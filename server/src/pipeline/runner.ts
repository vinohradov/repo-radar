import { nanoid } from "nanoid";
import {
  PHASES,
  type Scan,
  type Phase,
  type PhaseStatus,
  type Finding,
  type Usage,
} from "@repo-radar/shared";
import { scansRepo, findingsRepo, reportsRepo, agentRunsRepo, settingsRepo } from "../db/repositories.js";
import { scanEvents } from "../events.js";
import { config } from "../config.js";
import { tasksForScan } from "../tasks/registry.js";
import type { NormalizedFinding } from "../tasks/types.js";
import { agentCall } from "../ai/agentCall.js";
import { hasApiKey } from "../config.js";
import { acquire, changedFilesSince } from "./acquire.js";
import { aggregate, computeScores } from "./aggregate.js";
import { buildReports } from "./report.js";
import { validateFindings } from "./validate.js";
import { TokenBudget } from "./budget.js";

function now(): number {
  return Date.now();
}

export function modelForAgent(agent: string): string {
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

export function disabledTasks(): string[] {
  const raw = settingsRepo.get("disabledTasks");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/* ------------------------- cancellation registry ------------------------- */

class CancelledError extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "CancelledError";
  }
}

const controllers = new Map<string, AbortController>();

/** Abort a running scan: in-flight API calls and child processes are killed. */
export function cancelScan(scanId: string): boolean {
  const c = controllers.get(scanId);
  if (!c) return false;
  c.abort();
  return true;
}

export function isScanActive(scanId: string): boolean {
  return controllers.has(scanId);
}

/* ------------------------------ scan setup ------------------------------- */

export function setPhase(scan: Scan, phase: Phase, status: PhaseStatus, detail?: string): void {
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
  costUsd: number;
}): void {
  usage.inputTokens += add.inputTokens;
  usage.outputTokens += add.outputTokens;
  usage.cacheCreationTokens += add.cacheCreationTokens;
  usage.cacheReadTokens += add.cacheReadTokens;
  // Cost is accumulated per call with each call's ACTUAL model, so per-agent
  // model overrides are priced correctly in the scan total.
  usage.costUsd = Math.round((usage.costUsd + add.costUsd) * 1_000_000) / 1_000_000;
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
    commit: null,
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

function insertRun(
  scan: Scan,
  taskId: string,
  agent: string,
  model: string,
  result: {
    status: "ok" | "skipped" | "error";
    usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; costUsd: number };
    durationMs: number;
    detail: string | null;
  },
): void {
  agentRunsRepo.insert({
    id: nanoid(12),
    scanId: scan.id,
    taskId,
    agent: agent as Parameters<typeof agentRunsRepo.insert>[0]["agent"],
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
}

/** Confidence below which a finding gets a validation re-check. */
const VALIDATION_THRESHOLD = 0.7;

/**
 * Run the full pipeline for a scan. Fire-and-forget; drives DB + SSE.
 * `token` (private-repo PAT) is passed in-memory only — never persisted.
 */
export async function runScan(scanId: string, token?: string | null): Promise<void> {
  const scan = scansRepo.get(scanId);
  if (!scan) return;
  scan.status = "running";
  scansRepo.update(scan);

  const ac = new AbortController();
  controllers.set(scanId, ac);
  const throwIfCancelled = (): void => {
    if (ac.signal.aborted) throw new CancelledError();
  };

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
      signal: ac.signal,
    });
    cleanup = acquired.cleanup;
    scan.repoName = acquired.repoName;
    scan.commit = acquired.commit;
    scansRepo.update(scan);

    // Incremental: diff against the last completed scan of the same repo.
    let changedFiles: string[] | null = null;
    let incrementalNote = "";
    if (scan.config.incremental && acquired.commit) {
      const prev = scansRepo
        .list()
        .find(
          (s) =>
            s.id !== scan.id &&
            s.status === "completed" &&
            s.commit &&
            ((scan.repoUrl && s.repoUrl === scan.repoUrl) ||
              (scan.localPath && s.localPath === scan.localPath)),
        );
      if (prev?.commit && prev.commit !== acquired.commit) {
        changedFiles = await changedFilesSince(acquired.repoDir, prev.commit);
        incrementalNote = changedFiles
          ? ` · incremental: ${changedFiles.length} changed files since ${prev.commit.slice(0, 7)}`
          : " · incremental baseline unreachable — full scan";
      } else if (prev?.commit && prev.commit === acquired.commit) {
        changedFiles = [];
        incrementalNote = " · incremental: no changes since last scan";
      } else {
        incrementalNote = " · incremental requested but no baseline — full scan";
      }
    }
    throwIfCancelled();
    setPhase(
      scan,
      "acquire",
      "completed",
      `${acquired.repoName} · ${acquired.ecosystems.join(", ")}${incrementalNote}`,
    );

    /* -------- collect -------- */
    setPhase(scan, "collect", "running");
    const tasks = tasksForScan(scan.config, disabledTasks());
    const collected: { task: (typeof tasks)[number]; evidence: unknown; itemCount: number }[] = [];
    const evidenceByTask: Record<string, unknown> = {};
    let collectFailures = 0;
    // Collectors are independent and read-only — run them in parallel.
    const collectResults = await Promise.allSettled(
      tasks.map(async (task) => ({
        task,
        result: await task.collect({
          repoDir: acquired.repoDir,
          repoName: acquired.repoName,
          ecosystems: acquired.ecosystems,
          excludedPaths: scan.config.excludedPaths,
          changedFiles,
          signal: ac.signal,
        }),
      })),
    );
    throwIfCancelled();
    collectResults.forEach((settled, i) => {
      if (settled.status !== "fulfilled") {
        // A throwing collector must be VISIBLE, not silently dropped.
        collectFailures++;
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        scanEvents.emitScan({
          type: "task:failed",
          scanId: scan.id,
          taskId: tasks[i].meta.id,
          message: `Collector failed: ${reason}`,
          at: now(),
        });
        return;
      }
      const { task, result } = settled.value;
      if (result.evidence !== null && result.evidence !== undefined) {
        collected.push({ task, evidence: result.evidence, itemCount: result.itemCount });
        evidenceByTask[task.meta.id] = result.evidence;
      }
      scanEvents.emitScan({
        type: "task:done",
        scanId: scan.id,
        taskId: task.meta.id,
        message: result.note,
        at: now(),
      });
    });
    setPhase(
      scan,
      "collect",
      "completed",
      `${collected.length}/${tasks.length} tasks have evidence` +
        (collectFailures ? ` · ${collectFailures} collector(s) failed` : ""),
    );

    /* -------- analyze (parallel agents) -------- */
    setPhase(scan, "analyze", "running");
    const budget = new TokenBudget(config.maxOutputTokensPerScan);
    const rawFindings: NormalizedFinding[] = [];
    let analyzeSkipped = false;
    let budgetSkipped = 0;
    let analyzeFailures = 0;

    const focusContext =
      scan.config.focusAreas.length > 0
        ? { focusAreas: scan.config.focusAreas, priority: scan.config.priority }
        : null;

    const analyses = await Promise.allSettled(
      collected.map(async ({ task, evidence }) => {
        // Hard budget: reserve this task's max_tokens before launching; the
        // reservation settles down to actual usage when the response lands.
        if (!budget.tryReserve(task.meta.maxTokens)) {
          return { task, result: null, model: "", budgetSkipped: true as const };
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
          userContent: JSON.stringify(focusContext ? { context: focusContext, evidence } : evidence),
          schema: task.outputSchema,
          maxTokens: task.meta.maxTokens,
          effort: task.meta.effort,
          signal: ac.signal,
        });
        budget.settle(task.meta.maxTokens, result.usage.outputTokens);
        return { task, result, model, budgetSkipped: false as const };
      }),
    );
    throwIfCancelled();

    analyses.forEach((settled, i) => {
      if (settled.status !== "fulfilled") {
        analyzeFailures++;
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        scanEvents.emitScan({
          type: "task:failed",
          scanId: scan.id,
          taskId: collected[i].task.meta.id,
          message: `Analysis failed: ${reason}`,
          at: now(),
        });
        return;
      }
      const { task, result, model } = settled.value;
      if (settled.value.budgetSkipped) {
        budgetSkipped++;
        scanEvents.emitScan({
          type: "task:failed",
          scanId: scan.id,
          taskId: task.meta.id,
          message: `Skipped: per-scan output-token budget (${config.maxOutputTokensPerScan}) exhausted`,
          at: now(),
        });
        return;
      }
      if (!result) return;

      addUsage(scan.usage, result.usage);
      if (result.status === "skipped") analyzeSkipped = true;
      if (result.status === "error") analyzeFailures++;

      insertRun(scan, task.meta.id, task.meta.agent, model, result);

      if (result.status === "ok" && result.output) {
        rawFindings.push(...task.toFindings(result.output, scan.id));
      }

      scanEvents.emitScan({
        type: result.status === "error" ? "task:failed" : "task:done",
        scanId: scan.id,
        taskId: task.meta.id,
        message:
          result.status === "ok"
            ? `${task.toFindings(result.output!, scan.id).length} findings`
            : `${result.status}: ${result.detail ?? ""}`,
        at: now(),
      });
    });
    scansRepo.update(scan);
    const analyzeDetailParts = [`${rawFindings.length} raw findings`];
    if (budgetSkipped) analyzeDetailParts.push(`${budgetSkipped} task(s) skipped for budget`);
    if (analyzeFailures) analyzeDetailParts.push(`${analyzeFailures} failed`);
    if (analyzeSkipped) analyzeDetailParts.push("AI unavailable for some tasks");
    setPhase(
      scan,
      "analyze",
      analyzeSkipped && rawFindings.length === 0 ? "skipped" : "completed",
      analyzeDetailParts.join(" · "),
    );

    /* -------- aggregate -------- */
    setPhase(scan, "aggregate", "running");
    const threshold = (settingsRepo.get("severityThreshold") as Finding["severity"] | null) ?? "low";
    const findings: Finding[] = aggregate(rawFindings, scan.id, threshold);
    findingsRepo.insertMany(findings);
    let scores = computeScores(findings);
    scan.scores = scores;
    scan.findingCount = findings.length;
    scansRepo.update(scan);
    setPhase(scan, "aggregate", "completed", `${findings.length} findings · health ${scores.health}%`);

    /* -------- validate (hallucination guard) -------- */
    setPhase(scan, "validate", "running");
    const lowConfidence = findings.filter((f) => f.confidence < VALIDATION_THRESHOLD);
    let rejected = 0;
    if (lowConfidence.length === 0) {
      setPhase(scan, "validate", "skipped", "No low-confidence findings to re-check");
    } else if (!hasApiKey()) {
      setPhase(scan, "validate", "skipped", "AI unavailable");
    } else if (!budget.tryReserve(4096)) {
      setPhase(scan, "validate", "skipped", "Token budget exhausted");
    } else {
      const model = modelForAgent("validation");
      const verdictCall = await validateFindings({
        model,
        findings: lowConfidence,
        evidenceByTask,
        signal: ac.signal,
      });
      budget.settle(4096, verdictCall.usage.outputTokens);
      throwIfCancelled();
      addUsage(scan.usage, verdictCall.usage);
      insertRun(scan, "validation", "validation", model, verdictCall);

      if (verdictCall.status === "ok" && verdictCall.output) {
        const byId = new Map(findings.map((f) => [f.id, f]));
        for (const v of verdictCall.output.verdicts) {
          const f = byId.get(v.findingId);
          if (!f) continue;
          f.validation = v.verdict;
          findingsRepo.setValidation(f.id, v.verdict);
          if (v.verdict === "rejected") rejected++;
        }
        // Rejected findings no longer count toward the scores.
        const surviving = findings.filter((f) => f.validation !== "rejected");
        scores = computeScores(surviving);
        scan.scores = scores;
        scan.findingCount = surviving.length;
        scansRepo.update(scan);
        setPhase(
          scan,
          "validate",
          "completed",
          `${lowConfidence.length} re-checked · ${rejected} rejected as likely false positives`,
        );
      } else {
        setPhase(scan, "validate", "skipped", verdictCall.detail ?? "Validation unavailable");
      }
    }

    /* -------- report -------- */
    setPhase(scan, "report", "running");
    const reportFindings = findings.filter((f) => f.validation !== "rejected");
    const reportModel = modelForAgent("reporting");
    const canReport = budget.tryReserve(4096);
    const reports = await buildReports({
      scanId: scan.id,
      repoName: scan.repoName,
      repoUrl: scan.repoUrl,
      branch: scan.branch,
      commit: scan.commit,
      model: reportModel,
      findings: reportFindings,
      scores,
      skipAi: !canReport,
      signal: ac.signal,
    });
    throwIfCancelled();
    if (reports.call) {
      budget.settle(4096, reports.call.usage.outputTokens);
      addUsage(scan.usage, reports.call.usage);
      insertRun(scan, "reporting", "reporting", reportModel, reports.call);
    } else if (canReport) {
      budget.settle(4096, 0);
    }
    scansRepo.update(scan);
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
    setPhase(
      scan,
      "report",
      "completed",
      canReport ? "Human + agent reports ready" : "Reports built without AI (budget exhausted)",
    );

    /* -------- done -------- */
    scan.status = "completed";
    scan.finishedAt = now();
    scansRepo.update(scan);
    scanEvents.emitScan({ type: "scan:done", scanId: scan.id, at: now() });
  } catch (err) {
    const cancelled = err instanceof CancelledError || ac.signal.aborted;
    scan.status = cancelled ? "cancelled" : "failed";
    scan.error = cancelled ? "Cancelled by user" : err instanceof Error ? err.message : String(err);
    scan.finishedAt = now();
    // Mark any running phase as failed and surface why in its detail.
    for (const p of PHASES) {
      if (scan.phases[p]?.status === "running") {
        scan.phases[p].status = cancelled ? "skipped" : "failed";
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
    controllers.delete(scanId);
    if (cleanup) {
      try {
        cleanup();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
