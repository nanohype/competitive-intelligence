import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { createRegistry } from "./registry.js";
import { CircuitBreaker } from "../resilience/circuit-breaker.js";
import type { Config } from "../config.js";

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
  private breaker = new CircuitBreaker("bedrock-llm", { failureThreshold: 3 });
  private modelId: string;

  constructor(region: string, modelId: string) {
    this.client = new BedrockRuntimeClient({ region });
    this.modelId = modelId;
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.execute(async () => {
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
      );

      const text =
        response.output?.message?.content
          ?.filter((b) => "text" in b)
          .map((b) => b.text)
          .join("") ?? "";

      return {
        text,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cacheReadTokens: response.usage?.cacheReadInputTokens ?? 0,
        cacheWriteTokens: response.usage?.cacheWriteInputTokens ?? 0,
      };
    });
  }
}

// ─── Anthropic (direct API) ───

class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  private breaker = new CircuitBreaker("anthropic-llm", { failureThreshold: 3 });

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.execute(async () => {
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-20250514",
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
  private breaker = new CircuitBreaker("openai-llm", { failureThreshold: 3 });

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(system: string, userMessage: string): Promise<LlmResponse> {
    return this.breaker.execute(async () => {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o",
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
    llmRegistry.register("anthropic", () => new AnthropicProvider(config.anthropicApiKey!));
  }
  if (config.openaiApiKey) {
    llmRegistry.register("openai", () => new OpenAILlmProvider(config.openaiApiKey!));
  }
  return llmRegistry.get(config.llmProvider);
}
