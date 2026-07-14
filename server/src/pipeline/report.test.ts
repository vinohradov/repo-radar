import { describe, it, expect } from "vitest";
import type { Finding } from "@repo-radar/shared";
import { deriveAllowedPaths, fallbackActions } from "./report.js";

function finding(partial: Partial<Finding>): Finding {
  return {
    id: "f1",
    scanId: "s1",
    agent: "code",
    taskId: "code-modernization",
    type: "modernisation",
    severity: "medium",
    file: "src/a.ts",
    line: 1,
    title: "t",
    description: "d",
    suggestedFix: "fix",
    confidence: 0.9,
    reference: null,
    fingerprint: "fp",
    validation: null,
    feedback: null,
    ...partial,
  };
}

describe("deriveAllowedPaths", () => {
  it("scopes to top-level dirs and root files the findings touch", () => {
    const paths = deriveAllowedPaths([
      finding({ file: "src/a.ts" }),
      finding({ file: "src/deep/b.ts" }),
      finding({ file: "package.json" }),
    ]);
    expect(paths).toEqual(["package.json", "src/**"]);
  });

  it("falls back to ** when no finding has a file", () => {
    expect(deriveAllowedPaths([finding({ file: null })])).toEqual(["**"]);
  });
});

describe("fallbackActions", () => {
  it("maps agents to distinct action types (no more all-update-file)", () => {
    const actions = fallbackActions([
      finding({ agent: "security", taskId: "security-deps" }),
      finding({ agent: "security", taskId: "secrets-scan" }),
      finding({ agent: "documentation" }),
      finding({ agent: "code" }),
    ]);
    expect(actions.map((a) => a.actionType)).toEqual([
      "run-command",
      "notify-owner",
      "create-ticket",
      "update-file",
    ]);
  });
});
