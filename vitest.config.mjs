import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['scripts/version.mjs', 'scripts/verify-bundle.mjs', 'scripts/fix-metaharness-memretrieve.mjs', 'scripts/private-fence.mjs', 'kb/forge-guard-injection.mjs', 'kb/resolve-deps.mjs', 'kb/forge-ask-all.mjs', 'kb/verify-citation.mjs'],
      reporter: ['text', 'lcov'],
      // Regression floor (item 5): CI fails if coverage drops below these — set just under the
      // current measured levels (stmts 74 / lines 77 / branches 62 / funcs 78). Raise as coverage grows.
      thresholds: { statements: 71, lines: 74, branches: 59, functions: 75 },
    },
  },
});
