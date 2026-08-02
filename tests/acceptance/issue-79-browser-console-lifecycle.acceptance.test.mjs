import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

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

function start(script, home, cwd, port) {
  const child = spawn(process.execPath, [script, '--serve'], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CONSOLE_PORT: String(port),
      RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
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
    const aRoot = path.join(root, 'candidate-a');
    const bRoot = path.join(root, 'candidate-b');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.cpSync(ROOT, aRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules`) });
    fs.cpSync(ROOT, bRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules`) });
    const aScript = path.join(aRoot, 'scripts', 'onboarding-console.mjs');
    const bScript = path.join(bRoot, 'scripts', 'onboarding-console.mjs');
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

      const second = start(bScript, home, cwd, port);
      const secondIdentity = await waitFor(async () => {
        try {
          const value = await page.evaluate(async () => (await fetch('/api/runtime')).json());
          return value.pid === second.pid ? value : null;
        } catch { return null; }
      });
      expect(secondIdentity.pid).toBe(second.pid);
      expect(secondIdentity.sourceSha256).not.toBe(firstIdentity.sourceSha256);
      expect(await page.evaluate(async () => (await fetch('/api/capabilities')).status)).toBe(200);
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect(await page.title()).toMatch(/RuvNet Brain/i);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
