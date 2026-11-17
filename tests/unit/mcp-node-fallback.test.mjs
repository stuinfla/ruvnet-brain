// tests/unit/mcp-node-fallback.test.mjs
//
// THE LAUNCH NODE BREAKING MID-SESSION MUST NOT TAKE SEARCH DOWN (2026-11-16 outage).
//
// plugin/mcp/server.mjs started its search worker with process.execPath — the versioned Homebrew keg the
// long-running shell was launched under. A `brew upgrade` at 3:31 a.m. replaced a library that keg linked
// against; from then on that node died in 7 ms with "dyld: Library not loaded" and every search in every
// open session failed. A deleted keg was worse: spawn emits 'error' and no 'exit', nothing rejected the
// pending call, and each search hung for the full init timeout.
//
// These tests start the REAL server under a clone of node placed at a fake keg path, prove a first search
// works, retire the worker, then break the launch node the two ways it breaks in life (a dyld-failing
// binary; a deleted path) and require the next search to succeed through the fallback chain. The last
// case breaks every candidate and requires a fast, loud failure that names each node and its reason.
//
// RNB_SERVER_UNDER_TEST points the suite at another copy of server.mjs (the pre-fix file, placed beside
// the real one so its relative imports resolve) to prove each test fails on the old code.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = process.env.RNB_SERVER_UNDER_TEST || path.join(ROOT, 'plugin', 'mcp', 'server.mjs');
const REAL_NODE = fs.realpathSync(process.execPath);
const posix = process.platform !== 'win32';
const temps = [];
afterAll(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

// A worker that answers the private handshake and searches, naming the node it runs under; the query
// "retire" makes it exit cleanly (the idle retirement), so the next search must respawn it.
const STUB_CHILD = `
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } });
  if (m.method === 'brain/warmup') return send({ jsonrpc: '2.0', id: m.id, result: { ready: true } });
  if (m.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'answer from ' + process.execPath }] } });
    if (m.params?.arguments?.query === 'retire') setTimeout(() => process.exit(0), 20);
  }
});
`;
const DYLD = '#!/bin/sh\necho "dyld[$$]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.36.dylib" >&2\nkill -ABRT $$\n';
// Passes a bare `node -e` self-test, then dies like the broken keg when asked to run the worker.
const DIES_ON_SCRIPT = `#!/bin/sh\nif [ "$1" = "-e" ]; then exec '${REAL_NODE}' "$@"; fi\n${DYLD.split('\n').slice(1).join('\n')}`;

function world(child = STUB_CHILD) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-node-fallback-'));
  temps.push(t);
  const keg = path.join(t, 'Cellar', 'node@24', '9.9.9', 'bin');
  fs.mkdirSync(keg, { recursive: true });
  const launchNode = path.join(keg, 'node');
  try { fs.copyFileSync(REAL_NODE, launchNode, fs.constants.COPYFILE_FICLONE); } catch { fs.copyFileSync(REAL_NODE, launchNode); }
  fs.chmodSync(launchNode, 0o755);
  // A Homebrew node links @rpath/libnode.*.dylib from its keg's lib/; the clone needs its own copy.
  const realLib = path.join(path.dirname(path.dirname(REAL_NODE)), 'lib');
  for (const name of fs.existsSync(realLib) ? fs.readdirSync(realLib).filter((n) => /^libnode\./.test(n)) : []) {
    fs.mkdirSync(path.join(keg, '..', 'lib'), { recursive: true });
    try { fs.copyFileSync(path.join(realLib, name), path.join(keg, '..', 'lib', name), fs.constants.COPYFILE_FICLONE); }
    catch { fs.copyFileSync(path.join(realLib, name), path.join(keg, '..', 'lib', name)); }
  }
  const brainHome = path.join(t, 'brain');
  fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(brainHome, 'kb', 'forge-mcp-all.mjs'), child);
  const home = path.join(t, 'home');
  const pathBin = path.join(t, 'pathbin');
  fs.mkdirSync(home); fs.mkdirSync(pathBin);
  return { t, launchNode, brainHome, home, pathBin };
}

const script = (file, text) => { fs.writeFileSync(file, text, { mode: 0o755 }); return file; };
const breakWithDyld = (file) => { fs.unlinkSync(file); script(file, DYLD); };

function startServer(w, extraEnv = {}) {
  const env = {
    PATH: `${w.pathBin}:/usr/bin:/bin`, HOME: w.home, XDG_STATE_HOME: path.join(w.t, 'state'), XDG_CACHE_HOME: path.join(w.t, 'cache'),
    RUVNET_BRAIN_HOME: w.brainHome, RUVNET_BRAIN_NODE_WELL_KNOWN: '', NTFY_TOPIC: '', RUVNET_BRAIN_INIT_TIMEOUT_MS: '60000', ...extraEnv,
  };
  const proc = spawn(w.launchNode, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const waiters = new Map();
  let buf = '', stderr = '', nextId = 1;
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (waiters.has(o.id)) { waiters.get(o.id)(o); waiters.delete(o.id); }
    }
  });
  proc.stderr.on('data', (d) => { stderr += d; });
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; waiters.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const search = async (query) => {
    const r = await rpc('tools/call', { name: 'search_ruvnet', arguments: { query } });
    return { isError: Boolean(r.result?.isError), text: r.result?.content?.[0]?.text || r.error?.message || '' };
  };
  const readiness = () => { try { return JSON.parse(fs.readFileSync(path.join(w.brainHome, 'mcp-readiness.d', `${proc.pid}.json`), 'utf8')); } catch { return null; } };
  const stop = () => new Promise((done) => { if (proc.exitCode !== null) return done(); proc.once('exit', done); proc.kill('SIGKILL'); });
  return { proc, rpc, search, readiness, stop, stderrOf: () => stderr };
}

async function initialized(w, env) {
  const s = startServer(w, env);
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return s;
}

describe.skipIf(!posix)('search survives the launch node breaking mid-session', () => {
  it('a brew upgrade leaves the launch keg failing with dyld: the next search recovers through the fallback chain', async () => {
    const w = world();
    fs.symlinkSync(REAL_NODE, path.join(w.pathBin, 'node'));
    // The launch keg leads the chain, so the first worker really runs under it (as on 2026-11-16).
    const s = await initialized(w, { RUVNET_BRAIN_NODE_CANDIDATES: w.launchNode });
    try {
      expect((await s.search('first')).text).toBe(`answer from ${fs.realpathSync(w.launchNode)}`);
      await s.search('retire');
      await new Promise((r) => setTimeout(r, 300));
      breakWithDyld(w.launchNode);
      const after = await s.search('after the upgrade');
      expect(after.isError, after.text).toBe(false);
      expect(after.text).toMatch(/^answer from /);
      const ready = s.readiness();
      expect(ready?.state).toBe('ready');
      expect(ready?.workerNode).toBeTruthy();
      expect(ready.workerNode).not.toBe(w.launchNode);
    } finally { await s.stop(); }
  }, 30_000);

  it('a deleted launch keg answers promptly through the fallback (spawn error, no exit, is never a hang)', async () => {
    const w = world();
    fs.symlinkSync(REAL_NODE, path.join(w.pathBin, 'node'));
    const s = await initialized(w, { RUVNET_BRAIN_NODE_CANDIDATES: w.launchNode });
    try {
      expect((await s.search('first')).text).toBe(`answer from ${fs.realpathSync(w.launchNode)}`);
      await s.search('retire');
      await new Promise((r) => setTimeout(r, 300));
      fs.unlinkSync(w.launchNode);
      const started = Date.now();
      const after = await s.search('after the delete');
      expect(after.isError, after.text).toBe(false);
      expect(after.text).toMatch(/^answer from /);
      expect(after.text).not.toContain(fs.realpathSync(w.t));
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { await s.stop(); }
  }, 30_000);

  it('a node that passes the self-test but dies on the worker is retried with the next candidate, and reported', async () => {
    const w = world();
    const liar = script(path.join(w.t, 'liar-node'), DIES_ON_SCRIPT);
    fs.symlinkSync(REAL_NODE, path.join(w.pathBin, 'node'));
    const s = await initialized(w, { RUVNET_BRAIN_NODE_CANDIDATES: liar });
    try {
      const r = await s.search('first');
      expect(r.isError, r.text).toBe(false);
      const ready = s.readiness();
      expect(ready?.workerNode).not.toBe(liar);
      expect(JSON.stringify(ready?.nodeRejected || [])).toMatch(/liar-node[^}]*Library not loaded/);
    } finally { await s.stop(); }
  }, 30_000);

  it('every candidate broken: fails in seconds, names each node and its reason, and records the outage', async () => {
    const w = world();
    script(path.join(w.pathBin, 'node'), DYLD);
    const liar = script(path.join(w.t, 'liar-node'), DIES_ON_SCRIPT);
    // PATH holds only the broken node: a runner's own /usr/bin/node must not rescue this world.
    const s = startServer(w, { RUVNET_BRAIN_NODE_CANDIDATES: liar, PATH: w.pathBin });
    try {
      await s.rpc('ping', {}); // the shell is up and running before its own binary is broken
      breakWithDyld(w.launchNode);
      const started = Date.now();
      const r = await s.search('anything');
      const took = Date.now() - started;
      expect(r.isError).toBe(true);
      expect(took).toBeLessThan(15_000);
      expect(r.text).toMatch(/could not start under any Node runtime/);
      expect(r.text).toContain(liar);
      expect(r.text).toMatch(/Library not loaded/);
      expect(r.text).toMatch(/First thing to check/);
      const health = JSON.parse(fs.readFileSync(path.join(w.brainHome, 'health.json'), 'utf8'));
      expect(health).toMatchObject({ status: 'down', phase: 'node-runtime' });
    } finally { await s.stop(); }
  }, 30_000);

  it('a worker that crashes under a node that still runs is a brain fault: one start, phase initialize, no "reinstall Node"', async () => {
    const w = world("process.stderr.write('Error: the KB manifest is corrupt\\n'); process.exit(1);\n");
    fs.symlinkSync(REAL_NODE, path.join(w.pathBin, 'node'));
    const s = await initialized(w);
    try {
      const r = await s.search('anything');
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/failed to initialize/);
      expect(r.text).not.toMatch(/could not start under any Node runtime/);
      const health = JSON.parse(fs.readFileSync(path.join(w.brainHome, 'health.json'), 'utf8'));
      expect(health).toMatchObject({ status: 'down', phase: 'initialize' });
    } finally { await s.stop(); }
  }, 30_000);
});
