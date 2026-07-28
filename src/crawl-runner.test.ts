/**
 * Integration test: the push radar's write path, end to end.
 *
 * Everything between the process edges runs for real — `crawlAll`, the HTML
 * parser, the chunker, the semantic differ against a working in-memory store,
 * and the alert engine with its threshold gate and Block Kit formatter. Only
 * three things are faked, and each is a genuine process boundary: HTTP (via
 * `crawlAll`'s own `fetchPageImpl` seam), the embedding provider, and the
 * Slack sink.
 *
 * The single-writer mutex is the reason this file exists. `replicaCount: 1`
 * plus this flag is the entire concurrency story: the scheduler and the MCP
 * `trigger_crawl` tool call the same runner, and two overlapping runs would
 * embed and upsert the same source while the other was halfway through
 * rewriting it. That invariant lived in a closure inside `main()`, where no
 * test could reach it.
 */

import { describe, expect, it, vi } from "vitest";
import type { AlertEngine, AlertSink } from "./alerts/index.js";
import { createAlertEngine } from "./alerts/index.js";
import type { Config } from "./config.js";
import { createCrawlRunner } from "./crawl-runner.js";
import type { FetchResult } from "./crawler/fetcher.js";
import type { Source } from "./crawler/sources.js";
import type { LlmProvider } from "./providers/llm.js";
import type { EmbeddingProvider } from "./providers/embeddings.js";
import type { SearchResult, VectorDocument, VectorStore } from "./providers/vectors.js";

const SOURCES: Source[] = [
  {
    id: "acme:changelog",
    competitor: "Acme",
    url: "https://acme.example.com/changelog",
    type: "changelog",
  },
  {
    id: "globex:pricing",
    competitor: "Globex",
    url: "https://globex.example.com/pricing",
    type: "pricing",
  },
];

function page(body: string): string {
  return `<html><body><main>${body}</main></body></html>`;
}

/** Long enough to clear the pipeline's 50-character floor and produce chunks. */
const LONG_BODY =
  "Acme has shipped a new usage-based billing tier with per-seat overage pricing. " +
  "The rollout covers every enterprise plan and replaces the old flat-rate contract. " +
  "Existing customers keep their current rate until renewal, and the migration guide " +
  "walks through the new invoice format in detail.";

const DIMS = 8;

/**
 * A deterministic embedder: identical text → identical vector, different text →
 * a near-orthogonal one.
 *
 * It seeds a PRNG from a hash of the whole string rather than accumulating
 * character codes. A character-frequency vector is the obvious version and it
 * is useless here — any two English paragraphs have almost the same letter
 * distribution, so every changed page scores above the 0.85 similarity
 * threshold and the differ reports no change no matter what the crawl found.
 */
function embedOne(text: string): number[] {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  const vector: number[] = [];
  for (let i = 0; i < DIMS; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vector.push(state / 2 ** 32 - 0.5);
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function fakeEmbedder(): EmbeddingProvider {
  return {
    dimensions: DIMS,
    async embed(texts: string[]) {
      return texts.map(embedOne);
    },
  };
}

/** A working in-memory store — real upsert/search/prune, so the diff is real. */
function memoryStore(): VectorStore & { docs: Map<string, VectorDocument> } {
  const docs = new Map<string, VectorDocument>();
  const cosine = (a: number[], b: number[]) => {
    const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
    return dot / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
  };
  return {
    docs,
    async upsert(incoming) {
      for (const doc of incoming) docs.set(doc.id, doc);
    },
    async search(embedding, topK, filter) {
      const matches: SearchResult[] = [];
      for (const doc of docs.values()) {
        if (filter && Object.entries(filter).some(([k, v]) => doc.metadata?.[k] !== v)) continue;
        matches.push({
          id: doc.id,
          content: doc.content,
          score: cosine(embedding, doc.embedding),
          metadata: doc.metadata ?? {},
        });
      }
      return matches.sort((a, b) => b.score - a.score).slice(0, topK);
    },
    async delete(ids) {
      for (const id of ids) docs.delete(id);
    },
    async deleteByMetadata(filter, keepIds) {
      let removed = 0;
      for (const [id, doc] of docs) {
        if (keepIds?.includes(id)) continue;
        if (Object.entries(filter).every(([k, v]) => doc.metadata?.[k] === v)) {
          docs.delete(id);
          removed++;
        }
      }
      return removed;
    },
    async count(filter) {
      if (!filter) return docs.size;
      return [...docs.values()].filter((doc) =>
        Object.entries(filter).every(([k, v]) => doc.metadata?.[k] === v),
      ).length;
    },
  };
}

function fakeLlm(): LlmProvider {
  return {
    async chat() {
      return {
        text: JSON.stringify({
          significance: "high",
          summary: "Acme moved to usage-based billing.",
          signals: ["pricing change"],
        }),
        inputTokens: 512,
        outputTokens: 64,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    },
  };
}

function alertConfig(overrides: Partial<Config> = {}): Config {
  return {
    significanceThreshold: 0.3,
    slackAlertChannel: "#competitive-intel",
    ...overrides,
  } as Config;
}

interface HarnessOptions {
  sources?: Source[];
  html?: Record<string, string>;
  /** Fail every fetch, to exercise the "nothing to process" branch. */
  fetchFails?: boolean;
  /** Block each fetch until released, so two runs can overlap on purpose. */
  gate?: { promise: Promise<void> };
  alertEngine?: AlertEngine;
}

function harness(opts: HarnessOptions = {}) {
  const sources = opts.sources ?? SOURCES;
  const store = memoryStore();
  const sent: Array<{ channel: string; text: string }> = [];
  const sink: AlertSink = {
    async send(channel, message) {
      sent.push({ channel, text: message.text });
    },
  };

  const fetchPageImpl = vi.fn(async (url: string): Promise<FetchResult> => {
    if (opts.gate) await opts.gate.promise;
    if (opts.fetchFails) throw new Error(`connect ECONNREFUSED ${url}`);
    const html = opts.html?.[url] ?? page(LONG_BODY);
    return { url, html, statusCode: 200, fetchedAt: new Date(), headers: {} };
  });

  const runCrawl = createCrawlRunner({
    sources,
    crawlOptions: { timeoutMs: 1_000, userAgent: "test", fetchPageImpl },
    embedder: fakeEmbedder(),
    store,
    alertEngine: opts.alertEngine ?? createAlertEngine(fakeLlm(), sink, alertConfig()),
  });

  return { runCrawl, store, sent, fetchPageImpl };
}

describe("the single-writer mutex", () => {
  it("skips a second run that starts while the first is still going", async () => {
    let release!: () => void;
    const gate = { promise: new Promise<void>((resolve) => (release = resolve)) };
    const h = harness({ gate });

    const first = h.runCrawl();
    // The MCP trigger_crawl path, arriving mid-crawl.
    const second = await h.runCrawl();
    expect(second).toBe("skipped");

    release();
    expect(await first).toBe("ran");
  });

  it("releases the mutex after a run so the next one proceeds", async () => {
    const h = harness();
    expect(await h.runCrawl()).toBe("ran");
    expect(await h.runCrawl()).toBe("ran");
  });

  it("releases the mutex even when the run throws, rather than wedging the radar", async () => {
    // Without the `finally`, one pipeline failure would leave the flag set for
    // the life of the pod and every later run would report "skipped" forever.
    const exploding: AlertEngine = {
      async processDiffs() {
        throw new Error("alert engine exploded");
      },
    };
    const h = harness({ alertEngine: exploding });

    await expect(h.runCrawl()).rejects.toThrow(/alert engine exploded/);
    // Still usable: the next call gets past the mutex and reaches the fetcher.
    await expect(h.runCrawl()).rejects.toThrow(/alert engine exploded/);
    expect(h.fetchPageImpl).toHaveBeenCalledTimes(SOURCES.length * 2);
  });
});

describe("runCrawl — nothing to do", () => {
  it("skips when no sources are configured, without touching the network", async () => {
    const h = harness({ sources: [] });
    expect(await h.runCrawl()).toBe("skipped");
    expect(h.fetchPageImpl).not.toHaveBeenCalled();
  });

  it("reports a run, not a skip, when every fetch fails", async () => {
    // "ran" is the honest answer: the crawl was attempted. Reporting "skipped"
    // here would tell an operator the mutex held when the sites were down.
    const h = harness({ fetchFails: true });
    expect(await h.runCrawl()).toBe("ran");
    expect(h.sent).toHaveLength(0);
    expect(h.store.docs.size).toBe(0);
  });
});

describe("runCrawl — the full path", () => {
  it("seeds a baseline on the first crawl and stays quiet", async () => {
    // The cold-start guard. Without it every source on a fresh deploy scores
    // 1.0 and the first run pages the team with one alert per competitor.
    const h = harness();
    expect(await h.runCrawl()).toBe("ran");

    expect(h.store.docs.size).toBeGreaterThan(0);
    expect(h.sent).toHaveLength(0);
  });

  it("stays quiet on a second crawl of unchanged pages", async () => {
    const h = harness();
    await h.runCrawl();
    await h.runCrawl();

    expect(h.sent).toHaveLength(0);
  });

  it("alerts once a page has genuinely changed", async () => {
    const changed = page(
      "Globex now bundles the analytics add-on into the base subscription at no extra cost. " +
        "The standalone analytics SKU is retired and existing add-on contracts convert at renewal. " +
        "Support for the legacy reporting API ends next quarter with a documented migration path.",
    );
    const h = harness();
    await h.runCrawl(); // baseline
    expect(h.sent).toHaveLength(0);

    // Second crawl against the same seeded store, so the diff runs against
    // real history rather than a cold start.
    const secondPass = createCrawlRunner({
      sources: SOURCES,
      crawlOptions: {
        timeoutMs: 1_000,
        userAgent: "test",
        fetchPageImpl: async (url) => ({
          url,
          html: url.includes("globex") ? changed : page(LONG_BODY),
          statusCode: 200,
          fetchedAt: new Date(),
          headers: {},
        }),
      },
      embedder: fakeEmbedder(),
      store: h.store,
      alertEngine: createAlertEngine(
        fakeLlm(),
        {
          async send(channel, message) {
            h.sent.push({ channel, text: message.text });
          },
        },
        alertConfig(),
      ),
    });

    expect(await secondPass()).toBe("ran");
    // Only the page that actually changed alerts — Acme served the same bytes.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].channel).toBe("#competitive-intel");
  });
});
