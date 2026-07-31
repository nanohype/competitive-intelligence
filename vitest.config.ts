import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // evals/*.test.ts is the offline half of the eval tier — fixture
    // validity and the graders. It runs here, on every PR, because the model
    // half can be skipped and a rotted golden set must not wait for it.
    // The model half is evals/*.eval.ts, on its own config (npm run eval).
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // src/vendor/ holds byte-identical copies of @nanohype/runtime modules,
        // fully unit-tested at their source of truth (nanohype/library/runtime);
        // local tests cover this app's wiring of them.
        "src/vendor/**",
        // Composition roots. index.ts wires config → providers → sources →
        // crawl runner → engines → MCP server → scheduler and nothing else;
        // the logic it used to hold lives in src/crawl-runner.ts and
        // src/health.ts, both covered. cli.ts is the same for the one-off
        // commands, rendering through display.ts — which is ANSI terminal
        // output end to end, every function a console.log of styled strings.
        // Its contract is visual, and a test of it would pin escape sequences
        // rather than behavior.
        "src/index.ts",
        "src/cli.ts",
        "src/display.ts",
        // Per-provider SDK adapters — build a request, call, parse. They are
        // exercised through their interfaces (LlmProvider, EmbeddingProvider)
        // by the crawl-runner and intel tests, which is where the behavior
        // that matters lives. The selection in front of them is a real
        // decision and is tested in providers/bootstrap.test.ts even though
        // it is not counted here.
        "src/providers/llm.ts",
        "src/providers/embeddings.ts",
      ],
      // Always on, so `npm test` enforces the floor locally exactly as CI does
      // (ci.yml runs `test:coverage`). A gate that only evaluates behind a flag
      // is one forgotten flag away from letting an untested module land.
      enabled: true,
      // Floors set just below current measured coverage so CI fails on a
      // regression, not on the current state. They clear the org floor in
      // nanohype/standards/testing-rubric.json (branches 60 / functions 75 /
      // lines 75 / statements 75). Ratchet up as the suite grows; never down.
      thresholds: {
        lines: 93, // measured 93.09
        functions: 94, // measured 94.07
        branches: 85, // measured 85.79
        statements: 92, // measured 92.26

        // Per-file 100%, above the global floor, on the two files where an
        // uncovered branch is an unproven security control rather than a
        // coverage number. A global floor averages these against everything
        // else, so the package can sit comfortably above its ratchet while the
        // gap is in the SSRF guard.
        //
        // url-guard.ts decides whether an operator-supplied source URL may be
        // fetched at all — every branch is a way into the VPC, the cloud
        // metadata endpoint, or loopback.
        //
        // oauth.ts is the MCP resource server's token check: signature, issuer,
        // expiry, and the RFC 8707 audience binding that stops a token minted
        // for another resource being replayed here.
        "src/crawler/url-guard.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "src/mcp/oauth.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
