#!/usr/bin/env node
// scripts/claims-verify.mjs — the CLAIMS LEDGER (ADR-0011 Phase 0, last open item).
//
// Every user-facing number must be regenerable from a real artifact on disk, and CI must fail
// when one can't be. Each ledger entry is { claim, source, verify } where verify() re-derives
// the number from the artifact — NO network, NO model calls, brain-independent, so it runs on
// a bare CI runner. If a check needs the 512MB brain and the brain is absent, it SKIPs LOUDLY
// (printed with a reason) — a skip is never a silent pass.
//
// Usage:  node scripts/claims-verify.mjs        (or: npm run claims:verify)  — READ-ONLY gate
//         node scripts/claims-verify.mjs --fix  (or: npm run claims:fix)     — regenerate the surfaces
// Exit:   0 = every claim regenerated (skips allowed, printed); 1 = any claim failed.
//
// Verify functions take artifact paths as parameters (repo paths as defaults) so tests can
// point them at tampered copies. Main-guarded like scripts/eval-brain.mjs so tests can import
// the functions without running the CLI.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storeRoot } from '../kb/store-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PASS = 'PASS';
const FAIL = 'FAIL';
const SKIP = 'SKIP';

// The invariant name, spelled here rather than imported, so a broken or absent learning-replay.mjs
// degrades to ONE red row instead of taking the whole ledger down with an import error (the ledger
// has to run on a bare CI runner and report what it can). tests/unit/learning-replay.test.mjs
// asserts this literal equals the module's exported INVARIANT, so the two cannot drift silently.
const LEARNING_REPLAY = 'LEARNING-REPLAY';
const pass = (evidence) => ({ status: PASS, evidence });
const fail = (evidence) => ({ status: FAIL, evidence });
const skip = (evidence) => ({ status: SKIP, evidence });

// ── claim 1: "grounded 12/12 → n=120 baseline" ──────────────────────────────────────────────────
// evals/baseline.json is the recorded truth the eval gate promotes against. Assert the recorded
// stratum sizes (grounded k=n=100, routed n=80) plus internal consistency for EVERY metric:
// k ≤ n, p = k/n, lo ≤ p ≤ hi, all probabilities in [0,1]. No other expectations are hardcoded —
// the point is that the file is self-consistent and matches what we advertise, not that the
// scores themselves are any particular value.
export function verifyBaseline(file = path.join(ROOT, 'evals', 'baseline.json')) {
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read/parse ${file}: ${e.message}`);
  }
  if (!b.score || typeof b.score !== 'object') return fail('baseline has no score object');

  for (const [name, m] of Object.entries(b.score)) {
    if (!m || typeof m !== 'object') return fail(`metric ${name} is not an object`);
    const { k, n, p, lo, hi } = m;
    if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n <= 0)
      return fail(`metric ${name}: k/n must be non-negative integers with n>0 (k=${k}, n=${n})`);
    if (k > n) return fail(`metric ${name}: k=${k} > n=${n} — impossible count`);
    if (Math.abs(p - k / n) > 1e-9) return fail(`metric ${name}: p=${p} ≠ k/n=${k / n}`);
    // EPS absorbs float artifacts of the Wilson formula (k=n yields hi = 0.9999999999999999,
    // one ulp under p=1) without letting a real inconsistency through.
    const EPS = 1e-9;
    if (!(lo >= -EPS && hi <= 1 + EPS && lo <= p + EPS && p <= hi + EPS))
      return fail(`metric ${name}: interval broken — need 0 ≤ lo ≤ p ≤ hi ≤ 1 (lo=${lo}, p=${p}, hi=${hi})`);
  }

  const g = b.score.grounded, r = b.score.routed;
  if (!g || g.n !== 100 || g.k !== 100)
    return fail(`recorded truth drifted: expected grounded k=100/n=100, got k=${g?.k}/n=${g?.n} — if the baseline was deliberately re-recorded, update this ledger in the same commit`);
  if (!r || r.n !== 80)
    return fail(`recorded truth drifted: expected routed n=80, got n=${r?.n} — if the baseline was deliberately re-recorded, update this ledger in the same commit`);

  return pass(`grounded ${g.k}/${g.n}, routed n=${r.n}; all ${Object.keys(b.score).length} metrics satisfy k≤n and lo≤p≤hi`);
}

// ── claim 2: "held-out set is frozen at 120 questions across 5 strata" ──────────────────────────
// Recount the strata from the artifact itself. The expected census is the advertised one.
export const EXPECTED_STRATA = { named: 28, described: 32, scenario: 20, adversarial: 20, provenance: 20 };

export function verifyHeldOutStrata(file = path.join(ROOT, 'evals', 'held-out.json'), expected = EXPECTED_STRATA) {
  let setJson;
  try {
    setJson = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read/parse ${file}: ${e.message}`);
  }
  const qs = setJson.questions;
  if (!Array.isArray(qs)) return fail('held-out set has no questions array');

  const counts = {};
  for (const q of qs) counts[q.stratum] = (counts[q.stratum] || 0) + 1;

  const expectedTotal = Object.values(expected).reduce((a, b) => a + b, 0);
  const problems = [];
  for (const [stratum, want] of Object.entries(expected)) {
    if ((counts[stratum] || 0) !== want) problems.push(`${stratum}: ${counts[stratum] || 0} ≠ ${want}`);
  }
  for (const stratum of Object.keys(counts)) {
    if (!(stratum in expected)) problems.push(`unexpected stratum "${stratum}" (${counts[stratum]})`);
  }
  if (qs.length !== expectedTotal) problems.push(`total: ${qs.length} ≠ ${expectedTotal}`);
  if (problems.length) return fail(`strata census drifted: ${problems.join('; ')}`);

  return pass(`${qs.length} questions: ` + Object.entries(expected).map(([s, c]) => `${s} ${c}`).join(', '));
}

// ── claim 3: "~56× cheaper" (explainer + hook) ──────────────────────────────────────────────────
// Derived from the corpus fact recorded in the metaharness KB: a run cost $0.267
// (with the 51.33 figure alongside it). ~56× = $15 / $0.267 ≈ 56.2. We re-find both corpus
// strings with a plain streaming grep (first match wins) and re-do the arithmetic. The passages
// file ships with the 512MB brain, which CI does not have — absent file is a LOUD SKIP, never
// a silent pass. Default reads the canonical store root (kb/store-root.mjs), not <repo>/kb — that
// directory is a gitignored build workspace the installed brain never lands in (see kbDir on the
// census functions below for the same fix).
export async function verifyCheaperFactor(file = path.join(storeRoot(), 'metaharness.passages.jsonl')) {
  if (!fs.existsSync(file)) {
    return skip(`brain not installed — ${file} absent, cannot re-derive ~56× from corpus (runs on machines with the brain)`);
  }

  const needles = ['$0.267', '51.33'];
  const found = new Set();
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      for (const needle of needles) if (!found.has(needle) && line.includes(needle)) found.add(needle);
      if (found.size === needles.length) break; // first match wins; stop streaming
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const missing = needles.filter((n) => !found.has(n));
  if (missing.length) return fail(`corpus fact missing from ${path.relative(ROOT, file)}: ${missing.join(', ')} — the ~56× claim no longer regenerates`);

  const factor = 15 / 0.267;
  if (Math.abs(factor - 56.2) > 0.1) return fail(`arithmetic drifted: 15 / 0.267 = ${factor.toFixed(2)}, expected ≈ 56.2`);

  return pass(`"$0.267" and "51.33" found in corpus; 15 / 0.267 = ${factor.toFixed(1)} ≈ 56×`);
}

// ── claim 4: "coverage badge says N% of ALL source" — the % is RE-DERIVED, never string-matched ──
// (2026-07-18) The old check only asserted the literal string `coverage-10%25%20of%20ALL%20source`
// was PRESENT and that vitest set `all:true`. It never re-derived the real percentage — so the
// badge sat at "10%" while the true floor was ~14.55% and this gate reported PASS. A gate that
// cannot fail on the number it guards is not a gate; it launders a false assurance. The badge now
// advertises floor(min of the four v8 metrics) over ALL shipped source; this re-reads the real
// coverage-summary.json produced by `npm run test:cov` and fails if the badge drifts >1pt from it.
// Mirrors verifyChunkCountSurfaces (re-derive from artifact) rather than string-matching. ADR-0020.
export const BADGE_RE = /coverage-(\d+)%25%20of%20ALL%20source/;
export const BADGE_RE_G = new RegExp(BADGE_RE.source, 'g'); // the writer needs the global form

/** Extract the integer % the README coverage badge advertises, or null if the badge is gone/malformed. */
export function readBadgePct(readme) {
  const m = readme.match(BADGE_RE);
  return m ? Number(m[1]) : null;
}

// Every place the README states the coverage % IN PROSE (the badge has its own regex above). ONE
// table feeds both the checker (drift ⇒ FAIL) and the writer (--fix rewrites them), so a phrasing
// can never be guarded by one and missed by the other — which is how a badge and its own caption
// end up disagreeing.
export const COVERAGE_PROSE_RES = [
  /(\d+)% of ALL source/g,
  /(\d+)% is the honest number/g,
];

/** Every prose statement of the coverage % in the README, as { pct, text }. */
export function readCoverageClaims(readme) {
  const out = [];
  for (const re of COVERAGE_PROSE_RES) for (const m of readme.matchAll(re)) out.push({ pct: Number(m[1]), text: m[0] });
  return out;
}

// ── FRESHNESS IS A PRECONDITION, not a nicety (2026-07-26) ──────────────────────────────────────
// The defect: coverage/coverage-summary.json sat NINE DAYS stale (mtime Jul 18) while this gate
// re-derived "the truth" from it and graded the badge against a measurement nobody had taken since;
// then a coverage run that ended on a failing test deleted it and wrote nothing at all. One
// unvalidated, rottable input, three possible lies: a false FAIL, a false PASS, a crash. A truth-gate
// that trusts a rotting artifact is ceremony wearing the costume of substance.
//
// So the coverage claim is now UNVERIFIABLE unless the artifact is (1) present, (2) COMPLETE — it
// contains an entry for every file the coverage config says it measures, so a half-written summary
// from an aborted run can never be mistaken for a measurement — and (3) NEWER than every source in
// that set (and newer than the config that defines the set, since a config edit redefines the
// denominator). Unverifiable ⇒ a LOUD skip naming the exact regenerate command. Never a number.
//
// WHY MTIME, NOT A CONTENT HASH STORED BESIDE THE SUMMARY (the alternative I rejected): a hash
// sidecar is only evidence if it is written by whatever produced the summary. Nothing in this
// pipeline can do that — vitest writes coverage-summary.json, and any hash THIS script wrote
// afterwards would be a hash of the tree as it looks at gate time, i.e. a self-certifying stamp
// that agrees with itself by construction and cannot detect the very drift it exists to catch.
// mtime is produced by the OS as a side effect of the write we actually care about: evidence, not
// testimony. Its known weaknesses are both handled: a git checkout resets every source mtime to
// checkout time, but the coverage run that follows writes the summary later, so a fresh CI clone is
// always fresh; and `touch` can forge an mtime, but this gate defends against ROT, not against a
// hostile committer — who could edit the advertised number directly anyway.
export const COVERAGE_REGEN_CMD = 'npm run test:cov';

const DIR_PRUNE = new Set(['node_modules', '.git', 'coverage', 'dist', 'clones']);

/** Minimal glob → RegExp for the shapes coverage.include/exclude actually use (`**`, `*`, `?`). */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * The source set the coverage summary CLAIMS to measure — read from vitest.config.mjs itself
 * (imported, not regex-scraped, so a future edit to the globs is followed automatically instead of
 * silently mis-parsed). Falls back to the summary's own file keys when the config can't be imported
 * (e.g. devDeps absent), and says so, rather than pretending to know the denominator.
 */
export async function coverageSourceSet(vitestFile = path.join(ROOT, 'vitest.config.mjs'), root = ROOT) {
  let cfg;
  try {
    cfg = (await import(pathToFileURL(vitestFile).href)).default;
  } catch (e) {
    return { files: null, derivedFrom: null, reason: `cannot import ${path.basename(vitestFile)}: ${e.message}` };
  }
  const cov = cfg?.test?.coverage ?? {};
  const include = Array.isArray(cov.include) ? cov.include : null;
  if (!include || !include.length) {
    return { files: null, derivedFrom: null, reason: `${path.basename(vitestFile)} declares no coverage.include globs` };
  }
  const exclude = (Array.isArray(cov.exclude) ? cov.exclude : []).map(globToRe);
  const incl = include.map(globToRe);

  const files = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!DIR_PRUNE.has(ent.name)) walk(abs); continue; }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (incl.some((r) => r.test(rel)) && !exclude.some((r) => r.test(rel))) files.push(abs);
    }
  };
  walk(root);
  return { files, derivedFrom: include, reason: null };
}

/**
 * Is the coverage artifact admissible as evidence?
 * → { fresh, code: 'fresh'|'absent'|'unreadable'|'partial'|'stale', reason }
 * `reason` always names the exact regenerate command, so a skip is actionable, never just sad.
 */
export async function coverageFreshness(
  summaryFile = path.join(ROOT, 'coverage', 'coverage-summary.json'),
  vitestFile = path.join(ROOT, 'vitest.config.mjs'),
  root = ROOT,
) {
  const rel = (p) => path.relative(root, p).split(path.sep).join('/') || p;
  const regen = ` — regenerate with \`${COVERAGE_REGEN_CMD}\``;

  if (!fs.existsSync(summaryFile)) {
    return { fresh: false, code: 'absent', reason: `${rel(summaryFile)} absent — no coverage run has produced it (a run that ends on a failing test deletes it and writes nothing)${regen}` };
  }
  let summary, summaryMtime;
  try {
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    summaryMtime = fs.statSync(summaryFile).mtimeMs;
  } catch (e) {
    return { fresh: false, code: 'unreadable', reason: `${rel(summaryFile)} is present but unreadable (${e.message}) — a half-written artifact is not a measurement${regen}` };
  }

  const measured = new Set(Object.keys(summary).filter((k) => k !== 'total').map((k) => path.resolve(root, k)));
  const { files, reason: setReason } = await coverageSourceSet(vitestFile, root);

  // Compare against the config's source set when we can derive it; otherwise fall back to the files
  // the summary itself names (still catches "source edited after the run", just not "file never measured").
  const sources = files ?? [...measured];
  if (files) {
    const unmeasured = files.filter((f) => !measured.has(path.resolve(f)));
    if (unmeasured.length) {
      const sample = unmeasured.slice(0, 3).map(rel).join(', ');
      return { fresh: false, code: 'partial', reason: `${rel(summaryFile)} is PARTIAL — ${unmeasured.length} file(s) the coverage config measures are missing from it (${sample}${unmeasured.length > 3 ? ', …' : ''}), so its total is a denominator nobody measured${regen}` };
    }
  }

  let newest = { file: null, mtime: -Infinity };
  for (const f of [...sources, vitestFile]) {
    let m;
    try { m = fs.statSync(f).mtimeMs; } catch { continue; }
    if (m > newest.mtime) newest = { file: f, mtime: m };
  }
  if (newest.file && newest.mtime > summaryMtime) {
    const age = Math.round((newest.mtime - summaryMtime) / 1000);
    const human = age >= 86400 ? `${(age / 86400).toFixed(1)} days` : age >= 3600 ? `${(age / 3600).toFixed(1)} h` : `${age}s`;
    return { fresh: false, code: 'stale', reason: `${rel(summaryFile)} is STALE — ${rel(newest.file)} was modified ${human} AFTER the coverage run that produced it, so the summary measures source that no longer exists${regen}${files ? '' : ` (source set inferred from the summary itself: ${setReason})`}` };
  }
  return { fresh: true, code: 'fresh', reason: `${rel(summaryFile)} covers all ${sources.length} configured source file(s) and is newer than every one of them` };
}

export async function verifyCoverageBadge(
  readmeFile = path.join(ROOT, 'README.md'),
  summaryFile = path.join(ROOT, 'coverage', 'coverage-summary.json'),
  vitestFile = path.join(ROOT, 'vitest.config.mjs'),
  root = ROOT,
) {
  let readme, vitestCfg;
  try {
    readme = fs.readFileSync(readmeFile, 'utf8');
    vitestCfg = fs.readFileSync(vitestFile, 'utf8');
  } catch (e) {
    return fail(`cannot read artifact: ${e.message}`);
  }

  const advertised = readBadgePct(readme);
  if (advertised === null) {
    return fail('README no longer carries a "coverage-N%25%20of%20ALL%20source" badge — the number that must stay honest is missing');
  }
  // "ALL source" is only an honest claim while every shipped file is in the denominator.
  const allTrue = /\ball\s*:\s*true\b/.test(vitestCfg);
  if (!allTrue) {
    return fail('vitest.config.mjs no longer sets coverage `all: true` — the badge advertises "ALL source", so the denominator must be every shipped file, not a flattering subset');
  }
  // The badge is not the only place the README states the number; the prose must move with it, or
  // one of the two is lying no matter which one matches the artifact.
  const proseDrift = readCoverageClaims(readme).filter((c) => c.pct !== advertised);
  if (proseDrift.length) {
    return fail(`README states the coverage % ${proseDrift.length + 1} different ways: badge ${advertised}%, but also ${proseDrift.map((c) => `"${c.text}"`).join(', ')} — one number, every surface (\`npm run claims:fix\`)`);
  }

  // FRESHNESS PRECONDITION — refuse to grade a claim against an artifact that cannot be trusted.
  // Never a derived number, never a silent pass; a loud SKIP that names the command that fixes it.
  const state = await coverageFreshness(summaryFile, vitestFile, root);
  if (!state.fresh) {
    return skip(`coverage claim NOT GRADED (badge says "${advertised}%", unverified): ${state.reason}`);
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  } catch (e) {
    return fail(`cannot parse ${path.relative(ROOT, summaryFile)}: ${e.message}`);
  }
  const t = summary.total;
  const metrics = ['statements', 'branches', 'functions', 'lines'];
  for (const k of metrics) {
    if (!t?.[k] || typeof t[k].pct !== 'number') return fail(`coverage summary malformed: missing total.${k}.pct`);
  }
  const min = Math.min(...metrics.map((k) => t[k].pct));
  const realFloor = Math.floor(min);
  const TOL = 1; // floor(min) is stable across a whole integer band; ±1 absorbs boundary jitter.
  const detail = metrics.map((k) => `${k} ${t[k].pct}%`).join(', ');
  if (Math.abs(advertised - realFloor) > TOL) {
    return fail(`coverage badge advertises ${advertised}% but the re-derived floor is ${realFloor}% (${detail}). Update the README badge AND prose to ${realFloor}% — run \`npm run claims:fix\`, never hand-type it.`);
  }
  return pass(`badge ${advertised}% within ${TOL}pt of re-derived floor ${realFloor}% (min metric ${min.toFixed(2)}%; all:true; ${detail}); artifact fresh: ${state.reason}`);
}

// ── claim 6: "32 repos · N source chunks" — the advertised chunk count regenerates ──────────────
// The public chunk total is re-derived from the per-store idmap sidecars (id count == passages rows
// == vectors, enforced by corpus-qa S3), summed over PUBLIC stores only (kb/PRIVATE-STORES.json is
// the fence). Every user-facing surface that quotes the number must quote THIS number — the count
// sat at a stale 128,994 across 10+ surfaces after a rebuild moved it (2026-07-10 gremlin hunt).
// The sidecars ship with the brain, which bare CI does not have — absent kb dir is a LOUD SKIP.
//
// kbDir (where the idmap sidecars live) and the private-stores fence are two DIFFERENT facts, same
// conflation kb/store-root.mjs's header names: the fence is a small policy file this repo commits at
// a fixed path (scripts/build-bundle.mjs reads the identical path), while the sidecars ship with the
// installed brain at the canonical store root (kb/store-root.mjs's storeRoot(), not <repo>/kb — that
// directory is a gitignored build workspace the installed brain never lands in outside the release
// build's own KB_DIR override, which storeRoot() already honors). Defaulting kbDir to
// `path.join(ROOT, 'kb')` — the exact anti-pattern kb/forge-currency.mjs's brainKnownSet() carried
// until PR #222 — made this check silently SKIP on any machine with a real installed brain outside
// the repo checkout, never re-deriving the count it exists to police.
export const CHUNK_SURFACES = ['README.md', 'explainer/index.html', 'explainer/llms.txt', 'explainer/llms-full.txt'];
export const PRIVATE_STORES_FILE = path.join(ROOT, 'kb', 'PRIVATE-STORES.json');

export function computePublicChunkTotal(kbDir = storeRoot(), privateStoresFile = PRIVATE_STORES_FILE) {
  const priv = new Set(fs.existsSync(privateStoresFile) ? JSON.parse(fs.readFileSync(privateStoresFile, 'utf8')).privateStores : []);
  let total = 0, stores = 0;
  for (const f of fs.readdirSync(kbDir)) {
    const m = f.match(/^(.+)\.big\.rvf\.idmap\.json$/);
    if (!m || priv.has(m[1])) continue;
    total += Object.keys(JSON.parse(fs.readFileSync(path.join(kbDir, f), 'utf8')).idToLabel).length;
    stores++;
  }
  return { total, stores };
}

/** Every built store on disk, private ones included — what "N built stores incl. private" advertises. */
export function countBuiltStores(kbDir = storeRoot()) {
  return fs.readdirSync(kbDir).filter((f) => /\.big\.rvf\.idmap\.json$/.test(f)).length;
}

/** The three brain census numbers every public surface quotes, all from the same artifacts. */
export function brainCensus(kbDir = storeRoot(), privateStoresFile = PRIVATE_STORES_FILE) {
  const { total, stores } = computePublicChunkTotal(kbDir, privateStoresFile);
  return { chunks: total, publicStores: stores, builtStores: countBuiltStores(kbDir) };
}

// ONE table of "how a census number appears on a public surface", shared by the checker (drift ⇒
// FAIL) and the writer (--fix ⇒ restamp). Four surfaces cannot drift four ways when one table decides
// what the number looks like in all of them. `(?<![\d,])` stops a rule matching the tail of a longer
// number. Each group is rewritten in the writer with its own format (raw for a data-count attribute,
// comma-grouped for prose).
export const SURFACE_CLAIM_RULES = [
  { name: 'chunk count', key: 'chunks', re: /(?<![\d,])(\d{1,3}(?:,\d{3})+)([^0-9]{0,40}?chunks)/gis, groups: [{ i: 1, fmt: 'comma' }] },
  { name: 'chunk counter', key: 'chunks', re: /data-count="(\d{4,})"([^>]*>)([\d,]+)(<\/span>\s*chunks)/gi, groups: [{ i: 1, fmt: 'raw' }, { i: 3, fmt: 'comma' }] },
  { name: 'public-store count', key: 'publicStores', re: /(?<![\d,])(\d{1,3}(?:,\d{3})*)(\s+public\s+stores)/gi, groups: [{ i: 1, fmt: 'comma' }] },
  { name: 'public-store counter', key: 'publicStores', re: /data-count="(\d+)"([^>]*>)([\d,]+)(<\/span>\s*public\s+stores)/gi, groups: [{ i: 1, fmt: 'raw' }, { i: 3, fmt: 'comma' }] },
  { name: 'built-store count', key: 'builtStores', re: /(?<![\d,])(\d{1,3}(?:,\d{3})*)(\s+built\s+stores)/gi, groups: [{ i: 1, fmt: 'comma' }] },
];

const fmtNum = (n, fmt) => (fmt === 'comma' ? n.toLocaleString('en-US') : String(n));

export function verifyChunkCountSurfaces(kbDir = storeRoot(), surfaces = CHUNK_SURFACES, root = ROOT, privateStoresFile = PRIVATE_STORES_FILE) {
  if (!fs.existsSync(kbDir) || !fs.readdirSync(kbDir).some((f) => f.endsWith('.big.rvf.idmap.json'))) {
    return skip(`brain not installed — ${path.join(kbDir, '*.big.rvf.idmap.json')} absent, cannot re-derive the chunk count (runs on machines with the brain)`);
  }
  const census = brainCensus(kbDir, privateStoresFile);
  const want = census.chunks.toLocaleString('en-US');

  const problems = [];
  for (const rel of surfaces) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) { problems.push(`${rel}: file missing`); continue; }
    const s = fs.readFileSync(p, 'utf8');
    if (!s.includes(want)) problems.push(`${rel}: does not contain "${want}"`);
    // Any census number quoted anywhere on the surface must BE the re-derived one. Store counts are
    // drift-checked but not required to be present — not every surface quotes them.
    for (const rule of SURFACE_CLAIM_RULES) {
      for (const m of s.matchAll(rule.re)) {
        for (const g of rule.groups) {
          if (Number(String(m[g.i]).replace(/,/g, '')) !== census[rule.key]) {
            problems.push(`${rel}: stale ${rule.name} "${m[0].trim()}" (expected ${fmtNum(census[rule.key], g.fmt)})`);
          }
        }
      }
    }
  }
  if (problems.length) return fail(`brain census drifted: ${problems.join('; ')} — one pass fixes every surface: \`npm run claims:fix\``);
  return pass(`${want} chunks · ${census.publicStores} public stores · ${census.builtStores} built stores re-derived from the idmaps; all ${surfaces.length} surfaces quote them`);
}

// ── claim 5: "version surfaces agree" ───────────────────────────────────────────────────────────
// Delegated to the existing single-source-of-truth checker; we propagate its exit code.
export function verifyVersionSurfaces(root = ROOT) {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-version.mjs'), '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').pop() || '(no output)';
  if (res.status !== 0) return fail(`sync-version --check exited ${res.status}: ${out}`);
  return pass(out);
}

// ── the WRITER (--fix): regenerate every advertised number in ONE pass ──────────────────────────
// Four surfaces quoted "149,930" for a fortnight after the brain moved to 150,161 because keeping
// them in step was a human chore performed four times. The fix is not more diligence, it is one
// writer: `npm run claims:fix` re-derives the census from the idmaps and the coverage % from the
// coverage summary, and stamps ALL of them together. sync-version.mjs's idiom exactly — one source
// of truth, everything else inherits, `--check` (here: the plain gate) proves it.
//
// The writer obeys the SAME freshness precondition as the gate: it will not propagate a coverage
// number derived from an absent/stale/partial artifact. A writer that stamps a rotten number is
// worse than no writer — it launders the rot into four more places.

/**
 * Rewrite the numeric groups of one rule to `value`; returns { out, hits } (hits = groups changed).
 * Offsets are computed from a cursor that only moves forward WITHIN each match, so a rule whose two
 * groups can hold identical text (`data-count="1234">1234</span>`) still rewrites the right one —
 * a plain string replace would have clobbered the first occurrence twice.
 */
function restampRule(s, rule, value) {
  let out = '', last = 0, hits = 0;
  for (const m of s.matchAll(rule.re)) {
    let rel = 0;
    for (const g of rule.groups) {
      const cur = m[g.i];
      if (cur === undefined) continue;
      const idx = m[0].indexOf(cur, rel);
      if (idx < 0) continue;
      rel = idx + cur.length;
      const want = fmtNum(value, g.fmt);
      if (cur === want) continue;
      const at = m.index + idx;
      out += s.slice(last, at) + want;
      last = at + cur.length;
      hits++;
    }
  }
  return { out: out + s.slice(last), hits };
}

export async function applyFix({
  root = ROOT,
  kbDir = storeRoot(),
  privateStoresFile = PRIVATE_STORES_FILE,
  surfaces = CHUNK_SURFACES,
  readmeFile = path.join(root, 'README.md'),
  summaryFile = path.join(root, 'coverage', 'coverage-summary.json'),
  vitestFile = path.join(root, 'vitest.config.mjs'),
  write = false,
} = {}) {
  const report = { changed: [], census: null, coverage: { skipped: true, reason: 'not attempted' }, notes: [] };
  const edits = new Map(); // abs path -> content

  const readSurface = (rel) => {
    const p = path.join(root, rel);
    if (edits.has(p)) return { p, s: edits.get(p) };
    if (!fs.existsSync(p)) return { p, s: null };
    return { p, s: fs.readFileSync(p, 'utf8') };
  };

  // ---- the brain census (chunks + store counts), re-derived from the idmap sidecars -------------
  const haveBrain = fs.existsSync(kbDir) && fs.readdirSync(kbDir).some((f) => f.endsWith('.big.rvf.idmap.json'));
  if (!haveBrain) {
    report.notes.push('brain not installed — chunk/store counts left untouched (nothing to re-derive them from)');
  } else {
    const census = brainCensus(kbDir, privateStoresFile);
    report.census = census;
    for (const rel of surfaces) {
      const { p, s } = readSurface(rel);
      if (s === null) { report.notes.push(`${rel}: file missing, skipped`); continue; }
      let next = s, hits = 0;
      for (const rule of SURFACE_CLAIM_RULES) {
        const r = restampRule(next, rule, census[rule.key]);
        next = r.out; hits += r.hits;
      }
      if (!next.includes(census.chunks.toLocaleString('en-US'))) {
        // A surface with no existing claim is REPORTED, never improvised into someone else's prose —
        // the first stamp on a new surface is a deliberate one-time copy edit.
        report.notes.push(`${rel}: no chunk-count claim to restamp — add one by hand once (e.g. "${census.chunks.toLocaleString('en-US')} source chunks"), then this keeps it fresh`);
      }
      if (hits) { edits.set(p, next); report.changed.push(rel); }
    }
  }

  // ---- the coverage % (badge + every prose copy), re-derived from the coverage summary ----------
  const state = await coverageFreshness(summaryFile, vitestFile, root);
  if (!state.fresh) {
    report.coverage = { skipped: true, reason: state.reason, code: state.code };
  } else {
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    const metrics = ['statements', 'branches', 'functions', 'lines'];
    const pcts = metrics.map((k) => summary.total?.[k]?.pct);
    if (pcts.some((v) => typeof v !== 'number')) {
      report.coverage = { skipped: true, reason: 'coverage summary has no usable total.*.pct', code: 'malformed' };
    } else {
      const pct = Math.floor(Math.min(...pcts));
      const relReadme = path.relative(root, readmeFile).split(path.sep).join('/');
      const { p, s } = readSurface(relReadme);
      const before = s ?? fs.readFileSync(readmeFile, 'utf8');
      let next = before, hits = 0;
      for (const rule of [{ re: BADGE_RE_G, groups: [{ i: 1, fmt: 'raw' }] }, ...COVERAGE_PROSE_RES.map((re) => ({ re, groups: [{ i: 1, fmt: 'raw' }] }))]) {
        const r = restampRule(next, rule, pct);
        next = r.out; hits += r.hits;
      }
      report.coverage = { skipped: false, pct, metrics: Object.fromEntries(metrics.map((k, i) => [k, pcts[i]])), changed: hits > 0 };
      if (hits) {
        edits.set(p, next);
        if (!report.changed.includes(relReadme)) report.changed.push(relReadme);
      }
    }
  }

  if (write) for (const [p, s] of edits) fs.writeFileSync(p, s);
  return report;
}

// ── the CRITICAL-INVARIANT VECTOR (ADR-058, "never an average") ─────────────────────────────────
//
// ADR-058's release gate is a VECTOR of named invariants, not a mean of scores — an average lets a
// dead invariant be paid for by seven live ones, which is precisely how a release ships with its
// learning wire unproven. Each entry is one NAMED invariant whose state is DERIVED from an artifact
// on disk that states the SHA it was measured on.
//
// The vector ADR-058 §"The release gate" specifies in full:
//   INSTALL-FAILS-LOUD · INTERFACE-CORPUS · LATENCY-DECISION-LANE · COEXIST-BYTE-EQUAL ·
//   LEARNING-REPLAY · SIGNAL-WATCH-FIRES · SCENARIOS-CURRENT · GUARANTEE-RUNS
//
// Only the ones whose harness EXISTS are registered here. Registering the other seven as always-SKIP
// rows would be the ceremony this repo keeps deleting: a name in a table is not a check. They land
// as their own D-items land.
export const invariants = [
  {
    name: LEARNING_REPLAY,
    what: 'a lesson recorded in project A changes an agent\'s produced artifact in project B, against a brain-off control, and survives a nightly refresh',
    source: 'data/learning-replay-result.json (written by scripts/learning-replay.mjs)',
    verify: verifyLearningReplay,
  },
];

/**
 * LEARNING-REPLAY — read the trap's own result artifact.
 *
 * The ONE rule that governs the mapping: **UNKNOWN IS NEVER PASS, and neither is INCONCLUSIVE.**
 * A trap that has not run, whose result predates a load-bearing edit, or whose control arm also
 * produced the token, reports SKIP — printed loudly by the runner, never counted as verified. FAIL
 * is a real red: the treated arm did not change its artifact.
 *
 * The verdict is not recomputed here. It is READ from an artifact that states the SHA it was
 * measured on, and `checkArtifact()` re-derives whether that SHA is still current for this tree.
 * A gate that recomputed the verdict from nothing would be asserting, not deriving.
 */
export async function verifyLearningReplay() {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'learning-replay.mjs')).href);
  } catch (e) {
    return fail(`cannot load scripts/learning-replay.mjs: ${e.message}`);
  }
  const res = mod.checkArtifact();
  if (res.status === 'PASS') return pass(res.why);
  if (res.status === 'FAIL') return fail(res.why);
  // UNKNOWN | INCONCLUSIVE — loud, and explicitly not a pass.
  return skip(`${res.status} (never a pass): ${res.why}`);
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────
export const ledger = [
  {
    claim: 'grounded 12/12 → n=120 baseline',
    source: 'evals/baseline.json',
    verify: verifyBaseline,
  },
  {
    claim: 'held-out set is frozen at 120 questions across 5 strata',
    source: 'evals/held-out.json',
    verify: verifyHeldOutStrata,
  },
  {
    claim: '~56× cheaper (explainer + hook)',
    source: 'kb/metaharness.passages.jsonl',
    verify: verifyCheaperFactor,
  },
  {
    claim: 'coverage badge % re-derives from the real coverage run (ALL source)',
    source: 'README.md + coverage/coverage-summary.json + vitest.config.mjs',
    verify: verifyCoverageBadge,
  },
  {
    claim: 'version surfaces agree',
    source: 'scripts/sync-version.mjs --check',
    verify: verifyVersionSurfaces,
  },
  {
    claim: 'advertised source-chunk count regenerates from the brain (all surfaces agree)',
    source: 'kb/*.big.rvf.idmap.json + kb/PRIVATE-STORES.json',
    verify: verifyChunkCountSurfaces,
  },
  // The invariant vector rides the same runner so it is printed in the same table and obeys the same
  // "a skip is never a silent pass" rule. The vector is ALSO exported separately (`invariants`) so a
  // future release gate can consume the named states without reading prose out of a markdown row.
  ...invariants.map((iv) => ({ claim: `invariant ${iv.name}: ${iv.what}`, source: iv.source, verify: iv.verify })),
];

// ── runner ──────────────────────────────────────────────────────────────────────────────────────
const cell = (s) => String(s).replaceAll('|', '\\|');

export async function runLedger(entries = ledger) {
  const rows = [];
  for (const entry of entries) {
    let result;
    try {
      result = await entry.verify();
    } catch (e) {
      result = fail(`verify() threw: ${e.message}`);
    }
    rows.push({ claim: entry.claim, source: entry.source, ...result });
  }
  return rows;
}

async function main() {
  // --fix is the ONLY writing path; the gate itself never mutates a surface.
  if (process.argv.includes('--fix')) {
    const report = await applyFix({ write: true });
    if (report.census) {
      console.log(`[claims:fix] census re-derived: ${report.census.chunks.toLocaleString('en-US')} chunks · ${report.census.publicStores} public stores · ${report.census.builtStores} built stores`);
    }
    if (report.coverage.skipped) {
      console.log(`[claims:fix] coverage % NOT stamped (left exactly as it was): ${report.coverage.reason}`);
    } else {
      console.log(`[claims:fix] coverage % re-derived: ${report.coverage.pct}% = floor(min ${Object.entries(report.coverage.metrics).map(([k, v]) => `${k} ${v}%`).join(', ')})`);
    }
    for (const n of report.notes) console.log(`[claims:fix] ${n}`);
    console.log(report.changed.length
      ? `[claims:fix] rewrote ${report.changed.length} surface(s) in one pass: ${report.changed.join(', ')}`
      : '[claims:fix] every surface already agrees with the artifacts — nothing to write');
    console.log('');
  }

  const rows = await runLedger();

  console.log('## Claims ledger — every advertised number must regenerate from an artifact\n');
  console.log('| claim | status | evidence |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${cell(r.claim)} | ${r.status} | ${cell(r.evidence)} |`);
  console.log('');

  const skipped = rows.filter((r) => r.status === SKIP);
  for (const s of skipped) console.log(`SKIPPED (not a pass): ${s.claim} — ${s.evidence}`);

  const failed = rows.filter((r) => r.status === FAIL);
  if (failed.length) {
    console.error(`\nclaims:verify FAILED — ${failed.length} claim(s) no longer regenerate from their artifacts.`);
    process.exit(1);
  }
  console.log(`\nclaims:verify OK — ${rows.length - skipped.length} verified, ${skipped.length} skipped (loudly).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
