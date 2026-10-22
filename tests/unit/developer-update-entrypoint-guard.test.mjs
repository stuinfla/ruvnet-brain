// tests/unit/developer-update-entrypoint-guard.test.mjs
//
// REPRODUCED LIVE 2026-10-22 (Dream Cycle, enforcement-integrity): plugin/scripts/developer-update.mjs's
// own CLI guard compared path.resolve(process.argv[1]) against import.meta.url directly — the exact
// defect class tests/unit/entrypoint-symlink.test.mjs documents for kb/forge-ask.mjs et al. Invoked
// through a symlink, the guard disagreed, developerUpdateCli() never ran, and the process exited 0
// having printed nothing. scripts/console-suite-update.mjs's RNBC "update all tools" adapter spawns
// this exact file directly (`spawnChild(node, [runner, '--apply'], ...)`), so a silent no-op here is
// not theoretical — it is the nightly suite-update's own entry point.
//
// `--help` is used deliberately: it is the one invocation that cannot mutate anything (no lock
// acquired, no npm/install calls), so this test is safe to run for real rather than mocked.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = path.join(ROOT, 'plugin/scripts/developer-update.mjs');

describe('plugin/scripts/developer-update.mjs entry-point guard', () => {
  it('runs the CLI when invoked directly', () => {
    const r = spawnSync(process.execPath, [TARGET, '--help'], { encoding: 'utf8', timeout: 20000 });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain('Usage: ruvnet-brain-update');
  });

  it('still runs the CLI when invoked through a symlink (npm bin shim, Homebrew-style install)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-developer-update-symlink-'));
    const link = path.join(dir, 'developer-update.mjs');
    try {
      fs.symlinkSync(TARGET, link);
      const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 20000 });
      expect(r.error, `spawn failed: ${r.error && r.error.message}`).toBeUndefined();
      expect(
        r.stdout,
        'a symlinked invocation produced NOTHING — the guard silently skipped developerUpdateCli(), ' +
          'indistinguishable from a successful run that printed nothing',
      ).toContain('Usage: ruvnet-brain-update');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
