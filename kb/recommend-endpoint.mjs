/**
 * recommend-endpoint.mjs — a tiny local endpoint on the WARM search worker that answers "which rUv
 * package cards are nearest to this prompt?" for the UserPromptSubmit hook (ADR-093 rev 2).
 *
 * WHY HERE. A hook is a fresh process per prompt; loading bge-base there costs ~3 s against a 3 s
 * timeout. forge-mcp-all.mjs already holds that embedder warm for search_ruvnet. This endpoint lets the
 * hook borrow it: one JSON line in, one JSON line out, over a Unix socket (a named pipe on Windows).
 *
 * WHAT IT IS NOT. Not a second MCP server, not network-reachable, not started unless the package
 * recommender flag is on. The socket lives in a 0700 directory under the Brain's own cache; a
 * random per-process token in a 0600 descriptor file must accompany every request, so a process
 * that cannot read the user's cache cannot ask. Requests are bounded (8 KiB in, k ≤ 10) and the
 * endpoint never writes anything but its own descriptor and socket.
 *
 * DESCRIPTOR: <brainHome>/run/recommend-<pid>.json = { pid, socket, token, startedAt, schema }.
 * Removed on exit. A hook treats a descriptor whose pid is not alive as stale and ignores it. The socket is
 * <brainHome>/run/recommend-<pid>.sock, or /tmp/ruvnet-brain-<uid>/recommend-<pid>.sock when that path is too
 * long for a Unix socket (SOCKET_PATH_MAX below).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { openCardIndex } from './package-cards-index.mjs';

export const SCHEMA = 'ruvnet-brain.recommend-endpoint/1';
const MAX_REQUEST = 8 * 1024;
const MAX_K = 10;

/** The Brain cache root, resolved exactly as forge-mcp-all.mjs resolves it for meterLog(). */
export function brainHomeFromEnv(env = process.env) {
  if (env.RUVNET_BRAIN_HOME) return env.RUVNET_BRAIN_HOME;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'ruvnet-brain');
  return path.join(env.HOME || env.USERPROFILE || '', '.cache', 'ruvnet-brain');
}

/** Same opt-in rule as plugin/scripts/advocacy-route.mjs packageRecommenderEnabled() (parity-tested). */
export function recommenderFlagOn(env = process.env) {
  return ['1', 'on', 'true', 'yes'].includes(String(env.RUVNET_PACKAGE_RECOMMENDER || '').trim().toLowerCase());
}

export function runDir(brainHome) { return path.join(brainHome, 'run'); }

function socketPath(brainHome, pid) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ruvnet-brain-recommend-${pid}`
    : path.join(runDir(brainHome), `recommend-${pid}.sock`);
}

// A Unix socket path is capped by sockaddr_un.sun_path: measured 104 bytes on macOS (105 → listen EINVAL),
// 108 incl. NUL on Linux. A long HOME / RUVNET_BRAIN_HOME (or a Brain moved to a deep folder) pushes
// <brainHome>/run/recommend-<pid>.sock past it, and the endpoint silently never started. Then the socket
// goes in ONE short per-user directory, the same on every process of this user (not os.tmpdir(), which
// differs between a GUI host and a terminal): /tmp/ruvnet-brain-<uid>, 0700, owned by this user.
export const SOCKET_PATH_MAX = process.platform === 'linux' ? 107 : 104;
export function shortSocketDir(uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  return uid === null || uid === undefined ? null : path.join('/tmp', `ruvnet-brain-${uid}`);
}

/** The short directory, created 0700 if absent; null unless it is a real directory private to this user. */
function privateShortDir(dir) {
  if (!dir) return null;
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') return null; }
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    return (fs.lstatSync(dir).mode & 0o077) === 0 ? dir : null;
  } catch { return null; }
}

/** A directory that looks like the plugin's card snapshot, not an arbitrary path a client named. */
export function isCardsDir(dir) {
  return ['package-cards.json', 'package-cards.rvf', 'package-cards.rvf.meta.json', 'package-recommender.mjs']
    .every((f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } });
}

function tokenMatches(got, want) {
  if (typeof got !== 'string' || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** Remove descriptors and sockets left by workers that died without cleanup (SIGKILL, crash). */
export function sweepStale(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const m = n.match(/^recommend-(\d+)\.(json|sock)$/);
    if (!m || pidAlive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch { /* raced */ }
  }
  return removed;
}

/**
 * Start the endpoint. A request names the plugin directory holding package-cards.{json,rvf}; it is
 * accepted only if it looks like one (isCardsDir), and only ONE index is held at a time (a plugin update
 * moves the dir: the old index is closed, not leaked). A failed open is not cached.
 * Returns { close(), descriptor } or null when it could not start (never throws).
 */
export async function startRecommendEndpoint({ brainHome, onActivity = () => {}, log = () => {}, openIndex = openCardIndex, signals = true }) {
  try {
    const dir = runDir(brainHome);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
    sweepStale(dir);
    let sock = socketPath(brainHome, process.pid);
    if (process.platform !== 'win32' && Buffer.byteLength(sock) > SOCKET_PATH_MAX) {
      const short = privateShortDir(shortSocketDir());
      if (!short) {
        log(`[recommend-endpoint] not started: socket path ${sock} is ${Buffer.byteLength(sock)} bytes (limit ${SOCKET_PATH_MAX}) `
          + `and the short fallback ${shortSocketDir()} is not a private directory of this user`);
        return null;
      }
      sweepStale(short);
      log(`[recommend-endpoint] ${sock} is ${Buffer.byteLength(sock)} bytes (limit ${SOCKET_PATH_MAX}); listening in ${short} instead`);
      sock = path.join(short, `recommend-${process.pid}.sock`);
    }
    if (process.platform !== 'win32') fs.rmSync(sock, { force: true });
    const token = crypto.randomBytes(24).toString('hex');
    let held = null; // { key, promise }

    const indexFor = async (cardsDir) => {
      const key = path.resolve(cardsDir);
      if (!isCardsDir(key)) return null;
      if (held?.key !== key) {
        const prev = held;
        held = { key, promise: Promise.resolve().then(() => openIndex(key)).catch(() => null) };
        prev?.promise.then((ix) => ix?.close?.()).catch(() => {});
      }
      const ix = await held.promise;
      if (!ix && held?.key === key) held = null;   // never cache a failure: the next request retries
      return ix;
    };

    const server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.setTimeout(5000, () => conn.destroy());
      conn.on('data', async (chunk) => {
        buf += chunk;
        if (buf.length > MAX_REQUEST) { conn.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        let req;
        try { req = JSON.parse(line); } catch { conn.end('{"error":"bad-json"}\n'); return; }
        if (!req || !tokenMatches(req.token, token)) { conn.end('{"error":"unauthorized"}\n'); return; }
        onActivity();
        const started = Date.now();
        try {
          const cardsDir = typeof req.cardsDir === 'string' && path.isAbsolute(req.cardsDir) ? req.cardsDir : null;
          const index = cardsDir ? await indexFor(cardsDir) : null;
          if (!index) { conn.end(`${JSON.stringify({ error: 'no-card-index' })}\n`); return; }
          const k = Math.min(MAX_K, Math.max(1, Number(req.k) || 4));
          const hits = await index.query(String(req.prompt || '').slice(0, 4000), k);
          conn.end(`${JSON.stringify({
            schema: SCHEMA,
            ms: Date.now() - started,
            candidates: hits.map((h) => ({ id: h.card.id, similarity: +h.similarity.toFixed(4) })),
          })}\n`);
        } catch (e) {
          conn.end(`${JSON.stringify({ error: String(e?.message || e).slice(0, 200) })}\n`);
        }
      });
      conn.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });
    if (process.platform !== 'win32') { try { fs.chmodSync(sock, 0o600); } catch { /* best effort */ } }
    const descriptor = { schema: SCHEMA, pid: process.pid, socket: sock, token, startedAt: new Date().toISOString() };
    const descFile = path.join(dir, `recommend-${process.pid}.json`);
    const tmp = `${descFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(descriptor), { mode: 0o600 });
    fs.renameSync(tmp, descFile);
    const cleanup = () => {
      try { fs.rmSync(descFile, { force: true }); } catch { /* gone */ }
      if (process.platform !== 'win32') { try { fs.rmSync(sock, { force: true }); } catch { /* gone */ } }
    };
    process.once('exit', cleanup);
    // A SIGTERM'd worker (the parent's idle/timeout kill) never reaches 'exit'; without this its socket
    // and descriptor would sit in run/ forever. Exit status stays the signal's conventional failure.
    for (const sig of signals ? ['SIGTERM', 'SIGINT'] : []) {
      process.once(sig, () => { cleanup(); process.exit(sig === 'SIGTERM' ? 143 : 130); });
    }
    server.unref();
    log(`[recommend-endpoint] listening at ${sock}`);
    return { descriptor, close: () => { server.close(); cleanup(); } };
  } catch (e) {
    log(`[recommend-endpoint] not started: ${e.message}`);
    return null;
  }
}
