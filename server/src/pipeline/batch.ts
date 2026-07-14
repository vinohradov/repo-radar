import { nanoid } from "nanoid";
import type { Finding, Scan } from "@repo-radar/shared";
import { scansRepo, findingsRepo, reportsRepo, agentRunsRepo, settingsRepo } from "../db/repositories.js";
import { getClient } from "../ai/client.js";
import { buildAgentRequest, interpretResponse } from "../ai/agentCall.js";
import { tasksForScan } from "../tasks/registry.js";
import type { Task } from "../tasks/types.js";
import type * as z from "zod/v4";
import { newScan, modelForAgent, disabledTasks, setPhase } from "./runner.js";
import { acquire } from "./acquire.js";
import { aggregate, computeScores } from "./aggregate.js";
import { buildReports } from "./report.js";

/**
 * Nightly Batch-API scans: re-scan every distinct repo the team has scanned
 * before, submitting ALL analyze calls as one Message Batch at 50% cost.
 * Validation is skipped in batch mode (results land while nobody is watching;
 * the next interactive scan re-checks anything low-confidence).
 */

export interface NightlyStatus {
  running: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
}

let running = false;

export function nightlyStatus(): NightlyStatus {
  return {
    running,
    lastRunAt: Number(settingsRepo.get("nightlyLastRunAt")) || null,
    lastResult: settingsRepo.get("nightlyLastResult"),
  };
}

interface BatchJob {
  scan: Scan;
  cleanup: () => void;
  tasks: { task: Task<z.ZodType>; evidence: unknown; model: string }[];
}

/** Latest scan per distinct repo (URL or local path). */
function distinctRepoScans(): Scan[] {
  const seen = new Set<string>();
  const out: Scan[] = [];
  for (const s of scansRepo.list()) {
    const key = s.repoUrl ?? s.localPath ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runNightlyBatch(): Promise<string> {
  if (running) return "Nightly batch already running";
  const client = getClient();
  if (!client) return "No ANTHROPIC_API_KEY — nightly batch skipped";

  running = true;
  const startedAt = Date.now();
  try {
    const templates = distinctRepoScans();
    if (templates.length === 0) return "No repos scanned yet — nothing to batch";

    /* ---- acquire + collect for every repo (deterministic, no tokens) ---- */
    const jobs: BatchJob[] = [];
    for (const tpl of templates) {
      const scan = newScan({
        repoUrl: tpl.repoUrl,
        localPath: tpl.localPath,
        branch: tpl.branch,
        label: "nightly batch",
        config: tpl.config,
      });
      scan.status = "running";
      scansRepo.update(scan);
      try {
        setPhase(scan, "acquire", "running");
        const acquired = await acquire({
          scanId: scan.id,
          repoUrl: scan.repoUrl,
          localPath: scan.localPath,
          branch: scan.branch,
        });
        scan.repoName = acquired.repoName;
        scan.commit = acquired.commit;
        scansRepo.update(scan);
        setPhase(scan, "acquire", "completed", `${acquired.repoName} · ${acquired.ecosystems.join(", ")}`);

        setPhase(scan, "collect", "running");
        const tasks = tasksForScan(scan.config, disabledTasks());
        const withEvidence: BatchJob["tasks"] = [];
        for (const task of tasks) {
          try {
            const result = await task.collect({
              repoDir: acquired.repoDir,
              repoName: acquired.repoName,
              ecosystems: acquired.ecosystems,
              excludedPaths: scan.config.excludedPaths,
              changedFiles: null,
            });
            if (result.evidence !== null && result.evidence !== undefined) {
              withEvidence.push({ task, evidence: result.evidence, model: modelForAgent(task.meta.agent) });
            }
          } catch {
            /* collector failure — task simply not batched */
          }
        }
        setPhase(scan, "collect", "completed", `${withEvidence.length}/${tasks.length} tasks have evidence`);
        setPhase(scan, "analyze", "running", "Queued in Message Batch (50% cost)");
        jobs.push({ scan, cleanup: acquired.cleanup, tasks: withEvidence });
      } catch (err) {
        scan.status = "failed";
        scan.error = err instanceof Error ? err.message : String(err);
        scan.finishedAt = Date.now();
        scansRepo.update(scan);
      }
    }

    const requests = jobs.flatMap((job) =>
      job.tasks.map(({ task, evidence, model }) => ({
        custom_id: `${job.scan.id}__${task.meta.id}`,
        params: buildAgentRequest({
          model,
          systemPrompt: task.systemPrompt,
          userContent: JSON.stringify(evidence),
          schema: task.outputSchema,
          maxTokens: task.meta.maxTokens,
          effort: task.meta.effort,
        }),
      })),
    );
    if (requests.length === 0) {
      finishJobs(jobs, new Map());
      return `Nightly batch: ${jobs.length} repos, no evidence to analyze`;
    }

    /* ---------------- submit ONE batch for all repos ---------------- */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batches = (client.messages as any).batches;
    let batch = await batches.create({ requests });

    // Poll until the batch ends (nightly = nobody is waiting; be patient).
    const deadline = Date.now() + 60 * 60 * 1000;
    while (batch.processing_status === "in_progress" && Date.now() < deadline) {
      await sleep(15_000);
      batch = await batches.retrieve(batch.id);
    }

    /* ------------------------- map results back ------------------------- */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultsById = new Map<string, any>();
    if (batch.processing_status === "ended") {
      for await (const entry of await batches.results(batch.id)) {
        resultsById.set(entry.custom_id, entry.result);
      }
    }
    finishJobs(jobs, resultsById);

    const summary = `Nightly batch: ${jobs.length} repos, ${requests.length} agent calls at 50% cost (${batch.processing_status})`;
    settingsRepo.set("nightlyLastRunAt", String(startedAt));
    settingsRepo.set("nightlyLastResult", summary);
    return summary;
  } catch (err) {
    const msg = `Nightly batch failed: ${err instanceof Error ? err.message : String(err)}`;
    settingsRepo.set("nightlyLastRunAt", String(startedAt));
    settingsRepo.set("nightlyLastResult", msg);
    return msg;
  } finally {
    running = false;
  }
}

/** Aggregate + report each batched scan from its (possibly partial) results. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function finishJobs(jobs: BatchJob[], resultsById: Map<string, any>): void {
  for (const job of jobs) {
    void finishJob(job, resultsById).catch(() => {
      /* per-repo failures already recorded on the scan row */
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function finishJob(job: BatchJob, resultsById: Map<string, any>): Promise<void> {
  const { scan } = job;
  try {
    const rawFindings: Parameters<typeof aggregate>[0] = [];
    let failures = 0;
    for (const { task, model } of job.tasks) {
      const entry = resultsById.get(`${scan.id}__${task.meta.id}`);
      if (!entry || entry.type !== "succeeded") {
        failures++;
        continue;
      }
      const result = interpretResponse(entry.message, task.outputSchema, model, 0, { batch: true });
      scan.usage.inputTokens += result.usage.inputTokens;
      scan.usage.outputTokens += result.usage.outputTokens;
      scan.usage.cacheCreationTokens += result.usage.cacheCreationTokens;
      scan.usage.cacheReadTokens += result.usage.cacheReadTokens;
      scan.usage.costUsd = Math.round((scan.usage.costUsd + result.usage.costUsd) * 1_000_000) / 1_000_000;
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
        durationMs: 0,
        detail: result.detail ? `[batch] ${result.detail}` : "[batch]",
        createdAt: Date.now(),
      });
      if (result.status === "ok" && result.output) {
        rawFindings.push(...task.toFindings(result.output, scan.id));
      } else {
        failures++;
      }
    }
    setPhase(
      scan,
      "analyze",
      "completed",
      `${rawFindings.length} raw findings (batched, 50% cost)` + (failures ? ` · ${failures} failed` : ""),
    );

    setPhase(scan, "aggregate", "running");
    const threshold = (settingsRepo.get("severityThreshold") as Finding["severity"] | null) ?? "low";
    const findings = aggregate(rawFindings, scan.id, threshold);
    findingsRepo.insertMany(findings);
    const scores = computeScores(findings);
    scan.scores = scores;
    scan.findingCount = findings.length;
    scansRepo.update(scan);
    setPhase(scan, "aggregate", "completed", `${findings.length} findings · health ${scores.health}%`);

    setPhase(scan, "validate", "skipped", "Skipped in nightly batch mode");

    setPhase(scan, "report", "running");
    const reports = await buildReports({
      scanId: scan.id,
      repoName: scan.repoName,
      repoUrl: scan.repoUrl,
      branch: scan.branch,
      commit: scan.commit,
      model: modelForAgent("reporting"),
      findings,
      scores,
      skipAi: true, // deterministic reports for unattended runs — zero extra tokens
    });
    reportsRepo.upsert({ id: nanoid(12), scanId: scan.id, audience: "human", content: reports.humanMarkdown, createdAt: Date.now() });
    reportsRepo.upsert({ id: nanoid(12), scanId: scan.id, audience: "agent", content: JSON.stringify(reports.manifest, null, 2), createdAt: Date.now() });
    setPhase(scan, "report", "completed", "Deterministic reports (batch mode)");

    scan.status = "completed";
    scan.finishedAt = Date.now();
    scansRepo.update(scan);
  } catch (err) {
    scan.status = "failed";
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = Date.now();
    scansRepo.update(scan);
  } finally {
    try {
      job.cleanup();
    } catch {
      /* ignore */
    }
  }
}
