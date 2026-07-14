import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentKind, Settings, Severity } from "@repo-radar/shared";
import { settingsRepo } from "../db/repositories.js";
import { config, hasApiKey } from "../config.js";

const AGENTS: AgentKind[] = ["code", "security", "documentation", "reporting"];

function currentSettings(): Settings {
  const modelsRaw = settingsRepo.get("models");
  let models: Record<string, string> = {};
  if (modelsRaw) {
    try {
      models = JSON.parse(modelsRaw);
    } catch {
      models = {};
    }
  }
  const resolved = {} as Record<AgentKind, string>;
  for (const a of AGENTS) resolved[a] = models[a] || config.defaultModel;

  const excludedRaw = settingsRepo.get("excludedPaths");
  const excludedPaths = excludedRaw
    ? (JSON.parse(excludedRaw) as string[])
    : ["node_modules", "dist", "build", ".git", "coverage"];

  return {
    models: resolved,
    severityThreshold: (settingsRepo.get("severityThreshold") as Severity | null) ?? "low",
    excludedPaths,
    hasApiKey: hasApiKey(),
  };
}

const UpdateSettings = z.object({
  models: z.record(z.string(), z.string()).optional(),
  severityThreshold: z.enum(["low", "medium", "high", "critical"]).optional(),
  excludedPaths: z.array(z.string()).optional(),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => currentSettings());

  app.put("/api/settings", async (req, reply) => {
    const parsed = UpdateSettings.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (parsed.data.models) settingsRepo.set("models", JSON.stringify(parsed.data.models));
    if (parsed.data.severityThreshold) settingsRepo.set("severityThreshold", parsed.data.severityThreshold);
    if (parsed.data.excludedPaths) settingsRepo.set("excludedPaths", JSON.stringify(parsed.data.excludedPaths));
    return currentSettings();
  });
}
