import { buildApp } from "./app.js";
import { config, hasApiKey } from "./config.js";
import { sweepWorkspace } from "./pipeline/acquire.js";
import { startScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  // A crash mid-scan orphans workspace checkouts — clear them at boot.
  sweepWorkspace();
  const app = await buildApp();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  startScheduler((msg) => app.log.info(msg));
  app.log.info(
    `Repo Radar server on :${config.port} — AI layer ${hasApiKey() ? "enabled" : "DISABLED (set ANTHROPIC_API_KEY)"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
