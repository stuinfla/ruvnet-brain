import { defineConfig } from 'vitest/config';

// Machine and historical diagnostics: deliberately outside the root include (and so outside
// scripts/full-suite-gate.mjs); tests/known-red.json `excludedFiles` names each one and why.
export default defineConfig({
  test: {
    include: ['tests/diagnostics/**/*.test.mjs'],
    env: { RUVNET_TURN_CAPTURE: 'off' },
    testTimeout: 90_000,
  },
});
