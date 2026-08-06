#!/usr/bin/env node
// scripts/doc-currency.mjs — DOCUMENT CURRENCY. ADR-034 / DDD-0008, decided originally in ADR-0009
// on 2026-07-06 and left as prose for sixteen days, during which zero of this repo's scripts
// implemented it. This is the gate half of that decision.
//
//   node scripts/doc-currency.mjs --report          human table: every doc, its stamps, its verdict
//   node scripts/doc-currency.mjs --check           exit 1 on a real violation (CI / pre-push)
//   node scripts/doc-currency.mjs --fix             backfill ONLY dates git can prove; label them
//   node scripts/doc-currency.mjs --json            machine-readable, same evaluation
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE LAW (ADR-0024, already law here): "a status must be RE-DERIVED from the verifiable
// artifact, never read from a self-asserted field." Every value this tool prints is derived from
// git or the filesystem. A frontmatter `impl:` is treated as an untrusted CLAIM to be checked
// against the derivation, never as an input to it.
//
// FIVE FAILURE MODES THIS DESIGN EXISTS TO AVOID — each one found by adversarial review of the
// naive version, each one reproduced against this repo before being fixed here:
//
//   1. A missing or renamed governed path made `git rev-parse HEAD:<p>` print the literal
//      "HEAD:<p>" to stdout and exit 128. Hashing that literal produced a STABLE digest that could
//      never change again — so renaming a governed file (the most common way a doc goes stale)
//      froze its verification green forever. Here: resolution is checked per path via
//      `git cat-file --batch-check`, and ANY unresolvable member makes the digest uncomputable.
//      A digest is never computed over a guess.  (see resolveGoverned / computeDigest)
//
//   2. A DIRECTORY in `governs:` hashed the whole tree. `HEAD:docs/adr` resolves to a tree object
//      that changes when ANY of the 34 ADRs changes — mass-expiring unrelated verifications on day
//      one. That is the wolf-cry that gets a gate switched off. Here: trees are a hard finding, and
//      the fix (a glob) is printed.
//
//   3. The digest covered only the CODE, so editing the DOCUMENT left the stamp green. You could
//      rewrite a verified ADR to describe behaviour the code never had and nothing expired. Here
//      the document's own normative body is an input to the digest, so either side moving expires
//      the verification. The currency log is excluded, because appending the row that RECORDS a
//      verification must not invalidate that same verification.
//
//   4. `impl:` used ANY-semantics ("≥1 governed path is wired"), which reported `wired` for a doc
//      governing an unwired file plus one wired helper — i.e. green on exactly the built-but-
//      unwired failure the rung was invented to catch. Here impl is derived PER PATH and the
//      WEAKEST member wins, with the unwired members named.
//
//   5. Falling back to `date:` when `updated:` is absent counted a CREATION stamp as a drifted
//      UPDATE stamp. That is how "4 of 20 stamps are wrong" was measured when only 1 committed ADR
//      actually had a drifted `updated:` — three of the four accused carry no `updated:` key at
//      all. Absent is absent here; it is reported as absent and never inferred from a neighbour.
//
// FALSE POSITIVES ARE THE DESIGNED FAILURE MODE. A gate that cries wolf gets bypassed and a
// bypassed gate protects nothing (ADR-0024 said the same about its own scope). So: age is NOWHERE
// in the drift formula — only movement of the governed set is; a doc with a dirty working tree is
// exempted from stamp checks rather than accused; a doc with no `governs:` has no drift and cannot
// be flagged stale; and the twelve legacy ADRs whose frontmatter is a bare `id:` are REPORTED
// forever and BLOCK never (they predate the convention; blocking twelve pre-existing violations on
// day one is how a gate dies).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const DEFAULT_DIRS = ['docs/adr', 'docs/ddd'];

// Label for the digest recipe. Bumping it deliberately expires every stamp, which is the honest
// behaviour when the meaning of a stamp changes.
export const DIGEST_RECIPE = 'sha256-manifest';

// Ladder. Lower is weaker. `unknown` sits below everything because "we cannot tell" must never
// outrank "we checked and it is not built".
export const IMPL_LADDER = ['unknown', 'unbuilt', 'built', 'wired', 'verified'];
const rank = (v) => { const i = IMPL_LADDER.indexOf(v); return i < 0 ? 0 : i; };
export const weakest = (vals) => (vals.length ? vals.reduce((a, b) => (rank(b) < rank(a) ? b : a)) : 'unknown');

// rUv's ADR enum, unchanged and un-extended (ruflo-adr REFERENCE.md). `Implemented` is deliberately
// NOT here: it is a fifth value this repo invented on someone else's key, and it is the lie-shaped
// one — it says something about code on a key that means something about a decision.
export const RUV_STATUSES = ['Proposed', 'Accepted', 'Deprecated', 'Superseded'];

// ── git ─────────────────────────────────────────────────────────────────────────────────────────
// Every call is `-C root` so fixtures in tmp dirs are first-class; nothing reads process.cwd().

function git(root, args, { input } = {}) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function isGitRepo(root) {
  return git(root, ['rev-parse', '--git-dir']).ok;
}

export function hasCommits(root) {
  return git(root, ['rev-parse', '--verify', 'HEAD']).ok;
}

// Last commit date (author date, in the committer's own timezone — the date a human would have
// typed) + sha, for one path. Empty when the path has never been committed.
export function lastCommit(root, rel) {
  const r = git(root, ['log', '-1', '--format=%ad|%H', '--date=short', '--', rel]);
  if (!r.ok || !r.out) return null;
  const [date, sha] = r.out.split('|');
  return { date, sha };
}

// The commit that ADDED the file, following renames. `--diff-filter=A` can emit several rows across
// a rename chain; the earliest (last line) is the creation.
export function firstCommit(root, rel) {
  const r = git(root, ['log', '--follow', '--diff-filter=A', '--format=%ad|%H', '--date=short', '--', rel]);
  if (!r.ok || !r.out) return null;
  const lines = r.out.split('\n').filter(Boolean);
  if (!lines.length) return null;
  const [date, sha] = lines[lines.length - 1].split('|');
  return { date, sha };
}

// Working tree differs from HEAD, or the file is not tracked at all. A dirty doc's "last commit
// date" is not the date of its current contents, so every stamp comparison is suspended for it.
export function isDirty(root, rel) {
  const r = git(root, ['status', '--porcelain', '--', rel]);
  return r.ok ? r.out.length > 0 : false;
}

// ── frontmatter ─────────────────────────────────────────────────────────────────────────────────
// Deliberately a small hand parser rather than a YAML dependency: the shapes are fixed, the repo
// has no YAML dep, and a parse failure here must degrade to "unreadable", never throw.

export function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { present: false, keys: {}, endLine: -1, raw: [] };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return { present: false, keys: {}, endLine: -1, raw: [] };

  const keys = {};
  const raw = lines.slice(1, end);
  let listKey = null;
  for (const ln of raw) {
    const item = ln.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { keys[listKey].push(item[1].trim().replace(/^["']|["']$/g, '')); continue; }
    const kv = ln.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    const v = vRaw.trim();
    if (v === '') { listKey = k; keys[k] = []; continue; }
    listKey = null;
    if (v.startsWith('[') && v.endsWith(']')) {
      keys[k] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      keys[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return { present: true, keys, endLine: end, raw };
}

// The part of a document a verification is a reading OF. Frontmatter is excluded (it holds the
// stamp itself — including it would make every stamp invalidate itself the moment it was written).
// The currency log is excluded for the same reason one rung up: recording a verification appends a
// row, and that row must not expire the verification it records.
export function normativeBody(text) {
  const fm = parseFrontmatter(text);
  const lines = text.split('\n');
  const body = fm.present ? lines.slice(fm.endLine + 1) : lines;
  const out = [];
  let skipping = false;
  for (const ln of body) {
    const h = ln.match(/^#{1,6}\s+(.*)$/);
    if (h) skipping = /^currency log\b/i.test(h[1].trim());
    if (!skipping) out.push(ln.replace(/[ \t]+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── the governed set ────────────────────────────────────────────────────────────────────────────

// Resolve every declared entry to a concrete blob at HEAD. Globs expand through the index; a
// literal entry is looked up with `git cat-file --batch-check`, which distinguishes blob / tree /
// missing in ONE process and — unlike `git rev-parse HEAD:<p>` — never prints the requested path
// back as if it were an answer.
export function resolveGoverned(root, entries) {
  const results = [];
  if (!entries.length) return results;

  const expanded = [];
  for (const e of entries) {
    const clean = String(e).trim();
    if (!clean) continue;
    if (/[*?[\]]/.test(clean)) {
      const ls = git(root, ['ls-files', '--', clean]);
      const hits = ls.ok ? ls.out.split('\n').filter(Boolean) : [];
      if (!hits.length) { expanded.push({ path: clean, from: clean, glob: true, empty: true }); continue; }
      for (const h of hits) expanded.push({ path: h, from: clean, glob: true });
    } else {
      expanded.push({ path: clean.replace(/\/+$/, ''), from: clean, trailingSlash: /\/$/.test(clean) });
    }
  }

  const lookups = expanded.filter((e) => !e.empty);
  const byPath = new Map();
  if (lookups.length && hasCommits(root)) {
    const input = lookups.map((e) => `HEAD:${e.path}`).join('\n') + '\n';
    const r = git(root, ['cat-file', '--batch-check'], { input });
    const lines = r.out ? r.out.split('\n') : [];
    lines.forEach((ln, i) => {
      const m = ln.match(/^([0-9a-f]{40})\s+(\w+)\s+(\d+)$/);
      const e = lookups[i];
      if (!e) return;
      if (m) byPath.set(e.path, { sha: m[1], type: m[2] });
      else byPath.set(e.path, { sha: null, type: 'missing' });
    });
  }

  for (const e of expanded) {
    const abs = path.join(root, e.path);
    const onDisk = fs.existsSync(abs);
    if (e.empty) {
      results.push({ ...e, type: 'no-match', sha: null, onDisk: false, resolved: false });
      continue;
    }
    const hit = byPath.get(e.path) || { sha: null, type: onDisk ? 'untracked' : 'missing' };
    const type = hit.type === 'missing' && onDisk ? 'untracked' : hit.type;
    results.push({ ...e, type, sha: hit.sha, onDisk, resolved: type === 'blob' });
  }
  return results;
}

// A digest is a value you cannot type from memory — that is its entire job. It is therefore
// computed ONLY when every input is a real, resolved blob. If any member is a tree, missing,
// untracked, or an empty glob, the answer is `null` plus a reason. Never a hash over a placeholder.
export function computeDigest(root, docRelPath, docText, governed) {
  const unresolved = governed.filter((g) => !g.resolved);
  if (!governed.length) return { digest: null, reason: 'governs: is empty — nothing to verify against' };
  if (unresolved.length) {
    return {
      digest: null,
      reason: `unresolvable governed path(s): ${unresolved.map((g) => `${g.path} (${g.type})`).join(', ')}`,
      unresolved,
    };
  }
  const manifest = [
    ...governed.map((g) => `blob ${g.sha} ${g.path}`).sort(),
    `doc ${sha256(normativeBody(docText))} ${docRelPath}`,
    `recipe ${DIGEST_RECIPE}`,
  ].join('\n');
  return { digest: sha256(manifest).slice(0, 12), manifest };
}

// Is this path referenced from something that is neither a test nor a document? The gap between
// "exists" and "someone calls it" is this repo's signature failure (a capability registry with zero
// call sites; lessons mined, weighted and consumed by nobody). It is also the one check with a real
// false-negative rate — hook-invoked scripts and dynamic dispatch have no greppable caller — so a
// negative result WARNS and never blocks.
export function findCallers(root, rel) {
  const base = path.basename(rel);
  const r = git(root, ['grep', '-l', '-I', '--untracked', '-F', '-e', rel, '-e', base]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').filter(Boolean).filter((f) => {
    if (f === rel) return false;
    if (/(^|\/)tests?\//.test(f)) return false;
    if (/\.test\.[cm]?[jt]s$/.test(f)) return false;
    if (/\.(md|markdown)$/i.test(f)) return false;
    return true;
  });
}

// ── impl derivation ─────────────────────────────────────────────────────────────────────────────
// PER PATH, then the WEAKEST wins. Any-semantics ("one member is wired ⇒ wired") reports green on
// exactly the built-but-unwired case the rung exists to catch.
export function deriveImpl(root, governed, { checkWiring = true } = {}) {
  if (!governed.length) return { impl: 'unknown', perPath: [], unwired: [], reason: 'no governs: set' };
  const perPath = governed.map((g) => {
    if (!g.onDisk && !g.resolved) return { path: g.path, impl: 'unbuilt', type: g.type };
    const callers = checkWiring ? findCallers(root, g.path) : [];
    return { path: g.path, impl: callers.length ? 'wired' : 'built', callers, type: g.type };
  });
  return {
    impl: weakest(perPath.map((p) => p.impl)),
    perPath,
    unwired: perPath.filter((p) => p.impl === 'built').map((p) => p.path),
    missing: perPath.filter((p) => p.impl === 'unbuilt').map((p) => p.path),
  };
}

// ── drift ───────────────────────────────────────────────────────────────────────────────────────
// Drift is MOVEMENT, never age. `presumed-stale` says "nobody has checked since the code moved",
// which is exactly what is true. A doc untouched for months whose governed code has not moved is
// `current`, silently. That property is what keeps this gate alive.
export const DRIFT_COMMITS_STALE = 2;
export const DRIFT_DAYS_STALE = 7;

export function deriveDrift(root, docRel, governed) {
  const paths = governed.filter((g) => g.resolved).map((g) => g.path);
  if (!paths.length) return { state: 'not-applicable', commits: 0, days: 0, reason: 'no resolvable governed paths' };
  const doc = lastCommit(root, docRel);
  if (!doc) return { state: 'not-applicable', commits: 0, days: 0, reason: 'document has no git history' };

  // A VERSION BUMP IS NOT DRIFT (2026-08-06). `scripts/sync-version.mjs` rewrites the plugin
  // manifests, package.json, kb/package.json and RVF-GENERATIONS.json on EVERY release bump, and
  // several ADRs legitimately `govern:` those files. So every bump marked those documents
  // presumed-stale whether or not anything they decide had moved — measured four times in one day
  // on ADR-050/051/057/058, each time resolving to "re-read, nothing changed but a version string".
  //
  // That is not a harmless nuisance. A gate that fires on every bump teaches people to stamp
  // without reading, and this repo has already blanket-stamped 61 ADRs from a bad grep exactly
  // once. It also blocks unattended release automation, which cannot author a currency row.
  //
  // Drift is MOVEMENT IN WHAT THE DOCUMENT DECIDES. A commit whose entire diff inside the governed
  // paths is version-identifier lines cannot have changed any decision, so it does not count. Any
  // commit touching one substantive line still counts in full — this narrows the trigger, never the
  // verdict.
  const shas = (() => {
    const r = git(root, ['rev-list', `${doc.sha}..HEAD`, '--', ...paths]);
    return r.ok && r.out ? r.out.split('\n').filter(Boolean) : [];
  })();
  const VERSION_FIELD = /^[+-]\s*"?(version|releaseTag|brainVersion|softwareVersion|tag)"?\s*[:=]/i;
  const isVersionOnly = (sha) => {
    const d = git(root, ['show', '--unified=0', '--format=', sha, '--', ...paths]);
    if (!d.ok || !d.out) return false;
    const changed = d.out.split('\n')
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    // No changed lines at all (pure rename/mode) is not evidence of a decision change either, but
    // be conservative: only EXEMPT when there is at least one line and every one is a version field.
    return changed.length > 0 && changed.every((l) => VERSION_FIELD.test(l));
  };
  const substantive = shas.filter((s) => !isVersionOnly(s));
  const commits = substantive.length;

  const codeR = git(root, ['log', '-1', '--format=%ad', '--date=short', `${doc.sha}..HEAD`, '--', ...paths]);
  const codeDate = codeR.ok && codeR.out ? codeR.out.split('\n')[0] : null;

  let days = 0;
  if (codeDate) {
    const d0 = Date.parse(`${doc.date}T00:00:00Z`);
    const d1 = Date.parse(`${codeDate}T00:00:00Z`);
    if (Number.isFinite(d0) && Number.isFinite(d1)) days = Math.max(0, Math.round((d1 - d0) / 86400000));
  }

  let state = 'current';
  if (commits > 0) {
    state = (commits >= DRIFT_COMMITS_STALE || days >= DRIFT_DAYS_STALE) ? 'presumed-stale' : 'lagging';
  }
  return { state, commits, days, docDate: doc.date, docSha: doc.sha, codeDate, paths };
}

// ── currency log ────────────────────────────────────────────────────────────────────────────────
// A *why* is judged on STRUCTURE, never on meaning — a gate that claimed to judge sincerity would
// be a fifth lie-shaped status. It must carry at least one RESOLVABLE referent. This raises the
// cost of filler; it does not detect insincerity and must never claim to. What it reliably kills is
// the empty why ("updated docs"), which is the failure that actually happens.
export function countReferents(root, why) {
  const refs = [];
  for (const m of why.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g)) {
    if (fs.existsSync(path.join(root, m[1]))) refs.push({ kind: 'path', value: m[1] });
  }
  for (const m of why.matchAll(/\b(ADR|DDD|SEC)-0*(\d{1,4})\b/gi)) {
    refs.push({ kind: 'doc-id', value: `${m[1].toUpperCase()}-${m[2]}` });
  }
  for (const m of why.matchAll(/\b([0-9a-f]{7,40})\b/g)) {
    if (hasCommits(root) && git(root, ['cat-file', '-e', `${m[1]}^{commit}`]).ok) refs.push({ kind: 'sha', value: m[1] });
  }
  for (const m of why.matchAll(/(?:^|\s)#(\d{1,6})\b/g)) refs.push({ kind: 'issue', value: `#${m[1]}` });
  for (const m of why.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
    if (/["'“”‘’*]/.test(why)) refs.push({ kind: 'dated-quote', value: m[0] });
  }
  return refs;
}

export function parseCurrencyLog(root, text) {
  const lines = text.split('\n');
  let inSection = false;
  const rows = [];
  for (const ln of lines) {
    const h = ln.match(/^#{1,6}\s+(.*)$/);
    if (h) { inSection = /^currency log\b/i.test(h[1].trim()); continue; }
    if (!inSection) continue;
    if (!ln.trim().startsWith('|')) continue;
    const cells = ln.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-{2,}$/.test(cells[0].replace(/[: ]/g, '-'))) continue;
    if (/^date$/i.test(cells[0])) continue;
    const [date, what, ...rest] = cells;
    const why = rest.join(' | ');
    rows.push({ date, what, why, referents: countReferents(root, why) });
  }
  return { present: rows.length > 0 || /^#{1,6}\s+currency log\b/im.test(text), rows };
}

// ── evaluation ──────────────────────────────────────────────────────────────────────────────────

const BLOCK = 'block';
const WARN = 'warn';

export function listDocs(root, dirs = DEFAULT_DIRS) {
  const out = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      if (!/^\d{4}.*\.md$/.test(name)) continue;
      out.push(path.posix.join(d.split(path.sep).join('/'), name));
    }
  }
  return out;
}

export function evaluateDoc(root, rel, opts = {}) {
  const { checkWiring = true } = opts;
  const abs = path.join(root, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const fm = parseFrontmatter(text);
  const k = fm.keys;

  const CONVENTION_KEYS = ['status', 'date', 'updated', 'impl', 'governs', 'verified', 'verified_digest'];
  const declared = CONVENTION_KEYS.filter((key) => k[key] !== undefined);
  // A document predating the convention carries NONE of its keys. That is a derived property of the
  // file, not a hardcoded list of filenames — a new doc written to the convention can never be
  // mistaken for one, and nobody has to maintain a grandfather roster.
  const legacy = fm.present && declared.length === 0;

  const findings = [];
  const add = (level, code, message, extra = {}) => findings.push({ level, code, message, ...extra });

  const tracked = hasCommits(root) && git(root, ['ls-files', '--error-unmatch', '--', rel]).ok;
  const dirty = !tracked || isDirty(root, rel);
  const docCommit = tracked ? lastCommit(root, rel) : null;
  const addedCommit = tracked ? firstCommit(root, rel) : null;

  const doc = {
    file: rel,
    id: k.id ?? null,
    legacy,
    tracked,
    dirty,
    status: k.status ?? null,
    date: k.date ?? null,
    updated: k.updated ?? null,
    updatedPinned: k.updated_pinned === true || k.updated_pinned === 'true',
    implStored: k.impl ?? null,
    verifiedStamp: k.verified ?? null,
    verifiedDigestStored: k.verified_digest ?? null,
    governsDeclared: Array.isArray(k.governs) ? k.governs : (k.governs ? [String(k.governs)] : []),
    docCommit,
    addedCommit,
    findings,
  };

  if (!fm.present) {
    add(WARN, 'no-frontmatter', 'no YAML frontmatter — cannot carry stamps; not currency-checkable');
    doc.impl = 'unknown';
    doc.drift = { state: 'not-applicable', commits: 0, days: 0 };
    doc.digest = { computed: null, stored: null, match: null };
    return doc;
  }

  // ── stamps ────────────────────────────────────────────────────────────────────────────────────
  // Legacy docs are reported and never blocked. Retro-stamping twelve documents is not a push-time
  // job, and a gate whose first act is to block twelve pre-existing violations gets disabled.
  const stampLevel = legacy ? WARN : BLOCK;
  if (legacy) add(WARN, 'legacy-unstamped', `frontmatter carries none of ${CONVENTION_KEYS.join('/')} — predates the convention; reported, never blocked`);

  // The enum is judged on the LEADING TOKEN. `status: Proposed (awaiting Stuart's approval)` is a
  // Proposed decision with a note attached, and flagging it would be a false positive on a doc doing
  // nothing wrong — the parenthetical is how a human says something the enum has no room for.
  const statusWord = doc.status ? (doc.status.match(/^[A-Za-z]+/)?.[0] ?? doc.status) : null;
  if (!doc.status) add(stampLevel, 'missing-status', 'no `status:` — the decision state is unstated in the machine-readable half');
  else if (!RUV_STATUSES.includes(statusWord)) {
    // `Implemented` is the specific historical case: a fifth value invented on rUv's key, saying
    // something about CODE on a key that means something about a DECISION.
    add(WARN, 'status-not-in-enum', `status: ${doc.status} is not one of ${RUV_STATUSES.join('|')} (rUv's enum)`
      + (/^implemented$/i.test(doc.status) ? ' — this is the code-state axis; it belongs on `impl:`, which is derived' : ''));
  }
  if (!doc.date) add(stampLevel, 'missing-created', 'no `date:` — creation is unstamped');
  if (!doc.updated) add(stampLevel, 'missing-updated', 'no `updated:` — last-change is unstamped (NOT inferred from `date:`)');

  if (!tracked) add(WARN, 'no-git-history', 'not committed — every git-derived value is unavailable for this document');

  // Stamp-vs-git. Suspended entirely when the working tree is dirty: the last COMMIT date is not
  // the date of the current CONTENTS, so accusing a doc mid-edit is a guaranteed false positive.
  if (doc.updated && docCommit && !dirty) {
    const d = Date.parse(`${doc.updated}T00:00:00Z`);
    const g = Date.parse(`${docCommit.date}T00:00:00Z`);
    if (Number.isFinite(d) && Number.isFinite(g)) {
      const deltaDays = Math.round((g - d) / 86400000);
      if (deltaDays >= 1) {
        // `updated_pinned: true` — the date is a HISTORICAL RECORD, not a currency stamp.
        //
        // Some documents record WHEN SOMETHING HAPPENED, not when the file was last edited.
        // ADR-050's `updated: 2026-08-02` is an incident cutoff and is asserted by
        // tests/unit/fix-workstream-guidance. A blanket "make the stamp match the last commit"
        // rule cannot tell those apart, so it silently rewrote the pinned date — putting two gates
        // into direct contradiction, one demanding the pinned value and one demanding the commit
        // date, with no way to satisfy both. The document itself is the only thing that knows
        // which kind of date it carries, so it now says so, and --fix must never overwrite it.
        if (doc.updatedPinned) {
          add(WARN, 'stamp-pinned',
            `updated: ${doc.updated} is PINNED (updated_pinned: true) and deliberately does not track the last commit ${docCommit.date} — it records an event, not the edit`);
        } else add(BLOCK, 'stamp-lags-doc',
          `updated: ${doc.updated} but the document's own last commit is ${docCommit.date} (${docCommit.sha.slice(0, 8)}) — edited without touching its own stamp`);
      } else if (deltaDays <= -1) {
        // Typed ahead. WARN only: a stamp dated today on a change not yet committed is CORRECT, and
        // blocking it would make the gate fire on the very act of doing the right thing.
        add(WARN, 'stamp-ahead-of-doc', `updated: ${doc.updated} is ahead of the last commit ${docCommit.date} — expected while the change is uncommitted; a violation only if it stays`);
      }
    }
  } else if (doc.updated && dirty) {
    add(WARN, 'stamp-unverifiable-dirty', 'working tree modified — stamp-vs-git comparison suspended rather than guessed');
  }

  if (doc.date && addedCommit && doc.date !== addedCommit.date) {
    add(WARN, 'created-differs-from-first-commit', `date: ${doc.date} but git says the file was added ${addedCommit.date} — the created stamp is immutable, so this is reported, never auto-corrected`);
  }

  // ── governed set ──────────────────────────────────────────────────────────────────────────────
  const governed = resolveGoverned(root, doc.governsDeclared);
  doc.governed = governed;

  for (const g of governed) {
    if (g.type === 'tree') {
      add(BLOCK, 'governs-directory',
        `governs: "${g.from}" is a DIRECTORY — its tree object changes when any file under it changes, mass-expiring unrelated verifications. Use a glob (e.g. "${g.path}/*.md") so the set expands to files.`);
    } else if (g.type === 'missing') {
      // Severity depends on what the document CLAIMS. A Proposed ADR naming the artifact it intends
      // to create is the `unbuilt` state working exactly as designed — blocking it would make this
      // gate fire on the act of writing a design doc, which is the wolf-cry that gets it removed.
      // A document that claims built/wired/verified over a path that is gone is a different thing:
      // the claim is refuted and the digest is uncomputable.
      const claims = doc.verifiedDigestStored || (doc.implStored && rank(doc.implStored) >= rank('built'));
      add(claims ? BLOCK : WARN, 'governs-unresolvable',
        `governs: "${g.from}" does not exist at HEAD and is not on disk`
        + (claims ? ' — but this document claims it is built or verified; the claim is refuted and no digest can be computed' : ' — not yet created, so this document derives `impl: unbuilt`'));
    } else if (g.type === 'untracked') {
      add(WARN, 'governs-untracked', `governs: "${g.path}" exists on disk but is not tracked by git — it can never contribute to a digest, so this document can never reach verified while it is listed`);
    } else if (g.type === 'no-match') {
      add(WARN, 'governs-glob-empty', `governs: "${g.from}" matched no tracked file`);
    }
  }
  if (!doc.legacy && doc.governsDeclared.length === 0) {
    add(WARN, 'no-governs', 'no `governs:` set — this document makes no machine-checkable claim about code, so it can never be verified and can never be found stale');
  }

  // ── impl (derived; the stored value is a claim to be checked, never an input) ──────────────────
  const derived = deriveImpl(root, governed, { checkWiring });
  const digest = computeDigest(root, rel, text, governed);
  const storedDigest = doc.verifiedDigestStored;
  const digestMatch = digest.digest && storedDigest ? digest.digest === storedDigest : null;

  let impl = derived.impl;
  if (impl === 'wired' && storedDigest) impl = digestMatch ? 'verified' : 'verification-expired';
  doc.impl = impl;
  doc.implPerPath = derived.perPath;
  doc.digest = { computed: digest.digest, stored: storedDigest ?? null, match: digestMatch, reason: digest.reason ?? null };

  if (derived.unwired?.length) {
    add(WARN, 'built-not-wired',
      `no non-test, non-doc caller found for: ${derived.unwired.join(', ')} — built but apparently unreachable. WARNS only: hook-invoked and dynamically dispatched code is wired without a greppable caller.`);
  }
  if (storedDigest && digestMatch === false) {
    add(WARN, 'verification-expired',
      `verified_digest: ${storedDigest} no longer recomputes (now ${digest.digest ?? 'uncomputable'}) — the governed code or the document's own normative body has moved since anyone read them together`);
  }
  if (storedDigest && !digest.digest) {
    add(WARN, 'verification-uncomputable', `a verified_digest is stamped but the digest cannot be recomputed: ${digest.reason}`);
  }
  if (doc.verifiedStamp && !storedDigest) {
    add(BLOCK, 'verified-without-digest', 'a `verified:` date with no `verified_digest:` is a typeable stamp — exactly the class of claim this convention exists to replace');
  }
  if (doc.verifiedStamp && governed.length === 0) {
    add(BLOCK, 'verified-without-governs', 'verified against an empty governed set — verifies nothing and shows green');
  }

  // ADR-0024 applied to this file's own frontmatter: a stored status must never outrank what the
  // artifact supports. Overclaiming BLOCKS; understating WARNS (it is stale, not a lie).
  if (doc.implStored) {
    const storedRank = rank(doc.implStored);
    const derivedRank = rank(impl === 'verification-expired' ? 'built' : impl);
    if (!IMPL_LADDER.includes(doc.implStored)) {
      add(WARN, 'impl-unknown-value', `impl: ${doc.implStored} is not one of ${IMPL_LADDER.join('|')}`);
    } else if (storedRank > derivedRank) {
      add(BLOCK, 'impl-overclaimed',
        `impl: ${doc.implStored} but the artifact only supports "${impl}"${derived.missing?.length ? ` (missing: ${derived.missing.join(', ')})` : ''}${derived.unwired?.length ? ` (unwired: ${derived.unwired.join(', ')})` : ''} — a status the artifact refutes is void (ADR-0024)`);
    } else if (storedRank < derivedRank) {
      add(WARN, 'impl-understated', `impl: ${doc.implStored} but the artifact now supports "${impl}" — the stored value has fallen behind the code`);
    }
  }

  // ── drift ─────────────────────────────────────────────────────────────────────────────────────
  const drift = deriveDrift(root, rel, governed);
  doc.drift = drift;
  // A DECISION THAT IS NOT IN FORCE CANNOT DRIFT (ADR-056, 2026-07-27). Rejected / Superseded /
  // Deprecated documents describe a path NOT taken, or one another document has since taken over.
  // Their `governs:` set names code that was never meant to implement them, so "the governed code
  // moved and nobody re-checked" is not a defect — there is nothing to re-check against. Blocking a
  // push over it is a textbook false positive, and this file's own header names false positives as
  // the DESIGNED failure mode: "a gate that cries wolf gets bypassed and a bypassed gate protects
  // nothing." Found by ADR-046 and ADR-047 — both Rejected — sitting in the blocking set with
  // nothing an author could ever do to clear them short of deleting the record of a rejected idea.
  // Still REPORTED, never silent: a superseded document whose code moves is worth seeing, and the
  // day someone un-rejects it the finding returns to BLOCK on its own.
  const notInForce = /^(rejected|superseded|deprecated)$/i.test(statusWord || '');
  if (drift.state === 'presumed-stale') {
    add(notInForce ? WARN : BLOCK, 'presumed-stale',
      `governed code moved ${drift.commits} commit(s) (${drift.days}d) after the document's own last commit (${drift.docDate}) — nobody has checked since it moved. Paths: ${drift.paths.join(', ')}`
      + (notInForce ? ` — reported, NOT blocked: status "${statusWord}" means this decision is not in force, so it cannot drift from code it never governed` : ''));
  } else if (drift.state === 'lagging') {
    add(WARN, 'lagging', `governed code moved ${drift.commits} commit(s) after the document — normal within a session; reported, not blocked`);
  }

  // ── currency log ──────────────────────────────────────────────────────────────────────────────
  const log = parseCurrencyLog(root, text);
  doc.currencyLog = log;
  if (!doc.legacy && !log.present) {
    add(WARN, 'no-currency-log', 'no `## Currency log` section — the *why* of each change is unrecorded');
  }
  for (const row of log.rows) {
    if (!row.referents.length) {
      add(WARN, 'why-without-referent',
        `currency-log row ${row.date}: the *why* carries no resolvable referent (path / ADR id / commit sha / issue / dated quote) — "${row.why.slice(0, 60)}"`);
    }
  }
  if (doc.updated && log.rows.length && log.rows[0].date && log.rows[0].date !== doc.updated) {
    add(WARN, 'log-head-differs-from-updated', `updated: ${doc.updated} but the newest currency-log row is dated ${log.rows[0].date}`);
  }

  return doc;
}

export function evaluate(root = REPO_ROOT, opts = {}) {
  const dirs = opts.dirs ?? DEFAULT_DIRS;
  const docs = (opts.files ?? listDocs(root, dirs)).map((rel) => evaluateDoc(root, rel, opts));
  return { root, docs };
}

// ── --fix : backfill ONLY what git can prove ────────────────────────────────────────────────────
// The anti-goal is explicit and absolute: a reconstructed stamp is a fabricated number on a
// user-facing surface. Every value written here comes back out of `git log`, is labelled
// `*_source: derived-from-git`, and when git cannot answer, NOTHING is written and the gap is
// reported. `status:` is never written — it is a social fact no script may set. `impl:` is never
// written — it is derived on every read, and a stored copy is the lie this tool exists to catch.
export function planFix(root, doc) {
  const changes = [];
  const blocked = [];
  if (!doc.tracked) { blocked.push({ code: 'no-git-history', why: 'file has no commits — no date can be derived, and none will be invented' }); return { changes, blocked }; }

  if (!doc.date) {
    if (doc.addedCommit) changes.push({ key: 'date', value: doc.addedCommit.date, source: 'derived-from-git', evidence: `git log --follow --diff-filter=A ${doc.file} → ${doc.addedCommit.sha.slice(0, 8)}` });
    else blocked.push({ code: 'missing-created', why: 'git reports no adding commit for this path' });
  }
  if (!doc.updated) {
    if (doc.dirty) blocked.push({ code: 'missing-updated', why: 'working tree is modified — the last commit date is not the date of the current contents' });
    else if (doc.docCommit) changes.push({ key: 'updated', value: doc.docCommit.date, source: 'derived-from-git', evidence: `git log -1 ${doc.file} → ${doc.docCommit.sha.slice(0, 8)}` });
    else blocked.push({ code: 'missing-updated', why: 'git reports no commit touching this path' });
  } else if (!doc.updatedPinned && doc.findings.some((f) => f.code === 'stamp-lags-doc') && doc.docCommit && !doc.dirty) {
    changes.push({ key: 'updated', value: doc.docCommit.date, source: 'derived-from-git', replaces: doc.updated, evidence: `git log -1 ${doc.file} → ${doc.docCommit.sha.slice(0, 8)}` });
  }
  return { changes, blocked };
}

export function applyFix(root, doc, plan) {
  if (!plan.changes.length) return { written: false, changes: [] };
  const abs = path.join(root, doc.file);
  const text = fs.readFileSync(abs, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm.present) return { written: false, changes: [], skipped: 'no frontmatter to write into' };

  const lines = text.split('\n');
  const head = lines.slice(0, fm.endLine);     // '---' + keys
  const tail = lines.slice(fm.endLine);        // closing '---' onward

  for (const c of plan.changes) {
    const keyRe = new RegExp(`^${c.key}\\s*:`);
    const srcRe = new RegExp(`^${c.key}_source\\s*:`);
    const idx = head.findIndex((l) => keyRe.test(l));
    const line = `${c.key}: ${c.value}`;
    const srcLine = `${c.key}_source: ${c.source}`;
    if (idx >= 0) head[idx] = line; else head.push(line);
    const sIdx = head.findIndex((l) => srcRe.test(l));
    if (sIdx >= 0) head[sIdx] = srcLine; else head.splice((idx >= 0 ? idx : head.length - 1) + 1, 0, srcLine);
  }
  fs.writeFileSync(abs, [...head, ...tail].join('\n'));
  return { written: true, changes: plan.changes };
}

// ── reporting ───────────────────────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

export function renderReport({ root, docs }) {
  const out = [];
  out.push(`document currency — ${docs.length} document(s) under ${root}`);
  out.push('');
  out.push(`${pad('document', 46)} ${pad('status', 12)} ${pad('created', 11)} ${pad('updated', 11)} ${pad('impl', 21)} ${pad('drift', 15)} findings`);
  out.push('─'.repeat(140));
  for (const d of docs) {
    const b = d.findings.filter((f) => f.level === BLOCK).length;
    const w = d.findings.filter((f) => f.level === WARN).length;
    out.push([
      pad(d.file.replace(/^docs\//, ''), 46),
      pad(d.status ?? '—', 12),
      pad(d.date ?? '—', 11),
      pad(d.updated ?? '—', 11),
      pad(d.impl ?? 'unknown', 21),
      pad(d.drift?.state ?? '—', 15),
      `${b ? `${b} BLOCK` : ''}${b && w ? ' · ' : ''}${w ? `${w} warn` : ''}${!b && !w ? 'clean' : ''}`,
    ].join(' '));
  }
  out.push('');

  const withFindings = docs.filter((d) => d.findings.length);
  if (withFindings.length) {
    out.push('detail');
    out.push('─'.repeat(140));
    for (const d of withFindings) {
      out.push(`  ${d.file}`);
      for (const f of d.findings) out.push(`    [${f.level === BLOCK ? 'BLOCK' : ' warn'}] ${f.code}: ${f.message}`);
      out.push('');
    }
  }

  const blocks = docs.reduce((n, d) => n + d.findings.filter((f) => f.level === BLOCK).length, 0);
  const warns = docs.reduce((n, d) => n + d.findings.filter((f) => f.level === WARN).length, 0);
  const stamped = docs.filter((d) => d.updated).length;
  out.push(`summary: ${docs.length} documents · ${stamped} carry an \`updated:\` stamp · ${docs.length - stamped} do not (absent, NOT inferred from \`date:\`)`);
  out.push(`         ${blocks} blocking finding(s) · ${warns} warning(s)`);
  return out.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { mode: null, root: REPO_ROOT, dirs: null, strict: false, warnDrift: false, dryRun: false, json: false, changed: null, noWiring: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--report') a.mode = 'report';
    else if (v === '--check') a.mode = 'check';
    else if (v === '--fix') a.mode = 'fix';
    else if (v === '--json') { a.json = true; if (!a.mode) a.mode = 'report'; }
    else if (v === '--strict') a.strict = true;
    else if (v === '--warn-drift') a.warnDrift = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--no-wiring') a.noWiring = true;
    else if (v === '--root') a.root = path.resolve(argv[++i]);
    else if (v === '--changed') a.changed = argv[++i];
    else if (v === '--dir') a.dirs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!a.mode) a.mode = 'report';
  return a;
}

// Which findings actually stop a push. `--strict` promotes the judgement-shaped warnings; nothing
// promotes `built-not-wired`, whose false-negative rate is real and known.
export function blockingFindings(docs, { strict = false, warnDrift = false, scope = null } = {}) {
  const out = [];
  for (const d of docs) {
    if (scope && !scope.has(d.file)) continue;
    for (const f of d.findings) {
      let level = f.level;
      if (warnDrift && f.code === 'presumed-stale') level = WARN;
      if (strict && (f.code === 'why-without-referent' || f.code === 'legacy-unstamped' || f.code === 'no-governs')) level = BLOCK;
      if (strict && d.legacy && (f.code === 'missing-status' || f.code === 'missing-created' || f.code === 'missing-updated')) level = BLOCK;
      if (level === BLOCK) out.push({ file: d.file, ...f });
    }
  }
  return out;
}

// A changed-scope gate must follow the Document -> Governed set relationship in both directions.
// Looking only for directly touched ADR filenames lets code invalidate an ADR without evaluating it.
export function changedDocumentScope(docs, touched) {
  return new Set(docs
    .filter((d) => touched.has(d.file)
      || (d.governed ?? []).some((g) => g.resolved && touched.has(g.path)))
    .map((d) => d.file));
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (!isGitRepo(a.root)) {
    // FAIL OPEN, loudly. A gate that stops work because it could not read git is a gate people
    // switch off — and every value here is git-derived, so without git there is nothing to say.
    process.stderr.write(`[doc-currency] not a git repository: ${a.root} — nothing is derivable; passing.\n`);
    return 0;
  }

  const dirs = a.dirs ?? DEFAULT_DIRS;
  const result = evaluate(a.root, { dirs, checkWiring: !a.noWiring });

  let scope = null;
  if (a.changed) {
    const r = git(a.root, ['diff', '--name-only', `${a.changed}...HEAD`]);
    const touched = new Set(r.ok ? r.out.split('\n').filter(Boolean) : []);
    scope = changedDocumentScope(result.docs, touched);
  }

  if (a.mode === 'fix') {
    const applied = [];
    for (const d of result.docs) {
      const plan = planFix(a.root, d);
      if (!plan.changes.length && !plan.blocked.length) continue;
      for (const c of plan.changes) {
        process.stdout.write(`${a.dryRun ? '[would fix]' : '[fixed]   '} ${d.file}: ${c.key} = ${c.value} (derived-from-git; ${c.evidence})\n`);
      }
      for (const b of plan.blocked) {
        process.stdout.write(`[cannot]   ${d.file}: ${b.code} — ${b.why}. NOT invented.\n`);
      }
      if (!a.dryRun) applied.push(applyFix(a.root, d, plan));
    }
    process.stdout.write(`\n${a.dryRun ? 'dry run — nothing written' : `${applied.filter((x) => x.written).length} document(s) updated`}. Dates are only ever copied out of git; nothing is reconstructed.\n`);
    return 0;
  }

  if (a.json) {
    process.stdout.write(JSON.stringify({
      root: result.root,
      recipe: DIGEST_RECIPE,
      docs: result.docs.map((d) => ({
        file: d.file, id: d.id, legacy: d.legacy, status: d.status, date: d.date, updated: d.updated,
        implStored: d.implStored, impl: d.impl, digest: d.digest, drift: d.drift,
        governs: d.governsDeclared, findings: d.findings,
      })),
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(result) + '\n');
  }

  if (a.mode !== 'check') return 0;

  const blocking = blockingFindings(result.docs, { strict: a.strict, warnDrift: a.warnDrift, scope });
  if (!blocking.length) {
    process.stderr.write('[doc-currency] no blocking currency violations.\n');
    return 0;
  }
  process.stderr.write(`\n[doc-currency] ${blocking.length} BLOCKING violation(s):\n`);
  for (const f of blocking) process.stderr.write(`  ${f.file}: ${f.code} — ${f.message}\n`);
  process.stderr.write('\nFix: `node scripts/doc-currency.mjs --fix` backfills the dates git can prove.\n'
    + 'Everything else is a claim only a human can make — including `status:`, which no script may set.\n');
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());
