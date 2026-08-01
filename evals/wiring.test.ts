/**
 * The offline tier's wiring assertions.
 *
 * `harness.test.ts` asks whether the golden set and the graders are sound.
 * This asks whether the tier can start at all — a different question, and the
 * one that was quietly answered "no".
 *
 * `evals.yml` set `EVAL_LLM: bedrock`, the direct-to-Bedrock backend from
 * before this app moved onto the ModelGateway. `resolveEvalLlm` accepts only
 * `gateway` and throws on anything else, so a dispatched run failed before
 * reaching a model. Nothing reported it: the workflow is manual-dispatch-only
 * with no schedule, and a tier nobody runs looks exactly like one that works.
 *
 * These read the workflow off disk rather than taking values as parameters.
 * A check handed the value by the thing it is checking agrees with itself.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EVAL_BACKENDS } from "./provider.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function workflow(name: string): unknown {
  return parse(readFileSync(join(repoRoot, ".github", "workflows", name), "utf8"));
}

/**
 * Every `env:` map in the tree, job-level and step-level alike.
 *
 * Walked rather than read from one known path: EVAL_LLM could legitimately move
 * between the job and the step, and a check that only looked where it happens
 * to sit today would go silent the moment it did — which is the failure mode
 * this file exists to close, not reproduce.
 */
function envValues(node: unknown, key: string, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) envValues(item, key, found);
    return found;
  }
  const record = node as Record<string, unknown>;
  const env = record.env;
  if (env && typeof env === "object" && key in (env as Record<string, unknown>)) {
    found.push(String((env as Record<string, unknown>)[key]));
  }
  for (const value of Object.values(record)) envValues(value, key, found);
  return found;
}

describe("the eval workflow and the eval code agree", () => {
  const evals = workflow("evals.yml");

  it("asks for a backend resolveEvalLlm accepts", () => {
    const asked = envValues(evals, "EVAL_LLM");
    expect(asked.length).toBeGreaterThan(0);
    for (const value of asked) {
      expect(EVAL_BACKENDS as readonly string[]).toContain(value);
    }
  });

  it("supplies the gateway endpoint that backend requires", () => {
    // `gateway` is not self-sufficient: resolveEvalLlm throws without
    // MODEL_GATEWAY_ENDPOINT. Asking for the right backend and not giving it an
    // address fails in exactly the same place, one line later.
    expect(envValues(evals, "MODEL_GATEWAY_ENDPOINT").length).toBeGreaterThan(0);
  });

  it("finds EVAL_LLM at all", () => {
    // Unset means the tier skips. A workflow that dropped the variable would
    // report success having run no evals — worse than failing, because it looks
    // like coverage.
    expect(envValues(evals, "EVAL_LLM")).not.toEqual([]);
  });
});

describe("the env walker", () => {
  // The assertions above are only worth their green if the walker finds things.
  // One that matched nothing would pass every test in this file vacuously.
  it("finds an env value on a job", () => {
    expect(envValues({ jobs: { a: { env: { EVAL_LLM: "gateway" } } } }, "EVAL_LLM")).toEqual([
      "gateway",
    ]);
  });

  it("finds an env value on a step inside an array", () => {
    expect(
      envValues(
        { jobs: { a: { steps: [{ run: "x" }, { env: { EVAL_LLM: "gateway" } }] } } },
        "EVAL_LLM",
      ),
    ).toEqual(["gateway"]);
  });

  it("finds both when the key is set in two places", () => {
    const doc = { env: { EVAL_LLM: "a" }, jobs: { j: { steps: [{ env: { EVAL_LLM: "b" } }] } } };
    expect(envValues(doc, "EVAL_LLM").sort()).toEqual(["a", "b"]);
  });

  it("returns nothing when the key is absent", () => {
    expect(envValues({ jobs: { a: { env: { OTHER: "x" } } } }, "EVAL_LLM")).toEqual([]);
  });
});
