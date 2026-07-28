/**
 * Provider selection tests.
 *
 * The per-provider classes in `llm.ts` and `embeddings.ts` are SDK adapters —
 * build a request, call, parse — and are excluded from the coverage denominator
 * as such (see vitest.config.ts). The selection in front of them is not an
 * adapter: it is the decision of which model the radar actually runs on, and
 * getting it wrong means the app comes up healthy on the wrong backend and says
 * nothing about it.
 *
 * Constructing a provider builds an SDK client but issues no request, so this
 * runs offline with no credentials.
 */

import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { bootstrapEmbeddings } from "./embeddings.js";
import { bootstrapLlm } from "./llm.js";

function config(overrides: Partial<Config>): Config {
  return {
    awsRegion: "us-east-1",
    bedrockLlmModel: "us.anthropic.claude-sonnet-4-6",
    bedrockEmbeddingModel: "amazon.titan-embed-text-v2:0",
    anthropicApiKey: "sk-ant-test",
    anthropicLlmModel: "claude-sonnet-4-6",
    openaiApiKey: "sk-test",
    openaiLlmModel: "gpt-4o",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1024,
    ...overrides,
  } as Config;
}

describe("bootstrapLlm", () => {
  it.each(["bedrock", "anthropic", "openai"] as const)("resolves the %s provider", (provider) => {
    const llm = bootstrapLlm(config({ llmProvider: provider }));
    expect(typeof llm.chat).toBe("function");
  });

  it("fails loudly on an unknown provider rather than falling back", () => {
    // A silent fallback to the default would mean a typo in LLM_PROVIDER ships
    // a pod that runs, bills, and answers on a model nobody chose.
    expect(() =>
      bootstrapLlm(config({ llmProvider: "gemini" as Config["llmProvider"] })),
    ).toThrow();
  });
});

describe("bootstrapEmbeddings", () => {
  it.each(["bedrock", "openai"] as const)("resolves the %s provider", (provider) => {
    const embedder = bootstrapEmbeddings(config({ embeddingProvider: provider }));
    expect(typeof embedder.embed).toBe("function");
    expect(embedder.dimensions).toBeGreaterThan(0);
  });

  it("fails loudly on an unknown provider", () => {
    expect(() =>
      bootstrapEmbeddings(config({ embeddingProvider: "cohere" as Config["embeddingProvider"] })),
    ).toThrow();
  });
});
