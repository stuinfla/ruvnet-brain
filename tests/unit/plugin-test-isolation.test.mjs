import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('plugin hook test subprocesses isolate ambient homes and cache selectors', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-test-isolation-'));
  try {
    const preload = path.join(fixture, 'guard.cjs');
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
for (const name of ['spawnSync', 'spawn']) {
  const original = cp[name];
  cp[name] = (command, args, options = {}) => {
    const env = options.env;
    if (!env || env.HOME === process.env.HOME || env.USERPROFILE !== env.HOME
      || !env.XDG_CACHE_HOME.startsWith(env.HOME + path.sep)
      || !env.RUVNET_BRAIN_HOME.startsWith(env.HOME + path.sep)
      || !options.cwd || options.cwd === process.cwd()) throw new Error('UNISOLATED TEST CHILD');
    fs.appendFileSync(process.env.TEST_CHILD_LOG, JSON.stringify({ home: env.HOME, cwd: options.cwd }) + '\\n');
    return original(command, args, options);
  };
}
require('node:module').syncBuiltinESMExports();
`);
    const log = path.join(fixture, 'children.jsonl');
    const script = fileURLToPath(new URL('../../plugin/test/run-tests.mjs', import.meta.url));
    const r = spawnSync(process.execPath, ['--require', preload, script], {
      cwd: fixture, encoding: 'utf8', timeout: 45000,
      env: { ...process.env, NODE_OPTIONS: '', HOME: fixture, USERPROFILE: fixture,
        XDG_CACHE_HOME: path.join(fixture, 'ambient-cache'), RUVNET_BRAIN_HOME: path.join(fixture, 'ambient-brain'),
        RUVNET_BRAIN_KB: path.join(fixture, 'explicit-absent-corpus'), REQUIRE_BRAIN: '0', TEST_CHILD_LOG: log },
    });
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toContain('UNISOLATED TEST CHILD');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(r.stdout).toContain('CORE CAPABILITY BATTERY SKIPPED');
    for (const { home } of calls) expect(fs.existsSync(home), 'owned test homes cleaned').toBe(false);
    expect(fs.existsSync(path.join(fixture, 'ambient-cache'))).toBe(false);
    expect(fs.existsSync(path.join(fixture, 'ambient-brain'))).toBe(false);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}, 50000);
