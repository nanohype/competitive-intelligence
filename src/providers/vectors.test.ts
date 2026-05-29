import { describe, it, expect, vi } from "vitest";
import {
  bootstrapVectorStore,
  PgVectorStore,
  type PgQueryPort,
  type PgQueryResult,
} from "./vectors.js";
import type { Config } from "../config.js";

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

describe("MemoryVectorStore", () => {
  it("upserts and searches documents", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "hello", embedding: [1, 0, 0], metadata: { src: "a" } },
      { id: "2", content: "world", embedding: [0, 1, 0], metadata: { src: "b" } },
    ]);

    const results = await store.search([1, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it("filters by metadata", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: { src: "alpha" } },
      { id: "2", content: "b", embedding: [1, 0, 0], metadata: { src: "beta" } },
    ]);

    const results = await store.search([1, 0, 0], 10, { src: "beta" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("2");
  });

  it("deleteByMetadata removes matching documents", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: { sourceId: "x" } },
      { id: "2", content: "b", embedding: [0, 1, 0], metadata: { sourceId: "x" } },
      { id: "3", content: "c", embedding: [0, 0, 1], metadata: { sourceId: "y" } },
    ]);

    const deleted = await store.deleteByMetadata({ sourceId: "x" });
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
  });

  it("delete removes by ID", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: {} },
      { id: "2", content: "b", embedding: [0, 1, 0], metadata: {} },
    ]);

    await store.delete(["1"]);
    expect(await store.count()).toBe(1);
  });

  it("counts a metadata-filtered subset", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: { sourceId: "x" } },
      { id: "2", content: "b", embedding: [0, 1, 0], metadata: { sourceId: "x" } },
      { id: "3", content: "c", embedding: [0, 0, 1], metadata: { sourceId: "y" } },
    ]);

    expect(await store.count()).toBe(3);
    expect(await store.count({ sourceId: "x" })).toBe(2);
    expect(await store.count({ sourceId: "y" })).toBe(1);
    expect(await store.count({ sourceId: "missing" })).toBe(0);
  });
});

// PgVectorStore against a fake `PgQueryPort` (the same narrow query subset the
// real `pg.Pool` satisfies) — no live Postgres, no `vi.mock("pg")`.
function fakeQuery(responses: PgQueryResult[]): {
  port: PgQueryPort;
  spy: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const queryFn = vi.fn(async () => {
    return queue.shift() ?? { rows: [], rowCount: 0 };
  });
  return {
    port: { query: queryFn as unknown as PgQueryPort["query"] },
    spy: queryFn,
  };
}

const ddl = (): PgQueryResult => ({ rows: [], rowCount: 0 });

describe("PgVectorStore", () => {
  it("runs idempotent schema DDL once on first use, then reuses it", async () => {
    // 4 DDL statements (extension, table, ivfflat index, gin index) + the op.
    const { port, spy } = fakeQuery([
      ddl(),
      ddl(),
      ddl(),
      ddl(),
      { rows: [{ n: 0 }], rowCount: 1 },
      { rows: [{ n: 0 }], rowCount: 1 },
    ]);
    const store = new PgVectorStore({ query: port, embeddingDim: 3 });

    await store.count();
    await store.count();

    const sqls = spy.mock.calls.map((c) => c[0] as string);
    expect(sqls.filter((s) => s.includes("CREATE EXTENSION IF NOT EXISTS vector"))).toHaveLength(1);
    expect(sqls.some((s) => s.includes("USING ivfflat (embedding vector_cosine_ops)"))).toBe(true);
    expect(sqls.some((s) => s.includes("USING GIN (metadata)"))).toBe(true);
  });

  it("upserts with a vector literal and jsonb metadata", async () => {
    const { port, spy } = fakeQuery([ddl(), ddl(), ddl(), ddl(), ddl()]);
    const store = new PgVectorStore({ query: port, embeddingDim: 3 });

    await store.upsert([
      { id: "a:0", content: "hello", embedding: [0.1, 0.2, 0.3], metadata: { sourceId: "a" } },
    ]);

    const upsertCall = spy.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO"));
    expect(upsertCall).toBeDefined();
    const [sql, params] = upsertCall!;
    expect(sql as string).toContain("ON CONFLICT (id) DO UPDATE");
    expect((params as unknown[])[2]).toBe("[0.1,0.2,0.3]");
    expect((params as unknown[])[3]).toBe(JSON.stringify({ sourceId: "a" }));
  });

  it("searches by cosine distance and maps score = 1 - distance", async () => {
    const { port, spy } = fakeQuery([
      ddl(),
      ddl(),
      ddl(),
      ddl(),
      {
        rows: [{ id: "a:0", content: "hello", metadata: { sourceId: "a" }, score: 0.92 }],
        rowCount: 1,
      },
    ]);
    const store = new PgVectorStore({ query: port, embeddingDim: 3 });

    const results = await store.search([1, 0, 0], 5, { sourceId: "a" });

    expect(results).toEqual([
      { id: "a:0", content: "hello", score: 0.92, metadata: { sourceId: "a" } },
    ]);
    const searchCall = spy.mock.calls.find((c) =>
      (c[0] as string).includes("ORDER BY embedding <=>"),
    );
    const [sql, params] = searchCall!;
    expect(sql as string).toContain("1 - (embedding <=> $1::vector) AS score");
    expect(sql as string).toContain("metadata @> $2::jsonb");
    expect((params as unknown[])[0]).toBe("[1,0,0]");
    expect((params as unknown[])[1]).toBe(JSON.stringify({ sourceId: "a" }));
    expect((params as unknown[])[2]).toBe(5);
  });

  it("count() returns the row count and filters via jsonb containment", async () => {
    const { port, spy } = fakeQuery([
      ddl(),
      ddl(),
      ddl(),
      ddl(),
      { rows: [{ n: "7" }], rowCount: 1 },
    ]);
    const store = new PgVectorStore({ query: port, embeddingDim: 3 });

    const n = await store.count({ sourceId: "a" });
    expect(n).toBe(7);
    const countCall = spy.mock.calls.find((c) => (c[0] as string).includes("count(*)"));
    expect(countCall![0] as string).toContain("metadata @> $1::jsonb");
  });

  it("deleteByMetadata returns the deleted row count", async () => {
    const { port } = fakeQuery([ddl(), ddl(), ddl(), ddl(), { rows: [], rowCount: 3 }]);
    const store = new PgVectorStore({ query: port, embeddingDim: 3 });
    expect(await store.deleteByMetadata({ sourceId: "a" })).toBe(3);
  });

  it("rejects an embedding whose dim does not match the configured dim", async () => {
    const { port } = fakeQuery([ddl(), ddl(), ddl(), ddl()]);
    const store = new PgVectorStore({ query: port, embeddingDim: 1024 });
    await expect(store.search([0.1, 0.2], 5)).rejects.toThrow(
      /embedding dim 2 does not match configured 1024/,
    );
  });
});
