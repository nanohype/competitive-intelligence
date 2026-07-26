import { beforeAll, describe, expect, it } from "vitest";
import { analyzeChanges } from "../src/intel/analysis.js";
import type { LlmProvider } from "../src/providers/llm.js";
import { type GradeResult, grade, loadSuite, score, toDiff } from "./harness.js";
import { resolveEvalLlm } from "./provider.js";

// The model tier. Runs against a real provider, costs money, and reports a
// score rather than a boolean.
//
// EVAL_LLM decides whether it runs at all, and the two states are deliberately
// asymmetric:
//
//   unset      — skipped. Local default; running the unit suite should not
//                bill anyone.
//   set        — must work. A configured-but-broken provider is a hard
//                failure, never a skip, because a green run has to mean the
//                evals executed. This mirrors portal's TEST_DATABASE_URL.
//
// CI sets it on the job that has credentials, and that job is separate from
// `verify` so its result is legible on its own.

const suite = loadSuite("analysis.json");
const configured = (process.env.EVAL_LLM ?? "").trim();

describe.skipIf(configured === "")(`eval: ${suite.name}`, () => {
  let llm: LlmProvider;
  const results = new Map<string, GradeResult>();

  beforeAll(async () => {
    llm = resolveEvalLlm(configured);

    // Cases are independent, so run them concurrently — but bounded, because
    // a golden set that grows to fifty cases would otherwise open fifty
    // simultaneous model calls and trip provider rate limits, which reads as
    // an eval failure rather than what it is.
    const queue = [...suite.cases];
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        try {
          const analysis = await analyzeChanges(toDiff(c.input), llm);
          results.set(c.id, grade(c.expect, analysis));
        } catch (err) {
          // A thrown case is a failed case, recorded as such. Leaving it
          // absent would let an outage read as a smaller suite that passed.
          results.set(c.id, {
            passed: false,
            failures: [
              {
                check: "significance",
                detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          });
        }
      }
    });
    await Promise.all(workers);
  }, 300_000);

  // Adversarial cases are asserted one by one. There is no rate here: a
  // boundary that holds four times in five is not a boundary, and naming the
  // specific case that broke is the whole value when one does.
  for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
    it(`holds the line: ${c.id}`, () => {
      const r = results.get(c.id);
      expect(r, `${c.id} produced no result`).toBeDefined();
      const why = (r?.failures ?? []).map((f) => `${f.check}: ${f.detail}`).join("; ");
      expect(`${c.id} — ${why}`, `\n${c.rationale}\n`).toBe(`${c.id} — `);
    });
  }

  it("meets the capability floor", () => {
    const s = score(suite.cases, results);
    const failed = suite.cases
      .filter((c) => c.kind === "capability" && !results.get(c.id)?.passed)
      .map((c) => {
        const why = (results.get(c.id)?.failures ?? [])
          .map((f) => `${f.check}: ${f.detail}`)
          .join("; ");
        return `  ${c.id} — ${why}`;
      });

    // Capability is a rate because model judgment legitimately varies between
    // adjacent bands. Raise the floor in the fixture as prompts improve; a
    // floor nobody ratchets stops being a floor.
    expect(
      s.capability.rate,
      `capability ${s.capability.passed}/${s.capability.total}` +
        (failed.length ? `\nfailed:\n${failed.join("\n")}` : ""),
    ).toBeGreaterThanOrEqual(suite.capabilityFloor);
  });

  it("ran every case", () => {
    // Guards the guard: if a case silently never executed, the floor above
    // was computed over a smaller suite.
    expect(results.size).toBe(suite.cases.length);
  });
});
