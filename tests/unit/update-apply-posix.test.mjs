// update-apply.test.mjs — the Stable Spine engine (ADR-023). Every test runs the REAL
// scripts/update-apply.mjs as a subprocess against a temp RUVNET_BRAIN_HOME — no mocks of the
// engine itself. Windows-safe by design (no symlinks anywhere), so no win32 skip.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'update-apply.mjs');

let HOME_DIR;
const run = (...args) => spawnSync(process.execPath, [ENGINE, ...args], {
  encoding: 'utf8',
  env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: '' },
});
const active = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'active.json'), 'utf8')); } catch { return null; } };

/** A minimal valid plugin payload: scripts/ with one good sh + one good mjs, parseable hooks.json. */
function makePayload(version, { badScript = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spine-payload-${version}-`));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.sh'), '#!/bin/bash\necho ok\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.mjs'), 'console.log("ok");\n');
  // The broken fixture is a .mjs, not a .sh: node --check gates on EVERY platform, so the
  // gate-refusal test proves refusal on Windows too (bash -n only runs where /bin/bash exists).
  if (badScript) fs.writeFileSync(path.join(dir, 'scripts', 'broken.mjs'), 'const = broken syntax here(\n');
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ruvnet-brain', version }));
  return dir;
}

beforeEach(() => { HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-')); });
afterEach(() => { fs.rmSync(HOME_DIR, { recursive: true, force: true }); });

describe('update-apply POSIX payload safety', () => {
  beforeEach(() => { HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-posix-home-')); });
  afterEach(() => { fs.rmSync(HOME_DIR, { recursive: true, force: true }); });
  it('rejects payload symlinks instead of copying files from outside the payload', (ctx) => {
    if (process.platform === 'win32') return ctx.skip();
    const payload = makePayload('9.9.1-test');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'must-not-enter-generation');
    fs.symlinkSync(secret, path.join(payload, 'scripts', 'outside-link.txt'));
    const r = run('--from-dir', payload);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/payload contains a symbolic link/);
    expect(active()).toBe(null);
    expect(fs.existsSync(path.join(HOME_DIR, 'versions', '9.9.1-test', 'scripts', 'outside-link.txt'))).toBe(false);
    fs.rmSync(payload, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

});
