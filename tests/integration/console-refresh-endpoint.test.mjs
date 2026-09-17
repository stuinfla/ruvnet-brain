import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENTRY = path.join(ROOT, 'scripts/onboarding-console.mjs');
let child;
let port;
let token;
let project;
let consoleRoot;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    server.once('error', reject);
  });
}

function waitForUrl() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`console did not start: ${output}`)), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', reject);
  });
}

beforeAll(async () => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-refresh-')));
  consoleRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-refresh-home-')));
  const requestedPort = await freePort();
  child = spawn(process.execPath, [ENTRY, '--serve'], {
    cwd: project,
    env: { ...process.env, NODE_ENV: 'test', CONSOLE_PORT: String(requestedPort), RUVNET_CONSOLE_ROOT: consoleRoot, RUVNET_CONSOLE_TEST_TOKEN: 'a'.repeat(48), RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await waitForUrl();
  const receiptDir = path.join(consoleRoot, '.cache', 'ruvnet-brain', 'console-instances');
  const receipt = fs.readdirSync(receiptDir).map((name) => path.join(receiptDir, name))
    .map((file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } })
    .find((value) => value?.port === port && value?.scope === project);
  token = 'a'.repeat(48);
  expect(receipt?.port).toBe(port);
});

afterAll(() => { try { child?.kill('SIGTERM'); } catch {} });

describe('refresh endpoint and client contract', () => {
  it('returns an explicit disabled state that the client can settle', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, started: false, refreshing: false, refresh: { status: 'disabled' } });
    const app = fs.readFileSync(path.join(ROOT, 'console/app.js'), 'utf8');
    expect(app).toContain("body.refresh?.status === 'failed'");
    expect(app).toContain("body.refresh?.status === 'already-running'");
  });
});
