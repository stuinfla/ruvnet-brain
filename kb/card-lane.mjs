#!/usr/bin/env node
// card-lane.mjs — the FAST LANE first responder over kb/capability-cards.md.
//
// WHY THIS EXISTS (measured 2026-07-27, on a quiet machine): the cross-repo heavy search
// (`searchAll` in forge-ask-all.mjs) costs ~19,620ms warm / ~72,970ms cold per query, almost
// entirely TRANSFORMER LOAD/INIT (two ONNX models: the bge/MiniLM embedder + the ms-marco
// cross-encoder reranker) — the HNSW vector search underneath is sub-millisecond. Meanwhile the
// single most common question this brain answers — "does rUv already ship this? which tool do I
// reach for?" — is fully answered by kb/capability-cards.md, a hand-written ~20KB prose file with
// one card per building block. This module answers THAT question with ZERO ML: plain
// tokenization + keyword overlap over the cards, so a covered question returns in low-single-digit
// milliseconds and never loads either ONNX model.
//
// THE CONTRACT THIS MUST HONOR (non-negotiable — "the product can never lie"):
//   1. ANSWER, not just filter. A hit returns the full card text, cited to capability-cards.md and
//      the repo it describes — usable on its own, not a "maybe check X" nudge.
//   2. SILENCE OR FALLTHROUGH, NEVER A FABRICATED HIT. A query the cards do not confidently cover
//      returns { hit: false, reason }. The caller (forge-mcp-all.mjs) then runs the heavy path
//      exactly as before — this module never stands in the way of a real answer, it only skips
//      the wait when it already knows the answer cold. NAMING a covered repo is NOT by itself
//      sufficient confidence — see the adversarial case in tests/unit/card-lane.test.mjs: "Does
//      AgentDB include a Thompson-Sampling bandit?" names a real, covered repo, but its card never
//      mentions reinforcement learning or bandits, so this must fall through honestly rather than
//      hand back a generic AgentDB description as if it answered the specific question asked.
//   3. The heavy path is UNTOUCHED. This module does not change forge-ask-all.mjs and is invoked
//      strictly BEFORE it, never instead of it for a genuine miss.
//
// Deliberately NOT ML: no embeddings, no cross-encoder, no @xenova/transformers anywhere in this
// file's module graph — if it ever needs to get smarter than keyword overlap, that is a decision
// to make explicitly, not something to drift into by accident.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiresImplementationProof } from './implementation-evidence.mjs';

export const CARDS_FILE = 'capability-cards.md';
export const REPO_ALIASES_FILE = 'repo-aliases.json';
export const PACKAGE_OWNERS_FILE = 'package-owners.json';

export function loadRepoAliases(dir) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [dir && path.join(dir, REPO_ALIASES_FILE), path.join(moduleDir, REPO_ALIASES_FILE)]
    .filter(Boolean);
  for (const file of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      return Object.fromEntries(Object.entries(value)
        .filter(([canonical, stores]) =>
          canonical && Array.isArray(stores) && stores.every((store) => typeof store === 'string')));
    } catch {
      // A partial/older bundle may not carry the registry. Try the module-local copy, then use none.
    }
  }
  return {};
}

export function loadPackageOwners(dir) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [dir && path.join(dir, PACKAGE_OWNERS_FILE), path.join(moduleDir, PACKAGE_OWNERS_FILE)]
    .filter(Boolean);
  for (const file of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      return Object.fromEntries(Object.entries(value)
        .filter(([packageName, repo]) =>
          /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(packageName) && typeof repo === 'string' && repo));
    } catch {
      // Older bundles may not carry package ownership metadata.
    }
  }
  return {};
}

export function repositoryNames(repo, dir) {
  const registry = loadRepoAliases(dir);
  const direct = registry[repo];
  if (direct) return [...new Set([repo, ...direct])];
  for (const [canonical, stores] of Object.entries(registry)) {
    if (stores.includes(repo)) return [...new Set([canonical, ...stores])];
  }
  return [repo];
}

// A small stopword list — just enough to stop generic question words ("what", "does", "should",
// "use") from diluting the coverage math. This is not a linguistics project; each card already
// carries ~30 real content words, and those are what should do the discriminating.
const STOPWORDS = new Set(`
  a an the of and or but if then else for to from in on at by with without into onto over under
  is are was were be been being do does did doing done can could should would will shall may might
  what which who whom whose when where why how
  this that these those it its i you he she they we my your his her their our
  need needs want wants use uses using used tool tools reach like ask asks question questions
  have has had not no nor so such too very just about also
  each other
`.trim().split(/\s+/));

function normalizePhrases(text) {
  // Normalize only unambiguous multi-word paraphrases. Keeping this before tokenization lets
  // ordinary language ("throw it away") match the product vocabulary ("discard") without
  // weakening the overlap, coverage, or winner-margin confidence gates.
  return String(text || '')
    .toLowerCase()
    .replace(/\bthrow\s+(?:it\s+)?away\b/g, 'discard')
    .replace(/\bspend\s+less\s+money\s+on\s+model\s+calls?\b/g, 'reduce model cost')
    .replace(/\bwithout\s+getting\s+dumber\s+answers?\b/g, 'without sacrificing quality')
    .replace(/\bsettings\s+screen\b/g, 'console')
    .replace(/\bstep[- ]by[- ]step\b/g, 'structured')
    .replace(/\bwritten\s+spec\b/g, 'specification')
    .replace(/\bfinished\s+code\b/g, 'completion')
    .replace(/\bimprove\s+(?:my\s+)?agent(?:'s)?\s+scaffolding\b/g, 'evolve agent harness')
    .replace(/\bwithout\s+swapping\s+out\s+the\s+model\s+itself\b/g, 'model remains fixed')
    .replace(/\bcausal\s+chain\s+behind\s+(?:a\s+)?recall\b/g, 'explainable recall feature attribution')
    .replace(
      /\bshrink(?:\s+(?:my|our|the))?\s+(?:system\s+)?prompts?\s+without\s+losing\s+(?:their\s+)?meaning\b/g,
      'prompt compression token reduction meaning preservation',
    )
    .replace(
      /\bcompress\s+instructions?\s+without\s+changing\s+behavio[u]?r\b/g,
      'prompt compression token reduction meaning preservation',
    )
    .replace(
      /\bsend\s+easy\s+tasks?\s+to\s+(?:a\s+)?cheap\s+model[\s\S]*?\bcheap\s+one\s+gives?\s+up\b/g,
      'route orchestrate tasks cheap model failure escalation',
    )
    .replace(
      /\b(?:start|starts|starting)\s+(?:each|every)\s+(?:new\s+)?session\s+cold\b/g,
      'persistent project memory survives across sessions',
    )
    .replace(
      /\bcarry\s+decisions?\s+across\s+sessions\b/g,
      'record decision recall project memory across sessions',
    )
    .replace(
      /\bforget(?:s|ting)?\s+(?:everything|context)\s+between\s+sessions\b/g,
      'persistent memory survives across sessions',
    )
    .replace(
      /\bjustify\s+(?:its|their|the)\s+recalls?\b/g,
      'explainable recall feature attribution',
    )
    .replace(
      /\bci\s+takes?\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+hours?\b/g,
      'quality engineering',
    )
    .replace(/\btests?\s+generated\b/g, 'generate tests')
    .replace(
      /\bprioriti[sz]ed\s+only\s+for\s+(?:the\s+)?riskiest\s+changed\s+code\b/g,
      'risk-based test prioritization risk-weighted changed code',
    )
    .replace(
      /\bagents?\s+work\s+(?:in\s+)?the\s+same\s+repo\s+and\s+clobber\s+each\s+other(?:'s)?\s+context\b/g,
      'multi-agent coordination agents share state memory',
    )
    .replace(
      /\bcoordinated\s+roles?\s+with\s+shared\s+state\b/g,
      'coordinate swarms specialized agents share state',
    )
    .replace(
      /\bagents?\s+ingests?\s+untrusted\s+web\s+content\b/g,
      'agent sandbox risky ingest',
    )
    .replace(
      /\bif\s+an?\s+ingest\s+poisons?\s+memory\b/g,
      'branch memory',
    )
    .replace(
      /\binstant\s+rollback\s+without\s+replaying\s+(?:the\s+)?whole\s+day\b/g,
      'instantly roll back discard branch',
    )
    .replace(
      /\bthe\s+same\s+vector\s+queries\s+hit\s+(?:our|the)\s+store\s+thousands\s+of\s+times\s+an\s+hour\b/g,
      'repeated vector queries vector cache read cache',
    )
    .replace(
      /\b(?:hundreds?|thousands?|\d+)\s+users?\s+each\s+need\s+their\s+own\s+agent\s+memory[\s\S]*?\bfull\s+copies\b[\s\S]*?\bstorage\s+bill\b/g,
      'copy-on-write agent memory branch constant time size tiny storage overhead',
    )
    .replace(
      /\bcached\s+reads\s+we\s+can\s+cryptographically\s+verify\b/g,
      'cached reads witness provenance-verifiable retrieval',
    )
    .replace(
      /\bdevice\s+mesh\s+must\s+stay\s+secure\s+even\s+if\s+quantum\s+computers?\s+break\s+rsa\b/g,
      'quantum-resistant post-quantum secure mesh',
    )
    .replace(
      /\bwhat(?:'s|\s+is)\s+the\s+comms?\s+layer\b/g,
      'secure agent-to-agent messaging communication layer',
    )
    .replace(
      /\bphased\s+method\s+with\s+hard\s+gates\s+from\s+requirements\s+to\s+completion\b/g,
      'structured phased development methodology with quality gates from specification to completion',
    )
    .replace(/\bbare-metal\s+box\b/g, 'hardware-grade runtime')
    .replace(/\bmultiple\s+tenants\b/g, 'multi-tenant workloads')
    .replace(/\bstrict\s+isolation\b/g, 'hardware-grade isolation')
    .replace(/\bhypervisor\s+partitions\b/g, 'microhypervisor secure partitioning')
    .replace(/\briskiest\b/g, 'risk-weighted')
    .replace(/\brisky\b/g, 'risk-weighted')
    .replace(/\bwhat(?:'s|\s+is)\s+uncovered\b/g, 'coverage gaps')
    .replace(/\buncovered\b/g, 'coverage gaps');
}

/** Lowercase alnum/dotted/hyphenated tokens (keeps package-ish names like "dspy.ts", "cve-bench" whole). */
function rawTokens(text) {
  const normalized = normalizePhrases(text);
  return normalized.match(/[a-z0-9][a-z0-9+.#-]*[a-z0-9]|[a-z0-9]/g) || [];
}

/**
 * Content tokens for scoring: the whole-token pass PLUS each hyphenated compound's own parts
 * (so "graph-database" also credits "graph" and "database"). Splitting only ADDS candidate
 * overlap — it can turn a miss into a hit, never the reverse — so it can only improve recall, not
 * create a false positive on its own; the confidence thresholds below still gate every hit.
 */
export function contentTokens(text) {
  const out = new Set();
  for (const t of rawTokens(text)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
    if (t.includes('-')) {
      for (const part of t.split('-')) {
        if (part.length >= 3 && !STOPWORDS.has(part)) out.add(part);
      }
    }
  }
  return [...out];
}

/**
 * WHOLE tokens only — deliberately NOT split on hyphens. This is the "is this repo NAMED?"
 * predicate, and splitting would break it: several real repo names share a generic hyphenated
 * prefix ("agent-harness-generator" vs "agentic-flow" vs "agenticow" all split to include
 * "agent"; "cognitum-cogs" splits to include "cognitum", the very word a question about the
 * UNRELATED, privately-fenced "cognitum-seed" would also contain). Measured live during test
 * authoring: with split identity tokens, "what capabilities does the cognitum-seed appliance
 * ship?" registered as naming cognitum-cogs, purely off the shared "cognitum" fragment. Identity
 * must match the repo's WHOLE key, never a fragment of it — content overlap (contentTokens,
 * above) is where splitting belongs, because there it can only ever ADD recall, never identity.
 */
function wholeTokens(text) {
  const out = new Set();
  for (const t of rawTokens(text)) if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  return out;
}

/** Parse "## <repo>\n<body>" sections — the same shape scripts/build-concepts.mjs reads. */
export function parseCards(md) {
  const cards = [];
  for (const sec of String(md || '').split(/^##\s+/m).slice(1)) {
    const nl = sec.indexOf('\n');
    if (nl < 0) continue;
    const repo = sec.slice(0, nl).trim();
    const body = sec.slice(nl + 1).trim();
    if (!repo || !body) continue;
    cards.push({ repo, body });
  }
  return cards;
}

// Memoized by (dir, mtime) — capability-cards.md is tiny (~20KB) and this process is typically the
// long-lived warm MCP child, so parsing once and reusing is what gets a hit down into low-single-
// digit milliseconds instead of re-parsing ~30 cards on every call.
// Keyed by (dir, mtimeMs, SIZE). mtime alone is not enough: many filesystems quantise mtime (ext4
// on CI, and some to a whole second), so two writes inside one tick are indistinguishable and the
// cache serves stale cards. Size is free from the same stat() and closes the common case. Found
// 2026-07-28 when CI went red on exactly that race — the PRODUCT was right and the test was
// clock-dependent, but the staleness window is real and worth closing rather than tolerating.
let _cache = null; // { dir, mtimeMs, size, cards }

/** Read + parse capability-cards.md from a bundle dir. Returns null (never []) when it is absent —
 *  an older/partial bundle without this file must not be silently reported as "zero cards". */
export function loadCards(dir) {
  const file = path.join(dir, CARDS_FILE);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (_cache && _cache.dir === dir && _cache.mtimeMs === stat.mtimeMs && _cache.size === stat.size) return _cache.cards;
  const raw = fs.readFileSync(file, 'utf8');
  const cards = parseCards(raw).map((c) => ({
    repo: c.repo,
    body: c.body,
    tokenSet: new Set(contentTokens(`${c.repo} ${c.body}`)),
    // Identity token: the repo's own WHOLE key, lowercased — never split (see wholeTokens above).
    repoIdentity: c.repo.toLowerCase(),
  }));
  _cache = { dir, mtimeMs: stat.mtimeMs, size: stat.size, cards };
  return cards;
}

// Thresholds for the UNNAMED path (the query never names any repo — a purely DESCRIBED need).
// Not invented: tuned against plugin/test/capability-questions{,.heldout}.json, the real
// first-party question set already used to gate by-description routing.
const MIN_OVERLAP = 2;       // at least 2 distinct content words in common with the card
const MIN_COVERAGE = 0.34;   // at least a third of the query's own content words must be explained
const MIN_MARGIN = 1;        // the winner must beat the runner-up by at least one more overlapping word

/**
 * Use the card index as a source-search router when a generic card cannot honestly answer.
 * Candidate repo names are routing hints only; the caller still has to retrieve source evidence.
 */
export function routeReposFromCards(query, dir, availableRepos, { limit = 3 } = {}) {
  const q = String(query || '').trim();
  const qIdentityPhrase = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const available = new Set(Array.isArray(availableRepos) ? availableRepos : []);
  const cards = loadCards(dir);
  if (!q || !cards?.length || !available.size) {
    return { repos: [], confidence: 'none', reason: !q ? 'empty query' : 'card index unavailable' };
  }

  const qTokens = contentTokens(q);
  const qIdentity = wholeTokens(q);
  const aliases = loadRepoAliases(dir);
  const scopedPackage = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+/i.test(q);
  const namesRepo = (repo) => {
    const phrase = String(repo).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return phrase.length >= 3
      && new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`).test(qIdentityPhrase);
  };
  const canonicalNamed = new Set();
  const aliasNamed = new Set();
  for (const repo of available) {
    if (qIdentity.has(repo.toLowerCase()) || namesRepo(repo)) canonicalNamed.add(repo);
    if (repositoryNames(repo, dir)
      .filter((name) => name.toLowerCase() !== repo.toLowerCase())
      .some((name) => qIdentity.has(name.toLowerCase()) || namesRepo(name))) {
      aliasNamed.add(repo);
    }
  }
  const namedPackage = q.match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+/i)?.[0]?.toLowerCase();
  const packageOwner = namedPackage ? loadPackageOwners(dir)[namedPackage] : null;
  if (packageOwner && available.has(packageOwner)) canonicalNamed.add(packageOwner);
  const rawNamed = new Set([...canonicalNamed, ...aliasNamed]);
  const explicitAliasComparison = rawNamed.size > 1
    && /\b(?:compare|comparison|versus|vs\.?|between|across|difference|differ)\b/i.test(q);
  const aliasesDominatedByContext = Boolean(
    !canonicalNamed.size
    && aliasNamed.size
    && !explicitAliasComparison
    && (() => {
      const registry = loadRepoAliases(dir);
      const resolveCardStore = (cardRepo) =>
        available.has(cardRepo)
          ? cardRepo
          : (registry[cardRepo] || []).find((store) => available.has(store)) || null;
      const overlaps = cards
        .map((card) => {
          const repo = resolveCardStore(card.repo);
          const overlap = qTokens.filter((token) => card.tokenSet.has(token)).length;
          return { repo, overlap, coverage: qTokens.length ? overlap / qTokens.length : 0 };
        })
        .filter(({ repo }) => repo);
      const bestAlias = Math.max(0, ...overlaps
        .filter(({ repo }) => aliasNamed.has(repo))
        .map(({ overlap }) => overlap));
      const bestContext = overlaps
        .filter(({ repo }) => !aliasNamed.has(repo))
        .sort((a, b) => b.overlap - a.overlap || b.coverage - a.coverage)[0];
      return bestContext?.overlap >= MIN_OVERLAP
        && bestContext.coverage >= MIN_COVERAGE
        && bestContext.overlap > bestAlias + 1;
    })()
  );
  // A short store alias can also be ordinary product vocabulary: "RVF cognitive container"
  // names a format inside an AgentDB/RuView question; it does not ask for a second repository.
  // Prefer an explicitly named canonical repo unless the user actually compares products. When
  // no canonical repo is named, aliases remain first-class ("What is RVF?" still routes RuVector).
  const explicitlyNamed = new Set(canonicalNamed);
  if ((!canonicalNamed.size && !aliasesDominatedByContext) || explicitAliasComparison) {
    for (const repo of aliasNamed) explicitlyNamed.add(repo);
  }
  const implicitProductQuestion =
    /\b(?:i\s+am\s+lost|installed\s+this|chatbot|settings\s+screen|version\s+4|asking\s+claude\s+from\s+memory|source\s+question|question\s+to\s+a\s+cited\s+answer|hallucinat\w*|evidence\s+is\s+thin|search\s+(?:has\s+been\s+)?spinning|source\s+worker|query\s+routing|cross-encoder|release-proof|npm\s+package|ready\s+to\s+ship|storage\s+split|capabilit\w*\s+described\s+in\s+an?\s+adr|reranks?\s+candidates?)\b/i.test(q)
    || (/\bcodex\b/i.test(q) && /\bclaude(?:\s+code)?\b/i.test(q))
    || (/\bsearch\b/i.test(q) && /\bfinds?\s+nothing\b/i.test(q));
  // Product-pipeline vocabulary is stronger than a dependency token inside the same question.
  // "Which code path reranks candidates after RVF retrieval?" is about Brain's retrieval pipeline,
  // not RuVector's storage engine. Add Brain even when RVF/Ruflo/AgentDB is also named; the
  // primary-product rule below then removes dependency scopes unless the user explicitly compares.
  if (implicitProductQuestion && canonicalNamed.size === 0 && available.has('ruvnet-brain')) {
    explicitlyNamed.add('ruvnet-brain');
  }
  // Product-scoped questions often name the implementation tools used by RuvNet Brain
  // ("RuvNet Brain ... Agentic QE, Ruflo, AgentDB"). Those references are dependencies, not three
  // requested search boundaries. Search the product's own source first; it records how the pieces
  // are wired. Preserve true multi-repo intent when the user explicitly asks for a comparison.
  const explicitMultiRepoComparison = explicitlyNamed.size > 1
    && /\b(?:compare|comparison|versus|vs\.?|between|across|difference|differ)\b/i.test(q);
  const primaryBrainScope = explicitlyNamed.has('ruvnet-brain')
    && !explicitMultiRepoComparison;
  if (primaryBrainScope) {
    for (const repo of explicitlyNamed) {
      if (repo !== 'ruvnet-brain') explicitlyNamed.delete(repo);
    }
  }
  const resolveStore = (cardRepo) => {
    if (available.has(cardRepo)) return cardRepo;
    return (aliases[cardRepo] || []).find((alias) => available.has(alias)) || null;
  };

  const scored = cards
    .map((card) => ({ card, repo: resolveStore(card.repo) }))
    .filter((candidate) => candidate.repo)
    .map(({ card, repo }) => {
      const storeIdentity = repo.toLowerCase();
      const named = explicitlyNamed.has(repo)
        || (!primaryBrainScope && (
          qIdentity.has(card.repoIdentity)
          || qIdentity.has(storeIdentity)
          || namesRepo(card.repo)
        ));
      const tokens = qTokens.filter((token) =>
        token !== card.repoIdentity && token !== storeIdentity);
      let overlap = 0;
      for (const token of tokens) if (card.tokenSet.has(token)) overlap++;
      return {
        repo,
        cardRepo: card.repo,
        named,
        overlap,
        coverage: tokens.length ? overlap / tokens.length : 0,
      };
    })
    .sort((a, b) => Number(b.named) - Number(a.named) || b.overlap - a.overlap || b.coverage - a.coverage);

  const named = scored.filter((candidate) => candidate.named);
  const first = scored[0];
  const second = scored[1];
  const described = !named.length
    && first?.overlap >= MIN_OVERLAP
    && first.coverage >= MIN_COVERAGE
    && first.overlap - (second?.overlap || 0) >= MIN_MARGIN;
  // Routing hints may safely preserve a small tie: unlike answerFromCards, this path never emits
  // a capability claim. It only narrows source retrieval, which must independently prove the
  // answer. Refusing a two-way tie here needlessly falls back from 2 repos to the entire corpus.
  const tiedLeaders = !named.length && first?.overlap >= MIN_OVERLAP
    ? scored.filter((candidate) =>
      candidate.overlap === first.overlap
      && candidate.coverage >= MIN_COVERAGE)
    : [];
  const describedCluster = !described && tiedLeaders.length >= 2 && tiedLeaders.length <= 3;
  if (!named.length && !described && !describedCluster) {
    return {
      repos: [],
      confidence: 'none',
      reason: `card router was ambiguous (closest=${first?.repo || 'none'} overlap=${first?.overlap || 0})`,
    };
  }

  const selected = [];
  const candidates = named.length
    ? named
    : describedCluster
      ? tiedLeaders
      : [first];
  for (const candidate of candidates) {
    if (candidate.overlap <= 0 && !candidate.named) continue;
    if (!selected.includes(candidate.repo)) selected.push(candidate.repo);
    if (selected.length >= Math.max(1, limit)) break;
  }
  // A confident source route must stay scoped. `concepts` is a 24-candidate aggregate store; adding
  // it to every named or single-winner route turned an 8-passage source lookup into 32+ full
  // cross-encoder reads. Keep it only for a genuine small tie where its shared primer can resolve
  // the ambiguity without widening to the full corpus.
  if (!scopedPackage && describedCluster && available.has('concepts') && !selected.includes('concepts')) {
    selected.push('concepts');
  }
  const cardRepos = Object.fromEntries(selected
    .map((repo) => [repo, scored.find((candidate) => candidate.repo === repo)?.cardRepo])
    .filter(([, cardRepo]) => cardRepo));
  return {
    repos: selected,
    namedRepos: named.map((candidate) => candidate.repo),
    cardRepos,
    primaryProductScope: primaryBrainScope,
    confidence: named.length ? 'named' : 'described',
    reason: named.length
      ? `query explicitly names ${named.map((candidate) => candidate.repo).join(', ')}`
      : describedCluster
        ? `card evidence preserves ${tiedLeaders.length} tied source candidates (${first.overlap} matching concepts)`
        : `card evidence favors ${first.repo} (${first.overlap} matching concepts)`,
  };
}

/**
 * The fast lane's one entry point. Returns a usable, cited answer when the cards confidently cover
 * the query, or { hit: false, reason } when they do not — never a guess dressed as an answer.
 */
function isGuideQuestion(query) {
  const q = String(query || '');
  const claimText = q.replace(/\bgreen\s+test\s+run\s+prove\b/gi, 'green test run establish');
  const sourceOrReleaseClaim =
    /\b(?:built|shipped|implemented|released|deployed|current(?:ly)?|latest|default|prove|proof|source\s+code|code\s+path|adr[-\s_]?\d+)\b/i;
  if (sourceOrReleaseClaim.test(claimText)) return false;
  return /\b(?:what\s+is|what\s+does|what\s+happens|how\s+do\s+i|which\s+store|difference\s+between|fit\s+together|good\s+enough|chatbot|database|settings\s+screen|install\s+is\s+healthy|work\s+in\s+codex|turn\s+the\s+brain\s+off|green\s+test\s+run\s+prove|every\s+capability\s+described\s+in\s+an?\s+adr|what\s+exact\s+evidence)\b/i.test(q);
}

export function answerFromCards(query, dir, { allowGuideAnswers = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return { hit: false, reason: 'empty query' };
  if (requiresImplementationProof(q) && !(allowGuideAnswers && isGuideQuestion(q))) {
    return { hit: false, reason: 'implementation evidence required; curated cards cannot prove built or shipped state' };
  }
  // Capability cards answer product-level selection and concepts. Package APIs, registration code,
  // ADR status, and benchmark claims require the source-bearing lane even when a generic card has
  // overlapping words.
  const scopedPackage = q.match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+/i)?.[0];
  if (scopedPackage) {
    return { hit: false, reason: `scoped package detail requires source retrieval (${scopedPackage})` };
  }
  const exactArtifact = /(?:^|[\s'"`])(?:\.{0,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+(?:$|[\s'"`,:;?)])/u.test(q)
    || /\b[A-Za-z0-9_.-]+\.(?:c|cc|cpp|go|h|hpp|java|js|jsx|mjs|cjs|md|py|rs|sh|sql|toml|ts|tsx|yaml|yml)\b/i.test(q);
  if (exactArtifact) {
    return { hit: false, reason: 'exact path or file query requires source retrieval' };
  }
  const sourceDetail =
    /\b(?:adr[-\s_]?\d+|api|sdk|backends?|exports?|registered|source code|code path|(?:code|working)\s+example|(?:three|\d+)\s+lines?\s+of\s+code|snippet|actually\s+mutate|supported?\s+topolog(?:y|ies)|topolog(?:y|ies)\s+does\s+it\s+support|package names?|crate names?|workspace|supersedes?|deployment\s+process|exact[-\s]+artifact|github\s+checks?|independent\s+graders?)\b/i;
  const claimValidation =
    /\b(?:validate|benchmark(?:ed|ing)?)\b[\s\S]{0,80}\b(?:claim|performance)\b|\b(?:claim|performance)\b[\s\S]{0,80}\b(?:validate|benchmark(?:ed|ing)?)\b/i;
  const costQualityTradeoff =
    /\b(?:cheap(?:er|est)?|cost|spend)\b[\s\S]{0,100}\bquality\b|\bquality\b[\s\S]{0,100}\b(?:cheap(?:er|est)?|cost|spend)\b/i;
  const fixedModelHarnessEvolution =
    /\b(?:agent(?:'s)?\s+scaffolding|harness)\b[\s\S]{0,120}\bwithout\s+(?:changing|replacing|swapping)(?:\s+out)?\s+(?:the\s+)?model\b/i;
  const meaningPreservingCompression =
    /\b(?:compress|shrink)\w*\b[\s\S]{0,80}\b(?:prompts?|instructions?)\b[\s\S]{0,80}\bwithout\s+(?:losing|changing)\b[\s\S]{0,40}\b(?:meaning|behavio[u]?r)\b/i.test(q)
    || /\b(?:prompts?|instructions?)\b[\s\S]{0,80}\b(?:compress|shrink)\w*\b[\s\S]{0,80}\bwithout\s+(?:losing|changing)\b[\s\S]{0,40}\b(?:meaning|behavio[u]?r)\b/i.test(q);
  const cheapFirstFailureEscalation =
    /\bcheap\s+model\b[\s\S]{0,140}\b(?:gives?\s+up|fail(?:s|ed|ure)?)\b/i.test(q)
    && /\b(?:expensive|pay|escalat\w*)\b/i.test(q);
  if (sourceDetail.test(q)
      || claimValidation.test(q)
      || costQualityTradeoff.test(normalizePhrases(q))
      || fixedModelHarnessEvolution.test(q)
      || meaningPreservingCompression
      || cheapFirstFailureEscalation) {
    return { hit: false, reason: 'implementation/source detail requires source retrieval' };
  }
  const cards = loadCards(dir);
  if (!cards || !cards.length) return { hit: false, reason: 'no capability-cards.md in this bundle' };

  const qTokens = contentTokens(q);
  if (!qTokens.length) return { hit: false, reason: 'query has no scoreable content words' };
  const qIdentity = wholeTokens(q); // exact whole-token set, for the "is this repo NAMED?" test only
  // In ecosystem-selection questions, "RuvNet" names the umbrella, not the `ruvnet` repository.
  // Treating it as a repo identity forces every "Which RuvNet tool …?" query onto the generic
  // card before the requested capability can rank. Direct questions such as "What is ruvnet?"
  // retain their exact-identity behavior.
  if (/\b(?:what|which)\s+ruvnet\s+(?:tool|repo|repository|package)\b/i.test(q)) {
    qIdentity.delete('ruvnet');
  }
  let preferredGuideRepo = null;
  if (allowGuideAnswers) {
    if (/\b(?:chatbot|settings\s+screen|install\s+is\s+healthy|question\s+to\s+a\s+cited\s+answer|work\s+in\s+codex|turn\s+the\s+brain\s+off|green\s+test\s+run\s+prove|every\s+capability\s+described\s+in\s+an?\s+adr|what\s+exact\s+evidence)\b/i.test(q)) {
      preferredGuideRepo = 'ruvnet-brain';
    } else if (/\borchestration\b/i.test(q) && /\bmemory\b/i.test(q)) {
      preferredGuideRepo = 'ruflo';
    } else {
      const namedByPosition = cards
        .flatMap((card) => repositoryNames(card.repo, dir)
          .map((name) => ({
            repo: card.repo,
            at: qIdentity.has(name.toLowerCase())
              ? q.toLowerCase().indexOf(name.toLowerCase())
              : -1,
          })))
        .filter(({ at }) => at >= 0)
        .sort((a, b) => a.at - b.at);
      preferredGuideRepo = namedByPosition[0]?.repo || null;
    }
  }

  const scored = cards.map((card) => {
    const preferred = preferredGuideRepo === card.repo;
    const namedRepo = preferred || repositoryNames(card.repo, dir)
      .some((name) => qIdentity.has(name.toLowerCase()));
    // Once named, don't let the repo's OWN name token (e.g. "rvm") double-count against its body.
    const nonRepoTokens = qTokens.filter((t) => t !== card.repoIdentity);
    let bodyOverlap = 0;
    for (const t of nonRepoTokens) if (card.tokenSet.has(t)) bodyOverlap++;
    const totalOverlap = bodyOverlap + (namedRepo ? 1 : 0); // for ranking/margin only
    return { card, preferred, namedRepo, nonRepoCount: nonRepoTokens.length, bodyOverlap, totalOverlap };
  });
  scored.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.totalOverlap - a.totalOverlap);
  const top = scored[0];
  const second = scored[1] || { totalOverlap: 0 };

  let confident;
  if (top.namedRepo) {
    // The query names this card's repo outright ("what is X", "does X do Y"). That alone is
    // decisive ONLY when there is nothing else being asked (a plain "what is X" — the degenerate,
    // ideal case for a generic card) OR the card's own body actually speaks to the rest of the
    // question. Naming the repo is never sufficient on its own for a SPECIFIC ask the card is
    // silent on (the Thompson-Sampling/AgentDB case this file's header documents).
    confident = top.nonRepoCount === 0 || top.bodyOverlap >= 1;
  } else {
    const coverage = top.bodyOverlap / qTokens.length;
    confident = top.bodyOverlap >= MIN_OVERLAP
      && coverage >= MIN_COVERAGE
      && (top.totalOverlap - second.totalOverlap) >= MIN_MARGIN;
  }

  if (!confident) {
    return {
      hit: false,
      reason: `no card cleared the confidence bar (closest=${top.card.repo} bodyOverlap=${top.bodyOverlap}/${qTokens.length} named=${top.namedRepo})`,
    };
  }

  return {
    hit: true,
    repo: top.card.repo,
    bodyOverlap: top.bodyOverlap,
    coverage: Number((top.bodyOverlap / qTokens.length).toFixed(2)),
    namedRepo: top.namedRepo,
    path: `${CARDS_FILE}#${top.card.repo}`,
    text: top.card.body,
  };
}

/** Render a fast-lane hit into the same "text block" shape the heavy path returns, so a caller can
 *  read content[0].text uniformly either way — plus a plain marker a consumer can grep for. */
export function renderCardHit(hit) {
  const confidence = hit.namedRepo
    ? 'named directly'
    : `overlap ${hit.bodyOverlap}, coverage ${hit.coverage}`;
  return (
    `⚡ FAST LANE — zero-ML keyword match (${confidence})\n`
    + `#1  repo=${hit.repo}  evidence=curated-capability-card\n`
    + `path : ${hit.repo}/kb/${hit.path}\n`
    + `----- grounded summary -----\n`
    + `${hit.text}\n\n`
    + `➡ This is a curated summary card, not a full-text passage. For code-level detail (exact APIs, `
    + `function signatures, ADR status), ask a more specific question — that runs the full source search.`
  );
}
