#!/usr/bin/env node
// memory-doctor.mjs — does this project's AgentDB actually LEARN, or does it just record?
//
// WHY THIS EXISTS (2026-07-14). For two days I told Stuart "AgentDB is fixed / verified / 33 of 33."
// It was never fixed, and I never lied — I ran a check that COULD NOT FAIL:
//     ruflo memory store  ->  ruflo memory search  ->  got a row back  ->  "healthy"
// That exercises `memory_entries`, a key-value table with an HNSW index. It says NOTHING about
// whether anything is embedded, distilled, or learned. It would pass on a database with the entire
// intelligence substrate surgically removed — which is exactly the database most of his projects have.
//
// LIVENESS IS NOT HEALTH. This file is the referee that makes that distinction impossible to fudge.
//
// THE ROOT CAUSE IT FOUND (measured, not theorised):
//   memory_entries.embedding is NULL for ~99% of rows in most projects.
//     ruvnet-brain          1,023 entries · 99.8% embedded ->   456 patterns   (learns)
//     ugo-ai-register-now   7,214 entries ·  100% embedded -> 3,610 patterns   (learns)
//     AMBUILANCE_INVENTORY 11,133 entries ·  0.03% embedded ->     1 pattern    (dead)
//     flighttest           19,108 entries ·   0.3% embedded ->    12 patterns   (dead)
//   No embedding -> no semantic recall AND nothing for distill to consume (ADR-174 explicitly skips
//   rows with no parseable vector) -> no patterns -> no episodes -> no intelligence. The whole chain
//   snaps at the first link.
//
//   And the rows are unembedded because of WHO WRITES THEM: namespaces `hooks:pre-bash`,
//   `hooks:post-bash`, `command-history`, `command-results`, `performance-metrics` — telemetry
//   emitted by the `npx @claude-flow/cli hooks pre-command/post-command` calls wired into ~190 hooks
//   across 16 projects. Five unembedded rows per Bash command. They bury the real memories under
//   thousands of rows of "I ran a command", none of it recallable or distillable.
//
// GROUNDED IN rUv's SOURCE (not invented here):
//   ruflo/v3/docs/adr/ADR-174-memory-distillation-self-optimization.md  (ACCEPTED) — the
//     RETRIEVE->JUDGE->DISTILL->CONSOLIDATE pipeline, and the finding that the substrate was empty
//     because the consolidate worker was a stub. rUv hit this exact wall and shipped `memory distill`.
//   agentdb/src/controllers/ReflexionMemory.ts — storeEpisode()/retrieveRelevant()/getCritiqueSummary().
//     Its retrieval INNER-JOINs episode_embeddings, which is empty everywhere, so reflexion recall
//     currently returns nothing on every project. That is a SEPARATE layer from ADR-174 distillation;
//     do not conflate them (I did, and had to retract it).
//
// This tool DIAGNOSES ONLY. It opens every database read-only and writes nothing, anywhere.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, pathIdentity } from './project-identity.mjs';

const HOME = os.homedir();
const DEFAULT_SCAN_ROOTS = ['Code', 'code', 'src', 'source', 'projects', 'dev', 'work'];

// Telemetry namespaces: high-volume, unembedded, zero-signal. Written by the npx hook calls.
// Counted separately so "you have 11,000 memories" is never mistaken for "you have 11,000 lessons".
const NOISE_NS = new Set([
  'hooks:pre-bash', 'hooks:post-bash', 'hooks:pre-edit', 'hooks:post-edit',
  'command-history', 'command-results', 'performance-metrics', 'notifications',
]);

// A doctor that cannot tell "the patient is dead" from "I could not find the patient" is worse than
// no doctor. The FIRST version of this function swallowed every sqlite error and returned 0 — so a
// database it could not even OPEN (spaces in the path broke the file: URI) was reported as
// "0 memories, 0 patterns", indistinguishable from a genuinely empty store. That is the exact
// can't-fail check this whole file exists to abolish, reproduced inside it. Caught by running it.
//
// Now: every query returns {ok, value} or {ok:false, err}. Unreadable is UNKNOWN, never zero, and
// UNKNOWN is reported loudly rather than averaged into a reassuring number.
// `mode=ro` ALONE CANNOT OPEN A RESTING WAL DATABASE, and that is not an edge case — it is the normal
// state of every store nobody is currently using. A WAL database needs its -shm shared-memory segment
// to be read, and a read-only connection is not allowed to create one, so SQLite returns CANTOPEN(14).
//
// MEASURED (fresh WAL db, same file, three ways):
//     sidecars removed + mode=ro              -> Error: unable to open database file (14)
//     sidecars present + mode=ro              -> 1
//     sidecars removed + mode=ro&immutable=1  -> 1, and `ls` shows no -wal/-shm created
//
// This was live on the owner's own machine while it shipped: `.swarm/memory.db-{shm,wal}` had been
// renamed `.CORRUPT-20260714-144824`, so every single read of the repo's 16MB store returned
// unreadable, and the console reported memory distillation as permanently UNKNOWN on a healthy store.
// Three retries two seconds apart cannot fix a structural refusal; they just make it slow.
//
// `immutable=1` is GATED, because it promises SQLite the file will not change underneath it — a
// promise nobody can keep about a database with a live writer, and breaking it returns torn or
// stale rows rather than an error. So it is used ONLY when both sidecars are absent, which is the
// observable signature of "no process has this open in WAL mode", and the absence is re-checked
// AFTER the read so a writer that arrived mid-flight invalidates the result instead of being
// reported as fact. A locked store still yields an honest unreadable.
const walSidecarsPresent = (db) => fs.existsSync(`${db}-wal`) || fs.existsSync(`${db}-shm`);

const q = (db, sql) => {
  // encodeURI, not raw interpolation: "Helix - Personal Health Intelligence Platform" has spaces,
  // and sqlite3 rejects the URI outright (error 14) rather than falling back to a plain path.
  const base = `file:${encodeURI(db)}?mode=ro`; // read-only: this process will never be a second writer
  const run = (uri) => execFileSync('sqlite3', [uri, sql], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  // MODE IS CHOSEN BEFORE THE OPEN, FROM A FACT ON DISK — NOT AFTER CATCHING WHICHEVER ERROR A
  // GIVEN SQLITE BUILD HAPPENS TO THROW. This used to try plain `mode=ro` first and only add
  // `immutable=1` after catching "unable to open database file (14)". CONFIRMED LIVE 2026-07-26
  // (Docker ubuntu:24.04, apt sqlite3 3.45.1 — the exact version this repo's "check" CI job
  // installs): on a resting WAL db with no sidecars, plain `mode=ro` does NOT throw there the way
  // macOS's bundled 3.51.0 does — it succeeds AND silently vivifies `-shm`/`-wal` as a side effect
  // of establishing WAL-index shared memory for the reader. No exception meant the catch block's
  // sidecar check — the only place this was ever guarded — never ran, so a "read-only" diagnosis
  // left litter in the caller's directory on every ubuntu CI run.
  //
  // The fix does not depend on which behavior a given SQLite build has. It decides the mode from a
  // fact available before either would be attempted: do the sidecars already exist?
  //   - present -> a live/resting WAL with real frames; open plain `mode=ro` and let a genuine
  //     pending WAL be read normally (immutable=1 here would be a promise we cannot make).
  //   - absent  -> nothing to replay; open `mode=ro&immutable=1` STRAIGHT AWAY — the one mode both
  //     measured SQLite builds leave clean. Plain mode=ro never gets the chance to vivify a -shm
  //     file nobody asked for.
  const restingWal = fs.existsSync(db) && !walSidecarsPresent(db);
  const uri = restingWal ? `${base}&immutable=1` : base;

  try {
    const value = run(uri);
    // Belt and suspenders for a third SQLite build we have not measured: a read that started with
    // no sidecars must end with no sidecars. If one appeared anyway — a fresh concurrent writer, or
    // another version-specific quirk — the bytes just read cannot be trusted, and this read's own
    // litter is removed rather than left in the caller's directory.
    if (restingWal && walSidecarsPresent(db)) {
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(`${db}${suffix}`); } catch { /* best-effort cleanup only */ }
      }
      return { ok: false, err: 'a writer opened the store mid-read' };
    }
    return { ok: true, value, viaImmutable: restingWal || undefined };
  } catch (e) {
    const err = String(e.stderr || e.message || '');
    // "no such table/column" is SCHEMA VARIANCE (an older store) — a real, reportable fact.
    if (/no such (table|column)/.test(err)) return { ok: true, value: null, missing: true };
    // Anything else means we could not read the database, and we must say so, not guess zero.
    return { ok: false, err: err.split('\n')[0].slice(0, 60) };
  }
};
// n() returns null for "unknown" and a number only when we genuinely counted. Callers must handle null.
const n = (r) => (r.ok ? (r.value === null || r.value === '' ? null : parseInt(r.value, 10)) : null);

export function candidateRoots({
  home = HOME,
  configPath = path.join(home, '.claude', 'ruvnet-brain', 'config.json'),
} = {}) {
  let configured = [];
  let configuredCount = 0;
  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (Array.isArray(value.scanRoots)) {
      configuredCount = value.scanRoots.length;
      configured = value.scanRoots.filter((item) => typeof item === 'string' && item.trim());
    }
  } catch { /* absent or malformed config does not erase the common roots */ }

  // Keyed by pathIdentity, not by the spelling. DEFAULT_SCAN_ROOTS deliberately lists both `Code`
  // and `code` so neither convention is missed, and on a case-insensitive volume those are ONE
  // directory — which the old Set-of-strings admitted twice and then scanned, counted and summed
  // twice (#107). On a case-sensitive volume they are two inodes and both are still kept.
  const roots = new Map();
  const addRoot = (value) => {
    const absolute = path.isAbsolute(value) ? value : path.join(home, value);
    const canonical = canonicalPath(absolute);
    try {
      if (canonical && fs.statSync(canonical).isDirectory()) {
        const identity = pathIdentity(canonical) ?? canonical;
        if (!roots.has(identity)) roots.set(identity, canonical);
        return true;
      }
    } catch { /* missing/non-directory roots are not candidates on this machine */ }
    return false;
  };
  for (const value of DEFAULT_SCAN_ROOTS) addRoot(value);
  let validConfigured = 0;
  for (const value of configured) {
    if (addRoot(value)) validConfigured += 1;
  }
  if (configuredCount > 0 && validConfigured === 0) {
    throw new Error('configured scanRoots contain no existing directories');
  }
  return [...roots.values()].sort();
}

// Keyed by pathIdentity for the same reason candidateRoots is: one store reached by two names is
// one store. Values are the canonical spelling, which is what every caller reads back.
function storesBelow(root) {
  const out = new Map();
  const canonicalRoot = canonicalPath(root);
  if (!canonicalRoot) return out;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.name === '.swarm') {
        const db = path.join(dir, '.swarm/memory.db');
        const canonical = canonicalPath(db);
        if (canonical) out.set(pathIdentity(canonical) ?? canonical, canonical);
        continue;
      }
      if (e.name.startsWith('.') && e.name !== '.swarm') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(canonicalRoot, 0);
  return out;
}

export function findStores(root) {
  const out = new Map();
  const collect = (found) => { for (const [identity, db] of found) if (!out.has(identity)) out.set(identity, db); };
  if (root !== undefined) {
    collect(storesBelow(root));
    return [...out.values()].sort();
  }

  for (const candidate of candidateRoots()) collect(storesBelow(candidate));
  // These two stores intentionally sit outside the project-root convention. They belong only to
  // the fleet-wide no-argument scan; an explicit root must remain genuinely scoped.
  for (const extra of [path.join(HOME, '.claude/.swarm/memory.db'), path.join(HOME, 'cognitum-trader/.swarm/memory.db')]) {
    const canonical = canonicalPath(extra);
    if (canonical) collect([[pathIdentity(canonical) ?? canonical, canonical]]);
  }
  return [...out.values()].sort();
}

export function displayStoreName(db, home = HOME) {
  const canonicalDb = canonicalPath(db) || path.resolve(db);
  const project = path.dirname(path.dirname(canonicalDb));
  const canonicalHome = canonicalPath(home) || path.resolve(home);
  const relative = path.relative(canonicalHome, project);
  if (relative === '') return '~';
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return project;
}

export function diagnose(db) {
  const name = displayStoreName(db);

  const ic = q(db, 'PRAGMA integrity_check;');
  if (!ic.ok) {
    // UNREADABLE is its own verdict. It is NOT "empty". Reporting it as zero was the bug.
    return { name, db, unreadable: ic.err, findings: [`UNREADABLE: ${ic.err}`], learns: false };
  }
  const integrity = (ic.value || '').split('\n')[0] || 'unknown';

  const total = n(q(db, 'SELECT count(*) FROM memory_entries;'));
  const embedded = n(q(db, "SELECT count(*) FROM memory_entries WHERE embedding IS NOT NULL AND length(embedding)>0;"));
  const nsRes = q(db, 'SELECT namespace, count(*) FROM memory_entries GROUP BY namespace;');
  const nsRows = (nsRes.value || '').split('\n').filter(Boolean).map((l) => l.split('|'));
  const noise = nsRows.filter(([ns]) => NOISE_NS.has(ns)).reduce((a, [, c]) => a + (parseInt(c, 10) || 0), 0);
  const real = total === null ? null : total - noise;

  const patterns = n(q(db, 'SELECT count(*) FROM reasoning_patterns;'));
  const patternEmb = n(q(db, 'SELECT count(*) FROM pattern_embeddings;'));
  const episodes = n(q(db, 'SELECT count(*) FROM episodes;'));
  const epEmb = n(q(db, 'SELECT count(*) FROM episode_embeddings;'));
  const critiques = n(q(db, 'SELECT count(critique) FROM episodes;'));
  const skills = n(q(db, 'SELECT count(*) FROM skills;'));
  const promoted = n(q(db, 'SELECT count(*) FROM reasoning_patterns WHERE promoted=1;')); // absent in older schemas -> null

  // A store with no memory_entries table at all is a DIFFERENT thing from an empty one. Say which.
  if (total === null) {
    return { name, db, integrity, schemaless: true,
             findings: ['no memory_entries table — pre-AgentDB schema, never initialised'], learns: false };
  }

  const cover = total ? embedded / total : 0;
  const distilled = real ? patterns / real : 0;

  // Each finding names the ONE thing that is false, in the order the chain breaks. A doctor that
  // lists twelve symptoms teaches nothing; the first broken link is the only one worth fixing today.
  const findings = [];
  if (integrity !== 'ok') findings.push(`CORRUPT (${integrity})`);
  if (total === 0) findings.push('no memories at all');
  else if (cover < 0.5) findings.push(`only ${(cover * 100).toFixed(1)}% embedded — nothing can be recalled or distilled`);
  else if (patterns === 0) findings.push('embedded but never distilled — run: ruflo memory distill run');
  else if (distilled < 0.05) findings.push(`${patterns} patterns from ${real} real memories — distill barely ran`);
  if (noise > real && noise > 500) findings.push(`${noise} telemetry rows from npx hooks bury ${real} real memories`);
  if (episodes > 0 && epEmb === 0) findings.push('reflexion recall dead (0 episode_embeddings — INNER JOIN returns nothing)');
  if (episodes > 0 && critiques === 0) findings.push('0 critiques — episodes carry no lessons');

  const learns = cover >= 0.5 && patterns > 0 && distilled >= 0.05;
  return { name, db, integrity, total, embedded, cover, noise, real, patterns, patternEmb,
           episodes, epEmb, critiques, skills, promoted, distilled, findings, learns };
}

// Does this project wire `npx <claude-flow|ruvector>` into its tool-use hooks? Those hooks write
// telemetry rows (hooks:pre-bash, command-history, ...) with no embedding. THE PREDICTION THIS TESTS:
// if they are the cause of dead memory, then hooked projects should be dead and unhooked ones alive.
// If a single project breaks that correlation, the theory is wrong and must be discarded.
export function hasNpxHooks(db) {
  const projDir = path.dirname(path.dirname(db));
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const p = path.join(projDir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      const hooks = JSON.stringify(s.hooks || {});
      if (/npx\s+(-y\s+)?(@?claude-flow|ruvector|aqe)/.test(hooks)) return true;
    } catch { /* unparseable settings — cannot claim either way */ }
  }
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('memory-doctor.mjs')) {
  const stores = findStores();
  const rows = stores.map((db) => ({ ...diagnose(db), npxHooks: hasNpxHooks(db) }));
  const w = Math.min(34, Math.max(...rows.map((r) => r.name.length), 8));
  const readable = rows.filter((r) => !r.unreadable && !r.schemaless);

  console.log(`\n  AgentDB fleet — ${rows.length} stores found\n`);
  console.log(`  ${'PROJECT'.padEnd(w)} ${'MEMORIES'.padStart(9)} ${'EMBED%'.padStart(7)} ${'NOISE'.padStart(7)} ${'PATTERNS'.padStart(8)} ${'npx?'.padStart(5)}  LEARNS?`);
  console.log(`  ${'-'.repeat(w)} ${'-'.repeat(9)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(8)} ${'-'.repeat(5)}  -------`);
  for (const r of readable.sort((a, b) => b.total - a.total)) {
    if (r.total === 0) continue;
    const pct = (r.cover * 100).toFixed(1) + '%';
    console.log(`  ${r.name.slice(0, w).padEnd(w)} ${String(r.total).padStart(9)} ${pct.padStart(7)} ${String(r.noise).padStart(7)} ${String(r.patterns).padStart(8)} ${(r.npxHooks ? 'YES' : 'no').padStart(5)}  ${r.learns ? 'yes' : 'NO'}`);
  }

  // THE FALSIFICATION TEST — stated before the answer is known, so it can actually fail.
  const withMem = readable.filter((r) => r.total >= 50);
  const hookedDead = withMem.filter((r) => r.npxHooks && !r.learns).length;
  const hookedAlive = withMem.filter((r) => r.npxHooks && r.learns).length;
  const cleanAlive = withMem.filter((r) => !r.npxHooks && r.learns).length;
  const cleanDead = withMem.filter((r) => !r.npxHooks && !r.learns).length;
  console.log(`\n  HYPOTHESIS: the npx tool-use hooks cause dead memory (unembedded telemetry floods the store).`);
  console.log(`  ${'npx hooks + DEAD memory  (predicted)'.padEnd(42)} ${hookedDead}`);
  console.log(`  ${'npx hooks + LIVE memory  (CONTRADICTS)'.padEnd(42)} ${hookedAlive}`);
  console.log(`  ${'no hooks  + LIVE memory  (predicted)'.padEnd(42)} ${cleanAlive}`);
  console.log(`  ${'no hooks  + DEAD memory  (CONTRADICTS)'.padEnd(42)} ${cleanDead}`);
  const contra = hookedAlive + cleanDead;
  console.log(`  => ${contra === 0 ? 'hypothesis SURVIVES: no contradicting project' : `hypothesis is INCOMPLETE: ${contra} project(s) contradict it — the npx hooks are NOT the whole story`}`);

  const unreadable = rows.filter((r) => r.unreadable);
  const schemaless = rows.filter((r) => r.schemaless);
  if (unreadable.length) { console.log(`\n  UNREADABLE (NOT "empty" — we could not open these):`); unreadable.forEach((r) => console.log(`    ${r.name} — ${r.unreadable}`)); }
  if (schemaless.length) console.log(`\n  no memory_entries table (never initialised): ${schemaless.length}`);

  const dead = readable.filter((r) => !r.learns && r.total > 0);
  console.log(`\n  ${readable.filter((r) => r.learns).length} of ${readable.filter((r) => r.total > 0).length} populated stores actually learn. ${dead.length} record and forget.\n`);
  for (const r of dead.slice(0, 10)) console.log(`  ${r.name}\n     - ${r.findings.join('\n     - ')}`);

  // Non-zero when the fleet is not learning: no scheduled job — and no assistant — can ever again
  // call this "verified" unless the numbers actually agree.
  process.exit(dead.length || unreadable.length ? 1 : 0);
}
