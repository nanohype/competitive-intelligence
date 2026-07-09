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
        lines: 52, // measured 53.2
        functions: 50, // measured 52.51
        branches: 59, // measured 60.74
        statements: 52, // measured 53.38
      },
    },
  },
});
