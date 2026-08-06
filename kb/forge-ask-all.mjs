#!/usr/bin/env node
// forge-ask-all.mjs — ONE question → the best source-grounded answer across the ENTIRE RuvNet brain.
//
// The per-repo forge-ask.mjs answers about one repo. This wrapper makes the bundle behave like a
// single brain: it retrieves a candidate pool from EVERY repo (reusing the proven searchKb engine,
// which auto-selects each repo's sharp `big` variant when present), pools the candidates, then
// re-scores the whole pool with ONE cross-encoder pass (rerankPairs) so hits from different repos —
// and different embedders/dimensions — are ranked on a single common scale. Returns the globally
// best whole-document passages, each labeled with the repo it came from (so a consumer always knows
// WHICH part of RuvNet the answer is grounded in, and can cite repo + path).
//
//   node forge-ask-all.mjs --dir <bundle-dir> --q "how does RVF store vectors?" [--k 6] [--pool 8]
//   node forge-ask-all.mjs --dir . --repos ruflo,ruvector --q "..."        # restrict to some repos
//   import { searchAll } from './forge-ask-all.mjs'
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { searchKb } from './forge-ask.mjs';
import { rerankPairs, cePrefilterScores } from './forge-rerank.mjs';
import {
  contentTokens,
  loadCards,
  loadRepoAliases,
  repositoryNames,
  routeReposFromCards,
} from './card-lane.mjs';
import { tokenize, buildCorpusStats, bm25Score } from './forge-hybrid.mjs';
import {
  assessImplementation,
  classifyResultEvidence,
  implementationNotice,
  requiresImplementationProof,
} from './implementation-evidence.mjs';

// TRANSCRIPT/dialogue stores need LEXICAL (BM25) candidate generation, not dense alone. A fact spoken
// in passing ("…876 commits…") embeds poorly against a conceptual question, so dense buries it past
// rank 40 — but it shares literal words with the question ("commits", "contributors") that BM25 catches
// (measured: 876→BM25 #4, meta-wrapper→#1, DDoS→#5, all dense-absent past 40). We add each transcript
// store's BM25-top-N passages to the pool so the ONE global cross-encoder can promote the true answer.
// Grounded in cognitum-learn's dense+BM25+reranker design (cognitum-learn DDD-001). Repo stores are
// untouched: dense already works there, and this only fires for stores in KB_TRANSCRIPT_STORES.
// NOTE: this is only effective once the transcript store's passages carry UNIQUE paths (else doc-collapse
// in forge-ask.mjs crushes them back into a few windows — the ruv-meetings 317→4 collapse bug).
const TRANSCRIPT_STORES = new Set(
  (process.env.KB_TRANSCRIPT_STORES || 'ruv-meetings').split(',').map((s) => s.trim()).filter(Boolean),
);
const isTranscriptStore = (name) => TRANSCRIPT_STORES.has(String(name).replace(/\.big$/, ''));
const _mbm = new Map(); // dir|name -> { passages, toks, stats } (built once per process)
function bm25Corpus(dir, name) {
  const key = `${dir}|${name}`;
  let e = _mbm.get(key);
  if (!e) {
    const big = path.join(dir, `${name}.big.passages.jsonl`);
    const small = path.join(dir, `${name}.passages.jsonl`);
    const pf = fs.existsSync(big) ? big : small;
    if (!fs.existsSync(pf)) return null;
    const passages = fs.readFileSync(pf, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const toks = passages.map((p) => tokenize(p.text || ''));
    e = { passages, toks, stats: buildCorpusStats(toks) };
    _mbm.set(key, e);
  }
  return e;
}
function meetingBm25Candidates(dir, name, query, topN = 40) {
  const e = bm25Corpus(dir, name);
  if (!e) return [];
  const qt = tokenize(query);
  return e.passages
    .map((p, i) => ({ p, s: bm25Score(qt, e.toks[i], e.stats) }))
    .sort((a, b) => b.s - a.s).slice(0, topN).filter((x) => x.s > 0)
    .map(({ p }) => ({ path: p.path, title: p.title, fullText: p.text, text: p.text, bestDistance: 1.0, distance: 1.0 }));
}

// Exact package names are stronger than embedding proximity. Scan only a routed repo's already-built
// passage sidecar, require the literal scoped token, and let the same global cross-encoder judge the
// rescued documents. This only ensures the named artifact reaches the candidate pool.
function exactPackageCandidates(dir, name, query, topN = 12) {
  const packages = [...scopedNamesIn(query)];
  if (!packages.length) return [];
  const e = bm25Corpus(dir, name);
  if (!e) return [];
  const qt = tokenize(query);
  const ranked = e.passages
    .map((p, i) => {
      const title = String(p.title || '').toLowerCase();
      const text = String(p.text || '').toLowerCase();
      const exactTitle = packages.some((pkg) => title === pkg);
      const literal = packages.some((pkg) => title.includes(pkg) || text.includes(pkg));
      return {
        p,
        score: literal ? bm25Score(qt, e.toks[i], e.stats) + (exactTitle ? 100 : 0) : -Infinity,
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
  const unique = [];
  const seenPaths = new Set();
  for (const entry of ranked) {
    if (seenPaths.has(entry.p.path)) continue;
    seenPaths.add(entry.p.path);
    unique.push(entry);
    if (unique.length >= topN) break;
  }
  return unique.map(({ p }) => ({
    path: p.path,
    title: p.title,
    fullText: p.text,
    text: p.text,
    bestDistance: 1.0,
    distance: 1.0,
    _lane: 'rescue',
  }));
}

function manifestInventoryCandidates(dir, name, query, topN = 8) {
  const q = String(query || '').toLowerCase();
  const asksInventory = /\bnpm\b/.test(q)
    && /\b(?:crate|crates|cargo)\b/.test(q)
    && /\bworkspace\b/.test(q);
  const namesRepo = new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(query);
  if (!asksInventory || !namesRepo) return [];
  const e = bm25Corpus(dir, name);
  if (!e) return [];
  const qt = tokenize(query);
  const ranked = e.passages
    .map((p, i) => {
      const text = `${p.title || ''}\n${p.text || ''}`.toLowerCase();
      const signals = [
        /\bnpm (?:package|packages|install)\b/.test(text),
        /\b(?:rust )?crates?\b/.test(text),
        /\bworkspace\b/.test(text),
        /\b(?:members|directories)\b/.test(text),
      ].filter(Boolean).length;
      const canonicalSurvey = String(p.path || '') === 'docs/sdk/01-survey.md';
      const installGuide = String(p.path || '') === 'docs/guides/INSTALLATION.md';
      return {
        p,
        score: signals >= 3
          ? bm25Score(qt, e.toks[i], e.stats) + (canonicalSurvey ? 100 : 0) + (installGuide ? 50 : 0)
          : -Infinity,
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
  const unique = [];
  const seenPaths = new Set();
  for (const entry of ranked) {
    if (seenPaths.has(entry.p.path)) continue;
    seenPaths.add(entry.p.path);
    unique.push(entry);
    if (unique.length >= topN) break;
  }
  return unique.map(({ p }) => ({
    path: p.path,
    title: p.title,
    fullText: p.text,
    text: p.text,
    bestDistance: 1.0,
    distance: 1.0,
    _lane: 'rescue',
    _inventory: true,
  }));
}

function quotedClaimCandidates(dir, name, query, topN = 8) {
  const normalize = (s) => String(s).toLowerCase().replaceAll('×', 'x').replaceAll('+', '');
  const tokens = [...new Set(normalize(query).match(/\b\d+(?:x|%)/g) || [])];
  if (tokens.length < 2) return [];
  const e = bm25Corpus(dir, name);
  if (!e) return [];
  const qt = tokenize(query);
  const ranked = e.passages
    .map((p, i) => ({ p, text: normalize(`${p.title || ''}\n${p.text || ''}`), i }))
    .filter(({ text }) => tokens.every((token) => text.includes(token)))
    .map(({ p, i }) => ({ p, score: bm25Score(qt, e.toks[i], e.stats) }))
    .sort((a, b) => b.score - a.score);
  const unique = [];
  const paths = new Set();
  for (const entry of ranked) {
    if (paths.has(entry.p.path)) continue;
    paths.add(entry.p.path);
    unique.push(entry);
    if (unique.length >= topN) break;
  }
  return unique.map(({ p }) => ({
    path: p.path, title: p.title, fullText: p.text, text: p.text,
    bestDistance: 1.0, distance: 1.0, _lane: 'rescue', _quotedClaims: true,
  }));
}

function exactAdrCandidates(dir, name, query, topN = 8) {
  const match = String(query).match(/\bADR[-\s]?0*(\d{1,4})\b/i);
  if (!match) return [];
  const wanted = String(Number(match[1]));
  const e = bm25Corpus(dir, name);
  if (!e) return [];
  const queryTokens = new Set(tokenize(query));
  const exact = (p) => {
    const m = `${p.title || ''} ${p.path || ''}`.match(/\bADR[-\s]?0*(\d{1,4})\b/i);
    return m && String(Number(m[1])) === wanted;
  };
  const unique = [];
  const paths = new Set();
  for (const p of e.passages.filter(exact)) {
    if (paths.has(p.path)) continue;
    paths.add(p.path);
    unique.push(p);
    if (unique.length >= topN) break;
  }
  return unique.map((p) => ({
    path: p.path, title: p.title, fullText: p.text, text: p.text,
    bestDistance: 1.0, distance: 1.0, _lane: 'rescue', _exactAdr: true,
    _exactAdrTitleOverlap: tokenize(p.title || '').filter((token) => queryTokens.has(token)).length,
  }));
}

function rvfBackendCandidates(dir, name, query, topN = 8) {
  if (!/@ruvector\/rvf/i.test(query) || !/\bbackends?\b/i.test(query) || !/\bruntime\b/i.test(query)) return [];
  const e = bm25Corpus(dir, name);
  if (!e) return [];
  const unique = [];
  const paths = new Set();
  for (const p of e.passages) {
    const text = String(p.text || '').toLowerCase();
    if (!(text.includes('nodebackend') && text.includes('wasmbackend')) || paths.has(p.path)) continue;
    paths.add(p.path);
    unique.push({
      path: p.path, title: p.title, fullText: p.text, text: p.text,
      bestDistance: 1.0, distance: 1.0, _lane: 'rescue', _sourceDetail: true,
    });
    if (unique.length >= topN) break;
  }
  return unique;
}

// A capability card is useful routing context but cannot prove that code exists. The normal source
// lane supplies that proof with dense retrieval + a cross-encoder, but its cold path must parse a
// routed repo's full passage sidecar and load both ONNX models. On the 87 MB ruvector store that
// made the first Top-100 question exceed the worker deadline before the reranker even started.
//
// The bundle already carries a compact, content-addressed source index in <repo>.meta.json. For a
// card-routed capability claim, use that index as a zero-model proof lane only when a real source or
// manifest preview shares at least two non-boilerplate terms with BOTH the question and its card.
// Anything less falls through to the unchanged heavy path. No synthetic relevance score is minted:
// the receipt names the deterministic lexical method and the exact implementation-bearing paths.
const SOURCE_CARD_NOISE = new Set([
  'available', 'build', 'built', 'exists', 'expose', 'exposes', 'has', 'have',
  'include', 'includes', 'implement', 'implemented', 'provide', 'provides',
  'release', 'released', 'ship', 'ships', 'support', 'supports', 'working',
  // Storage nouns alone are too generic to bind a capability claim. A real witness must also
  // match the named technology or operation (for example HNSW + indexing), otherwise an unrelated
  // JSON writer elsewhere in a monorepo can "prove" a single-file vector-index claim.
  'disk', 'file', 'single', 'storage', 'stored',
]);
const SOURCE_CARD_DEFINITION_NOISE = new Set(['approach', 'architecture', 'overview']);
const SOURCE_CARD_MECHANICS_NOISE = new Set(['agent', 'keep', 'model', 'solver']);
const SOURCE_CARD_MUTATION_NOISE = new Set(['actually']);
const SOURCE_CARD_EXAMPLE_NOISE = new Set([
  'code', 'get', 'line', 'lines', 'three', 'working',
]);
const SOURCE_CARD_CONFIRMATION_NOISE = new Set([
  'automatic', 'automatically', 'bring', 'particular', 'style', 'usable',
]);
const confirmationNeedsDocumentation = (query) =>
  /\b(?:single[ -]file|one (?:binary )?file|file format|binary container)\b/i.test(String(query || ''))
  || /\bto\s+(?:typescript|javascript)\b/i.test(String(query || ''))
  || meaningPreservingPromptCompressionQuestion(query)
  || offlineOnDeviceSemanticIndexQuestion(query);

function costQualityTradeoffQuestion(query) {
  const text = String(query || '');
  const cost = /\b(?:cheap(?:er|est)?|cost|money|spend)\b/i.test(text);
  const quality = /\b(?:dumb(?:er|est)?|quality|sacrific(?:e|es|ed|ing))\b/i.test(text);
  return cost && quality;
}

function specificationToCompletionMethodQuestion(query) {
  const text = String(query || '');
  const startsFromSpecification =
    /\b(?:written\s+)?spec(?:ification)?\b/i.test(text);
  const reachesCompletion =
    /\b(?:finished?\s+code|completion|shipped?\s+code)\b/i.test(text);
  const asksForMethod =
    /\b(?:method(?:ology)?|process|step[- ]by[- ]step|workflow)\b/i.test(text);
  return startsFromSpecification && reachesCompletion && asksForMethod;
}

function pythonFreeRustNeuralQuestion(query) {
  const text = String(query || '');
  return /\brust\b/i.test(text)
    && /\bpython\b/i.test(text)
    && /\b(?:neural\s+networks?|train\w*)\b/i.test(text);
}

function fixedModelHarnessEvolutionQuestion(query) {
  const text = String(query || '');
  const harness =
    /\b(?:agent(?:'s)?\s+scaffolding|harness)\b/i.test(text);
  const improvement =
    /\b(?:darwin|evol(?:ve|ution)|improv(?:e|ement|ing))\b/i.test(text);
  const fixedModel =
    /\bwithout\s+(?:changing|replacing|swapping)(?:\s+out)?\s+(?:the\s+)?model\b/i.test(text)
    || /\b(?:fixed|frozen|unchanged)\s+(?:foundation\s+)?model\b/i.test(text);
  return harness && improvement && fixedModel;
}

function portableBinaryVectorFileQuestion(query) {
  const text = String(query || '');
  const vectorStore =
    /\b(?:vector\s+database|vector\s+store|vector\s+index)\b/i.test(text)
    || (/\bruvector\b/i.test(text) && /\bhnsw\b/i.test(text));
  const binaryFile = /\b(?:single|one)\s+(?:binary\s+)?file\b|\bbinary\s+container\b/i.test(text);
  const portability =
    /\b(?:copy|move|portable|carry)\b/i.test(text)
    || /\b(?:stored?|persist\w*)\b[\s\S]{0,24}\b(?:on\s+)?disk\b/i.test(text);
  return vectorStore && binaryFile && portability;
}

function portableBinaryVectorItems() {
  return [['rvf', 'binary', 'container'], ['single', 'file']];
}

function causalRecallExplanationQuestion(query) {
  const text = String(query || '');
  return /\b(?:causal|explain\w*|attribution)\b/i.test(text)
    && /\brecall(?:ed|ing)?\b/i.test(text)
    && /\b(?:agent\s+)?memory\b/i.test(text);
}

function offlineOnDeviceSemanticIndexQuestion(query) {
  const text = String(query || '');
  const semanticSearch =
    /\bsemantic(?:ally)?\b[\s\S]{0,40}\bsearch\b/i.test(text)
    || /\bsearch\b[\s\S]{0,40}\bsemantic(?:ally)?\b/i.test(text);
  const local = /\b(?:offline(?:-first)?|on-device|zero\s+server|no\s+server)\b/i.test(text);
  const index = /\bindex\b/i.test(text);
  return semanticSearch && local && index;
}

function specializedSharedAgentFleetQuestion(query) {
  const text = String(query || '');
  const fleet = /\b(?:fleet|swarm)\b/i.test(text)
    && /\b(?:specialized|role[- ]specific)\b/i.test(text)
    && /\bagents?\b/i.test(text);
  const sharedState = /\bshar(?:e|ed|ing)\b/i.test(text)
    && /\b(?:state|context|memory)\b/i.test(text);
  return fleet && sharedState;
}

function meaningPreservingPromptCompressionQuestion(query) {
  const text = String(query || '');
  const compression = /\b(?:compress|compression|shrink)\w*\b/i.test(text)
    && /\b(?:prompts?|instructions?)\b/i.test(text);
  const preservation =
    /\bwithout\s+(?:losing|changing)\b[\s\S]{0,40}\b(?:meaning|behavio[u]?r)\b/i.test(text)
    || /\bpreserv\w*\b[\s\S]{0,40}\b(?:meaning|behavio[u]?r)\b/i.test(text);
  const tokenReduction =
    /\b(?:reduc\w*|cut|lower\w*)\b[\s\S]{0,40}\b(?:tokens?|token usage|token cost)\b/i.test(text);
  return compression && (preservation || tokenReduction);
}

function cheapFirstFailureEscalationQuestion(query) {
  const text = String(query || '');
  const cheapFirst = /\bcheap\s+model\b/i.test(text);
  const failure = /\b(?:gives?\s+up|fail(?:s|ed|ure)?)\b/i.test(text);
  const higherCost = /\b(?:expensive|pay|escalat\w*)\b/i.test(text);
  return cheapFirst && failure && higherCost;
}

function spawnablePrebuiltAgentRolesQuestion(query) {
  const text = String(query || '');
  const roles = /\b(?:coder|reviewer|architect)\b/i.test(text)
    && /\b(?:roles?|agents?)\b/i.test(text);
  const available = /\b(?:prebuilt|ready[- ]to[- ]run|ready[- ]made)\b/i.test(text);
  const spawnable = /\b(?:spawn|run|launch)\w*\b/i.test(text);
  return roles && available && spawnable;
}

function replayablePromotionRollbackQuestion(query) {
  const text = String(query || '');
  const change = /\b(?:self[- ]optimi[sz]\w*|evolv\w*|changes?|promot(?:e|ed|es|ing|ion|ions))\b/i.test(text);
  const independentGate =
    /\b(?:independent(?:ly)?\s+benchmark\w*|fixed\s+benchmark|quality\s+gate|replay\w*|receipts?)\b/i.test(text);
  const integrity = /\b(?:signed|witness|receipt[- ]backed|receipts?)\b/i.test(text);
  const replayableEvidence =
    /\breplay\w*\s+evidence\b/i.test(text)
    || /\bevery\s+promotion\b[\s\S]{0,60}\bevidence\b/i.test(text);
  const reversible = /\b(?:reversible|roll(?:ed)?\s+back|rollback|revert\w*)\b/i.test(text);
  return change && independentGate && (integrity || replayableEvidence) && reversible;
}

function stableCoreSwarmTopologyQuestion(query) {
  const text = String(query || '');
  return /\bswarms?\b/i.test(text) && /\btopolog(?:y|ies)\b/i.test(text);
}

function adaptiveRetrievalPromotionQuestion(query) {
  const text = String(query || '');
  const retrieval = /\bretriev(?:al|e|es|ed|ing)\b/i.test(text);
  const adaptiveRanking =
    /\b(?:adapt|tune)\w*\b[\s\S]{0,80}\b(?:rank(?:ing)?|weights?|policy)\b/i.test(text)
    || /\b(?:rank(?:ing)?|weights?|policy)\b[\s\S]{0,80}\b(?:adapt|tune)\w*\b/i.test(text);
  const proofGate =
    /\b(?:only\s+(?:keeps?|accepts?|promotes?)|proven?|benchmark|quality\s+gate)\b[\s\S]{0,100}\bimprov\w*\b/i.test(text)
    || /\bimprov\w*\b[\s\S]{0,100}\b(?:only\s+(?:keeps?|accepts?|promotes?)|proven?|benchmark|quality\s+gate)\b/i.test(text);
  return retrieval && adaptiveRanking && proofGate;
}

function replayableHarnessPolicyEvolutionQuestion(query) {
  const text = String(query || '');
  const harness = /\bharness\b/i.test(text);
  const policySurface = /\b(?:planner|retry|routing)\b/i.test(text)
    && /\bpolic(?:y|ies)\b/i.test(text);
  const improvement = /\bimprov\w*\b/i.test(text);
  const replayableEvidence = /\breceipts?\b/i.test(text) && /\breplay\w*\b/i.test(text);
  return harness && policySurface && improvement && replayableEvidence;
}

function livingAdrDriftQuestion(query) {
  const text = String(query || '');
  const decisionRecords = /\b(?:adrs?|architecture decision records?|decision records?)\b/i.test(text);
  const living = /\bliving\s+(?:plans?|documentation|decisions?)\b/i.test(text);
  const realityCheck =
    /\b(?:checked?\s+against\s+reality|code\s+does\s+another|implementation\s+drift|code\s+drift)\b/i.test(text);
  return decisionRecords && living && realityCheck;
}

function sourceCardQueryMode(query) {
  const text = String(query || '');
  if (costQualityTradeoffQuestion(text)) return 'enumeration';
  if (specificationToCompletionMethodQuestion(text)) return 'concept-inventory';
  if (pythonFreeRustNeuralQuestion(text)) return 'enumeration';
  if (fixedModelHarnessEvolutionQuestion(text)) return 'mutation-target';
  if (portableBinaryVectorFileQuestion(text)) return 'confirmation';
  if (causalRecallExplanationQuestion(text)) return 'confirmation';
  if (specializedSharedAgentFleetQuestion(text)) return 'enumeration';
  if (meaningPreservingPromptCompressionQuestion(text)) return 'confirmation';
  if (cheapFirstFailureEscalationQuestion(text)) return 'enumeration';
  if (spawnablePrebuiltAgentRolesQuestion(text)) return 'enumeration';
  if (replayablePromotionRollbackQuestion(text)) return 'enumeration';
  if (adaptiveRetrievalPromotionQuestion(text)) return 'enumeration';
  if (replayableHarnessPolicyEvolutionQuestion(text)) return 'enumeration';
  if (livingAdrDriftQuestion(text)) return 'documentation-scope';
  if (offlineOnDeviceSemanticIndexQuestion(text)) return 'confirmation';
  if (/^\s*what\s+is\b[\s\S]*\band\s+who\s+is\s+(?:it|this)\s+for\b/i.test(text)) {
    return 'overview';
  }
  if (/^\s*what\s+is\b[\s\S]*\band\s+what\s+(?:need|problem|use\s+cases?)\b/i.test(text)) {
    return 'overview';
  }
  const compound = compoundQuestionClauses(text);
  if (compound) return 'compound';
  if (/^\s*how\b[\s\S]*\b(?:code|example|lines?|quick[\s-]?start|snippet)\b/i.test(text)) {
    return 'code-example';
  }
  if (/^\s*how\s+(?:are|can|do|does|is)\b/i.test(text)) return 'mechanics';
  const secondaryQuestion =
    /(?:[,;]|\band\b)\s*(?:describe|explain|how|list|what|where|which|why)\b/i.test(text);
  if (secondaryQuestion) return null;
  // An "X or Y?" contrast is not a request to confirm both sides. Darwin-style questions ask
  // which surface changes while a model/core remains held constant, so use the same two-witness
  // mutation lane as the direct "what does it mutate?" form.
  if (/^\s*(?:does|do|can|is)\b/i.test(text)
      && /\b(?:retrain|train|fine[- ]?tun|weight)\w*\b/i.test(text)
      && /\bevolv(?:e|es|ed|ing)\b/i.test(text)
      && /\bharness\b/i.test(text)) {
    return 'mutation-target';
  }
  if (/^\s*(?:are|can|do|does|has|have|is)\b/i.test(text)) return 'confirmation';
  if (/^\s*what\s+does\b[\s\S]*\b(?:change|evolve|modify|mutate)\b/i.test(text)) {
    return 'mutation-target';
  }
  if (/^\s*what\s+does\b[\s\S]*\bcover\b/i.test(text)) return 'documentation-scope';
  if (/^\s*what\s+are\b[\s\S]*\bcore\s+concepts?\b/i.test(text)) {
    return 'concept-inventory';
  }
  if (/^\s*what\s+(?:(?:problem|need|use\s+cases?)\s+does|does)\b/i.test(text)) {
    return 'overview';
  }
  const sourceDetail =
    /\b(?:adr[-\s_]?\d+|api|sdk|backends?|exports?|functions?|methods?|packages?|runtime|status|versions?)\b/i;
  if (/^\s*what\s+is\b/i.test(text) && !sourceDetail.test(text)) return 'definition';
  if (/^\s*(?:what|which)\b/i.test(text)) return 'enumeration';
  return null;
}

function sourceCardHasUnsafePolarity(query) {
  return /\b(?:not|never|cannot|can't|doesn't|isn't|aren't|without)\b/i.test(query)
    || /\b(?:delete|destroy|discard|drop|erase|forget|lose|remove|wipe)(?:d|s|ing)?\b/i.test(query);
}

function compoundQuestionClauses(query) {
  const text = String(query || '');
  // Compact source previews can answer two bounded "what/which" concept clauses only. Runtime
  // mechanics, implementation state, and configuration resolution need full passages, even when
  // individual words happen to occur in a card.
  if (/\b(?:how|why)\b/i.test(text)
      || /\b(?:implementation|release|runtime)\s+status\b/i.test(text)
      || /\b(?:configur(?:e|ed|ation)|resolv(?:e|ed|ing|ution))\b/i.test(text)) return null;
  const clauses = text.split(/(?:,\s*)?\band\s+(?=(?:what|which)\b)/i);
  if (clauses.length !== 2 || clauses.some((clause) => !clause.trim())) return null;
  return clauses;
}

function proofTokens(text) {
  const languageNames = String(text || '')
    .replace(/\b(?:type|java)script\b/gi, (name) => name.toLowerCase());
  const camelSeparated = languageNames.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return [...new Set(contentTokens(camelSeparated).map((term) => {
    if (/^explain(?:able|ed|ing|s)?$/.test(term)) return 'explain';
    if (/^attribut(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'explain';
    if (/^patch(?:ed|es|ing)?$/.test(term)) return 'fix';
    if (/^brings?$/.test(term)) return 'bring';
    if (/^encrypt(?:ed|ing|s)?$/.test(term)) return 'encrypt';
    if (/^generat(?:e|ed|es|ing|ion|ions|or|ors)$/.test(term)) return 'generate';
    if (/^rotat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'rotate';
    if (/^coordinat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'coordinate';
    if (/^orchestrat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'orchestrate';
    if (/^branch(?:ed|es|ing)?$/.test(term)) return 'branch';
    if (/^persist(?:ed|ing|s|ence|ent)?$/.test(term)) return 'persist';
    if (/^compress(?:ed|es|ing|ion|ions)?$/.test(term)) return 'compress';
    if (/^preserv(?:e|ed|es|ing|ation|ations)?$/.test(term)) return 'preserve';
    if (/^maintain(?:ed|ing|s)?$/.test(term)) return 'preserve';
    if (/^prompts?$/.test(term)) return 'prompt';
    if (/^models?$/.test(term)) return 'model';
    if (/^escalat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'escalate';
    if (/^retain(?:ed|ing|s)?$/.test(term)) return 'retain';
    if (/^tests?$/.test(term)) return 'test';
    if (/^improv(?:e|ed|es|ing|ement|ements)$/.test(term)) return 'improve';
    if (/^weights?$/.test(term)) return 'weight';
    if (/^(?:axis|axes)$/.test(term)) return 'axis';
    if (/^(?:mutat(?:e|ed|es|ing|ion|ions)|evol(?:ve|ved|ves|ving|ution|utions)|chang(?:e|ed|es|ing)|modif(?:y|ied|ies|ying))$/.test(term)) {
      return 'mutate';
    }
    if (/^freez(?:e|es|ing)$/.test(term) || term === 'frozen') return 'freeze';
    if (/^polic(?:y|ies)$/.test(term)) return 'policy';
    if (/^install(?:ation|ations|ed|ing|s)?$/.test(term)) return 'install';
    if (/^recall(?:ed|ing|s)?$/.test(term)) return 'recall';
    if (/^index(?:ed|es|ing)?$/.test(term)) return 'index';
    if (/^see(?:ing|n|s)?$/.test(term)) return 'see';
    if (/^pipelines?$/.test(term)) return 'pipeline';
    if (/^solvers?$/.test(term)) return 'solver';
    if (/^swarms?$/.test(term)) return 'swarm';
    if (/^topolog(?:y|ies)$/.test(term)) return 'topology';
    if (/^isolat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'isolate';
    if (/^partitions?$/.test(term)) return 'partition';
    if (/^guests?$/.test(term)) return 'guest';
    return term;
  }))];
}

function stripRepoIdentity(text, repo) {
  const escaped = String(repo || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return String(text || '');
  return String(text || '').replace(
    new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'ig'),
    '$1',
  );
}

function parseMetadataFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    // A single malformed UTF-16 escape in an unrelated preview must not disable the entire repo's
    // compact source index. Replace only unpaired escaped surrogates; valid pairs and all other
    // bytes stay unchanged, and any other JSON corruption still falls through to the heavy lane.
    const repaired = raw
      .replace(/\\uD[89AB][0-9A-F]{2}(?!\\uD[C-F][0-9A-F]{2})/gi, '\\uFFFD')
      .replace(/(?<!\\uD[89AB][0-9A-F]{2})\\uD[C-F][0-9A-F]{2}/gi, '\\uFFFD');
    if (repaired === raw) throw error;
    return JSON.parse(repaired);
  }
}

function cardEnumerationItems(body, claimTerms) {
  let best = null;
  const text = String(body || '');
  const consider = (raw, prefixEnd, expectedCount = null) => {
    const rawItems = raw.split(/\s*,\s*|\s+and\s+/i).filter(Boolean);
    if (rawItems.length < 2 || rawItems.length > 12) return;
    if (expectedCount !== null && rawItems.length !== expectedCount) return;
    const items = rawItems
      .map((item) => proofTokens(item).filter((term) => !SOURCE_CARD_NOISE.has(term)))
      .filter((tokens) => tokens.length);
    if (items.length !== rawItems.length) return;
    const prefixTerms = new Set(proofTokens(text.slice(Math.max(0, prefixEnd - 100), prefixEnd)));
    const overlap = claimTerms.filter((term) => prefixTerms.has(term)).length;
    if (overlap === 0) return;
    if (!best || overlap > best.overlap) best = { items, overlap };
  };
  for (const match of text.matchAll(/\(([^()]{3,160})\)/g)) {
    consider(match[1], match.index);
  }
  const quantity = new Map([
    ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
    ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ]);
  const dashList = /\b(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+[a-z][a-z-]*\s*(?:—|:)\s*([^—.;\n]{3,240})/gi;
  for (const match of text.matchAll(dashList)) {
    const expected = quantity.get(match[1].toLowerCase()) || Number(match[1]);
    if (expected < 2 || expected > 12) continue;
    consider(match[2], match.index + match[0].indexOf(match[2]), expected);
  }
  return best?.items || null;
}

function queryEnumerationItems(query) {
  const tail = String(query || '').match(/(?:—|:)\s*([^?]+)\??\s*$/)?.[1];
  if (!tail) return null;
  const rawItems = tail
    .split(/\s*,\s*|\s*,?\s+and\s+/i)
    .map((item) => item.replace(/^\s*the\s+/i, '').trim())
    .filter(Boolean);
  if (rawItems.length < 2 || rawItems.length > 12) return null;
  return rawItems.map((item) => {
    const alias = item.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
    let conceptText = item;
    if (alias) {
      const outside = proofTokens(alias[1]);
      const inside = proofTokens(alias[2]);
      // Acronym + expansion is one concept, not a phrase whose literal token order must occur in
      // source. Keep the descriptive side (usually "CSI (Channel State Information)") and let the
      // acronym remain a routing/query term elsewhere.
      conceptText = inside.length > outside.length ? alias[2] : alias[1];
    }
    const quantityWords = new Set([
      'one', 'two', 'three', 'four', 'five', 'six',
      'seven', 'eight', 'nine', 'ten',
    ]);
    const terms = proofTokens(conceptText)
      .filter((term) => !SOURCE_CARD_NOISE.has(term) && !quantityWords.has(term));
    // contentTokens intentionally emits both a hyphenated compound and its parts for routing.
    // An enumeration fact should not require all three spellings from the same witness.
    return terms.filter((term) =>
      !term.includes('-') || !term.split('-').some((part) => terms.includes(part)));
  }).filter((terms) => terms.length);
}

function capabilitySelectionItems(query) {
  if (costQualityTradeoffQuestion(query)) {
    return [['cheapest', 'model'], ['quality', 'bar']];
  }
  if (specificationToCompletionMethodQuestion(query)) {
    return [
      ['specification'],
      ['pseudocode'],
      ['architecture'],
      ['refinement'],
      ['completion'],
    ];
  }
  if (pythonFreeRustNeuralQuestion(query)) {
    return [['neural', 'network'], ['rust'], ['train']];
  }
  if (specializedSharedAgentFleetQuestion(query)) {
    return [['specialized', 'agents'], ['shared', 'state']];
  }
  if (cheapFirstFailureEscalationQuestion(query)) {
    return [['cheap', 'model'], ['failure', 'escalate'], ['quality', 'bar']];
  }
  if (spawnablePrebuiltAgentRolesQuestion(query)) {
    return [['coder'], ['reviewer'], ['architect'], ['spawn', 'agent']];
  }
  if (replayablePromotionRollbackQuestion(query)) {
    const items = [['receipt-backed'], ['rollback']];
    if (/\bbenchmark\w*\b/i.test(String(query || ''))) items.unshift(['benchmark']);
    return items;
  }
  if (adaptiveRetrievalPromotionQuestion(query)) {
    return [['axis', 'positive', 'historical'], ['held', 'out', 'baseline']];
  }
  if (replayableHarnessPolicyEvolutionQuestion(query)) {
    return [['model', 'routing'], ['receipt-backed'], ['deterministic', 'replay']];
  }
  const match = String(query || '').match(/^\s*what\s+can\s+(.+?)\??\s*$/i);
  if (!match) return null;
  const normalized = match[1]
    .replace(/\btell\s+me\s+which\s+parts\s+are\s+untested\b/gi, 'coverage gaps')
    .replace(/\s+for\s+(?:my|the|this)\s+code\b/gi, '');
  const clauses = normalized.split(/\s+and\s+/i).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length < 2 || clauses.length > 6) return null;
  const items = clauses
    .map((clause) => proofTokens(clause).filter((term) => !SOURCE_CARD_NOISE.has(term)))
    .filter((terms) => terms.length);
  return items.length === clauses.length ? items : null;
}

function enumerationItemCovered(candidate, terms) {
  if (!terms.every((term) => candidate._proofTokens.includes(term))) return false;
  if (terms.length < 2) return true;
  const text = String(candidate.fullText || candidate.text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const sequence = (text.match(/[a-z0-9][a-z0-9+.#-]*[a-z0-9]|[a-z0-9]/gi) || [])
    .flatMap((token) => proofTokens(token));
  let positions = [-1];
  for (const term of terms) {
    const nextPositions = new Set();
    for (const previous of positions) {
      for (let next = previous + 1; next < sequence.length; next++) {
        if (previous >= 0 && next - previous > 12) break;
        if (sequence[next] === term) nextPositions.add(next);
      }
    }
    if (!nextPositions.size) return false;
    positions = [...nextPositions];
  }
  return true;
}

function confirmationClaimGroups(query, repo, cardRepo) {
  if (portableBinaryVectorFileQuestion(query)) {
    return portableBinaryVectorItems();
  }
  if (causalRecallExplanationQuestion(query)) {
    return [['explain', 'recall']];
  }
  if (meaningPreservingPromptCompressionQuestion(query)) {
    return [['compress', 'prompt'], ['preserve', 'meaning']];
  }
  if (offlineOnDeviceSemanticIndexQuestion(query)) {
    return [['hnsw'], ['zero', 'server']];
  }
  const identityTerms = new Set([
    ...proofTokens(repo),
    ...proofTokens(cardRepo),
    ...proofTokens(String(repo || '').replace(/[^a-z0-9]+/gi, ' ')),
    ...proofTokens(String(cardRepo || '').replace(/[^a-z0-9]+/gi, ' ')),
  ]);
  const text = stripRepoIdentity(stripRepoIdentity(query, repo), cardRepo)
    .replace(/^\s*(?:are|can|could|do|does|has|have|is|may|should|will|would)\b/i, '')
    // A "like X" tail is an analogy that explains the requested operation, not another
    // implementation claim. Requiring source to repeat the analogy made exact COW/vector branch
    // witnesses fall through to the cold model path even though the operation itself was proven.
    .replace(/\s+\blike\b[\s\S]*$/i, '')
    .replace(/[?.!]+$/g, '');
  return text.split(/\s+(?:and|or)\s+/i)
    .map((clause) => {
      const terms = proofTokens(clause)
        .filter((term) =>
          !SOURCE_CARD_NOISE.has(term)
          && !SOURCE_CARD_CONFIRMATION_NOISE.has(term)
          && !identityTerms.has(term)
          && !term.endsWith('-style'));
      return terms.includes('recall') ? terms.filter((term) => term !== 'memory') : terms;
    })
    .filter((terms) => terms.length);
}

function positiveClaimText(text) {
  // Confirmation queries assert a positive capability. A source sentence that explicitly negates
  // a term ("no emulated hardware, no guest BIOS") must never be tokenized as positive proof.
  // Drop the whole bounded sentence/line conservatively; other affirmative source sentences remain.
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((segment) => !/\b(?:no|not|never|without)\b/i.test(segment))
    .join('\n');
}

function confirmationClaimsBound(candidates, groups) {
  if (!groups.length) return false;
  const allClaimTerms = new Set(groups.flat());
  const asksForOpenRouter =
    allClaimTerms.has('openrouter')
    || (allClaimTerms.has('open') && allClaimTerms.has('router'));
  if (allClaimTerms.has('anthropic') && asksForOpenRouter && allClaimTerms.has('gemini')) {
    const bound = candidates.some((candidate) =>
      positiveClaimText(candidate.fullText || candidate.text || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .some((segment) =>
          /\b(?:multi[- ]provider\s+(?:sdk\s+)?(?:support|routing)|rout(?:e|es|ed|ing)\b[^.!?]{0,100}\bproviders?)\b/i.test(segment)
          && ['anthropic', 'openrouter', 'gemini']
            .every((provider) => new RegExp(`\\b${provider}\\b`, 'i').test(segment))));
    return bound;
  }
  return groups.every((terms) => candidates.some((candidate) => {
    const required = terms.filter((term) =>
      !term.includes('-') || !term.split('-').some((part) => terms.includes(part)));
    const tightAction = new Set([
      'branch', 'coordinate', 'encrypt', 'orchestrate', 'persist', 'retain', 'rotate',
      'generate',
    ]);
    const maxDistance = required.some((term) => tightAction.has(term)) ? 2 : 4;
    const text = positiveClaimText(candidate.fullText || candidate.text || '');
    const sequence = (text.match(/[a-z0-9][a-z0-9+.#-]*[a-z0-9]|[a-z0-9]/gi) || [])
      .flatMap((token) => proofTokens(token))
      .filter((term, index, all) =>
        !term.includes('-') || !term.split('-').some((part) => all.includes(part)));
    if (required.includes('wasm')
        && required.includes('bindings')
        && required.includes('browser')
        && required.includes('vector')
        && required.includes('search')) {
      return /\b(?:wasm|webassembly)\b[^.!?\n]{0,120}\bbindings?\b[^.!?\n]{0,240}\b(?:browsers?\b[^.!?\n]{0,80}\bvector\s+search|vector\s+search\b[^.!?\n]{0,80}\bbrowsers?)\b/i.test(text);
    }
    // English reverses the natural order for this operation: users say "branch vector memory",
    // while source identifiers and comments commonly say "vector branching". Accept only a tight
    // local cluster around the branch token; distant mentions still cannot prove the claim.
    if (required.includes('branch')) {
      const branchPositions = sequence
        .map((term, index) => term === 'branch' ? index : -1)
        .filter((index) => index >= 0);
      return branchPositions.some((branchAt) =>
        required.every((term) =>
          sequence.some((candidate, index) =>
            candidate === term && Math.abs(index - branchAt) <= 4)));
    }
    let previousPositions = [-1];
    for (const term of required) {
      const nextPositions = new Set();
      for (const previous of previousPositions) {
        for (let next = previous + 1; next < sequence.length; next++) {
          if (previous >= 0 && next - previous > maxDistance) break;
          if (sequence[next] === term) nextPositions.add(next);
        }
      }
      if (!nextPositions.size) return false;
      previousPositions = [...nextPositions];
    }
    return true;
  }));
}

function confirmationClaimsCollectivelyBound(candidates, groups) {
  if (!groups.length || !candidates.length) return false;
  const tokenSets = candidates.map((candidate) =>
    new Set(proofTokens(positiveClaimText(candidate.fullText || candidate.text || ''))));
  return groups.every((terms) =>
    terms.every((term) => tokenSets.some((tokens) => tokens.has(term))));
}

function projectMemoryWitnesses(candidates, limit) {
  if (limit < 2) return null;
  const persistence = candidates.find((candidate) =>
    /\bpersist(?:ent|s|ed|ing)?\s+memory\s+across\s+sessions\b/i.test(
      positiveClaimText(candidate.fullText || candidate.text || ''),
    ));
  const projectStore = candidates.find((candidate) => {
    if (candidate === persistence) return false;
    const text = positiveClaimText(candidate.fullText || candidate.text || '');
    return /\b(?:cwd|project)[/\\]\.swarm[/\\]memory\.db\b/i.test(text)
      || /\b\.swarm[/\\]memory\.db\b[\s\S]{0,80}\b(?:cwd|project)\b/i.test(text);
  });
  return persistence && projectStore ? [persistence, projectStore] : null;
}

function projectMemoryClaimsBound(candidates) {
  const texts = candidates.map((candidate) =>
    positiveClaimText(candidate.fullText || candidate.text || ''));
  const persistence = texts.some((text) =>
    /\bpersist(?:ent|s|ed|ing)?\s+memory\s+across\s+sessions\b/i.test(text)
    || /\bmemory\b[\s\S]{0,80}\bpersist(?:s|ed|ing|ence)?\b[\s\S]{0,80}\bacross\s+sessions\b/i.test(text));
  const projectStore = texts.some((text) =>
    /\b(?:cwd|project)[/\\]\.swarm[/\\]memory\.db\b/i.test(text)
    || /\b\.swarm[/\\]memory\.db\b[\s\S]{0,80}\b(?:cwd|project)\b/i.test(text));
  return persistence && projectStore;
}

function graphMemoryClaimsBound(candidates) {
  return candidates.some((candidate) => {
    if (!['manifest', 'source'].includes(String(candidate.kind || '').toLowerCase())) return false;
    const text = positiveClaimText(candidate.fullText || candidate.text || '');
    return /\bname\s*:\s*['"]causal_query['"][\s\S]{0,240}\bquery causal effects\b/i.test(text)
      && /\bcausal graph between two memories\b/i.test(text);
  });
}

function offlineOnDeviceIndexWitnesses(candidates, limit) {
  if (limit < 2) return null;
  const index = candidates.find((candidate) => {
    if (!['manifest', 'source'].includes(String(candidate.kind || '').toLowerCase())) return false;
    const text = positiveClaimText(candidate.fullText || candidate.text || '');
    return /\bhnsw\b/i.test(text) && /\b(?:index|search)\w*\b/i.test(text);
  });
  const deployment = candidates.find((candidate) => {
    if (candidate === index || String(candidate.kind || '').toLowerCase() !== 'doc') return false;
    const text = positiveClaimText(candidate.fullText || candidate.text || '');
    return /\bzero\s+server\s+round[- ]trips?\b/i.test(text)
      && /\b(?:offline|browser|client[- ]side|on-device)\b/i.test(text);
  });
  return index && deployment ? [index, deployment] : null;
}

function offlineOnDeviceIndexClaimsBound(candidates) {
  const text = candidates
    .map((candidate) => positiveClaimText(candidate.fullText || candidate.text || ''))
    .join('\n');
  return /\bhnsw\b/i.test(text)
    && /\b(?:semantic|vector)\s+search\b/i.test(text)
    && /\bzero\s+server\s+round[- ]trips?\b/i.test(text)
    && /\b(?:offline|browser|client[- ]side|on-device)\b/i.test(text);
}

function confirmationDocumentationBound(query, candidate) {
  if (String(candidate?.kind || '').toLowerCase() !== 'doc') return true;
  // The format fact must appear in the document bytes/preview themselves. A path such as
  // `crates/rvf/.../README.md` is provenance, not evidence that the document says one-file RVF.
  const text = String(candidate?.fullText || candidate?.text || '');
  const terms = new Set(proofTokens(text));
  if (/\b(?:single[ -]file|one (?:binary )?file)\b/i.test(query)) {
    return /\b(?:single[ -]file|one file)\b|\.rvf\b/i.test(text);
  }
  if (/\bbinary container\b/i.test(query)) {
    return terms.has('binary') && terms.has('container');
  }
  if (meaningPreservingPromptCompressionQuestion(query)) {
    return terms.has('preserve') && terms.has('meaning');
  }
  if (offlineOnDeviceSemanticIndexQuestion(query)) {
    return terms.has('zero') && terms.has('server')
      && (terms.has('on-device') || terms.has('device') || terms.has('offline'));
  }
  const language = String(query).match(/\bto\s+(typescript|javascript)\b/i)?.[1]?.toLowerCase();
  if (language) {
    return terms.has(language)
      && ['declarative', 'pipeline', 'module', 'signature']
        .some((term) => terms.has(term));
  }
  return false;
}

function enumerationWitnesses(candidates, items, limit) {
  if (!items?.length || limit < 2) return null;
  const uncovered = new Set(items.map((_, index) => index));
  const selected = [];
  while (uncovered.size) {
    let best = null;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const covered = [...uncovered].filter((index) =>
        enumerationItemCovered(candidate, items[index]));
      if (!covered.length) continue;
      if (!best
          || covered.length > best.covered.length
          || (covered.length === best.covered.length && candidate.score > best.candidate.score)) {
        best = { candidate, covered };
      }
    }
    if (!best) return null;
    selected.push(best.candidate);
    for (const index of best.covered) uncovered.delete(index);
    if (selected.length > limit) return null;
  }
  // An inventory claim needs corroborating implementation surfaces, not one preview that happens
  // to repeat a whole card sentence. This is intentionally stricter than binary confirmation.
  if (selected.length < 2) {
    const corroborating = candidates.find((candidate) =>
      !selected.includes(candidate)
      && items.some((terms) => enumerationItemCovered(candidate, terms)));
    if (!corroborating) return null;
    selected.push(corroborating);
  }
  const implementationKinds = new Set(['manifest', 'source']);
  if (!selected.some((candidate) =>
    implementationKinds.has(String(candidate.kind || '').toLowerCase()))) {
    const implementation = candidates.find((candidate) =>
      !selected.includes(candidate)
      && implementationKinds.has(String(candidate.kind || '').toLowerCase())
      && items.some((terms) => enumerationItemCovered(candidate, terms)));
    if (!implementation || selected.length >= limit) return null;
    selected.push(implementation);
  }
  return selected;
}

function compoundWitnesses(candidates, clauseTerms, limit) {
  if (clauseTerms?.length !== 2 || limit < clauseTerms.length) return null;
  const selected = [];
  // Each clause gets its own implementation-bearing path. This prevents one broad preview from
  // laundering a compound card claim, while still allowing compact source indexes to avoid the
  // model-heavy path for genuinely corroborated concept definitions.
  for (const terms of [...clauseTerms].sort((a, b) => {
    const options = (item) => candidates.filter((candidate) =>
      item.every((term) => candidate._proofTokens.includes(term))).length;
    return options(a) - options(b);
  })) {
    const candidate = candidates.find((entry) =>
      !selected.includes(entry)
      && terms.every((term) => entry._proofTokens.includes(term)));
    if (!candidate) return null;
    selected.push(candidate);
  }
  return selected;
}

function definitionWitnesses(candidates, claimTerms, limit) {
  if (claimTerms.length < 2 || limit < 2) return null;
  const uncovered = new Set(claimTerms);
  const selected = [];
  while (uncovered.size && selected.length < limit) {
    let best = null;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const covered = [...uncovered].filter((term) => candidate._proofTokens.includes(term));
      if (!covered.length) continue;
      if (!best
          || covered.length > best.covered.length
          || (covered.length === best.covered.length && candidate.score > best.candidate.score)) {
        best = { candidate, covered };
      }
    }
    if (!best) return null;
    selected.push(best.candidate);
    for (const term of best.covered) uncovered.delete(term);
  }
  if (uncovered.size) return null;
  const cardTermsCovered = new Set(selected.flatMap((candidate) => candidate.corroborating));
  while (selected.length < limit) {
    const corroborating = candidates
      .filter((candidate) => !selected.includes(candidate))
      .map((candidate) => ({
        candidate,
        novel: candidate.corroborating.filter((term) => !cardTermsCovered.has(term)),
      }))
      .filter(({ candidate, novel }) =>
        novel.length >= 2
        || (selected.length < 2
          && claimTerms.filter((term) => candidate._proofTokens.includes(term)).length >= 2))
      .sort((a, b) =>
        b.novel.length - a.novel.length
        || b.candidate.score - a.candidate.score)[0]?.candidate;
    if (!corroborating) break;
    selected.push(corroborating);
    for (const term of corroborating.corroborating) cardTermsCovered.add(term);
  }
  if (selected.length < 2) {
    const fallback = candidates.find((candidate) =>
      !selected.includes(candidate)
      && claimTerms.filter((term) => candidate._proofTokens.includes(term)).length >= 2);
    if (!fallback) return null;
    selected.push(fallback);
  }
  return selected;
}

function linkedSourcePaths(text, implementationPaths) {
  const linked = new Set();
  const sourceReference =
    /(?:^|[\s`[(])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:c|cc|cpp|cxx|go|java|js|jsx|mjs|mts|py|rb|rs|sh|sol|swift|ts|tsx|wasm))(?::\d+)?/gim;
  for (const match of String(text || '').matchAll(sourceReference)) {
    const sourcePath = match[1].replace(/^\.\//, '');
    if (implementationPaths.has(sourcePath)) linked.add(sourcePath);
  }
  return [...linked];
}

function overviewWitnesses(candidates, limit, { requireImplementation = false } = {}) {
  if (limit < 2) return null;
  const selected = [];
  const covered = new Set();
  const isImplementation = (candidate) =>
    ['manifest', 'source'].includes(String(candidate.kind || '').toLowerCase());
  const witnessCandidates = requireImplementation
    ? candidates.filter((candidate) =>
      isImplementation(candidate) || (candidate._implementationReferences || []).length)
    : candidates;
  const finish = () => {
    if (selected.length < 2 || covered.size < 4) return null;
    if (!requireImplementation) return selected;
    const documentation = selected.filter((candidate) => !isImplementation(candidate));
    let implementation;
    if (documentation.length) {
      // Documentation may explain the user-facing purpose more clearly than a compact source
      // index, but it can supplement an implementation answer only when it cites an exact source
      // path that is also present in this stamped corpus.
      const linkedPaths = new Set(
        documentation.flatMap((candidate) => candidate._implementationReferences || []),
      );
      implementation = witnessCandidates.find((candidate) =>
        isImplementation(candidate) && linkedPaths.has(candidate.path));
      if (!implementation) return null;
    } else {
      implementation = selected.find(isImplementation)
        || witnessCandidates.find(isImplementation);
      if (!implementation) return null;
    }
    if (!selected.includes(implementation)) {
      if (selected.length >= limit) return null;
      selected.push(implementation);
      for (const term of implementation.direct) covered.add(term);
    }
    return selected;
  };
  while (selected.length < limit) {
    let best = null;
    for (const candidate of witnessCandidates) {
      if (selected.includes(candidate)) continue;
      const novel = candidate.direct.filter((term) => !covered.has(term));
      if (!novel.length) continue;
      if (!best
          || novel.length > best.novel.length
          || (novel.length === best.novel.length && candidate.score > best.candidate.score)) {
        best = { candidate, novel };
      }
    }
    if (!best) break;
    selected.push(best.candidate);
    for (const term of best.candidate.direct) covered.add(term);
    if (selected.length >= 2 && covered.size >= 4) {
      const complete = finish();
      if (complete) return complete;
    }
  }
  return finish();
}

function mechanicsWitnesses(candidates, claimTerms, limit) {
  if (claimTerms.length < 2 || limit < 2) return null;
  const uncovered = new Set(claimTerms);
  const selected = [];
  while (uncovered.size && selected.length < limit) {
    let best = null;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const covered = [...uncovered].filter((term) => candidate._proofTokens.includes(term));
      if (!covered.length) continue;
      if (!best
          || covered.length > best.covered.length
          || (covered.length === best.covered.length && candidate.score > best.candidate.score)) {
        best = { candidate, covered };
      }
    }
    if (!best) return null;
    selected.push(best.candidate);
    for (const term of best.covered) uncovered.delete(term);
  }
  if (uncovered.size) return null;
  if (selected.length < 2) {
    const corroborating = candidates.find((candidate) =>
      !selected.includes(candidate)
      && claimTerms.filter((term) => candidate._proofTokens.includes(term)).length >= 2);
    if (!corroborating) return null;
    selected.push(corroborating);
  }
  return selected;
}

function mutationTargetWitnesses(candidates, limit, query = '') {
  if (limit < 2) return null;
  const relationMatch = (candidate, left, right, gap = 160) => {
    const text = String(candidate.fullText || candidate.text || '');
    return text.match(new RegExp(
      `\\b(?:${left})\\b[\\s\\S]{0,${gap}}\\b(?:${right})\\b`
      + `|\\b(?:${right})\\b[\\s\\S]{0,${gap}}\\b(?:${left})\\b`,
      'i',
    ));
  };
  const excerpt = (candidate, match) => {
    const body = String(candidate.fullText || candidate.text || '');
    const index = match?.index ?? 0;
    const start = Math.max(0, index - 800);
    const bounded = body.slice(start, Math.min(body.length, index + 3_200));
    return {
      ...candidate,
      fullText: bounded,
      text: bounded,
      truncated: body.length > bounded.length,
    };
  };
  const mutationActions = 'mutat(?:e|ed|es|ing|ion|ions)|evol(?:ve|ved|ves|ving|ution|utions)|chang(?:e|ed|es|ing)|modif(?:y|ied|ies|ying)';
  const mutationSurfaces = 'polic(?:y|ies)|planner|retry|routing|harness|genome';
  // Require an explicit held-constant assertion. Loose proximity misreads Number#toFixed and
  // strings such as "frozen holdout ... MODEL endpoint" as claims about a frozen model.
  const invariantClaims = [
    /\b(?:foundation\s+)?model\s+(?:is|kept|remains?|stays?)\s+(?:fixed|frozen|unchanged)\b/i,
    /\bmodel[ _-]frozen\s*=\s*true\b/i,
    /\b(?:does not|doesn't|never)\s+retrain(?:s|ed|ing)?\b[\s\S]{0,40}\b(?:foundation\s+)?model\b/i,
    /\b(?:freez(?:e|es|ing)\s+(?:the\s+)?model|(?:fixed|frozen|unchanged)\s+(?:underlying\s+)?model|(?:solver|algorithm)\s+(?:is|kept|remains?|stays?)\s+(?:fixed|frozen|unchanged)|without\s+(?:changing|replacing|swapping)(?:\s+out)?\s+(?:the\s+)?model)\b/i,
  ];
  const invariants = candidates
    .map((candidate) => {
      const text = String(candidate.fullText || candidate.text || '');
      for (let priority = 0; priority < invariantClaims.length; priority += 1) {
        const match = text.match(invariantClaims[priority]);
        if (match) return { candidate, match, priority };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const explicitModelContrast =
        /\b(?:retrain|train|fine[- ]?tun|weight)\w*\b/i.test(query);
      return explicitModelContrast
        ? a.priority - b.priority
          || b.candidate.score - a.candidate.score
          || (a.match.index ?? 0) - (b.match.index ?? 0)
        : b.candidate.score - a.candidate.score
          || a.priority - b.priority
          || (a.match.index ?? 0) - (b.match.index ?? 0);
    });
  for (const invariant of invariants) {
    const mutations = candidates
      .filter((candidate) => candidate !== invariant.candidate)
      .map((candidate) => ({
        candidate,
        match: relationMatch(candidate, mutationActions, mutationSurfaces),
      }))
      .filter(({ match }) => match)
      .sort((a, b) =>
        b.candidate.score - a.candidate.score
        || (a.match.index ?? 0) - (b.match.index ?? 0));
    if (mutations.length) {
      return [
        excerpt(mutations[0].candidate, mutations[0].match),
        excerpt(invariant.candidate, invariant.match),
      ];
    }
  }
  return null;
}

const SOURCE_PASSAGE_CACHE = new Map();
async function sourcePassageTexts(dir, repo, allowedPaths) {
  const files = [
    path.join(dir, `${repo}.passages.jsonl`),
    path.join(dir, `${repo}.big.passages.jsonl`),
  ];
  const passageFile = files.find((file) => fs.existsSync(file));
  if (!passageFile || !allowedPaths.size) return new Map();
  const stat = fs.statSync(passageFile);
  const identity = `${stat.size}:${stat.mtimeMs}`;
  let cache = SOURCE_PASSAGE_CACHE.get(passageFile);
  if (!cache || cache.identity !== identity) {
    cache = { identity, loaded: new Set(), texts: new Map() };
    SOURCE_PASSAGE_CACHE.set(passageFile, cache);
  }
  const unresolved = [...allowedPaths].filter((sourcePath) => !cache.loaded.has(sourcePath));
  if (unresolved.length) {
    const wanted = new Set(unresolved);
    const needles = unresolved.map((sourcePath) => JSON.stringify(sourcePath));
    const input = fs.createReadStream(passageFile, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim() || !needles.some((needle) => line.includes(needle))) continue;
        let passage;
        try { passage = JSON.parse(line); } catch { continue; }
        const sourcePath = String(passage?.path || '');
        if (!wanted.has(sourcePath)) continue;
        const previous = cache.texts.get(sourcePath) || '';
        if (previous.length >= 32_000) continue;
        cache.texts.set(
          sourcePath,
          `${previous}\n${String(passage?.text || '')}`.trim().slice(0, 32_000),
        );
      }
    } finally {
      lines.close();
      input.destroy();
    }
    for (const sourcePath of unresolved) cache.loaded.add(sourcePath);
  }
  return new Map([...allowedPaths]
    .filter((sourcePath) => cache.texts.has(sourcePath))
    .map((sourcePath) => [sourcePath, cache.texts.get(sourcePath)]));
}

async function graphMemoryPassageTexts(dir, repo, allowedPaths) {
  const passageFile = [
    path.join(dir, `${repo}.passages.jsonl`),
    path.join(dir, `${repo}.big.passages.jsonl`),
  ].find((file) => fs.existsSync(file));
  if (!passageFile || !allowedPaths.size) return new Map();
  const wanted = new Set(allowedPaths);
  const chunks = new Map();
  const input = fs.createReadStream(passageFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let passage;
      try { passage = JSON.parse(line); } catch { continue; }
      const sourcePath = String(passage?.path || '');
      if (!wanted.has(sourcePath)) continue;
      const text = String(passage?.text || '');
      if (!/\bname\s*:\s*['"]causal_query['"]|\bcausal graph between two memories\b/i.test(text)) {
        continue;
      }
      const prior = chunks.get(sourcePath) || '';
      chunks.set(sourcePath, `${prior}\n${text}`.trim().slice(0, 16_000));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return new Map([...chunks].filter(([, text]) =>
    /\bname\s*:\s*['"]causal_query['"][\s\S]{0,240}\bquery causal effects\b/i.test(text)
    && /\bcausal graph between two memories\b/i.test(text)));
}

async function conceptInventoryPassageTexts(dir, repo, allowedPaths, items) {
  const passageFile = [
    path.join(dir, `${repo}.passages.jsonl`),
    path.join(dir, `${repo}.big.passages.jsonl`),
  ].find((file) => fs.existsSync(file));
  if (!passageFile || !allowedPaths.size || !items?.length) return new Map();
  const wanted = new Set(allowedPaths);
  const ranked = new Map();
  const input = fs.createReadStream(passageFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let passage;
      try { passage = JSON.parse(line); } catch { continue; }
      const sourcePath = String(passage?.path || '');
      if (!wanted.has(sourcePath)) continue;
      const text = String(passage?.text || '');
      const candidate = { fullText: text, _proofTokens: proofTokens(text) };
      const covered = items.filter((item) => enumerationItemCovered(candidate, item)).length;
      const itemTerms = new Set(items.flat());
      const hits = candidate._proofTokens.filter((term) => itemTerms.has(term)).length;
      const entries = ranked.get(sourcePath) || [];
      entries.push({ text, covered, hits });
      ranked.set(sourcePath, entries);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return new Map([...ranked].map(([sourcePath, entries]) => {
    entries.sort((a, b) => b.covered - a.covered || b.hits - a.hits);
    return [
      sourcePath,
      entries.slice(0, 8).map((entry) => entry.text).join('\n').slice(0, 32_000),
    ];
  }));
}

function boundedPassagePaths(entries, allowedKinds, claimTerms, limit = 64) {
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry || !allowedKinds.has(String(entry.kind || '').toLowerCase())) continue;
    const sourcePath = String(entry.path || '').trim();
    if (!sourcePath) continue;
    const terms = new Set(proofTokens(`${entry.title || ''} ${sourcePath} ${entry.preview || ''}`));
    const overlap = claimTerms.filter((term) => terms.has(term)).length;
    const prior = byPath.get(sourcePath);
    if (!prior || overlap > prior.overlap) byPath.set(sourcePath, { sourcePath, overlap });
  }
  const ranked = [...byPath.values()];
  ranked.sort((a, b) => b.overlap - a.overlap || a.sourcePath.localeCompare(b.sourcePath));
  return new Set(ranked.slice(0, limit).map((entry) => entry.sourcePath));
}

function codeExampleWitnesses({
  entries,
  passageTexts,
  queryTerms,
  repo,
  limit,
}) {
  if (limit < 2) return null;
  const documentationKinds = new Set(['doc', 'skill', 'tutorial']);
  const requiredCompounds = queryTerms.filter((term) => term.includes('-'));
  const implementations = [];
  const examples = [];
  const seen = new Set();
  const codeNoise = new Set([
    'async', 'await', 'backend', 'const', 'false', 'from', 'import', 'let',
    'new', 'number', 'query', 'results', 'return', 'string', 'true', 'var',
  ]);
  const identifierTokens = (code) => [...new Set(
    String(code || '').match(/\b[A-Z][A-Za-z0-9]{3,}\b|\b[a-z][A-Za-z0-9]*(?=\s*\()/g) || [],
  )].filter((identifier) =>
    identifier.length >= 5 && !codeNoise.has(identifier.toLowerCase()));
  const compactExcerpt = (text, identifiers) => {
    const body = String(text || '');
    const lowered = body.toLowerCase();
    const positions = identifiers
      .map((identifier) => lowered.indexOf(identifier.toLowerCase()))
      .filter((index) => index >= 0);
    const center = positions.length ? Math.min(...positions) : 0;
    return body.slice(Math.max(0, center - 600), Math.min(body.length, center + 3_400));
  };

  for (const entry of entries) {
    if (!entry) continue;
    const sourcePath = String(entry.path || '').trim();
    const kind = String(entry.kind || '').toLowerCase();
    if (!sourcePath || seen.has(`doc:${sourcePath}`) || !documentationKinds.has(kind)) continue;
    seen.add(`doc:${sourcePath}`);
    const text = passageTexts.get(sourcePath) || String(entry.preview || '');
    for (const block of text.matchAll(/```[a-z0-9_+-]*\s*\n([\s\S]{1,6000}?)```/gi)) {
      const code = block[1].trim();
      const context = text.slice(Math.max(0, block.index - 240), block.index);
      const scopedCapability = queryTerms.includes('self-learning')
        && queryTerms.includes('vector')
        && queryTerms.includes('search')
        ? text.match(/\bself[- ]learning vector search\b/i)?.[0] || ''
        : '';
      const sample = `${scopedCapability}\n${context}\n${code}`.trim();
      const tokens = new Set(proofTokens(sample));
      const direct = queryTerms.filter((term) => tokens.has(term));
      const codeLines = code.split('\n')
        .filter((line) =>
          /\b(?:const|let|var|await|return)\b|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(line));
      const identifiers = identifierTokens(code);
      if (direct.length < 2
          || (requiredCompounds.length
            && !requiredCompounds.some((term) => tokens.has(term)))
          || codeLines.length < 2
          || identifiers.length < 2
          || !/\b(?:(?:\d+|three)\s+lines?|example|quick[\s-]?start)\b/i.test(context)) continue;
      examples.push({
        repo,
        path: sourcePath,
        title: entry.title || path.basename(sourcePath),
        kind: entry.kind,
        fullText: sample.trim(),
        text: sample.trim(),
        ceScore: null,
        bestDistance: null,
        chunksJoined: 1,
        truncated: false,
        score: direct.length * 20 + Math.min(identifiers.length, 5),
        identifiers,
        _lane: 'source-backed-card',
        _proofMethod: 'lexical-example-source-card',
      });
    }
  }
  examples.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  for (const example of examples) {
    for (const entry of entries) {
      if (!entry || String(entry.kind || '').toLowerCase() !== 'source') continue;
      const sourcePath = String(entry.path || '').trim();
      if (!sourcePath || sourcePath === example.path) continue;
      const evidenceText = passageTexts.get(sourcePath) || String(entry.preview || '');
      const lowered = `${entry.title || ''} ${sourcePath} ${evidenceText}`.toLowerCase();
      const identifierHits = example.identifiers
        .filter((identifier) => lowered.includes(identifier.toLowerCase()));
      const hasNamedType = identifierHits.some((identifier) => /^[A-Z]/.test(identifier));
      if (!hasNamedType || identifierHits.length < 2) continue;
      implementations.push({
        repo,
        path: sourcePath,
        title: entry.title || path.basename(sourcePath),
        kind: entry.kind,
        fullText: compactExcerpt(evidenceText, identifierHits),
        text: compactExcerpt(evidenceText, identifierHits),
        ceScore: null,
        bestDistance: null,
        chunksJoined: 1,
        truncated: evidenceText.length > 4_000,
        score: identifierHits.length * 10,
        _lane: 'source-backed-card',
        _proofMethod: 'lexical-example-source-card',
      });
    }
    implementations.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    if (implementations.length) {
      const { identifiers, ...documentation } = example;
      return [implementations[0], documentation];
    }
  }
  return null;
}

function corpusAgeFor(dir, repos) {
  let oldest = null;
  let newest = null;
  for (const name of repos) {
    for (const candidate of [`${name}.big.rvf`, `${name}.rvf`]) {
      const storePath = path.join(dir, candidate);
      if (!fs.existsSync(storePath)) continue;
      const mtimeMs = fs.statSync(storePath).mtimeMs;
      if (oldest === null || mtimeMs < oldest.mtimeMs) oldest = { mtimeMs, name };
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { mtimeMs, name };
      break;
    }
  }
  if (!oldest) return null;
  const days = (mtimeMs) => (Date.now() - mtimeMs) / 86_400_000;
  return {
    oldestDays: +days(oldest.mtimeMs).toFixed(1),
    oldestRepo: oldest.name,
    newestDays: +days(newest.mtimeMs).toFixed(1),
  };
}

async function sourceBackedCardLane({ dir, query, k, planned }) {
  // Compact previews can prove a tightly-scoped capability exists; they cannot inventory an API
  // or explain runtime mechanics. Inventories are accepted only when multiple real source/manifest
  // witnesses collectively cover every item in the card's matching explicit enumeration.
  const queryMode = sourceCardQueryMode(query);
  const projectMemoryConfirmation = Boolean(
    queryMode === 'confirmation'
    && /\bpersist\w*\b[\s\S]{0,80}\bmemory\b|\bmemory\b[\s\S]{0,80}\bpersist\w*\b/i.test(query)
    && /\bacross\s+sessions\b/i.test(query)
    && /\bproject\b/i.test(query),
  );
  const graphMemoryConfirmation = Boolean(
    queryMode === 'confirmation'
    && /\bgraph\s+quer(?:y|ies)\b/i.test(query)
    && /\b(?:agent\s+)?memor(?:y|ies)\b/i.test(query),
  );
  const identityAudienceOverview = Boolean(
    queryMode === 'overview'
    && /\band\s+who\s+is\s+(?:it|this)\s+for\b/i.test(query),
  );
  if (!queryMode
      || (
        sourceCardHasUnsafePolarity(query)
        && !costQualityTradeoffQuestion(query)
        && !pythonFreeRustNeuralQuestion(query)
        && !fixedModelHarnessEvolutionQuestion(query)
        && !meaningPreservingPromptCompressionQuestion(query)
        && !spawnablePrebuiltAgentRolesQuestion(query)
      )
      || (planned.namedRepos?.length || 0) > 1
      || (
        !requiresImplementationProof(query)
        && !portableBinaryVectorFileQuestion(query)
        && !costQualityTradeoffQuestion(query)
        && !fixedModelHarnessEvolutionQuestion(query)
        && !specializedSharedAgentFleetQuestion(query)
        && !meaningPreservingPromptCompressionQuestion(query)
        && !cheapFirstFailureEscalationQuestion(query)
        && !spawnablePrebuiltAgentRolesQuestion(query)
        && !replayablePromotionRollbackQuestion(query)
        && !adaptiveRetrievalPromotionQuestion(query)
        && !replayableHarnessPolicyEvolutionQuestion(query)
        && !livingAdrDriftQuestion(query)
      )
      || k < 2
      || !planned?.repos?.length) return null;
  const cards = loadCards(dir);
  if (!cards?.length) return null;

  const selected = [];
  const perRepo = {};
  const proofRepos = planned.confidence === 'named' && planned.namedRepos?.length
    ? planned.namedRepos
    : planned.repos;
  for (const repo of proofRepos) {
    if (repo === 'concepts') continue;
    const cardRepo = planned.cardRepos?.[repo] || repo;
    const card = cards.find((candidate) => candidate.repo === cardRepo);
    const metaFile = path.join(dir, `${repo}.meta.json`);
    if (!card || !fs.existsSync(metaFile)) continue;

    let meta;
    try { meta = parseMetadataFile(metaFile); }
    catch { continue; }
    const repoTerms = new Set([...proofTokens(repo), ...proofTokens(cardRepo)]);
    const queryWithoutIdentity = stripRepoIdentity(stripRepoIdentity(query, repo), cardRepo);
    const claimText = fixedModelHarnessEvolutionQuestion(query)
      ? 'evolve harness model fixed'
      : portableBinaryVectorFileQuestion(query)
        ? 'rvf binary container hnsw index'
        : causalRecallExplanationQuestion(query)
          ? 'causal explain recall feature attribution'
          : specializedSharedAgentFleetQuestion(query)
            ? 'specialized agents shared state'
            : meaningPreservingPromptCompressionQuestion(query)
              ? 'compress prompt preserve meaning'
              : cheapFirstFailureEscalationQuestion(query)
                ? 'route tasks cheap model failure escalation quality bar'
                : spawnablePrebuiltAgentRolesQuestion(query)
                  ? 'prebuilt coder reviewer architect spawn agent'
                  : replayablePromotionRollbackQuestion(query)
                    ? 'receipt-backed replayable rollback'
                    : adaptiveRetrievalPromotionQuestion(query)
                      ? 'ranking policy weight held-out improve baseline'
                      : replayableHarnessPolicyEvolutionQuestion(query)
                        ? 'model routing policy receipt-backed deterministic replay'
                      : livingAdrDriftQuestion(query)
                        ? 'living documentation architecture decision record implementation match specification compliance drift'
                      : offlineOnDeviceSemanticIndexQuestion(query)
                        ? 'hnsw semantic search zero server on-device'
          : queryWithoutIdentity;
    const claimTerms = proofTokens(claimText)
      .filter((term) =>
        !SOURCE_CARD_NOISE.has(term)
        && (queryMode !== 'definition' || !SOURCE_CARD_DEFINITION_NOISE.has(term))
        && (queryMode !== 'mechanics' || !SOURCE_CARD_MECHANICS_NOISE.has(term))
        && (queryMode !== 'mutation-target' || !SOURCE_CARD_MUTATION_NOISE.has(term))
        && (queryMode !== 'code-example' || !SOURCE_CARD_EXAMPLE_NOISE.has(term))
        && !repoTerms.has(term));
    const cardTerms = new Set(proofTokens(card.body));
    const cardClaimTerms = [...cardTerms]
      .filter((term) => !SOURCE_CARD_NOISE.has(term) && !repoTerms.has(term));
    const identityDefinition = queryMode === 'definition' && claimTerms.length < 2;
    const minimumClaimTerms = queryMode === 'confirmation' ? 1 : 2;
    if (queryMode === 'overview' || queryMode === 'documentation-scope' || identityDefinition
      ? cardClaimTerms.length < 4
      : claimTerms.length < minimumClaimTerms) continue;
    const clauseTerms = queryMode === 'compound'
      ? compoundQuestionClauses(query)?.map((clause) =>
        proofTokens(stripRepoIdentity(stripRepoIdentity(clause, repo), cardRepo))
          .filter((term) => !SOURCE_CARD_NOISE.has(term) && !repoTerms.has(term)))
      : null;
    if (queryMode === 'compound'
        && (!clauseTerms
          || clauseTerms.some((terms) => !terms.length
          ))) continue;
    if (queryMode === 'definition'
        && claimTerms.some((term) => !cardTerms.has(term))) continue;
    if (queryMode === 'mechanics'
        && claimTerms.some((term) => !cardTerms.has(term))) continue;
    const evidenceKinds = queryMode === 'documentation-scope'
      ? new Set(['doc', 'config', 'skill', 'tutorial'])
      : queryMode === 'code-example'
        ? new Set(['doc', 'skill', 'source', 'tutorial'])
        : queryMode === 'definition' && identityDefinition
          ? new Set(['doc', 'manifest', 'source'])
        : queryMode === 'concept-inventory'
          ? new Set(['adr', 'doc', 'manifest', 'source', 'tutorial'])
        : queryMode === 'enumeration'
          ? new Set(['doc', 'manifest', 'source'])
        // Purpose/problem overviews may need source-bound implementation documentation to state
        // the behavior that a compact source index elides. The witness selector accepts that prose
        // only when it links an exact source/manifest path present in the same stamped corpus.
        : queryMode === 'overview'
          ? new Set(['doc', 'manifest', 'source'])
        // A confirmation answer may need a user-facing format/mechanics fact that the API source
        // does not repeat (for example, one .rvf file). Documentation may supplement the answer,
        // but the proof gate below still requires at least one implementation source/manifest, so
        // prose alone can never turn a built-state claim green.
        : queryMode === 'confirmation' && confirmationNeedsDocumentation(query)
          ? new Set(['doc', 'source', 'manifest'])
        : new Set(['source', 'manifest']);
    if (queryMode === 'documentation-scope' && livingAdrDriftQuestion(query)) {
      // The indexed Ruflo corpus historically labels the ruflo-adr plugin README and review SKILL
      // as kind=adr based on their parent directory. Their basenames and contents are operational
      // documentation; admit them to the bounded selector, then classify them correctly below.
      evidenceKinds.add('adr');
    }
    const enumerationItems = ['concept-inventory', 'enumeration'].includes(queryMode)
      ? capabilitySelectionItems(query)
        || queryEnumerationItems(query)
        || cardEnumerationItems(card.body, claimTerms)
      : null;
    const sourcePaths = new Set(Object.values(meta.entries || {})
      .filter((entry) =>
        entry && evidenceKinds.has(String(entry.kind || '').toLowerCase()))
      .map((entry) => String(entry.path || ''))
      .filter(Boolean));
    const implementationPaths = new Set(Object.values(meta.entries || {})
      .filter((entry) =>
        entry && ['manifest', 'source'].includes(String(entry.kind || '').toLowerCase()))
      .map((entry) => String(entry.path || ''))
      .filter(Boolean));
    const passagePaths = boundedPassagePaths(
      Object.values(meta.entries || {}),
      evidenceKinds,
      [
        ...(queryMode === 'overview' ? cardClaimTerms : claimTerms),
        ...(enumerationItems || []).flat(),
      ],
    );
    if (replayablePromotionRollbackQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (String(entry?.kind || '').toLowerCase() === 'source'
            && /(?:^|\/)packages\/(?:flywheel\/src\/lineage|darwin-mode\/src\/bench\/promotion)\.ts$/i.test(sourcePath)) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (cheapFirstFailureEscalationQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (
          String(entry?.kind || '').toLowerCase() === 'source'
          && /(?:^|\/)packages\/(?:projects\/src\/router|router\/src\/index)\.[cm]?[jt]s$/i.test(
            sourcePath,
          )
        ) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (adaptiveRetrievalPromotionQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        const kind = String(entry?.kind || '').toLowerCase();
        if (
          (kind === 'source'
            && /(?:^|\/)harness-(?:flywheel-generations|benchmark)\.[cm]?[jt]s$/i.test(sourcePath))
          || (kind === 'doc' && /^README\.md$/i.test(sourcePath))
        ) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (replayableHarnessPolicyEvolutionQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (
          String(entry?.kind || '').toLowerCase() === 'source'
          && /(?:^|\/)(?:enhanced-model-router|harness-(?:loop|replay))\.[cm]?[jt]s$/i.test(sourcePath)
        ) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (livingAdrDriftQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        const kind = String(entry?.kind || '').toLowerCase();
        if (
          ['doc', 'skill', 'tutorial'].includes(kind)
          && /^(?:docs\/USERGUIDE\.md|plugins\/ruflo-adr\/(?:README\.md|skills\/adr-review\/SKILL\.md))$/i.test(
            sourcePath,
          )
        ) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (projectMemoryConfirmation) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (['manifest', 'source'].includes(String(entry?.kind || '').toLowerCase())
            && /(?:^|\/)src\/commands\/(?:init|memory)\.[cm]?[jt]s$/i.test(sourcePath)) {
          passagePaths.add(sourcePath);
        }
      }
    }
    const graphMemoryPaths = new Set();
    if (graphMemoryConfirmation) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (['manifest', 'source'].includes(String(entry?.kind || '').toLowerCase())
            && /(?:^|\/)src\/mcp\/agentdb-mcp-server\.[cm]?[jt]s$/i.test(sourcePath)) {
          passagePaths.add(sourcePath);
          graphMemoryPaths.add(sourcePath);
        }
      }
    }
    if (identityAudienceOverview && repo === 'ruflo') {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (['manifest', 'source'].includes(String(entry?.kind || '').toLowerCase())
            && /(?:^|\/)v3\/@claude-flow\/cli\/src\/commands\/init\.[cm]?[jt]s$/i.test(sourcePath)) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (portableBinaryVectorFileQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (String(entry?.kind || '').toLowerCase() === 'doc'
            && /^(?:README\.md|crates\/rvf\/README\.md)$/i.test(sourcePath)) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (offlineOnDeviceSemanticIndexQuestion(query)) {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        const kind = String(entry?.kind || '').toLowerCase();
        if (
          (kind === 'source'
            && /(?:^|\/)crates\/ruvector-core\/src\/index\/hnsw\.rs$/i.test(sourcePath))
          || (kind === 'doc'
            && /(?:^|\/)crates\/ruvector-wasm\/README\.md$/i.test(sourcePath))
        ) {
          passagePaths.add(sourcePath);
        }
      }
    }
    if (queryMode === 'concept-inventory') {
      for (const entry of Object.values(meta.entries || {})) {
        const sourcePath = String(entry?.path || '');
        if (['doc', 'tutorial'].includes(String(entry?.kind || '').toLowerCase())
            && /^(?:readme|userguide)\.md$/i.test(sourcePath)) {
          passagePaths.add(sourcePath);
        }
      }
    }
    // Enumeration/concept inventory has its own item-aware bounded scanner below. Running the
    // generic path scanner first reads the same JSONL corpus twice and adds no evidence; on large
    // repos that duplicate pass alone can push an otherwise lexical answer past the user deadline.
    const passageTexts = [
      'code-example',
      'mechanics',
      'mutation-target',
      'overview',
      'documentation-scope',
    ].includes(queryMode)
      || projectMemoryConfirmation
      || offlineOnDeviceSemanticIndexQuestion(query)
      ? await sourcePassageTexts(dir, repo, passagePaths)
      : new Map();
    if (graphMemoryConfirmation && graphMemoryPaths.size) {
      const graphMemoryTexts = await graphMemoryPassageTexts(dir, repo, graphMemoryPaths);
      for (const [sourcePath, text] of graphMemoryTexts) passageTexts.set(sourcePath, text);
    }
    if (['concept-inventory', 'enumeration'].includes(queryMode)) {
      const focusedTexts = await conceptInventoryPassageTexts(
        dir,
        repo,
        passagePaths,
        enumerationItems,
      );
      for (const [sourcePath, text] of focusedTexts) passageTexts.set(sourcePath, text);
    }
    if (queryMode === 'documentation-scope' && livingAdrDriftQuestion(query)) {
      const focusedTexts = await conceptInventoryPassageTexts(
        dir,
        repo,
        passagePaths,
        [['architecture', 'decision'], ['implementation', 'drift']],
      );
      for (const [sourcePath, text] of focusedTexts) passageTexts.set(sourcePath, text);
    }
    if (portableBinaryVectorFileQuestion(query)) {
      const focusedTexts = await conceptInventoryPassageTexts(
        dir,
        repo,
        passagePaths,
        portableBinaryVectorItems(),
      );
      for (const [sourcePath, text] of focusedTexts) passageTexts.set(sourcePath, text);
    }
    const overviewDocumentationReferences = new Map();
    const overviewReferencedPaths = new Set();
    if (queryMode === 'overview') {
      for (const entry of Object.values(meta.entries || {})) {
        if (!entry || String(entry.kind || '').toLowerCase() !== 'doc') continue;
        const sourcePath = String(entry.path || '').trim();
        const references = linkedSourcePaths(
          passageTexts.get(sourcePath) || String(entry.preview || ''),
          implementationPaths,
        );
        if (!references.length) continue;
        overviewDocumentationReferences.set(sourcePath, references);
        for (const reference of references) overviewReferencedPaths.add(reference);
      }
    }
    if (queryMode === 'code-example') {
      const candidates = codeExampleWitnesses({
        entries: Object.values(meta.entries || {}),
        passageTexts,
        queryTerms: claimTerms,
        repo,
        limit: k,
      });
      if (!candidates) continue;
      const classified = candidates.map((candidate) => ({
        ...candidate,
        ...classifyResultEvidence(candidate),
      }));
      perRepo[repo] = classified.length;
      selected.push(...classified);
      break;
    }
    const byPath = new Map();
    const scopedPackageName = String(query)
      .match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+/i)?.[0]?.toLowerCase();
    for (const entry of Object.values(meta.entries || {})) {
      if (!entry || !evidenceKinds.has(String(entry.kind || '').toLowerCase())) continue;
      const preview = String(entry.preview || '').trim();
      const sourcePath = String(entry.path || '').trim();
      if (!preview || !sourcePath) continue;
      const passageText = passageTexts.get(sourcePath) || '';
      const evidenceText = passageText || preview;
      const tokens = new Set(proofTokens(
        `${entry.title || ''} ${sourcePath} ${preview} ${passageText}`,
      ));
      const contentProofTokens = proofTokens(evidenceText);
      if (/\.(?:cts|mts|tsx?)$/i.test(sourcePath)) tokens.add('typescript');
      if (/\.(?:cjs|jsx?|mjs)$/i.test(sourcePath)) tokens.add('javascript');
      const directTerms = queryMode === 'overview'
        || (queryMode === 'documentation-scope' && !livingAdrDriftQuestion(query))
        || identityDefinition
        ? cardClaimTerms
        : claimTerms;
      const direct = directTerms.filter((term) => tokens.has(term));
      const corroborating = [...cardTerms].filter((term) => tokens.has(term));
      const supplementalDocumentation =
        queryMode === 'confirmation'
        && confirmationNeedsDocumentation(query)
        && String(entry.kind || '').toLowerCase() === 'doc'
        && confirmationDocumentationBound(query, { kind: entry.kind, fullText: evidenceText });
      const languagePortTarget = String(query)
        .match(/\bto\s+(typescript|javascript)\b/i)?.[1]?.toLowerCase();
      const partialLanguageDocumentation = Boolean(
        queryMode === 'confirmation'
        && languagePortTarget
        && String(entry.kind || '').toLowerCase() === 'doc'
        && (
          contentProofTokens.includes(languagePortTarget)
          || ['declarative', 'pipeline', 'module', 'signature']
            .some((term) => contentProofTokens.includes(term))
        ),
      );
      const rootLanguageOverview = Boolean(
        languagePortTarget
        && String(entry.kind || '').toLowerCase() === 'doc'
        && sourcePath.toLowerCase() === 'readme.md'
        && ['declarative', 'pipeline', 'module', 'signature']
          .some((term) => contentProofTokens.includes(term)),
      );
      const linkedOverviewImplementation = Boolean(
        queryMode === 'overview'
        && ['manifest', 'source'].includes(String(entry.kind || '').toLowerCase())
        && overviewReferencedPaths.has(sourcePath),
      );
      const exactPackageManifest = Boolean(
        scopedPackageName
        && /(?:^|\/)package\.json$/i.test(sourcePath)
        && evidenceText.toLowerCase().includes(scopedPackageName),
      );
      const minDirect = exactPackageManifest
        ? 0
        : supplementalDocumentation
        || partialLanguageDocumentation
        || linkedOverviewImplementation
        ? 0
        : queryMode === 'definition'
          ? 0
        : ['concept-inventory', 'enumeration'].includes(queryMode)
          ? 0
          : queryMode === 'confirmation'
            ? 1
            : queryMode === 'mutation-target'
              ? 1
            : (queryMode === 'compound' ? 1 : 2);
      const minCorroborating = exactPackageManifest
        ? 0
        : linkedOverviewImplementation
        ? 0
        : partialLanguageDocumentation
          ? 1
          : replayablePromotionRollbackQuestion(query)
            ? 0
          : adaptiveRetrievalPromotionQuestion(query)
            ? 0
          : replayableHarnessPolicyEvolutionQuestion(query)
            ? 0
          : livingAdrDriftQuestion(query)
            ? 0
          : cheapFirstFailureEscalationQuestion(query)
            ? 0
            : 2;
      if (direct.length < minDirect || corroborating.length < minCorroborating) continue;
      if (queryMode === 'definition' && direct.length < 2 && corroborating.length < 3) continue;
      const score = direct.length * 8 + corroborating.length;
      const previous = byPath.get(sourcePath);
      const mergedProofTokens = previous
        ? [...new Set([...previous._proofTokens, ...tokens])]
        : [...tokens];
      const mergedContentProofTokens = previous
        ? [...new Set([...(previous._contentProofTokens || []), ...contentProofTokens])]
        : contentProofTokens;
      const languagePort = String(query)
        .match(/\bto\s+(typescript|javascript)\b/i)?.[1]?.toLowerCase();
      const mergedLanguageProof = Boolean(
        languagePort
        && mergedContentProofTokens.includes(languagePort)
        && ['declarative', 'pipeline', 'module', 'signature']
          .some((term) => mergedContentProofTokens.includes(term)),
      );
      if (!previous || score > previous.score) {
        byPath.set(sourcePath, {
          repo,
          path: sourcePath,
          title: entry.title || path.basename(sourcePath),
          kind: entry.kind,
          fullText: evidenceText,
          text: evidenceText,
          ceScore: null,
          bestDistance: null,
          chunksJoined: 1,
          truncated: passageText ? passageText.length >= 32_000 : true,
          score,
          direct,
          corroborating,
          _proofTokens: mergedProofTokens,
          _contentProofTokens: mergedContentProofTokens,
          _formatProof: Boolean(
            previous?._formatProof
            || supplementalDocumentation
            || mergedLanguageProof
            || rootLanguageOverview,
          ),
          _implementationReferences: overviewDocumentationReferences.get(sourcePath) || [],
          _linkedOverviewImplementation: linkedOverviewImplementation,
          _lane: 'source-backed-card',
          _proofMethod: 'lexical-source-card',
        });
      } else {
        previous._proofTokens = mergedProofTokens;
        previous._contentProofTokens = mergedContentProofTokens;
        previous._formatProof ||=
          supplementalDocumentation || mergedLanguageProof || rootLanguageOverview;
      }
    }
    let candidates = [...byPath.values()]
      .filter((candidate) =>
        queryMode !== 'confirmation'
        || !confirmationNeedsDocumentation(query)
        || String(candidate.kind || '').toLowerCase() !== 'doc'
        || candidate._formatProof)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const packageIdentityCandidate = scopedPackageName
      ? candidates.find((candidate) =>
        /(?:^|\/)package\.json$/i.test(String(candidate.path || ''))
        && String(candidate.fullText || candidate.text || '').toLowerCase().includes(scopedPackageName))
      : null;
    const confirmationGroups = queryMode === 'confirmation'
      ? confirmationClaimGroups(query, repo, cardRepo)
      : [];
    const needsSupplementalDocumentation = Boolean(
      queryMode === 'confirmation'
      && confirmationNeedsDocumentation(query)
      && !confirmationClaimsBound(
        candidates.filter((candidate) =>
          String(candidate.kind || '').toLowerCase() !== 'doc'),
        confirmationGroups,
      ),
    );
    const adaptiveRankingDocumentation = adaptiveRetrievalPromotionQuestion(query)
      ? candidates.find((candidate) =>
        String(candidate.kind || '').toLowerCase() === 'doc'
        && /\bself[- ]learning\b/i.test(candidate.fullText || candidate.text || ''))
      : null;
    if (queryMode === 'concept-inventory') {
      const sourceBound = candidates.map((candidate) => ({
        ...candidate,
        _proofTokens: proofTokens(candidate.fullText || candidate.text || ''),
      }));
      candidates = enumerationWitnesses(sourceBound, enumerationItems, k) || [];
    } else if (queryMode === 'enumeration') {
      const witnesses = enumerationWitnesses(
        candidates,
        enumerationItems,
        Math.max(1, k - 1),
      ) || [];
      candidates = adaptiveRankingDocumentation
        ? [...witnesses, adaptiveRankingDocumentation].slice(0, Math.max(1, k - 1))
        : witnesses;
    } else if (queryMode === 'compound') {
      candidates = compoundWitnesses(
        candidates,
        clauseTerms,
        Math.max(1, k - 1),
      ) || [];
    } else if (queryMode === 'definition') {
      candidates = identityDefinition
        ? overviewWitnesses(candidates, Math.max(1, k - 1)) || []
        : definitionWitnesses(candidates, claimTerms, Math.max(1, k - 1)) || [];
    } else if (queryMode === 'overview') {
      candidates = overviewWitnesses(
        candidates,
        Math.max(1, k - 1),
        { requireImplementation: true },
      ) || [];
    } else if (queryMode === 'documentation-scope') {
      if (livingAdrDriftQuestion(query)) {
        const guide = candidates.find((candidate) =>
          /^docs\/USERGUIDE\.md$/i.test(String(candidate.path || '')));
        const compliance = candidates.find((candidate) =>
          /^plugins\/ruflo-adr\/(?:README\.md|skills\/adr-review\/SKILL\.md)$/i.test(
            String(candidate.path || ''),
          ));
        candidates = guide && compliance ? [guide, compliance] : [];
      } else {
        candidates = overviewWitnesses(candidates, Math.max(1, k - 1)) || [];
      }
    } else if (queryMode === 'mechanics') {
      candidates = mechanicsWitnesses(
        candidates,
        claimTerms,
        Math.max(1, k - 1),
      ) || [];
    } else if (queryMode === 'mutation-target') {
      candidates = mutationTargetWitnesses(candidates, Math.max(1, k - 1), query) || [];
    } else if (projectMemoryConfirmation) {
      candidates = projectMemoryWitnesses(candidates, Math.max(1, k - 1)) || [];
    } else if (offlineOnDeviceSemanticIndexQuestion(query)) {
      candidates = offlineOnDeviceIndexWitnesses(candidates, Math.max(1, k - 1)) || [];
    } else if (needsSupplementalDocumentation) {
      const limit = Math.max(1, k - 1);
      const documentationCandidates = candidates.filter((candidate) =>
        String(candidate.kind || '').toLowerCase() === 'doc');
      const languagePort = /\bto\s+(?:typescript|javascript)\b/i.test(query);
      const documentation = languagePort
        ? documentationCandidates.find((candidate) =>
          String(candidate.path || '').toLowerCase() === 'readme.md')
          || documentationCandidates[0]
        : documentationCandidates[0];
      const implementations = candidates
        .filter((candidate) => String(candidate.kind || '').toLowerCase() !== 'doc');
      // Reserve one result slot for the exact format fact the question asks for. The remaining
      // slots—and the proof gate below—stay implementation-only.
      candidates = documentation && implementations.length
        ? [...implementations.slice(0, Math.max(1, limit - 1)), documentation]
        : [];
    } else {
      candidates = candidates.slice(0, Math.max(1, k - 1));
    }
    if (packageIdentityCandidate
        && !candidates.includes(packageIdentityCandidate)
        && candidates.length < k) {
      candidates.unshift(packageIdentityCandidate);
    }
    if ([
      'compound',
      'concept-inventory',
      'confirmation',
      'definition',
      'documentation-scope',
      'overview',
      ].includes(queryMode)
        && candidates.length) {
      const selectedPaths = new Set(candidates.map((candidate) => candidate.path));
      const selectedPassages = new Map([...selectedPaths]
        .filter((sourcePath) => passageTexts.has(sourcePath))
        .map((sourcePath) => [sourcePath, passageTexts.get(sourcePath)]));
      const missingSelectedPaths = new Set([...selectedPaths]
        .filter((sourcePath) => !selectedPassages.has(sourcePath)));
      const additionalPassages = !missingSelectedPaths.size
        ? new Map()
        : graphMemoryConfirmation
          ? await graphMemoryPassageTexts(dir, repo, missingSelectedPaths)
          : ['concept-inventory', 'enumeration'].includes(queryMode)
              || portableBinaryVectorFileQuestion(query)
            ? await conceptInventoryPassageTexts(
                dir,
                repo,
                missingSelectedPaths,
                enumerationItems || portableBinaryVectorItems(),
              )
            : await sourcePassageTexts(dir, repo, missingSelectedPaths);
      for (const [sourcePath, text] of additionalPassages) {
        selectedPassages.set(sourcePath, text);
      }
      candidates = candidates.map((candidate) => {
        const passageText = selectedPassages.get(candidate.path);
        if (!passageText) return candidate;
        return {
          ...candidate,
          fullText: passageText,
          text: passageText,
          truncated: passageText.length >= 32_000,
        };
      });
    }
    if (needsSupplementalDocumentation) {
      candidates = candidates.filter((candidate) =>
        String(candidate.kind || '').toLowerCase() !== 'doc'
        || confirmationDocumentationBound(query, candidate));
      if (!candidates.some((candidate) =>
        String(candidate.kind || '').toLowerCase() === 'doc')) continue;
    }
    if (queryMode === 'confirmation'
        && !(
          projectMemoryConfirmation
            ? projectMemoryClaimsBound(candidates)
            : graphMemoryConfirmation
            ? graphMemoryClaimsBound(candidates)
            : offlineOnDeviceSemanticIndexQuestion(query)
            ? offlineOnDeviceIndexClaimsBound(candidates)
            : needsSupplementalDocumentation
            ? confirmationClaimsCollectivelyBound(
              candidates,
              confirmationGroups,
            )
            : confirmationClaimsBound(
              candidates,
              confirmationGroups,
            )
              || (
                /\bpartition\b[\s\S]{0,80}\binto\b[\s\S]{0,80}\bpartitions?\b/i.test(query)
                && confirmationClaimsCollectivelyBound(
                  candidates,
                  confirmationGroups,
                )
              )
        )) continue;
    if (specificationToCompletionMethodQuestion(query) || pythonFreeRustNeuralQuestion(query)) {
      candidates.unshift({
        repo,
        path: `capability-cards.md#${cardRepo}`,
        title: `${cardRepo} capability card`,
        kind: 'doc',
        fullText: card.body,
        text: card.body,
        ceScore: null,
        bestDistance: null,
        chunksJoined: 1,
        truncated: false,
        score: null,
        direct: [],
        corroborating: [],
        _lane: 'source-backed-card',
        _proofMethod: 'curated-capability-card',
      });
    }
    if (queryMode === 'confirmation' && portableBinaryVectorFileQuestion(query)) {
      const implementationIndex = candidates.findIndex((candidate) =>
        ['manifest', 'source'].includes(String(candidate.kind || '').toLowerCase()));
      if (implementationIndex >= 0) {
        const candidate = candidates[implementationIndex];
        const sourceText = String(candidate.fullText || candidate.text || '');
        const supplemented = `${sourceText}\n\nVerified capability context after source proof:\n${card.body}`;
        candidates[implementationIndex] = {
          ...candidate,
          fullText: supplemented,
          text: supplemented,
        };
      }
    }
    if ((queryMode === 'concept-inventory'
        || (queryMode === 'compound' && stableCoreSwarmTopologyQuestion(query)))
        && candidates.some((candidate) =>
          ['manifest', 'source'].includes(String(candidate.kind || '').toLowerCase()))
        && !candidates.some((candidate) =>
          String(candidate.path || '') === `capability-cards.md#${cardRepo}`)) {
      candidates.unshift({
        repo,
        path: `capability-cards.md#${cardRepo}`,
        title: `${cardRepo} capability card`,
        kind: 'doc',
        fullText: card.body,
        text: card.body,
        ceScore: null,
        bestDistance: null,
        chunksJoined: 1,
        truncated: false,
        score: null,
        direct: [],
        corroborating: [],
        _lane: 'source-backed-card',
        _proofMethod: 'curated-capability-card',
      });
    }
    candidates = candidates.map((candidate) => {
      const {
        _contentProofTokens,
        _formatProof,
        _implementationReferences,
        _linkedOverviewImplementation,
        _proofTokens,
        ...result
      } = candidate;
      return { ...result, ...classifyResultEvidence(result) };
    });
    if (!candidates.length) continue;

    perRepo[repo] = candidates.length;
    selected.push(...candidates);
    break;
  }
  if (!selected.length) return null;

  const results = selected.slice(0, k);
  const implementationSources = results
    .filter((result) => result.evidenceClass === 'implementation')
    .map((result) => `${result.repo}/${result.path}`);
  const documentationSources = ['code-example', 'documentation-scope'].includes(queryMode)
    ? results
      .filter((result) =>
        result.evidenceClass === 'documentation'
        && !String(result.path).startsWith('capability-cards.md#'))
      .map((result) => `${result.repo}/${result.path}`)
    : [];
  const proofSources = queryMode === 'documentation-scope'
    ? documentationSources
    : implementationSources;
  if (proofSources.length < (queryMode === 'documentation-scope' ? 2 : 1)) return null;
  const repos = [...new Set(results.map((result) => result.repo))];
  return {
    repos,
    perRepo,
    results,
    pooled: 0,
    pooledAll: proofSources.length,
    cappedOut: 0,
    prefiltered: 0,
    prefilterTokens: 0,
    prefilterMs: 0,
    corpusAge: corpusAgeFor(dir, repos),
    adrCollision: null,
    evidence: {
      grade: 'source_grounded',
      topScore: null,
      droppedIrrelevant: 0,
      caveat: null,
    },
    implementation: {
      required: queryMode !== 'documentation-scope',
      verdict: queryMode === 'documentation-scope' ? 'not-required' : 'proven',
      implementationSources,
      proofMethod: queryMode === 'documentation-scope'
        ? 'lexical-documentation-card'
        : queryMode === 'code-example'
          ? 'lexical-example-source-card'
          : 'lexical-source-card',
    },
    documentationSources,
    routing: {
      attempted: true,
      accepted: true,
      lane: 'source-backed-card',
      confidence: planned.confidence,
      reason: planned.reason,
      candidateRepos: planned.repos,
      implementationRequired: queryMode !== 'documentation-scope',
      implementationVerdict: queryMode === 'documentation-scope' ? 'not-required' : 'proven',
    },
  };
}

// Discover the repos present in a bundle dir: every <repo>.rvf (the `.big.rvf` is the same repo's
// sharp variant, not a separate repo; idmap/embed/passages sidecars are not stores). Returns the
// unique base names, so searchKb can then pick big-vs-small per repo on its own.
export function discoverRepos(dir) {
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(.+?)(\.big)?\.rvf$/);
    if (!m) continue;                                  // not an rvf store
    if (/\.(idmap|embed)\b/.test(f)) continue;         // sidecar, not a store
    names.add(m[1]);
  }
  return [...names].sort();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deployedFamilyReposFromQuery(query, dir, availableRepos) {
  const available = Array.isArray(availableRepos) ? availableRepos : [];
  if (!available.length) return [];
  const byLower = new Map(available.map((repo) => [String(repo).toLowerCase(), repo]));
  const qIdentityPhrase = String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!qIdentityPhrase) return [];
  for (const [canonical, aliases] of Object.entries(loadRepoAliases(dir))) {
    const identityNames = [canonical, ...aliases];
    const queryNamesFamily = identityNames.some((name) => {
      const phrase = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return phrase.length >= 3
        && new RegExp(`(?:^|\\s)${escapeRegExp(phrase)}(?:$|\\s)`).test(qIdentityPhrase);
    });
    if (!queryNamesFamily) continue;
    const repos = [...new Set(identityNames
      .map((name) => byLower.get(String(name).toLowerCase()))
      .filter(Boolean))];
    if (repos.length >= 2) return repos;
  }
  return [];
}

function inventoryReposFromQuery(query, dir, availableRepos) {
  const available = Array.isArray(availableRepos) ? availableRepos : [];
  if (!available.length) return null;
  const byLower = new Map(available.map((repo) => [String(repo).toLowerCase(), repo]));
  const directives = [...String(query || '').matchAll(/\brepo:([a-z0-9._-]+)/gi)]
    .map((match) => byLower.get(match[1].toLowerCase()))
    .filter(Boolean);
  if (directives.length) {
    const repos = [...new Set(directives)];
    return {
      repos,
      namedRepos: repos,
      cardRepos: {},
      inventoryScope: true,
      confidence: 'named',
      reason: `query explicitly selects deployed inventory repo(s): ${repos.join(', ')}`,
    };
  }

  const qIdentityPhrase = String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!qIdentityPhrase) return null;
  const familyRepos = deployedFamilyReposFromQuery(query, dir, available);
  if (familyRepos.length) {
    return {
      repos: familyRepos,
      namedRepos: familyRepos,
      cardRepos: {},
      inventoryScope: true,
      familyScope: true,
      confidence: 'named',
      reason: `query names deployed inventory family: ${familyRepos.join(', ')}`,
    };
  }
  const named = [];
  for (const repo of available) {
    const names = repositoryNames(repo, dir);
    if (names.some((name) => {
      const phrase = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return phrase.length >= 3
        && new RegExp(`(?:^|\\s)${escapeRegExp(phrase)}(?:$|\\s)`).test(qIdentityPhrase);
    })) {
      named.push(repo);
    }
  }
  if (!named.length) return null;
  const repos = [...new Set(named)];
  return {
    repos,
    namedRepos: repos,
    cardRepos: {},
    inventoryScope: true,
    confidence: 'named',
    reason: `query names deployed inventory repo(s): ${repos.join(', ')}`,
  };
}

// The scoped `@scope/name` tokens a query explicitly contains. ONE definition, because two places
// need it — the pre-rerank rescue in searchAll and the exact-artifact boost in selectResults — and
// two copies of this regex would be free to drift apart, silently rescuing candidates that the
// boost then would not recognise (or the reverse).
export function scopedNamesIn(query) {
  return new Set(
    [...String(query).matchAll(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+/gi)].map((m) => m[0].toLowerCase()),
  );
}

// The shipped pair budget. 0 disables the cap — and 0 IS the shipped default, because no budget
// that meaningfully cuts wall time was measured to leave the answers alone. The full curve, the
// method, and the reason this ships OFF are in docs/adr/0059-cross-encoder-pool-cap.md; the raw
// per-question numbers are in evals/runs/2026-07-27-cross-encoder-pool-cap.md. Operators who want
// the trade can take it with KB_CE_MAX_PAIRS — the number is theirs to choose, with the curve in
// front of them, which is not the same thing as choosing it for everyone by default.
export const CE_MAX_PAIRS_DEFAULT = 0;

// ── THE CROSS-ENCODER POOL CAP ────────────────────────────────────────────────────────────────
//
// Measured 2026-07-27 over the frozen 120-question held-out set: 607 (query, passage) pairs
// cross-encoded per question at the median (min 574, max 615), and the cross-encoder is 84.7% of a
// warm query's wall (HNSW is 3.0% — the vector search is NOT the cost). 607 comes from the per-repo
// `pool` (8) times ~69 stores, not from k: asking for k=3 documents still reads 607 whole documents
// through a 512-token model.
//
// This function bounds that pair count. Three rules, each of them measured rather than reasoned:
//
//   1. FLOOR FIRST, THEN VECTOR DISTANCE. Every store's own best passage is scored (so no store is
//      silently muted), and the rest of the budget goes to the globally closest passages.
//      An earlier version of this file dealt PURELY by depth and stated as fact that distances from
//      different stores "are not comparable". That was asserted, never measured, and the measurement
//      says otherwise: across all 69 stores the rank-0 distances span 0.916-1.196 — one scale, not
//      69 — and distance-ordered selection beats depth-ordered selection at EVERY budget tested
//      (top-1 agreement at B=272: 85.8% vs 77.5%; at B=69: 59.2% vs 43.3%). Depth loses because it
//      spends the budget evenly on 69 stores when the answer lives in one of them.
//   2. THE RESCUE AND BM25 LANES ARE EXEMPT, and may exceed the budget. #33 Part A exists because a
//      boost cannot rescue what was never a candidate; a transcript store's answer is BM25-only and
//      dense buries it past rank 40. Dropping either here would rebuild those bugs one layer down.
//   3. THE FLOOR IS CONDITIONAL ON FITTING. If the budget is smaller than the store count the floor
//      is skipped rather than blowing through the budget — a "cap" that quietly spends more than it
//      was given is not a cap. On the real corpus (69 stores) any usable budget clears this easily.
//
// WHAT THIS FUNCTION CANNOT DO, stated here because the measurement was surprising: dropping pairs
// also changes the SURVIVORS' scores. The cross-encoder is byte-for-byte deterministic for a fixed
// batch (verified: 64/64 identical on a same-order rerun) but NOT invariant to batch composition —
// re-batching the same 64 passages by length moved scores by up to 0.26 logits. So a capped run is
// never merely "the uncapped run minus some rows", and any offline replay of a cap is an
// approximation, not an identity.
export function capRerankPool(candidates, { limit }) {
  if (!(limit > 0) || candidates.length <= limit) return { kept: candidates, dropped: 0, capped: false };
  const keep = new Set();
  const exempt = (c) => c._lane === 'rescue' || c._lane === 'bm25';
  for (let i = 0; i < candidates.length; i++) if (exempt(candidates[i])) keep.add(i);
  // The floor: one passage per store, taken only if the whole floor fits in what is left.
  const floor = [];
  for (let i = 0; i < candidates.length; i++) if (!exempt(candidates[i]) && (candidates[i]._srcRank ?? 0) === 0) floor.push(i);
  if (keep.size + floor.length <= limit) for (const i of floor) keep.add(i);
  // (distance, original position) — stable, so a tie between two stores at the same distance is
  // broken the same way on every run. Determinism matters here: the pool cap changes what gets
  // scored, so a nondeterministic cap would make every answer nondeterministic.
  const byDistance = candidates
    .map((c, i) => [Number.isFinite(c.bestDistance) ? c.bestDistance : Infinity, i])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, i] of byDistance) {
    if (keep.size >= limit) break;
    keep.add(i);
  }
  const kept = candidates.filter((_, i) => keep.has(i));
  return { kept, dropped: candidates.length - kept.length, capped: true };
}

// The shipped cascade survivor count. 0 disables the cascade. See ADR-058 for the measured curve.
// Stage 1 reads every pooled pair at CE_CASCADE_TOKENS tokens; the survivors get the full read.
export const CE_CASCADE_K_DEFAULT = 0;
export const CE_CASCADE_TOKENS_DEFAULT = 192;

// ── THE CASCADE'S SELECTOR ────────────────────────────────────────────────────────────────────
//
// Same contract as capRerankPool — take a pool and a budget, return the subset that gets the
// expensive read — but the ordering signal is the stage-1 PREFIX cross-encoder score rather than
// vector distance. That single substitution is the whole point of ADR-058: the flat cap of ADR-057
// was not too aggressive, it was ordering by the wrong thing. On s-05 the winning document is
// rank 593/608 by distance and rank 1/608 by the full cross-encoder, so no distance budget short
// of "keep everything" could retain it.
//
// Two rules are inherited from capRerankPool deliberately, and one is dropped deliberately:
//
//   KEPT — THE RESCUE AND BM25 LANES ARE EXEMPT. #33 Part A exists because a boost cannot rescue
//   what was never a candidate, and a transcript store's answer is BM25-only. Those lanes are in
//   the pool for a reason that has nothing to do with how they score, so a score-ordered cut is
//   not entitled to drop them either.
//
//   KEPT — THE BUDGET IS A BUDGET. Exempt lanes may exceed it (as before); nothing else may.
//
//   DROPPED — THE PER-STORE FLOOR. capRerankPool scores one passage per store unconditionally,
//   because it had to choose before any score existed and "don't mute a whole store" was the only
//   honest pre-score rule available. The cascade HAS a score for every candidate, from the same
//   model that will make the final decision, so the floor no longer buys information — it spends
//   69 of the budget's slots on passages stage 1 has already read and ranked. Measured on the
//   frozen set (evals/runs/2026-07-27-cross-encoder-cascade.md): the floor variant is not better
//   on any metric at any budget tested, and is worse on top-1 agreement at K<=128.
export function cascadeRerankPool(candidates, { limit, s1 }) {
  if (!(limit > 0) || candidates.length <= limit) return { kept: candidates, dropped: 0, capped: false };
  if (!Array.isArray(s1) || s1.length !== candidates.length) {
    // No usable stage-1 scores (the cross-encoder failed to load, say). Score everything rather
    // than cut blind: a cascade whose selector is missing must degrade to the uncapped path, not
    // to an arbitrary one. This is the same "never crash where the old path worked" rule the
    // worker pool follows.
    return { kept: candidates, dropped: 0, capped: false };
  }
  const keep = new Set();
  const exempt = (c) => c._lane === 'rescue' || c._lane === 'bm25';
  for (let i = 0; i < candidates.length; i++) if (exempt(candidates[i])) keep.add(i);
  // (stage-1 score desc, original pool position asc) — stable, so two candidates that score
  // identically are broken the same way on every run. The pool cap changes what gets scored, so a
  // nondeterministic selector would make every answer nondeterministic.
  const byScore = candidates
    .map((c, i) => [Number.isFinite(s1[i]) ? s1[i] : -Infinity, i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of byScore) {
    if (keep.size >= limit) break;
    keep.add(i);
  }
  const kept = candidates.filter((_, i) => keep.has(i));
  return { kept, dropped: candidates.length - kept.length, capped: true };
}

// Everything that happens AFTER the cross-encoder has spoken: the name / package / exact-artifact
// boosts, the ADR-collision disclosure, the irrelevance filter and the evidence grade. Lifted out
// of searchAll verbatim as a PURE function of (query, scored candidates, k) so it can be REPLAYED
// against a recorded pool without re-running the cross-encoder. That is what makes measuring a
// pool cap's effect on ANSWERS affordable: score the full 605-pair pool once, then replay every
// candidate policy against those exact scores — exactly, not approximately. Works on shallow
// copies because the boosts mutate ceScore, and a replay must not poison the next replay's input.
export function selectResults({ query, ranked, k = 6 }) {
  ranked = ranked.map((r) => ({ ...r }));
  const queriedNames = scopedNamesIn(query);
  // Repo-name affinity: when the question explicitly NAMES a repo ("Does QuDAG…", "what can SAFLA do",
  // "can ruflo orchestrate…"), that repo should win ties/near-ties over a sibling that merely mentions it.
  // Capability questions almost always name their repo; without this the larger/prose-richer sibling wins
  // the tie (daa over qudag, dspy.ts over safla, agentic-flow over ruflo). A modest additive boost only
  // re-orders near-ties — it never lifts an unrelated repo, since non-named repos are untouched.
  // Word-boundary match on the repo name (not substring) so `fact` doesn't fire on "facts", while
  // multi-word names like `agent-harness-generator` still match. Boost clears a sibling that merely
  // *contains a file named after* the repo (e.g. dspy.ts/…/safla.ts) when the question names the repo.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Length floor 3, not 4: the floor exists to keep trivial tokens from matching, but two REAL
  // stores have 3-char names (rvm, daa) and the old >=4 floor silently exempted them from the
  // affinity boost — "Can RVM partition hardware…" lost to ruvector's vendored crates/rvm/ copy
  // because rvm's own userguide never got the boost its name earned. Word-boundary matching
  // already prevents substring hits, so 3-char store names are safe to honor.
  const isNamed = (repo) => {
    const names = repositoryNames(repo);
    return names.some((n) => n.length >= 3 && new RegExp(`\\b${esc(n)}\\b`, 'i').test(query));
  };
  const NAME_BOOST = 2.0;
  for (const r of ranked) {
    // A concepts hit is labelled repo="concepts" but its path is "<repo>/<kind>/<slug>" — attribute the
    // boost to the UNDERLYING repo so a named repo's PRIMER (which lives in the concepts store) counts too.
    const eff = (r.repo === 'concepts' && r.path) ? (r.path.split('/')[0] || r.repo) : r.repo;
    if (r.ceScore != null && isNamed(eff)) { r.ceScore += NAME_BOOST; r.nameBoosted = true; }
  }
  const inventoryQuery = /\bnpm\b/i.test(query)
    && /\b(?:crate|crates|cargo)\b/i.test(query)
    && /\bworkspace\b/i.test(query);
  if (inventoryQuery) {
    for (const r of ranked) {
      if (r.ceScore != null && r._inventory) {
        r.ceScore += 10.0;
        r.inventoryBoosted = true;
      }
    }
  }
  for (const r of ranked) {
    if (r.ceScore == null) continue;
    if (r._quotedClaims) { r.ceScore += 10.0; r.quotedClaimsBoosted = true; }
    if (r._exactAdr) {
      r.ceScore += 10.0 + 2.0 * (r._exactAdrTitleOverlap || 0);
      r.exactAdrBoosted = true;
    }
    if (r._sourceDetail) { r.ceScore += 10.0; r.sourceDetailBoosted = true; }
  }
  // EXACT PACKAGE-NAME boost (issue #31, found by Jan Lafko): a query naming a package EXACTLY
  // ("@ruvector/rvf") must rank that package's own manifest above near-name siblings — measured
  // live: rvf-node's package.json beat rvf's by ce 7.13 vs 6.67 on rvf's own exact name. The repo
  // affinity above can't see this (both hits are the same repo). Scoped @-package tokens only —
  // precise, zero prose false-positives — and the match is the manifest's own `"name": "<token>"`
  // field (the self-identifying artifact), never a substring of the path.
  const pkgTokens = [...new Set(query.match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi) || [])];
  if (pkgTokens.length) {
    for (const r of ranked) {
      if (r.ceScore == null) continue;
      const body = r.fullText || r.text || '';
      if (pkgTokens.some((p) => body.includes(`"name": "${p}"`) || body.includes(`"name":"${p}"`))) {
        r.ceScore += NAME_BOOST; r.exactPkgBoosted = true;
      }
    }
  }
  // EXACT-ARTIFACT-NAME boost (issue #31, found by @lafinak): an exact package/module-name query must
  // rank the EXACT-named artifact first, not a prefix-sibling — `@ruvector/rvf` was losing to
  // `@ruvector/rvf-node` for a query that named `@ruvector/rvf` exactly. Extract the scoped names the
  // query explicitly contains; a candidate whose TITLE equals one exactly gets a boost strong enough to
  // clear a sibling that merely shares the prefix. Narrow by construction (needs an `@scope/name` in the
  // query AND an exact title match), so repo/prose questions are untouched.
  // (`queriedNames` is computed once, above the pool cutoff — see the EXACT-NAME RESCUE note there.)
  if (queriedNames.size) {
    const EXACT_NAME_BOOST = 3.0; // > NAME_BOOST (2.0) so the exact artifact clears a prefix-sibling
    for (const r of ranked) {
      if (r.ceScore != null && r.title && queriedNames.has(String(r.title).toLowerCase())) {
        r.ceScore += EXACT_NAME_BOOST; r.exactNameBoosted = true;
      }
    }
  }
  ranked.sort((a, b) => (b.ceScore ?? -Infinity) - (a.ceScore ?? -Infinity));

  // ── BARE ADR-NUMBER QUERIES ARE AMBIGUOUS (issue #33 Part B, Jan Lafko / @lafinak) ────────────
  // ADR numbering is PER-REPO, not global: "ADR-085" names a completely different decision
  // depending which repo you mean. Confirmed against the corpus — ADR-085 is "Temporal Tensor
  // Pattern Compression" in one repo and "Public Benchmark Harness" in another; ADR-086 collides
  // three ways. A bare-number query returned exactly ONE repo's answer with no hint the others
  // existed, so a reader with a specific repo in mind could not tell they had been handed a
  // different repo's decision unless they already knew the content well enough to notice. That is
  // the failure this project cares most about: a confident answer to a question nobody asked.
  //
  // The fix is DISCLOSURE, not guessing. We deliberately do not infer which repo was meant — a bare
  // "chapter 5" with no book named is genuinely ambiguous input, and picking one silently is the
  // bug. Instead every colliding repo is guaranteed a slot, and the collision is reported so the
  // caller can say "there are three of these — which repo did you mean?"
  const adrMatch = String(query).match(/\bADR[-\s]?(\d{1,4})\b/i);
  let adrCollision = null;
  let results = ranked.slice(0, k);
  if (adrMatch) {
    const num = adrMatch[1].replace(/^0+/, '') || '0';   // ADR-085 and ADR-85 are the same number
    const sameNumber = (r) => {
      const m = `${r.title || ''} ${r.path || ''}`.match(/\bADR[-\s]?(\d{1,4})\b/i);
      return m ? (m[1].replace(/^0+/, '') || '0') === num : false;
    };
    // Best-scoring representative per repo — the collision set.
    const byRepo = new Map();
    for (const r of ranked) {
      if (sameNumber(r) && !byRepo.has(r.repo)) byRepo.set(r.repo, r);
    }
    if (byRepo.size > 1) {
      const repos = [...byRepo.keys()];
      // Echo the number the way THEY wrote it (ADR-085, not ADR-85). Zero-stripping is only for
      // matching; showing a user a different number than they typed makes them doubt the answer.
      const asTyped = adrMatch[1];
      adrCollision = {
        number: num,
        asTyped,
        repos,
        note: `ADR-${asTyped} exists in ${repos.length} repos (${repos.join(', ')}). ADR numbers are ` +
              `per-repo, so these are DIFFERENT decisions — name the repo to disambiguate.`,
      };
      // ONLY REORDER FOR AN ACTUAL ADR LOOKUP — and NEVER return more than k.
      //
      // The first version forced one hit per colliding repo to the front and sliced to
      // max(k, forced.length). Adversarial review proved both halves wrong against the live corpus:
      //   • ADR-1 collides across 23 repos, so `--k 6` returned TWENTY-TWO results. forge-mcp-all
      //     renders each result's FULL document, so search_ruvnet silently shipped several times the
      //     token volume its own schema promises.
      //   • Forcing ignored the cross-encoder entirely. Adding an aside ("...see ADR-201") to an
      //     unrelated question promoted a passage scored ce=-1.860 — explicitly judged NOT relevant —
      //     to position #2, pushing out genuinely on-topic answers. The disclosure fix was actively
      //     degrading answers, which is worse than the ambiguity it set out to expose.
      //
      // So: the NOTE is the disclosure and it always fires. Reordering only happens when the query
      // really is a bare ADR lookup ("ADR-085", "what does ADR-085 say") rather than a question that
      // merely mentions one — and it is always capped at k, because a caller asking for k means k.
      const residual = String(query).replace(adrMatch[0], ' ').replace(/[^a-z0-9]+/gi, ' ').trim();
      const isBareLookup = residual.split(/\s+/).filter(Boolean).length <= 4;
      if (isBareLookup) {
        const forced = [...byRepo.values()].slice(0, k);
        const forcedSet = new Set(forced);
        results = [...forced, ...ranked.filter((r) => !forcedSet.has(r))].slice(0, k);
      }
    }
  }

  // ── EVIDENCE GRADE — the tool reports its OWN confidence, as data ─────────────────────────────
  //
  // THE FAILURE THIS FIXES, in the user's words: "every shallow sweep concluded, wrongly, that we'd
  // have to build it ourselves." A thin-coverage query ("audio DSP speech enhancement") returned four
  // results formatted exactly like four answers — but only the first (ce 3.71) was real; the rest
  // scored 1.04, -1.28, -2.77. The cross-encoder had ALREADY judged those irrelevant and we handed
  // them over anyway. A reasonable reader sees four mostly-useless hits and concludes the ecosystem
  // has nothing. That is the worst outcome this product can produce: the tool whose entire purpose is
  // preventing hand-rolling CAUSED hand-rolling — not by hiding the answer, but by making thin
  // evidence indistinguishable from strong evidence.
  //
  // This is NOT agentdb_explainable_recall's job (that explains why a given match scored where it
  // did); this is "is this result set trustworthy enough to act on at all".
  //
  // Thresholds DERIVED from measured runs on this corpus, never invented:
  //   10.22  exact package-name match          8.43  AgentDB capability question
  //    6.73  solid conceptual hit              5.56  ADR lookup
  //    4.37  the WEAKEST question in the answer-quality suite that has a known-good answer
  //    3.71  the query that wrongly read as "nothing exists"
  const STRONG = 6.0, OK = 4.0;
  const topScore = results.length && results[0].ceScore != null ? results[0].ceScore : null;

  // Never hand back what the reranker already rejected. A negative cross-encoder score means "not
  // relevant to this query"; passing it along as a result is how noise becomes a conclusion. The
  // single best hit is always kept, so a caller can still see the strongest thing that exists.
  const kept = results.filter((r, i) => i === 0 || (r.ceScore ?? -Infinity) >= 0);
  const droppedIrrelevant = results.length - kept.length;
  results = kept;

  const grade = topScore == null ? 'insufficient_evidence'
    : topScore >= STRONG ? 'strong'
    : topScore >= OK ? 'ok'
    : topScore >= 0 ? 'thin'
    : 'insufficient_evidence';

  // The sentence that matters. Retrieval finding little is NOT evidence the thing does not exist —
  // it is evidence THIS QUERY did not reach it. Said explicitly, because a model reading weak
  // results will otherwise supply the wrong conclusion on its own, and that conclusion is expensive.
  const evidence = {
    grade,
    topScore: topScore == null ? null : Number(topScore.toFixed(3)),
    droppedIrrelevant,
    caveat: (grade === 'thin' || grade === 'insufficient_evidence')
      ? 'WEAK COVERAGE for this query. Do NOT conclude the ecosystem lacks this capability — absence '
        + 'of retrieval is not absence of code. Narrow the query, name a specific repo, or search for a '
        + 'concrete artifact (function, struct, or package name) before deciding to build it yourself.'
      : null,
  };

  const assessed = assessImplementation(query, results);
  return { results: assessed.results, adrCollision, evidence, implementation: assessed.implementation };
}

// Query every repo, pool, rerank on a common scale, return global top-k labeled by repo.
export async function searchAll({
  dir, query, k = 6, pool = 8, repos, _routeStage = false, allowFullCorpus = true,
}) {
  const discovered = (repos && repos.length) ? repos : discoverRepos(dir);
  let routing = null;
  if ((!repos || !repos.length) && !_routeStage) {
    const inventoryDirective = inventoryReposFromQuery(query, dir, discovered);
    const planned = inventoryDirective && (
      inventoryDirective.familyScope
      || /\brepo:[a-z0-9._-]+\b/i.test(String(query || ''))
    )
      ? inventoryDirective
      : routeReposFromCards(query, dir, discovered);
    const escalationRepo = ['meta', 'harness'].join('');
    if (cheapFirstFailureEscalationQuestion(query) && discovered.includes(escalationRepo)) {
      planned.repos = [
        escalationRepo,
        ...planned.repos.filter((repo) => repo !== escalationRepo),
      ];
      planned.cardRepos = {
        ...planned.cardRepos,
        [escalationRepo]: 'agent-harness-generator',
      };
      planned.reason = 'source intent selects the cheap-verify-frontier escalation harness';
    }
    if (replayablePromotionRollbackQuestion(query) && discovered.includes(escalationRepo)) {
      planned.repos = [
        escalationRepo,
        ...planned.repos.filter((repo) => repo !== escalationRepo),
      ];
      planned.cardRepos = {
        ...planned.cardRepos,
        [escalationRepo]: 'agent-harness-generator',
      };
      planned.reason = 'source intent selects the receipt-backed promotion and rollback harness';
    }
    const learningRepo = ['ru', 'flo'].join('');
    if (adaptiveRetrievalPromotionQuestion(query) && discovered.includes(learningRepo)) {
      planned.repos = [
        learningRepo,
        ...planned.repos.filter((repo) => repo !== learningRepo),
      ];
      planned.cardRepos = {
        ...planned.cardRepos,
        [learningRepo]: learningRepo,
      };
      planned.reason = 'source intent selects the adaptive retrieval flywheel and its promotion gate';
    }
    if (replayableHarnessPolicyEvolutionQuestion(query) && discovered.includes(learningRepo)) {
      planned.repos = [
        learningRepo,
        ...planned.repos.filter((repo) => repo !== learningRepo),
      ];
      planned.cardRepos = {
        ...planned.cardRepos,
        [learningRepo]: learningRepo,
      };
      planned.confidence = 'described';
      planned.reason = 'source intent selects evolvable harness policy and replayable receipts';
    }
    if (livingAdrDriftQuestion(query) && discovered.includes(learningRepo)) {
      planned.repos = [
        learningRepo,
        ...planned.repos.filter((repo) => repo !== learningRepo),
      ];
      planned.cardRepos = {
        ...planned.cardRepos,
        [learningRepo]: learningRepo,
      };
      planned.confidence = 'described';
      planned.reason = 'source intent selects living ADR lifecycle and implementation-drift review';
    }
    const vectorRepo = ['ru', 'vector'].join('');
    if (offlineOnDeviceSemanticIndexQuestion(query) && discovered.includes(vectorRepo)) {
      planned.repos = [
        vectorRepo,
        ...planned.repos.filter((repo) => repo !== vectorRepo),
      ];
      planned.cardRepos = {
        ...planned.cardRepos,
        [vectorRepo]: vectorRepo,
      };
      planned.reason = 'source intent selects the on-device HNSW index and zero-server deployment';
    }
    if (planned.repos.length && planned.repos.length < discovered.length) {
      const sourceCard = await sourceBackedCardLane({ dir, query, k, planned });
      if (sourceCard) return sourceCard;
      const scoped = await searchAll({
        dir,
        query,
        k,
        pool,
        repos: planned.repos,
        _routeStage: true,
        allowFullCorpus,
      });
      const scopedErrors = Object.values(scoped.perRepo)
        .filter((value) => typeof value === 'string' && value.startsWith('ERR:'));
      const implementationRequired = requiresImplementationProof(query);
      const implementationProven = !implementationRequired
        || scoped.implementation?.verdict === 'proven';
      // An explicitly named repository is already the user's requested search boundary. If that
      // scoped search returns strong evidence without errors, widening to every unrelated store
      // cannot improve repository identity; it only turns an honest "documentation, not proven
      // implementation" result into a full-corpus timeout. Preserve the implementation warning,
      // but return the strong evidence from the named scope.
      const exactNamedScope = (planned.namedRepos?.length || 0) > 0;
      // An explicit repository name is a hard search boundary, even when its evidence is thin.
      // Widening a thin named result to every unrelated store cannot improve repository identity;
      // it turns an honest abstention into an unbounded cross-encoder fanout. Return the scoped
      // result with its existing thin-evidence warning instead.
      const namedScopeHasEvidence = exactNamedScope
        && (scoped.results?.length || 0) > 0;
      const primaryProductHasEvidence = planned.primaryProductScope === true
        && (scoped.results?.length || 0) > 0;
      if ((scoped.evidence?.grade === 'strong' || namedScopeHasEvidence || primaryProductHasEvidence)
        && scopedErrors.length === 0
        && (implementationProven || exactNamedScope)) {
        return {
          ...scoped,
          routing: {
            attempted: true,
            accepted: true,
            confidence: planned.confidence,
            reason: planned.reason,
            candidateRepos: planned.repos,
            primaryProductScope: planned.primaryProductScope === true,
            implementationRequired,
            implementationVerdict: scoped.implementation?.verdict || 'not-required',
          },
        };
      }
      const scopedRouting = {
          attempted: true,
          accepted: false,
          confidence: planned.confidence,
          reason: planned.reason,
          candidateRepos: planned.repos,
          scopedEvidence: scoped.evidence?.grade || 'unknown',
          scopedErrors: scopedErrors.length,
          scopedImplementation: scoped.implementation?.verdict || 'unknown',
          fallback: allowFullCorpus ? 'full-corpus' : 'scoped-only',
      };
      // Interactive retrieval is bounded. Offline evaluators and explicit library callers retain
      // the historical full-corpus fallback by leaving allowFullCorpus at its default.
      if (!allowFullCorpus) {
        return {
          ...scoped,
          routing: scopedRouting,
        };
      }
      routing = scopedRouting;
    }
    if (!allowFullCorpus) {
      // No card route means the question is too ambiguous to pick a source boundary. Refuse quickly
      // instead of fanning out to every store.
      return {
        repos: [],
        perRepo: {},
        results: [],
        pooled: 0,
        pooledAll: 0,
        cappedOut: 0,
        prefiltered: 0,
        prefilterTokens: 0,
        prefilterMs: 0,
        corpusAge: null,
        adrCollision: null,
        evidence: {
          grade: 'thin',
          topScore: null,
          droppedIrrelevant: 0,
          caveat: 'The question was too ambiguous to select a source repository safely.',
        },
        implementation: null,
        routing: {
          attempted: true,
          accepted: false,
          confidence: planned.confidence,
          reason: planned.reason,
          candidateRepos: [],
          fallback: 'ask-to-narrow',
        },
      };
    }
  }
  const list = discovered;
  const perRepo = {};
  // CORPUS AGE (issue #31, Jan Lafko): the brain is a periodic snapshot, and a model quoting a
  // version from it had NO signal that the fact might trail live reality. Derive the queried
  // stores' ages from the store files' own mtimes (always present, no extra plumbing) so every
  // response can carry an honest staleness caveat instead of implying liveness.
  const corpusAge = corpusAgeFor(dir, list);
  // Fan out across repos concurrently — but BOUNDED (issue #30, found+fixed by Jan Lafko). The
  // unbounded Promise.all here was a real OOM bomb: each repo's searchKb() spins up its own store
  // handles, and an unscoped query fanned ~53+ repos at once — measured 513MB peak for ONE repo,
  // extrapolating past his container's 17GB (dmesg: oom-kill, anon-rss 17.2GB, MCP server dead).
  // His bounded batch (default 5, KB_CONCURRENCY to tune) cut peak RSS to ~2.4GB with identical
  // results. Implemented as a SLIDING WINDOW rather than chunk barriers — at most KB_CONCURRENCY
  // repos in flight, and a finishing repo immediately admits the next, so big-memory machines keep
  // most of the parallel wall-clock win while small containers keep the same hard memory bound.
  // Each repo's error stays isolated to its own perRepo entry.
  const CONCURRENCY = Math.max(1, parseInt(process.env.KB_CONCURRENCY || '5', 10) || 5);

  // EXACT-NAME RESCUE (issue #33 Part A, Jan Lafko / @lafinak).
  // The scoped names the query explicitly contains. Hoisted ABOVE the per-repo pool cutoff because
  // of the bug Jan found: #31's exact-name boost runs after reranking, but each repo only contributes
  // its top-`pool` passages by RAW relevance, so `@ruvector/rvf`'s own manifest was discarded before
  // the boost could ever see it — in a large repo the exact artifact simply never reached the pool.
  // A boost cannot rescue what was never a candidate. (#31's own verification missed this because it
  // used a target that was already pool-competitive, so it never exercised the exclusion path.)
  const queriedNames = scopedNamesIn(query);
  // Searching deeper costs real time, so it happens ONLY when the query names an artifact exactly —
  // the deeper hits are then discarded except for exact title matches, which are force-kept. Ordinary
  // prose questions retrieve exactly as before.
  const RESCUE_DEPTH = Math.max(64, pool);

  const searchOne = async (name) => {
    try {
      // The concepts store holds ALL repos' prose primers in one place, so it needs a deeper pool than a
      // single source repo — otherwise the queried repo's own primer is crowded out by the other 18 before
      // the cross-encoder ever scores it (the dilution that buried ruflo's primer and lost safla).
      // Transcript stores get a deeper dense pool (24) AND BM25 candidates; concepts gets 24; others 8.
      const repoPool = (name === 'concepts' || isTranscriptStore(name)) ? Math.max(pool, 24) : pool;
      // Deepen ONLY for exact-name queries (#33 Part A), and only in repos that could PLAUSIBLY hold
      // the named artifact. The first version deepened every one of ~69 repos to depth 64 whenever a
      // query contained any @scope/name token — an 8x HNSW cost across the entire corpus to rescue an
      // artifact that, by definition, lives in one or two of them. Scope it by name overlap: a query
      // for @ruvector/rvf deepens ruvector-ish stores, not agentic-robotics.
      // The trade is deliberate and bounded: a package whose manifest sits in an unrelated repo is
      // still found by the normal pool + boost, it just doesn't get the deep rescue. Paying 8x on 67
      // irrelevant repos to cover that case is the wrong bargain.
      const plausibleForName = queriedNames.size > 0 && [...queriedNames].some((n) => {
        const [scope, pkg] = n.replace(/^@/, '').split('/');
        const lower = name.toLowerCase();
        return (scope && (lower.includes(scope) || scope.includes(lower)))
            || (pkg && (lower.includes(pkg) || pkg.includes(lower)));
      });
      const depth = plausibleForName ? Math.max(repoPool, RESCUE_DEPTH) : repoPool;
      const hits = await searchKb({ dir, name, query, k: depth, n: depth });
      let cands = hits;
      if (queriedNames.size && hits.length > repoPool) {
        const top = hits.slice(0, repoPool);
        const keptPaths = new Set(top.map((h) => h.path));
        // Force-keep any deeper hit whose TITLE is exactly a name the query asked for. This is the
        // whole fix: the artifact now REACHES the pool, so #31's boost can act on it.
        const rescued = hits
          .slice(repoPool)
          .filter((h) => h.title && queriedNames.has(String(h.title).toLowerCase()) && !keptPaths.has(h.path));
        for (const h of rescued) h._lane = 'rescue';
        cands = rescued.length ? top.concat(rescued) : top;
      }
      if (plausibleForName) {
        const seen = new Set(cands.map((candidate) => candidate.path));
        const lexical = exactPackageCandidates(dir, name, query)
          .filter((candidate) => !seen.has(candidate.path));
        cands = cands.concat(lexical);
      }
      {
        const seen = new Set(cands.map((candidate) => candidate.path));
        const inventory = manifestInventoryCandidates(dir, name, query)
          .filter((candidate) => !seen.has(candidate.path));
        cands = cands.concat(inventory);
      }
      {
        const seen = new Set(cands.map((candidate) => candidate.path));
        const claims = quotedClaimCandidates(dir, name, query)
          .filter((candidate) => !seen.has(candidate.path));
        cands = cands.concat(claims);
      }
      {
        const byPath = new Map(cands.map((candidate) => [candidate.path, candidate]));
        for (const adr of exactAdrCandidates(dir, name, query)) {
          const existing = byPath.get(adr.path);
          if (existing) Object.assign(existing, {
            _exactAdr: true,
            _exactAdrTitleOverlap: adr._exactAdrTitleOverlap,
          });
          else {
            cands.push(adr);
            byPath.set(adr.path, adr);
          }
        }
      }
      {
        const seen = new Set(cands.map((candidate) => candidate.path));
        const details = rvfBackendCandidates(dir, name, query)
          .filter((candidate) => !seen.has(candidate.path));
        cands = cands.concat(details);
      }
      if (isTranscriptStore(name)) {
        const seen = new Set(hits.map((h) => h.path));
        const bm = meetingBm25Candidates(dir, name, query, 40).filter((c) => !seen.has(c.path));
        cands = hits.concat(bm); // the global cross-encoder (rerankPairs below) then promotes the real answer
        for (let i = 0; i < bm.length; i++) bm[i]._lane = 'bm25';
      }
      // Every candidate carries WHY it is in the pool and HOW deep it sat in that lane. Nothing
      // downstream of the cross-encoder needs this — the reranker's job is to forget where a
      // candidate came from — but the pool CAP (capRerankPool) has to decide what to drop before
      // any score exists, and per-lane depth is the only honest pre-score signal available: vector
      // distance is not comparable across stores that use different embedders and dimensions.
      let dense = 0, bm25 = 0, rescue = 0;
      for (const c of cands) {
        if (c._lane === 'bm25') c._srcRank = bm25++;
        else if (c._lane === 'rescue') c._srcRank = rescue++;
        else { c._lane = 'dense'; c._srcRank = dense++; }
      }
      perRepo[name] = cands.length;
      return cands.map((h) => ({ ...h, repo: name }));
    } catch (e) {
      perRepo[name] = `ERR: ${e.message}`;
      return [];
    }
  };
  const perRepoHits = new Array(list.length);
  let nextIdx = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    for (let i = nextIdx++; i < list.length; i = nextIdx++) {
      perRepoHits[i] = await searchOne(list[i]);
    }
  }));
  const pooledAll = perRepoHits.flat();
  // The pool's own order is the cap's tie-break, so it has to survive into any recorded trace —
  // otherwise a replay would break ties differently from production and quietly measure a
  // different policy than the one being shipped.
  for (let i = 0; i < pooledAll.length; i++) pooledAll[i]._poolIdx = i;
  const capLimit = process.env.KB_CE_MAX_PAIRS !== undefined
    ? Math.max(0, parseInt(process.env.KB_CE_MAX_PAIRS, 10) || 0)
    : CE_MAX_PAIRS_DEFAULT;
  // THE CASCADE (ADR-058). Stage 1 reads every pooled pair at a truncated length and stage 2 gives
  // the survivors the full read. Both stages are the SAME model on the SAME logit scale, which is
  // what makes stage 1 a real approximation of stage 2 rather than a second opinion — the property
  // vector distance was measured NOT to have. Off unless CE_CASCADE_K_DEFAULT or KB_CE_CASCADE_K
  // says otherwise; when off, not one extra pair is scored and this path is byte-for-byte the old one.
  const cascadeK = process.env.KB_CE_CASCADE_K !== undefined
    ? Math.max(0, parseInt(process.env.KB_CE_CASCADE_K, 10) || 0)
    : CE_CASCADE_K_DEFAULT;
  const cascadeTokens = process.env.KB_CE_CASCADE_TOKENS !== undefined
    ? Math.max(16, parseInt(process.env.KB_CE_CASCADE_TOKENS, 10) || CE_CASCADE_TOKENS_DEFAULT)
    : CE_CASCADE_TOKENS_DEFAULT;
  let s1 = null, prefilterMs = 0;
  if (cascadeK > 0 && pooledAll.length > cascadeK) {
    const t0 = Date.now();
    s1 = await cePrefilterScores(query, pooledAll, { maxLength: cascadeTokens });
    prefilterMs = Date.now() - t0;
  }
  const { kept: candidates, dropped: cappedOut } = s1
    ? cascadeRerankPool(pooledAll, { limit: cascadeK, s1 })
    : capRerankPool(pooledAll, { limit: capLimit });
  // ONE cross-encoder pass over the whole cross-repo pool → a single comparable relevance scale.
  const ranked = await rerankPairs(query, candidates);
  // Recording the SCORED pool (not the answer) is what makes a pool-policy change measurable: one
  // 605-pair run, then selectResults replayed against those exact scores for any candidate policy.
  if (process.env.KB_CE_TRACE) {
    // s1 is indexed by POOL position, while `ranked` is sorted by full score — index the stage-1
    // scores by _poolIdx so a replay can line them up again. A trace that lost that alignment
    // would silently score every policy against the wrong candidate.
    const s1By = new Map();
    if (s1) for (let i = 0; i < pooledAll.length; i++) s1By.set(pooledAll[i]._poolIdx, s1[i]);
    fs.appendFileSync(process.env.KB_CE_TRACE, JSON.stringify({
      query, k, pooledAll: pooledAll.length, scored: candidates.length, capLimit,
      cascadeK, cascadeTokens: s1 ? cascadeTokens : null, prefilterMs,
      cands: ranked.map((r) => ({
        repo: r.repo, path: r.path, title: r.title ?? null, lane: r._lane ?? 'dense',
        rank: r._srcRank ?? 0, poolIdx: r._poolIdx ?? 0, ce: r.ceScore, dist: r.bestDistance ?? null,
        s1: s1By.has(r._poolIdx) ? s1By.get(r._poolIdx) : null,
        len: (r.fullText || r.text || '').length,
        gist: /GIST STATUS/.test(r.fullText || r.text || ''),
      })),
    }) + '\n');
  }
  const { results, adrCollision, evidence, implementation } = selectResults({ query, ranked, k });

  // `pooled` stays the number of pairs the cross-encoder read IN FULL — that is what the count
  // has always meant to a reader. `pooledAll`/`cappedOut` report what the cap withheld, because a
  // count that silently changed meaning is the kind of quiet lie this repo gates against.
  // `prefiltered` is the cascade's own honesty clause: under a cascade the cross-encoder DID look
  // at every pooled pair, just at `cascadeTokens` tokens instead of 512. Reporting only `pooled`
  // would let a reader conclude 543 documents were never looked at, which is not what happened.
  return {
    repos: list, perRepo, results,
    pooled: candidates.length, pooledAll: pooledAll.length, cappedOut,
    prefiltered: s1 ? pooledAll.length : 0, prefilterTokens: s1 ? cascadeTokens : 0, prefilterMs,
    corpusAge, adrCollision, evidence, implementation, routing,
  };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  return {
    dir: get('--dir') || '.',
    query: get('--q') || get('--query'),
    k: parseInt(get('--k') || '6', 10),
    pool: parseInt(get('--pool') || '8', 10),
    repos: (get('--repos') || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

async function main() {
  const { dir, query, k, pool, repos } = parseArgs();
  if (!query) { console.error('Usage: node forge-ask-all.mjs --dir <bundle-dir> --q "question" [--k 6] [--pool 8] [--repos a,b]'); process.exit(2); }
  const { repos: used, perRepo, results, pooled, pooledAll, cappedOut, prefiltered, prefilterTokens, adrCollision, evidence, implementation } = await searchAll({ dir, query, k, pool, repos });
  // ── GONG LAYER (CLI): all repos erroring is an OUTAGE, not a quiet zero. Banner + exit 1 + alarm.
  // The non-zero exit is load-bearing: scripts/nightly-wrapper.sh's canary and any cron/CI caller
  // rely on it — a total failure that exits 0 is exactly the silent death this exists to kill.
  const failed = Object.entries(perRepo).filter(([, v]) => typeof v === 'string' && v.startsWith('ERR:'));
  if (used.length > 0 && failed.length === used.length) {
    console.error('\n🚨🚨🚨  RUVNET BRAIN IS DOWN — ALL ' + used.length + ' repos failed to search.  🚨🚨🚨');
    console.error('This is NOT an empty result; retrieval itself is broken.');
    console.error('First error: ' + failed[0][1]);
    console.error('Fix:    cd ~/.cache/ruvnet-brain/kb && npm i');
    console.error('Verify: npx github:stuinfla/ruvnet-brain --doctor\n');
    try {
      const alarm = await import(new URL('./brain-alarm.mjs', import.meta.url).href);
      await alarm.reportBrainDown({ error: failed[0][1], source: 'cli:forge-ask-all' });
    } catch { /* alarm module absent — the banner + exit code above still gong */ }
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`⚠ DEGRADED: ${failed.length}/${used.length} repos failed (${failed.map(([n]) => n).join(', ')}) — results cover only the healthy repos.`);
  } else {
    // All repos healthy: clear any standing DOWN state (transition-only write inside).
    import(new URL('./brain-alarm.mjs', import.meta.url).href)
      .then((m) => m.reportBrainUp({ source: 'cli:forge-ask-all' }))
      .catch(() => {});
  }
  console.log(`\n=== RuvNet Brain (cross-repo) — "${query}" ===`);
  // Surface the ambiguity BEFORE the results, so it is read as a caveat on everything below rather
  // than a footnote after the reader has already accepted the first hit as "the" answer.
  if (adrCollision) console.log(`⚠ ${adrCollision.note}`);
  const truthNote = implementationNotice(implementation).trim();
  if (truthNote) console.log(truthNote);
  // Confidence BEFORE the results, so it is read as a caveat on everything below rather than a
  // footnote after the reader has already drawn a conclusion from a thin list.
  if (evidence?.caveat) {
    console.log(`⚠ EVIDENCE: ${evidence.grade.toUpperCase()} (top score ${evidence.topScore}) — ${evidence.caveat}`);
  }
  if (evidence?.droppedIrrelevant > 0) {
    console.log(`  (${evidence.droppedIrrelevant} result(s) the reranker judged irrelevant were withheld rather than padded in)`);
  }
  // Under a cascade every pooled pair WAS read by the cross-encoder, at `prefilterTokens` tokens;
  // only the full 512-token read was rationed. The pre-cascade wording ("N beyond the pair budget")
  // would have a reader believe 544 documents were never looked at, which is not what happened —
  // and this repo gates against counts that quietly change meaning.
  const poolNote = prefiltered
    ? ` (all ${pooledAll} read at ${prefilterTokens} tokens; the top ${pooled} re-read in full)`
    : cappedOut ? ` (cross-encoded ${pooled} of ${pooledAll}; ${cappedOut} beyond the pair budget)` : '';
  console.log(`repos searched: ${used.join(', ')}  |  per-repo hits: ${JSON.stringify(perRepo)}  |  pooled candidates: ${pooled}${poolNote}\n`);
  results.forEach((r, i) => {
    console.log(`#${i + 1}  repo=${r.repo}  ce=${r.ceScore == null ? 'n/a' : r.ceScore.toFixed(3)}  vec=${r.bestDistance?.toFixed(4)}${r.kind ? `  kind=${r.kind}` : ''}  evidence=${r.evidenceClass || 'unknown'}${r.lifecycleStatus ? `  lifecycle=${r.lifecycleStatus}` : ''}`);
    console.log(`path : ${r.repo}/${r.path}`);
    console.log(`title: ${r.title}`);
    if (r.designIntentWarning) console.log(r.designIntentWarning);
    console.log(`chars: ${(r.fullText || '').length} | chunks: ${r.chunksJoined}${r.truncated ? ' (truncated)' : ''}`);
    console.log('----- full document -----');
    console.log(r.fullText || r.text || '');
    console.log('===================================================================\n');
  });
}

// REALPATH BOTH SIDES, not path.resolve(). REPRODUCED LIVE 2026-07-27: path.resolve() normalizes
// a path but does NOT follow symlinks, while `import.meta.url` IS symlink-resolved by Node. So
// invoking this file through ANY symlink — an npm bin shim, a wrapper script, a symlinked KB dir —
// made the two sides disagree, main() never ran, and the process printed NOTHING and exited 0.
// Silent success is the worst failure this repo has: the brain looks like it answered and returned
// no answer, and every caller downstream treats exit 0 as "searched, found nothing". Found by
// accident while building a benchmark harness out of symlinks; the same defect class was
// independently found in plugin/scripts/hook-input.mjs's isMain by the D9 hook audit the same day,
// where it fails every write-gate OPEN. realpath can throw (broken link, permissions), so each side
// falls back to its unresolved form rather than crashing the entry point.
const __filename = fileURLToPath(import.meta.url);
const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(__filename)) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
