import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';

// fileURLToPath, not URL().pathname ("/D:/…" on Windows), and bash from the one resolver. The script is
// the macOS launchd Goldie job, so the suite skips (visibly) on win32 or where no bash resolves.
const SCRIPT = fileURLToPath(new URL('../../scripts/goldie-weekly.sh', import.meta.url));
const BASH = resolveBash();
const RUNNABLE = process.platform !== 'win32' && Boolean(BASH) && fs.existsSync(BASH);
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!RUNNABLE)('goldie-weekly.sh under the launchd PATH (skipped: needs a POSIX bash; the job is macOS launchd)', () => {
  it('puts the native CLI directories ahead of the system PATH before it starts the cycle', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goldie-path-')); dirs.push(home);
    fs.mkdirSync(path.join(home, '.claude/model-router/bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/bin/model-weekly-cycle.mjs'), '');
    const stub = path.join(home, 'node-stub.sh');
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s" "$PATH"\n', { mode: 0o755 });
    const out = execFileSync(BASH, [SCRIPT], {
      env: { HOME: home, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', RUVNET_NODE_BINARY: stub }, encoding: 'utf8' });
    const parts = out.split(':');
    expect(parts.slice(0, 2)).toEqual([path.join(home, '.local/bin'), path.join(home, '.npm-global/bin')]);
    expect(parts).toContain('/usr/bin');
  });
});
