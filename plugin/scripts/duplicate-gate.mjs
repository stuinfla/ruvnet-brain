#!/usr/bin/env node
/**
 * duplicate-gate.mjs — "is this the simplest code that works, without duplicating what already exists?"
 *
 * THE OWNER, 2026-09-30: "whenever you're writing code, is it the simplest version of the code that
 * works, that doesn't create duplicates or replication across the project? That's become a major
 * issue and it's happening again right now." The record: a hand-rolled census restamper written
 * while scripts/sync-census.mjs shipped, a second model router (ADR-0015's deleted router-optimizer),
 * duplicate routing ADRs, overlapping hooks. Prose rules against this failed; ADR-030 measured why.
 *
 * A POLICY OF decision-gate.mjs, NOT A HOOK. It speaks the policy contract (exit 0 allow, exit 2 +
 * stderr refuse) and is composed by the ONE PreToolUse refuser (ADR-067) on both hosts — no new
 * registration. Deterministic, local, no model: it scores the new code against an index of the
 * repo's code on four cheap signals (TF-IDF over header comments and body identifiers, IDF-weighted
 * shared distinctive literals/CLI flags, file-stem and exported-name overlap).
 *
 * WHEN IT LOOKS: a NEW code file under scripts/, kb/, plugin/scripts/, tests/ or bin/, or an
 * edit that adds a NEW exported function/class of >= MIN_EXPORT_LINES lines. Never an ordinary edit,
 * docs, lockfiles, fixtures, generated files, or tests/unit/<stem>.test.* mirroring a <stem> module.
 *
 * AT MOST ONE REFUSAL PER PATH PER SESSION. The second attempt is allowed and recorded as an
 * acknowledgement — the gate can interrupt once, it can never loop. A header line
 * `// DISTINCT-FROM: <existing path> — <reason>` (or `#` for sh/py) allows on the first attempt.
 *
 * SCOPE: active in the RuvNet Brain checkout (a repo containing plugin/scripts/decision-gate.mjs),
 * where its threshold was tuned on real history (scripts/duplicate-gate-replay.mjs). Elsewhere only
 * when RUVNET_DUPLICATE_GATE=on; RUVNET_DUPLICATE_GATE=off disables it everywhere.
 *
 * FAIL OPEN on every error, including a blown time budget. The index is cached under the repo's git
 * common dir (never ~/.cache/ruvnet-brain), keyed by HEAD and each file's mtime+size.
 *
 * OVERLOAD MUST NOT SWITCH IT OFF SILENTLY (2026-09-30). Measured at load average ~450 on 16 cores:
 * the fixed 1300ms index budget ran out on every write, the gate threw 'index budget exhausted' and
 * exited 0 — an allow indistinguishable from "no duplicate found", i.e. the gate was off and nothing
 * said so. Now: (1) the budget scales with the measured 1-minute load per CPU (x1..x4) and never
 * outruns decision-gate's own deadline (RUVNET_DECISION_DEADLINE); (2) past the budget, a file whose
 * cached features are merely STALE keeps them instead of being dropped, so a warm index still judges
 * under overload; (3) progress is always saved, so a cold index warms across writes; (4) only a file
 * with NO usable features left unindexed makes it skip — and a skip exits SKIPPED (3) with one line
 * `duplicate gate skipped: <reason>` that decision-gate records in the outcome ledger and prints.
 * Still never a refusal on error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCOPE = ['scripts/', 'kb/', 'plugin/scripts/', 'tests/', 'bin/'];
export const THRESHOLD = 0.5;
export const MIN_EXPORT_LINES = 15;
export const MIN_COPIED_LINES = 10;
export const MIN_COPIED_SHARE = 0.1;
const MAX_LINE_DF = 3;
const MIN_CODE_LINES = 8;
export const WEIGHTS = { hdr: 0.3, body: 0.35, lit: 0.2, name: 0.15 };
const CODE = /\.(mjs|cjs|js|ts|mts|sh|py)$/;
const MAX_BYTES = 400_000;
const CACHE_VERSION = 2;
const BUILD_BUDGET_MS = 1300;
/** Exit code meaning "this policy did not vote, and says why on stderr" (decision-gate records it). */
export const SKIPPED = 3;
const DEADLINE_MARGIN_MS = 250;

/**
 * The index budget for this call: the base, scaled by measured load per CPU (1..4x), clipped to what
 * decision-gate's shared deadline leaves (minus a margin for scoring and exit). Pure given its inputs.
 */
export function buildBudgetMs({ env = process.env, now = Date.now(), load = os.loadavg()[0], cpus = os.cpus().length || 1 } = {}) {
  const base = Number.isFinite(Number(env.RUVNET_DUPLICATE_GATE_BUDGET_MS)) && env.RUVNET_DUPLICATE_GATE_BUDGET_MS !== undefined
    ? Number(env.RUVNET_DUPLICATE_GATE_BUDGET_MS) : BUILD_BUDGET_MS;
  const scaled = base * Math.min(4, Math.max(1, load / cpus));
  const outer = Number(env.RUVNET_DECISION_DEADLINE);
  return Math.max(0, Math.round(Number.isFinite(outer) && outer > 0 ? Math.min(scaled, outer - now - DEADLINE_MARGIN_MS) : scaled));
}

/** Thrown when the index cannot be completed in budget; its message is the visible skip reason. */
export class IndexBudgetError extends Error {}
const ACK_TTL_MS = 24 * 3600_000;

const STOP = new Set(('the and for with that this from not are was were but its has have had can will '
  + 'into when than then there their them they what which who why how all any each one two out our '
  + 'you your only also just more most must never ever here same such over under about after before '
  + 'because does did done been being else true false null undefined const let var function return '
  + 'import export default async await new class extends typeof instanceof throw catch try finally '
  + 'while break continue switch case if elif fi then esac echo local def self none pass lambda '
  + 'node mjs js json txt www http https com org length push map filter join split slice string '
  + 'number object array value values key keys path file files dir name').split(' '));

/** Export names so common that sharing one says nothing about what a file does. */
const GENERIC = new Set(['main', 'isMain', 'run', 'parseArgs', 'usage', 'help', 'fixture', 'handler', 'check', 'REPO', 'ROOT', 'log']);

/** camelCase / snake / kebab aware word tokens, lowercased, stop words and short tokens dropped. */
const SPLIT = new Map(); // word -> its tokens; the same identifiers recur across every file
export function tokens(text) {
  const out = [];
  for (const raw of String(text).match(/[A-Za-z][A-Za-z0-9]*/g) || []) {
    let parts = SPLIT.get(raw);
    if (!parts) {
      parts = (/[A-Z]/.test(raw) ? raw.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) || [raw] : [raw])
        .map((p) => p.toLowerCase()).filter((t) => t.length >= 3 && !STOP.has(t));
      if (SPLIT.size > 100_000) SPLIT.clear();
      SPLIT.set(raw, parts);
    }
    for (const t of parts) out.push(t);
  }
  return out;
}

const tf = (list) => { const m = Object.create(null); for (const t of list) m[t] = (m[t] || 0) + 1; return m; };
const stemOf = (rel) => path.basename(rel).replace(/\.(test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '');
export const isTest = (rel) => /(^|\/)tests?\//.test(rel) || /\.(test|spec)\.[cm]?[jt]s$/.test(rel);

/** The leading comment block (after a shebang): what the author says the file IS. */
export function headerOf(text) {
  const lines = String(text).split('\n').slice(0, 120);
  const out = [];
  let i = lines[0]?.startsWith('#!') ? 1 : 0;
  for (; i < lines.length && out.length < 80; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^(\/\/|#|\/\*|\*|\*\/)/.test(t)) out.push(t.replace(/^(\/\/+|#+|\/\*+|\*+\/?|\*\/)\s?/, ''));
    else if (/^(['"]use strict['"]|set -[euo])/.test(t)) continue;
    else break;
  }
  return out.join('\n');
}

export function exportsOf(text) {
  const names = new Set();
  const s = String(text);
  for (const m of s.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k) names.add(k); }
  }
  for (const m of s.matchAll(/^(?:function\s+)?([A-Za-z_][\w]*)\s*\(\)\s*\{/gm)) names.add(m[1]); // sh
  for (const m of s.matchAll(/^def\s+([A-Za-z_]\w*)/gm)) names.add(m[1]);                          // py
  names.delete('default');
  return [...names];
}

/** Distinctive literals: quoted strings, CLI flags, regex literals. Import specifiers excluded. */
export function literalsOf(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    if (/^\s*(import\b|export\s.*\bfrom\b)|\brequire\(/.test(line)) continue;
    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n$]){8,120})\1/g)) {
      if (/[A-Za-z]{3}/.test(m[2]) && !/^(node:|\.\.?\/)/.test(m[2])) out.add(m[2]);
    }
    for (const m of line.matchAll(/(?<![\w-])--[a-z][a-z0-9-]{2,40}/g)) out.add(m[0]);
    for (const m of line.matchAll(/(?<=[=(,:!&|?]\s*)\/((?:\\.|[^/\n\\]){8,160})\/[dgimsuy]*/g)) out.add(`/${m[1]}/`);
  }
  return [...out];
}

/** Normalised code lines worth comparing (hash -> text): not imports, comments, braces or short boilerplate. */
export function codeLines(text) {
  const out = new Map();
  for (const raw of String(text).split('\n')) {
    const l = raw.trim().replace(/\s+/g, ' ');
    if (l.length < 24 || /^(import\b|export \{|\} from|\/\/|\*|\/\*|#)/.test(l)) continue;
    let h = 0x811c9dc5;
    for (let i = 0; i < l.length; i++) { h ^= l.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    if (!out.has(h.toString(36))) out.set(h.toString(36), l);
  }
  return out;
}

/** Everything the scorer needs from one file, small enough to cache. */
export function extract(rel, text) {
  const s = String(text).slice(0, MAX_BYTES);
  const exp = exportsOf(s);
  const header = headerOf(s);
  return {
    stem: [...new Set(tokens(stemOf(rel)))],
    exports: exp,
    names: [...new Set(exp.flatMap(tokens))],
    hdr: tf(tokens(header)),
    hdrLine: header.split('\n').map((l) => l.trim()).find((l) => l.length > 12)?.slice(0, 140) || '',
    body: tf(tokens(s)),
    lits: literalsOf(s),
    lines: [...codeLines(s).keys()],
  };
}

/** Document frequencies + norms for one index. Pure; the replay harness uses this same function. */
export function prepare(entries) {
  const n = entries.length || 1;
  const df = Object.create(null); const ldf = Object.create(null); const edf = Object.create(null);
  for (const e of entries) {
    for (const t of Object.keys(e.f.body)) df[t] = (df[t] || 0) + 1;
    for (const l of e.f.lits) ldf[l] = (ldf[l] || 0) + 1;
    for (const x of e.f.exports) edf[x] = (edf[x] || 0) + 1;
  }
  // Inverted index of DISTINCTIVE lines only (in <= MAX_LINE_DF files): a line many files share is an
  // idiom, not a copy.
  const lineIdx = new Map();
  entries.forEach((e, i) => { for (const h of e.f.lines || []) { const a = lineIdx.get(h); if (!a) lineIdx.set(h, [i]); else a.push(i); } });
  for (const [h, a] of lineIdx) if (a.length > MAX_LINE_DF) lineIdx.delete(h);
  const idf = (t) => Math.log((n + 1) / ((df[t] || 0) + 1)) + 1;
  const lidf = (l) => Math.log((n + 1) / ((ldf[l] || 0) + 1));
  const eidf = (x) => Math.log((n + 1) / ((edf[x] || 0) + 1));
  const norm = (m) => Math.sqrt(Object.entries(m).reduce((a, [t, c]) => a + ((1 + Math.log(c)) * idf(t)) ** 2, 0)) || 1;
  return { n, idf, lidf, eidf, norm, lineIdx, entries: entries.map((e) => ({ ...e, hn: norm(e.f.hdr), bn: norm(e.f.body) })) };
}

function cosine(a, an, b, bn, idf) {
  let dot = 0;
  const [small, big] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const t of Object.keys(small)) if (Object.hasOwn(big, t)) dot += (1 + Math.log(a[t])) * (1 + Math.log(b[t])) * idf(t) ** 2;
  return dot / (an * bn);
}

const jaccard = (a, b) => { const B = new Set(b); const i = a.filter((x) => B.has(x)).length; return i / ((a.length + b.length - i) || 1); };

/**
 * >= 1 means refuse. Two ways to cross: the four lexical signals together, or distinctive lines copied
 * verbatim — MIN_COPIED_LINES of them, or half that when at least half of the new code is copied.
 */
export function strengthOf({ score, copied, copyShare }, { threshold = THRESHOLD, minCopied = MIN_COPIED_LINES } = {}) {
  const need = copyShare >= 0.5 ? minCopied / 2 : minCopied;
  return Math.max(score / threshold, copyShare >= MIN_COPIED_SHARE ? copied.length / need : 0);
}

/** Score a candidate against every entry; the top `limit`, best first, each with its evidence. */
export function rank(model, cand, { self = '', limit = 3, testsOnly = null } = {}) {
  const hn = model.norm(cand.hdr); const bn = model.norm(cand.body);
  const candLitW = cand.lits.reduce((a, l) => a + model.lidf(l), 0) || 1;
  const copiedBy = new Map();
  for (const h of cand.lines || []) for (const i of model.lineIdx.get(h) || []) copiedBy.set(i, [...(copiedBy.get(i) || []), h]);
  const candLines = (cand.lines || []).length || 1;
  const out = [];
  for (const [i, e] of model.entries.entries()) {
    if (e.path === self) continue;
    if (testsOnly !== null && isTest(e.path) !== testsOnly) continue;
    const f = e.f;
    const hdr = Object.keys(cand.hdr).length >= 4 && Object.keys(f.hdr).length >= 4 ? cosine(cand.hdr, hn, f.hdr, e.hn, model.idf) : 0;
    const body = cosine(cand.body, bn, f.body, e.bn, model.idf);
    const L = new Set(f.lits);
    const sharedLits = cand.lits.filter((l) => L.has(l));
    const lit = Math.min(1, sharedLits.reduce((a, l) => a + model.lidf(l), 0) / Math.max(candLitW, 12));
    const E = new Set(f.exports);
    const sharedExports = cand.exports.filter((x) => E.has(x) && !GENERIC.has(x) && model.eidf(x) > 3);
    const name = Math.max(jaccard(cand.stem, f.stem), jaccard(cand.names, f.names), sharedExports.length ? 0.6 : 0);
    const score = WEIGHTS.hdr * hdr + WEIGHTS.body * body + WEIGHTS.lit * lit + WEIGHTS.name * name;
    const copied = copiedBy.get(i) || [];
    const m = { path: e.path, score, copied, copyShare: copied.length / candLines };
    out.push({ ...m, strength: strengthOf(m), parts: { hdr, body, lit, name }, sharedExports, sharedLits: sharedLits.slice(0, 3), hdrLine: f.hdrLine });
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, limit);
}

/**
 * PRECISION CUT 1 (2026-09-30 replay, 300 commits): a match with the SAME file name in another
 * directory is a relocation (scripts/x.mjs -> plugin/scripts/x.mjs leaving a re-export shim), not a
 * second implementation — 11 of 39 replayed refusals, every one of which ended as a move.
 */
export const isRelocation = (rel, matchPath) => path.posix.basename(rel) !== '' && path.posix.basename(rel) === path.posix.basename(matchPath) && rel !== matchPath;

/**
 * PRECISION CUT 2: a TEST (or test helper) that repeats another test's setup is logged as a SHADOW
 * would-block, never refused — 19 of 39 replayed refusals were copied test scaffolding.
 */
function logShadow(stateDir, row) {
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(path.join(stateDir, 'shadow.jsonl'), `${JSON.stringify(row)}\n`); } catch { /* shadow is measurement only */ }
}

/** `// DISTINCT-FROM: <path> — <reason>` naming an existing path, in the first 40 lines. */
export function distinctFrom(text, exists) {
  for (const line of String(text).split('\n').slice(0, 40)) {
    const m = /^\s*(?:\/\/+|#+|\*|\/\*+)\s*DISTINCT-FROM:\s*(\S+)\s+(?:—|–|--|-)\s*(\S.{3,})$/.exec(line);
    if (m && exists(m[1])) return { path: m[1], reason: m[2].trim() };
  }
  return null;
}

/** Why this candidate is not the gate's business, or null. Pure. */
export function exemption(rel, text, stems) {
  if (!SCOPE.some((d) => rel.startsWith(d))) return 'out-of-scope';
  if (!CODE.test(rel)) return 'not-code';
  if (/(^|\/)(__)?fixtures?(__)?\//.test(rel) || rel.includes('node_modules/')) return 'fixture';
  if (/@generated|DO NOT EDIT|auto-?generated/i.test(String(text).split('\n').slice(0, 6).join('\n'))) return 'generated';
  if (isTest(rel) && stems.has(stemOf(rel))) return 'test-mirror';
  // A re-export shim or a stub has nothing to duplicate; measured: 4-line shims matched each other.
  if (String(text).split('\n').filter((l) => l.trim() && !/^\s*(\/\/|#|\*|\/\*)/.test(l)).length < MIN_CODE_LINES) return 'too-small';
  return null;
}

/** New exported declarations of >= MIN_EXPORT_LINES lines in `next` whose names `prev` lacks. */
export function largeNewExports(next, prev = '') {
  const known = new Set(exportsOf(prev));
  const lines = String(next).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s*|class\s+|const\s+)([A-Za-z_$][\w$]*)/.exec(lines[i]);
    if (!m || known.has(m[1])) continue;
    let j = i;
    if (!/;\s*$/.test(lines[i])) { j = i + 1; while (j < lines.length && !/^[}\]]/.test(lines[j])) j++; }
    if (j - i + 1 < MIN_EXPORT_LINES) continue;
    let k = i; while (k > 0 && /^\s*(\/\*\*|\*|\/\/)/.test(lines[k - 1])) k--;
    out.push({ name: m[1], text: lines.slice(k, j + 1).join('\n') });
    i = j;
  }
  return out;
}

// ── Repository side: git, index cache, session acknowledgements ─────────────────────────────────

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 1500 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

/**
 * The repo holding `absFile`, and the file's path with symlinks resolved. git reports the REAL
 * toplevel (/private/var/... on macOS, where /var is a symlink), so comparing it with an unresolved
 * payload path made every file look outside the repo — caught by this gate's own tests.
 */
export function repoOf(absFile) {
  let dir = path.dirname(absFile);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const real = path.join(fs.realpathSync(dir), path.relative(dir, absFile));
  const [top, common] = git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']).trim().split('\n');
  return { root: fs.realpathSync(top), gitDir: path.resolve(dir, common), real };
}

/** Tracked + untracked-not-ignored code files: a file written earlier this session counts too. */
export function listCode(root) {
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter((p) => p && CODE.test(p) && !p.includes('node_modules/') && !/(^|\/)(__)?fixtures?(__)?\//.test(p));
}

/** Load the index, re-extracting only files whose mtime/size moved. Throws past `deadline`. */
export function loadIndex(root, stateDir, { deadline = Date.now() + BUILD_BUDGET_MS, files = listCode(root) } = {}) {
  const cacheFile = path.join(stateDir, 'index.json');
  let head = '';
  try { head = git(root, ['rev-parse', 'HEAD']).trim(); } catch { /* unborn branch */ }
  let cache = {};
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.v === CACHE_VERSION) cache = c.entries || {}; } catch { /* cold */ }
  const entries = []; const next = {}; let dirty = false; let blown = false; let missing = 0; let stale = 0;
  const started = Date.now();
  for (const rel of files) {
    let st; try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const hit = cache[rel];
    if (hit && hit.m === st.mtimeMs && hit.s === st.size) { next[rel] = hit; entries.push({ path: rel, f: hit.f }); continue; }
    if (blown || Date.now() > deadline) {
      // Out of budget: a STALE entry is still this file's features as of its last index — far better
      // evidence than none. It stays marked stale (old m/s), so a later call with budget refreshes it.
      blown = true;
      if (hit) { next[rel] = hit; entries.push({ path: rel, f: hit.f }); stale += 1; } else missing += 1;
      continue;
    }
    const f = extract(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    next[rel] = { m: st.mtimeMs, s: st.size, f }; entries.push({ path: rel, f }); dirty = true;
  }
  if (dirty || Object.keys(cache).length !== Object.keys(next).length) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, head, entries: next }));
      fs.renameSync(tmp, cacheFile);
    } catch { /* a cache is an optimisation */ }
  }
  if (missing) {
    throw new IndexBudgetError(`index budget exhausted after ${Date.now() - started}ms (budget ${Math.max(0, deadline - started)}ms, `
      + `load ${os.loadavg()[0].toFixed(0)} on ${os.cpus().length} CPUs): ${missing} of ${missing + entries.length} files unindexed; `
      + 'progress is cached and the next write resumes');
  }
  return entries;
}

function readAcks(stateDir) { try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'acks.json'), 'utf8')); } catch { return {}; } }
function writeAcks(stateDir, acks, now) {
  try {
    for (const [k, v] of Object.entries(acks)) if (now - (v.ts || 0) > ACK_TTL_MS) delete acks[k];
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'acks.json'), JSON.stringify(acks, null, 1));
  } catch { /* best effort */ }
}

/** The candidate text this call adds, and whether it is a new file. null = nothing to judge. */
export function candidateOf(input, abs, rel) {
  const exists = fs.existsSync(abs);
  const current = exists ? fs.readFileSync(abs, 'utf8') : '';
  const patch = typeof input.new_string === 'string' && /^\*\*\* (Add|Update) File: /m.test(input.new_string) ? input.new_string : null;
  if (patch) { // Codex apply_patch, normalised by codex-hook-adapter.mjs: the '+' lines of this file's section
    const secs = patch.split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m);
    const sec = secs.find((s) => { const h = /^\*\*\* (Add|Update) File: (.+)$/m.exec(s); return h && path.normalize(h[2].trim()).endsWith(path.normalize(rel)); });
    if (!sec) return null;
    const added = sec.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
    if (/^\*\*\* Add File/.test(sec) && !exists) return { isNew: true, text: added };
    const big = largeNewExports(added, current);
    return big.length ? { isNew: false, text: big.map((b) => b.text).join('\n\n'), names: big.map((b) => b.name), header: current } : null;
  }
  if (typeof input.content === 'string') {
    if (!exists) return { isNew: true, text: input.content };
    const big = largeNewExports(input.content, current);
    return big.length ? { isNew: false, text: big.map((b) => b.text).join('\n\n'), names: big.map((b) => b.name), header: input.content } : null;
  }
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const added = edits.map((e) => (typeof e?.new_string === 'string' ? e.new_string : '')).join('\n');
  const before = `${current}\n${edits.map((e) => e?.old_string || '').join('\n')}`;
  const big = largeNewExports(added, before);
  return big.length ? { isNew: false, text: big.map((b) => b.text).join('\n\n'), names: big.map((b) => b.name), header: current } : null;
}

export function refusalText(rel, matches, what) {
  const rows = matches.map((m, i) => {
    const ev = [
      m.sharedExports.length ? `exports ${m.sharedExports.slice(0, 4).join(', ')}` : '',
      m.hdrLine ? `"${m.hdrLine}"` : '',
      m.sharedLits.length ? `shares ${m.sharedLits.map((l) => JSON.stringify(l.slice(0, 40))).join(', ')}` : '',
      m.copied.length ? `${m.copied.length} distinctive line(s) identical, e.g. ${(m.copiedText || []).map((l) => JSON.stringify(l.slice(0, 70))).join(' ')}` : '',
    ].filter(Boolean).join('\n        ');
    return `  ${i + 1}. ${m.path}  (similarity ${m.score.toFixed(2)}, copied lines ${m.copied.length})\n        ${ev}`;
  }).join('\n');
  return `⛔ BLOCKED (once) — ${what} ${rel} looks like code this repo already has.

${rows}

Reuse or extend one of these, or state in the file header why it must be separate:

  // DISTINCT-FROM: <path> — <reason>        (# for .sh/.py)

The write is allowed when that header line names an existing path and a reason. MOVING or
EXTRACTING code out of one of these files? Retry, then remove it from the original in the same change.
This path is refused at most once per session: retrying is allowed and recorded as your decision.
Owner, 2026-09-30: "is it the simplest version of the code that works, that doesn't create
duplicates or replication across the project?"`;
}

/**
 * The whole policy, as a function of one hook payload. Returns { allow, reason?, why }.
 * Every thrown error becomes an allow at the caller.
 */
export function evaluate(payload, { env = process.env, now = Date.now(), deadline = now + buildBudgetMs({ env, now }) } = {}) {
  const mode = String(env.RUVNET_DUPLICATE_GATE || '').toLowerCase();
  if (mode === 'off' || env.RUVNET_SKIP_DUPLICATE_CHECK === '1') return { allow: true, why: 'disabled' };
  const input = payload?.tool_input || {};
  const file = input.file_path || input.path || input.notebook_path || '';
  if (!file || /\.ipynb$/.test(file)) return { allow: true, why: 'no-file' };
  const base = String(payload.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
  const { root, gitDir, real: abs } = repoOf(path.resolve(base, file));
  if (mode !== 'on' && !fs.existsSync(path.join(root, 'plugin', 'scripts', 'decision-gate.mjs'))) return { allow: true, why: 'not-this-repo' };
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return { allow: true, why: 'outside-repo' };
  if (!SCOPE.some((d) => rel.startsWith(d)) || !CODE.test(rel)) return { allow: true, why: 'out-of-scope' };

  const cand = candidateOf(input, abs, rel);
  if (!cand) return { allow: true, why: 'no-new-code' };
  const files = listCode(root);
  const exists = (p) => fs.existsSync(path.resolve(root, p));
  const stems = new Set(files.filter((p) => !isTest(p)).map(stemOf));
  const ex = exemption(rel, cand.text, stems);
  if (ex) return { allow: true, why: ex };
  if (distinctFrom(cand.text, exists) || (cand.header && distinctFrom(cand.header, exists))) return { allow: true, why: 'distinct-from' };

  const stateDir = env.RUVNET_DUPLICATE_GATE_STATE_DIR || path.join(gitDir, 'ruvnet-duplicate-gate');
  const session = String(payload.session_id || '');
  const ackKey = `${session}\u0000${rel}`;
  const acks = readAcks(stateDir);
  if (acks[ackKey]?.state === 'refused') {
    acks[ackKey] = { ...acks[ackKey], state: 'acknowledged', ackTs: now, ts: now };
    writeAcks(stateDir, acks, now);
    return { allow: true, why: 'acknowledged' };
  }
  if (acks[ackKey]) return { allow: true, why: 'already-acknowledged' };

  const model = prepare(loadIndex(root, stateDir, { deadline, files }));
  const matches = rank(model, extract(rel, cand.text), { self: rel, testsOnly: isTest(rel) })
    .filter((m) => m.strength >= 0.6 && !isRelocation(rel, m.path));
  if (!matches.length || matches[0].strength < 1) return { allow: true, why: 'no-match', best: matches[0] };
  if (isTest(rel)) {
    logShadow(stateDir, { ts: now, session, rel, wouldBlock: true, why: 'test-scaffolding', top: matches.map((m) => [m.path, Number(m.score.toFixed(3)), m.copied.length]) });
    return { allow: true, why: 'shadow-test', matches };
  }
  const lineText = codeLines(cand.text);
  for (const m of matches) m.copiedText = m.copied.slice(0, 2).map((h) => lineText.get(h)).filter(Boolean);
  acks[ackKey] = { state: 'refused', ts: now, session, rel, top: matches.map((m) => [m.path, Number(m.score.toFixed(3))]) };
  writeAcks(stateDir, acks, now);
  const what = cand.isNew ? 'new file' : `new export ${cand.names.join(', ')} in`;
  return { allow: false, why: 'duplicate', matches, reason: refusalText(rel, matches, what) };
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  let code = 0;
  try {
    const r = evaluate(JSON.parse(fs.readFileSync(0, 'utf8') || '{}'));
    if (!r.allow) { process.stderr.write(`${r.reason}\n`); code = 2; }
  } catch (e) {
    // Fail open — but an overloaded gate says so. Anything else (not a git repo, no git on PATH, a
    // malformed payload) is "not applicable" and stays silent, as before.
    if (e instanceof IndexBudgetError) { process.stderr.write(`duplicate gate skipped: ${e.message}\n`); code = SKIPPED; } else code = 0;
  }
  process.exit(code);
}
