/** Owned, deadline-bound native reads and global Ruflo commands for canonical recall. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rufloInvocation, nativeNodeFor } from './ruflo-bin.mjs';
export function searchJsonResult(stdout) {
  const s = String(stdout || '');
  // Live Ruflo prints warnings AFTER the JSON object as well as logs before it.
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return { valid: false, rows: [] };
  try { const rows = JSON.parse(s.slice(start, end + 1)).results;
    return Array.isArray(rows) && rows.every(r => r && typeof r.key === 'string' && r.key)
      ? { valid: true, rows } : { valid: false, rows: [] };
  } catch { return { valid: false, rows: [] }; }
}

function killGroup(child) {
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const inside = (root, file) => { const rel = path.relative(root, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/**
 * Can reads go through Ruflo's own published code instead of one CLI process per read (#429)? Only when the resolved
 * `ruflo` is the real package entry AND the `@claude-flow/cli` it loads (found as bin/ruflo.js finds it) declares a
 * `./memory` export that resolves to a file inside it. Otherwise null and the caller keeps the per-read CLI route.
 * The three functions and result shapes are checked again inside the child, where they are actually loaded.
 */
export function resolveBatchTarget(bin, { env = process.env, deadlineAt } = {}) {
  try {
    if (!bin || process.platform === 'win32') return null; // npm .cmd shims are not inspected here
    const entry = fs.realpathSync(bin);
    const pkgRoot = path.dirname(path.dirname(entry));
    const pkg = readJson(path.join(pkgRoot, 'package.json'));
    const declared = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.ruflo;
    if (pkg?.name !== 'ruflo' || typeof declared !== 'string' || fs.realpathSync(path.resolve(pkgRoot, declared)) !== entry) return null;
    let cliRoot = null;
    for (let dir = pkgRoot, i = 0; i < 10 && !cliRoot; i += 1, dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', '@claude-flow', 'cli');
      if (fs.existsSync(path.join(candidate, 'package.json'))) cliRoot = candidate;
      if (path.dirname(dir) === dir) break;
    }
    const cli = cliRoot && readJson(path.join(cliRoot, 'package.json'));
    const target = cli?.name === '@claude-flow/cli' ? (cli.exports?.['./memory']?.import ?? cli.exports?.['./memory']) : null;
    if (typeof target !== 'string') return null;
    const file = fs.realpathSync(path.resolve(cliRoot, target));
    if (!inside(fs.realpathSync(cliRoot), file) || !fs.statSync(file).isFile()) return null;
    return { node: nativeNodeFor(bin, { env, deadlineAt })?.node ?? process.execPath, moduleUrl: pathToFileURL(file).href };
  } catch { return null; }
}

/**
 * ONE owned child answering `list` / `get` for a store through Ruflo's public memory export. Spawned on first use,
 * killed (whole process group) at the absolute deadline or on close(). Every op resolves, never rejects:
 * { state: 'ok' | 'unavailable' | 'timed out' | 'fallback', rows?, value? } — 'fallback' means this route cannot
 * answer (capability or shape mismatch) and the caller must use the per-read CLI route. `{success:false}` from
 * Ruflo is 'unavailable', never an empty result.
 */
export function openBatchSession({ bin, storePath, env, deadline, makeCwd, signal }) {
  const target = resolveBatchTarget(bin, { env, deadlineAt: deadline });
  if (!target || !storePath) return null;
  let child = null, cwd = null, ready = null, resolveReady = null, seq = 0, closed = false, timer;
  const pending = new Map();
  const settleAll = (state) => { for (const finish of [...pending.values()]) finish({ state }); };
  const close = (state = 'unavailable') => {
    if (closed) return; closed = true; clearTimeout(timer);
    settleAll(state);
    if (child) { killGroup(child); try { child.stdin.destroy(); } catch { /* gone */ } }
    cwd?.cleanup?.();
  };
  const start = () => {
    if (child || closed) return;
    try {
      cwd = makeCwd();
      child = spawn(target.node, [fileURLToPath(new URL('./agentdb-recall-reader.mjs', import.meta.url)), '--session', storePath, target.moduleUrl],
        { cwd: cwd.cwd, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false', CLAUDE_FLOW_MEMORY_PATH: undefined },
          stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
    } catch { child = null; close(); return; }
    ready = new Promise((resolve) => {
      resolveReady = resolve;
      child.once('close', () => { resolve(false); if (!closed) settleAll('unavailable'); });
      child.once('error', () => resolve(false));
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (typeof row.ready === 'boolean') resolveReady(row.ready);
        else pending.get(row.id)?.(row);
      }
    });
    child.stdin.on('error', () => {});
    timer = setTimeout(() => close('timed out'), Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', () => close('unavailable'), { once: true });
  };
  const ask = (request, opDeadline = deadline) => new Promise((resolve) => {
    if (closed || signal?.aborted) return resolve({ state: signal?.aborted ? 'unavailable' : 'timed out' });
    if (opDeadline - Date.now() <= 0) return resolve({ state: 'timed out' });
    start();
    if (!child) return resolve({ state: 'unavailable' });
    const id = ++seq;
    const opTimer = opDeadline < deadline ? setTimeout(() => finish({ state: 'timed out' }), Math.max(1, opDeadline - Date.now())) : null;
    const finish = (row) => { if (!pending.delete(id)) return; clearTimeout(opTimer); const { id: _id, ...rest } = row; resolve(rest); };
    pending.set(id, finish);
    ready.then((ok) => {
      if (!pending.has(id)) return;
      if (!ok) return finish({ state: closed ? 'unavailable' : 'fallback' });
      try { child.stdin.write(JSON.stringify({ id, ...request }) + '\n'); } catch { finish({ state: 'unavailable' }); }
    });
  });
  return { storePath, close,
    list: (namespace, limit, opDeadline) => ask({ op: 'list', namespace, limit }, opDeadline),
    get: async (namespace, key, opDeadline) => { const r = await ask({ op: 'get', namespace, key }, opDeadline); return r.state === 'ok' ? { ...r, value: r.value.trim() } : r; } };
}

/** One ruflo search, bounded by an absolute deadline. Resolves { rows, state } — never rejects. */
export function searchOnce({ ruflo, store, args, deadline, env, scratch, operation = 'search', signal, invocation }) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (signal?.aborted || remaining <= 0) { resolve({ rows: [], state: signal?.aborted ? 'unavailable' : 'timed out' }); return; }
    let cwd;
    try { cwd = fs.mkdtempSync(path.join(scratch(store.path), 'run-')); } catch { resolve({ rows: [], state: 'unavailable' }); return; }
    const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* swept later as a stale run- dir */ } };
    let inv;
    try { inv = invocation ?? rufloInvocation(ruflo, ['memory', operation, '--path', store.path, ...args]); }
    catch { cleanup(); resolve({ rows: [], state: 'unavailable' }); return; }
    let child;
    try {
      child = spawn(inv.executable, inv.args, { cwd, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false', CLAUDE_FLOW_MEMORY_PATH: undefined },
        stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
    } catch { cleanup(); resolve({ rows: [], state: 'unavailable' }); return; }
    let out = '', outputBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let done = false, retiring = null, retirementTimer, timer;
    const finish = (state, retirement = process.platform === 'win32' ? 'direct-child-only' : 'confirmed') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(retirementTimer);
      signal?.removeEventListener('abort', cancel);
      cleanup();
      const parsed = operation === 'search' ? searchJsonResult(out) : null;
      if (state === 'ok' && parsed && !parsed.valid) state = 'unavailable';
      resolve({ rows: state === 'ok' && parsed ? parsed.rows : [], value: state === 'ok' ? out.trim() : '', state, retirement });
    };
    const retire = state => {
      if (done || retiring) return;
      retiring = state; killGroup(child);
      retirementTimer = setTimeout(() => finish('unavailable', 'unconfirmed'), Math.max(1, deadline - Date.now()));
    };
    const cancel = () => retire('unavailable');
    signal?.addEventListener('abort', cancel, { once: true });
    // Reserve cleanup inside the same caller deadline; pipe inheritance cannot report success.
    timer = setTimeout(() => retire('timed out'), Math.max(1, deadline - Date.now() - 100));
    child.stdout.on('data', c => { if (done || retiring) return; outputBytes += c.length;
      if (outputBytes > 1 << 20) return retire('unavailable');
      try { out += decoder.decode(c, { stream: true }); } catch { retire('unavailable'); } });
    child.on('error', () => retire('unavailable'));
    child.on('close', code => {
      killGroup(child); // Successful parent exit must not leave an owned detached grandchild.
      let valid = true; try { out += decoder.decode(); } catch { valid = false; }
      const settle = () => {
        if (done) return;
        let alive = false;
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
        }
        if (alive && Date.now() < deadline) { retirementTimer = setTimeout(settle, 5); return; }
        finish(alive || !valid ? 'unavailable' : retiring ?? (code === 0 ? 'ok' : 'failed'), alive ? 'unconfirmed' : undefined);
      };
      clearTimeout(retirementTimer); settle();
    });
    if (signal?.aborted) cancel();
  });
}

/** Isolate synchronous read-only SQLite work inside the same cancellable process budget. */
export async function nativeRead({ store, requests, namespaces, deadline, env, scratch, signal, session }) {
  if (session && session.storePath === store.path) {
    const rows = requests ? await Promise.all(requests.map(({ namespace, key }) => session.get(namespace, key)))
      : await Promise.all(namespaces.map((namespace) => session.list(namespace, 100000)));
    const states = rows.map((row) => row.state);
    if (!states.includes('fallback')) {
      const dead = states.find((state) => state === 'timed out') ?? (!requests && states.find((state) => state !== 'ok'));
      if (dead) return { ok: false, fatal: true, state: dead };
      return { ok: true, state: 'ok', value: requests ? rows.map((row) => (row.state === 'ok' ? row.value : null))
        : Object.fromEntries(namespaces.map((namespace, i) => [namespace, rows[i].rows.map((row) => row.key).filter((key) => typeof key === 'string')])) };
    }
  }
  const result = await searchOnce({ store, deadline, env, scratch, signal, operation: 'native',
    invocation: { executable: process.execPath, args: [fileURLToPath(new URL('./agentdb-recall-reader.mjs', import.meta.url)),
      store.path, JSON.stringify({ requests, namespaces, deadline })] } });
  if (result.state !== 'ok') return { ok: false, fatal: true, state: result.state };
  try {
    const parsed = JSON.parse(result.value);
    if (typeof parsed.ok !== 'boolean') throw new Error('invalid native result');
    return { ...parsed, state: parsed.ok ? 'ok' : 'unavailable' };
  } catch { return { ok: false, fatal: true, state: 'unavailable' }; }
}

export async function exactReads({ candidates, bin, deadline, env, scratch, signal, session }) {
  const groups = new Map();
  for (const candidate of candidates) {
    const storePath = candidate.storePath;
    if (!groups.has(storePath)) groups.set(storePath, []);
    groups.get(storePath).push(candidate);
  }
  const results = new Map();
  await Promise.all([...groups].map(async ([storePath, rows]) => {
    const native = await nativeRead({ store: { path: storePath }, requests: rows.map(({ namespace, key }) => ({ namespace, key })),
      deadline, env, scratch, signal, session });
    await Promise.all(rows.map(async (row, index) => {
      const result = native.ok ? { state: 'ok', value: native.value[index] ?? '' }
        : native.fatal ? { state: native.state, value: '' }
        : await searchOnce({ ruflo: bin, store: { path: storePath }, deadline, env, scratch, signal,
          operation: 'retrieve', args: ['-k', row.key, '-n', row.namespace, '--value-only'] });
      results.set(row, result);
    }));
  }));
  return results;
}

