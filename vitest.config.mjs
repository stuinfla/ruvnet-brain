import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['scripts/version.mjs', 'scripts/verify-bundle.mjs', 'kb/forge-guard-injection.mjs'],
      reporter: ['text', 'lcov'],
    },
  },
});
