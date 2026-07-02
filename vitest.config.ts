import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // src/vendor/ holds byte-identical copies of @nanohype/runtime modules,
      // fully unit-tested at their source of truth (nanohype/library/runtime);
      // local tests cover this app's wiring of them.
      exclude: ["src/**/*.test.ts", "src/vendor/**"],
      // Floors set just below current measured coverage so CI fails on a
      // regression, not on the current state. Ratchet up as the orchestrators
      // (crawler/slack/intel) gain tests.
      thresholds: {
        lines: 30,
        functions: 28,
        branches: 38,
        statements: 30,
      },
    },
  },
});
