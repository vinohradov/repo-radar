import type { FastifyInstance } from "fastify";
import { CreateScanRequest, ScanConfig, type ReportAudience } from "@repo-radar/shared";
import { scansRepo, findingsRepo, reportsRepo, agentRunsRepo } from "../db/repositories.js";
import { scanEvents } from "../events.js";
import { newScan, runScan } from "../pipeline/runner.js";

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  // Start a scan — the one-click action.
  app.post("/api/scans", async (req, reply) => {
    const parsed = CreateScanRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues });
    }
    const config = ScanConfig.parse(parsed.data.config ?? {});
    const scan = newScan({
      repoUrl: parsed.data.repoUrl ?? null,
      localPath: parsed.data.localPath ?? null,
      branch: parsed.data.branch ?? null,
      label: parsed.data.label ?? null,
      config,
    });
    // Fire-and-forget; progress streams over SSE. Token is passed in-memory only.
    void runScan(scan.id, parsed.data.token);
    return reply.code(201).send(scan);
  });

  app.get("/api/scans", async () => scansRepo.list());

  app.get<{ Params: { id: string } }>("/api/scans/:id", async (req, reply) => {
    const scan = scansRepo.get(req.params.id);
    if (!scan) return reply.code(404).send({ error: "Scan not found" });
    return scan;
  });

  app.delete<{ Params: { id: string } }>("/api/scans/:id", async (req, reply) => {
    const scan = scansRepo.get(req.params.id);
    if (!scan) return reply.code(404).send({ error: "Scan not found" });
    scansRepo.delete(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/scans/:id/findings", async (req, reply) => {
    const scan = scansRepo.get(req.params.id);
    if (!scan) return reply.code(404).send({ error: "Scan not found" });
    return findingsRepo.listByScan(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/scans/:id/runs", async (req) => {
    return agentRunsRepo.listByScan(req.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { audience?: string; download?: string } }>(
    "/api/scans/:id/report",
    async (req, reply) => {
      const audience = (req.query.audience === "agent" ? "agent" : "human") as ReportAudience;
      const report = reportsRepo.get(req.params.id, audience);
      if (!report) return reply.code(404).send({ error: "Report not ready" });
      if (req.query.download) {
        const ext = audience === "agent" ? "json" : "md";
        const ct = audience === "agent" ? "application/json" : "text/markdown";
        reply.header("content-type", ct);
        reply.header(
          "content-disposition",
          `attachment; filename="repo-radar-${audience}-${req.params.id}.${ext}"`,
        );
        return report.content;
      }
      return report;
    },
  );

  // SSE progress stream.
  app.get<{ Params: { id: string } }>("/api/scans/:id/events", async (req, reply) => {
    const scanId = req.params.id;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`retry: 3000\n\n`);

    const scan = scansRepo.get(scanId);
    if (scan) {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(scan)}\n\n`);
    }

    const unsubscribe = scanEvents.subscribe(scanId, (e) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Keep the handler open; SSE lifetime is bound to the connection.
    return reply;
  });
}
