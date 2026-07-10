import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'],
    coverage: {
      provider: 'v8',
      // ADR-0011 Phase 0: measure ALL shipped source, not a flattering 8-file subset. `all: true`
      // counts files no test ever imports at 0% — that zero is the honest truth, not a regression.
      all: true,
      // ADR-0011 Phase 1: the denominator is ALL first-party source — scripts/, kb/, bin/, and the
      // shipped plugin MCP server. plugin/test/run-tests.mjs is the plugin's own test battery and
      // kb/test-guard-injection.mjs is a test script (both run directly in CI), so they are test
      // code, not source — excluded from the denominator like tests/.
      include: ['scripts/**/*.mjs', 'kb/*.mjs', 'bin/*.mjs', 'plugin/mcp/*.mjs'],
      exclude: ['kb/node_modules/**', 'kb/clones/**', 'kb/test-guard-injection.mjs'],
      reporter: ['text-summary', 'lcov'],
      // Regression floor: CI fails below these. Set to the measured value ROUNDED DOWN (see the
      // commit that changed this line for the measured values). Raise as coverage grows; never
      // lower silently.
      thresholds: { statements: 13, lines: 14, branches: 11, functions: 15 },
    },
  },
});
