import type * as z from "zod/v4";
import type { AgentKind, TaskInfo } from "@repo-radar/shared";
import type { Task } from "./types.js";
import { securityDepsTask } from "./security-deps/index.js";
import { secretsScanTask } from "./secrets-scan/index.js";
import { codeModernizationTask } from "./code-modernization/index.js";
import { docsCoverageTask } from "./docs-coverage/index.js";

/** All registered tasks. Add a new analysis type here — nothing else changes. */
export const TASKS: Task<z.ZodType>[] = [
  securityDepsTask as Task<z.ZodType>,
  secretsScanTask as Task<z.ZodType>,
  codeModernizationTask as Task<z.ZodType>,
  docsCoverageTask as Task<z.ZodType>,
];

type EnableFlag = "includeSecurity" | "includeCodeQuality" | "includeDocumentation";

/** Which config flag gates each agent kind. */
const AGENT_ENABLE_FLAG: Record<AgentKind, EnableFlag | null> = {
  security: "includeSecurity",
  code: "includeCodeQuality",
  documentation: "includeDocumentation",
  reporting: null,
};

export function tasksEnabledBy(config: Record<EnableFlag, boolean>): Task<z.ZodType>[] {
  return TASKS.filter((t) => {
    const flag = AGENT_ENABLE_FLAG[t.meta.agent];
    if (!flag) return false;
    return Boolean(config[flag]);
  });
}

export function taskInfos(): TaskInfo[] {
  return TASKS.map((t) => ({
    id: t.meta.id,
    agent: t.meta.agent,
    title: t.meta.title,
    description: t.meta.description,
    ecosystems: t.meta.ecosystems,
    maxFindings: t.meta.maxFindings,
    effort: t.meta.effort,
  }));
}
