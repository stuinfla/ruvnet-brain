import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONSOLE_RUNTIME_SURFACE, consoleRuntimeDigest } from '../../scripts/console-runtime-identity.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const roots = [];
const required = [
  'kb/refresh-run.mjs',
  'kb/lifecycle-evidence-retention.mjs',
  'kb/model-requirements.mjs',
  'kb/zip-extract.mjs',
];

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-import-closure-'));
  roots.push(root);
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  for (const relative of CONSOLE_RUNTIME_SURFACE) {
    const target = path.join(runtime, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(repo, relative), target, { recursive: true });
  }
  return { runtime, home };
}

function importStaged({ runtime, home }) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    await import('./bin/install.mjs');
    await import('./scripts/onboarding-console.mjs');
    // The installer loads this helper dynamically only when extracting an archive.
    const { extractZip } = await import('./kb/zip-extract.mjs');
    if (typeof extractZip !== 'function') throw new Error('missing archive helper');
    console.log('staged-import-ok');
  `], {
    cwd: runtime, encoding: 'utf8', timeout: 30_000, shell: false,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home,
      npm_config_cache: path.join(home, '..', 'npm-cache'), npm_config_offline: 'true',
      RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_IMPORT_ONLY: '1' },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('exact staged Console import closure', () => {
  it('imports the installer, Console, and dynamic archive helper without source-tree fallback or host activation', () => {
    const fixture = stage();
    const result = importStaged(fixture);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged-import-ok');
    expect(fs.readdirSync(fixture.home)).toEqual([]);
    expect(fs.existsSync(path.join(fixture.runtime, 'node_modules'))).toBe(false);
  });

  it.each(required)('binds %s to the generation and fails actual import if omitted', (relative) => {
    const fixture = stage();
    expect(CONSOLE_RUNTIME_SURFACE).toContain(relative);
    const before = consoleRuntimeDigest(fixture.runtime);
    fs.appendFileSync(path.join(fixture.runtime, relative), '\n// changed candidate bytes\n');
    expect(consoleRuntimeDigest(fixture.runtime)).not.toBe(before);
    fs.unlinkSync(path.join(fixture.runtime, relative));
    const result = importStaged(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).toContain(path.basename(relative));
    expect(fs.readdirSync(fixture.home)).toEqual([]);
  });
});
