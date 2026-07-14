import { buildApp } from "./app.js";
import { config, hasApiKey } from "./config.js";

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    `Repo Radar server on :${config.port} — AI layer ${hasApiKey() ? "enabled" : "DISABLED (set ANTHROPIC_API_KEY)"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
