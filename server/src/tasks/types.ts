import type * as z from "zod/v4";
import type { AgentKind, Ecosystem } from "@repo-radar/shared";

export interface TaskMeta {
  id: string;
  agent: AgentKind;
  title: string;
  description: string;
  ecosystems: Ecosystem[];
  maxFindings: number;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}

/** Context handed to a collector: the on-disk repo and scan config. */
export interface CollectContext {
  repoDir: string;
  repoName: string;
  ecosystems: Ecosystem[];
  excludedPaths: string[];
}

/**
 * A collector runs deterministic scripts (NO AI) and returns compact evidence
 * plus a human-readable count for the progress UI. If `evidence` is empty the
 * analyze step skips this task entirely (saving tokens).
 */
export interface CollectResult {
  evidence: unknown;
  itemCount: number;
  note?: string;
}

/**
 * A task = collector script + frozen prompt + structured-output schema.
 * This is the pluggable unit: add a folder, register it, done.
 */
export interface Task<TSchema extends z.ZodType = z.ZodType> {
  meta: TaskMeta;
  /** Frozen system prompt (byte-stable → prompt-cacheable). */
  systemPrompt: string;
  /** Structured-output schema the agent must satisfy. */
  outputSchema: TSchema;
  /** Deterministic evidence gathering. Runs before any AI call. */
  collect(ctx: CollectContext): Promise<CollectResult>;
  /** Turn the validated agent output into normalized findings. */
  toFindings(output: z.infer<TSchema>, scanId: string): NormalizedFinding[];
}

/** A finding before it gets an id/fingerprint (added at aggregate time). */
export interface NormalizedFinding {
  agent: AgentKind;
  taskId: string;
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  suggestedFix: string;
  confidence: number;
  reference?: string | null;
}
