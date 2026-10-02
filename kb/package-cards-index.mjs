/**
 * package-cards-index.mjs — the SEMANTIC lane of the package recommender (ADR-093 rev 2).
 *
 * Lives in kb/ because it runs inside the warm search worker (forge-mcp-all.mjs), which already holds
 * the bge-base query embedder; and kb/ may not import the plugin (issue #32).
 *
 * BUILD (offline, once per card set): embed every package card's text with the SAME bge-base passage
 * configuration the corpus stores use (CLS pooling, normalized, NO prefix) and ingest the vectors into
 * `package-cards.rvf` with @ruvector/rvf. The card JSON beside it maps RVF ids to cards.
 *
 * QUERY (warm worker, per prompt): embed the prompt with the corpus QUERY configuration (bge
 * instruction prefix, the asymmetric half), `db.query()` the RVF for nearest cards, collapse each
 * family to its best member, and return the ranked list with cosine similarity. No hand-rolled
 * cosine: RVF computes the distance; similarity is reported as 1 − distance.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadRvf, closeReadonlyRvf } from './resolve-deps.mjs';

export const CARDS_JSON = 'package-cards.json';
export const CARDS_RVF = 'package-cards.rvf';
export const EMBED_CFG = Object.freeze({
  model: 'Xenova/bge-base-en-v1.5',
  dimensions: 768,
  pooling: 'cls',
  normalize: true,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
});
const PASSAGE_CFG = Object.freeze({ ...EMBED_CFG, queryPrefix: '' });

/** The text a card is embedded as: its name, its manifest description, its manifest keywords. */
export function cardEmbeddingText(card) {
  const short = String(card.id || '').replace(/^@[^/]+\//, '');
  const kw = (card.keywords || []).filter((k) => !/^(ruv|ruvector|ruvnet|rust|napi|napi-rs|wasm|webassembly|native|simd|fast|performance)$/.test(k));
  return `${short}: ${card.description || ''}${kw.length ? `. Keywords: ${kw.join(', ')}` : ''}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function embedder() {
  const { __embedInternals } = await import('./forge-ask.mjs');
  return __embedInternals.embed;
}

/** Build <dir>/package-cards.rvf from <dir>/package-cards.json. Returns { vectors, rvf }. */
export const DEFAULT_TIERS = Object.freeze(['T0', 'T1']);

export async function buildCardIndex(dir, { log = () => {}, tiers = DEFAULT_TIERS } = {}) {
  const raw = fs.readFileSync(path.join(dir, CARDS_JSON));
  const doc = JSON.parse(raw.toString('utf8'));
  // THE CATALOGUE IS THE CORE TIERS. RVF ids stay indices into the FULL card array, so the card JSON
  // is the one map; only cards whose store is in data/registry.tiers.json T0/T1 are embedded.
  const all = doc.cards || [];
  const cards = all.map((card, i) => ({ card, i })).filter(({ card }) => !tiers || tiers.includes(card.tier));
  const embed = await embedder();
  const { RvfDatabase } = loadRvf().mod;
  const out = path.join(dir, CARDS_RVF);
  for (const f of [out, `${out}.idmap.json`, `${out}.meta.json`]) fs.rmSync(f, { force: true });
  const db = await RvfDatabase.create(out, { dimensions: EMBED_CFG.dimensions, metric: 'cosine' });
  const BATCH = 32;
  let accepted = 0;
  let expected = 0;
  for (let i = 0; i < cards.length; i += BATCH) {
    const slice = cards.slice(i, i + BATCH);
    const rows = [];
    for (const { card, i: at } of slice) {
      // TWO VECTORS PER CARD when the package directory has a README: the manifest line says what it
      // IS, the README says what it is FOR, in the words a user is likelier to use. Query takes the
      // better of the two (family collapse below keeps one hit per card).
      rows.push({ id: `${at}`, vector: await embed(cardEmbeddingText(card), PASSAGE_CFG) });
      if (card.readme) rows.push({ id: `${at}.r`, vector: await embed(`${String(card.id).replace(/^@[^/]+\//, '')}: ${card.readme}`, PASSAGE_CFG) });
    }
    expected += rows.length;
    accepted += (await db.ingestBatch(rows)).accepted;
    log(`[package-cards-index] ${Math.min(i + BATCH, cards.length)}/${cards.length}`);
  }
  await db.close();
  fs.writeFileSync(`${out}.meta.json`, `${JSON.stringify({ tiers, vectors: accepted, embed: EMBED_CFG, cards: CARDS_JSON, cardsSha256: sha256(raw), rvfSha256: sha256(fs.readFileSync(out)) })}\n`);
  if (accepted !== expected) throw new Error(`package-cards.rvf holds ${accepted} of ${expected} vectors`);
  return { vectors: accepted, rvf: out };
}

/**
 * A loaded index. `query(prompt, k)` → [{ card, similarity }] best-first, one per family.
 * Opened read-only once; the caller keeps it for the life of the warm worker.
 */
export async function openCardIndex(dir) {
  const cardsFile = path.join(dir, CARDS_JSON);
  const rvfFile = path.join(dir, CARDS_RVF);
  if (!fs.existsSync(cardsFile) || !fs.existsSync(rvfFile)) return null;
  const raw = fs.readFileSync(cardsFile);
  // STALENESS IS REFUSAL: an RVF whose ids were assigned against a different card file maps hits to the
  // wrong cards. The meta sidecar binds the vectors to the exact card bytes; any mismatch → no index.
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(`${rvfFile}.meta.json`, 'utf8')); } catch { return null; }
  if (meta?.cardsSha256 !== sha256(raw) || meta?.embed?.model !== EMBED_CFG.model) return null;
  // A torn or swapped .rvf must never reach the native reader inside the process that serves search.
  if (meta?.rvfSha256 !== sha256(fs.readFileSync(rvfFile))) return null;
  const cards = JSON.parse(raw.toString('utf8')).cards || [];
  const { RvfDatabase } = loadRvf().mod;
  const db = await RvfDatabase.openReadonly(rvfFile);
  const embed = await embedder();
  return {
    size: cards.length,
    async query(prompt, k = 8) {
      const qv = await embed(String(prompt || ''), EMBED_CFG);
      const hits = await db.query(qv, Math.max(k * 3, 24));
      const seen = new Set();
      const out = [];
      for (const h of hits) {
        const card = cards[Number.parseInt(String(h.id), 10)];
        if (!card) continue;
        const fam = `${card.store}:${card.family}`;
        if (seen.has(fam)) continue;
        seen.add(fam);
        out.push({ card, similarity: 1 - h.distance });
        if (out.length >= k) break;
      }
      return out;
    },
    async close() { await closeReadonlyRvf(db); },
  };
}
