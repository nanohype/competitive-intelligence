import { describe, expect, it } from "vitest";
import type { SearchResult, VectorStore } from "../providers/vectors.js";
import type { Chunk } from "./chunker.js";
import { semanticDiff } from "./differ.js";

function makeChunk(id: string, text: string): Chunk {
  return { id, text, index: 0, sourceId: "test:src", metadata: { sourceId: "test:src" } };
}

function makeStore(results: SearchResult[]): VectorStore {
  return {
    async search() {
      return results;
    },
    async upsert() {},
    async delete() {},
    async deleteByMetadata() {
      return 0;
    },
    async count() {
      return 0;
    },
  };
}

describe("semanticDiff", () => {
  it("marks all chunks as new when store is empty", async () => {
    const chunks = [makeChunk("a:0", "hello"), makeChunk("a:1", "world")];
    const embeddings = [
      [1, 0],
      [0, 1],
    ];
    const store = makeStore([]); // no matches

    const result = await semanticDiff(chunks, embeddings, store, {
      competitor: "acme",
    });

    expect(result.changeScore).toBe(1);
    expect(result.newChunks).toHaveLength(2);
    expect(result.unchangedChunks).toHaveLength(0);
  });

  it("marks all chunks as unchanged when store has high-similarity matches", async () => {
    const chunks = [makeChunk("a:0", "hello")];
    const embeddings = [[1, 0]];
    const store = makeStore([{ id: "a:0", content: "hello", score: 0.99, metadata: {} }]);

    const result = await semanticDiff(chunks, embeddings, store, {
      competitor: "acme",
    });

    expect(result.changeScore).toBe(0);
    expect(result.newChunks).toHaveLength(0);
    expect(result.unchangedChunks).toHaveLength(1);
  });

  it("uses custom similarity threshold", async () => {
    const chunks = [makeChunk("a:0", "hello")];
    const embeddings = [[1, 0]];
    // Score 0.80 is below default 0.85 threshold but above 0.70
    const store = makeStore([{ id: "a:0", content: "hello", score: 0.8, metadata: {} }]);

    const below = await semanticDiff(chunks, embeddings, store, {
      competitor: "acme",
      similarityThreshold: 0.85,
    });
    expect(below.newChunks).toHaveLength(1);

    const above = await semanticDiff(chunks, embeddings, store, {
      competitor: "acme",
      similarityThreshold: 0.7,
    });
    expect(above.unchangedChunks).toHaveLength(1);
  });

  it("returns 0 change score for empty input", async () => {
    const result = await semanticDiff([], [], makeStore([]), {
      competitor: "acme",
    });
    expect(result.changeScore).toBe(0);
    expect(result.totalChunks).toBe(0);
  });

  it("treats a score exactly at the threshold as unchanged", async () => {
    const chunks = [makeChunk("a:0", "hello")];
    const embeddings = [[1, 0]];

    // score === threshold → unchanged (the comparison is `score < threshold`)
    const atThreshold = makeStore([{ id: "a:0", content: "hello", score: 0.85, metadata: {} }]);
    const r1 = await semanticDiff(chunks, embeddings, atThreshold, { competitor: "acme" });
    expect(r1.unchangedChunks).toHaveLength(1);
    expect(r1.newChunks).toHaveLength(0);

    // just below → new
    const justBelow = makeStore([{ id: "a:0", content: "hello", score: 0.849, metadata: {} }]);
    const r2 = await semanticDiff(chunks, embeddings, justBelow, { competitor: "acme" });
    expect(r2.newChunks).toHaveLength(1);
    expect(r2.unchangedChunks).toHaveLength(0);
  });
});
