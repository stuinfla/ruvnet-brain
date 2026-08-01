import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const CONSOLE = path.join(REPO, 'scripts', 'onboarding-console.mjs');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const homes = [];
const children = new Set();

function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-console-runtime-'));
  homes.push(home);
  return home;
}

function receiptFile(home, cwd = REPO) {
  const scopeId = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 24);
  return path.join(home, '.cache', 'ruvnet-brain', 'console-instances', `${scopeId}.json`);
}

function candidateIdentity(port) {
  return {
    product: 'ruvnet-brain-console',
    schema: 1,
    apiContract: 1,
    pid: process.pid,
    port,
    startedAt: '2026-08-01T18:00:00.000Z',
    scope: path.resolve(REPO),
    scriptRealpath: fs.realpathSync(CONSOLE),
    runtimeVersion: PACKAGE_VERSION,
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(CONSOLE)).digest('hex'),
  };
}

function runStatus(home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONSOLE, '--runtime-status'], {
      cwd: REPO,
      env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withRuntimeServer(identityForPort, fn) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/runtime') { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(identityForPort(server.address().port)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function shutdownConsole(port, controlToken) {
  return fetch(`http://127.0.0.1:${port}/api/runtime/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ controlToken }),
  });
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  children.clear();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startConsole(home, port) {
  const child = spawn(process.execPath, [CONSOLE, '--serve'], {
    cwd: REPO,
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
  child.on('close', () => children.delete(child));
  return child;
}

async function waitFor(check, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for Console runtime');
}

describe('Brain Console runtime lifecycle', () => {
  it('reports that no owned Console instance is running without starting one', async () => {
    const home = isolatedHome();
    const port = await freePort();
    const run = spawnSync(process.execPath, [CONSOLE, '--runtime-status'], {
      cwd: REPO,
      env: { ...process.env, HOME: home, USERPROFILE: home, CONSOLE_PORT: String(port), RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('"state":"not-running"');
    expect(fs.existsSync(path.join(home, '.cache', 'ruvnet-brain', 'console-instances'))).toBe(false);
  });

  it('accepts a live instance only when its receipt and exact candidate identity agree', async () => {
    const home = isolatedHome();
    await withRuntimeServer(candidateIdentity, async (port) => {
      const receipt = { ...candidateIdentity(port), controlToken: 'a'.repeat(48) };
      fs.mkdirSync(path.dirname(receiptFile(home)), { recursive: true });
      fs.writeFileSync(receiptFile(home), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

      const run = await runStatus(home);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(JSON.parse(run.stdout)).toMatchObject({ state: 'current', port });
    });
  });

  it('rejects the mixed-generation mutant when the live router digest differs from the candidate', async () => {
    const home = isolatedHome();
    await withRuntimeServer((port) => ({ ...candidateIdentity(port), sourceSha256: 'b'.repeat(64) }), async (port) => {
      const receipt = { ...candidateIdentity(port), sourceSha256: 'b'.repeat(64), controlToken: 'a'.repeat(48) };
      fs.mkdirSync(path.dirname(receiptFile(home)), { recursive: true });
      fs.writeFileSync(receiptFile(home), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

      const run = await runStatus(home);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ state: 'stale-running', port });
    });
  });

  it('writes a private receipt, exposes a non-secret identity, and reuses the exact live instance', async () => {
    const home = isolatedHome();
    const port = await freePort();
    const first = startConsole(home, port);
    const runtime = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime`);
        return response.ok ? response.json() : null;
      } catch { return null; }
    });

    expect(runtime).toMatchObject({
      product: 'ruvnet-brain-console',
      schema: 1,
      apiContract: 1,
      pid: first.pid,
      port,
      scope: REPO,
    });
    expect(runtime).not.toHaveProperty('controlToken');

    const file = receiptFile(home);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(receipt).toMatchObject(runtime);
    expect(receipt.controlToken).toMatch(/^[a-f0-9]{48}$/);

    const second = startConsole(home, port);
    const secondExit = await new Promise((resolve) => second.on('close', (status) => resolve(status)));
    expect(secondExit).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/api/runtime`).then((r) => r.json())).pid).toBe(first.pid);

    const denied = await shutdownConsole(port, 'f'.repeat(48));
    expect(denied.status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/runtime`).then((r) => r.json())).pid).toBe(first.pid);

    const stopped = await fetch(`http://127.0.0.1:${port}/api/runtime/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controlToken: receipt.controlToken }),
    });
    expect(stopped.status).toBe(202);
    await waitFor(() => first.exitCode !== null);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('gracefully replaces a receipt-proven stale generation on the same port', async () => {
    const home = isolatedHome();
    const controlToken = 'c'.repeat(48);
    let shutdowns = 0;
    const staleServer = http.createServer(async (req, res) => {
      const port = staleServer.address().port;
      const stale = { ...candidateIdentity(port), sourceSha256: 'b'.repeat(64) };
      if (req.method === 'GET' && req.url === '/api/runtime') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(stale));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/runtime/shutdown') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (JSON.parse(body).controlToken !== controlToken) { res.writeHead(403); res.end(); return; }
        shutdowns += 1;
        res.writeHead(202); res.end();
        setImmediate(() => staleServer.close());
        return;
      }
      res.writeHead(404); res.end('not found');
    });
    await new Promise((resolve) => staleServer.listen(0, '127.0.0.1', resolve));
    const port = staleServer.address().port;
    const staleReceipt = { ...candidateIdentity(port), sourceSha256: 'b'.repeat(64), controlToken };
    fs.mkdirSync(path.dirname(receiptFile(home)), { recursive: true });
    fs.writeFileSync(receiptFile(home), `${JSON.stringify(staleReceipt)}\n`, { mode: 0o600 });

    const current = startConsole(home, port);
    const live = await waitFor(async () => {
      try {
        const value = await fetch(`http://127.0.0.1:${port}/api/runtime`).then((r) => r.json());
        return value.sourceSha256 === candidateIdentity(port).sourceSha256 ? value : null;
      } catch { return null; }
    });
    expect(shutdowns).toBe(1);
    expect(live.pid).toBe(current.pid);
    const receipt = JSON.parse(fs.readFileSync(receiptFile(home), 'utf8'));
    await shutdownConsole(port, receipt.controlToken);
    await waitFor(() => current.exitCode !== null);
  });

  it('never kills a foreign branded listener and reuses the current random-port instance', async () => {
    const home = isolatedHome();
    let foreignRequests = 0;
    const foreign = http.createServer((req, res) => {
      foreignRequests += 1;
      if (req.url === '/') { res.writeHead(200); res.end('<title>RuvNet Brain</title>'); return; }
      res.writeHead(404); res.end('not found');
    });
    await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const occupied = foreign.address().port;

    const before = await runStatus(home, { CONSOLE_PORT: String(occupied) });
    expect(JSON.parse(before.stdout)).toMatchObject({ state: 'foreign-port', port: occupied });

    const first = startConsole(home, occupied);
    const receipt = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(receiptFile(home), 'utf8')); } catch { return null; }
    });
    expect(receipt.port).not.toBe(occupied);
    expect(foreign.listening).toBe(true);
    expect((await fetch(`http://127.0.0.1:${occupied}/`)).status).toBe(200);

    const second = startConsole(home, occupied);
    expect(await new Promise((resolve) => second.on('close', resolve))).toBe(0);
    expect((await fetch(`http://127.0.0.1:${receipt.port}/api/runtime`).then((r) => r.json())).pid).toBe(first.pid);
    expect(foreign.listening).toBe(true);
    expect(foreignRequests).toBeGreaterThan(0);

    await shutdownConsole(receipt.port, receipt.controlToken);
    await waitFor(() => first.exitCode !== null);
    await new Promise((resolve) => foreign.close(resolve));
  });
});
