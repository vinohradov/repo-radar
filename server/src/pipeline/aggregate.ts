import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Finding, Scores, Severity } from "@repo-radar/shared";
import { SEVERITY_ORDER } from "@repo-radar/shared";
import type { NormalizedFinding } from "../tasks/types.js";

function fingerprint(f: NormalizedFinding): string {
  return createHash("sha1")
    .update(`${f.taskId}|${f.file ?? ""}|${f.line ?? ""}|${f.title}`)
    .digest("hex")
    .slice(0, 16);
}

/** Dedupe by fingerprint (keep highest confidence) and apply severity threshold. */
export function aggregate(
  raw: NormalizedFinding[],
  scanId: string,
  severityThreshold: Severity,
): Finding[] {
  const byFp = new Map<string, Finding>();
  const minSev = SEVERITY_ORDER[severityThreshold];

  for (const nf of raw) {
    if (SEVERITY_ORDER[nf.severity] < minSev) continue;
    const fp = fingerprint(nf);
    const existing = byFp.get(fp);
    const finding: Finding = {
      id: nanoid(12),
      scanId,
      agent: nf.agent,
      taskId: nf.taskId,
      type: nf.type,
      severity: nf.severity,
      file: nf.file,
      line: nf.line,
      title: nf.title,
      description: nf.description,
      suggestedFix: nf.suggestedFix,
      confidence: nf.confidence,
      reference: nf.reference ?? null,
      fingerprint: fp,
      validation: null,
      feedback: null,
    };
    if (!existing || finding.confidence > existing.confidence) {
      byFp.set(fp, existing ? { ...finding, id: existing.id } : finding);
    }
  }

  return Array.from(byFp.values()).sort((a, b) => {
    const sev = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    return sev !== 0 ? sev : b.confidence - a.confidence;
  });
}

/** Derive the dashboard stat tiles from the findings. */
export function computeScores(findings: Finding[]): Scores {
  const count = (agent: Finding["agent"], sev: Severity) =>
    findings.filter((f) => f.agent === agent && f.severity === sev).length;

  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;

  // Health: start at 100, subtract weighted penalties, floor at 0.
  const penalty = critical * 12 + high * 6 + medium * 2 + (findings.length - critical - high - medium) * 0.5;
  const health = Math.max(0, Math.round(100 - penalty));

  const secCrit = count("security", "critical") + count("security", "high");
  const security: Scores["security"] = secCrit > 0 ? "Low" : count("security", "medium") > 0 ? "Medium" : "High";

  const codeIssues = findings.filter((f) => f.agent === "code").length;
  const code: Scores["code"] = codeIssues > 12 ? "Poor" : codeIssues > 4 ? "Fair" : "Good";

  const docIssues = findings.filter((f) => f.agent === "documentation").length;
  const docs: Scores["docs"] = docIssues > 6 ? "Poor" : docIssues > 2 ? "Fair" : "Good";

  return { health, security, code, docs };
}
