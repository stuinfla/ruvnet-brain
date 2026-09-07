import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildIntegrationEvidence } from '../../scripts/integration-evidence.mjs';

const root = path.resolve(import.meta.dirname, '../..');
describe('required native Codex discovery', () => {
  it('fails the real discovery suite when the required CLI is missing', () => {
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'tests/integration/codex-skill-discovery.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, RUVNET_REQUIRE_CODEX_DISCOVERY: '1', RUVNET_CODEX_BIN: path.join(root, 'missing-codex-test-binary') } });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('required Codex CLI is unavailable');
  });
  it('rejects a skipped native discovery result as release integration proof', () => {
    const title = 'exposes self-contained native Console and What is New skills through the real plugin loader';
    expect(() => buildIntegrationEvidence({ numTotalTests: 1, numPendingTests: 1,
      testResults: [{ assertionResults: [{ title, fullName: title, status: 'skipped' }] }] },
    { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 })).toThrow(/unknown skips/);
  });
});
