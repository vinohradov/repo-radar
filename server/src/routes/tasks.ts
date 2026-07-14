import type { FastifyInstance } from "fastify";
import { taskInfos } from "../tasks/registry.js";
import { agentRunsRepo } from "../db/repositories.js";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks", async () => {
    const infos = taskInfos();
    const stats = agentRunsRepo.aggregateAvgByTask();
    return infos.map((t) => ({
      ...t,
      stats: stats[t.id] ?? { avgTokens: 0, avgCost: 0, runs: 0 },
    }));
  });
}
