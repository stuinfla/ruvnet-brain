/** Owned, deadline-bound native reads and global Ruflo commands for canonical recall. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rufloInvocation } from './ruflo-bin.mjs';
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
      child = spawn(inv.executable, inv.args, { cwd, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_MEMORY_PATH: undefined },
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
export async function nativeRead({ store, requests, namespaces, deadline, env, scratch, signal }) {
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

export async function exactReads({ candidates, bin, deadline, env, scratch, signal }) {
  const groups = new Map();
  for (const candidate of candidates) {
    const storePath = candidate.storePath;
    if (!groups.has(storePath)) groups.set(storePath, []);
    groups.get(storePath).push(candidate);
  }
  const results = new Map();
  await Promise.all([...groups].map(async ([storePath, rows]) => {
    const native = await nativeRead({ store: { path: storePath }, requests: rows.map(({ namespace, key }) => ({ namespace, key })),
      deadline, env, scratch, signal });
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

