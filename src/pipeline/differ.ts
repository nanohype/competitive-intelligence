import type { VectorStore } from "../providers/vectors.js";
import type { Chunk } from "./chunker.js";
import { logger } from "../logger.js";

export interface DiffResult {
  sourceId: string;
  competitor: string;
  /** 0–1 score indicating how much the content changed */
  changeScore: number;
  /** Chunks that are semantically new (low similarity to any stored content) */
  newChunks: Chunk[];
  /** Chunks that are semantically similar to existing content (no real change) */
  unchangedChunks: Chunk[];
  /** Total chunks processed */
  totalChunks: number;
  /**
   * True when this diff is the source's first-ever crawl against an empty
   * backend — the chunks are seeded as a baseline, not a real change. The
   * alert engine ignores baseline diffs so a cold start (fresh deploy, empty
   * pgvector, in-memory restart) doesn't flood every source as "all new".
   */
  baseline?: boolean;
}

/**
 * Compare new chunks against what's already in the vector store.
 * Returns a change score based on how many chunks are semantically novel.
 *
 * A chunk is considered "new" if its best match in the store for the same
 * source has a cosine similarity below the threshold.
 */
export async function semanticDiff(
  chunks: Chunk[],
  embeddings: number[][],
  store: VectorStore,
  options: {
    similarityThreshold?: number;
    competitor: string;
  },
): Promise<DiffResult> {
  const threshold = options.similarityThreshold ?? 0.85;
  const sourceId = chunks[0]?.sourceId ?? "unknown";

  const newChunks: Chunk[] = [];
  const unchangedChunks: Chunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];

    // Search for similar content from the same source
    const matches = await store.search(embedding, 1, { sourceId });

    if (matches.length === 0 || matches[0].score < threshold) {
      newChunks.push(chunk);
    } else {
      unchangedChunks.push(chunk);
    }
  }

  const changeScore = chunks.length === 0 ? 0 : newChunks.length / chunks.length;

  logger.info("semantic diff", {
    sourceId,
    changeScore: changeScore.toFixed(3),
    newChunks: newChunks.length,
    unchanged: unchangedChunks.length,
  });

  return {
    sourceId,
    competitor: options.competitor,
    changeScore,
    newChunks,
    unchangedChunks,
    totalChunks: chunks.length,
  };
}
