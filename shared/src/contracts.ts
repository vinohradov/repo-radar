import * as z from "zod/v4";
import { Severity } from "./domain.js";

/**
 * Agent I/O contracts. These are the structured-output schemas each agent is
 * constrained to via output_config.format. Descriptions are load-bearing: they
 * are sent to the model as the schema and enforce concise, bounded output.
 *
 * Note: structured outputs do not support minLength/maxLength constraints, so
 * "max 2-3 sentences" limits live in the descriptions, backed by per-task
 * max_tokens caps.
 */

export const CodeFinding = z.object({
  type: z.enum(["code-quality", "maintainability", "modernisation"]),
  severity: Severity,
  file: z.string().describe("Repo-relative file path"),
  line: z.number().nullable().describe("1-indexed line, or null if not applicable"),
  title: z.string().describe("Short issue title, under 10 words"),
  description: z.string().describe("What is wrong and why it matters. Max 2-3 sentences."),
  suggestedFix: z.string().describe("Short, concrete recommendation. One sentence."),
  confidence: z.number().describe("0.0-1.0 confidence this is a genuine, worthwhile issue"),
});
export type CodeFinding = z.infer<typeof CodeFinding>;

export const CodeAnalysisOutput = z.object({
  issues: z.array(CodeFinding),
});
export type CodeAnalysisOutput = z.infer<typeof CodeAnalysisOutput>;

export const SecurityFinding = z.object({
  component: z.string().describe("Dependency/package name"),
  currentVersion: z.string(),
  severity: Severity,
  risk: z.string().describe("Short risk explanation grounded in the advisory. Max 2 sentences."),
  recommendation: z.enum(["upgrade", "replace", "investigate", "configure"]),
  targetVersion: z.string().nullable().describe("Safe version to upgrade to, or null"),
  reference: z.string().nullable().describe("CVE/GHSA id or advisory URL, or null"),
  manifest: z
    .string()
    .nullable()
    .describe("Manifest file the dependency comes from, echoed from the evidence (e.g. package.json, pom.xml)"),
  confidence: z.number().describe("0.0-1.0 confidence the risk is real and relevant to THIS repo"),
});
export type SecurityFinding = z.infer<typeof SecurityFinding>;

export const SecurityOutput = z.object({
  vulnerabilities: z.array(SecurityFinding),
});
export type SecurityOutput = z.infer<typeof SecurityOutput>;

export const DocFinding = z.object({
  area: z.enum(["setup", "usage", "architecture", "api", "troubleshooting"]),
  severity: Severity,
  title: z.string().describe("Short gap title"),
  description: z.string().describe("What documentation is missing or weak. Max 2 sentences."),
  suggestedContent: z.string().describe("Outline of what to add. One or two sentences."),
  confidence: z.number().describe("0.0-1.0"),
});
export type DocFinding = z.infer<typeof DocFinding>;

export const DocOutput = z.object({
  gaps: z.array(DocFinding),
});
export type DocOutput = z.infer<typeof DocOutput>;

/** Secrets-scan agent output (candidates are pre-redacted by the collector). */
export const SecretFinding = z.object({
  file: z.string().describe("Repo-relative file path from the candidate"),
  line: z.number().nullable().describe("1-indexed line, or null"),
  kind: z.string().describe("Type of secret (e.g. AWS access key, GitHub token)"),
  severity: Severity,
  risk: z.string().describe("Blast radius if leaked. Max 2 sentences."),
  recommendation: z.string().describe("One sentence: rotate + move to env/secret manager."),
  confidence: z.number().describe("0.0-1.0 likelihood this is a REAL secret, not a placeholder"),
});
export type SecretFinding = z.infer<typeof SecretFinding>;

export const SecretsOutput = z.object({
  secrets: z.array(SecretFinding),
});
export type SecretsOutput = z.infer<typeof SecretsOutput>;

/** Validation agent output — adversarial re-check of low-confidence findings. */
export const ValidationVerdict = z.object({
  findingId: z.string().describe("The id of the finding being judged, echoed from the input"),
  verdict: z
    .enum(["confirmed", "rejected"])
    .describe("confirmed = the finding is real and grounded in the evidence; rejected = likely false positive"),
  note: z.string().describe("One sentence justifying the verdict."),
});
export type ValidationVerdict = z.infer<typeof ValidationVerdict>;

export const ValidationOutput = z.object({
  verdicts: z.array(ValidationVerdict),
});
export type ValidationOutput = z.infer<typeof ValidationOutput>;

/** Machine-oriented action for a downstream fixing agent (report type 2). */
export const MachineAction = z.object({
  actionType: z.enum(["create-ticket", "run-command", "update-file", "notify-owner"]),
  priority: Severity,
  target: z.string().describe("File path, package, or subsystem the action applies to"),
  instruction: z.string().describe("Deterministic, self-contained instruction for a fixing agent."),
  acceptanceCriteria: z.string().describe("How the fixing agent knows it succeeded."),
});
export type MachineAction = z.infer<typeof MachineAction>;

export const ReportingOutput = z.object({
  summary: z.string().describe("2-4 sentence overview of the repo's health for a human reader."),
  topRisks: z.array(z.string()).describe("Up to 5 highest-priority risks, one line each."),
  recommendedNextSteps: z.array(z.string()).describe("Up to 5 concrete next steps, ordered."),
  machineActions: z.array(MachineAction).describe("Actions for a fixing agent, highest priority first."),
});
export type ReportingOutput = z.infer<typeof ReportingOutput>;

/** The downloadable fix manifest (report type 2), assembled in code. */
export const FixManifest = z.object({
  $schema: z.literal("repo-radar/fix-manifest@1"),
  scanId: z.string(),
  repository: z.object({
    url: z.string().nullable(),
    branch: z.string().nullable(),
    commit: z.string().nullable(),
  }),
  generatedAt: z.string(),
  actions: z.array(MachineAction),
  constraints: z.object({
    allowedPaths: z.array(z.string()),
    executionMode: z.enum(["dry-run", "proposal", "apply"]),
  }),
});
export type FixManifest = z.infer<typeof FixManifest>;
