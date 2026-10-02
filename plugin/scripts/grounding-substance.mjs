#!/usr/bin/env node
// grounding-substance.mjs — THE FOURTH WALL (ADR-055 §3, build item 5; issue #46).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE INCIDENT THIS EXISTS FOR (observed live 2026-07-27, owner session).
//
//   The model called search_ruvnet and received rUv's own working browser example —
//   `ruvector/examples/rvf/scripts/rvf-browser.html`: "npm install @ruvector/rvf-wasm",
//   "No backend required." Hours later it wrote browser code importing that exact runtime from
//   `https://esm.sh/@ruvector/rvf-wasm`, contradicting both the returned source and the product's
//   nothing-leaves-your-device premise. EVERY GATE STAYED GREEN. GPT-5.6 replayed that write
//   against the live gate during the ADR-055 duel and measured LIVE_GATE_EXIT=0.
//
//   The reason is one sentence: the grounding stamp records that a search RAN, never what it
//   RETURNED. A term and a timestamp cannot contradict anything. The model's own admission:
//   "The Brain did its job. I ignored it."
//
// This file binds the WRITE to the ANSWER. It runs after ground-before-write.sh's recency wall
// passes, reads the evidence ledger kb/forge-evidence.mjs appends on every successful search, and
// refuses a write that CONTRADICTS the stamped source.
//
// ── THE FIVE RULES THAT KEEP IT FROM BECOMING THEATRE ───────────────────────────────────────────
//
// 1. CONTRADICTION ONLY. "Not found in retrieval" is never sufficient to block (ADR-055 §1, §3.3 —
//    GPT-5.6's correction, adopted). Every detector here needs a POSITIVE fact from the stamped
//    source that the write positively contradicts. No evidence ⇒ no finding, ever.
//
// 2. NO ALLOWLISTS. ADR-055 §3.7.4 refuses "CDN/package allowlists standing in for selected
//    evidence" by name. D1 does not know what a CDN is. It compares the write's remote origin
//    against the origins THE STAMPED SOURCE ITSELF CARRIES — because `rvf-browser.html` offers a
//    CDN alternative in its own text (F22), and a naive "any CDN" rule is a false-positive machine.
//
// 3. MALFUNCTION IS NOT A DECISION (ADR-055 §1.2). Unparseable payload, missing ledger, unreadable
//    policy, an exception anywhere: exit 0. Only a detector may produce exit 2.
//
// 4. THE REFUSAL CARRIES THE EVIDENCE (ADR-055 §1.3). Source path, the install command verbatim,
//    the source's own words, and the compliant replacement — so compliance is cheaper than defiance.
//
// 5. THE OVERRIDE IS IN-BAND, REASONED AND RECEIPTED (ADR-055 §3.5). An environment variable
//    CANNOT be set on a Write call — that was a named defect in this repo's own walls twice
//    (issue #12 defect 2, and design-wall.sh's header). So the token lives in the write payload,
//    carries a mandatory stated reason, and writes its own receipt for later adjudication.
//
// ── SCOPE, DELIBERATELY NARROW ──────────────────────────────────────────────────────────────────
// Detectors D1, D2, D3 (contradiction-shaped) plus D4 where a user-owned policy file states an
// invariant. ADR-055 §3.3's D5 (receipt integrity: tampered / cross-session / changed source
// hashes) is NOT implemented here and is recorded as deferred rather than faked: its blocking form
// needs the outcome ledger and adjudication of build item 7, and a D5 that blocked on "the ledger
// looks odd" would be a malfunction manufacturing a refusal — precisely rule 3 above. Absent or
// unreadable evidence is treated as no evidence, which is exit 0.
//
// CONTRACT: stdin = the raw PreToolUse payload. exit 0 = allow (also every failure mode).
//           exit 2 + refusal on stderr = BLOCK. Never writes to stdout.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHookEvent, toolName } from './hook-input.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The three pure helpers, DUPLICATED from kb/forge-evidence.mjs on purpose. ────────────────────
// The plugin and the knowledge bundle are two independently-shipped artifacts: the bundle lives in
// ~/.cache/ruvnet-brain/kb and the plugin in the Claude Code plugin cache, and neither can import
// the other (kb/ has its own no-imports-outside-kb rule — issue #32, MODULE_NOT_FOUND twice). This
// is the same deliberate duplication the brain-off sentinel read already carries in three files,
// and it is held THE SAME WAY: by test, not by comment. tests/unit/fourth-wall.test.mjs drives one
// shared table of cases through BOTH copies and fails if they ever disagree.
export function pkgBase(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}
export function specToPackage(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || /^https?:/i.test(s)) return null;
  const parts = s.split('/');
  if (s.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}
export function packageFromUrl(url) {
  try {
    const m = /^https?:\/\/[^/]+\/(.*)$/i.exec(String(url || ''));
    if (!m) return null;
    let rest = m[1].replace(/^(?:npm|gh|pkg)\//, '');
    rest = rest.split('?')[0].split('#')[0];
    const parts = rest.split('/').filter(Boolean);
    if (!parts.length) return null;
    let name = parts[0].startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    const at = name.lastIndexOf('@');
    if (at > 0) name = name.slice(0, at);
    if (!/^(?:@[\w.-]+\/)?[\w.][\w.-]*$/.test(name)) return null;
    if (/\.(?:js|mjs|cjs|ts|wasm|json|html|css|map)$/i.test(name)) return null;
    return name;
  } catch { return null; }
}

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────
function cacheDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, 'ruvnet-brain')
    : path.join(home, '.cache', 'ruvnet-brain');
}
const evidenceFile = () => process.env.RUVNET_EVIDENCE_FILE || path.join(cacheDir(), 'evidence.jsonl');
const overrideLedger = () => process.env.RUVNET_OVERRIDE_FILE || path.join(cacheDir(), 'grounding-overrides.jsonl');

const sha12 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

/**
 * Newest receipts first, bounded. `RUVNET_EVIDENCE_MAX_AGE_H` (default 24h) keeps the wall bound to
 * what the model actually saw recently, matching the recency layer beneath it (ADR-012, narrowed by
 * ADR-055 §3.1 to exactly that role).
 */
function readReceipts() {
  try {
    const raw = fs.readFileSync(evidenceFile(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const maxAgeH = Number(process.env.RUVNET_EVIDENCE_MAX_AGE_H ?? 24);
    const cutoff = Number.isFinite(maxAgeH) && maxAgeH > 0 ? Date.now() - maxAgeH * 3600_000 : 0;
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 60; i--) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (!r || !Array.isArray(r.sources)) continue;
      if (cutoff && Date.parse(r.ts || '') && Date.parse(r.ts) < cutoff) continue;
      out.push(r);
    }
    return out;
  } catch { return []; }
}

/**
 * The user-owned project policy (ADR-055 §3.2). It resolves ambiguity the SOURCE cannot: when a
 * source supports both a local install and a CDN, only the user can say which this project uses.
 * Absent ⇒ `source-supported`, i.e. what the source carries, the source permits. That default
 * refuses nothing the source itself offers, which is why shipping it does not need a migration.
 */
function readPolicy(filePath) {
  const tryRead = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  if (process.env.RUVNET_IMPL_POLICY) {
    const p = tryRead(process.env.RUVNET_IMPL_POLICY);
    if (p) return { policy: p, from: process.env.RUVNET_IMPL_POLICY };
  }
  const roots = [];
  if (process.env.CLAUDE_PROJECT_DIR) roots.push(process.env.CLAUDE_PROJECT_DIR);
  try {
    let d = path.dirname(path.resolve(filePath || '.'));
    for (let i = 0; i < 6 && d && d !== path.dirname(d); i++) { roots.push(d); d = path.dirname(d); }
  } catch { /* unresolvable path — the CLAUDE_PROJECT_DIR candidate still stands */ }
  for (const r of roots) {
    const p = path.join(r, '.ruvnet', 'implementation-policy.json');
    const j = tryRead(p);
    if (j) return { policy: j, from: p };
  }
  return { policy: null, from: null };
}

// ── The write, read out of the payload ──────────────────────────────────────────────────────────

/** Everything this tool call would ADD to the file. Write/Edit/MultiEdit, all shapes. */
function addedText(ev) {
  const ti = (ev && ev.tool_input) || {};
  const parts = [];
  if (typeof ti.content === 'string') parts.push(ti.content);
  if (typeof ti.new_string === 'string') parts.push(ti.new_string);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e && typeof e.new_string === 'string') parts.push(e.new_string);
  return parts.join('\n');
}

/**
 * Strip comments before any detector looks at the text.
 *
 * This is not tidiness — it is the single biggest false-positive class the ADR's known-good corpus
 * names: "comments discussing esm.sh" must pass (§8). A line that says
 * `// do NOT do: import x from "https://esm.sh/@ruvector/rvf-wasm"` is a warning ABOUT the bug, and
 * a wall that refuses it teaches people to stop writing warnings. Deterministic and conservative:
 * `//` only when not preceded by `:` (spares `https://`), plus block comments, plus `#` at line
 * start for shell/python.
 */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/^[ \t]*#[^\n]*$/gm, '');
}

/** Executable remote origins the write INTRODUCES. Only import/require/script-src/importScripts. */
function executableRemoteRefs(code) {
  const refs = [];
  const push = (url, how) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return;
    const host = (/^https?:\/\/([^/]+)/i.exec(u) || [])[1];
    if (!host) return;
    refs.push({ url: u, host: host.toLowerCase(), pkg: packageFromUrl(u), how });
  };
  for (const m of code.matchAll(/\b(?:import|export)\b[^;'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]/g)) push(m[1], 'import');
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) push(m[1], 'dynamic import');
  for (const m of code.matchAll(/\bimport\s*['"]([^'"\n]+)['"]/g)) push(m[1], 'import');
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) push(m[1], 'require');
  for (const m of code.matchAll(/\bimportScripts\s*\(\s*['"]([^'"\n]+)['"]/g)) push(m[1], 'importScripts');
  for (const m of code.matchAll(/<script[^>]*\ssrc\s*=\s*['"]([^'"\n]+)['"]/gi)) push(m[1], 'script src');
  return refs;
}

/** Bare packages the write imports or installs. */
function writtenPackages(code) {
  const out = new Map();
  const add = (name, how) => { if (name && !out.has(name)) out.set(name, { name, how }); };
  for (const m of code.matchAll(/\b(?:import|export)\b[^;'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]/g)) add(specToPackage(m[1]), 'import');
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) add(specToPackage(m[1]), 'require');
  for (const m of code.matchAll(/\bimport\s*['"]([^'"\n]+)['"]/g)) add(specToPackage(m[1]), 'import');
  for (const m of code.matchAll(/(?:npm\s+(?:install|i|add)|pnpm\s+(?:install|i|add)|yarn\s+add|bun\s+add)(?:\s+-{1,2}[\w-]+)*\s+((?:@[\w.-]+\/)?[\w.][\w.-]*)/g)) add(m[1], 'install');
  return [...out.values()];
}

/** Symbols the write DEFINES (the hand-roll shape D3 looks for). */
function definedSymbols(code) {
  const out = new Set();
  const res = [
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|class\b)/g,
  ];
  for (const re of res) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Symbols the write IMPORTS by name — proof it is USING the stamped API rather than re-writing it. */
function importedSymbols(code) {
  const out = new Set();
  for (const m of code.matchAll(/\bimport\s+([^;'"\n]*?)\bfrom\s*['"][^'"\n]+['"]/g)) {
    const braced = /\{([^}]*)\}/.exec(m[1]);
    if (braced) for (const raw of braced[1].split(',')) {
      const nm = raw.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) out.add(nm);
    }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(/g)) {
    for (const raw of m[1].split(',')) {
      const nm = raw.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) out.add(nm);
    }
  }
  return out;
}

/**
 * Package basenames too generic to carry an owner claim. D2 asks "same thing, different owner?" —
 * a basename of `wasm`, `core` or `client` means the question cannot be answered from the name, so
 * D2 declines rather than guesses. Every entry here shrinks the detector; none of them grows it.
 */
const GENERIC_BASENAMES = new Set([
  'wasm', 'core', 'cli', 'sdk', 'api', 'db', 'utils', 'util', 'common', 'client', 'server', 'node',
  'js', 'ts', 'lib', 'types', 'index', 'main', 'app', 'web', 'browser', 'runtime', 'plugin', 'tools',
  'memory', 'hooks', 'test', 'tests', 'config', 'shared', 'data', 'src', 'bin', 'dist', 'pkg',
]);

/**
 * Identifiers too ordinary to prove a hand-roll. D3's claim is "you re-implemented THAT api";
 * `init`, `search` or `create` cannot support it. Names must also be ≥5 chars for the same reason.
 */
const GENERIC_SYMBOLS = new Set([
  'init', 'main', 'run', 'start', 'stop', 'get', 'set', 'add', 'remove', 'delete', 'update', 'query',
  'search', 'create', 'close', 'open', 'read', 'write', 'load', 'save', 'send', 'parse', 'format',
  'connect', 'insert', 'index', 'build', 'render', 'store', 'fetch', 'clear', 'reset', 'log',
  'config', 'options', 'result', 'value', 'error', 'handler', 'callback', 'client', 'server',
]);

// ── Detectors ───────────────────────────────────────────────────────────────────────────────────

const DISABLED = new Set(
  String(process.env.RUVNET_GROUNDING_DISABLE || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
);
/**
 * THE MUTATION SEAM (ADR-055 §8: "break each detector independently; every mutant killed or no
 * release"). It is deliberately LOUD: a silent way to switch a wall off is a bypass, an announced
 * one is a declared capability. tests/unit/fourth-wall.test.mjs T3 uses it to prove each detector
 * is load-bearing — a detector whose removal changes nothing was never protecting anything.
 */
function enabled(id) {
  if (!DISABLED.has(id)) return true;
  process.stderr.write(`[grounding-substance] DETECTOR DISABLED: ${id} (RUVNET_GROUNDING_DISABLE test seam)\n`);
  return false;
}

/**
 * D1 GROUNDING-NET — a remote origin for a capability the stamped source ships LOCALLY.
 *
 * Fires only when ALL of these hold, which is what keeps it off the known-good corpus:
 *   a) the write executes code from a remote URL (import / require / script src / importScripts),
 *   b) that URL NAMES a package,
 *   c) a stamped source ships that same package with a LOCAL install command, and
 *   d) NO stamped source that ships it carries the host being used.
 * Drop (d) and you get the "any CDN is bad" rule ADR-055 §3.7.4 forbids and F22 disproves.
 *
 * ── WHY (d) IS EVALUATED ACROSS ALL SOURCES AND NOT PER SOURCE ──────────────────────────────────
 * The first version tested (d) inside the source loop and `continue`d on a permitting source. That
 * is a latent false positive with a completely ordinary trigger: two stamped documents for one
 * package — say the README that documents the CDN and the example that only shows the local
 * install. Whichever one the loop reached second would fire, so the refusal depended on ledger
 * ORDER rather than on evidence. Permission is a property of the held evidence as a whole: if any
 * stamped source that ships this package carries this origin, the origin is source-supported.
 */
function detectD1({ refs, receipts, policy }) {
  if (!enabled('D1')) return [];
  const bundledOnly = policy?.network?.runtimeOrigins === 'bundled-only';
  for (const ref of refs) {
    if (!ref.pkg) continue;
    // Every stamped source that ships this package, gathered before any verdict is formed.
    const shippers = [];
    for (const r of receipts) {
      for (const s of r.sources) {
        const local = s.packages.find((p) => p.name === ref.pkg)
          || s.packages.find((p) => pkgBase(p.name) === pkgBase(ref.pkg) && !GENERIC_BASENAMES.has(pkgBase(p.name).toLowerCase()));
        if (local) shippers.push({ r, s, local });
      }
    }
    if (!shippers.length) continue;                       // nothing stamped ships it ⇒ nothing to contradict
    const permitting = shippers.find(({ s }) => (s.origins || []).includes(ref.host));
    if (permitting && !bundledOnly) continue;             // the evidence itself offers this origin
    // The clearest single finding: prefer the source that names the host when the objection is the
    // user's policy, so the refusal quotes the document the user is actually overriding.
    const { r, s, local } = permitting || shippers[0];
    return [{
      id: permitting ? 'D4' : 'D1',
      name: permitting ? 'GROUNDING-POLICY' : 'GROUNDING-NET',
      headline: permitting
        ? `remote origin ${ref.host} is source-supported but this project's policy requires bundled delivery`
        : `${ref.how} of ${ref.pkg} from ${ref.host} — the stamped source ships it locally`,
      receipt: r.id,
      source: `${s.repo}/${s.path}`,
      install: local.install,
      pkg: local.name,
      posture: s.posture || [],
      origins: s.origins || [],
      offending: ref.url,
      fix: `${local.install}\n    then import it by name:  import … from '${local.name}'`,
    }];   // one refusal, the clearest one — a wall that lists twelve findings is noise
  }
  return [];
}

/**
 * D2 GROUNDING-PKG — package substitution: the same thing, a different owner.
 *
 * The failure this replays is the wrong-crate class (bare `rvf` vs `rvf-runtime`; a hand-named
 * "MetaHarness router" vs `@metaharness/router`). Deterministic form: the write pulls in a package
 * whose BASENAME matches a stamped package's basename while the full name differs. Generic
 * basenames are excluded outright, and a user policy may name denied packages outright.
 */
function detectD2({ pkgs, receipts, policy }) {
  if (!enabled('D2')) return [];
  const denied = new Set((policy?.deniedPackages || []).map(String));
  for (const w of pkgs) {
    if (denied.has(w.name)) {
      return [{
        id: 'D4', name: 'GROUNDING-POLICY', headline: `${w.name} is denied by this project's implementation policy`,
        receipt: null, source: null, install: null, pkg: w.name, posture: [], origins: [], offending: w.name,
        fix: `remove the ${w.how} of ${w.name}, or change .ruvnet/implementation-policy.json yourself`,
      }];
    }
    const base = pkgBase(w.name).toLowerCase();
    if (base.length < 4 || GENERIC_BASENAMES.has(base)) continue;
    for (const r of receipts) {
      for (const s of r.sources) {
        const stamped = s.packages.find((p) => pkgBase(p.name).toLowerCase() === base && p.name !== w.name);
        if (!stamped) continue;
        return [{
          id: 'D2', name: 'GROUNDING-PKG',
          headline: `${w.how} of ${w.name} — the stamped source names ${stamped.name} for this`,
          receipt: r.id, source: `${s.repo}/${s.path}`, install: stamped.install, pkg: stamped.name,
          posture: s.posture || [], origins: s.origins || [], offending: w.name,
          fix: `${stamped.install}\n    then use '${stamped.name}', not '${w.name}'`,
        }];
      }
    }
  }
  return [];
}

/**
 * D3 GROUNDING-API — hand-rolling an API the stamped source ships, and the explicit-negative case.
 *
 * D3a (hand-roll): the write DEFINES a distinctive symbol that a stamped source EXPORTS, does not
 *   import that symbol from anywhere, and names the stamped package in its own text. All four
 *   conditions are required; each one alone is ordinary code.
 * D3b (explicit negative): the source SAYS "does not export X" and the write uses X on the stamped
 *   package. ADR-055 §3.3, adopted verbatim: absence from retrieval is ADVISORY ONLY and never
 *   reaches this function — only a fact the source states may block.
 */
function detectD3({ code, prose, receipts }) {
  if (!enabled('D3')) return [];
  const defined = definedSymbols(code);
  const imported = importedSymbols(code);
  // `prose` is the added text WITH comments; `code` is without. The domain link is read from prose
  // on purpose — a hand-roll characteristically does NOT import the package (that is the whole
  // failure), so the only place it names it is a comment: "a local reimplementation of X". The
  // symbol test stays on `code`, so a comment can never by itself define or import anything.
  for (const r of receipts) {
    for (const s of r.sources) {
      // D3b — explicit negative facts.
      for (const neg of (s.negatives || [])) {
        const sym = neg.symbol;
        if (!sym || sym.length < 4) continue;
        const used = new RegExp(String.raw`\.\s*${sym}\s*\(`).test(code) || new RegExp(String.raw`\b${sym}\s*\(`).test(code);
        const namesPkg = s.packages.some((p) => prose.includes(p.name));
        if (used && namesPkg) {
          return [{
            id: 'D3', name: 'GROUNDING-API', headline: `${sym}() — the stamped source states it does not exist`,
            receipt: r.id, source: `${s.repo}/${s.path}`, install: s.packages[0]?.install || null,
            pkg: s.packages[0]?.name || null, posture: [neg.quote], origins: s.origins || [], offending: sym,
            fix: `remove the call to ${sym}; the source says: "${neg.quote}"`,
          }];
        }
      }
      // D3a — the hand-roll.
      if (!s.packages.length) continue;
      const namedPkg = s.packages.find((p) => prose.includes(p.name));
      if (!namedPkg) continue;
      for (const sym of defined) {
        if (sym.length < 5 || GENERIC_SYMBOLS.has(sym.toLowerCase())) continue;
        if (imported.has(sym)) continue;
        const exported = (s.symbols || []).find((x) => x.name === sym);
        if (!exported) continue;
        return [{
          id: 'D3', name: 'GROUNDING-API',
          headline: `you are defining ${sym}, which ${namedPkg.name} already exports`,
          receipt: r.id, source: `${s.repo}/${s.path}`, install: namedPkg.install, pkg: namedPkg.name,
          posture: s.posture || [], origins: s.origins || [], offending: sym,
          fix: `${namedPkg.install}\n    then import it:  import { ${sym} } from '${namedPkg.name}'`,
        }];
      }
    }
  }
  return [];
}

// ── Override (ADR-055 §3.5) ─────────────────────────────────────────────────────────────────────

/**
 * IN-BAND, because an env var cannot be set on a Write call.
 *
 * That is not a style preference — it is a defect this repo has already shipped twice and paid for:
 * verify-interface.sh advertised `RUVNET_SKIP_INTERFACE_CHECK=1` while reading it from the HOOK's
 * own environment (issue #12 defect 2), and design-wall.sh reintroduced the same shape. A PreToolUse
 * hook is spawned BEFORE the tool runs, so the only channel the caller controls is the payload.
 *
 *     RUVNET_GROUNDING_OVERRIDE: <a real reason, at least 12 characters>
 *
 * Scoped by construction: the token lives inside one specific write, so it is one-use and cannot
 * leak into the next call the way an exported variable does. Every mint is receipted for later
 * adjudication (§4), which is what distinguishes "recorded disagreement" from "wall switched off".
 */
const OVERRIDE_RE = /RUVNET_GROUNDING_OVERRIDE\s*[:=]\s*(.+)/;
/**
 * Read from the DECODED write text, never the raw payload. Scanning the raw JSON looked like it
 * worked and quietly appended the payload's own closing `"}}`  to every recorded reason — an
 * adjudication ledger full of corrupted reasons is worse than none, because it reads as data.
 */
function overrideFrom(added) {
  const m = OVERRIDE_RE.exec(String(added || ''));
  if (!m) return null;
  const reason = m[1].replace(/\*\/\s*$/, '').replace(/["'`,;]+\s*$/, '').trim();
  if (reason.length < 12) return { reason, valid: false };
  return { reason: reason.slice(0, 300), valid: true };
}

function writeOverrideReceipt(entry) {
  try {
    const f = overrideLedger();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify(entry)}\n`);
  } catch { /* a receipt that cannot be written must not turn an allow into a block */ }
}

function gateReceipt(subject, reason) {
  try {
    const script = path.join(HERE, 'gate-receipt.sh');
    if (!fs.existsSync(script)) return;
    spawnSync('bash', [script, 'grounding-substance', subject, reason], { stdio: 'ignore', timeout: 3000 });
  } catch { /* never */ }
}

// ── The refusal ─────────────────────────────────────────────────────────────────────────────────

function refusal(f, filePath) {
  const words = (f.posture || []).slice(0, 2).map((p) => `  "${p}"`).join('\n');
  // `null` drops a line; `''` keeps a deliberate blank one. (Filtering on `''` collapsed every
  // paragraph break the first time this ran — the refusal is read by a model under pressure, so
  // its shape is part of whether it works.)
  return [
    `⛔ BLOCKED — ${f.name} (${f.id}): this write contradicts what the brain showed you.`,
    '',
    `  ${f.headline}`,
    '',
    'THE SOURCE THE BRAIN RETURNED:',
    f.source ? `  ${f.source}` : '  (project policy — .ruvnet/implementation-policy.json)',
    f.install ? `  ${f.install}` : null,
    words ? `\nIN THE SOURCE'S OWN WORDS:\n${words}` : null,
    f.origins && f.origins.length ? `\nORIGINS THAT SOURCE ITSELF CARRIES: ${f.origins.slice(0, 6).join(', ')}` : null,
    '',
    'YOUR WRITE INTRODUCES:',
    `  ${f.offending}${filePath ? `   (in ${filePath})` : ''}`,
    '',
    'DO THIS INSTEAD:',
    `    ${f.fix}`,
    '',
    'This is the founding failure of this product, made mechanical (issue #46, ADR-055 §3): the model',
    'searched, received the right answer, and wrote its opposite with every gate green — because the',
    'stamp recorded that a search RAN, never what it RETURNED. It records both now.',
    '',
    'If you genuinely mean it, say why IN THE WRITE ITSELF (a receipt is recorded and adjudicated):',
    '    RUVNET_GROUNDING_OVERRIDE: <your reason, at least 12 characters>',
    f.receipt ? `\n[receipt ${f.receipt}]` : null,
  ].filter((l) => l !== null).join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { return 0; }
  if (!raw.trim()) return 0;

  const ev = parseHookEvent(raw);
  if (!ev) return 0;                                        // malfunction is not a decision
  const tool = toolName(ev);
  if (!/^(Write|Edit|MultiEdit)$/.test(tool)) return 0;   // toolName() is canonical: Grok's write arrives as Write

  const filePath = typeof ev.tool_input?.file_path === 'string' ? ev.tool_input.file_path : '';
  const added = addedText(ev);
  if (!added) return 0;

  const receipts = readReceipts();
  if (!receipts.length) return 0;                           // NEVER block on absence of evidence

  const { policy } = readPolicy(filePath);
  const code = stripComments(added);
  const refs = executableRemoteRefs(code);
  const pkgs = writtenPackages(code);

  const findings = [
    ...detectD1({ refs, receipts, policy }),
    ...detectD2({ pkgs, receipts, policy }),
    ...detectD3({ code, prose: added, receipts }),
  ];
  if (!findings.length) return 0;
  const f = findings[0];

  const ovr = overrideFrom(added);
  if (ovr && ovr.valid) {
    writeOverrideReceipt({
      at: new Date().toISOString(), detector: f.id, receipt: f.receipt || null,
      file: filePath, offending: f.offending, diffHash: sha12(added), reason: ovr.reason,
      adjudication: 'unadjudicated',
    });
    gateReceipt(`override:${f.id}`, `overridden in-band: ${ovr.reason}`.slice(0, 150));
    // Loud on purpose (§3.5: overrides are loud). exit 0 — the write proceeds, on the record.
    process.stderr.write(
      `[grounding-substance] OVERRIDE ACCEPTED for ${f.id} (${f.offending}) — reason: ${ovr.reason}\n`
      + `[grounding-substance] receipt written to ${overrideLedger()} for adjudication.\n`,
    );
    return 0;
  }

  gateReceipt(f.offending, `${f.id} ${f.name}: ${f.headline}`.slice(0, 150));
  process.stderr.write(`${refusal(f, filePath)}\n`);
  if (ovr && !ovr.valid) {
    process.stderr.write('\n[grounding-substance] an override token was present but its reason was too short (<12 chars) — not accepted.\n');
  }
  return 2;
}

// Rule 3, at the outermost boundary: nothing this file can throw may become a refusal.
//
// Guarded on being the ENTRYPOINT so the pure helpers above can be imported by the parity test
// without this file reading stdin and exiting the test runner — the same shape hook-input.mjs uses.
// stdin here is a pipe bash has already drained and re-fed (`printf '%s' "$INPUT" | node …`), so the
// held-open-stdin hole ADR-055 F20 found in unprompted-runtime.mjs cannot occur on this path: there
// is no interactive terminal on the other end, ever.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let code = 0;
  try { code = main(); } catch (e) {
    try { process.stderr.write(`[grounding-substance] degraded (${e && e.message}) — write permitted\n`); } catch { /* never */ }
    code = 0;
  }
  process.exit(code);
}
