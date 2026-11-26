/**
 * kb/rsi-retrieval-loop.mjs — ADR-099 Entry Index + Closed-Loop Retrieval RSI + ADR-304 Receipts.
 *
 * 1. Serves question-to-passage entry lookups from:
 *    - entry-index.d2q.rvf   (base doc2query + README/doc entry points)
 *    - rsi-learned.d2q.rvf   (shadow-verified question -> exact passage promotions from live use)
 * 2. Observes live retrievals into ~/.cache/ruvnet-brain/rsi-retrieval-ledger.jsonl
 *    (append-only, real queries only — skipped during VITEST / RUVNET_RSI_OBSERVE=0).
 * 3. Promotes verified high-confidence entries into rsi-learned.d2q.rvf ONLY after
 *    openReadonly() shadow-branch round-trip ID + distance verification, snapshotting
 *    previous files strictly after shadow verification succeeds (100% rollbackable).
 * 4. Provides CausalRecall (bounded uplift), MMRDiversityRanker (tier-safe diversity),
 *    and full 64-char SHA-256 witness-chained ADR-304 retrieval receipts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getLedgerPath() {
  return path.join(os.homedir(), '.cache', 'ruvnet-brain', 'rsi-retrieval-ledger.jsonl');
}

const openCache = new Map(); // filePath -> { db, meta, mtimeMs, metaMtimeMs }
const causalCache = new Map(); // ledgerPath -> { sig, counts }
let lastReceiptHash = '0'.repeat(64);

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
    const mst = fs.statSync(metaPath);
    const cached = openCache.get(rvfPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.metaMtimeMs === mst.mtimeMs) return cached;
    if (cached?.db?.close) { Promise.resolve(cached.db.close()).catch(() => {}); }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const entries = Array.isArray(meta?.entries) ? meta.entries : [];
    const openFn = typeof RvfDatabase.openReadonly === 'function'
      ? (p) => RvfDatabase.openReadonly(p)
      : (p) => RvfDatabase.open(p);
    const loading = Promise.resolve(openFn(rvfPath)).catch((err) => {
      openCache.delete(rvfPath);
      throw err;
    });
    const opened = { rvfPath, metaPath, mtimeMs: st.mtimeMs, metaMtimeMs: mst.mtimeMs, entries, db: null, loading };
    openCache.set(rvfPath, opened);
    return opened;
  } catch {
    return null;
  }
}

export async function queryEntryIndexes({ dir, queryVec, repos = null, RvfDatabase, k = 16, maxDist = 0.48 } = {}) {
  if (!queryVec || !RvfDatabase || !dir) return [];
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

export function recordRetrievalObservation({ query, repo, citedPath, ceScore, grounded, lane } = {}) {
  if (process.env.RUVNET_RSI_OBSERVE === '0' || process.env.VITEST || !query) return;
  try {
    const ledgerPath = getLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      query: String(query).slice(0, 300),
      repo: typeof repo === 'string' && repo ? repo : null,
      path: typeof citedPath === 'string' && citedPath ? citedPath : null,
      ceScore: typeof ceScore === 'number' && Number.isFinite(ceScore) ? +ceScore.toFixed(4) : null,
      grounded: Boolean(grounded),
      lane: lane || 'unknown',
    };
    fs.appendFileSync(ledgerPath, JSON.stringify(row) + '\n');
  } catch {
    // Non-fatal observability write
  }
}

export async function promoteVerifiedLedgerEntries({
  dir,
  embedFn,
  RvfDatabase,
  minCe = 2.0,
  maxNew = 200,
  ledgerPath = getLedgerPath(),
} = {}) {
  if (!dir || typeof embedFn !== 'function' || !RvfDatabase?.create) {
    return { promoted: 0, totalLearned: 0, shadowVerified: false, error: 'Missing dir, embedFn, or RvfDatabase.create' };
  }
  if (!fs.existsSync(ledgerPath)) return { promoted: 0, totalLearned: 0, shadowVerified: true, reason: 'no ledger yet' };

  const safeMinCe = typeof minCe === 'number' && Number.isFinite(minCe) ? Math.max(0, minCe) : 2.0;
  const safeMaxNew = typeof maxNew === 'number' && Number.isFinite(maxNew) && maxNew > 0 ? Math.floor(maxNew) : 200;

  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
  const candidates = [];
  const seenQ = new Set();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (!r.grounded || typeof r.repo !== 'string' || !r.repo || typeof r.path !== 'string' || !r.path) continue;
      if (typeof r.ceScore !== 'number' || !Number.isFinite(r.ceScore) || r.ceScore < safeMinCe) continue;
      if (/^evals\/runs\//i.test(r.path)) continue;
      const norm = String(r.query || '').trim().toLowerCase();
      if (!norm || norm.length < 12 || seenQ.has(norm)) continue;
      seenQ.add(norm);
      candidates.push({
        repo: r.repo,
        path: r.path,
        question: r.query.trim(),
        ceScore: r.ceScore,
        source: 'rsi-promoted',
        promotedAt: new Date().toISOString(),
      });
    } catch {}
  }

  const metaPath = path.join(dir, 'rsi-learned.d2q.meta.json');
  const rvfPath = path.join(dir, 'rsi-learned.d2q.rvf');
  let existing = [];
  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!Array.isArray(parsed?.entries)) throw new Error('entries missing');
      existing = parsed.entries;
    } catch (err) {
      return { promoted: 0, totalLearned: 0, shadowVerified: false, error: `Corrupt existing meta.json: ${err.message}` };
    }
  }
  const existingQ = new Set(existing.map((e) => String(e.question || '').trim().toLowerCase()));
  const fresh = candidates.filter((c) => !existingQ.has(c.question.toLowerCase())).slice(0, safeMaxNew);
  if (!fresh.length) return { promoted: 0, totalLearned: existing.length, shadowVerified: true, reason: 'already up to date' };

  const allEntries = [...existing, ...fresh];
  const shadowRvf = `${rvfPath}.shadow`;
  const cleanupShadow = () => {
    fs.rmSync(shadowRvf, { force: true });
    fs.rmSync(`${shadowRvf}.idmap.json`, { force: true });
  };
  cleanupShadow();

  const sampleVecs = [];
  let db = null;
  try {
    db = await RvfDatabase.create(shadowRvf, { dimensions: 768, metric: 'cosine', overwrite: true });
    const batch = [];
    for (let i = 0; i < allEntries.length; i++) {
      const vec = await embedFn(allEntries[i].question);
      const arr = Array.from(vec || []);
      if (arr.length !== 768 || arr.some((x) => !Number.isFinite(x))) {
        throw new Error(`Invalid embedding vector at index ${i}`);
      }
      const id = String(i + 1);
      batch.push({ id, vector: arr });
      if (i === 0 || (i >= existing.length && sampleVecs.length < 4)) {
        sampleVecs.push({ id, vector: arr });
      }
      if (batch.length === 32 || i === allEntries.length - 1) await db.ingestBatch(batch.splice(0));
    }
  } catch (err) {
    if (db?.close) { try { await db.close(); } catch {} }
    cleanupShadow();
    return { promoted: 0, totalLearned: existing.length, shadowVerified: false, error: err?.message || String(err) };
  }
  if (db?.close) { try { await db.close(); } catch {} }

  // Shadow-branch round-trip verification (requires openReadonly, checks exact ID + cosine distance)
  if (typeof RvfDatabase.openReadonly !== 'function') {
    cleanupShadow();
    return { promoted: 0, totalLearned: existing.length, shadowVerified: false, error: 'RvfDatabase.openReadonly unavailable for shadow verification' };
  }
  let verifyDb = null;
  try {
    verifyDb = await RvfDatabase.openReadonly(shadowRvf);
    for (const s of sampleVecs) {
      const res = await verifyDb.query(s.vector, 3);
      const top = res?.[0];
      const dist = Number(top?.distance ?? 1);
      if (!top || String(top.id) !== String(s.id) || !Number.isFinite(dist) || dist > 0.25) {
        throw new Error(`Shadow-branch verification failed for id=${s.id} (got id=${top?.id}, dist=${dist})`);
      }
    }
  } catch (err) {
    if (verifyDb?.close) { try { await verifyDb.close(); } catch {} }
    cleanupShadow();
    return { promoted: 0, totalLearned: existing.length, shadowVerified: false, error: err?.message || String(err) };
  }
  if (verifyDb?.close) { try { await verifyDb.close(); } catch {} }

  // Snapshot prior good files ONLY AFTER shadow verification passes
  if (fs.existsSync(rvfPath)) fs.copyFileSync(rvfPath, `${rvfPath}.bak`);
  if (fs.existsSync(`${rvfPath}.idmap.json`)) fs.copyFileSync(`${rvfPath}.idmap.json`, `${rvfPath}.idmap.json.bak`);
  if (fs.existsSync(metaPath)) fs.copyFileSync(metaPath, `${metaPath}.bak`);

  const tmpMeta = `${metaPath}.tmp`;
  fs.writeFileSync(tmpMeta, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    model: 'Xenova/bge-base-en-v1.5',
    dimensions: 768,
    entries: allEntries,
  }, null, 2) + '\n');
  fs.renameSync(shadowRvf, rvfPath);
  if (fs.existsSync(`${shadowRvf}.idmap.json`)) fs.renameSync(`${shadowRvf}.idmap.json`, `${rvfPath}.idmap.json`);
  fs.renameSync(tmpMeta, metaPath);
  openCache.delete(rvfPath);
  return { promoted: fresh.length, totalLearned: allEntries.length, shadowVerified: true };
}

export function rollbackRsiLearned(dir) {
  if (!dir) return { ok: false, error: 'Missing dir.' };
  const rvfPath = path.join(dir, 'rsi-learned.d2q.rvf');
  const metaPath = path.join(dir, 'rsi-learned.d2q.meta.json');
  if (!fs.existsSync(`${rvfPath}.bak`) || !fs.existsSync(`${metaPath}.bak`)) {
    return { ok: false, error: 'No RSI rollback snapshot available yet.' };
  }
  const tmpRvf = `${rvfPath}.rb.tmp`;
  const tmpMeta = `${metaPath}.rb.tmp`;
  fs.copyFileSync(`${rvfPath}.bak`, tmpRvf);
  fs.copyFileSync(`${metaPath}.bak`, tmpMeta);
  fs.renameSync(tmpRvf, rvfPath);
  fs.renameSync(tmpMeta, metaPath);
  if (fs.existsSync(`${rvfPath}.idmap.json.bak`)) {
    const tmpMap = `${rvfPath}.idmap.rb.tmp`;
    fs.copyFileSync(`${rvfPath}.idmap.json.bak`, tmpMap);
    fs.renameSync(tmpMap, `${rvfPath}.idmap.json`);
  } else {
    fs.rmSync(`${rvfPath}.idmap.json`, { force: true });
  }
  openCache.delete(rvfPath);
  return { ok: true };
}

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
  const ledgerPath = getLedgerPath();
  if (fs.existsSync(ledgerPath)) {
    try {
      const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
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

function loadCausalCounts(ledgerPath) {
  try {
    if (!ledgerPath || !fs.existsSync(ledgerPath)) return new Map();
    const st = fs.statSync(ledgerPath);
    const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const cached = causalCache.get(ledgerPath);
    if (cached && cached.sig === sig) return cached.counts;

    // Bounded tail-read (last 256 KB) so an unbounded append-only ledger stays O(1)
    const readLen = Math.min(st.size, 262144);
    const buf = Buffer.allocUnsafe(readLen);
    const fd = fs.openSync(ledgerPath, 'r');
    try { fs.readSync(fd, buf, 0, readLen, Math.max(0, st.size - readLen)); } finally { fs.closeSync(fd); }

    const counts = new Map();
    const lines = buf.toString('utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (!r.grounded || typeof r.repo !== 'string' || !r.repo || typeof r.path !== 'string' || !r.path) continue;
        if (/^evals\/runs\//i.test(r.path)) continue;
        if (typeof r.ceScore !== 'number' || !Number.isFinite(r.ceScore) || r.ceScore < 2.0) continue;
        const key = `${r.repo.toLowerCase()}::${r.path}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      } catch {}
    }
    causalCache.set(ledgerPath, { sig, counts });
    return counts;
  } catch {
    return new Map();
  }
}

/**
 * CausalRecall — bounded, log-damped uplift (+0.00 to +0.35 logits) for passages proven useful
 * in real grounded sessions. Never boosts negative-logit candidates; deterministic in tests.
 */
export function applyCausalRecall(candidates, opts = {}) {
  if (!Array.isArray(candidates)) return [];
  if (!candidates.length) return [];
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const explicitLedger = typeof safeOpts.ledgerPath === 'string' && safeOpts.ledgerPath;
  if (!explicitLedger && (process.env.VITEST || process.env.RUVNET_RSI_OBSERVE === '0')) {
    return candidates;
  }
  const counts = loadCausalCounts(explicitLedger ? safeOpts.ledgerPath : getLedgerPath());
  if (!counts.size) return candidates;
  let touched = false;
  const out = candidates.map((c, idx) => {
    const ce = typeof c?.ceScore === 'number' && !Number.isNaN(c.ceScore) ? c.ceScore : null;
    if (ce == null || !Number.isFinite(ce) || ce < 0) return { c, idx, score: ce ?? -Infinity };
    const repo = typeof c.repo === 'string' ? c.repo : '';
    const p = typeof c.path === 'string' ? c.path : '';
    const n = repo && p ? (counts.get(`${repo.toLowerCase()}::${p}`) || 0) : 0;
    if (!n) return { c, idx, score: ce };
    const uplift = Math.min(0.35, 0.12 * Math.log1p(n));
    touched = true;
    return {
      c: { ...c, _causalUplift: +uplift.toFixed(4), _causalScore: +(ce + uplift).toFixed(4) },
      idx,
      score: ce + uplift,
    };
  });
  if (!touched) return candidates;
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out.map((x) => x.c);
}

function tokenSet(item) {
  const s = `${item?.title || ''} ${item?.path || ''} ${(item?.fullText || item?.preview || item?.text || '').slice(0, 320)}`.toLowerCase();
  return new Set(s.split(/[^a-z0-9_]+/).filter((w) => w.length >= 3));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * MMRDiversityRanker — preserves #1 unconditionally, respects strict k bounds, never promotes
 * a negative-logit hit above a positive-logit hit, and balances relevance vs redundancy.
 */
export function applyMmrDiversity(results, opts = {}) {
  if (!Array.isArray(results) || !results.length) return [];
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const rawK = safeOpts.k === undefined ? 6 : Number(safeOpts.k);
  if (!Number.isFinite(rawK) || rawK <= 0) return [];
  const limit = Math.min(Math.floor(rawK), results.length);
  if (limit === 1 || results.length <= 2) return results.slice(0, limit);

  const rawLambda = safeOpts.lambda === undefined ? 0.78 : Number(safeOpts.lambda);
  const lambda = Number.isFinite(rawLambda) ? Math.min(1, Math.max(0, rawLambda)) : 0.78;

  const scoreOf = (r) => {
    const s = r?._causalScore ?? r?.ceScore;
    return typeof s === 'number' && Number.isFinite(s) ? s : -Infinity;
  };
  const scores = results.map(scoreOf);
  const finiteScores = scores.filter(Number.isFinite);
  const maxS = finiteScores.length ? Math.max(...finiteScores) : 0;
  const minS = finiteScores.length ? Math.min(...finiteScores) : 0;
  const span = Math.max(2.0, maxS - minS);
  const norm = scores.map((s) => (Number.isFinite(s) ? 1 - (maxS - s) / span : -1));
  const toks = results.map(tokenSet);

  const pickFromTier = (pickedIdx, poolIndices) => {
    const remaining = new Set(poolIndices);
    while (pickedIdx.length < limit && remaining.size > 0) {
      let bestI = -1;
      let bestMmr = -Infinity;
      for (const i of remaining) {
        let maxSim = 0;
        for (const j of pickedIdx) {
          const lex = jaccard(toks[i], toks[j]);
          const rI = typeof results[i]?.repo === 'string' ? results[i].repo.toLowerCase() : '';
          const rJ = typeof results[j]?.repo === 'string' ? results[j].repo.toLowerCase() : '';
          const sameRepo = rI && rJ && rI === rJ ? 0.25 : 0;
          const sim = Math.min(1, lex + sameRepo);
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = lambda * norm[i] - (1 - lambda) * maxSim;
        if (mmr > bestMmr) { bestMmr = mmr; bestI = i; }
      }
      if (bestI < 0) break;
      pickedIdx.push(bestI);
      remaining.delete(bestI);
    }
  };

  const pickedIdx = [0]; // Never demote #1
  const posTier = [];
  const negTier = [];
  for (let i = 1; i < results.length; i++) {
    if (scores[i] >= 0) posTier.push(i);
    else negTier.push(i);
  }
  pickFromTier(pickedIdx, posTier);
  pickFromTier(pickedIdx, negTier);
  return pickedIdx.map((i) => results[i]);
}

/**
 * ADR-304 Witness-Chained Retrieval Receipt — full 64-char SHA-256 verifiable provenance record.
 */
export function createRetrievalReceipt(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const query = safeOpts.query || '';
  const results = Array.isArray(safeOpts.results) ? safeOpts.results : [];
  const lane = safeOpts.lane || 'unknown';
  const ts = typeof safeOpts.ts === 'string' && safeOpts.ts ? safeOpts.ts : new Date().toISOString();
  const schema = 'adr-304-retrieval-receipt/v1';
  const queryHash = crypto.createHash('sha256').update(String(query)).digest('hex');
  const items = results.slice(0, 8).map((r) => ({
    repo: r?.repo || null,
    path: r?.path || null,
    ce: typeof r?.ceScore === 'number' && Number.isFinite(r.ceScore) ? +r.ceScore.toFixed(4) : null,
  }));
  const prevHash = typeof safeOpts.prevHash === 'string' && safeOpts.prevHash ? safeOpts.prevHash : lastReceiptHash;
  const resultCount = results.length;
  const payload = JSON.stringify({ schema, prevHash, ts, queryHash, lane, resultCount, items });
  const receiptHash = crypto.createHash('sha256').update(payload).digest('hex');
  if (!safeOpts.prevHash) lastReceiptHash = receiptHash;
  return { schema, ts, queryHash, lane, resultCount, prevHash, receiptHash, items };
}
