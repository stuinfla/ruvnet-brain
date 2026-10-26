// codex-shared-host-refresh.test.mjs — #492 (b). A running shared Codex app-server (the managed daemon the TUI attaches
// to) keeps the plugin declarations it parsed before the Brain changed the installed plugin from another process:
// openai/codex rust-v0.164.0 codex-rs/core-plugins/src/manager.rs LoadedPluginsCache::get() drops a cached entry only
// when the active plugin ROOT changes. Measured 2026-10-25 on codex-cli 0.164.0 in an isolated CODEX_HOME: after an
// in-place change the daemon's hooks/list still showed the old SessionEnd declaration (3s) while a fresh server and the
// disk showed the new one (2s); a no-edit config/batchWrite with reloadUserConfig made the daemon agree.
// The server here is a real WebSocket endpoint on a real Unix socket behind Codex's rendezvous symlink.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { refreshSharedCodexAppServer } from '../../scripts/codex-hook-trust-reconcile.mjs';
import * as installer from '../../bin/install.mjs';

const { refreshCodexSharedHost } = installer;

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

/** A fake shared app-server: answers like Codex and records every request it receives. */
async function sharedServer({ rejectWrite = false } = {}) {
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-')));
  const sockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')));
  const socket = path.join(sockDir, 's');
  const received = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    received.push({ path: req.url });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)); received.push(msg);
      if (msg.id === undefined) return;
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === 'initialize') reply({ userAgent: 'codex' });
      else if (msg.method === 'config/read') reply({ config: {}, layers: [{ name: { type: 'user', file: path.join(codexHome, 'config.toml') }, version: 'sha256:v1', config: {} }] });
      else if (msg.method === 'config/batchWrite') {
        if (rejectWrite) ws.send(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'Configuration was modified since last read. secret=hunter2' } }));
        else reply({ status: 'ok', version: 'sha256:v1' });
      }
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  fs.mkdirSync(path.join(codexHome, 'app-server-control'));
  fs.symlinkSync(socket, path.join(codexHome, 'app-server-control', 'app-server-control.sock'));
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    fs.rmSync(codexHome, { recursive: true, force: true }); fs.rmSync(sockDir, { recursive: true, force: true });
  });
  return { codexHome, received };
}

describe('refreshSharedCodexAppServer — reload a running Codex host without changing anything', () => {
  it('sends Codex\'s own no-edit reload, version-checked, and grants nothing', async () => {
    const { codexHome, received } = await sharedServer();
    const result = await refreshSharedCodexAppServer({ codexHome });
    expect(result).toEqual({ state: 'refreshed', changed: false, approvalsGranted: 0 });
    expect(received[0].path).toBe('/'); // never the daemon's /daemon/shutdown endpoint
    expect(received.slice(1).map((m) => m.method)).toEqual(['initialize', 'initialized', 'config/read', 'config/batchWrite']);
    expect(received.at(-1).params).toEqual({ filePath: path.join(codexHome, 'config.toml'), expectedVersion: 'sha256:v1', reloadUserConfig: true, edits: [] });
  });
  it('does nothing when no shared server is listening, and never starts one', async () => {
    const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-')));
    cleanups.push(() => fs.rmSync(codexHome, { recursive: true, force: true }));
    expect(await refreshSharedCodexAppServer({ codexHome })).toEqual({ state: 'no-shared-server', changed: false });
    expect(fs.existsSync(path.join(codexHome, 'app-server-control'))).toBe(false);
  });
  // Cross-vendor review F (4.7.21): the deadline started only after the WebSocket opened, so a socket that accepts
  // but never completes the handshake hung the installer forever.
  it('a socket that never completes the WebSocket handshake fails within the deadline and is torn down', async () => {
    const net = await import('node:net');
    const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-')));
    const sockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')));
    const sockets = new Set(); let closed = 0;
    const server = net.createServer((s) => { sockets.add(s); s.resume(); s.on('close', () => { closed += 1; }); }); // accepts, never answers
    await new Promise((resolve) => server.listen(path.join(sockDir, 's'), resolve));
    fs.mkdirSync(path.join(codexHome, 'app-server-control'));
    fs.symlinkSync(path.join(sockDir, 's'), path.join(codexHome, 'app-server-control', 'app-server-control.sock'));
    cleanups.push(async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(() => r())); fs.rmSync(codexHome, { recursive: true, force: true }); fs.rmSync(sockDir, { recursive: true, force: true }); });
    const started = Date.now();
    const outcome = await Promise.race([refreshSharedCodexAppServer({ codexHome, timeoutMs: 300 }),
      new Promise((resolve) => setTimeout(() => resolve({ state: 'HUNG' }), 3000))]);
    expect(outcome).toMatchObject({ state: 'failed', reason: expect.stringMatching(/timed out/) });
    expect(Date.now() - started).toBeLessThan(2500);
    for (let i = 0; i < 40 && closed < sockets.size; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.size).toBe(1);
    expect(closed).toBe(1); // the half-open connection was terminated, not left dangling
  });
  it('reports a refused reload as failed without echoing the native error text', async () => {
    const { codexHome } = await sharedServer({ rejectWrite: true });
    const result = await refreshSharedCodexAppServer({ codexHome });
    expect(result.state).toBe('failed');
    expect(result.reason).not.toMatch(/hunter2/);
  });
});

describe('refreshCodexSharedHost — the installer reloads the host only after it changed what the host sees', () => {
  it('reloads after an install, an update or a trust write; not after a no-op run', async () => {
    const calls = [];
    const refresh = async (args) => { calls.push(args); return { state: 'refreshed', changed: false }; };
    for (const action of ['installed', 'updated']) expect((await refreshCodexSharedHost({ action }, { codexHome: '/x', refresh })).state).toBe('refreshed');
    expect((await refreshCodexSharedHost({ action: 'unchanged', hookTrust: { state: 'registry-verified', changed: true } }, { codexHome: '/x', refresh })).state).toBe('refreshed');
    expect(await refreshCodexSharedHost({ action: 'unchanged', hookTrust: { state: 'unchanged', changed: false } }, { codexHome: '/x', refresh })).toEqual({ state: 'not-needed', changed: false });
    expect(await refreshCodexSharedHost({ action: 'disabled' }, { codexHome: '/x', refresh })).toEqual({ state: 'not-needed', changed: false });
    expect(calls).toEqual([{ codexHome: '/x' }, { codexHome: '/x' }, { codexHome: '/x' }]);
  });
});

describe('the installer says plainly what the reload does to sessions already open (#492 review)', () => {
  it('a reload tells the owner open sessions change now and Brain hooks pause there until re-reviewed in /hooks', () => {
    expect(typeof installer.codexHostRefreshMessage).toBe('function');
    const note = installer.codexHostRefreshMessage({ state: 'refreshed', changed: false, approvalsGranted: 0 });
    expect(note.level).toBe('info');
    expect(note.text).toMatch(/already open pick up the change immediately/);
    expect(note.text).toMatch(/Brain hooks pause in them until you re-review them in \/hooks/);
    expect(note.text).toMatch(/no approval granted, nothing restarted/);
  });
  it('a failed reload warns; no server or nothing to do says nothing', () => {
    expect(installer.codexHostRefreshMessage({ state: 'failed', reason: 'timed out' })).toMatchObject({ level: 'warn', text: expect.stringMatching(/not reloaded \(timed out\)/) });
    for (const state of ['no-shared-server', 'not-needed', 'blocked']) expect(installer.codexHostRefreshMessage({ state })).toBeNull();
  });
});

// Cross-vendor review E (4.7.21): only a fresh install reloaded the running Codex app-server; `--update` (the path
// every existing user takes) converges hosts through syncHostsAfterUpdate and skipped it.
describe('--update reloads the running Codex app-server through the shared host-convergence path', () => {
  const ROOT = path.resolve(import.meta.dirname, '../..');
  const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  it('convergeHostsAfterUpdate refreshes after the Codex plugin changed, and returns what happened', async () => {
    expect(typeof installer.convergeHostsAfterUpdate).toBe('function');
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxu-')));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const kb = path.join(home, 'kb'); fs.mkdirSync(kb, { recursive: true });
    const calls = [];
    const result = await installer.convergeHostsAfterUpdate(kb, {
      sourceRoot: ROOT, brainHome: path.join(home, 'brain'),
      wireClaude: () => ({ host: true, wired: true, version: VERSION }),
      wireCodexHost: () => ({ host: true, wired: true, action: 'unchanged' }),
      wireCodexPlugin: () => ({ action: 'updated', installed: true, enabled: true, version: VERSION }),
      runStableSpine: () => ({ status: 0, error: undefined }),
      refreshHost: async (codexPlugin) => { calls.push(codexPlugin.action); return { state: 'refreshed', changed: false, approvalsGranted: 0 }; },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['updated']);
    expect(result.hostRefresh).toMatchObject({ state: 'refreshed', approvalsGranted: 0 });
  });
  it('the real --update caller (runUpdate) converges only through it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
    const start = src.indexOf('async function runUpdate(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).not.toMatch(/\bsyncHostsAfterUpdate\(/);
    expect(body.match(/await convergeHostsAfterUpdate\(kbDir\)/g)).toHaveLength(2);
  });
});

// Review r2 (4.7.21), owner decision: the unattended nightly (RUVNET_NIGHTLY=1, set by bin/nightly-refresh.mjs) must not
// reload the shared Codex app-server; it records a notice the next SessionStart shows once. Interactive --update reloads.
describe('the unattended nightly defers the Codex reload to a once-only SessionStart notice', () => {
  const ROOT = path.resolve(import.meta.dirname, '../..');
  const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const converge = async (home, extra) => {
    const kb = path.join(home, 'kb'); fs.mkdirSync(kb, { recursive: true });
    const calls = [];
    const result = await installer.convergeHostsAfterUpdate(kb, {
      sourceRoot: ROOT, brainHome: path.join(home, 'brain'),
      wireClaude: () => ({ host: true, wired: true, version: VERSION }),
      wireCodexHost: () => ({ host: true, wired: true, action: 'unchanged' }),
      wireCodexPlugin: () => ({ action: 'updated', installed: true, enabled: true, version: VERSION }),
      runStableSpine: () => ({ status: 0, error: undefined }),
      refreshHost: async (codexPlugin) => { calls.push(codexPlugin.action); return { state: 'refreshed', changed: false, approvalsGranted: 0 }; },
      noticeHome: () => path.join(home, 'brain'),
      ...extra,
    });
    return { result, calls };
  };
  const tmpHome = () => { const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxn-'))); cleanups.push(() => fs.rmSync(h, { recursive: true, force: true })); return h; };

  it('nightly: no reload; a notice is recorded and the next SessionStart shows it exactly once', async () => {
    const home = tmpHome();
    const { result, calls } = await converge(home, { unattended: true });
    expect(calls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.hostRefresh).toMatchObject({ state: 'deferred-unattended', noticeRecorded: true });
    const { stableSpine } = await import('../../plugin/scripts/session-start-update-plane.mjs');
    const brain = path.join(home, 'brain');
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ version: VERSION }));
    const say = () => { const out = []; stableSpine({ env: {}, hookDir: '/nonexistent', stateDir: brain, home, pluginVersion: VERSION, emit: (l) => out.push(l), now: Date.now() }); return out; };
    expect(say()).toEqual(['[RuvNet Brain — CODEX HOOKS CHANGED OVERNIGHT] Codex hooks changed overnight; open Codex sessions will pick them up on restart or after /hooks review.']);
    expect(say()).toEqual([]);
  });

  it('nightly with nothing changed for Codex: no reload and no notice', async () => {
    const home = tmpHome();
    const { result, calls } = await converge(home, { unattended: true,
      wireCodexPlugin: () => ({ action: 'unchanged', installed: true, enabled: true, version: VERSION, hookTrust: { state: 'unchanged', changed: false } }) });
    expect(calls).toEqual([]);
    expect(result.hostRefresh).toEqual({ state: 'not-needed', changed: false });
    expect(fs.existsSync(path.join(home, 'brain', 'codex-hooks-overnight-notice.json'))).toBe(false);
  });

  it('interactive --update still reloads and records no notice', async () => {
    const home = tmpHome();
    const { result, calls } = await converge(home, { unattended: false });
    expect(calls).toEqual(['updated']);
    expect(result.hostRefresh).toMatchObject({ state: 'refreshed' });
    expect(fs.existsSync(path.join(home, 'brain', 'codex-hooks-overnight-notice.json'))).toBe(false);
  });

  it('the nightly marker is the env the scheduled runner sets (RUVNET_NIGHTLY=1), and it is the default', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'bin', 'nightly-refresh.mjs'), 'utf8');
    expect(runner).toMatch(/RUVNET_NIGHTLY: '1'/);
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
    expect(src).toMatch(/unattended = process\.env\.RUVNET_NIGHTLY === '1'/);
  });
});

// Review r2 (4.7.21): the reload notice must not say hooks pause when the authorized reconciliation already re-trusted them.
describe('the reload notice says whether trust was re-established', () => {
  it('re-trusted (registry-verified or nothing pending): hooks keep running, no /hooks review asked', () => {
    for (const state of ['registry-verified', 'unchanged']) {
      const note = installer.codexHostRefreshMessage({ state: 'refreshed' }, { action: 'updated', hookTrust: { state } });
      expect(note.text).toMatch(/already re-trusted/);
      expect(note.text).not.toMatch(/re-review them in \/hooks/);
    }
  });
  it('not re-trusted (blocked, degraded, or no reconciliation): hooks need review in /hooks', () => {
    for (const plugin of [{ hookTrust: { state: 'blocked' } }, { hookTrust: { state: 'degraded' } }, { action: 'updated' }, null]) {
      const note = installer.codexHostRefreshMessage({ state: 'refreshed' }, plugin);
      expect(note.text).toMatch(/Brain hooks pause in them until you re-review them in \/hooks/);
      expect(note.text).not.toMatch(/already re-trusted/);
    }
  });
});
