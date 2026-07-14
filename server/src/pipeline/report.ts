import {
  ReportingOutput,
  type Finding,
  type Scores,
  type FixManifest,
  type MachineAction,
  type Severity,
} from "@repo-radar/shared";
import { agentCall } from "../ai/agentCall.js";
import type { AgentCallResult } from "../ai/agentCall.js";

const REPORTING_PROMPT = `You are a Reporting agent for a repository scanner.

You receive a repository's aggregated, already-structured findings (from the
code, security, and documentation agents) plus computed health scores. Produce
two things in one structured response:

1. A concise HUMAN summary: a 2-4 sentence overview, the top risks (one line
   each), and ordered recommended next steps.
2. MACHINE actions for a downstream fixing agent (e.g. a coding agent). Each
   action must be deterministic and self-contained: name the exact target
   (file/package), give a precise instruction, and state acceptance criteria
   the fixing agent can verify (e.g. "npm audit reports 0 high vulnerabilities",
   "tests pass").

Rules:
- Be concise and high-signal. No filler.
- Order machine actions by priority, highest first.
- Only produce actions that follow from the findings; do not invent work.
- Ground every risk and action in the provided findings.`;

/** Cap on findings sent to the reporting agent; the rest are summarized as a count. */
const REPORT_FINDINGS_CAP = 60;

function compactFindings(findings: Finding[]): { rows: unknown[]; omitted: number } {
  const rows = findings.slice(0, REPORT_FINDINGS_CAP).map((f) => ({
    agent: f.agent,
    severity: f.severity,
    file: f.file,
    line: f.line,
    title: f.title,
    fix: f.suggestedFix,
    confidence: Math.round(f.confidence * 100) / 100,
  }));
  return { rows, omitted: Math.max(0, findings.length - REPORT_FINDINGS_CAP) };
}

function buildHumanMarkdown(
  repoName: string,
  scores: Scores,
  reporting: {
    summary: string;
    topRisks: string[];
    recommendedNextSteps: string[];
  },
  findings: Finding[],
): string {
  const bySeverity = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const lines: string[] = [];
  lines.push(`# Repo Radar report — ${repoName}`);
  lines.push("");
  lines.push(
    `**Health:** ${scores.health}%  ·  **Security:** ${scores.security}  ·  **Code:** ${scores.code}  ·  **Docs:** ${scores.docs}`,
  );
  lines.push("");
  lines.push(
    `Findings: ${findings.length} total — ${bySeverity("critical")} critical, ${bySeverity("high")} high, ${bySeverity("medium")} medium, ${bySeverity("low")} low.`,
  );
  const validated = findings.filter((f) => f.validation === "confirmed").length;
  if (validated > 0) {
    lines.push("");
    lines.push(`_${validated} low-confidence finding(s) re-checked and confirmed by the validation agent._`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(reporting.summary || "_No summary available._");
  if (reporting.topRisks.length) {
    lines.push("");
    lines.push("## Top risks");
    for (const r of reporting.topRisks) lines.push(`- ${r}`);
  }
  if (reporting.recommendedNextSteps.length) {
    lines.push("");
    lines.push("## Recommended next steps");
    reporting.recommendedNextSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  lines.push("");
  lines.push("## All findings");
  lines.push("");
  lines.push("| Severity | Agent | Location | Issue | Suggested fix |");
  lines.push("|---|---|---|---|---|");
  for (const f of findings) {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "—";
    lines.push(
      `| ${f.severity} | ${f.agent} | ${loc} | ${escapeCell(f.title)} | ${escapeCell(f.suggestedFix)} |`,
    );
  }
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Deterministic fallback actions when the AI layer is unavailable. */
export function fallbackActions(findings: Finding[]): MachineAction[] {
  return findings.slice(0, 40).map((f) => ({
    actionType:
      f.agent === "security"
        ? f.taskId === "secrets-scan"
          ? "notify-owner"
          : "run-command"
        : f.agent === "documentation"
          ? "create-ticket"
          : "update-file",
    priority: f.severity,
    target: f.file ?? f.taskId,
    instruction: `${f.title}. ${f.suggestedFix}`,
    acceptanceCriteria:
      f.agent === "security"
        ? "Dependency audit reports no remaining advisory for this component."
        : "Change applied and existing tests/build still pass.",
  }));
}

/**
 * Scope the manifest to the paths the findings actually touch, so a fixing
 * agent gets a real constraint instead of a blanket "**".
 */
export function deriveAllowedPaths(findings: Finding[]): string[] {
  const paths = new Set<string>();
  for (const f of findings) {
    if (!f.file) continue;
    const first = f.file.split("/")[0];
    paths.add(f.file.includes("/") ? `${first}/**` : first);
    if (paths.size >= 10) break;
  }
  return paths.size > 0 ? Array.from(paths).sort() : ["**"];
}

export interface ReportResult {
  humanMarkdown: string;
  manifest: FixManifest;
  call: AgentCallResult<ReportingOutput> | null;
}

export async function buildReports(params: {
  scanId: string;
  repoName: string;
  repoUrl: string | null;
  branch: string | null;
  commit?: string | null;
  model: string;
  findings: Finding[];
  scores: Scores;
  /** True when the token budget is exhausted — use the deterministic path. */
  skipAi?: boolean;
  signal?: AbortSignal;
}): Promise<ReportResult> {
  let reporting = {
    summary: "",
    topRisks: [] as string[],
    recommendedNextSteps: [] as string[],
  };
  let actions: MachineAction[];
  let call: AgentCallResult<ReportingOutput> | null = null;

  if (params.findings.length === 0) {
    reporting.summary = "No findings above the configured severity threshold. The repository looks healthy for the analyzed dimensions.";
    actions = [];
  } else if (params.skipAi) {
    reporting.summary = `Automated summary skipped (per-scan token budget exhausted). ${params.findings.length} findings detected; see the table below and the fix manifest.`;
    reporting.topRisks = params.findings.slice(0, 5).map((f) => `${f.severity.toUpperCase()}: ${f.title}`);
    reporting.recommendedNextSteps = params.findings.slice(0, 5).map((f) => f.suggestedFix);
    actions = fallbackActions(params.findings);
  } else {
    const compact = compactFindings(params.findings);
    call = await agentCall({
      model: params.model,
      systemPrompt: REPORTING_PROMPT,
      userContent: JSON.stringify({
        repository: params.repoName,
        scores: params.scores,
        findings: compact.rows,
        // No silent truncation: tell the agent (and reader) what was left out.
        ...(compact.omitted > 0
          ? { note: `${compact.omitted} lower-priority findings omitted from this list; they appear in the full table.` }
          : {}),
      }),
      schema: ReportingOutput,
      maxTokens: 4096,
      effort: "low",
      signal: params.signal,
    });

    if (call.status === "ok" && call.output) {
      reporting = {
        summary: call.output.summary,
        topRisks: call.output.topRisks,
        recommendedNextSteps: call.output.recommendedNextSteps,
      };
      actions = call.output.machineActions;
    } else {
      // AI unavailable or errored — deterministic fallback from findings.
      reporting.summary = `Automated summary unavailable (${call.detail ?? "AI skipped"}). ${params.findings.length} findings detected; see the table below and the fix manifest.`;
      reporting.topRisks = params.findings
        .slice(0, 5)
        .map((f) => `${f.severity.toUpperCase()}: ${f.title}`);
      reporting.recommendedNextSteps = params.findings
        .slice(0, 5)
        .map((f) => f.suggestedFix);
      actions = fallbackActions(params.findings);
    }
  }

  const manifest: FixManifest = {
    $schema: "repo-radar/fix-manifest@1",
    scanId: params.scanId,
    repository: { url: params.repoUrl, branch: params.branch, commit: params.commit ?? null },
    generatedAt: new Date().toISOString(),
    actions,
    constraints: {
      allowedPaths: deriveAllowedPaths(params.findings),
      executionMode: "proposal",
    },
  };

  return {
    humanMarkdown: buildHumanMarkdown(params.repoName, params.scores, reporting, params.findings),
    manifest,
    call,
  };
}
