import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { Chunk } from "../pipeline/chunker.js";
import type { DiffResult } from "../pipeline/differ.js";
import type { LlmProvider, LlmResponse } from "../providers/llm.js";
import type { SlackBlocks } from "./formatter.js";
import { type AlertSink, createAlertEngine } from "./index.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    llmProvider: "anthropic",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1024,
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

// Fake provider implementing the interface directly (no SDK mocking) — returns
// canned analysis JSON.
function fakeLlm(json: string): LlmProvider {
  const response: LlmResponse = {
    text: json,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return {
    async chat() {
      return response;
    },
  };
}

// Recording sink; `failing` makes send() reject to exercise the swallow path.
function recordingSink(failing = false): {
  sink: AlertSink;
  sends: Array<{ channel: string; message: SlackBlocks }>;
} {
  const sends: Array<{ channel: string; message: SlackBlocks }> = [];
  const sink: AlertSink = {
    async send(channel, message) {
      if (failing) throw new Error("slack down");
      sends.push({ channel, message });
    },
  };
  return { sink, sends };
}

function chunk(text: string): Chunk {
  return {
    id: "s:0",
    text,
    index: 0,
    sourceId: "acme:pricing",
    metadata: { sourceId: "acme:pricing" },
  };
}

function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    sourceId: "acme:pricing",
    competitor: "acme",
    changeScore: 0.5,
    newChunks: [chunk("new enterprise tier launched")],
    unchangedChunks: [],
    totalChunks: 1,
    ...overrides,
  };
}

const ANALYSIS = JSON.stringify({
  summary: "Acme launched an enterprise tier.",
  significance: "high",
  signals: ["new enterprise tier"],
});

describe("alert engine", () => {
  it("sends one alert on the configured channel for a significant diff", async () => {
    const { sink, sends } = recordingSink();
    const engine = createAlertEngine(fakeLlm(ANALYSIS), sink, makeConfig());

    const analyses = await engine.processDiffs([makeDiff()]);

    expect(analyses).toHaveLength(1);
    expect(analyses[0].significance).toBe("high");
    expect(sends).toHaveLength(1);
    expect(sends[0].channel).toBe("#test");
  });

  it("does not alert when changeScore is below the threshold", async () => {
    const { sink, sends } = recordingSink();
    const engine = createAlertEngine(
      fakeLlm(ANALYSIS),
      sink,
      makeConfig({ significanceThreshold: 0.6 }),
    );

    const analyses = await engine.processDiffs([makeDiff({ changeScore: 0.5 })]);

    expect(analyses).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("does not alert when there are no new chunks even above the threshold", async () => {
    const { sink, sends } = recordingSink();
    const engine = createAlertEngine(fakeLlm(ANALYSIS), sink, makeConfig());

    const analyses = await engine.processDiffs([makeDiff({ changeScore: 0.9, newChunks: [] })]);

    expect(analyses).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("still returns the analysis when the sink send fails", async () => {
    const { sink } = recordingSink(true);
    const engine = createAlertEngine(fakeLlm(ANALYSIS), sink, makeConfig());

    // processDiffs must resolve (swallowed send error) and keep the analysis.
    const analyses = await engine.processDiffs([makeDiff()]);
    expect(analyses).toHaveLength(1);
    expect(analyses[0].sourceId).toBe("acme:pricing");
  });
});
