import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { installConsoleRuntime } from '../../bin/install.mjs';
import { consoleFixtureEnvironment } from '../helpers/console-fixture-environment.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = path.join(ROOT, 'scripts', 'onboarding-console.mjs');
const children = new Set();
const temps = [];

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runtimeEnv(home, port) {
  return consoleFixtureEnvironment(home, {
    extras: {
      CONSOLE_PORT: String(port),
      RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1',
    },
  });
}

function start(script, home, cwd, port) {
  const child = spawn(process.execPath, [script, '--serve'], {
    cwd,
    env: runtimeEnv(home, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.testStdout = '';
  child.testStderr = '';
  child.stdout.on('data', (chunk) => { child.testStdout += String(chunk); });
  child.stderr.on('data', (chunk) => { child.testStderr += String(chunk); });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for Console lifecycle transition');
}

afterEach(async () => {
  const live = [...children].filter((child) => child.exitCode === null);
  for (const child of live) child.kill('SIGTERM');
  await Promise.all(live.map((child) => new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    const failed = setTimeout(() => reject(new Error(`Console child ${child.pid} did not exit after SIGKILL`)), 4_000);
    child.once('exit', () => { clearTimeout(hardKill); clearTimeout(failed); resolve(); });
  })));
  children.clear();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #79 installed browser lifecycle', () => {
  const chrome = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((candidate) => candidate && fs.existsSync(candidate));
  const test = chrome ? it : it.skip;

  test('a real browser reconnects from owned candidate A to candidate B on the same URL', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue79-browser-'));
    temps.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    // Build both candidates through the same transaction and file manifest the installer uses.
    // This keeps the acceptance boundary tied to the shipped runtime instead of a second fixture list.
    const aScript = installConsoleRuntime(path.join(root, 'candidate-a-cache'), ROOT);
    const bScript = installConsoleRuntime(path.join(root, 'candidate-b-cache'), ROOT);
    fs.appendFileSync(aScript, '\n// issue-79 candidate A digest\n');
    const port = await freePort();
    const first = start(aScript, home, cwd, port);

    const firstIdentity = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime`);
        return response.ok ? response.json() : null;
      } catch { return null; }
    });
    expect(firstIdentity.pid).toBe(first.pid);

    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      expect(await page.title()).toMatch(/RuvNet Brain/i);

      const statusProbe = spawnSync(process.execPath, [bScript, '--runtime-status'], {
        cwd,
        env: runtimeEnv(home, port),
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(statusProbe.status, statusProbe.stderr).toBe(0);
      expect(JSON.parse(statusProbe.stdout).state).toBe('stale-running');

      const second = start(bScript, home, cwd, port);
      let secondIdentity;
      try {
        secondIdentity = await waitFor(async () => {
          try {
            const value = await page.evaluate(async () => (await fetch('/api/runtime')).json());
            return value.pid === second.pid ? value : null;
          } catch { return null; }
        });
      } catch (error) {
        throw new Error(`${error.message}\nfirst stdout: ${first.testStdout}\nfirst stderr: ${first.testStderr}\nsecond stdout: ${second.testStdout}\nsecond stderr: ${second.testStderr}`);
      }
      expect(secondIdentity.pid).toBe(second.pid);
      expect(secondIdentity.runtimeVersion).toBe('4.0.7');
      expect(secondIdentity.sourceSha256).not.toBe(firstIdentity.sourceSha256);
      expect(await page.evaluate(async () => (await fetch('/api/capabilities')).status)).toBe(200);
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect(await page.title()).toMatch(/RuvNet Brain/i);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
