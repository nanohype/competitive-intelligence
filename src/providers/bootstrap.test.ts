/**
 * Provider wiring tests.
 *
 * The provider classes in `llm.ts` and `embeddings.ts` are adapters — build a
 * request, call, parse — and are excluded from the coverage denominator as such
 * (see vitest.config.ts). What is asserted here is the shape of the registry in
 * front of them: that the gateway is registered, and that it is the *only*
 * thing registered. A second arm reaching a vendor API directly would leave no
 * guardrail, no capture and no per-tenant attribution, and would look perfectly
 * healthy doing it.
 *
 * Constructing a provider builds a client but issues no request, so this runs
 * offline with no credentials.
 */

import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { bootstrapEmbeddings, embeddingRegistry } from "./embeddings.js";
import { bootstrapLlm, llmRegistry } from "./llm.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    awsRegion: "us-east-1",
    modelGatewayEndpoint: "http://gw.tenants-x.svc.cluster.local:8080",
    llmRoute: "default",
    embeddingRoute: "embeddings",
    embeddingDimensions: 1024,
    ...overrides,
  } as Config;
}

describe("bootstrapLlm", () => {
  it("resolves the gateway provider", () => {
    const llm = bootstrapLlm(config());
    expect(typeof llm.chat).toBe("function");
  });

  // There is deliberately one arm. A vendor-API provider would reach a model
  // with no guardrail, no capture and no per-tenant attribution — the three
  // things the gateway exists to apply. Alternative models are routes on the
  // ModelGateway CR, where they inherit all of it.
  it("registers the gateway as the only way to reach a model", () => {
    bootstrapLlm(config());
    expect(llmRegistry.names()).toEqual(["gateway"]);
  });
});

describe("bootstrapEmbeddings", () => {
  it("resolves the gateway provider and carries the configured width", () => {
    const embedder = bootstrapEmbeddings(config());
    expect(typeof embedder.embed).toBe("function");
    // The pgvector column is declared at this width; a provider that reported a
    // different one would insert vectors the store rejects.
    expect(embedder.dimensions).toBe(1024);
  });

  it("registers the gateway as the only embeddings path", () => {
    bootstrapEmbeddings(config());
    expect(embeddingRegistry.names()).toEqual(["gateway"]);
  });
});
