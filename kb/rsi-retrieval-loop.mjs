/**
 * kb/rsi-retrieval-loop.mjs — ADR-099 Entry Index + Closed-Loop Retrieval RSI.
 *
 * 1. Serves question-to-passage entry lookups from:
 *    - entry-index.d2q.rvf   (base doc2query + README/doc entry points)
 *    - rsi-learned.d2q.rvf   (replay-verified question -> exact passage promotions from live use)
 * 2. Observes every live retrieval into ~/.cache/ruvnet-brain/rsi-retrieval-ledger.jsonl
 *    (append-only, real queries only — never synthetic padding).
 * 3. Promotes verified high-confidence (ceScore >= 2.0, grounded) answers into rsi-learned.d2q.rvf
 *    with automatic pre-write snapshot backup so every promotion is 100% rollbackable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEDGER_PATH = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'rsi-retrieval-ledger.jsonl');
const openCache = new Map(); // filePath -> { db, meta, mtimeMs }

export function hasEntryIndexes(dir) {
  if (!dir) return false;
  return ['rsi-learned', 'entry-index'].some((b) =>
    fs.existsSync(path.join(dir, `${b}.d2q.rvf`)) && fs.existsSync(path.join(dir, `${b}.d2q.meta.json`)));
}

function loadIndexPair(dir, baseName, RvfDatabase) {
  try {
    const rvfPath = path.join(dir, `${baseName}.d2q.rvf`);
    const metaPath = path.join(dir, `${baseName}.d2q.meta.json`);
    if (!fs.existsSync(rvfPath) || !fs.existsSync(metaPath)) return null;
    const st = fs.statSync(rvfPath);
    const cached = openCache.get(rvfPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached;
    if (cached?.db?.close) { try { cached.db.close(); } catch {} }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const entries = Array.isArray(meta?.entries) ? meta.entries : [];
    const openFn = typeof RvfDatabase.openReadonly === 'function'
      ? (p) => RvfDatabase.openReadonly(p)
      : (p) => RvfDatabase.open(p);
    const loading = Promise.resolve(openFn(rvfPath)).catch((err) => {
      openCache.delete(rvfPath);
      throw err;
    });
    const opened = { rvfPath, metaPath, mtimeMs: st.mtimeMs, entries, db: null, loading };
    openCache.set(rvfPath, opened);
    return opened;
  } catch {
    return null;
  }
}

/**
 * Query both base doc2query entry index and RSI-learned entry index using the already-computed
 * 768d BGE query vector. Returns ranked { repo, path, question, distance, source } hits.
 */
export async function queryEntryIndexes({ dir, queryVec, repos = null, RvfDatabase, k = 16, maxDist = 0.48 }) {
  if (!queryVec || !RvfDatabase) return [];
  const allowed = repos && repos.length ? new Set(repos.map((r) => String(r).toLowerCase())) : null;
  const out = [];
  const seen = new Set();

  for (const baseName of ['rsi-learned', 'entry-index']) {
    const pair = loadIndexPair(dir, baseName, RvfDatabase);
    if (!pair) continue;
    try {
      if (!pair.db && pair.loading) {
        pair.db = await pair.loading;
        pair.loading = null;
      }
      if (!pair.db) continue;
      const hits = await pair.db.query(Array.from(queryVec), Math.max(k * 2, 24));
      for (const h of hits || []) {
        const dist = Number(h.distance ?? h.score ?? 1);
        if (!Number.isFinite(dist) || dist > maxDist) continue;
        const entry = pair.entries[Number(h.id) - 1];
        if (!entry?.repo || !entry?.path) continue;
        if (allowed && !allowed.has(String(entry.repo).toLowerCase())) continue;
        const key = `${entry.repo.toLowerCase()}::${entry.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          repo: entry.repo,
          path: entry.path,
          question: entry.question || '',
          distance: dist,
          source: baseName === 'rsi-learned' ? 'rsi-learned' : (entry.source || 'doc2query'),
        });
        if (out.length >= k) break;
      }
    } catch {
      // Never break primary retrieval if optional entry index fails
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, k);
}

/**
 * Append a real live retrieval observation to the append-only RSI ledger.
 * Zero synthetic rows; skips during eval/test runs when RUVNET_RSI_OBSERVE=0.
 */
export function recordRetrievalObservation({ query, repo, citedPath, ceScore, grounded, lane }) {
  if (process.env.RUVNET_RSI_OBSERVE === '0' || !query) return;
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      query: String(query).slice(0, 300),
      repo: repo || null,
      path: citedPath || null,
      ceScore: typeof ceScore === 'number' && Number.isFinite(ceScore) ? +ceScore.toFixed(4) : null,
      grounded: Boolean(grounded),
      lane: lane || 'unknown',
    };
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(row) + '\n');
  } catch {
    // Non-fatal observability write
  }
}

/**
 * Promote verified high-confidence observations (ceScore >= minCe, grounded, real repo file)
 * from rsi-retrieval-ledger.jsonl into rsi-learned.d2q.rvf with automatic backup snapshot.
 */
export async function promoteVerifiedLedgerEntries({ dir, embedFn, RvfDatabase, minCe = 2.0, maxNew = 200 }) {
  if (!fs.existsSync(LEDGER_PATH)) return { promoted: 0, totalLearned: 0, reason: 'no ledger yet' };
  const lines = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const candidates = [];
  const seenQ = new Set();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (!r.grounded || !r.repo || !r.path || typeof r.ceScore !== 'number' || r.ceScore < minCe) continue;
      if (/^evals\/runs\//i.test(r.path)) continue;
      const norm = String(r.query || '').trim().toLowerCase();
      if (!norm || norm.length < 12 || seenQ.has(norm)) continue;
      seenQ.add(norm);
      candidates.push({ repo: r.repo, path: r.path, question: r.query.trim(), ceScore: r.ceScore, source: 'rsi-promoted', promotedAt: new Date().toISOString() });
    } catch {}
  }
  const metaPath = path.join(dir, 'rsi-learned.d2q.meta.json');
  const rvfPath = path.join(dir, 'rsi-learned.d2q.rvf');
  let existing = [];
  if (fs.existsSync(metaPath)) {
    try { existing = JSON.parse(fs.readFileSync(metaPath, 'utf8')).entries || []; } catch {}
  }
  const existingQ = new Set(existing.map((e) => String(e.question || '').trim().toLowerCase()));
  const fresh = candidates.filter((c) => !existingQ.has(c.question.toLowerCase())).slice(0, maxNew);
  if (!fresh.length) return { promoted: 0, totalLearned: existing.length, reason: 'already up to date' };

  // Snapshot before mutating (100% rollbackable)
  if (fs.existsSync(rvfPath)) fs.copyFileSync(rvfPath, `${rvfPath}.bak`);
  if (fs.existsSync(`${rvfPath}.idmap.json`)) fs.copyFileSync(`${rvfPath}.idmap.json`, `${rvfPath}.idmap.json.bak`);
  if (fs.existsSync(metaPath)) fs.copyFileSync(metaPath, `${metaPath}.bak`);

  const allEntries = [...existing, ...fresh];
  const tmpRvf = `${rvfPath}.tmp`;
  fs.rmSync(tmpRvf, { force: true });
  fs.rmSync(`${tmpRvf}.idmap.json`, { force: true });
  const db = await RvfDatabase.create(tmpRvf, { dimensions: 768, metric: 'cosine', overwrite: true });
  const batch = [];
  for (let i = 0; i < allEntries.length; i++) {
    const vec = await embedFn(allEntries[i].question);
    batch.push({ id: String(i + 1), vector: Array.from(vec) });
    if (batch.length === 32 || i === allEntries.length - 1) await db.ingestBatch(batch.splice(0));
  }
  if (db.close) await db.close();
  fs.renameSync(tmpRvf, rvfPath);
  if (fs.existsSync(`${tmpRvf}.idmap.json`)) fs.renameSync(`${tmpRvf}.idmap.json`, `${rvfPath}.idmap.json`);
  fs.writeFileSync(metaPath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    model: 'Xenova/bge-base-en-v1.5',
    dimensions: 768,
    entries: allEntries,
  }, null, 2) + '\n');
  openCache.delete(rvfPath);
  return { promoted: fresh.length, totalLearned: allEntries.length };
}

/** Roll back rsi-learned.d2q.rvf to its pre-promotion snapshot. */
export function rollbackRsiLearned(dir) {
  const rvfPath = path.join(dir, 'rsi-learned.d2q.rvf');
  const metaPath = path.join(dir, 'rsi-learned.d2q.meta.json');
  if (!fs.existsSync(`${rvfPath}.bak`) || !fs.existsSync(`${metaPath}.bak`)) {
    return { ok: false, error: 'No RSI rollback snapshot available yet.' };
  }
  fs.copyFileSync(`${rvfPath}.bak`, rvfPath);
  if (fs.existsSync(`${rvfPath}.idmap.json.bak`)) fs.copyFileSync(`${rvfPath}.idmap.json.bak`, `${rvfPath}.idmap.json`);
  fs.copyFileSync(`${metaPath}.bak`, metaPath);
  openCache.delete(rvfPath);
  return { ok: true };
}

/** Live RSI statistics for the Console Problem Radar & Memory tab. */
export function getRsiStats(dir = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb')) {
  const readMeta = (name) => {
    const p = path.join(dir, `${name}.d2q.meta.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const base = readMeta('entry-index');
  const learned = readMeta('rsi-learned');
  let ledgerEvents = 0;
  let lastObservedAt = null;
  if (fs.existsSync(LEDGER_PATH)) {
    try {
      const lines = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean);
      ledgerEvents = lines.length;
      if (lines.length) lastObservedAt = JSON.parse(lines[lines.length - 1]).ts || null;
    } catch {}
  }
  return {
    baseEntries: base?.entries?.length || 0,
    baseBuiltAt: base?.updatedAt || null,
    learnedEntries: learned?.entries?.length || 0,
    lastPromotedAt: learned?.updatedAt || null,
    ledgerEvents,
    lastObservedAt,
    rollbackAvailable: fs.existsSync(path.join(dir, 'rsi-learned.d2q.rvf.bak')),
  };
}
