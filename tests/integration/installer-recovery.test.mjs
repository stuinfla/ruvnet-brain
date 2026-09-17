import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture = process.env.RUVNET_RECOVERY_FIXTURE_ROOT;
const installer = path.resolve(new URL('../../bin/install.mjs', import.meta.url).pathname);
describe('real installer staged recovery', () => {
  it.skipIf(!fixture)('applies then no-ops while preserving private bytes and metadata', () => {
    const env = { ...process.env, PATH: '/usr/bin:/bin', HOME: `${fixture}/home`, RUVNET_BRAIN_KB: `${fixture}/kb`,
      RUVNET_BRAIN_HOME: `${fixture}/home/brain`, RUVNET_BRAIN_TEST: '1',
      RUVNET_BRAIN_TEST_LATEST_TAG: 'v4.3.21',
      RUVNET_BRAIN_TEST_BUNDLE: process.env.RUVNET_RECOVERY_FIXTURE_ZIP,
      RUVNET_NO_UPDATE_FALLBACK: '0', RUVNET_NO_TELEMETRY: '1' };
    const run = () => spawnSync(process.execPath, [installer, '--update', '--no-nightly-prompt'], { env, encoding: 'utf8' });
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('"terminalVerdict":"applied"');
    const repeat = run();
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toContain('"terminalVerdict":"noop"');
    expect(fs.readFileSync(`${fixture}/kb/private.rvf`, 'utf8')).toBe('private-bytes');
    expect(JSON.parse(fs.readFileSync(`${fixture}/kb/SOURCE.json`)).stores.private.updateManaged).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${fixture}/kb/RVF-GENERATIONS.json`)).stores.private.file).toBe('private.rvf');
    const receipts = fs.readdirSync(`${fixture}/home/brain/refresh-runs`).filter((name) => name.endsWith('.json'));
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    const terminal = receipts.map((name) => JSON.parse(fs.readFileSync(`${fixture}/home/brain/refresh-runs/${name}`)))
      .filter((receipt) => receipt.status === 'SUCCEEDED');
    expect(terminal.length).toBeGreaterThanOrEqual(2);
  });
});
