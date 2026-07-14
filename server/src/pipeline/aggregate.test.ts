import { describe, it, expect } from "vitest";
import { aggregate, computeScores } from "./aggregate.js";
import type { NormalizedFinding } from "../tasks/types.js";

function nf(partial: Partial<NormalizedFinding>): NormalizedFinding {
  return {
    agent: "code",
    taskId: "code-modernization",
    type: "modernisation",
    severity: "medium",
    file: "src/a.ts",
    line: 10,
    title: "Use const",
    description: "d",
    suggestedFix: "f",
    confidence: 0.5,
    ...partial,
  };
}

describe("aggregate", () => {
  it("dedupes identical findings and keeps the highest confidence", () => {
    const raw = [nf({ confidence: 0.4 }), nf({ confidence: 0.9 }), nf({ confidence: 0.6 })];
    const out = aggregate(raw, "scan1", "low");
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.9);
  });

  it("keeps distinct findings separate", () => {
    const raw = [nf({ title: "A", line: 1 }), nf({ title: "B", line: 2 })];
    const out = aggregate(raw, "scan1", "low");
    expect(out).toHaveLength(2);
  });

  it("drops findings below the severity threshold", () => {
    const raw = [nf({ severity: "low", title: "L" }), nf({ severity: "high", title: "H" })];
    const out = aggregate(raw, "scan1", "high");
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });

  it("sorts by severity then confidence", () => {
    const raw = [
      nf({ severity: "low", title: "L", line: 1 }),
      nf({ severity: "critical", title: "C", line: 2 }),
      nf({ severity: "high", title: "H", line: 3 }),
    ];
    const out = aggregate(raw, "scan1", "low");
    expect(out.map((f) => f.severity)).toEqual(["critical", "high", "low"]);
  });
});

describe("computeScores", () => {
  it("reports full health and High security for no findings", () => {
    const scores = computeScores([]);
    expect(scores.health).toBe(100);
    expect(scores.security).toBe("High");
    expect(scores.code).toBe("Good");
  });

  it("lowers security when there is a high/critical security finding", () => {
    const findings = aggregate([nf({ agent: "security", severity: "critical", title: "vuln" })], "s", "low");
    const scores = computeScores(findings);
    expect(scores.security).toBe("Low");
    expect(scores.health).toBeLessThan(100);
  });
});
