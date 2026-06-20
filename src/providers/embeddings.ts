import OpenAI from "openai";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createRegistry } from "./registry.js";
import type { Config } from "../config.js";
import { CircuitBreaker } from "../resilience/circuit-breaker.js";

// Hard deadlines for every embedding call — embeddings run sequentially on the
// single-writer crawl path, so a hung call stalls the whole crawl. See llm.ts.
const EMBED_TIMEOUT_MS = 30_000;
const EMBED_CONNECT_TIMEOUT_MS = 5_000;

// OpenAI's embeddings endpoint caps array length + total tokens per request, so
// a large page must be sent in windows rather than one call.
const OPENAI_EMBED_BATCH = 256;

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
    this.client = new BedrockRuntimeClient({
      region,
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: EMBED_CONNECT_TIMEOUT_MS,
        requestTimeout: EMBED_TIMEOUT_MS,
      },
    });
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
          { abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS) },
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
    this.client = new OpenAI({ apiKey, timeout: EMBED_TIMEOUT_MS, maxRetries: 2 });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Window the inputs — a single large page can exceed OpenAI's per-request
    // array/token caps, which would 400 the whole crawl's embedding.
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += OPENAI_EMBED_BATCH) {
      const window = texts.slice(i, i + OPENAI_EMBED_BATCH);
      const batch = await this.breaker.execute(async () => {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: window,
          dimensions: this.dimensions,
        });
        return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      });
      all.push(...batch);
    }
    return all;
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
