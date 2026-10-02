// package-recommender.mjs — "what would rUv do?" over PACKAGE-LEVEL capability cards (ADR-0093,
// status Proposed). A pure matcher: prompt text in, at most ONE package card out, or null (silence).
// No IO except reading the card file once; no child process; no network; no embedder.
//
// WHY IT EXISTS. advocacy-catalog.mjs is a closed list of seven intents bound to seven building
// blocks. On 2026-09-30 the owner had to name @ruvector/typesafe himself — a package whose manifest
// the Brain had ingested — because nothing on the hook path could reach any package the catalogue's
// author had not hand-written. This matcher reads the cards scripts/package-cards.mjs derives from the
// corpus's own manifests, so a package rUv ships tonight is recommendable after the next card build
// with no code change.
//
// WHY LEXICAL. Same reason as advocacy-route.mjs and kb/card-lane.mjs: an embedder's cold init is
// ~3 s against a 3 s hook timeout. This is the card lane's discipline — content-token overlap gated by
// a minimum overlap, a coverage floor and a winner margin — with one addition the lane does not need:
// IDF weighting. ~800 package cards share a lot of vocabulary ("vector", "search", "rust", "fast");
// a word that half the cards carry says nothing about which card is meant.
//
// WHY THE TOKENIZER IS A COPY. The plugin and the knowledge bundle ship separately and cannot import
// each other (issue #32). The tokenizer below is the card lane's contentTokens() without its query
// phrase rewrites, and tests/unit/package-recommender.test.mjs holds the two equal on a shared table.
//
// SILENCE IS THE DEFAULT. Null for: short text, no design/diagnosis cue, no card clearing every gate,
// or a near-tie. A recommender that speaks on a coincidence is the nag ADR-028 exists to prevent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateHashOf } from './advocacy-outcomes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = path.join(HERE, 'package-cards.json');
export const SCHEMA = 'ruvnet-brain.package-cards/1';

// ── Tokenizer (held equal to kb/card-lane.mjs contentTokens by test) ─────────────────────────────
export const STOPWORDS = new Set(`
  a an the of and or but if then else for to from in on at by with without into onto over under
  is are was were be been being do does did doing done can could should would will shall may might
  what which who whom whose when where why how
  this that these those it its i you he she they we my your his her their our
  need needs want wants use uses using used tool tools reach like ask asks question questions
  have has had not no nor so such too very just about also
  each other
`.trim().split(/\s+/));

const normalizeApostrophes = (text) => String(text ?? '').replace(/[‘’ʼ]/g, "'");

export function lexTokens(text) {
  const raw = normalizeApostrophes(text).toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*[a-z0-9]|[a-z0-9]/g) || [];
  const out = new Set();
  for (const t of raw) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
    if (t.includes('-')) for (const part of t.split('-')) if (part.length >= 3 && !STOPWORDS.has(part)) out.add(part);
  }
  return [...out];
}

/**
 * A deliberately light suffix stripper applied to BOTH sides at scoring time, so "permitted" meets
 * "permit" and "queries" meets "query". Not Porter: four rules, length-guarded, no dictionary.
 */
export function stem(t) {
  if (t.length <= 4 || t.includes('-') || /\d/.test(t)) return t;
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('ied')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.endsWith('eed') ? t : t.slice(0, -2).replace(/(.)\1$/, '$1');
  if (/(ss|us|is)$/.test(t)) return t;
  if (t.endsWith('es') && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
}

const scoringTokens = (text) => [...new Set(lexTokens(text).filter((t) => !GENERIC.has(t)).map(stem).filter((t) => !GENERIC.has(t)))];

// ── Scoring vocabulary ────────────────────────────────────────────────────────────────────────────
// Words that are true of almost every rUv package and of almost every prompt. They may still match,
// but they never count toward the overlap floor and carry no weight.
const GENERIC = new Set(`
  ruv ruvector ruvnet rust native napi napi-rs wasm webassembly node node.js nodejs typescript javascript
  fast faster high-performance performance simd optimized optimization library sdk cli bindings binding
  package module api based support system systems tool engine framework platform production ready
  agent agents agentic llm llms data build app application real-time time new run runs running
  every keep keeps get gets make makes one two way lot lots thing things work works working
  first right best good better instead just really basically whole same
`.trim().split(/\s+/));

// Ordinary-language → manifest-language expansions. Generic vocabulary bridges ONLY: each maps a word
// people say to the words manifests use. None names a package — naming a package here would rebuild
// the closed catalogue this module replaces.
const EXPANSIONS = [
  [/\b(classif\w*|categori[sz]\w*|triage|sort\w* (?:\w+ ){0,4}into)\b/g, 'classification decisions choice'],
  [/\b(sentiment|urgency)\b/g, 'decisions score confidence'],
  [/\bcalibrat\w*\b/g, 'calibration confidence'],
  [/\bintents?\b/g, 'intent intent-matching'],
  [/\bby meaning\b|\bsemantic(ally)?\b/g, 'semantic embeddings'],
  [/\b(exact (?:keyword|term|match)\w*|keyword match\w*|part numbers?|sku)\b/g, 'bm25 sparse keyword'],
  [/\b(fuse|merg\w*|combin\w*)\b[^.!?]{0,60}\b(rank\w*|results?|lists?)\b/g, 'fusion rrf hybrid-search'],
  [/\b(colbert|multi[- ]vector|late interaction)\b/g, 'maxsim multi-vector late interaction'],
  [/\b(re-?rank\w*|reorder\w*|ordering)\b/g, 'reranking rerank'],
  [/\bcach\w*\b/g, 'cache caching'],
  [/\b(prompt injection|jailbreak\w*|system prompt)\b/g, 'prompt-injection jailbreak-detection'],
  [/\bforg[eo]t\w*\b|\blong[- ]term memory\b/g, 'memory agent-memory persistent'],
  [/\b(pinecone|qdrant|weaviate|chroma)\b/g, 'vector database hnsw'],
  [/\b(postgres\w*|pgvector)\b/g, 'postgresql pgvector'],
  [/\b(ssd|on disk|fit in ram|billion)\b/g, 'diskann ssd billion-scale'],
  [/\bknowledge graph\b/g, 'knowledge-graph graph'],
  [/\b(roll(?:ed|ing)?(?: \w+)? back|rollback|branch\w*)\b/g, 'branching copy-on-write'],
  [/\bsynthetic\b/g, 'synthetic data generator'],
  [/\b(topological|critical path)\b/g, 'dag topological scheduling'],
  [/\b(latex|equations?)\b/g, 'latex ocr'],
  [/\bsparse linear\b|\blinear system\b/g, 'sparse linear solver'],
  [/\b(min(imum)?[- ]cut)\b/g, 'mincut minimum cut'],
  [/\bwi-?fi\b/g, 'wifi sensing csi'],
  [/\b(replica\w*|partition\w*)\b/g, 'replication conflict resolution'],
  [/\bleader election\b/g, 'raft consensus leader election'],
  [/\b(photos?|images?)\b/g, 'image'],
  [/\b(flaky|coverage)\b/g, 'flaky coverage quality'],
  [/\b(traffic )?spikes?\b/g, 'burst scaling traffic spikes'],
  [/\b(cheap\w*|expensive|bill)\b/g, 'cost routing model'],
];

// Two concepts that, TOGETHER, name a third: literal matching plus meaning-matching IS hybrid search.
const CONJUNCTIONS = [
  [/\b(keyword|exact|literal|bm25)\b/, /\b(semantic\w*|meaning|vector|similar\w*|embedding\w*)\b/, 'hybrid-search hybrid fusion'],
];

export function expand(text) {
  const lower = normalizeApostrophes(text).toLowerCase();
  const extra = [];
  for (const [re, add] of EXPANSIONS) { re.lastIndex = 0; if (re.test(lower)) extra.push(add); }
  for (const [a, b, add] of CONJUNCTIONS) if (a.test(lower) && b.test(lower)) extra.push(add);
  return extra.length ? `${lower} ${extra.join(' ')}` : lower;
}

// A recommendation is for DESIGN ("build/add/I want/how do we") or DIAGNOSIS ("slow/keeps/costs")
// turns. Status checks, chit-chat, git chores, and explanations get nothing.
const DESIGN = /\b(build|add|implement|design|architect|create|set ?up|wire|integrate|needs?|wants?|looking for|how (?:do|can|should) (?:i|we)|should (?:i|we)|is there a way|choose|pick|replace|swap|migrate|let|give|store|generate|extract|detect|decide|route|split|solve|schedule|match|combine|rerank|apply|make)\b/;
const DIAGNOSIS = /\b(slow|latency|broken|fail\w*|keeps?|doesn'?t|does not|isn'?t|won'?t|bad|poor|wrong|worse|weird|problems?|too (?:expensive|slow|high)|costs?|bill|spikes?|drift\w*|corrupt\w*|forg[eo]t\w*|leak\w*|flaky|falls? over|hammered|washes out|misses|brittle|off|tripled|doubled)\b/;
// A conversational opener ("ok", "yes", "run …") only marks a non-work turn when the turn is SHORT.
// Measured on the blind set (2026-10-01): "ok so I want each of our AI helpers to …" was silenced by
// an unconditional opener rule — owners dictate, and dictation starts with "ok so".
const NON_WORK = /^(ok|okay|yes|no|thanks|thank you|continue|go on|commit|push|run|explain|what is|what's|why|summari[sz]e|format|rename|draft|write me)\b/;
const NON_WORK_MAX_LEN = 60;

export function isDesignOrDiagnosis(text) {
  const t = normalizeApostrophes(text).trim().toLowerCase();
  if (t.length < 20 || (t.length <= NON_WORK_MAX_LEN && NON_WORK.test(t))) return false;
  return DESIGN.test(t) || DIAGNOSIS.test(t);
}

// ── Card index ────────────────────────────────────────────────────────────────────────────────────
function cardText(card) {
  const short = String(card.id || '').replace(/^@[^/]+\//, '');
  return `${short} ${card.family || ''} ${card.description || ''} ${(card.keywords || []).join(' ')}`;
}

/** Build the scoring index once per process: per-card token sets + IDF over the whole card set. */
/**
 * The tokenizer identity. The card generator stores each card's scoring tokens pre-computed under
 * this version (cold-start cost: tokenizing ~800 cards was ~35 ms per prompt). A card file stamped
 * with any other version is re-tokenized here, so a stale precompute can cost time but never
 * correctness. tests/unit/package-recommender.test.mjs fails if the snapshot's stored tokens differ
 * from what this code computes — bump the version whenever STOPWORDS, GENERIC or stem() change.
 */
export const TOKENIZER_VERSION = 'pkgrec-tok/1';

/** A card's scoring token sets: `t` over all its text, `s` (strong) over its name and keywords. */
export function cardTokenSets(card) {
  return {
    t: scoringTokens(cardText(card)),
    s: scoringTokens(`${card.id} ${card.family || ''} ${(card.keywords || []).join(' ')}`),
  };
}

export function indexCards(doc) {
  const cards = Array.isArray(doc?.cards) ? doc.cards.filter((c) => c && typeof c.id === 'string' && typeof c.source === 'string') : [];
  const precomputed = doc?.tokenizer === TOKENIZER_VERSION;
  const entries = cards.map((card) => {
    const sets = precomputed && Array.isArray(card.t) && Array.isArray(card.s) ? card : cardTokenSets(card);
    return { card, tokens: new Set(sets.t), strong: new Set(sets.s) };
  });
  const df = new Map();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(1, entries.length);
  const idf = (t) => Math.log((n + 1) / ((df.get(t) || 0) + 1));
  return { entries, idf, n };
}

let _loaded = null; // { file, mtimeMs, size, index }

/** Candidate card files, highest precedence first: an explicit override, the bundle copy, the snapshot. */
export function cardFiles(env = process.env) {
  const out = [];
  if (env.RUVNET_PACKAGE_CARDS) out.push(env.RUVNET_PACKAGE_CARDS);
  const kb = env.RUVNET_BRAIN_KB || (env.RUVNET_BRAIN_HOME ? path.join(env.RUVNET_BRAIN_HOME, 'kb') : null);
  if (kb) out.push(path.join(kb, 'package-cards.json'));
  out.push(SNAPSHOT_FILE);
  return out;
}

/** Load + index the first readable, schema-valid card file. Null when none — never a fake index. */
export function loadIndex(files = cardFiles()) {
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (_loaded && _loaded.file === file && _loaded.mtimeMs === stat.mtimeMs && _loaded.size === stat.size) return _loaded.index;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc?.schema !== SCHEMA || !Array.isArray(doc.cards) || !doc.cards.length) continue;
      const index = { ...indexCards(doc), file, derivedFrom: doc.derivedFrom || null };
      _loaded = { file, mtimeMs: stat.mtimeMs, size: stat.size, index };
      return index;
    } catch { /* unreadable or malformed → try the next source */ }
  }
  return null;
}

// ── The gates (tuned on evals/recommendation-eval.v1.json split=dev ONLY; see ADR-0093) ──────────
export const GATES = Object.freeze({
  MIN_OVERLAP: 2,        // distinct non-generic tokens shared with the card
  MIN_STRONG: 1,         // at least one of them from the card's name/keywords, not only its prose
  MIN_SCORE: 7.0,        // IDF-weighted overlap
  MIN_COVERAGE: 0.15,    // share of the prompt's own non-generic tokens the card explains
  MARGIN: 1.25,          // winner score must be >= MARGIN x runner-up (a different family)
});

/**
 * Score every card; return the ranked list (for evaluation) and the decision (for the hook).
 * decision is { card, score, overlap, matched } or null with a reason.
 */
export function rank(prompt, index, gates = GATES) {
  if (!index) return { decision: null, reason: 'no-card-index', ranked: [] };
  if (!isDesignOrDiagnosis(prompt)) return { decision: null, reason: 'not-design-or-diagnosis', ranked: [] };
  const q = scoringTokens(expand(prompt));
  if (q.length < 2) return { decision: null, reason: 'too-few-content-words', ranked: [] };
  const ranked = [];
  for (const e of index.entries) {
    let score = 0; let strongHits = 0; const matched = [];
    for (const t of q) {
      if (!e.tokens.has(t)) continue;
      const w = index.idf(t) * (e.strong.has(t) ? 1.5 : 1);
      score += w; matched.push(t);
      if (e.strong.has(t)) strongHits++;
    }
    if (matched.length) ranked.push({ card: e.card, score, overlap: matched.length, strongHits, matched, coverage: matched.length / q.length });
  }
  // Code-unit order for the tie-break, NOT localeCompare: the first localeCompare in a cold process
  // initialises ICU collation (~15 ms measured), paid on every prompt by a hook.
  ranked.sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0));
  const top = ranked[0];
  if (!top) return { decision: null, reason: 'no-overlap', ranked };
  const rival = ranked.find((r) => r.card.family !== top.card.family || r.card.store !== top.card.store);
  if (top.overlap < gates.MIN_OVERLAP) return { decision: null, reason: 'overlap', ranked };
  if (top.strongHits < gates.MIN_STRONG && top.overlap < 3) return { decision: null, reason: 'no-strong-token', ranked };
  if (top.score < gates.MIN_SCORE) return { decision: null, reason: 'score', ranked };
  if (top.coverage < gates.MIN_COVERAGE) return { decision: null, reason: 'coverage', ranked };
  if (rival && top.score < gates.MARGIN * rival.score) return { decision: null, reason: 'margin', ranked };
  return { decision: top, reason: null, ranked };
}

/** The hook's entry point: the one card to recommend, or null. Never throws. */
export function recommend(prompt, { index } = {}) {
  try {
    const idx = index === undefined ? loadIndex() : index;
    const d = rank(prompt, idx).decision;
    if (!d) return null;
    // Name the PRODUCT's canonical install (ADR-093 rev 3), not whichever sibling package matched.
    const canon = d.card.canonical && d.card.canonical !== d.card.id ? idx.entries.find((e) => e.card.id === d.card.canonical)?.card : null;
    return canon ? { ...d, card: canon, matchedVia: d.card.id } : d;
  } catch { return null; }
}

/** One card per PRODUCT, named by its canonical install (ADR-093 rev 3). Unknown ids drop out. */
export function canonicalPicks(candidates, byId) {
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    const card = byId.get(c.id);
    if (!card) continue;
    const canon = (card.canonical && byId.get(card.canonical)) || card;
    const product = card.product || canon.id;
    if (seen.has(product)) continue;
    seen.add(product);
    out.push({ card: canon, similarity: c.similarity, matchedVia: card.id });
  }
  return out;
}

export { packageRecommenderEnabled, offerNames } from './package-recommender-flag.mjs';

/** The short name a user says back ("use typesafe"): the package id without its scope. */
export function shortName(card) {
  return String(card?.id || '').replace(/^@[^/]+\//, '');
}

/**
 * The advocacy candidate for one picked card: ONE line naming the package, its manifest description
 * and its source path. Same channel and aggregate shape as advocacy-route's catalogue candidate, so
 * unprompted-runtime applies the dial, the DismissalLedger and the OFFERED record unchanged.
 */
export function buildPackageCandidate({ prompt, pick, findingPrefix = 'recommend:pkg:' }) {
  const card = pick?.card;
  if (!card || typeof card.id !== 'string' || typeof card.source !== 'string') return null;
  const name = shortName(card);
  const description = String(card.description || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  return {
    channel: 'advocacy',
    effect: 'advisory',
    hookEventName: 'UserPromptSubmit',
    findingId: `${findingPrefix}${card.id}`,
    severity: 'normal',
    observationHash: stateHashOf([`package:${card.id}`]),
    copy: `[RuvNet Brain — rUv already ships this] If it genuinely fits this request, tell the user in ONE `
      + `sentence: "rUv ships ${card.id} — ${description} (source: ${card.source}). Say 'use ${name}' to proceed, or ignore this." `
      + 'Install state unknown from here; confirm with search_ruvnet before building, say it once, then carry on.',
    capability: name,
    package: card.id,
    source: card.source,
    sourceSha256: card.sourceSha256 || null,
    matched: Array.isArray(pick.matched) ? pick.matched : [],
    score: Number.isFinite(pick.score) ? +pick.score.toFixed(3) : null,
    promptHash: crypto.createHash('sha256').update(String(prompt || '').trim().toLowerCase()).digest('hex').slice(0, 16),
  };
}

// ── The semantic lane (ADR-093 rev 2) ────────────────────────────────────────────────────────────
// When a warm worker answers, the hook does NOT pick: it hands the host model the K nearest package
// cards and an instruction to mention at most ONE, and only if it genuinely fits. Measured on two blind
// sets with a model standing in for the host (evals/runs/2026-10-01-recommender-4.6/): the embedding is
// the better finder of candidates, the model the better judge of fit.
export const SEMANTIC_K = 4;
// ONE candidate set per session until a real host run shows the model stays quiet on negatives
// (adversarial review H1, 2026-10-01). Raise only on that evidence.
export const SEMANTIC_MAX_PER_SESSION = 1;
// Inject only when the NEAREST card clears this cosine similarity. Chosen on the self-authored set only
// (5th percentile of top-1 similarity among judge-correct hits = 0.532), then frozen; on the blinds it
// cut injections on negative prompts from 16/36 to 4/36 at a measured recall cost (ADR-093 rev 2).
export const SEMANTIC_MIN_SIMILARITY = 0.532;
export function semanticFloor(env = process.env) {
  const v = Number(env.RUVNET_PACKAGE_RECOMMENDER_MIN_SIMILARITY);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : SEMANTIC_MIN_SIMILARITY;
}

/** The advocacy candidate carrying a candidate SET, phrased exactly as the measured instruction. */
export function buildCandidateSetCandidate({ prompt, picks, findingPrefix = 'recommend:pkg:' }) {
  const cards = (picks || []).map((p) => p.card).filter((c) => c && typeof c.id === 'string' && typeof c.source === 'string');
  if (!cards.length) return null;
  const list = cards.map((c) => `${c.id} — ${String(c.description || '').replace(/\s+/g, ' ').trim().slice(0, 200)} (${c.source})`).join('; ');
  const top = cards[0];
  return {
    channel: 'advocacy',
    effect: 'advisory',
    hookEventName: 'UserPromptSubmit',
    findingId: `${findingPrefix}${top.id}`,
    severity: 'normal',
    observationHash: stateHashOf([`package:${top.id}`]),
    copy: `[RuvNet Brain — rUv may already ship this] Candidate rUv packages for this request (from the Brain's package cards): ${list}. `
      + 'If, and only if, ONE of them would materially help with exactly what the user is asking for, tell the user in one sentence: '
      + "'rUv ships <id> — <why it fits> (source: <source>)'. If none clearly fits, say nothing about them. Never mention more than one.",
    capability: shortName(top),
    package: top.id,
    candidates: cards.map((c) => c.id),
    similarities: (picks || []).map((p) => (Number.isFinite(p.similarity) ? +p.similarity.toFixed(4) : null)),
    promptHash: crypto.createHash('sha256').update(String(prompt || '').trim().toLowerCase()).digest('hex').slice(0, 16),
  };
}

/**
 * Turn a warm worker's answer into an advocacy lane, or null. `offered` = short names already offered
 * this session; `allowed(findingId)` = the DismissalLedger's verdict. A dismissed or already-offered
 * package is dropped from the set, never re-shown.
 */
export function semanticLane({ prompt, semantic, offered = new Set(), allowed = () => true, index, findingPrefix = 'recommend:pkg:', floor = semanticFloor() }) {
  if (!Array.isArray(semantic?.candidates) || !semantic.candidates.length) return null;
  if (!(semantic.candidates[0].similarity >= floor)) return null;   // nearest card too far: no hint at all
  if (!isDesignOrDiagnosis(prompt)) return null;
  const idx = index === undefined ? loadIndex() : index;
  if (!idx) return null;
  const byId = new Map(idx.entries.map((e) => [e.card.id, e.card]));
  const picks = canonicalPicks(semantic.candidates, byId)
    .filter((p) => p.card && !offered.has(shortName(p.card)) && allowed(`${findingPrefix}${p.card.id}`))
    .slice(0, SEMANTIC_K);
  if (!picks.length) return null;
  const top = picks[0].card;
  return {
    capability: shortName(top), id: `${findingPrefix}${top.id}`, intent: 'package-candidates', cap: SEMANTIC_MAX_PER_SESSION,
    extra: { package: top.id, candidates: picks.map((p) => shortName(p.card)), packages: picks.map((p) => p.card.id) },
    stateHash: stateHashOf([`package:${top.id}`]),
    build: () => buildCandidateSetCandidate({ prompt, picks, findingPrefix }),
  };
}
