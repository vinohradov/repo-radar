import type * as z from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { estimateCostUsd } from "@repo-radar/shared";
import { getClient, supportsEffort } from "./client.js";

export interface AgentCallResult<T> {
  status: "ok" | "skipped" | "error";
  output: T | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  durationMs: number;
  detail: string | null;
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
};

/**
 * The single agent call site for the whole app. Every agent goes through here.
 *
 * Token efficiency, all in one place:
 *  - frozen system prompt sent with cache_control:ephemeral (prefix cache)
 *  - structured output via output_config.format (no JSON-retry loops)
 *  - per-task max_tokens cap + effort tuning
 *  - full usage (incl. cache read) captured for accounting
 */
export async function agentCall<TSchema extends z.ZodType>(params: {
  model: string;
  systemPrompt: string;
  userContent: string;
  schema: TSchema;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}): Promise<AgentCallResult<z.infer<TSchema>>> {
  const client = getClient();
  if (!client) {
    return {
      status: "skipped",
      output: null,
      usage: EMPTY_USAGE,
      durationMs: 0,
      detail: "No ANTHROPIC_API_KEY — analyze phase skipped",
    };
  }

  const started = Date.now();
  try {
    const request: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: [
        {
          type: "text",
          text: params.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: params.userContent }],
      output_config: {
        format: zodOutputFormat(params.schema),
        ...(supportsEffort(params.model) ? { effort: params.effort } : {}),
      },
    };
    if (supportsEffort(params.model)) {
      request.thinking = { type: "adaptive" };
    }

    // Use create() (not parse()) so we always capture usage — even when the
    // model output is truncated or invalid JSON. We parse the text ourselves.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages as any).create(request);

    const u = message.usage ?? {};
    const usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      costUsd: 0,
    };
    usage.costUsd = estimateCostUsd(params.model, usage);
    const elapsed = () => Date.now() - started;

    if (message.stop_reason === "refusal") {
      return { status: "error", output: null, usage, durationMs: elapsed(), detail: "Model refused the request" };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (message.content ?? [])
      .filter((b: { type?: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("");

    if (message.stop_reason === "max_tokens") {
      return {
        status: "error",
        output: null,
        usage,
        durationMs: elapsed(),
        detail: "Output hit max_tokens (truncated) — raise the task's maxTokens",
      };
    }

    try {
      const parsed = params.schema.parse(JSON.parse(text)) as z.infer<TSchema>;
      return { status: "ok", output: parsed, usage, durationMs: elapsed(), detail: null };
    } catch (parseErr) {
      return {
        status: "error",
        output: null,
        usage, // usage is preserved even though parsing failed
        durationMs: elapsed(),
        detail: `Could not parse structured output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
  } catch (err) {
    return {
      status: "error",
      output: null,
      usage: EMPTY_USAGE,
      durationMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
