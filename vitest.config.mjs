import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'],
    coverage: {
      provider: 'v8',
      // ADR-0011 Phase 0: measure ALL shipped source, not a flattering 8-file subset. `all: true`
      // counts files no test ever imports at 0% — that zero is the honest truth, not a regression.
      all: true,
      include: ['scripts/**/*.mjs', 'kb/*.mjs', 'bin/*.mjs'],
      exclude: ['kb/node_modules/**', 'kb/clones/**'],
      reporter: ['text-summary', 'lcov'],
      // Regression floor: CI fails below these. Set at measured − 2 (see the commit that changed
      // this line for the measured values). Raise as coverage grows; never lower silently.
      thresholds: { statements: 7, lines: 8, branches: 6, functions: 11 },
    },
  },
});
