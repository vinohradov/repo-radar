import type { FastifyInstance } from "fastify";
import { taskInfos } from "../tasks/registry.js";
import { agentRunsRepo, findingsRepo, settingsRepo } from "../db/repositories.js";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks", async () => {
    const infos = taskInfos();
    const stats = agentRunsRepo.aggregateAvgByTask();
    const feedback = findingsRepo.feedbackByTask();
    let disabled: string[] = [];
    const raw = settingsRepo.get("disabledTasks");
    if (raw) {
      try {
        disabled = JSON.parse(raw) as string[];
      } catch {
        disabled = [];
      }
    }
    return infos.map((t) => ({
      ...t,
      enabled: !disabled.includes(t.id),
      stats: stats[t.id] ?? { avgTokens: 0, avgCost: 0, runs: 0 },
      feedback: feedback[t.id] ?? { up: 0, down: 0 },
    }));
  });
}
