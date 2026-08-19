import { describe, expect, it } from "vitest";
import type { Chunk } from "../pipeline/chunker.js";
import type { DiffResult } from "../pipeline/differ.js";
import type { LlmProvider, LlmResponse } from "../providers/llm.js";
import { analyzeChanges, stripCodeFences } from "./analysis.js";

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

  // A field the schema rejects is a parse failure, not a value to repair. The
  // schema used to `.catch()` these into `low` / `[]` and return the object as
  // if the model had answered correctly, so a model that had started emitting
  // garbage was reported as a confident low-significance finding.
  it("falls back to raw text when significance is not one of the four levels", async () => {
    const raw = JSON.stringify({ summary: "Z", significance: "urgent", signals: ["a"] });
    const a = await analyzeChanges(diff, fakeLlm(raw));
    expect(a.summary).toBe(raw.slice(0, 500)); // the raw-text fallback, NOT "Z"
    expect(a.significance).toBe("low");
    expect(a.signals).toEqual([]);
  });

  it("falls back to raw text when summary is missing", async () => {
    const raw = JSON.stringify({ significance: "low", signals: [] });
    const a = await analyzeChanges(diff, fakeLlm(raw));
    expect(a.summary).toBe(raw.slice(0, 500)); // not the old "Analysis unavailable" default
  });

  it("falls back to raw text when signals is not an array of strings", async () => {
    const raw = JSON.stringify({ summary: "Z", significance: "high", signals: [{ a: 1 }] });
    const a = await analyzeChanges(diff, fakeLlm(raw));
    expect(a.summary).toBe(raw.slice(0, 500));
    expect(a.signals).toEqual([]);
  });

  // The distinction the fallback cannot express on its own: a well-formed `low`
  // and a rejected response both leave `significance: "low"` downstream. This
  // pins that the well-formed one still keeps its own summary, which is the
  // only thing that tells them apart at the call site.
  it("keeps a genuine low-significance analysis distinct from the fallback", async () => {
    const llm = fakeLlm(
      JSON.stringify({ summary: "Minor copy edit", significance: "low", signals: [] }),
    );
    const a = await analyzeChanges(diff, llm);
    expect(a.summary).toBe("Minor copy edit");
    expect(a.significance).toBe("low");
  });

  it("falls back to raw text on non-JSON output", async () => {
    const prose = "The competitor appears to have updated pricing significantly.";
    const a = await analyzeChanges(diff, fakeLlm(prose));
    expect(a.summary).toBe(prose.slice(0, 500));
    expect(a.significance).toBe("low");
    expect(a.signals).toEqual([]);
  });
});
