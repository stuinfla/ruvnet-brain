import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['scripts/version.mjs', 'scripts/verify-bundle.mjs', 'scripts/fix-metaharness-memretrieve.mjs', 'kb/forge-guard-injection.mjs', 'kb/resolve-deps.mjs', 'kb/forge-ask-all.mjs'],
      reporter: ['text', 'lcov'],
      // Regression floor (item 5): CI fails if coverage drops below these — set just under the
      // current measured levels (stmts 66 / lines 69 / branches 56 / funcs 69). Raise as coverage grows.
      thresholds: { statements: 63, lines: 66, branches: 53, functions: 66 },
    },
  },
});
