import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['scripts/version.mjs', 'scripts/verify-bundle.mjs', 'kb/forge-guard-injection.mjs', 'kb/resolve-deps.mjs', 'kb/forge-ask-all.mjs'],
      reporter: ['text', 'lcov'],
      // Regression floor (item 5): CI fails if coverage drops below these — set just under the
      // current measured levels (stmts 59 / lines 63 / branches 49 / funcs 66). Raise as coverage grows.
      thresholds: { statements: 55, lines: 60, branches: 47, functions: 62 },
    },
  },
});
