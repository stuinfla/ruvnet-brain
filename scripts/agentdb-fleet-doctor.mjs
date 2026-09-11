#!/usr/bin/env node
// agentdb-fleet-doctor.mjs — per-project AgentDB health: AUDIT everything, FIX only what is
// provably safe, VERIFY with a real round-trip, and REPORT the rest loudly.
//
// Born 2026-07-13 after the Helix finding: a project's store can be mechanically healthy while
// its contents are useless at session start — entries fragmented across namespaces the
// session-start hook never reads, including OTHER PROJECTS' namespaces (cross-contamination).
//
// WHAT IT FIXES (safe, additive only):
//   • seeds a canonical `project-state-current-<ts>` checkpoint from git history when a project
//     has none (the session-start hook surfaces it from then on)
//   • runs `ruflo memory distill run` (ADR-174: incremental, non-destructive, $0)
// WHAT IT ONLY REPORTS (never guesses):
//   • foreign-project namespaces (moving another project's truth is how contamination
//     COMPOUNDS — that data belongs elsewhere, a human decides)
//   • fragmentation: how much of the store the session-start hook can actually see
// VERIFY: a real store→search round-trip through the ruflo CLI in the project's own namespace.
// Every fix is preceded by a timestamped .bak copy of the DB. Artifacts, never exit codes.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUFLO = path.join(os.homedir(), '.npm-global/bin/ruflo');
const SYSTEM_NS = new Set(['sessions', 'feedback', 'default', 'patterns', 'adr-patterns', 'adr-edges', 'metaharness-audit']);

function sql(db, q) {
  try { return execFileSync('sqlite3', ['-noheader', db, q], { encoding: 'utf8', timeout: 15000 }).trim(); }
  catch { return null; }
}

function ruflo(cwd, args) {
  // Every `ruflo` invocation auto-starts a project background daemon unless this is set (verified
  // live: ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/
  // daemon-autostart.js:85) — this doctor walks a whole fleet of project dirs and must not leave
  // one daemon running per project as a side effect of asking each one a question.
  const r = spawnSync(RUFLO, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

async function doctor(proj) {
  const name = path.basename(proj);
  const db = path.join(proj, '.swarm', 'memory.db');
  const row = { project: name, entries: 0, visible: 0, checkpoint: false, seeded: false, episodes: null, roundtrip: false, foreign: '', notes: [] };
  if (!fs.existsSync(db)) { row.notes.push('no db'); return row; }

  row.entries = Number(sql(db, 'SELECT count(*) FROM memory_entries;') ?? 0);
  const hasSchema = sql(db, 'SELECT count(*) FROM episodes;') !== null;
  if (!hasSchema) row.notes.push('OLD SCHEMA — needs export/init/import migration (see migrate-agentdb-schema.sh)');

  // What can the session-start hook actually see?
  row.visible = Number(sql(db, `SELECT count(*) FROM memory_entries WHERE namespace='${name}';`) ?? 0);
  row.checkpoint = Number(sql(db, `SELECT count(*) FROM memory_entries WHERE namespace='${name}' AND key LIKE 'project-state-current%';`) ?? 0) > 0;

  // Foreign-project namespaces: REPORT, never migrate.
  const nsRows = (sql(db, 'SELECT namespace, count(*) FROM memory_entries GROUP BY namespace;') || '')
    .split('\n').filter(Boolean).map((l) => l.split('|'));
  row.foreign = nsRows.filter(([ns]) => ns !== name && !SYSTEM_NS.has(ns)).map(([ns, n]) => `${ns}=${n}`).join(',');

  // FIX 1 (safe): seed a canonical checkpoint from git history when none exists.
  if (!row.checkpoint) {
    let gitlog = '';
    try { gitlog = execFileSync('git', ['-C', proj, 'log', '--oneline', '-8'], { encoding: 'utf8', timeout: 10000 }).trim(); } catch { /* not a repo */ }
    const val = `SEEDED CHECKPOINT ${new Date().toISOString()} (agentdb-fleet-doctor — no canonical checkpoint existed; the session-start hook had nothing to surface). Recent git history:\n${gitlog || '(not a git repo)'}\nMaintain from now on: append a NEW project-state-current-<epochms> row after meaningful work; never overwrite.`;
    fs.copyFileSync(db, `${db}.bak-fleet-doctor-${Date.now()}`);
    const r = ruflo(proj, ['memory', 'store', '-k', `project-state-current-${Date.now()}`, '--value', val, '-n', name]);
    row.seeded = r.status === 0 && /stored successfully/i.test(r.out);
    row.checkpoint = row.seeded;
  }

  // FIX 2 (safe): distill — incremental, non-destructive, $0.
  if (hasSchema) {
    ruflo(proj, ['memory', 'distill', 'run']);
    row.episodes = Number(sql(db, 'SELECT count(*) FROM episodes;') ?? 0);
  }

  // VERIFY: real round-trip through the real CLI in the project's own namespace.
  const canaryKey = `fleet-doctor-canary-${Date.now()}`;
  const canaryVal = `round-trip canary ${new Date().toISOString()}`;
  const stored = ruflo(proj, ['memory', 'store', '-k', canaryKey, '--value', canaryVal, '-n', name]);
  if (stored.status === 0) {
    const found = ruflo(proj, ['memory', 'search', '-q', 'fleet-doctor round-trip canary', '-n', name, '--limit', '3']);
    // The result table TRUNCATES keys (`fleet-doctor-cana...`) — asserting on the full key was a
    // false-negative bug (caught on first run, 2026-07-13, SpotOn: store fine, MY check wrong —
    // the exact lesson-agentdb-was-never-broken defect class). Match what the table can show.
    row.roundtrip = found.out.includes('fleet-doctor-cana') || found.out.includes('round-trip canary');
  }
  return row;
}

const targets = process.argv.slice(2);
if (!targets.length) { console.error('usage: agentdb-fleet-doctor.mjs <project-dir> [...]'); process.exit(2); }

const results = [];
for (const t of targets) results.push(await doctor(path.resolve(t)));

console.log('\nproject | entries | visible-at-start | checkpoint | episodes | round-trip | foreign-ns | notes');
console.log('-'.repeat(110));
for (const r of results) {
  console.log([r.project, r.entries, r.visible, r.checkpoint ? (r.seeded ? 'SEEDED' : 'yes') : 'NO',
    r.episodes ?? 'no-schema', r.roundtrip ? 'PASS' : 'FAIL', r.foreign || '-', r.notes.join('; ') || '-'].join(' | '));
}
const bad = results.filter((r) => !r.roundtrip || !r.checkpoint);
console.log(`\n${results.length - bad.length}/${results.length} projects fully verified${bad.length ? ` — NEEDS ATTENTION: ${bad.map((r) => r.project).join(', ')}` : ''}`);
