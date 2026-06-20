import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
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
