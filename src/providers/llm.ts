import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import type { Config } from "../config.js";
import { recordBedrockTokens } from "../metrics.js";
import { createBreaker } from "../resilience/circuit-breaker.js";
import { createRegistry } from "../vendor/runtime/registry.js";

// Hard deadlines for every external LLM call. Without these, a hung socket
// blocks the single-writer crawl indefinitely (the circuit breaker only counts
// failures *after* a call returns — it cannot abort one in flight). Generous
// enough for a 4096-token completion; tunable later via config if needed.
const LLM_TIMEOUT_MS = 60_000;
const LLM_CONNECT_TIMEOUT_MS = 5_000;

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

// ─── Bedrock (AWS credential chain, no API key needed) ───

class BedrockLlmProvider implements LlmProvider {
  private client: BedrockRuntimeClient;
  private breaker = createBreaker("bedrock-llm", { failureThreshold: 3 });
  private modelId: string;

  constructor(region: string, modelId: string) {
    this.client = new BedrockRuntimeClient({
      region,
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: LLM_CONNECT_TIMEOUT_MS,
        requestTimeout: LLM_TIMEOUT_MS,
      },
    });
    this.modelId = modelId;
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.exec(async () => {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          // The system prompt is stable across every diff/query, so mark a
          // cachePoint after it: Bedrock caches the prefix and bills cached
          // reads at a fraction of input-token cost (llm-policy: prompt
          // caching is mandatory). cacheRead/Write below measure effectiveness.
          system: [{ text: system }, { cachePoint: { type: "default" } }],
          messages: [{ role: "user", content: [{ text: userMessage }] }],
          inferenceConfig: { maxTokens: 4096 },
        }),
        // Hard deadline at the SDK middleware layer — guarantees the call
        // aborts even if the underlying socket hangs, regardless of the http
        // handler's timeout semantics.
        { abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS) },
      );

      const text =
        response.output?.message?.content
          ?.filter((b) => "text" in b)
          .map((b) => b.text)
          .join("") ?? "";

      const result: LlmResponse = {
        text,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cacheReadTokens: response.usage?.cacheReadInputTokens ?? 0,
        cacheWriteTokens: response.usage?.cacheWriteInputTokens ?? 0,
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

// ─── Anthropic (direct API) ───

class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  private breaker = createBreaker("anthropic-llm", { failureThreshold: 3 });
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 2 });
    this.model = model;
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.exec(async () => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: userMessage }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    });
  }
}

// ─── OpenAI (direct API) ───

class OpenAILlmProvider implements LlmProvider {
  private client: OpenAI;
  private breaker = createBreaker("openai-llm", { failureThreshold: 3 });
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 2 });
    this.model = model;
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.exec(async () => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 4096,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
      });

      return {
        text: response.choices[0]?.message?.content ?? "",
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    });
  }
}

// ─── Bootstrap ───

export function bootstrapLlm(config: Config): LlmProvider {
  llmRegistry.register(
    "bedrock",
    () => new BedrockLlmProvider(config.awsRegion, config.bedrockLlmModel),
  );
  if (config.anthropicApiKey) {
    llmRegistry.register(
      "anthropic",
      () => new AnthropicProvider(config.anthropicApiKey!, config.anthropicLlmModel),
    );
  }
  if (config.openaiApiKey) {
    llmRegistry.register(
      "openai",
      () => new OpenAILlmProvider(config.openaiApiKey!, config.openaiLlmModel),
    );
  }
  return llmRegistry.get(config.llmProvider);
}
