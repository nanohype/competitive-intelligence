import type { EmbeddingProvider } from "../providers/embeddings.js";
import type { LlmProvider } from "../providers/llm.js";
import type { SearchResult, VectorStore } from "../providers/vectors.js";
import { answerQuery } from "./analysis.js";

export interface QueryOptions {
  competitor?: string;
  topK?: number;
}

export interface IntelEngine {
  /**
   * Retrieval half: embed the question → vector search → ranked chunks with
   * their source metadata. This is the context an external reasoner (an MCP
   * consumer) grounds on — no prose answer is composed here.
   */
  retrieve(question: string, options?: QueryOptions): Promise<SearchResult[]>;
  /**
   * Compose an answer over the retrieved context via the LLM. The on-account
   * answer path used by the CLI and the in-boundary composed-answer option.
   */
  query(question: string, options?: QueryOptions): Promise<string>;
}

/**
 * Intelligence query engine. Takes natural-language questions about
 * competitors and retrieves the relevant chunks from the vector store. Two
 * entry points share one retrieval path: `retrieve` returns the ranked context
 * for a caller that does its own reasoning; `query` composes an LLM answer over
 * that same context.
 */
export function createIntelEngine(
  embedder: EmbeddingProvider,
  store: VectorStore,
  llm: LlmProvider,
): IntelEngine {
  async function retrieve(question: string, options?: QueryOptions): Promise<SearchResult[]> {
    const topK = options?.topK ?? 10;

    // Embed the question.
    const [embedding] = await embedder.embed([question]);

    // Search with an optional competitor filter. Match case-insensitively:
    // competitor ids are stored lowercase (source convention), but an MCP
    // caller reasons in natural language and passes "Replit", not "replit".
    const filter = options?.competitor
      ? { competitor: options.competitor.toLowerCase() }
      : undefined;
    return store.search(embedding, topK, filter);
  }

  return {
    retrieve,
    async query(question, options) {
      const results = await retrieve(question, options);

      if (results.length === 0) {
        return "No intelligence found for this query. The knowledge base may be empty — try running a crawl first.";
      }

      return answerQuery(question, results, llm);
    },
  };
}
