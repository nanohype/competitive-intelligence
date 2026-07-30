import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { recordBedrockTokens } from "../metrics.js";
import { createBreaker } from "../resilience/circuit-breaker.js";
import { createRegistry } from "../vendor/runtime/registry.js";

// Hard deadlines for every external LLM call. Without these, a hung socket
// blocks the single-writer crawl indefinitely (the circuit breaker only counts
// failures *after* a call returns — it cannot abort one in flight). Generous
// enough for a 4096-token completion; tunable later via config if needed.
const LLM_TIMEOUT_MS = 60_000;

const MAX_OUTPUT_TOKENS = 4096;

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmProvider {
  chat(system: string, userMessage: string): Promise<LlmResponse>;
}

export const llmRegistry = createRegistry<LlmProvider>("llm");

// ─── The Platform's ModelGateway ───

/**
 * Talks the Anthropic Messages API to the ModelGateway in this tenant's
 * namespace. The gateway resolves the route to a Bedrock model, applies the
 * route's guardrail and rate limit, signs the upstream call with its own Pod
 * Identity credentials, and is where the request is recorded.
 *
 * This is the only LLM arm. Reaching a model any other way — a vendor API with
 * an API key, a self-hosted endpoint — would leave no guardrail, no capture and
 * no per-tenant attribution, which is the whole reason the gateway exists.
 * Alternative models are added as routes on the `ModelGateway` CR, where they
 * inherit all three, rather than as providers here.
 */
class GatewayLlmProvider implements LlmProvider {
  private client: Anthropic;
  private breaker = createBreaker("model-gateway-llm", { failureThreshold: 3 });
  private route: string;

  constructor(endpoint: string, route: string) {
    this.client = new Anthropic({
      baseURL: endpoint,
      // The gateway holds the AWS credential; this app holds none. The SDK
      // requires the field, and the gateway ignores it.
      apiKey: "unused-the-gateway-holds-the-credential",
      timeout: LLM_TIMEOUT_MS,
      maxRetries: 2,
    });
    this.route = route;
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.exec(async () => {
      const response = await this.client.messages.create({
        // A route name. The gateway rewrites it to the real inference-profile
        // id upstream, so this app never names a model.
        model: this.route,
        max_tokens: MAX_OUTPUT_TOKENS,
        // The system prompt is stable across every diff/query, so mark a cache
        // breakpoint after it: Bedrock caches the prefix and bills cached reads
        // at a fraction of input-token cost (llm-policy: prompt caching is
        // mandatory). The cacheRead/Write counters below measure effectiveness.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const result: LlmResponse = {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // Anthropic reports the two cache figures separately from input_tokens,
        // so they are additional spend rather than a subset of it.
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      };

      // Emit token usage by kind so the Grafana cache-effectiveness panels
      // render and ARCHITECTURE's "measured, not assumed" claim holds.
      recordBedrockTokens("input", result.inputTokens);
      recordBedrockTokens("output", result.outputTokens);
      recordBedrockTokens("cache_read", result.cacheReadTokens);
      recordBedrockTokens("cache_write", result.cacheWriteTokens);

      return result;
    });
  }
}

// ─── Bootstrap ───

export function bootstrapLlm(config: Config): LlmProvider {
  llmRegistry.register(
    "gateway",
    () => new GatewayLlmProvider(config.modelGatewayEndpoint, config.llmRoute),
  );
  return llmRegistry.get("gateway");
}
