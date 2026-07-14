import { ValidationOutput, type Finding } from "@repo-radar/shared";
import { agentCall, type AgentCallResult } from "../ai/agentCall.js";

/**
 * FROZEN PROMPT — keep byte-stable so it stays prompt-cacheable across scans.
 * Do not interpolate dynamic values here; those go in the user message.
 */
const VALIDATION_PROMPT = `You are a Validation agent — an adversarial reviewer inside a repository scanner.

You receive findings that other analysis agents produced with LOW confidence,
together with the compacted evidence those agents saw. Your job is to catch
hallucinations and weak reasoning before findings reach the user.

For each finding, decide:
- "confirmed" — the evidence genuinely supports the finding as stated.
- "rejected"  — the finding is not grounded in the evidence, overstates the
  problem, duplicates another finding, or is a plausible-sounding fabrication.

Be skeptical by default: if the evidence does not clearly support the finding,
reject it. Do not soften verdicts to be polite. Echo each finding's id exactly.
Return a verdict for EVERY finding you were given.`;

/** How much of each task's evidence the validator gets to see (chars). */
const EVIDENCE_SLICE = 6000;

export async function validateFindings(params: {
  model: string;
  findings: Finding[];
  evidenceByTask: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<AgentCallResult<ValidationOutput>> {
  const compactFindings = params.findings.map((f) => ({
    id: f.id,
    taskId: f.taskId,
    agent: f.agent,
    severity: f.severity,
    file: f.file,
    line: f.line,
    title: f.title,
    description: f.description,
    confidence: f.confidence,
  }));

  const relevantTaskIds = new Set(params.findings.map((f) => f.taskId));
  const evidence: Record<string, string> = {};
  for (const taskId of relevantTaskIds) {
    const ev = params.evidenceByTask[taskId];
    if (ev !== undefined) {
      const raw = JSON.stringify(ev);
      evidence[taskId] = raw.length > EVIDENCE_SLICE ? `${raw.slice(0, EVIDENCE_SLICE)}…(truncated)` : raw;
    }
  }

  return agentCall({
    model: params.model,
    systemPrompt: VALIDATION_PROMPT,
    userContent: JSON.stringify({ findings: compactFindings, evidenceByTask: evidence }),
    schema: ValidationOutput,
    maxTokens: 4096,
    effort: "high",
    signal: params.signal,
  });
}
