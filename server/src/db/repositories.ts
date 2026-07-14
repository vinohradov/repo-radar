import type {
  Scan,
  Finding,
  Report,
  AgentRun,
  ScanStatus,
  Phase,
  PhaseState,
  Scores,
  Usage,
  ScanConfig,
  ReportAudience,
} from "@repo-radar/shared";
import { db } from "./index.js";

/* ------------------------------- scans ---------------------------------- */

interface ScanRow {
  id: string;
  repo_url: string | null;
  local_path: string | null;
  repo_name: string;
  label: string | null;
  branch: string | null;
  status: string;
  config: string;
  phases: string;
  scores: string | null;
  usage: string;
  finding_count: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

function rowToScan(r: ScanRow): Scan {
  return {
    id: r.id,
    repoUrl: r.repo_url,
    localPath: r.local_path,
    repoName: r.repo_name,
    label: r.label,
    branch: r.branch,
    status: r.status as ScanStatus,
    config: JSON.parse(r.config) as ScanConfig,
    phases: JSON.parse(r.phases) as Record<Phase, PhaseState>,
    scores: r.scores ? (JSON.parse(r.scores) as Scores) : null,
    usage: JSON.parse(r.usage) as Usage,
    findingCount: r.finding_count,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export const scansRepo = {
  insert(scan: Scan): void {
    db.prepare(
      `INSERT INTO scans (id, repo_url, local_path, repo_name, label, branch, status, config, phases, scores, usage, finding_count, error, created_at, finished_at)
       VALUES (@id, @repo_url, @local_path, @repo_name, @label, @branch, @status, @config, @phases, @scores, @usage, @finding_count, @error, @created_at, @finished_at)`,
    ).run({
      id: scan.id,
      repo_url: scan.repoUrl,
      local_path: scan.localPath,
      repo_name: scan.repoName,
      label: scan.label,
      branch: scan.branch,
      status: scan.status,
      config: JSON.stringify(scan.config),
      phases: JSON.stringify(scan.phases),
      scores: scan.scores ? JSON.stringify(scan.scores) : null,
      usage: JSON.stringify(scan.usage),
      finding_count: scan.findingCount,
      error: scan.error,
      created_at: scan.createdAt,
      finished_at: scan.finishedAt,
    });
  },

  update(scan: Scan): void {
    db.prepare(
      `UPDATE scans SET status=@status, phases=@phases, scores=@scores, usage=@usage,
        finding_count=@finding_count, error=@error, finished_at=@finished_at WHERE id=@id`,
    ).run({
      id: scan.id,
      status: scan.status,
      phases: JSON.stringify(scan.phases),
      scores: scan.scores ? JSON.stringify(scan.scores) : null,
      usage: JSON.stringify(scan.usage),
      finding_count: scan.findingCount,
      error: scan.error,
      finished_at: scan.finishedAt,
    });
  },

  get(id: string): Scan | null {
    const row = db.prepare("SELECT * FROM scans WHERE id = ?").get(id) as ScanRow | undefined;
    return row ? rowToScan(row) : null;
  },

  list(): Scan[] {
    const rows = db.prepare("SELECT * FROM scans ORDER BY created_at DESC").all() as ScanRow[];
    return rows.map(rowToScan);
  },

  delete(id: string): void {
    db.prepare("DELETE FROM scans WHERE id = ?").run(id);
  },
};

/* ------------------------------ findings -------------------------------- */

interface FindingRow {
  id: string;
  scan_id: string;
  agent: string;
  task_id: string;
  type: string;
  severity: string;
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  suggested_fix: string;
  confidence: number;
  reference: string | null;
  fingerprint: string;
}

function rowToFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    scanId: r.scan_id,
    agent: r.agent as Finding["agent"],
    taskId: r.task_id,
    type: r.type,
    severity: r.severity as Finding["severity"],
    file: r.file,
    line: r.line,
    title: r.title,
    description: r.description,
    suggestedFix: r.suggested_fix,
    confidence: r.confidence,
    reference: r.reference,
    fingerprint: r.fingerprint,
  };
}

export const findingsRepo = {
  insertMany(findings: Finding[]): void {
    const stmt = db.prepare(
      `INSERT INTO findings (id, scan_id, agent, task_id, type, severity, file, line, title, description, suggested_fix, confidence, reference, fingerprint, created_at)
       VALUES (@id, @scan_id, @agent, @task_id, @type, @severity, @file, @line, @title, @description, @suggested_fix, @confidence, @reference, @fingerprint, @created_at)`,
    );
    const now = Date.now();
    const tx = db.transaction((items: Finding[]) => {
      for (const f of items) {
        stmt.run({
          id: f.id,
          scan_id: f.scanId,
          agent: f.agent,
          task_id: f.taskId,
          type: f.type,
          severity: f.severity,
          file: f.file,
          line: f.line,
          title: f.title,
          description: f.description,
          suggested_fix: f.suggestedFix,
          confidence: f.confidence,
          reference: f.reference ?? null,
          fingerprint: f.fingerprint,
          created_at: now,
        });
      }
    });
    tx(findings);
  },

  listByScan(scanId: string): Finding[] {
    const rows = db
      .prepare("SELECT * FROM findings WHERE scan_id = ? ORDER BY confidence DESC")
      .all(scanId) as FindingRow[];
    return rows.map(rowToFinding);
  },
};

/* ------------------------------- reports -------------------------------- */

interface ReportRow {
  id: string;
  scan_id: string;
  audience: string;
  content: string;
  created_at: number;
}

export const reportsRepo = {
  upsert(report: Report): void {
    db.prepare("DELETE FROM reports WHERE scan_id = ? AND audience = ?").run(
      report.scanId,
      report.audience,
    );
    db.prepare(
      `INSERT INTO reports (id, scan_id, audience, content, created_at)
       VALUES (@id, @scan_id, @audience, @content, @created_at)`,
    ).run({
      id: report.id,
      scan_id: report.scanId,
      audience: report.audience,
      content: report.content,
      created_at: report.createdAt,
    });
  },

  get(scanId: string, audience: ReportAudience): Report | null {
    const row = db
      .prepare("SELECT * FROM reports WHERE scan_id = ? AND audience = ?")
      .get(scanId, audience) as ReportRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      scanId: row.scan_id,
      audience: row.audience as ReportAudience,
      content: row.content,
      createdAt: row.created_at,
    };
  },
};

/* ----------------------------- agent runs ------------------------------- */

interface AgentRunRow {
  id: string;
  scan_id: string;
  task_id: string;
  agent: string;
  model: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  duration_ms: number;
  detail: string | null;
  created_at: number;
}

export const agentRunsRepo = {
  insert(run: AgentRun): void {
    db.prepare(
      `INSERT INTO agent_runs (id, scan_id, task_id, agent, model, status, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, duration_ms, detail, created_at)
       VALUES (@id, @scan_id, @task_id, @agent, @model, @status, @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens, @cost_usd, @duration_ms, @detail, @created_at)`,
    ).run({
      id: run.id,
      scan_id: run.scanId,
      task_id: run.taskId,
      agent: run.agent,
      model: run.model,
      status: run.status,
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      cache_creation_tokens: run.cacheCreationTokens,
      cache_read_tokens: run.cacheReadTokens,
      cost_usd: run.costUsd,
      duration_ms: run.durationMs,
      detail: run.detail,
      created_at: run.createdAt,
    });
  },

  listByScan(scanId: string): AgentRun[] {
    const rows = db
      .prepare("SELECT * FROM agent_runs WHERE scan_id = ? ORDER BY created_at ASC")
      .all(scanId) as AgentRunRow[];
    return rows.map((r) => ({
      id: r.id,
      scanId: r.scan_id,
      taskId: r.task_id,
      agent: r.agent as AgentRun["agent"],
      model: r.model,
      status: r.status as AgentRun["status"],
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      cacheReadTokens: r.cache_read_tokens,
      costUsd: r.cost_usd,
      durationMs: r.duration_ms,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  },

  aggregateAvgByTask(): Record<string, { avgTokens: number; avgCost: number; runs: number }> {
    const rows = db
      .prepare(
        `SELECT task_id,
                AVG(input_tokens + output_tokens) AS avg_tokens,
                AVG(cost_usd) AS avg_cost,
                COUNT(*) AS runs
         FROM agent_runs WHERE status = 'ok' GROUP BY task_id`,
      )
      .all() as { task_id: string; avg_tokens: number; avg_cost: number; runs: number }[];
    const out: Record<string, { avgTokens: number; avgCost: number; runs: number }> = {};
    for (const r of rows) {
      out[r.task_id] = {
        avgTokens: Math.round(r.avg_tokens || 0),
        avgCost: r.avg_cost || 0,
        runs: r.runs,
      };
    }
    return out;
  },
};

/* ------------------------------ settings -------------------------------- */

export const settingsRepo = {
  get(key: string): string | null {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  },
  set(key: string, value: string): void {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  },
};
