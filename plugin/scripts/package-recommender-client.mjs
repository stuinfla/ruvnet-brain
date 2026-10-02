// package-recommender-client.mjs — the hook's side of the semantic lane (ADR-093 rev 2).
//
// Asks a WARM search worker (kb/recommend-endpoint.mjs inside forge-mcp-all.mjs) for the package cards
// nearest to the prompt. Never loads a model, never spawns anything, never waits past its budget: no
// live endpoint, a refused connection, a slow answer, or a malformed reply all resolve to
// { candidates: null, reason } — the caller then uses the lexical lane or stays silent.
//
// The plugin cannot import kb/ (issue #32), so brainHomeFromEnv() and the flag rule are duplicated
// here and held equal to kb/recommend-endpoint.mjs by tests/unit/package-recommender-semantic.test.mjs.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRecommenderEnabled, isDesignOrDiagnosis } from './package-recommender.mjs';

export const DEFAULT_BUDGET_MS = 250;
export const CARDS_DIR = path.dirname(fileURLToPath(import.meta.url));   // package-cards.{json,rvf} ship here

export function brainHomeFromEnv(env = process.env) {
  if (env.RUVNET_BRAIN_HOME) return env.RUVNET_BRAIN_HOME;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'ruvnet-brain');
  return path.join(env.HOME || env.USERPROFILE || '', '.cache', 'ruvnet-brain');
}

// ESRCH = gone. EPERM = a process we may not signal, i.e. NOT ours — never a worker we should trust.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SCHEMA = 'ruvnet-brain.recommend-endpoint/1';
const uid = typeof process.getuid === 'function' ? process.getuid() : null;

/** A file or dir we would trust: owned by this user and not group/world-writable/readable (POSIX). */
function privateToUser(p) {
  if (uid === null) return true;   // Windows: no POSIX modes; the per-process token is the guard (ADR-093)
  try { const st = fs.statSync(p); return st.uid === uid && (st.mode & 0o077) === 0; } catch { return false; }
}

// The endpoint's short-socket fallback dir (kb/recommend-endpoint.mjs shortSocketDir, held equal by
// tests/unit/package-recommender-semantic.test.mjs): used when <brainHome>/run/… is too long for a socket.
export function shortSocketDir(id = uid) {
  return id === null || id === undefined ? null : path.join('/tmp', `ruvnet-brain-${id}`);
}

/** Where a descriptor's socket may live: inside run/, or exactly recommend-<pid>.sock in the private short dir. */
function trustedSocket(d, runDir) {
  const socket = path.resolve(String(d?.socket));
  if (path.dirname(socket) === path.resolve(runDir)) return true;
  const short = shortSocketDir();
  if (!short || path.dirname(socket) !== short || path.basename(socket) !== `recommend-${d.pid}.sock`) return false;
  try { const st = fs.lstatSync(short); return st.isDirectory() && !st.isSymbolicLink() && privateToUser(short); } catch { return false; }
}

/**
 * Live endpoint descriptors, newest first. A descriptor is trusted only when the run/ dir and the file
 * are private to this user, its schema matches, its pid is alive and ours, and (POSIX) its socket lies
 * inside run/ (or is that pid's socket in the private short dir) — so a planted descriptor cannot route the
 * user's prompt text to someone else's socket
 * (adversarial review M3). Stale ones are skipped here, swept by the next endpoint.
 */
export function liveEndpoints(env = process.env) {
  const dir = path.join(brainHomeFromEnv(env), 'run');
  if (!privateToUser(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^recommend-\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const file = path.join(dir, n);
      if (!privateToUser(file)) continue;
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      const sockOk = process.platform === 'win32'
        ? /^\\\\\.\\pipe\\ruvnet-brain-recommend-\d+$/.test(String(d?.socket))
        : trustedSocket(d, dir);
      if (d?.schema === SCHEMA && Number.isInteger(d.pid) && n === `recommend-${d.pid}.json` && sockOk
        && typeof d.token === 'string' && d.token.length >= 32 && alive(d.pid)) out.push(d);
    } catch { /* torn or foreign file */ }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function askOne(d, request, deadline) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } resolve(v); } };
    const timer = setTimeout(() => finish({ candidates: null, reason: 'timeout' }), Math.max(1, deadline - Date.now()));
    const sock = net.createConnection(d.socket);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ ...request, token: d.token })}\n`));
    sock.on('data', (c) => {
      buf += c;
      if (buf.length > 64 * 1024) return finish({ candidates: null, reason: 'oversize' });
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let r;
      try { r = JSON.parse(buf.slice(0, nl)); } catch { return finish({ candidates: null, reason: 'bad-reply' }); }
      if (!Array.isArray(r?.candidates)) return finish({ candidates: null, reason: r?.error || 'no-candidates' });
      const candidates = r.candidates
        .filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.similarity))
        .slice(0, 10);
      finish({ candidates, reason: null, workerMs: r.ms });
    });
    sock.on('error', () => finish({ candidates: null, reason: 'connect-failed' }));
    sock.on('close', () => finish({ candidates: null, reason: 'closed' }));
  });
}

/**
 * The semantic lane, from the hook. Tries live endpoints newest-first until one answers or the
 * budget is spent. Resolves (never rejects) to { candidates: [{id, similarity}] | null, reason }.
 */
export async function askWarmWorker({ prompt, k = 8, cardsDir = CARDS_DIR, budgetMs = DEFAULT_BUDGET_MS, env = process.env } = {}) {
  const deadline = Date.now() + budgetMs;
  const endpoints = liveEndpoints(env);
  if (!endpoints.length) return { candidates: null, reason: 'no-warm-worker' };
  let last = { candidates: null, reason: 'no-answer' };
  for (const d of endpoints) {
    if (Date.now() >= deadline) return { candidates: null, reason: 'timeout' };
    last = await askOne(d, { prompt: String(prompt || '').slice(0, 4000), k, cardsDir }, deadline);
    if (last.candidates) return last;
  }
  return last;
}

/**
 * The route's single call: semantic candidates for this prompt, or null. Asks ONLY when the flag is
 * on, the closed catalogue did not match, and the prompt is design/diagnosis-shaped — so a chore,
 * a status question, or a default-off install never touches a socket.
 */
export const MAX_BUDGET_MS = 1000;   // never more than this, whatever the env asks (route's own budget is 1500)

export async function semanticFor(prompt, { catalogueMatched = false, env = process.env, startedAt = Date.now() } = {}) {
  if (!packageRecommenderEnabled(env) || catalogueMatched || !isDesignOrDiagnosis(prompt)) return null;
  // The budget runs from the HOOK PROCESS START the caller passes in, so module load and descriptor
  // reads count against it too (adversarial review M4); an env override is clamped, never trusted.
  const asked = Number(env.RUVNET_PACKAGE_RECOMMENDER_BUDGET_MS) || DEFAULT_BUDGET_MS;
  const budgetMs = Math.min(asked, MAX_BUDGET_MS) - (Date.now() - startedAt);
  if (budgetMs <= 0) return { candidates: null, reason: 'budget-spent' };
  try { return await askWarmWorker({ prompt, budgetMs, env }); } catch { return null; }
}
