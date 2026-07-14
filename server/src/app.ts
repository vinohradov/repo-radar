import Fastify from "fastify";
import cors from "@fastify/cors";
import { MODELS } from "@repo-radar/shared";
import { scanRoutes } from "./routes/scans.js";
import { taskRoutes } from "./routes/tasks.js";
import { settingsRoutes } from "./routes/settings.js";
import { hasApiKey, config } from "./config.js";

export async function buildApp() {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    hasApiKey: hasApiKey(),
    defaultModel: config.defaultModel,
    models: MODELS,
  }));

  await app.register(scanRoutes);
  await app.register(taskRoutes);
  await app.register(settingsRoutes);

  return app;
}
