import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANTHROPIC_LLM_MODEL, DEFAULT_BEDROCK_LLM_MODEL } from "./config.js";

/**
 * Hold the model ids in prose to the ones the app actually runs.
 *
 * `platform:validate` already gates the chart against platform.yaml, so the
 * manifest and the values file cannot disagree about which model this tenant
 * may invoke. Nothing gated the third copy: README.md, AGENTS.md and CLAUDE.md
 * each restate the model by hand, and all three had gone on naming Sonnet 4
 * after the code moved to Sonnet 5.
 *
 * The README's is the one that costs something. It tells a new operator which
 * model to enable access for in the Bedrock console — follow it and every
 * invoke fails with AccessDeniedException on a model the app never asks for,
 * while the model it does ask for stays disabled.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string) => readFileSync(resolve(ROOT, name), "utf-8");

/** Every Anthropic/Bedrock model id this repo is allowed to name in prose. */
const KNOWN_MODELS = new Set([
  DEFAULT_BEDROCK_LLM_MODEL,
  DEFAULT_ANTHROPIC_LLM_MODEL,
  "amazon.titan-embed-text-v2:0",
]);

/**
 * Matches a Bedrock inference-profile id, a bare foundation-model id, or a
 * direct-API alias — the three shapes these docs use.
 *
 * The branches are deliberately disjoint. `claude-sonnet-5` is a substring of
 * `us.anthropic.claude-sonnet-5`, so without the lookbehind the second branch
 * would match inside the first one's hits: every full id would still be found
 * under its short name if the first branch ever stopped matching, and the
 * per-document guard below would see a non-zero count and report the document
 * covered while the shape it was covering went unchecked.
 */
const MODEL_ID =
  /\b(?:us\.)?anthropic\.claude-[a-z0-9.-]*[a-z0-9]|(?<!\.)\bclaude-(?:sonnet|opus|haiku)-[0-9][a-z0-9.-]*/g;

const DOCS = ["README.md", "AGENTS.md", "CLAUDE.md"];

describe("model ids in prose", () => {
  it("names only models the code declares", () => {
    // The direction that rots: a doc naming a model the app never invokes.
    // Anything genuinely new belongs in KNOWN_MODELS with the code change that
    // introduced it, not quietly in a paragraph.
    const strays: string[] = [];

    for (const doc of DOCS) {
      const text = read(doc);
      for (const [index, line] of text.split("\n").entries()) {
        for (const match of line.matchAll(MODEL_ID)) {
          if (!KNOWN_MODELS.has(match[0])) {
            strays.push(`${doc}:${index + 1} names ${match[0]}`);
          }
        }
      }
    }

    expect(
      strays,
      `docs name models src/config.ts does not declare:\n${strays.join("\n")}`,
    ).toEqual([]);
  });

  it("finds model ids in every document it claims to check", () => {
    // Without this, a regex that stopped matching would report every document
    // clean and the check above would pass by finding nothing.
    //
    // Per document, not in total: MODEL_ID is an alternation, and each branch
    // covers a different id shape. A total count stays above zero when one
    // branch breaks, so the document that branch was covering goes unchecked
    // while the suite still passes.
    const counts = Object.fromEntries(
      DOCS.map((doc) => [doc, [...read(doc).matchAll(MODEL_ID)].length]),
    );

    for (const doc of DOCS) {
      expect(
        counts[doc],
        `${doc} matched no model id — MODEL_ID no longer covers its shape`,
      ).toBeGreaterThan(0);
    }
  });

  it("states the Bedrock default the code actually uses", () => {
    // The setup instruction an operator follows to enable Bedrock model access.
    const readme = read("README.md");
    expect(readme).toContain(`default \`${DEFAULT_BEDROCK_LLM_MODEL}\``);
  });

  it("keeps the documented Platform allowlist equal to the real one", () => {
    // AGENTS.md quotes platform.yaml's identity block as an example. A quote
    // that has drifted from the file it quotes is worse than no quote: an
    // agent reading it writes a CR the operator will not grant.
    const documented = allowedModelsFrom(read("AGENTS.md"));
    const actual = allowedModelsFrom(read("platform.yaml"));

    expect(actual.length).toBeGreaterThan(0);
    expect(documented).toEqual(actual);
  });
});

/** The `allowedModels:` list items from a YAML-ish block, comments stripped. */
function allowedModelsFrom(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("allowedModels:"));
  if (start === -1) return [];

  const models: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s*-\s*([^\s#]+)/);
    if (!item) break;
    models.push(item[1]);
  }
  return models;
}
