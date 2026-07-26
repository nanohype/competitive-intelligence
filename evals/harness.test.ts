import { describe, expect, it } from "vitest";
import { type EvalCase, grade, loadSuite, score, toDiff } from "./harness.js";

// The offline half of the eval tier. No model, no credentials, runs in `npm
// test` on every PR. It answers two questions the model tier cannot: is the
// golden set still a golden set, and does the grader grade?
//
// This matters because the model tier is the one that can be skipped. If
// fixture rot only surfaced when someone ran evals with credentials, a
// degenerate suite could sit green for months.

const suite = loadSuite("analysis.json");

describe("the golden set", () => {
  it("parses", () => {
    // loadSuite throws on a malformed case; reaching here is the assertion.
    expect(suite.cases.length).toBeGreaterThan(0);
  });

  it("has unique case ids", () => {
    // Results are keyed by id — a duplicate silently drops a case from the
    // score while still looking like coverage in the file.
    const ids = suite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers both kinds", () => {
    const kinds = new Set(suite.cases.map((c) => c.kind));
    expect(kinds).toContain("capability");
    expect(kinds).toContain("adversarial");
  });

  it("spans the significance range", () => {
    // A capability set where every case expects the same band measures
    // nothing — a model that always answers "high" would score 100%.
    const bands = new Set(
      suite.cases.filter((c) => c.kind === "capability").flatMap((c) => c.expect.significance),
    );
    expect(bands.has("low")).toBe(true);
    expect(bands.size).toBeGreaterThan(1);
  });

  it("gives every adversarial case something falsifiable", () => {
    // An adversarial case with no `absent` and an all-bands `significance`
    // cannot fail. It would pass forever and read as a control.
    for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
      const constrained = c.expect.absent.length > 0 || c.expect.significance.length < 4;
      expect(constrained, `${c.id} can never fail`).toBe(true);
    }
  });

  it("sets a capability floor that demands most cases pass", () => {
    expect(suite.capabilityFloor).toBeGreaterThanOrEqual(0.5);
    expect(suite.capabilityFloor).toBeLessThanOrEqual(1);
  });
});

describe("toDiff", () => {
  it("carries the case content into the chunk the analyzer reads", () => {
    const diff = toDiff(suite.cases[0].input);
    expect(diff.newChunks).toHaveLength(1);
    expect(diff.newChunks[0].text).toBe(suite.cases[0].input.content);
    expect(diff.competitor).toBe(suite.cases[0].input.competitor);
  });
});

describe("grade", () => {
  const expected = {
    significance: ["high", "critical"] as const,
    mentions: [["enterprise", "tier"]],
    absent: ["PWNED"],
  };
  const base = { summary: "They launched an Enterprise tier.", significance: "high", signals: [] };

  it("passes a correct analysis", () => {
    expect(grade({ ...expected, significance: [...expected.significance] }, base).passed).toBe(
      true,
    );
  });

  it("accepts any value inside the band", () => {
    const r = grade(
      { ...expected, significance: [...expected.significance] },
      { ...base, significance: "critical" },
    );
    expect(r.passed).toBe(true);
  });

  it("fails outside the band and says what it got", () => {
    const r = grade(
      { ...expected, significance: [...expected.significance] },
      { ...base, significance: "low" },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("significance");
    expect(r.failures[0].detail).toContain("low");
  });

  it("matches mentions case-insensitively across summary and signals", () => {
    const r = grade(
      { ...expected, significance: [...expected.significance] },
      { summary: "New pricing.", significance: "high", signals: ["ENTERPRISE TIER launched"] },
    );
    expect(r.passed).toBe(true);
  });

  it("requires every term in a mention set, not just one", () => {
    // The set is an AND — "enterprise" alone could be the word "enterprise
    // customers" in unrelated copy.
    const r = grade(
      { ...expected, significance: [...expected.significance] },
      { ...base, summary: "They mention enterprise customers." },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("mentions");
    expect(r.failures[0].detail).toContain("tier");
  });

  it("catches a banned string anywhere in the output", () => {
    const r = grade(
      { ...expected, significance: [...expected.significance] },
      { ...base, signals: ["pwned"] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.check === "absent")).toBe(true);
  });

  it("reports every failure, not just the first", () => {
    // On a real failure you want the whole picture in one CI log line.
    const r = grade(
      { ...expected, significance: [...expected.significance] },
      { summary: "PWNED", significance: "low", signals: [] },
    );
    expect(r.failures.map((f) => f.check).sort()).toEqual(["absent", "mentions", "significance"]);
  });
});

describe("score", () => {
  const cases: EvalCase[] = [
    { kind: "capability", id: "a" },
    { kind: "capability", id: "b" },
    { kind: "capability", id: "c" },
    { kind: "capability", id: "d" },
    { kind: "adversarial", id: "x" },
    { kind: "adversarial", id: "y" },
  ].map((c) => ({ ...c, rationale: "x".repeat(25), input: {}, expect: {} }) as unknown as EvalCase);

  const results = (passing: string[]) =>
    new Map(cases.map((c) => [c.id, { passed: passing.includes(c.id), failures: [] }]));

  it("scores capability as a rate", () => {
    const s = score(cases, results(["a", "b", "c", "x", "y"]));
    expect(s.capability).toEqual({ passed: 3, total: 4, rate: 0.75 });
  });

  it("counts adversarial separately", () => {
    const s = score(cases, results(["a", "b", "c", "d", "x"]));
    expect(s.adversarial).toEqual({ passed: 1, total: 2 });
  });

  it("treats a missing result as a failure", () => {
    // A case whose run threw has no entry. Absent must never read as passed —
    // the same "no data looks like all clear" trap the graders exist to avoid.
    const s = score(cases, new Map());
    expect(s.capability.passed).toBe(0);
    expect(s.adversarial.passed).toBe(0);
  });
});
