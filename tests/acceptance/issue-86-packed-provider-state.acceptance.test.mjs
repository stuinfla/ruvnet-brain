import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { consoleFixtureEnvironment } from '../helpers/console-fixture-environment.mjs';

// Issue #86 crossed two release boundaries that source-checkout tests cannot cover: npm's packed
// allow-list and the installer's persistent `.console-runtime` transaction. Keep both boundaries
// real here; the only synthetic inputs are unmistakable dummy credentials.
const ROOT = path.resolve(import.meta.dirname, '../..');
const secrets = {
  OPENAI_API_KEY: 'issue86-openai-secret-value',
  GOOGLE_API_KEY: 'issue86-google-secret-value',
  GEMINI_API_KEY: 'issue86-gemini-secret-value',
};
const temps = [];
const children = new Set();
let runtimeScript;
let runtimeKb;

function temporary(prefix) {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(value);
  return value;
}

function scrubbedEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) delete env[key];
  }
  for (const key of [
    'RUVNET_MODEL_CATALOG',
    'RUVNET_BRAIN_COMPLETE_SOURCE',
    ...Object.keys(secrets),
  ]) delete env[key];
  return env;
}

function runtimeEnvironment(root, port, credentials = {}) {
  return {
    ...consoleFixtureEnvironment(root, {
      baseEnv: scrubbedEnvironment(),
      extras: {
        CONSOLE_PORT: String(port),
        RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1',
      },
    }),
    HOME: root,
    USERPROFILE: root,
    RUVNET_BRAIN_KB: runtimeKb,
    ...credentials,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForState(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (response.ok) return response.json();
    } catch { /* server not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the staged Console /api/state');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    let force;
    let deadline;
    const done = () => {
      clearTimeout(force);
      clearTimeout(deadline);
      resolve();
    };
    child.once('exit', done);
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    deadline = setTimeout(() => {
      reject(new Error(`Console process ${child.pid} did not exit after SIGKILL`));
    }, 5_000);
  });
}

beforeAll(async () => {
  const artifactRoot = temporary('brain-issue86-packed-');
  const packDir = path.join(artifactRoot, 'pack');
  const installRoot = path.join(artifactRoot, 'install');
  fs.mkdirSync(packDir, { recursive: true });
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--pack-destination', packDir,
  ], { cwd: ROOT, encoding: 'utf8' }));
  const tarball = path.join(packDir, packed[0].filename);
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, tarball,
  ], { cwd: artifactRoot, encoding: 'utf8' });

  const installedPackage = path.join(installRoot, 'node_modules', 'ruvnet-brain');
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  const installedEntrypoint = path.join(installedPackage, 'bin', 'install.mjs');
  const installer = await import(`${pathToFileURL(installedEntrypoint).href}?issue86=${Date.now()}`);
  delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
  runtimeKb = path.join(installRoot, 'kb');
  runtimeScript = installer.installConsoleRuntime(runtimeKb, installedPackage);
}, 120_000);

afterAll(async () => {
  await Promise.all([...children].map(stopChild));
  for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true });
  delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
});

describe('issue #86 packed and staged provider availability', () => {
  it('serves OpenAI and both Google aliases as booleans without exposing credentials', async () => {
    const cases = [
      {
        name: 'OpenAI', credentials: { OPENAI_API_KEY: secrets.OPENAI_API_KEY },
        want: { openai: true, google: false },
      },
      {
        name: 'Google', credentials: { GOOGLE_API_KEY: secrets.GOOGLE_API_KEY },
        want: { openai: false, google: true },
      },
      {
        name: 'Gemini alias', credentials: { GEMINI_API_KEY: secrets.GEMINI_API_KEY },
        want: { openai: false, google: true },
      },
      { name: 'unset', credentials: {}, want: { openai: false, google: false } },
    ];

    for (const scenario of cases) {
      const home = temporary(`brain-issue86-${scenario.name.toLowerCase().replaceAll(' ', '-')}-`);
      const project = path.join(home, 'project');
      fs.mkdirSync(project, { recursive: true });
      const port = await freePort();
      const env = runtimeEnvironment(home, port, scenario.credentials);
      const warm = spawnSync(process.execPath, [runtimeScript, '--print-state'], {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      expect(warm.status, `${scenario.name} cache warm failed: ${warm.stderr}`).toBe(0);

      const child = spawn(process.execPath, [runtimeScript, '--serve'], {
        cwd: project,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      child.once('exit', () => children.delete(child));
      let state;
      try {
        state = await waitForState(port);
      } finally {
        await stopChild(child);
      }

      const router = state.sections.savings.routerEngine;
      expect(router.providerCatalog, scenario.name).toMatchObject({ status: 'ok' });
      expect(router.keys, scenario.name).toMatchObject(scenario.want);
      expect(router.subscriptions.openai.apiKey, scenario.name).toBe(scenario.want.openai);
      expect(router.subscriptions.google.apiKey, scenario.name).toBe(scenario.want.google);
      const serialized = JSON.stringify(state);
      for (const value of Object.values(secrets)) expect(serialized).not.toContain(value);
    }
  }, 120_000);
});
