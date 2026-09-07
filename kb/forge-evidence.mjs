// forge-evidence.mjs — THE SUBSTANCE WRITER (ADR-055 §3.1, build item 4; issue #46).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS. The grounding stamp records that a search RAN. It has never recorded what
// the search RETURNED. Observed live 2026-07-27: the model called search_ruvnet, received rUv's own
// working browser example (`ruvector/examples/rvf/scripts/rvf-browser.html` — `npm install
// @ruvector/rvf-wasm`, "No backend required"), and hours later wrote browser code importing that
// exact runtime from `esm.sh`. Every gate stayed green, because a term + a timestamp cannot
// contradict anything. The model's own admission: "The Brain did its job. I ignored it."
//
// This module turns a retrieval ANSWER into machine-usable FACTS, appended one JSON line per answer
// to an append-only evidence ledger. `plugin/scripts/grounding-substance.mjs` reads that ledger and
// is the half that can refuse.
//
// ── FOUR CONTRACTS, each load-bearing ───────────────────────────────────────────────────────────
//
// 1. EXTRACTION IS DETERMINISTIC (ADR-055 §3.1: "an LLM summary never becomes a hard fact"). Every
//    fact below comes from a regex over the document's own bytes: install commands, package names,
//    URLs the source itself carries, exported/imported symbols, and posture phrases quoted
//    VERBATIM. Nothing is inferred, summarised or scored.
//
// 2. IT RUNS ON THE SUCCESS PATH ONLY. A refusal, an outage, a thrown error, an empty result and a
//    switched-off brain must mint NOTHING — exactly the discipline `grounding-stamp.sh` had to
//    learn the hard way (ADR-054 §3; five distinct non-answers minted five valid 24h stamps on the
//    pre-fix tree). The call site in `forge-mcp-all.mjs` sits after those four early returns, and
//    tests/unit/fourth-wall.test.mjs T4 replays all five.
//
// 3. IT CAN NEVER BREAK A QUERY. Every entry point is total: it catches everything and returns a
//    benign value. A brain that stops answering because evidence capture threw is strictly worse
//    than a brain with no evidence at all.
//
// 4. NO IMPORTS OUTSIDE kb/. This ships inside the knowledge bundle, where scripts/ does not exist
//    (issue #32 — MODULE_NOT_FOUND on every real install, twice). Node builtins only.
//
// ── WHY THE PRODUCER AND NOT A PostToolUse HOOK ─────────────────────────────────────────────────
// ADR-055 §3.1 records the resolved disagreement: GPT-5.6's position won — the producer holds the
// actual source documents, while a PostToolUse hook would have to regex-mine a JSON-encoded prose
// payload (this repo's own grounding-stamp.sh header documents that quote-escaping pain at length).
// The ADR then assigns PERSISTENCE to a thin PostToolUse bridge. This implementation writes the
// ledger line from the producer instead, and that is a deliberate, smaller deviation in the same
// direction: the producer already has the documents AND the filesystem, so the bridge would add a
// second process, a second parse of the same escaped prose, and a failure mode (hook not installed
// ⇒ receipts silently never persisted) for no gain. The typed receipt is ALSO returned to the model
// in `structuredContent`, so a future bridge, the console, or another host can consume it without
// re-mining prose — which was the actual point of §3.1.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Ledger location. Mirrors the token-ledger convention in forge-mcp-all.mjs (never inside a project). */
export function evidenceFile() {
  if (process.env.RUVNET_EVIDENCE_FILE) return process.env.RUVNET_EVIDENCE_FILE;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, 'ruvnet-brain')
    : path.join(home, '.cache', 'ruvnet-brain');
  return path.join(dir, 'evidence.jsonl');
}

/** Capped file (ADR-055: "capped file, swallowed failures"). Bytes, not lines — a line is a document set. */
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_LINES = 400;
/** Per-document caps. A 200KB source file must not put 200KB into a ledger the write path reads hot. */
const MAX_PER_KIND = 24;
const MAX_QUOTE = 180;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sha12 = (s) => sha256(s).slice(0, 12);

// ── Regexes. Each one is a FACT extractor; none of them guesses. ────────────────────────────────

/**
 * Install commands, verbatim. The captured command string goes into the refusal text unmodified —
 * "the source's own words" is the whole point (ADR-055 §1.3: compliance must be cheaper than
 * defiance, which means the compliant command has to be RIGHT THERE).
 */
const INSTALL_RE = new RegExp(
  String.raw`(?:^|[\s\`>$])((?:npm\s+(?:install|i|add)|pnpm\s+(?:install|i|add)|yarn\s+add|bun\s+(?:install|add))` +
  String.raw`((?:\s+-{1,2}[\w-]+)*)\s+((?:@[\w.-]+\/)?[\w.][\w.-]*)(@[\w.^~*><=+-]+)?)`,
  'gm',
);
const CARGO_RE = /(?:^|[\s`>$])((?:cargo\s+(?:add|install))\s+([a-zA-Z][\w-]*))/gm;
const PIP_RE = /(?:^|[\s`>$])((?:pip3?\s+install)\s+([a-zA-Z][\w.-]*))/gm;

/** Any URL the source itself carries. Hosts are what D1 compares against — never an allowlist. */
const URL_RE = /https?:\/\/([a-zA-Z0-9._-]+)(\/[^\s"'`)\]<>]*)?/g;

/** Bare package specifiers the source imports (not relative, not a URL). */
const IMPORT_FROM_RE = /\b(?:import|export)\b[^;'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"\n]+)['"]/g;

/** Named bindings pulled out of an import — `import init, { VectorDB, search } from 'pkg'`. */
const NAMED_BINDINGS_RE = /\bimport\s+([^;'"\n]*?)\bfrom\s*['"]([^'"\n]+)['"]/g;

/** Symbols the source EXPORTS. JS/TS + Rust, because rUv's corpus is both. */
const EXPORT_RES = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bpub\s+(?:async\s+)?fn\s+([a-z_][\w]*)/g,
  /\bpub\s+struct\s+([A-Za-z_][\w]*)/g,
  /\bpub\s+(?:enum|trait|type|mod)\s+([A-Za-z_][\w]*)/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm,
  /^\s*class\s+([A-Za-z_][\w]*)\b/gm,
];
const RUST_PUB_USE_RE =
  /\bpub\s+use\s+[^;\n]*?(?:\{([^}\n]+)\}|(?:::)?([A-Za-z_][\w]*))\s*;/g;

/**
 * POSTURE PHRASES, quoted verbatim. These are what make "the stamped source ships this locally" a
 * FACT rather than a vibe: the source says so, in these words, and the refusal repeats them back.
 */
const POSTURE_RES = [
  /No backend required[.!]?/i,
  /runs? (?:entirely|completely) in (?:the|your) browser/i,
  /entirely in (?:the|your) browser/i,
  /(?:fully|entirely|completely) local/i,
  /no server (?:required|needed)/i,
  /zero (?:dependencies|deps)/i,
  /offline[- ]first/i,
  /all data stays (?:in|on)[^.\n]{0,40}/i,
  /zero server round-trips/i,
  /nothing leaves your (?:device|machine)/i,
  /client-side only/i,
  /fully (?:in (?:the|your) browser|client[- ]side)/i,
  /no (?:data )?upload/i,
  /gold\s+`?patch`?\s+is\s+never\s+applied[^.\n]{0,180}(?:during\s+grading|--grade)/i,
  /gold\s+is\s+used\s+only\s+by\s+--validate,\s+never\s+during\s+grading/i,
];

/**
 * EXPLICIT NEGATIVE FACTS (ADR-055 §3.1). The only form of "X is absent" that may ever block:
 * the source SAYS it. Absence from retrieval is advisory and is not collected here at all (§3.3).
 */
const NEGATIVE_RES = [
  /\b(?:does|do)\s+not\s+(?:export|expose|provide|include|support|ship)\s+`?([A-Za-z_$][\w$]*)/gi,
  /\bthere\s+is\s+no\s+`?([A-Za-z_$][\w$]*)`?\s+(?:export|function|method|api)/gi,
];

/** `@scope/name` → `name`; `name` → `name`. The unit D2 compares owners on. */
export function pkgBase(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Normalise a bare import specifier to its package name: `pkg/sub/path` → `pkg`, `@s/p/x` → `@s/p`. */
export function specToPackage(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || /^https?:/i.test(s)) return null;
  const parts = s.split('/');
  if (s.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/**
 * Package named by a delivery URL: `https://esm.sh/@ruvector/rvf-wasm@1.2/x.js` → `@ruvector/rvf-wasm`.
 * Understands the `/npm/` prefix jsDelivr uses and strips a trailing `@version`.
 * Returns null when the URL does not name a package — and a null NEVER produces a finding.
 */
export function packageFromUrl(url) {
  try {
    const m = /^https?:\/\/[^/]+\/(.*)$/i.exec(String(url || ''));
    if (!m) return null;
    let rest = m[1].replace(/^(?:npm|gh|pkg)\//, '');
    rest = rest.split('?')[0].split('#')[0];
    const parts = rest.split('/').filter(Boolean);
    if (!parts.length) return null;
    let name = parts[0].startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    // `@scope/name@1.2.3` — strip the version, keeping the scope's own leading @.
    const at = name.lastIndexOf('@');
    if (at > 0) name = name.slice(0, at);
    if (!/^(?:@[\w.-]+\/)?[\w.][\w.-]*$/.test(name)) return null;
    // A bare file is not a package.
    if (/\.(?:js|mjs|cjs|ts|wasm|json|html|css|map)$/i.test(name)) return null;
    return name;
  } catch { return null; }
}

const uniq = (a) => [...new Set(a.filter(Boolean))];
const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE);

function canonicalClaimTokens(value) {
  const text = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const raw = text.match(/[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]/g) || [];
  return raw.map((term) => {
    if (/^explain(?:able|ed|ing|s)?$/.test(term)) return 'explain';
    if (/^recall(?:ed|ing|s)?$/.test(term)) return 'recall';
    if (/^generat(?:e|ed|es|ing|ion|ions|or|ors)$/.test(term)) return 'generate';
    if (/^tests?$/.test(term)) return 'test';
    if (/^encrypt(?:ed|ing|s)?$/.test(term)) return 'encrypt';
    if (/^rotat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'rotate';
    if (/^coordinat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'coordinate';
    if (/^orchestrat(?:e|ed|es|ing|ion|ions)$/.test(term)) return 'orchestrate';
    if (/^persist(?:ed|ing|s|ence|ent)?$/.test(term)) return 'persist';
    if (/^retain(?:ed|ing|s)?$/.test(term)) return 'retain';
    return term;
  });
}

function sourceBindsQueryClaim(query, sourceText) {
  const queryTokens = canonicalClaimTokens(query);
  const sourceTokens = canonicalClaimTokens(sourceText);
  const actions = new Set([
    'coordinate', 'encrypt', 'explain', 'generate',
    'orchestrate', 'persist', 'retain', 'rotate',
  ]);
  const noise = new Set([
    'a', 'an', 'are', 'automatically', 'can', 'could', 'do', 'does', 'has', 'have',
    'is', 'it', 'not', 'particular', 'should', 'the', 'this', 'why', 'will', 'would',
  ]);
  const pairs = [];
  for (let index = 0; index < queryTokens.length; index++) {
    const action = queryTokens[index];
    if (!actions.has(action)) continue;
    const object = queryTokens.slice(index + 1, index + 6)
      .find((term) => !noise.has(term) && !actions.has(term));
    if (object) pairs.push([action, object]);
  }
  if (!pairs.length) return false;
  return pairs.every(([action, object]) => {
    const actionPositions = sourceTokens
      .map((term, index) => term === action ? index : -1)
      .filter((index) => index >= 0);
    const objectPositions = sourceTokens
      .map((term, index) => term === object ? index : -1)
      .filter((index) => index >= 0);
    return actionPositions.some((left) =>
      objectPositions.some((right) => Math.abs(left - right) <= 2));
  });
}

/**
 * The extractor. One returned DOCUMENT in, one typed fact record out.
 * Total: any throw yields a minimal record rather than propagating into a query.
 */
export function extractFacts(doc) {
  const rec = {
    repo: String(doc?.repo || ''),
    path: String(doc?.path || ''),
    packages: [],
    origins: [],
    urls: [],
    imports: [],
    symbols: [],
    posture: [],
    negatives: [],
    capability: null,
    sourceReference: null,
    enforceable: false,
    chars: 0,
    sha: '',
  };
  try {
    const text = String(doc?.fullText || doc?.text || '');
    rec.chars = text.length;
    // Full SHA-256 is required for answer-time capability claims. The receipt id below remains a
    // compact lookup handle, but the source identity used as evidence must not be truncated.
    rec.sha = sha256(text);
    if (!text) return rec;
    if (/^capability-cards\.md#/i.test(rec.path) && rec.repo) rec.capability = rec.repo;
    if (/\.(?:c|cc|cpp|cxx|go|java|js|jsx|mjs|cjs|py|rs|ts|tsx)$/i.test(rec.path)) {
      rec.sourceReference = { path: rec.path, sha: rec.sha };
    }

    // 1. Install commands → packages, each carrying the exact command a compliant write would run.
    const packages = new Map();
    const addPkg = (name, command, manager) => {
      if (!name || packages.size >= MAX_PER_KIND) return;
      if (!packages.has(name)) packages.set(name, { name, install: clip(command), manager });
    };
    for (const m of text.matchAll(INSTALL_RE)) {
      const name = m[3];
      if (!name || name === '.' || name.startsWith('-')) continue;
      addPkg(name, m[1], m[1].trim().split(/\s+/)[0]);
    }
    for (const m of text.matchAll(CARGO_RE)) addPkg(m[2], m[1], 'cargo');
    for (const m of text.matchAll(PIP_RE)) addPkg(m[2], m[1], 'pip');
    rec.packages = [...packages.values()];

    // 2. Origins the SOURCE ITSELF carries. This is the field that makes D1 legal: a "no CDN" rule
    //    would be a false-positive machine, because rvf-browser.html offers a CDN alternative in its
    //    own text (ADR-055 F22). What the source carries, the source permits.
    const hosts = [];
    const urls = [];
    for (const m of text.matchAll(URL_RE)) {
      hosts.push(m[1].toLowerCase());
      if (urls.length < MAX_PER_KIND) urls.push(clip(m[0]));
    }
    rec.origins = uniq(hosts).slice(0, MAX_PER_KIND);
    rec.urls = uniq(urls);

    // 3. What the source imports, and by what name.
    const imports = [];
    const symbols = new Map();
    const addSym = (name, pkg) => {
      if (!name || symbols.size >= MAX_PER_KIND * 2) return;
      if (!symbols.has(name)) symbols.set(name, { name, pkg: pkg || null });
    };
    for (const re of [IMPORT_FROM_RE, REQUIRE_RE, BARE_IMPORT_RE]) {
      for (const m of text.matchAll(re)) {
        const p = specToPackage(m[1]);
        if (p) imports.push(p);
      }
    }
    rec.imports = uniq(imports).slice(0, MAX_PER_KIND);
    for (const m of text.matchAll(NAMED_BINDINGS_RE)) {
      const pkg = specToPackage(m[2]) || packageFromUrl(m[2]);
      const clause = m[1];
      const braced = /\{([^}]*)\}/.exec(clause);
      if (braced) {
        for (const raw of braced[1].split(',')) {
          const nm = raw.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) addSym(nm, pkg);
        }
      }
      const dflt = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/g, ''));
      if (dflt) addSym(dflt[1], pkg);
    }
    // 4. Symbols the source EXPORTS. Attribution is to the document's own package when it has one.
    const ownPkg = rec.packages[0]?.name || null;
    for (const re of EXPORT_RES) for (const m of text.matchAll(re)) addSym(m[1], ownPkg);
    for (const m of text.matchAll(RUST_PUB_USE_RE)) {
      if (m[1]) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_][\w]*$/.test(name) && name !== 'self') addSym(name, ownPkg);
        }
      } else addSym(m[2], ownPkg);
    }
    rec.symbols = [...symbols.values()];

    // 5. Posture, in the source's own words.
    for (const re of POSTURE_RES) {
      const m = re.exec(text);
      if (m) rec.posture.push(clip(m[0]));
      if (rec.posture.length >= 6) break;
    }
    rec.posture = uniq(rec.posture);

    // 6. Explicit negative facts.
    for (const re of NEGATIVE_RES) {
      for (const m of text.matchAll(re)) {
        rec.negatives.push({ symbol: m[1], quote: clip(m[0]) });
        if (rec.negatives.length >= 8) break;
      }
    }
    rec.enforceable = Boolean(
      rec.packages.length
      || rec.origins.length
      || rec.symbols.length
      || rec.posture.length
      || rec.negatives.length
    );
  } catch { /* a partial record is fine; a thrown query is not */ }
  return rec;
}

/**
 * Build the typed receipt for one ANSWER (ADR-055 §3.1). Content-addressed: the id is derived from
 * the query plus every source hash, so the same answer twice is the same receipt id, and a receipt
 * that references changed source is detectably a different receipt.
 */
export function buildReceipt({ query, repos, results }) {
  const sources = [];
  try {
    for (const r of (results || [])) {
      const f = extractFacts(r);
      if (!f.enforceable
          && f.sourceReference
          && sourceBindsQueryClaim(query, r?.fullText || r?.text || '')) {
        f.enforceable = true;
        f.claimBinding = { method: 'tight-source-token-pair', query: clip(query) };
      }
      // Keep only documents that carry at least one fact worth binding to. A document with no
      // package, no origin, no symbol and no posture cannot contradict anything, and storing it
      // would only make the ledger bigger and the hot read slower.
      if (f.capability || f.enforceable || f.sourceReference) {
        sources.push(f);
      }
    }
  } catch { /* total */ }
  const id = sha12(`${query} ${sources.map((s) => `${s.repo}/${s.path}:${s.sha}`).join('|')}`);
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    query: clip(query),
    repos: Array.isArray(repos) ? repos.length : null,
    sources,
  };
}

/** Trim the ledger to the newest KEEP_LINES when it outgrows MAX_BYTES. Best-effort, never throws. */
function capFile(file) {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(-KEEP_LINES).join('\n');
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${keep}\n`);
    fs.renameSync(tmp, file);
  } catch { /* a ledger that cannot be trimmed is still a working ledger */ }
}

/**
 * Append one JSON line. Returns the receipt on success and null on any failure — the caller never
 * branches on it, but tests do.
 *
 * Append-only and single-line: concurrent MCP servers on one machine both append, and an O_APPEND
 * write of one short line is the same atomic-enough discipline the token ledger already relies on.
 */
export function appendEvidence(receipt) {
  try {
    if (!receipt || !receipt.sources || !receipt.sources.length) return null;
    const file = evidenceFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`);
    capFile(file);
    return receipt;
  } catch { return null; }
}

/**
 * THE ONE CALL SITE HELPER. Build + append + return the compact receipt to put in
 * `structuredContent`. Total by construction: `recordAnswer` never throws and never returns
 * anything a caller must check.
 */
export function recordAnswer({ query, repos, results }) {
  try {
    if (process.env.RUVNET_BRAIN_EVIDENCE === '0') return null;
    const receipt = buildReceipt({ query, repos, results });
    appendEvidence(receipt);
    // Compact form for the wire: paths + the two facts a reader would act on. The full record stays
    // on disk. Keeping this small is not cosmetic — structuredContent is context the user pays for.
    return {
      receiptId: receipt.id,
      sources: receipt.sources.slice(0, 8).map((s) => ({
        path: `${s.repo}/${s.path}`,
        packages: s.packages.map((p) => p.name),
        installs: s.packages.map((p) => p.install),
        origins: s.origins.slice(0, 6),
        capability: s.capability,
        sha: s.sha,
        sourceReference: s.sourceReference,
        claimBinding: s.claimBinding || null,
        enforceable: s.enforceable,
      })),
    };
  } catch { return null; }
}

/** Read the ledger's newest receipts, newest first. Bounded read; total. */
export function readReceipts({ limit = 60, file = null } = {}) {
  try {
    const f = file || evidenceFile();
    const raw = fs.readFileSync(f, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* skip a torn line, never fail the read */ }
    }
    return out;
  } catch { return []; }
}
