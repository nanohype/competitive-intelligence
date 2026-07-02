import type { ParsedContent } from '../crawler/parser.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { VectorStore, VectorDocument } from '../providers/vectors.js';
import { chunkText } from './chunker.js';
import { semanticDiff, type DiffResult } from './differ.js';
import { logger } from '../logger.js';
import { recordChunksProcessed, recordChangeScore, recordDiffsProcessed } from '../metrics.js';

export interface PipelineResult {
  diffs: DiffResult[];
  totalChunksStored: number;
}

/**
 * Full ingest pipeline: chunk → embed → diff → store.
 *
 * For each crawled page:
 * 1. Split content into chunks
 * 2. Generate embeddings for all chunks
 * 3. Compare against existing stored embeddings (semantic diff)
 * 4. Store new embeddings (replacing old ones for the same source)
 *
 * Cold-start guard: if the store holds no chunks for a source yet (first-ever
 * crawl, empty pgvector, or in-memory restart), the source is seeded as a
 * baseline — chunks are embedded and stored, but the diff is marked
 * `baseline: true` with `changeScore: 0` so the alert engine stays quiet
 * instead of reporting "everything changed" (changeScore 1.0) on every source.
 * Once a baseline exists, behavior is identical to a normal crawl.
 */
export async function ingestAndDiff(
  pages: ParsedContent[],
  embedder: EmbeddingProvider,
  store: VectorStore,
): Promise<PipelineResult> {
  const diffs: DiffResult[] = [];
  let totalChunksStored = 0;

  for (const page of pages) {
    if (!page.text || page.text.length < 50) {
      logger.debug('skipping empty page', { sourceId: page.sourceId });
      continue;
    }

    // 1. Chunk
    const chunks = chunkText(page.text, {
      sourceId: page.sourceId,
      metadata: {
        sourceId: page.sourceId,
        competitor: page.competitor,
        type: page.type,
        url: page.url,
        title: page.title,
        fetchedAt: page.fetchedAt.toISOString(),
      },
    });

    // 2. Embed
    const texts = chunks.map((c) => c.text);
    const embeddings = await embedder.embed(texts);

    // 3. Diff against existing store — unless this is a cold start for the
    // source. An empty backend has no history to diff against, so every chunk
    // would score as "new" (changeScore 1.0) and trip a full alert storm on
    // each fresh deploy / restart. Seed it as a baseline instead.
    const existing = await store.count({ sourceId: page.sourceId });
    let diff: DiffResult;
    if (existing === 0) {
      logger.info('baseline seed (cold start)', {
        sourceId: page.sourceId,
        chunks: chunks.length,
      });
      diff = {
        sourceId: page.sourceId,
        competitor: page.competitor,
        changeScore: 0,
        newChunks: [],
        unchangedChunks: chunks,
        totalChunks: chunks.length,
        baseline: true,
      };
    } else {
      diff = await semanticDiff(chunks, embeddings, store, {
        competitor: page.competitor,
      });
      recordChangeScore(diff.changeScore);
    }
    diffs.push(diff);

    // 4. Replace this source's stored vectors, ordered so a mid-write failure
    // can never wipe the source's history (which the cold-start guard would
    // silently re-baseline, dropping a real change). Upsert the new chunks
    // FIRST — idempotent on chunk IDs — then prune only the stale chunks
    // (those not in the new set). A failed upsert throws with the old chunks
    // intact; a failed prune leaves harmless duplicates the next crawl cleans.
    const docs: VectorDocument[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      content: chunk.text,
      embedding: embeddings[i],
      metadata: chunk.metadata,
    }));
    await store.upsert(docs);
    await store.deleteByMetadata(
      { sourceId: page.sourceId },
      docs.map((d) => d.id),
    );
    totalChunksStored += docs.length;
    recordChunksProcessed(docs.length);
  }

  recordDiffsProcessed(diffs.length);
  logger.info('pipeline complete', {
    pages: pages.length,
    diffs: diffs.length,
    totalChunksStored,
  });

  return { diffs, totalChunksStored };
}
