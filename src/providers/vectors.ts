import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { recordPgVectorError } from "../metrics.js";
import { createRegistry } from "../vendor/runtime/registry.js";

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, string>;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, string>;
}

export interface VectorStore {
  upsert(docs: VectorDocument[]): Promise<void>;
  search(
    embedding: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]>;
  delete(ids: string[]): Promise<void>;
  /**
   * Delete every chunk matching `filter`, optionally excluding ids in
   * `keepIds`. The exclusion lets the pipeline upsert-then-prune: write the new
   * chunks first, then drop only the stale ones, so a failed write never leaves
   * a source with zero history (which the cold-start guard would silently
   * re-baseline). Returns the number of rows deleted.
   */
  deleteByMetadata(filter: Record<string, string>, keepIds?: string[]): Promise<number>;
  count(filter?: Record<string, string>): Promise<number>;
}

// ─── Cosine similarity ───

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── In-Memory ───
// All data lives in process memory — lost on restart.
// Default for local dev/tests. Use the pgvector backend for durability.

class MemoryVectorStore implements VectorStore {
  private docs = new Map<string, VectorDocument>();

  async upsert(docs: VectorDocument[]): Promise<void> {
    for (const doc of docs) {
      this.docs.set(doc.id, doc);
    }
  }

  async search(
    embedding: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const doc of this.docs.values()) {
      if (filter && !matchesFilter(doc.metadata, filter)) continue;
      results.push({
        id: doc.id,
        content: doc.content,
        score: cosine(embedding, doc.embedding),
        metadata: doc.metadata,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.docs.delete(id);
  }

  async deleteByMetadata(filter: Record<string, string>, keepIds?: string[]): Promise<number> {
    const keep = keepIds ? new Set(keepIds) : undefined;
    let deleted = 0;
    for (const [id, doc] of this.docs) {
      if (keep?.has(id)) continue;
      if (matchesFilter(doc.metadata, filter)) {
        this.docs.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async count(filter?: Record<string, string>): Promise<number> {
    if (!filter) return this.docs.size;
    let n = 0;
    for (const doc of this.docs.values()) {
      if (matchesFilter(doc.metadata, filter)) n++;
    }
    return n;
  }
}

function matchesFilter(metadata: Record<string, string>, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([k, v]) => metadata[k] === v);
}

// ─── pgvector (durable) ───
// Survives restarts so the first post-restart crawl diffs against real
// history instead of re-flooding alerts. Backed by the tenant's declared
// `main` relational datastore — Aurora Serverless v2 (pgvector), provisioned by
// tenant-substrate; the app owns the extension + schema, the engine just runs it.
//
// `PgQueryPort` is a narrow subset of `pg.Pool` — a `query(text, values)`
// returning `{ rows, rowCount }`. The real `pg.Pool` satisfies it directly;
// tests pass a fake implementing just that shape (no `vi.mock("pg")`).

export interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface PgQueryPort {
  query<T = unknown>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgVectorStoreConfig {
  query: PgQueryPort;
  embeddingDim: number;
  /** Table name. Defaults to "ci_vectors". */
  table?: string;
}

interface SearchRow {
  id: string;
  content: string;
  metadata: Record<string, string>;
  score: number;
}

interface CountRow {
  n: string | number;
}

export class PgVectorStore implements VectorStore {
  private readonly query: PgQueryPort;
  private readonly embeddingDim: number;
  private readonly table: string;
  private initPromise: Promise<void> | undefined;

  constructor(config: PgVectorStoreConfig) {
    this.query = config.query;
    this.embeddingDim = config.embeddingDim;
    this.table = config.table ?? "ci_vectors";
  }

  /**
   * Idempotent, lazily-run schema bootstrap. Guarded so concurrent first
   * calls share a single init. Every statement is `IF NOT EXISTS`, so
   * repeated boots and rolling deploys are safe.
   */
  private ensureSchema(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init().catch((err) => {
        // Reset so a later call can retry after a transient DB outage.
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async init(): Promise<void> {
    // `vector` provides the VECTOR type + `<=>` cosine-distance operator.
    // Available on Aurora/RDS Postgres 15+ out of the box.
    await this.query.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.query.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id        TEXT PRIMARY KEY,
         content   TEXT NOT NULL,
         embedding VECTOR(${this.embeddingDim}) NOT NULL,
         metadata  JSONB NOT NULL DEFAULT '{}'::jsonb
       )`,
    );
    // Fail loud on a dimension mismatch. CREATE TABLE IF NOT EXISTS silently
    // no-ops against an existing table, so an EMBEDDING_DIMENSIONS change would
    // otherwise surface only as a confusing late insert failure. atttypmod on a
    // pgvector column is its configured dimension.
    const { rows } = await this.query.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = $1::regclass AND attname = 'embedding'`,
      [this.table],
    );
    const existingDim = rows[0]?.atttypmod;
    if (typeof existingDim === "number" && existingDim > 0 && existingDim !== this.embeddingDim) {
      throw new Error(
        `pgvector: table ${this.table} has VECTOR(${existingDim}) but configured embeddingDim is ${this.embeddingDim} — drop/migrate the table or fix EMBEDDING_DIMENSIONS`,
      );
    }
    // HNSW over cosine distance — builds incrementally and needs no populated
    // table, so it avoids IVFFlat's empty-table centroid pitfall (lists are
    // meaningless with zero rows). Fits the small, slowly-growing source set.
    await this.query.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
         ON ${this.table} USING hnsw (embedding vector_cosine_ops)`,
    );
    // GIN over the metadata jsonb so `@>` containment filters stay on index.
    await this.query.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_metadata_idx
         ON ${this.table} USING GIN (metadata)`,
    );
    logger.info("pgvector schema ready", { table: this.table, dim: this.embeddingDim });
  }

  private vectorLiteral(embedding: number[]): string {
    if (embedding.length !== this.embeddingDim) {
      throw new Error(
        `pgvector: embedding dim ${embedding.length} does not match configured ${this.embeddingDim}`,
      );
    }
    return `[${embedding.join(",")}]`;
  }

  async upsert(docs: VectorDocument[]): Promise<void> {
    if (docs.length === 0) return;
    await this.ensureSchema();
    for (const doc of docs) {
      await this.query.query(
        `INSERT INTO ${this.table} (id, content, embedding, metadata)
         VALUES ($1, $2, $3::vector, $4::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET content = EXCLUDED.content,
               embedding = EXCLUDED.embedding,
               metadata = EXCLUDED.metadata`,
        [doc.id, doc.content, this.vectorLiteral(doc.embedding), JSON.stringify(doc.metadata)],
      );
    }
  }

  async search(
    embedding: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]> {
    await this.ensureSchema();
    const params: unknown[] = [this.vectorLiteral(embedding)];
    let where = "";
    if (filter) {
      params.push(JSON.stringify(filter));
      where = `WHERE metadata @> $${params.length}::jsonb`;
    }
    params.push(topK);
    const { rows } = await this.query.query<SearchRow>(
      `SELECT id, content, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM ${this.table}
       ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      score: Number(row.score) || 0,
      metadata: row.metadata ?? {},
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureSchema();
    await this.query.query(`DELETE FROM ${this.table} WHERE id = ANY($1::text[])`, [ids]);
  }

  async deleteByMetadata(filter: Record<string, string>, keepIds?: string[]): Promise<number> {
    await this.ensureSchema();
    if (keepIds && keepIds.length > 0) {
      const { rowCount } = await this.query.query(
        `DELETE FROM ${this.table}
         WHERE metadata @> $1::jsonb AND id != ALL($2::text[])`,
        [JSON.stringify(filter), keepIds],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.query.query(
      `DELETE FROM ${this.table} WHERE metadata @> $1::jsonb`,
      [JSON.stringify(filter)],
    );
    return rowCount ?? 0;
  }

  async count(filter?: Record<string, string>): Promise<number> {
    await this.ensureSchema();
    const params: unknown[] = [];
    let where = "";
    if (filter) {
      params.push(JSON.stringify(filter));
      where = `WHERE metadata @> $1::jsonb`;
    }
    const { rows } = await this.query.query<CountRow>(
      `SELECT count(*) AS n FROM ${this.table} ${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }
}

// ─── Registry ───

export const vectorRegistry = createRegistry<VectorStore>("vector-store");

export function bootstrapVectorStore(config: Config): VectorStore {
  vectorRegistry.register("memory", () => new MemoryVectorStore());
  vectorRegistry.register("pgvector", () => {
    // `pg` reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from the
    // environment automatically when no connectionString is given, so an
    // unset DATABASE_URL still works against the Aurora-managed credentials.
    // TLS is verified: with a mounted RDS CA bundle (PG_CA_PATH) we pin to it;
    // otherwise Node's built-in trust store validates the publicly-anchored RDS
    // global CA. Either way the connection is encrypted AND authenticated.
    const ssl = config.pgCaPath
      ? { ca: readFileSync(config.pgCaPath, "utf8"), rejectUnauthorized: true }
      : { rejectUnauthorized: true };
    const pool = new Pool({
      ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {}),
      max: 5,
      ssl,
      // Bound every phase so a hung DB can't stall the single-writer crawl.
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      query_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    pool.on("error", (err: Error) => {
      recordPgVectorError();
      logger.error("pgvector pool error", { error: err.message });
    });
    // Count query-level failures too (Aurora failover, statement timeout) so the
    // PgVectorUnreachable alert fires on more than just idle-client errors.
    const query: PgQueryPort = {
      async query<T = unknown>(text: string, values?: unknown[]): Promise<PgQueryResult<T>> {
        try {
          const result = await pool.query(text, values);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        } catch (err) {
          recordPgVectorError();
          throw err;
        }
      },
    };
    return new PgVectorStore({ query, embeddingDim: config.embeddingDimensions });
  });
  return vectorRegistry.get(config.vectorProvider);
}
