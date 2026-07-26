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
      // src/vendor/ holds byte-identical copies of @nanohype/runtime modules,
      // fully unit-tested at their source of truth (nanohype/library/runtime);
      // local tests cover this app's wiring of them.
      exclude: ["src/**/*.test.ts", "src/vendor/**"],
      // Floors set just below current measured coverage so CI fails on a
      // regression, not on the current state. Ratchet up as the suite grows.
      thresholds: {
        lines: 55, // measured 55.26
        functions: 53, // measured 54.40
        branches: 59, // measured 60.54
        statements: 55, // measured 55.16
      },
    },
  },
});
