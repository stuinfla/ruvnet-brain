import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const homes = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('subscription-only dual-host installer wiring', () => {
  it('materializes both coordinator tools at the stable user path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-dual-host-'));
    homes.push(home);
    const source = [
      "import('./bin/install.mjs').then(async ({ offerRouterProfile }) => {",
      '  const result = await offerRouterProfile();',
      '  process.stdout.write(`RESULT=${result}\\n`);',
      '});',
    ].join('\n');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        // This case owns a disposable HOME and intentionally exercises the unsuppressed installer.
        // Do not inherit an outer isolated-suite guard that would turn the subject under test off.
        RUVNET_BRAIN_TEST: '0',
        RUVNET_BRAIN_IMPORT_ONLY: '1',
        RUVNET_BRAIN_NO_COLOR: '1',
      },
      timeout: 30_000,
    });

    expect(run.status, run.stderr).toBe(0);
    const bin = path.join(home, '.claude', 'model-router', 'bin');
    expect(fs.existsSync(path.join(bin, 'subscription-hosts.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(bin, 'dual-host-deliberation.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(bin, 'dual-host-suggest.mjs'))).toBe(true);
  });
});
