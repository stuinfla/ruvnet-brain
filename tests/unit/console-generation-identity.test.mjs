// Issue #79 — the Brain Console reused a stale detached server after updates and host restarts.
//
// The launcher already refuses a listener whose identity differs from the candidate's. The identity
// itself was the hole: `sourceSha256` digested ONE file, scripts/onboarding-console.mjs, while the
// runtime the server executes and serves is a whole surface of imported modules plus the frontend.
// An ordinary update — a changed console-engine.mjs, a changed console/app.js — left the entrypoint
// bytes untouched, so candidate B was indistinguishable from the A it replaced, the launcher printed
// "already running", and the reporter got a post-update page in front of a pre-update router.
//
// The boundary here is the real one: a detached server started from a path, that path's bytes
// atomically replaced underneath it by the installer, and a SEPARATE later process — the restarted
// host session — deciding what is running.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { beginConsoleRuntimeTransaction, installConsoleRuntime } from '../../bin/install.mjs';
import { consoleRuntimeDigest } from '../../scripts/console-runtime-identity.mjs';
import { consoleFixtureEnvironment } from '../helpers/console-fixture-environment.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const temps = [];
const children = new Set();

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fixtureEnv(home, port) {
  return consoleFixtureEnvironment(home, {
    extras: { CONSOLE_PORT: String(port), RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1' },
  });
}

function serve(script, home, cwd, port) {
  const child = spawn(process.execPath, [script, '--serve'], {
    cwd, env: fixtureEnv(home, port), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (chunk) => { child.log += chunk; });
  child.stderr.on('data', (chunk) => { child.log += chunk; });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function runtimeStatus(script, home, cwd, port) {
  const run = spawnSync(process.execPath, [script, '--runtime-status'], {
    cwd, env: fixtureEnv(home, port), encoding: 'utf8', timeout: 20_000,
  });
  if (run.status !== 0) throw new Error(`--runtime-status failed: ${run.stderr || run.status}`);
  return JSON.parse(run.stdout);
}

async function waitFor(check, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the Console runtime');
}

const liveIdentity = (port) => waitFor(async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime`);
    return response.ok ? response.json() : null;
  } catch { return null; }
});

/**
 * A staged runtime is a valid candidate source — every surface path has the same relative location on
 * both sides — so candidates are built from the shipped file manifest rather than a fixture's own list.
 */
function candidateFrom(runtime, mutate = () => {}) {
  const source = path.join(tempDir('brain-generation-candidate-'), 'source');
  fs.cpSync(runtime, source, { recursive: true });
  mutate(source);
  return source;
}

afterEach(async () => {
  const live = [...children].filter((child) => child.exitCode === null);
  for (const child of live) child.kill('SIGTERM');
  await Promise.all(live.map((child) => new Promise((resolve) => {
    const hard = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('exit', () => { clearTimeout(hard); resolve(); });
  })));
  children.clear();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #79 Console generation identity', () => {
  it('gives two candidates different identities when only an imported module changes', () => {
    const seed = tempDir('brain-generation-seed-');
    installConsoleRuntime(seed, REPO);
    const a = candidateFrom(path.join(seed, '.console-runtime'));
    // The reported failure exactly: the router's behaviour changes and the frontend changes, while
    // scripts/onboarding-console.mjs — the file the old identity digested — does not.
    const b = candidateFrom(a, (source) => {
      fs.appendFileSync(path.join(source, 'scripts', 'console-engine.mjs'), '\nexport const CANDIDATE_B = true;\n');
      fs.appendFileSync(path.join(source, 'console', 'app.js'), '\n/* candidate B */\n');
    });
    expect(fs.readFileSync(path.join(a, 'scripts', 'onboarding-console.mjs')))
      .toEqual(fs.readFileSync(path.join(b, 'scripts', 'onboarding-console.mjs')));

    const first = beginConsoleRuntimeTransaction(tempDir('brain-generation-a-'), a);
    const second = beginConsoleRuntimeTransaction(tempDir('brain-generation-b-'), b);
    try {
      expect(first.identity.sourceSha256).not.toBe(second.identity.sourceSha256);
    } finally {
      first.rollback();
      second.rollback();
    }
  });

  it('replaces a detached server whose runtime was updated underneath it, with no host restart required', async () => {
    const root = tempDir('brain-generation-boundary-');
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const cache = path.join(root, 'cache');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    const script = installConsoleRuntime(cache, REPO);
    const runtime = path.join(cache, '.console-runtime');
    const port = await freePort();
    const detached = serve(script, home, cwd, port);
    const beforeUpdate = await liveIdentity(port);

    // The installer's staged identity and the server's self-reported identity are the same fact.
    expect(beforeUpdate.pid).toBe(detached.pid);
    expect(beforeUpdate.sourceSha256)
      .toBe(JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-identity.json'), 'utf8')).sourceSha256);
    expect(runtimeStatus(script, home, cwd, port).state).toBe('current');

    // THE UPDATE: the same installed path, atomically replaced with a candidate whose entrypoint is
    // byte-identical. The detached server keeps its pre-update modules in memory and never notices.
    const next = candidateFrom(runtime, (source) => {
      fs.appendFileSync(path.join(source, 'scripts', 'console-engine.mjs'), '\nexport const CANDIDATE_B = true;\n');
      fs.appendFileSync(path.join(source, 'console', 'app.js'), '\n/* candidate B */\n');
    });
    installConsoleRuntime(cache, next);
    expect(fs.realpathSync(script)).toBe(fs.realpathSync(path.join(runtime, 'scripts', 'onboarding-console.mjs')));
    expect(detached.exitCode).toBe(null);
    expect((await liveIdentity(port)).pid).toBe(detached.pid);

    // THE RESTART: a brand new process, from the same installed path, deciding what is running.
    expect(runtimeStatus(script, home, cwd, port).state).toBe('stale-running');

    const replacement = serve(script, home, cwd, port);
    const afterUpdate = await waitFor(async () => {
      const value = await liveIdentity(port).catch(() => null);
      return value && value.pid === replacement.pid ? value : null;
    });
    expect(afterUpdate.pid).not.toBe(beforeUpdate.pid);
    expect(afterUpdate.sourceSha256).not.toBe(beforeUpdate.sourceSha256);
    expect(afterUpdate.sourceSha256).toBe(consoleRuntimeDigest(runtime));
    await waitFor(() => detached.exitCode !== null);
    expect(runtimeStatus(script, home, cwd, port).state).toBe('current');
  }, 90_000);
});
