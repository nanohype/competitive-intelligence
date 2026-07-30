/**
 * Provider resolution for the eval tier.
 *
 * Deliberately not `bootstrapLlm` from src/: that reads the app's full Zod
 * config, which demands vector-store and crawler settings an eval run has no
 * business needing. The eval wants exactly one thing — an LlmProvider — and
 * asking for it directly keeps a missing DATABASE_URL from failing an eval.
 *
 * It builds the *same* client the app uses, pointed at a ModelGateway, so the
 * eval measures the path production runs on — including the route's guardrail,
 * which is part of what these prompts are graded against. A direct-to-Bedrock
 * path here would grade a configuration no environment deploys.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_LLM_ROUTE } from "../src/config.js";
import type { LlmProvider, LlmResponse } from "../src/providers/llm.js";

const TIMEOUT_MS = 120_000;

/**
 * Backends an eval may name.
 *
 * One, and that is the design rather than an omission: every model this org
 * runs is reached through a ModelGateway, so a backend that went around one
 * would measure a system nobody deploys. To evaluate a different model, point
 * the gateway's route at it.
 */
export const EVAL_BACKENDS = ["gateway"] as const;
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

  const endpoint = process.env.MODEL_GATEWAY_ENDPOINT;
  if (!endpoint) {
    // Checked here rather than at the first case: without it every case fails
    // with the same connection error, which reads as the model failing.
    throw new Error(
      'EVAL_LLM="gateway" requires MODEL_GATEWAY_ENDPOINT — the base URL of a reachable ' +
        "ModelGateway. In cluster that is the operator-published endpoint; outside it, run " +
        "upstream's standalone `aigw` and point at that.",
    );
  }

  return gatewayProvider(endpoint, process.env.EVAL_MODEL_ROUTE || DEFAULT_LLM_ROUTE);
}

function gatewayProvider(endpoint: string, route: string): LlmProvider {
  const client = new Anthropic({
    baseURL: endpoint,
    // The gateway holds the AWS credential; the eval holds none.
    apiKey: "unused-the-gateway-holds-the-credential",
    timeout: TIMEOUT_MS,
    maxRetries: 2,
  });

  return {
    async chat(system, userMessage) {
      const response = await client.messages.create({
        model: route,
        // No temperature: the current Sonnet generation rejects the knob
        // outright ("`temperature` is deprecated for this model"). So there is
        // no dial to pin a run down with, and two runs of the same fixture can
        // legitimately differ. That is why capability is scored as a rate
        // against a floor rather than case by case.
        max_tokens: 4096,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
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
