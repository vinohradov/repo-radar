import { describe, it, expect } from "vitest";
import { tasksForScan, TASKS } from "./registry.js";

const baseFlags = {
  includeSecurity: true,
  includeCodeQuality: true,
  includeDocumentation: true,
};

describe("tasksForScan", () => {
  it("runs everything by default", () => {
    const tasks = tasksForScan({ ...baseFlags, enabledTasks: null }, []);
    expect(tasks.length).toBe(TASKS.length);
  });

  it("an explicit per-scan selection wins over everything", () => {
    const tasks = tasksForScan({ ...baseFlags, enabledTasks: ["docs-coverage"] }, ["docs-coverage"]);
    expect(tasks.map((t) => t.meta.id)).toEqual(["docs-coverage"]);
  });

  it("globally disabled tasks are skipped when no explicit selection", () => {
    const tasks = tasksForScan({ ...baseFlags, enabledTasks: null }, ["secrets-scan"]);
    expect(tasks.some((t) => t.meta.id === "secrets-scan")).toBe(false);
    expect(tasks.length).toBe(TASKS.length - 1);
  });

  it("include flags still gate whole agents", () => {
    const tasks = tasksForScan({ ...baseFlags, includeSecurity: false, enabledTasks: null }, []);
    expect(tasks.every((t) => t.meta.agent !== "security")).toBe(true);
  });
});
