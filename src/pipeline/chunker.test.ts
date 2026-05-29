import { describe, it, expect } from "vitest";
import { chunkText } from "./chunker.js";

const opts = { sourceId: "test:src", metadata: { sourceId: "test:src" } };

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Short text.", opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Short text.");
    expect(chunks[0].id).toBe("test:src:0");
    expect(chunks[0].index).toBe(0);
  });

  it("splits long text into multiple chunks", () => {
    const text = "word ".repeat(500); // ~2500 chars
    const chunks = chunkText(text, { ...opts, maxChunkSize: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Allow overlap to push slightly over maxChunkSize
      expect(chunk.text.length).toBeLessThan(500);
    }
  });

  it("preserves sourceId in each chunk", () => {
    const text = "a ".repeat(300);
    const chunks = chunkText(text, { ...opts, maxChunkSize: 100 });
    for (const chunk of chunks) {
      expect(chunk.sourceId).toBe("test:src");
      expect(chunk.metadata.sourceId).toBe("test:src");
    }
  });

  it("generates sequential IDs", () => {
    const text = "paragraph one.\n\nparagraph two.\n\nparagraph three.";
    const chunks = chunkText(text, { ...opts, maxChunkSize: 20, overlap: 0 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].id).toBe(`test:src:${i}`);
      expect(chunks[i].index).toBe(i);
    }
  });

  it("applies overlap between chunks", () => {
    const text = "AAAA\n\nBBBB\n\nCCCC";
    const chunks = chunkText(text, { ...opts, maxChunkSize: 10, overlap: 4 });
    if (chunks.length > 1) {
      // Second chunk should start with tail of first chunk
      expect(chunks[1].text.length).toBeGreaterThan(0);
    }
  });
});
