import * as z from "zod/v4";

/** Severity scale shared across all agents and the UI. */
export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Which specialized agent produced a finding. */
export const AgentKind = z.enum(["code", "security", "documentation", "reporting"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** Package ecosystems the collectors understand. */
export const Ecosystem = z.enum(["npm", "maven", "gradle", "pip", "unknown"]);
export type Ecosystem = z.infer<typeof Ecosystem>;

/** Lifecycle of a scan. */
export const ScanStatus = z.enum(["queued", "running", "completed", "failed"]);
export type ScanStatus = z.infer<typeof ScanStatus>;

/** Ordered pipeline phases; the UI renders these as a stepper. */
export const PHASES = ["acquire", "collect", "analyze", "aggregate", "report"] as const;
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

export const PhaseStatus = z.enum(["pending", "running", "completed", "failed", "skipped"]);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

/** Config the user can tweak before triggering a scan. */
export const ScanConfig = z.object({
  includeSecurity: z.boolean().default(true),
  includeCodeQuality: z.boolean().default(true),
  includeDocumentation: z.boolean().default(true),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  focusAreas: z.array(z.string()).default([]),
  excludedPaths: z.array(z.string()).default(["node_modules", "dist", "build", ".git", "coverage"]),
});
export type ScanConfig = z.infer<typeof ScanConfig>;

/** Request body for POST /api/scans — the one-click action. */
export const CreateScanRequest = z.object({
  repoUrl: z.string().optional(),
  localPath: z.string().optional(),
  branch: z.string().optional(),
  /** Optional human label describing the purpose of this scan. */
  label: z.string().optional(),
  /** Optional access token (PAT) for private HTTPS repos. Never persisted. */
  token: z.string().optional(),
  config: ScanConfig.partial().optional(),
}).refine((v) => Boolean(v.repoUrl || v.localPath), {
  message: "Provide either repoUrl or localPath",
});
export type CreateScanRequest = z.infer<typeof CreateScanRequest>;

/** Token accounting captured from every agent response. */
export const Usage = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  costUsd: z.number().default(0),
});
export type Usage = z.infer<typeof Usage>;

/** Health/quality scores shown as the dashboard stat tiles. */
export const Scores = z.object({
  health: z.number().min(0).max(100),
  security: z.enum(["High", "Medium", "Low"]),
  code: z.enum(["Good", "Fair", "Poor"]),
  docs: z.enum(["Good", "Fair", "Poor"]),
});
export type Scores = z.infer<typeof Scores>;

export const PhaseState = z.object({
  status: PhaseStatus,
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
  detail: z.string().optional(),
});
export type PhaseState = z.infer<typeof PhaseState>;

/** A single issue found by an agent. */
export const Finding = z.object({
  id: z.string(),
  scanId: z.string(),
  agent: AgentKind,
  taskId: z.string(),
  type: z.string(),
  severity: Severity,
  file: z.string().nullable(),
  line: z.number().nullable(),
  title: z.string(),
  description: z.string(),
  suggestedFix: z.string(),
  confidence: z.number().min(0).max(1),
  reference: z.string().nullable().optional(),
  fingerprint: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const Scan = z.object({
  id: z.string(),
  repoUrl: z.string().nullable(),
  localPath: z.string().nullable(),
  repoName: z.string(),
  label: z.string().nullable(),
  branch: z.string().nullable(),
  status: ScanStatus,
  config: ScanConfig,
  phases: z.record(Phase, PhaseState),
  scores: Scores.nullable(),
  usage: Usage,
  findingCount: z.number().default(0),
  error: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type Scan = z.infer<typeof Scan>;

export const ReportAudience = z.enum(["human", "agent"]);
export type ReportAudience = z.infer<typeof ReportAudience>;

export const Report = z.object({
  id: z.string(),
  scanId: z.string(),
  audience: ReportAudience,
  content: z.string(),
  createdAt: z.number(),
});
export type Report = z.infer<typeof Report>;

export const AgentRun = z.object({
  id: z.string(),
  scanId: z.string(),
  taskId: z.string(),
  agent: AgentKind,
  model: z.string(),
  status: z.enum(["ok", "skipped", "error"]),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  detail: z.string().nullable(),
  createdAt: z.number(),
});
export type AgentRun = z.infer<typeof AgentRun>;

/** Task registry entry, surfaced on the Agents page. */
export const TaskInfo = z.object({
  id: z.string(),
  agent: AgentKind,
  title: z.string(),
  description: z.string(),
  ecosystems: z.array(Ecosystem),
  maxFindings: z.number(),
  effort: z.enum(["low", "medium", "high"]),
});
export type TaskInfo = z.infer<typeof TaskInfo>;

/** SSE event envelope streamed during a scan. */
export const ScanEvent = z.object({
  type: z.enum([
    "scan:queued",
    "scan:phase",
    "task:started",
    "task:done",
    "scan:done",
    "scan:failed",
  ]),
  scanId: z.string(),
  phase: Phase.optional(),
  phaseStatus: PhaseStatus.optional(),
  taskId: z.string().optional(),
  message: z.string().optional(),
  at: z.number(),
});
export type ScanEvent = z.infer<typeof ScanEvent>;

/** Per-agent model settings editable on the Settings page. */
export const Settings = z.object({
  models: z.record(AgentKind, z.string()),
  severityThreshold: Severity,
  excludedPaths: z.array(z.string()),
  hasApiKey: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;
