/** Per-model pricing ($/MTok) for the cost estimate shown in the UI. */
export interface ModelPricing {
  id: string;
  label: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

export const MODELS: ModelPricing[] = [
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    inputPerMtok: 5,
    outputPerMtok: 25,
    cacheReadPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    inputPerMtok: 3,
    outputPerMtok: 15,
    cacheReadPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    inputPerMtok: 1,
    outputPerMtok: 5,
    cacheReadPerMtok: 0.1,
    cacheWritePerMtok: 1.25,
  },
];

export function pricingFor(modelId: string): ModelPricing {
  return MODELS.find((m) => m.id === modelId) ?? MODELS[0];
}

/** The Message Batches API is billed at 50% of standard pricing. */
export const BATCH_DISCOUNT = 0.5;

export function estimateCostUsd(
  modelId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
  opts?: { batch?: boolean },
): number {
  const p = pricingFor(modelId);
  let cost =
    (usage.inputTokens / 1_000_000) * p.inputPerMtok +
    (usage.outputTokens / 1_000_000) * p.outputPerMtok +
    (usage.cacheReadTokens / 1_000_000) * p.cacheReadPerMtok +
    (usage.cacheCreationTokens / 1_000_000) * p.cacheWritePerMtok;
  if (opts?.batch) cost *= BATCH_DISCOUNT;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
