import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = path.join(ROOT, 'plugin');
const SHIM = path.join(PLUGIN, 'scripts', 'hook-shim.mjs');

function fire(prompt) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ground-fast-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ground-cwd-'));
  const started = Date.now();
  const result = spawnSync(process.execPath, [SHIM, 'ground-ruvnet'], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'),
      CLAUDE_PLUGIN_ROOT: PLUGIN,
    },
    input: JSON.stringify({ prompt }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { ...result, elapsedMs: Date.now() - started };
}

describe('hook-shim ground quiet-prompt classifier', () => {
  it('keeps a no-store unrelated prompt quiet within the fast-path budget', () => {
    const r = fire('selfcheck probe');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.elapsedMs).toBeLessThan(1000);
  });

  it('forwards relevant input to the established grounding body', () => {
    const r = fire('fix the ruflo pipeline');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[RuvNet Brain — ground before you assert]');
    expect(r.stdout).toContain('search_ruvnet');
  });
});
