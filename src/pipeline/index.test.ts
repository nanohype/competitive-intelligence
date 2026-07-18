import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { ParsedContent } from "../crawler/parser.js";
import type { EmbeddingProvider } from "../providers/embeddings.js";
import { bootstrapVectorStore } from "../providers/vectors.js";
import { ingestAndDiff } from "./index.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    llmProvider: "anthropic",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 3,
    vectorProvider: "memory",
    crawlIntervalMinutes: 60,
    crawlTimeoutMs: 30_000,
    userAgent: "test",
    slackAlertChannel: "#test",
    significanceThreshold: 0.3,
    port: 3000,
    nodeEnv: "test",
    logLevel: "error",
    ...overrides,
  } as Config;
}

/**
 * Deterministic embedder: maps known text to fixed unit vectors so the
 * semantic diff is predictable. Anything else gets a far-apart vector.
 */
function fakeEmbedder(map: Record<string, number[]>): EmbeddingProvider {
  return {
    dimensions: 3,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => map[t] ?? [0, 0, 1]);
    },
  };
}

function page(text: string): ParsedContent {
  return {
    sourceId: "acme:pricing",
    competitor: "acme",
    type: "pricing",
    url: "https://acme.example/pricing",
    title: "Pricing",
    text,
    links: [],
    fetchedAt: new Date("2026-05-29T00:00:00Z"),
  };
}

describe("ingestAndDiff cold-start guard", () => {
  it("first crawl against an empty store seeds a baseline with no alert-worthy diff", async () => {
    const store = bootstrapVectorStore(makeConfig());
    const embedder = fakeEmbedder({
      "Acme Pro plan pricing is twenty dollars per seat per month, billed annually.": [1, 0, 0],
    });

    const result = await ingestAndDiff(
      [page("Acme Pro plan pricing is twenty dollars per seat per month, billed annually.")],
      embedder,
      store,
    );

    expect(result.diffs).toHaveLength(1);
    const diff = result.diffs[0];
    expect(diff.baseline).toBe(true);
    expect(diff.changeScore).toBe(0);
    expect(diff.newChunks).toHaveLength(0);
    // Baseline still ingests so the next crawl has history to diff against.
    expect(result.totalChunksStored).toBe(1);
    expect(await store.count({ sourceId: "acme:pricing" })).toBe(1);
  });

  it("second crawl with changed content produces a real diff (no longer baseline)", async () => {
    const store = bootstrapVectorStore(makeConfig());
    const embedder = fakeEmbedder({
      "Acme Pro plan pricing is twenty dollars per seat per month, billed annually.": [1, 0, 0],
      // Orthogonal vector → cosine 0 → well below the 0.85 threshold → "new".
      "Acme launched a brand new enterprise tier with fully custom pricing today.": [0, 1, 0],
    });

    // First crawl establishes the baseline (suppressed).
    const first = await ingestAndDiff(
      [page("Acme Pro plan pricing is twenty dollars per seat per month, billed annually.")],
      embedder,
      store,
    );
    expect(first.diffs[0].baseline).toBe(true);

    // Second crawl: content changed → real diff, surfaced as a change.
    const second = await ingestAndDiff(
      [page("Acme launched a brand new enterprise tier with fully custom pricing today.")],
      embedder,
      store,
    );
    const diff = second.diffs[0];
    expect(diff.baseline).toBeUndefined();
    expect(diff.changeScore).toBe(1);
    expect(diff.newChunks).toHaveLength(1);
  });

  it("second crawl with unchanged content produces a zero-change real diff", async () => {
    const store = bootstrapVectorStore(makeConfig());
    const embedder = fakeEmbedder({
      "Acme Pro plan pricing is twenty dollars per seat per month, billed annually.": [1, 0, 0],
    });

    await ingestAndDiff(
      [page("Acme Pro plan pricing is twenty dollars per seat per month, billed annually.")],
      embedder,
      store,
    );
    const second = await ingestAndDiff(
      [page("Acme Pro plan pricing is twenty dollars per seat per month, billed annually.")],
      embedder,
      store,
    );

    const diff = second.diffs[0];
    expect(diff.baseline).toBeUndefined();
    expect(diff.changeScore).toBe(0);
    expect(diff.unchangedChunks).toHaveLength(1);
  });
});
