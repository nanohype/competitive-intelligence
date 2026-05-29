import type { EmbeddingProvider } from "../providers/embeddings.js";
import type { VectorStore } from "../providers/vectors.js";
import type { LlmProvider } from "../providers/llm.js";
import { answerQuery } from "./analysis.js";

export interface IntelEngine {
  query(question: string, options?: { competitor?: string; topK?: number }): Promise<string>;
}

/**
 * Intelligence query engine. Takes natural language questions about competitors,
 * retrieves relevant chunks from the vector store, and generates answers via LLM.
 */
export function createIntelEngine(
  embedder: EmbeddingProvider,
  store: VectorStore,
  llm: LlmProvider,
): IntelEngine {
  return {
    async query(question, options) {
      const topK = options?.topK ?? 10;

      // Embed the question
      const [embedding] = await embedder.embed([question]);

      // Search with optional competitor filter
      const filter = options?.competitor ? { competitor: options.competitor } : undefined;
      const results = await store.search(embedding, topK, filter);

      if (results.length === 0) {
        return "No intelligence found for this query. The knowledge base may be empty — try running a crawl first.";
      }

      return answerQuery(question, results, llm);
    },
  };
}
