import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../providers/embeddings.js";
import type { LlmProvider, LlmResponse } from "../providers/llm.js";
import type { VectorStore } from "../providers/vectors.js";
import { createIntelEngine } from "./index.js";

const llmResponse = (text: string): LlmResponse => ({
  text,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const hit = (id: string, content: string) => ({
  id,
  content,
  score: 0.9,
  metadata: { competitor: "acme", url: "https://example.com", sourceId: "src" },
});

function makeEngine(searchResults: ReturnType<typeof hit>[]) {
  const embedder: EmbeddingProvider = {
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    dimensions: 3,
  };
  const store = {
    search: vi.fn(async () => searchResults),
  } as unknown as VectorStore;
  const llm: LlmProvider = {
    chat: vi.fn(async () => llmResponse("the grounded answer")),
  };
  return { engine: createIntelEngine(embedder, store, llm), embedder, store, llm };
}

describe("createIntelEngine", () => {
  it("answers a query from retrieved context via the LLM", async () => {
    const { engine, embedder, store, llm } = makeEngine([hit("1", "Acme shipped a new tier")]);

    const answer = await engine.query("what did acme ship?");

    expect(answer).toBe("the grounded answer");
    expect(embedder.embed).toHaveBeenCalledWith(["what did acme ship?"]);
    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 10, undefined);
    expect(llm.chat).toHaveBeenCalled();
  });

  it("short-circuits with guidance when the store is empty — no LLM call", async () => {
    const { engine, llm } = makeEngine([]);

    const answer = await engine.query("anything");

    expect(answer).toContain("No intelligence found");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("passes the competitor filter and topK through to the store", async () => {
    const { engine, store } = makeEngine([hit("1", "c")]);

    await engine.query("q", { competitor: "acme", topK: 3 });

    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 3, { competitor: "acme" });
  });

  it('matches the competitor case-insensitively — an MCP caller passes "Replit"', async () => {
    const { engine, store } = makeEngine([hit("1", "c")]);

    await engine.retrieve("q", { competitor: "Replit" });

    // Stored competitor ids are lowercase (source convention); the filter is
    // lowered so a natural-language caller does not have to know that.
    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 10, { competitor: "replit" });
  });
});
