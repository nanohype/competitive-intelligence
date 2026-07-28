/**
 * sources.json loader tests.
 *
 * This is the crawl target list, and it is the one input that decides what the
 * radar reaches out to. Two properties matter beyond parsing: a missing file is
 * an empty list rather than a crash (a fresh deploy with no sources mounted
 * should still serve MCP queries), and a malformed file is a hard failure
 * rather than a partial list — silently dropping a competitor means the radar
 * reports "no changes" for a site it never visited.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSourcesFromFile } from "./sources.js";

const dir = mkdtempSync(join(tmpdir(), "ci-sources-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadSourcesFromFile", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(loadSourcesFromFile(join(dir, "absent.json"))).toEqual([]);
  });

  it("loads a valid source set", () => {
    const path = write("valid.json", {
      sources: [
        {
          id: "acme:changelog",
          competitor: "Acme",
          url: "https://acme.example.com/changelog",
          type: "changelog",
          selectors: { content: "main", exclude: [".nav"] },
        },
      ],
    });

    expect(loadSourcesFromFile(path)).toEqual([
      {
        id: "acme:changelog",
        competitor: "Acme",
        url: "https://acme.example.com/changelog",
        type: "changelog",
        selectors: { content: "main", exclude: [".nav"] },
      },
    ]);
  });

  it("derives a stable id from competitor and type when none is given", () => {
    // The id keys every stored chunk's metadata, so it has to be derived the
    // same way on every load — a generated or positional id would orphan a
    // source's history the first time the file is reordered.
    const path = write("no-id.json", {
      sources: [
        { competitor: "Globex", url: "https://globex.example.com/pricing", type: "pricing" },
      ],
    });

    expect(loadSourcesFromFile(path)[0].id).toBe("Globex:pricing");
  });

  it("accepts an empty source list", () => {
    expect(loadSourcesFromFile(write("empty.json", { sources: [] }))).toEqual([]);
  });

  it.each([
    ["a url that is not a URL", { competitor: "Acme", url: "acme.example.com", type: "blog" }],
    ["an unknown type", { competitor: "Acme", url: "https://acme.example.com", type: "twitter" }],
    ["an empty competitor", { competitor: "", url: "https://acme.example.com", type: "blog" }],
    ["a missing url", { competitor: "Acme", type: "blog" }],
  ])("rejects %s rather than dropping the entry", (name, source) => {
    const path = write(`${name.replace(/\W+/g, "-")}.json`, { sources: [source] });
    expect(() => loadSourcesFromFile(path)).toThrow();
  });

  it("rejects a file with no sources key", () => {
    expect(() => loadSourcesFromFile(write("shapeless.json", { competitors: [] }))).toThrow();
  });

  it("rejects a file that is not JSON", () => {
    expect(() => loadSourcesFromFile(write("broken.json", "{ not json"))).toThrow();
  });
});
