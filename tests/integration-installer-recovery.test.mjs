import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const fixture = process.env.RUVNET_RECOVERY_FIXTURE_ROOT;
describe('real installer staged recovery', () => {
  it.skipIf(!fixture)('applies then no-ops while preserving private bytes and metadata', () => {
    const env = { ...process.env, PATH: '/usr/bin:/bin', RUVNET_BRAIN_KB: `${fixture}/kb`,
      RUVNET_BRAIN_HOME: `${fixture}/home/brain`, RUVNET_BRAIN_TEST: '1',
      RUVNET_BRAIN_TEST_LATEST_TAG: 'v4.3.21',
      RUVNET_BRAIN_TEST_BUNDLE: process.env.RUVNET_RECOVERY_FIXTURE_ZIP,
      RUVNET_NO_UPDATE_FALLBACK: '0', RUVNET_NO_TELEMETRY: '1' };
    const run = () => spawnSync('/opt/homebrew/bin/node', ['/tmp/rnb-historical-harness/bin/install.mjs', '--update', '--no-nightly-prompt'], { env, encoding: 'utf8' });
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(fs.readFileSync(`${fixture}/kb/private.rvf`, 'utf8')).toBe('private-bytes');
    expect(JSON.parse(fs.readFileSync(`${fixture}/kb/SOURCE.json`)).stores.private.updateManaged).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${fixture}/kb/RVF-GENERATIONS.json`)).stores.private.file).toBe('private.rvf');
  });
});
