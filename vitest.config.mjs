import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.mjs'],
    coverage: { provider: 'v8', include: ['scripts/version.mjs'], reporter: ['text'] },
  },
});
