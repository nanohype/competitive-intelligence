/**
 * Provider resolution for the eval tier.
 *
 * Deliberately not `bootstrapLlm` from src/: that reads the app's full Zod
 * config, which demands vector-store and crawler settings an eval run has no
 * business needing. The eval wants exactly one thing — an LlmProvider — and
 * asking for it directly keeps a missing DATABASE_URL from failing an eval.
 */
import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_ANTHROPIC_LLM_MODEL, DEFAULT_BEDROCK_LLM_MODEL } from "../src/config.js";
import type { LlmProvider, LlmResponse } from "../src/providers/llm.js";

const TIMEOUT_MS = 120_000;

/** Backends an eval may name. Kept narrow — these are the ones we run on. */
export const EVAL_BACKENDS = ["bedrock", "anthropic"] as const;
export type EvalBackend = (typeof EVAL_BACKENDS)[number];

/**
 * Resolve the provider named by EVAL_LLM.
 *
 * Throws on anything it cannot honour. That is the point: by the time this is
 * called, someone has explicitly asked for a model run, so an unusable
 * configuration must fail the run rather than quietly reduce it to nothing.
 */
export function resolveEvalLlm(name: string): LlmProvider {
  if (!(EVAL_BACKENDS as readonly string[]).includes(name)) {
    throw new Error(
      `EVAL_LLM="${name}" is not a known eval backend (${EVAL_BACKENDS.join(" | ")}). ` +
        `Unset EVAL_LLM to skip the model tier; setting it means it must run.`,
    );
  }

  if (name === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('EVAL_LLM="anthropic" requires ANTHROPIC_API_KEY.');
    }
    return anthropicProvider(apiKey, process.env.EVAL_MODEL || DEFAULT_ANTHROPIC_LLM_MODEL);
  }

  // Bedrock rides the AWS credential chain — Pod Identity in cluster, the
  // usual profile/role locally. There is no key to check here, so a missing
  // credential surfaces as the first call failing, which is still a failure
  // and not a skip.
  return bedrockProvider(
    process.env.AWS_REGION ?? "us-west-2",
    process.env.EVAL_MODEL || DEFAULT_BEDROCK_LLM_MODEL,
  );
}

function bedrockProvider(region: string, modelId: string): LlmProvider {
  const client = new BedrockRuntimeClient({
    region,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: TIMEOUT_MS },
  });
  return {
    async chat(system, userMessage) {
      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: userMessage }] }],
          // No temperature: the current Sonnet generation rejects the knob
          // outright ("`temperature` is deprecated for this model"). So there
          // is no dial to pin a run down with, and two runs of the same
          // fixture can legitimately differ. That is the reason capability is
          // scored as a rate against a floor rather than case by case.
          inferenceConfig: { maxTokens: 4096 },
        }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const text =
        response.output?.message?.content
          ?.filter((b) => "text" in b)
          .map((b) => b.text)
          .join("") ?? "";
      return zeroUsage(text);
    },
  };
}

function anthropicProvider(apiKey: string, model: string): LlmProvider {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 2 });
  return {
    async chat(system, userMessage) {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: userMessage }],
      });
      return zeroUsage(
        response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
      );
    },
  };
}

/** Token counts are not what an eval measures; the app's metrics path is. */
function zeroUsage(text: string): LlmResponse {
  return { text, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
