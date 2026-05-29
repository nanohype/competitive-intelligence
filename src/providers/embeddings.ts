import OpenAI from "openai";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createRegistry } from "./registry.js";
import type { Config } from "../config.js";
import { CircuitBreaker } from "../resilience/circuit-breaker.js";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

export const embeddingRegistry = createRegistry<EmbeddingProvider>("embedding");

// ─── Bedrock Titan (AWS credential chain) ───

class BedrockEmbeddingProvider implements EmbeddingProvider {
  private client: BedrockRuntimeClient;
  private breaker = new CircuitBreaker("bedrock-embeddings", { failureThreshold: 3 });
  private modelId: string;
  readonly dimensions: number;

  constructor(region: string, modelId: string, dimensions: number) {
    this.client = new BedrockRuntimeClient({ region });
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Titan embedding API takes one text at a time — call in sequence
    const results: number[][] = [];
    for (const text of texts) {
      const embedding = await this.breaker.execute(async () => {
        const response = await this.client.send(
          new InvokeModelCommand({
            modelId: this.modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              inputText: text,
              dimensions: this.dimensions,
              normalize: true,
            }),
          }),
        );
        const body = JSON.parse(new TextDecoder().decode(response.body));
        return body.embedding as number[];
      });
      results.push(embedding);
    }
    return results;
  }
}

// ─── OpenAI (direct API) ───

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private breaker = new CircuitBreaker("openai-embeddings", { failureThreshold: 3 });
  readonly dimensions: number;
  private model: string;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.breaker.execute(async () => {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      });
      return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    });
  }
}

// ─── Bootstrap ───

export function bootstrapEmbeddings(config: Config): EmbeddingProvider {
  embeddingRegistry.register(
    "bedrock",
    () =>
      new BedrockEmbeddingProvider(
        config.awsRegion,
        config.bedrockEmbeddingModel,
        config.embeddingDimensions,
      ),
  );
  if (config.openaiApiKey) {
    embeddingRegistry.register(
      "openai",
      () =>
        new OpenAIEmbeddingProvider(
          config.openaiApiKey!,
          config.embeddingModel,
          config.embeddingDimensions,
        ),
    );
  }
  return embeddingRegistry.get(config.embeddingProvider);
}
