#!/usr/bin/env node
/**
 * lesson-bridge.mjs — carry AgentDB's machine-wide lessons into the gate that already fires.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE MEASURED GAP (2026-08-10, on the owner's own machine — not hypothetical).
 *
 * This project has TWO stores of "what we learned", and until this file they were not connected by
 * anything. A grep for a reader proved it: no lesson-* script referenced `.swarm/memory.db`.
 *
 *     ~/.config/ruvnet-brain/lessons.json               17 lessons   → reaches lesson-gate → the model
 *     ~/.claude/global-memory/.swarm/memory.db (global) 33 lessons   → reaches NOTHING
 *
 * The 33 are the EXPENSIVE ones. Global memory is Tier 1 of the promotion ladder: a lesson only
 * lands there after it has been independently rediscovered in more than one project (ruflo ADR-G008,
 * "win twice to promote"). They are, by construction, the lessons that generalise — and they were
 * the ones with no way to speak.
 *
 * What that cost, concretely. `lesson-tests-that-cannot-fail-on-broken-code` has been in the global
 * store since 2026-07-21: "WOULD THIS TEST FAIL IF THE THING IT GUARDS WERE BROKEN? Prove it by
 * breaking the code and watching it fail." On 2026-08-08 this repo shipped issue #122's guard as a
 * test piping /dev/null, where stdin EOF made the enabled and disabled cases BOTH exit 0 — a test
 * that could not fail, written 18 days after the lesson that names that exact mistake was recorded.
 * The knowledge was on the machine. Nothing put it in front of the decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A BRIDGE AND NOT A NEW GATE.
 *
 * The reflex this repo has to unlearn is answering every incident with another gate; 47% of its 76
 * issues are gates that cannot pass or surfaces that state something false (ADR-065). So this adds
 * ZERO hooks, ZERO matchers, and ZERO new decision points. It feeds the pipeline that already exists
 * and is already proven live:
 *
 *     AgentDB global store ─▶ [this file] ─▶ lessons.json ─▶ lesson-gate ─▶ unprompted-runtime ─▶ model
 *                                            (unchanged)     (unchanged)    (the ONE chokepoint)
 *
 * Everything downstream — frequency cap, project scope, nudge-not-block, the ADR-040 chokepoint that
 * is the sole writer of user bytes — applies to a bridged lesson exactly as to a native one, because
 * a bridged lesson IS a native one by the time anything reads it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TRIGGER LIVES ON THE ROW, NOT IN A SIDE-FILE. This is the design decision worth defending.
 *
 * A lesson with no trigger is prose (lesson-store.mjs says so, and refuses it). So bridging needs a
 * trigger per lesson, and the obvious implementations are both wrong:
 *
 *   • CLASSIFY THE TEXT — a keyword mapper guessing "this one is about writing code". ADR-065 was
 *     written three hours earlier about exactly this: its own 17/0 split came from a keyword
 *     classifier and spot-checking immediately found a false positive. Guessing which moment a rule
 *     belongs to is how you get a rule that fires at the wrong moment, which is worse than silence.
 *   • A SEPARATE MANIFEST FILE — a second file naming the same rows. That is the disease: two places
 *     holding one fact, drifting the first time a lesson is added to one and not the other.
 *
 * So the trigger is a TAG ON THE AGENTDB ROW ITSELF, using rUv's own structured fields:
 *
 *     ruflo memory store --path ~/.claude/global-memory/.swarm/memory.db -n global \
 *       -k "lesson-tests-that-cannot-fail-on-broken-code" --value "<text>" \
 *       --tags "trigger:write-code,enforce:inject" --provenance user_claim
 *
 * One fact, one place, carried by the store that already owns the lesson. This is
 * `lesson-govern-at-structured-boundaries` — "when you find yourself parsing an unstructured string
 * to enforce a rule, you have chosen the wrong boundary" — applied to the bridge itself.
 *
 * AN UNTAGGED LESSON DOES NOT BRIDGE, AND IS REPORTED BY NAME. Silence would read as "that is all
 * there is", which is the same lie as a truncated list. Tagging is the human act of saying "this one
 * should interrupt me, here"; nothing enters enforcement because a machine thought it fit.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TRUST BOUNDARY IS NOT WIDENED. A bridged lesson carries origin `imported` unless the row's own
 * `provenance` column says `user_claim`, and makeLesson REFUSES `enforcement:block` on anything that
 * is not `user-stated`. Blocking additionally requires the opt-in file the mining pipeline never
 * writes. So the worst a planted global row can achieve, even if tagged, is an advisory the user sees
 * and can delete — never a refusal of their work.
 *
 * FAIL-SAFE, in both directions:
 *   • no global store / no sqlite / unreadable → 0 bridged, exit 0, nothing written. A machine
 *     without global memory (every fresh install) sees no change at all.
 *   • zero candidates found → REFUSES to write, so a transient read failure can never silently strip
 *     lessons that are already in the store. Removal is explicit: --prune.
 *
 *   node plugin/scripts/lesson-bridge.mjs             # report only — what would bridge, and what is untagged
 *   node plugin/scripts/lesson-bridge.mjs --apply     # merge into lessons.json (locked, atomic, backed up)
 *   node plugin/scripts/lesson-bridge.mjs --json      # machine-readable
 *   node plugin/scripts/lesson-bridge.mjs --apply --prune   # allow removing bridged rows when none remain
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeLesson, updateLessons, loadLessons, ENFORCEMENT, ORIGIN, STATUS, TRIGGERS } from './lesson-store.mjs';

/** Every bridged lesson id starts with this. It is how a merge knows which rows it owns. */
export const BRIDGE_PREFIX = 'G-';
/** Project-tier ids. Distinct prefix so a merge can own both sets without confusing them. */
export const PROJECT_PREFIX = 'P-';
/** Any id this bridge owns and may replace wholesale on the next run. */
export const isBridged = (id) => String(id).startsWith(BRIDGE_PREFIX) || String(id).startsWith(PROJECT_PREFIX);

const GLOBAL_DB = process.env.RUVNET_GLOBAL_MEMORY_DB
  || path.join(os.homedir(), '.claude', 'global-memory', '.swarm', 'memory.db');
const GLOBAL_NS = process.env.RUVNET_GLOBAL_MEMORY_NS || 'global';

/**
 * THE PROJECT TIER (ADR-067). Global memory holds lessons that already won twice; a project's own
 * `.swarm/memory.db` holds the ones learned HERE. Both are knowledge with no way to speak, and the
 * bridge was reading only one of them.
 *
 * The difference that matters is SCOPE, and lesson-gate already enforces it: a lesson carrying
 * `projects: [name]` speaks only in that project, while an unscoped one speaks anywhere. So a global
 * row bridges unscoped and a project row bridges scoped to its own directory — no new mechanism, the
 * existing `isHome` check does the work. Without that, a ruvnet-brain lesson would interrupt someone
 * working in a different repo, which is precisely the breakage recorded in lesson-gate.mjs on
 * 2026-07-22: "I've got other repos that are using this thing, and they're breaking."
 */
const PROJECT_DB = process.env.RUVNET_PROJECT_MEMORY_DB
  || path.join(process.cwd(), '.swarm', 'memory.db');

const TRIGGER_KEYS = new Set(Object.values(TRIGGERS).map((t) => t.key));
const ENFORCEMENTS = new Set(Object.values(ENFORCEMENT));

// ── Reading the store ────────────────────────────────────────────────────────────────────────────
// node:sqlite is preferred: in-process, no shell, exact bytes, no quoting hazard on multi-paragraph
// lesson text. It is stable on Node 22.5+/24 but absent on older runtimes, so the sqlite3 CLI is the
// fallback — and if neither exists this returns [] and the whole bridge becomes a no-op rather than
// an error. A tool that fails loudly on a machine that simply has no global memory would be noise.
const SQL = `SELECT key, content, COALESCE(tags,'') AS tags, COALESCE(provenance_type,'unknown') AS provenance,
             COALESCE(updated_at, created_at) AS ts
             FROM memory_entries WHERE namespace = ? ORDER BY key`;

export function readGlobalRows(dbPath = GLOBAL_DB, ns = GLOBAL_NS) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const { DatabaseSync } = require$('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(SQL).all(ns); } finally { db.close(); }
  } catch { /* fall through to the CLI */ }
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, SQL.replace('?', `'${ns.replace(/'/g, "''")}'`)],
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    const rows = JSON.parse(out || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
/**
 * Every `lesson*` row in a store, across ALL namespaces — the project tier scatters them (`lessons`,
 * the project dirname, `default`), and enumerating namespaces by hand is the restatement this repo
 * keeps paying for. The key prefix is the selector, exactly as the promotion tooling already uses it.
 */
export function readProjectRows(dbPath = PROJECT_DB) {
  const sql = `SELECT key, content, COALESCE(tags,'') AS tags, COALESCE(provenance_type,'unknown') AS provenance,
               COALESCE(updated_at, created_at) AS ts
               FROM memory_entries WHERE key LIKE 'lesson%' ORDER BY key`;
  if (!fs.existsSync(dbPath)) return [];
  try {
    const { DatabaseSync } = require$('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } catch { /* fall through */ }
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 1 << 24 });
    const rows = JSON.parse(out || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

/** Indirection so a missing node:sqlite is a caught throw rather than a module-load crash. */
function require$(id) { return process.getBuiltinModule ? process.getBuiltinModule(id) : null; }

// ── Row → lesson ─────────────────────────────────────────────────────────────────────────────────

/**
 * `trigger:write-code` tags → { trigger: 'write-code', … }
 *
 * BOTH WIRE SHAPES, and the first one is the one that matters. `ruflo memory store --tags "a,b"`
 * accepts a comma string on the command line and PERSISTS a JSON array:
 *
 *     ["trigger:write-code","enforce:inject","severity:high"]
 *
 * Measured 2026-08-10, after this parser was written to the comma form and the bridge read 0 of 30
 * freshly-tagged rows while the CLI reported success on every one. The test fixture had been built to
 * the same assumption, so it would have stayed green while the product read nothing — which is
 * `lesson-fixture-cannot-falsify-its-own-choice` happening to the file that exists to carry that
 * lesson. The fixture now writes what the CLI writes.
 */
export function parseTags(tags) {
  const raw = String(tags || '').trim();
  let parts;
  try {
    const parsed = JSON.parse(raw);
    parts = Array.isArray(parsed) ? parsed.map(String) : null;
  } catch { parts = null; }
  if (!parts) parts = raw.split(',');
  const out = {};
  for (const part of parts) {
    const [k, v] = String(part).split(':').map((s) => (s || '').trim());
    if (k && v) out[k.toLowerCase()] = v.toLowerCase();
  }
  return out;
}

/**
 * The statement is DERIVED from the row, never restated beside it (ADR-065). Global lessons are
 * written headline-first in imperative caps, so the first sentence is the instruction; the rest is
 * the evidence that earned it, which belongs in the store, not in a nudge with a 1200-char budget.
 */
export function statementOf(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const stop = text.search(/(?<=[.!?])\s(?=[A-Z(])/);
  const first = stop > 20 ? text.slice(0, stop) : text;
  return first.length > 300 ? `${first.slice(0, 297).trimEnd()}…` : first;
}

/** `lesson-tests-that-cannot-fail-on-broken-code` → `G-tests-that-cannot-fail-on-broken-code` */
export const idFor = (key) => BRIDGE_PREFIX + String(key).replace(/^lesson-/, '');

/**
 * Build a lesson from one AgentDB row, or explain in one line why it cannot be built.
 * Returns { lesson } or { skip: '<reason>' } — never throws, so one bad row cannot stop the bridge.
 */
export function lessonFromRow(row, { projects = [], idPrefix = BRIDGE_PREFIX, source = 'global' } = {}) {
  const key = String(row?.key || '');
  if (!key) return { skip: 'row has no key' };
  const tags = parseTags(row.tags);
  if (!tags.trigger) return { skip: 'no trigger: tag — add one to bridge it' };
  if (!TRIGGER_KEYS.has(tags.trigger)) {
    return { skip: `unknown trigger "${tags.trigger}" (expected one of: ${[...TRIGGER_KEYS].join(', ')})` };
  }
  // `checklist` is the default because it is the strongest level that is honest for imported
  // content: it reaches the model at the moment, and it refuses nothing.
  const enforcement = ENFORCEMENTS.has(tags.enforce) ? tags.enforce : ENFORCEMENT.CHECKLIST;
  // Typed provenance is rUv's own field (ADR-323). `user_claim` is the only value that means a human
  // said it; everything else — agent_output, tool_result, system_observation, unknown — is imported.
  const origin = row.provenance === 'user_claim' ? ORIGIN.USER_STATED : ORIGIN.IMPORTED;
  const when = Number(row.ts) > 0 ? new Date(Number(row.ts)).toISOString().slice(0, 10) : 'unknown date';
  try {
    return {
      lesson: makeLesson({
        id: idPrefix + String(key).replace(/^lesson-/, ''),
        statement: statementOf(row.content),
        trigger: tags.trigger,
        enforcement,
        // Real provenance, not a sentence invented to satisfy a non-empty check: where the row is and
        // when it was last written. Anyone can go read it.
        evidence: [`AgentDB ${source}/${key} — ${source === 'global' ? 'machine-wide' : 'project'} lesson store, recorded ${when}`],
        // SCOPE IS THE WHOLE DIFFERENCE BETWEEN THE TIERS. Empty = "applies anywhere by
        // declaration" (Tier 1 earned that by winning twice in projects that could not see each
        // other). A project row carries its own directory, so lesson-gate's isHome() keeps it home.
        projects,
        // NOT invented. Repetition is only used to order lessons of equal force, and a bridged lesson
        // has no per-project repeat count to honestly claim — so it sorts behind the user's directly
        // taught native lessons, which is the correct precedence.
        repeatCount: 0,
        severity: tags.severity === 'high' ? 'high' : 'normal',
        origin,
        status: STATUS.RATIFIED,   // the tag on the row IS the human act of ratification
        ratifiedBy: `agentdb-tag:${source}/${key}`,
      }),
    };
  } catch (e) { return { skip: String(e?.message || e).slice(0, 160) }; }
}

// ── Merge ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Replace every bridged row with the current set; leave every other row byte-identical.
 * Pure, so the test can assert the merge without touching a real store.
 */
export function mergeBridged(existing, bridged) {
  return [...existing.filter((l) => !isBridged(l.id)), ...bridged];
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
/**
 * "Am I the entrypoint?" — and it must NEVER be able to crash the caller that merely imported this.
 *
 * The first version had both Windows defects at once, and CI found them: `new URL(import.meta.url)
 * .pathname` yields `/D:/…` on Windows, which `path`/`fs` then mangle into `D:\D:` — the exact
 * `ENOENT: lstat 'D:\D:'` that failed this module's whole test SUITE at import time. And
 * `realpathSync` THROWS on anything that does not resolve, which under vitest `process.argv[1]`
 * does not.
 *
 * `fileURLToPath` is the fix for the first (hook-shim.mjs learned this in issue #38: "on Windows,
 * pathname yields '/C:/…' which path.resolve mangles into 'C:\\C:\\…'"), and try/catch for the
 * second. Both were ALREADY correct in scripts/selfcheck.mjs:660 and plugin/scripts/hook-input.mjs
 * — the pattern existed in this repo and I wrote a new one instead of reading it.
 */
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (isMain()) {
  const apply = argv.includes('--apply');
  const prune = argv.includes('--prune');
  const json = argv.includes('--json');

  const here = path.basename(process.cwd());
  const sources = [
    { name: 'global', rows: readGlobalRows(), opts: { projects: [], idPrefix: BRIDGE_PREFIX, source: 'global' } },
    // Scoped to THIS project by name, so lesson-gate's isHome() keeps it from speaking elsewhere.
    { name: `project:${here}`, rows: readProjectRows(), opts: { projects: [here], idPrefix: PROJECT_PREFIX, source: `project:${here}` } },
  ];
  const bridged = [];
  const skipped = [];
  const seen = new Set();
  for (const src of sources) {
    for (const row of src.rows) {
      const r = lessonFromRow(row, src.opts);
      if (!r.lesson) { skipped.push({ key: `${src.name}/${row.key}`, why: r.skip }); continue; }
      // A lesson promoted from a project to global exists in BOTH stores. The global copy wins: it
      // is the one that earned the right to travel, and surfacing the same correction twice teaches
      // the reader to skim (lesson-gate's own dedupe reasoning, applied across sources).
      const slug = String(row.key).replace(/^lesson-/, '');
      if (seen.has(slug)) { skipped.push({ key: `${src.name}/${row.key}`, why: 'already bridged from a higher tier' }); continue; }
      seen.add(slug);
      bridged.push(r.lesson);
    }
  }

  const alreadyBridged = loadLessons().filter((l) => isBridged(l.id)).length;
  // THE ANTI-WIPE GUARD. A read failure (store moved, sqlite missing, permissions) produces zero
  // candidates, and without this a "successful" apply would quietly delete every lesson the bridge
  // had previously installed. Nothing about that would look like an error.
  const wouldWipe = bridged.length === 0 && alreadyBridged > 0;

  if (json) {
    console.log(JSON.stringify({
      sources: sources.map((s) => ({ name: s.name, rows: s.rows.length })),
      bridged: bridged.map((l) => ({ id: l.id, trigger: l.trigger, enforcement: l.enforcement, origin: l.origin })),
      untagged: skipped, alreadyBridged, wouldWipe, applied: false,
    }, null, 2));
    process.exit(0);
  }

  console.log('\n  lesson-bridge');
  for (const s of sources) console.log(`    ${s.name.padEnd(24)} ${s.rows.length} row(s)`);
  console.log(`  ${bridged.length} carry a trigger tag.\n`);
  const byTrigger = new Map();
  for (const l of bridged) byTrigger.set(l.trigger, [...(byTrigger.get(l.trigger) || []), l]);
  for (const [trigger, ls] of [...byTrigger].sort()) {
    console.log(`  ▸ ${trigger}`);
    for (const l of ls) console.log(`      ${l.enforcement.padEnd(9)} ${l.id}`);
  }
  if (skipped.length) {
    // NAMED, never a count. A list that says "12 skipped" and stops is the truncation that reads as
    // completeness — the exact failure Rule 23 was written about.
    console.log(`\n  NOT bridged (${skipped.length}) — each needs a trigger tag on its AgentDB row:`);
    for (const s of skipped) console.log(`      ${s.key.padEnd(48)} ${s.why}`);
    console.log(`\n      ruflo memory store --path ${GLOBAL_DB} -n ${GLOBAL_NS} \\`);
    console.log('        -k "<key>" --value "<text>" --tags "trigger:<key>,enforce:checklist" --provenance user_claim');
  }

  if (!apply) {
    console.log(`\n  read-only. Re-run with --apply to merge ${bridged.length} lesson(s) into the store.\n`);
    process.exit(0);
  }
  if (wouldWipe && !prune) {
    console.error(`\n  REFUSING to apply: 0 lessons readable but ${alreadyBridged} bridged lesson(s) are already`);
    console.error('  installed. That is a read failure, not an empty store. Pass --prune if removal is intended.\n');
    process.exit(1);
  }
  const before = loadLessons().length;
  updateLessons((current) => mergeBridged(current, bridged));
  const after = loadLessons().length;
  console.log(`\n  applied: store ${before} → ${after} lesson(s) (${bridged.length} bridged, ${after - bridged.length} native)\n`);
}
