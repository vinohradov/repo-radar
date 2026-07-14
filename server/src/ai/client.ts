import Anthropic from "@anthropic-ai/sdk";
import { config, hasApiKey } from "../config.js";

let client: Anthropic | null = null;

export function getClient(): Anthropic | null {
  if (!hasApiKey()) return null;
  if (!client) client = new Anthropic({ apiKey: config.apiKey });
  return client;
}

/** Effort and adaptive thinking are supported on Opus 4.6+ / Sonnet 5, not Haiku. */
export function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
}
