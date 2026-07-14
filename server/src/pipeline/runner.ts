import { nanoid } from "nanoid";
import {
  PHASES,
  type Scan,
  type Phase,
  type PhaseStatus,
  type Finding,
  type Usage,
  estimateCostUsd,
} from "@repo-radar/shared";
import { scansRepo, findingsRepo, reportsRepo, agentRunsRepo, settingsRepo } from "../db/repositories.js";
import { scanEvents } from "../events.js";
import { config } from "../config.js";
import { tasksEnabledBy } from "../tasks/registry.js";
import type { NormalizedFinding } from "../tasks/types.js";
import { agentCall } from "../ai/agentCall.js";
import { acquire } from "./acquire.js";
import { aggregate, computeScores } from "./aggregate.js";
import { buildReports } from "./report.js";

function now(): number {
  return Date.now();
}

function modelForAgent(agent: string): string {
  const raw = settingsRepo.get("models");
  if (raw) {
    try {
      const models = JSON.parse(raw) as Record<string, string>;
      if (models[agent]) return models[agent];
    } catch {
      /* ignore */
    }
  }
  return config.defaultModel;
}

function setPhase(scan: Scan, phase: Phase, status: PhaseStatus, detail?: string): void {
  const ps = scan.phases[phase] ?? { status: "pending", startedAt: null, finishedAt: null };
  if (status === "running") ps.startedAt = now();
  if (status === "completed" || status === "failed" || status === "skipped") ps.finishedAt = now();
  ps.status = status;
  if (detail) ps.detail = detail;
  scan.phases[phase] = ps;
  scansRepo.update(scan);
  scanEvents.emitScan({
    type: "scan:phase",
    scanId: scan.id,
    phase,
    phaseStatus: status,
    message: detail,
    at: now(),
  });
}

function addUsage(usage: Usage, add: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): void {
  usage.inputTokens += add.inputTokens;
  usage.outputTokens += add.outputTokens;
  usage.cacheCreationTokens += add.cacheCreationTokens;
  usage.cacheReadTokens += add.cacheReadTokens;
}

export function newScan(input: {
  repoUrl?: string | null;
  localPath?: string | null;
  branch?: string | null;
  label?: string | null;
  config: Scan["config"];
}): Scan {
  const id = nanoid(12);
  const phases = Object.fromEntries(
    PHASES.map((p) => [p, { status: "pending" as PhaseStatus, startedAt: null, finishedAt: null }]),
  ) as Scan["phases"];
  const scan: Scan = {
    id,
    repoUrl: input.repoUrl ?? null,
    localPath: input.localPath ?? null,
    repoName: input.repoUrl
      ? input.repoUrl.replace(/\.git$/, "").split(/[\\/]/).pop() || "repository"
      : (input.localPath ?? "repository").split(/[\\/]/).pop() || "repository",
    label: input.label?.trim() || null,
    branch: input.branch ?? null,
    status: "queued",
    config: input.config,
    phases,
    scores: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    findingCount: 0,
    error: null,
    createdAt: now(),
    finishedAt: null,
  };
  scansRepo.insert(scan);
  scanEvents.emitScan({ type: "scan:queued", scanId: id, at: now() });
  return scan;
}

/**
 * Run the full pipeline for a scan. Fire-and-forget; drives DB + SSE.
 * `token` (private-repo PAT) is passed in-memory only — never persisted.
 */
export async function runScan(scanId: string, token?: string | null): Promise<void> {
  const scan = scansRepo.get(scanId);
  if (!scan) return;
  scan.status = "running";
  scansRepo.update(scan);

  let cleanup: (() => void) | null = null;

  try {
    /* -------- acquire -------- */
    setPhase(scan, "acquire", "running");
    const acquired = await acquire({
      scanId: scan.id,
      repoUrl: scan.repoUrl,
      localPath: scan.localPath,
      branch: scan.branch,
      token,
    });
    cleanup = acquired.cleanup;
    scan.repoName = acquired.repoName;
    scansRepo.update(scan);
    setPhase(scan, "acquire", "completed", `${acquired.repoName} · ${acquired.ecosystems.join(", ")}`);

    /* -------- collect -------- */
    setPhase(scan, "collect", "running");
    const tasks = tasksEnabledBy(scan.config);
    const collected: { task: (typeof tasks)[number]; evidence: unknown; itemCount: number }[] = [];
    // Collectors are independent and read-only — run them in parallel.
    const collectResults = await Promise.allSettled(
      tasks.map(async (task) => ({
        task,
        result: await task.collect({
          repoDir: acquired.repoDir,
          repoName: acquired.repoName,
          ecosystems: acquired.ecosystems,
          excludedPaths: scan.config.excludedPaths,
        }),
      })),
    );
    for (const settled of collectResults) {
      if (settled.status !== "fulfilled") continue;
      const { task, result } = settled.value;
      if (result.evidence !== null && result.evidence !== undefined) {
        collected.push({ task, evidence: result.evidence, itemCount: result.itemCount });
      }
      scanEvents.emitScan({
        type: "task:done",
        scanId: scan.id,
        taskId: task.meta.id,
        message: result.note,
        at: now(),
      });
    }
    setPhase(
      scan,
      "collect",
      "completed",
      `${collected.length}/${tasks.length} tasks have evidence`,
    );

    /* -------- analyze (parallel agents) -------- */
    setPhase(scan, "analyze", "running");
    const rawFindings: NormalizedFinding[] = [];
    let analyzeSkipped = false;

    const analyses = await Promise.allSettled(
      collected.map(async ({ task, evidence }) => {
        // Budget guard: stop spending once the per-scan output cap is reached.
        if (scan.usage.outputTokens >= config.maxOutputTokensPerScan) {
          return { task, result: null as null, skippedForBudget: true };
        }
        scanEvents.emitScan({
          type: "task:started",
          scanId: scan.id,
          taskId: task.meta.id,
          at: now(),
        });
        const model = modelForAgent(task.meta.agent);
        const result = await agentCall({
          model,
          systemPrompt: task.systemPrompt,
          userContent: JSON.stringify(evidence),
          schema: task.outputSchema,
          maxTokens: task.meta.maxTokens,
          effort: task.meta.effort,
        });
        return { task, result, model, skippedForBudget: false };
      }),
    );

    for (const settled of analyses) {
      if (settled.status !== "fulfilled") continue;
      const { task } = settled.value;
      if ("skippedForBudget" in settled.value && settled.value.skippedForBudget) {
        analyzeSkipped = true;
        continue;
      }
      const result = settled.value.result;
      const model = (settled.value as { model?: string }).model ?? config.defaultModel;
      if (!result) continue;

      addUsage(scan.usage, result.usage);
      if (result.status === "skipped") analyzeSkipped = true;

      agentRunsRepo.insert({
        id: nanoid(12),
        scanId: scan.id,
        taskId: task.meta.id,
        agent: task.meta.agent,
        model,
        status: result.status,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        costUsd: result.usage.costUsd,
        durationMs: result.durationMs,
        detail: result.detail,
        createdAt: now(),
      });

      if (result.status === "ok" && result.output) {
        rawFindings.push(...task.toFindings(result.output, scan.id));
      }

      scanEvents.emitScan({
        type: "task:done",
        scanId: scan.id,
        taskId: task.meta.id,
        message:
          result.status === "ok"
            ? `${task.toFindings(result.output!, scan.id).length} findings`
            : `${result.status}: ${result.detail ?? ""}`,
        at: now(),
      });
    }
    scan.usage.costUsd = estimateCostUsd(config.defaultModel, scan.usage);
    scansRepo.update(scan);
    setPhase(
      scan,
      "analyze",
      analyzeSkipped && rawFindings.length === 0 ? "skipped" : "completed",
      analyzeSkipped ? "AI unavailable or budget reached for some tasks" : `${rawFindings.length} raw findings`,
    );

    /* -------- aggregate -------- */
    setPhase(scan, "aggregate", "running");
    const threshold = (settingsRepo.get("severityThreshold") as Finding["severity"] | null) ?? "low";
    const findings: Finding[] = aggregate(rawFindings, scan.id, threshold);
    findingsRepo.insertMany(findings);
    const scores = computeScores(findings);
    scan.scores = scores;
    scan.findingCount = findings.length;
    scansRepo.update(scan);
    setPhase(scan, "aggregate", "completed", `${findings.length} findings · health ${scores.health}%`);

    /* -------- report -------- */
    setPhase(scan, "report", "running");
    const reports = await buildReports({
      scanId: scan.id,
      repoName: scan.repoName,
      repoUrl: scan.repoUrl,
      branch: scan.branch,
      model: modelForAgent("reporting"),
      findings,
      scores,
      config: { excludedPaths: scan.config.excludedPaths },
    });
    if (reports.call) {
      addUsage(scan.usage, reports.call.usage);
      scan.usage.costUsd = estimateCostUsd(config.defaultModel, scan.usage);
      agentRunsRepo.insert({
        id: nanoid(12),
        scanId: scan.id,
        taskId: "reporting",
        agent: "reporting",
        model: modelForAgent("reporting"),
        status: reports.call.status,
        inputTokens: reports.call.usage.inputTokens,
        outputTokens: reports.call.usage.outputTokens,
        cacheCreationTokens: reports.call.usage.cacheCreationTokens,
        cacheReadTokens: reports.call.usage.cacheReadTokens,
        costUsd: reports.call.usage.costUsd,
        durationMs: reports.call.durationMs,
        detail: reports.call.detail,
        createdAt: now(),
      });
    }
    reportsRepo.upsert({
      id: nanoid(12),
      scanId: scan.id,
      audience: "human",
      content: reports.humanMarkdown,
      createdAt: now(),
    });
    reportsRepo.upsert({
      id: nanoid(12),
      scanId: scan.id,
      audience: "agent",
      content: JSON.stringify(reports.manifest, null, 2),
      createdAt: now(),
    });
    setPhase(scan, "report", "completed", "Human + agent reports ready");

    /* -------- done -------- */
    scan.status = "completed";
    scan.finishedAt = now();
    scansRepo.update(scan);
    scanEvents.emitScan({ type: "scan:done", scanId: scan.id, at: now() });
  } catch (err) {
    scan.status = "failed";
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = now();
    // Mark any running phase as failed and surface why in its detail.
    for (const p of PHASES) {
      if (scan.phases[p]?.status === "running") {
        scan.phases[p].status = "failed";
        scan.phases[p].finishedAt = now();
        scan.phases[p].detail = scan.error ?? undefined;
      }
    }
    scansRepo.update(scan);
    scanEvents.emitScan({
      type: "scan:failed",
      scanId: scan.id,
      message: scan.error,
      at: now(),
    });
  } finally {
    if (cleanup) {
      try {
        cleanup();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
