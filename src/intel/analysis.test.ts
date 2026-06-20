import { describe, it, expect } from "vitest";
import { analyzeChanges, stripCodeFences } from "./analysis.js";
import type { DiffResult } from "../pipeline/differ.js";
import type { LlmProvider, LlmResponse } from "../providers/llm.js";
import type { Chunk } from "../pipeline/chunker.js";

function fakeLlm(text: string): LlmProvider {
  const response: LlmResponse = {
    text,
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

function chunk(text: string): Chunk {
  return {
    id: "s:0",
    text,
    index: 0,
    sourceId: "acme:pricing",
    metadata: { sourceId: "acme:pricing" },
  };
}

const diff: DiffResult = {
  sourceId: "acme:pricing",
  competitor: "acme",
  changeScore: 0.7,
  newChunks: [chunk("new content")],
  unchangedChunks: [],
  totalChunks: 1,
};

describe("stripCodeFences", () => {
  it("returns bare JSON unchanged", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
  it("strips a ```json fence", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("strips a plain ``` fence", () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe("analyzeChanges", () => {
  it("passes through clean JSON", async () => {
    const llm = fakeLlm(
      JSON.stringify({ summary: "Launched X", significance: "high", signals: ["X"] }),
    );
    const a = await analyzeChanges(diff, llm);
    expect(a.summary).toBe("Launched X");
    expect(a.significance).toBe("high");
    expect(a.signals).toEqual(["X"]);
    expect(a.sourceId).toBe("acme:pricing");
  });

  it("parses fenced JSON", async () => {
    const llm = fakeLlm('```json\n{"summary":"Y","significance":"medium","signals":[]}\n```');
    const a = await analyzeChanges(diff, llm);
    expect(a.summary).toBe("Y");
    expect(a.significance).toBe("medium");
  });

  it("clamps an invalid significance to low while keeping the parsed summary", async () => {
    const llm = fakeLlm(JSON.stringify({ summary: "Z", significance: "urgent", signals: ["a"] }));
    const a = await analyzeChanges(diff, llm);
    expect(a.significance).toBe("low");
    expect(a.summary).toBe("Z"); // from parsed JSON, NOT the raw-text fallback
    expect(a.signals).toEqual(["a"]);
  });

  it("defaults a missing summary", async () => {
    const llm = fakeLlm(JSON.stringify({ significance: "low", signals: [] }));
    const a = await analyzeChanges(diff, llm);
    expect(a.summary).toBe("Analysis unavailable");
  });

  it("falls back to raw text on non-JSON output", async () => {
    const prose = "The competitor appears to have updated pricing significantly.";
    const a = await analyzeChanges(diff, fakeLlm(prose));
    expect(a.summary).toBe(prose.slice(0, 500));
    expect(a.significance).toBe("low");
    expect(a.signals).toEqual([]);
  });
});
