import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/vendor/ holds byte-identical copies of @nanohype/runtime modules,
      // fully unit-tested at their source of truth (nanohype/library/runtime);
      // local tests cover this app's wiring of them.
      exclude: ['src/**/*.test.ts', 'src/vendor/**'],
      // Floors set just below current measured coverage so CI fails on a
      // regression, not on the current state. Ratchet up as the suite grows.
      thresholds: {
        lines: 50, // measured 52.59
        functions: 45, // measured 47.27
        branches: 59, // measured 61.94
        statements: 50, // measured 52.65
      },
    },
  },
});
