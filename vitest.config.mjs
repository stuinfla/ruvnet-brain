import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['scripts/version.mjs', 'scripts/verify-bundle.mjs', 'kb/forge-guard-injection.mjs', 'kb/resolve-deps.mjs', 'kb/forge-ask-all.mjs'],
      reporter: ['text', 'lcov'],
      // Regression floor (item 5): CI fails if coverage drops below these — set just under the
      // current measured levels (stmts 57 / lines 61 / branches 49 / funcs 64). Raise as coverage grows.
      thresholds: { statements: 52, lines: 55, branches: 45, functions: 58 },
    },
  },
});
