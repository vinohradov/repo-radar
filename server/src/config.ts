import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env from the repo root (two levels up from server/src).
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../.env") });

const DEFAULT_MODEL = process.env.REPO_RADAR_MODEL || "claude-opus-4-8";

export const config = {
  port: Number(process.env.PORT || 8787),
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  defaultModel: DEFAULT_MODEL,
  maxOutputTokensPerScan: Number(process.env.REPO_RADAR_MAX_OUTPUT_TOKENS_PER_SCAN || 60000),
  // Where cloned repos and the sqlite db live (repo root).
  dataDir: path.resolve(here, "../../data"),
  workspaceDir: path.resolve(here, "../../workspace"),
};

export function hasApiKey(): boolean {
  return config.apiKey.trim().length > 0;
}
