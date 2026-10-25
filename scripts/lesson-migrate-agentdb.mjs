#!/usr/bin/env node
/**
 * lesson-migrate-agentdb.mjs — ONE-TIME reconciliation: fold every `lesson-*` row from the two
 * AgentDB stores into the ONE plugin lesson store that lesson-gate.mjs actually reads
 * (~/.config/ruvnet-brain/lessons.json), losing nothing.
 *
 * WHY THIS EXISTS ALONGSIDE plugin/scripts/lesson-bridge.mjs. The bridge already carries any
 * AgentDB row that is TAGGED with `trigger:<key>` into the store, 1:1, as `G-<slug>` (global) /
 * `P-<slug>` (project) — and running it has already merged 44 of the 91 `lesson-*` rows this repo's
 * two AgentDB stores hold (verified live 2026-09-26: the store already contains 34 `G-*` and 10 `P-*`
 * ids whose evidence cites the exact bridged key). The bridge does ONE thing on purpose and refuses
 * to guess a trigger for an untagged row (ADR-066: a keyword classifier is exactly what produced a
 * false positive once already) — and it never asks "does an EXISTING lesson already say this?", so a
 * rediscovery of the same rule under a new key becomes a duplicate row, not a merge.
 *
 * This script is the other half: for the 47 rows the bridge cannot place (13 untagged in the global
 * store, 35 in the project store — because untagged rows are the norm there, not the exception), a
 * human (this migration's author) read every one against the current 61-entry store and recorded a
 * decision — MERGE into an existing entry that already states the same rule (by MEANING, not string
 * match), or NEW where nothing in the store covers it yet. That judgment cannot be automated without
 * repeating ADR-066's mistake, so it is captured once, here, as data (MANUAL_MAP below), and the
 * script only APPLIES it — mechanically, idempotently, and never silently dropping a row it does not
 * recognise.
 *
 * READ PATH: `ruflo memory list --format json` + `ruflo memory retrieve --format json` — the CLI,
 * never raw sqlite3 (this repo's memory policy exists specifically to prevent a second, disconnected
 * read/write path from developing by accident).
 *
 * WRITE PATH: plugin/scripts/lesson-store.mjs's own `updateLessons()` — locked, atomic, backed up,
 * and refuses to shrink the store. A MERGE never rewrites an existing lesson's `statement`; it only
 * appends one evidence line (idempotent: skipped if that exact source key is already cited anywhere
 * in the target's evidence — which is also how "already bridged" rows are detected, see
 * `alreadyCites()`). A NEW lesson is created once, under an `L##` id (never `G-`/`P-` — those
 * prefixes are lesson-bridge's own and `mergeBridged()` treats them as fully OWNED, i.e. a future
 * bridge run wholesale-replaces every `G-*`/`P-*` id with what it currently recomputes from tagged
 * rows; minting new content under those prefixes would make it silently vanish the next time
 * lesson-bridge --apply runs. `L##` continues this store's own native numbering (L01-L17 already
 * exist) and is untouched by the bridge).
 *
 * COUNTS ABOVE ARE POINT-IN-TIME (verified live 2026-09-26), NOT A CONTRACT — both AgentDB stores are
 * live and grow during ordinary sessions (one new dual-homed row, lesson-blast-radius-machine-wide-
 * changes, appeared in both stores between this script's dry-run and its first --apply, mid-authoring
 * of this very file). MANUAL_MAP is therefore necessarily a snapshot too. The script does NOT trust
 * that snapshot to be exhaustive: any row it cannot place via an already-bridged id OR an exact
 * MANUAL_MAP key is a hard refusal (see `unmapped` below), never a silent skip — add a decision and
 * re-run rather than assume "not in the table" means "not real".
 *
 * Usage:
 *   node scripts/lesson-migrate-agentdb.mjs --dry-run   # prints the full mapping table, writes nothing
 *   node scripts/lesson-migrate-agentdb.mjs --apply     # merges/creates (locked, atomic, backed up)
 *   node scripts/lesson-migrate-agentdb.mjs --dry-run --json
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  makeLesson, loadLessons, updateLessons, ORIGIN, STATUS, ENFORCEMENT, TRIGGERS,
} from './lesson-store.mjs';

const RUFLO = process.env.RUFLO_BIN || 'ruflo';
const GLOBAL_DB = process.env.RUVNET_GLOBAL_MEMORY_DB
  || path.join(os.homedir(), '.claude', 'global-memory', '.swarm', 'memory.db');
const GLOBAL_NS = process.env.RUVNET_GLOBAL_MEMORY_NS || 'global';
const PROJECT_DB = process.env.RUVNET_PROJECT_MEMORY_DB
  || '/Users/stuartkerr/Code/ruvnet-brain/.swarm/memory.db';
const PROJECT_LABEL = 'project:ruvnet-brain';

const MIGRATION_MARK = 'lesson-migrate-agentdb.mjs';

// ── ruflo CLI, never raw sqlite3 ─────────────────────────────────────────────────────────────────
// execFileSync's own stdout PIPE truncates ruflo's output at exactly 65536 bytes (measured
// 2026-09-26 — a wrapper/child-process quirk in the ruflo CLI, not a maxBuffer limit: maxBuffer was
// already generous and the truncation is byte-exact at 64KiB regardless of it). Routing stdout to a
// real file descriptor instead of a pipe avoids it entirely — proven on the same command/dataset.
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-migrate-'));
let callCounter = 0;
// The CLI also occasionally prints a one-time banner to STDOUT ahead of the JSON payload — observed
// live: "Transformers.js loaded: ..." and, on the very first invocation in a fresh process context,
// "[INFO] Started Ruflo background daemon for ...". Neither is documented as part of the `--format
// json` contract and both are harmless, but either breaks a naive JSON.parse. Strip only KNOWN
// banner-line prefixes (never guess at bracket positions — a banner can itself contain '[', e.g.
// "[INFO] ...", which would defeat a "find the first [" heuristic) and parse what remains.
const BANNER_LINE = /^(\[(INFO|OK|WARN|WARNING|ERROR|SUCCESS)\]|Transformers\.js loaded:)/;
function stripBanners(text) {
  return text.split('\n').filter((line) => !BANNER_LINE.test(line.trim())).join('\n');
}
// This machine runs many concurrent agent worktrees against the SAME live AgentDB files (verified
// live 2026-09-26: a `ruflo memory retrieve` on the project store hung indefinitely under real
// write contention from sibling sessions). A read that can wait forever on a lock turns "read 93
// rows" into "hang forever" — the exact class of defensive-flag mistake this repo has hit before
// (nightly-wrapper's `-readonly`/`timeout` removal, same lesson). Bound every call and fail LOUDLY
// with the exact command, never retry-in-a-loop against a possibly-still-locked file.
const CLI_TIMEOUT_MS = Number(process.env.RUVNET_LESSON_MIGRATE_TIMEOUT_MS) || 20_000;
function rufloJson(args) {
  const tmp = path.join(SCRATCH_DIR, `call-${callCounter++}.json`);
  const fd = fs.openSync(tmp, 'w');
  try {
    execFileSync(RUFLO, args, { stdio: ['ignore', fd, 'ignore'], timeout: CLI_TIMEOUT_MS, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false' } });
  } catch (e) {
    if (e.signal || e.code === 'ETIMEDOUT') {
      throw new Error(`ruflo ${args.join(' ')} did not finish within ${CLI_TIMEOUT_MS}ms (killed with ${e.signal || e.code}) — likely lock contention from a concurrent writer on this shared machine. Re-run.`);
    }
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  const raw = fs.readFileSync(tmp, 'utf8');
  fs.rmSync(tmp, { force: true });
  try {
    return JSON.parse(stripBanners(raw));
  } catch (e) {
    throw new Error(`ruflo ${args.join(' ')} did not return parseable JSON after stripping known banners: ${e.message}\n--- raw output (first 500 chars) ---\n${raw.slice(0, 500)}`);
  }
}
process.on('exit', () => { try { fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Every `lesson*` row visible via `ruflo memory list`, across every namespace when none is given. */
function listLessonRows(dbPath, namespace) {
  const args = ['memory', 'list', '--path', dbPath, '--limit', '5000', '--format', 'json'];
  if (namespace) args.push('-n', namespace);
  let rows;
  try { rows = rufloJson(args); } catch (e) {
    throw new Error(`ruflo memory list failed for ${dbPath}${namespace ? ` -n ${namespace}` : ''}: ${e.message}`);
  }
  return rows.filter((r) => typeof r.key === 'string' && r.key.startsWith('lesson'));
}

/** Full row (content + tags + timestamps) for one key, via `ruflo memory retrieve`. */
function retrieveRow(dbPath, namespace, key) {
  return rufloJson(['memory', 'retrieve', '--path', dbPath, '-n', namespace, '-k', key, '--format', 'json']);
}

function readStoreB() {
  return listLessonRows(GLOBAL_DB, GLOBAL_NS).map((e) => retrieveRow(GLOBAL_DB, GLOBAL_NS, e.key));
}
function readStoreC() {
  return listLessonRows(PROJECT_DB).map((e) => retrieveRow(PROJECT_DB, e.namespace, e.key));
}

function whenOf(row) {
  const ts = Number(row.updatedAt || row.createdAt || 0);
  return ts > 0 ? new Date(ts).toISOString().slice(0, 10) : 'unknown date';
}

/** The exact string every evidence line for a source row carries — this IS the provenance marker,
 *  both for lesson-bridge's own auto-merged rows (their evidence already contains it verbatim) and
 *  for every merge/new evidence line this script writes. Presence of `row.key` inside an entry's
 *  evidence[] is the single source of truth for "has this AgentDB row already been accounted for". */
function citationFor(storeLabel, dbPath, row) {
  return `[AgentDB ${storeLabel}/${row.key}, recorded ${whenOf(row)}, store ${dbPath}]: ${row.content}`;
}

/** Is `key` cited in this lesson's evidence — as the WHOLE key, never merely as a hyphen-prefix of a
 *  longer one? Plain substring search has a real false-positive class here: two source keys in this
 *  dataset are literal prefixes of each other (`lesson-npx-disease` / `lesson-npx-disease-1784075245`,
 *  `lesson-verify-by-mechanism` / `lesson-verify-by-mechanism-not-instance`) — a naive `.includes()`
 *  reported the shorter key as "already cited" purely because the longer key's citation happened to
 *  be written first, and its own distinct content was silently never merged. Caught live 2026-09-26 on
 *  a second (idempotency-check) run, by diffing what SHOULD have been written against what was. Fixed
 *  by requiring a non-identifier character (or end of string) immediately after the match. */
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function alreadyCites(lesson, key) {
  if (!Array.isArray(lesson.evidence)) return false;
  const re = new RegExp(escapeRegExp(key) + '(?![A-Za-z0-9-])');
  return lesson.evidence.some((e) => re.test(String(e)));
}

// ── THE MANUAL MAP ───────────────────────────────────────────────────────────────────────────────
// Every row lesson-bridge.mjs cannot place (no `trigger:` tag today) because it is untagged in the
// live store. Read in full, decided by MEANING against the 61 entries already in
// ~/.config/ruvnet-brain/lessons.json (verified live 2026-09-26). `store` is 'B' (global,
// ~/.claude/global-memory/.swarm/memory.db, ns global) or 'C' (this project's own
// .swarm/memory.db, across all namespaces — verified live: ruvnet-brain, default, lessons all hold
// lesson-* rows, not only the three the task brief anticipated).
//
// decision 'NEW'   -> id/trigger/enforcement/severity/origin/status/ratifiedBy/statement supplied.
// decision 'MERGE' -> target id supplied; the existing entry's statement is NEVER rewritten.
const NEW_META = {
  L18: {
    statement: 'Before answering or handing over a command, read the whole implementation chain — '
      + 'the code, its callers, its tests, and every gate a multi-step operation depends on. When '
      + "something is broken, first find the last time it worked and diff that window before "
      + "theorising; distinguish 'never worked' from 'regressed' before proposing a fix.",
    trigger: TRIGGERS.MUTATE_MACHINE.key, enforcement: ENFORCEMENT.INJECT, severity: 'high',
    origin: ORIGIN.USER_STATED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (Non-Negotiable #3, Stuart 2026-09-15)`,
  },
  L19: {
    statement: "When told to do something, do it — and when you say 'I will do X next', X happens "
      + 'next, not after another detour. Do not silently decline, defer, or substitute your own '
      + 'judgement for a direct instruction; if you cannot comply, say so immediately and why, and '
      + 'if you disagree, say so once, then comply if it is repeated.',
    trigger: TRIGGERS.CHOOSE_WORK.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'high',
    origin: ORIGIN.USER_STATED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (Non-Negotiable #1, Stuart 2026-09-15)`,
  },
  L20: {
    statement: 'When writing a guard against a metered or free-tier allowance, sum every resource '
      + "the provider aggregates into that quota — not just the one you're adding — and hard-fail "
      + 'rather than warn; print the arithmetic so the check is auditable, and prove the guard by '
      + 'breaking it.',
    trigger: TRIGGERS.WRITE_CODE.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, AppealArmor 2026-08-22)`,
  },
  L21: {
    statement: 'Before naming a host for any PHI-bearing or compliance-sensitive component, price '
      + 'the compliance artifact (BAA/DPA/SOC2) as part of the decision and record it in the ADR — a '
      + 'vendor that charges for it is a red flag, not a fixed cost, since major hyperscalers provide '
      + 'it free; isolate regulated data in a dedicated project/account and gate provisioning in '
      + 'code, not prose.',
    trigger: TRIGGERS.RECOMMEND_ARCH.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, AppealArmor 2026-08-22)`,
  },
  L22: {
    statement: "When reviewing a tool that wraps a client's transport (proxy, shim, interceptor), "
      + 'also measure its effect on how the client and server NEGOTIATE — feature flags, capability '
      + 'headers, prompt-cache behaviour, retry semantics — not only whether it exfiltrates data; and '
      + 'when you finally measure, be willing to exonerate the suspect if the wire evidence clears it.',
    trigger: TRIGGERS.RECOMMEND_ARCH.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, 2026-08-21)`,
  },
  L23: {
    statement: 'On this Mac, `system_profiler SPUSBDataType` can return empty output even when USB '
      + 'hardware is present and active — never treat that as proof of absence; use `ioreg -p IOUSB` '
      + '/ `ioreg -r -c IOUSBHostDevice -l` for USB device truth instead.',
    trigger: TRIGGERS.ASSERT_FACT.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, verified live 2026-08-06)`,
  },
  L24: {
    statement: 'Before starting a parallel/concurrent Claude Code session in a shared directory, '
      + 'isolate it in its own git worktree (never share the main checkout), commit only by explicit '
      + "pathspec (never `add -A`/`add .`/`commit -a`/`stash`/`reset --hard`/branch switches in a "
      + 'shared tree), and finish by running the real gates and asking before merging.',
    trigger: TRIGGERS.MUTATE_MACHINE.key, enforcement: ENFORCEMENT.INJECT, severity: 'high',
    origin: ORIGIN.USER_STATED, status: STATUS.RATIFIED,
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, Helix 2026-07-26)`,
  },
  L25: {
    statement: 'Before any production `claude -p` run, measure and shed loaded context (empty/strict '
      + 'MCP config, local setting sources, `--disable-slash-commands`, '
      + '`--exclude-dynamic-system-prompt-sections`) and re-probe `cache_creation_input_tokens` on a '
      + 'one-word call — an unshed call can cost two orders of magnitude more context than a shed '
      + 'one. Keep subscription auth; never `--bare`, which forces API-key billing.',
    trigger: TRIGGERS.WRITE_CODE.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'high',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (measured 2026-09-14)`,
  },
  L26: {
    statement: 'A try/catch around `JSON.parse` (or a bare `fs.existsSync`) proves the bytes parsed '
      + 'as JSON, not that the content is valid — when reviewing or writing a validation/seal check, '
      + 'point at the explicit assertion (kind===, schemaVersion===, digest recompute, membership '
      + "check) that would throw on `{}` or a wrong value; if you can't point at that line, there is "
      + 'no validation.',
    trigger: TRIGGERS.WRITE_CODE.key, enforcement: ENFORCEMENT.INJECT, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, 2026-09-13)`,
  },
  L27: {
    statement: 'If a release fails at the publish step with CI green and all evidence inputs valid, '
      + 'check for a stale non-terminal release transaction blocking new ones before assuming the '
      + 'seal/lineage logic is broken; use the repo\'s own purpose-built recovery tool rather than '
      + 'hand-rolling a fix.',
    trigger: TRIGGERS.MUTATE_MACHINE.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (standing lesson, 2026-08-20)`,
  },
  L28: {
    statement: 'AgentDB/ruflo memory persistence silently depends on which Node binary\'s ABI '
      + "matches the machine's compiled better-sqlite3 binding — a PATH or shebang resolving to the "
      + 'wrong Node version makes writes fall back to a non-persistent backend with no error and a '
      + "printed success table. Before treating 'memory keeps breaking' as a code bug, check which "
      + 'node every caller (including launchd/cron jobs, which may hardcode PATH order) actually '
      + 'resolves to, and verify durability by an independent read-back, never by requiring the '
      + 'module.',
    trigger: TRIGGERS.ASSERT_FACT.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'high',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (root-caused 2026-08-20)`,
  },
  L29: {
    statement: "A monitoring or escalation system's acknowledgment predicate must never be "
      + "satisfiable by the automation it is monitoring — if the fixer's own comments can satisfy "
      + "the watcher's 'owner responded' check, the system silences its own alarm. A state write for "
      + "dedup/attempt-tracking must also merge fields it doesn't own, never replace the whole "
      + 'record.',
    trigger: TRIGGERS.RECOMMEND_ARCH.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'high',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (ADR-050, measured 2026-07-24)`,
  },
  L30: {
    statement: 'An installed-but-dormant capability is a defect to surface proactively, never a '
      + 'neutral state to wait and be asked about — notice what the user is actually trying to do '
      + 'and recommend only the specific capability that serves THAT goal (goal-aware matching, not '
      + 'evangelism); detection without a recommended fix, and an offer to apply it, is not enough.',
    trigger: TRIGGERS.RECOMMEND_ARCH.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.USER_STATED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (product thesis, Stuart 2026-07-21)`,
  },
  L31: {
    statement: 'Before deduplicating or shipping any build artifact, QA the assembled BUNDLE itself, '
      + 'not the local workspace — a file that looks like a byte-identical duplicate in the '
      + 'workspace (e.g. a sidecar opened by name at runtime) can be load-bearing in the packaged '
      + 'output even though `cmp` shows it identical to another file.',
    trigger: TRIGGERS.SHIP.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (cost a broken release, 2026-07-15)`,
  },
  L32: {
    statement: 'A verification check built only from the instances you already found can only '
      + 're-confirm those instances — it is structurally incapable of revealing what you missed. '
      + 'Enumerate and instrument by MECHANISM (what CAN cause the problem, at every scope/depth) '
      + 'instead, and verify by the effect the user cares about, never by the cause you touched.',
    trigger: TRIGGERS.WRITE_CODE.key, enforcement: ENFORCEMENT.INJECT, severity: 'high',
    origin: ORIGIN.USER_STATED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (7 failures in one session, 2026-07-14)`,
  },
  L33: {
    statement: 'Kling renders exactly the loudness a soundscape prompt describes — a prompt naming '
      + 'only delicate sounds comes back near-silent; always name at least one sound with body/'
      + "presence, and verify each clip's audio by looking at the waveform/spectrogram, never by a "
      + 'single dB number. If a clip is empty, re-prompt — never amplify an empty track, which only '
      + 'raises the noise floor.',
    trigger: TRIGGERS.CLAIM_DONE.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (measured 2026-07-13)`,
  },
  L34: {
    statement: 'AgentDB (ADR-174) is two tiers: `memory_entries` is a raw recording tier, and '
      + '`memory distill` mines it into episodes/patterns/causal edges on a per-namespace cursor. '
      + '`causal_edges` are weak co-occurrence by design (may rank retrieval, may NOT justify '
      + "action), and only real execution outcomes or a budgeted judge can promote a pattern — 'zero "
      + "promoted' usually means starved input, not a broken gate. Know this before reporting "
      + 'AgentDB/distillation as broken.',
    trigger: TRIGGERS.RECOMMEND_ARCH.key, enforcement: ENFORCEMENT.CHECKLIST, severity: 'normal',
    origin: ORIGIN.IMPORTED, status: STATUS.RATIFIED, projects: ['ruvnet-brain'],
    ratifiedBy: `agentdb-migration:${MIGRATION_MARK} (ADR-174, 2026-07-13)`,
  },
};

// key -> { store, decision, target } | { store, decision, id } (id must have a matching NEW_META entry)
const MANUAL_MAP = {
  // ── Store B (global, 12 untagged rows lesson-bridge cannot place) ──
  'lesson-read-whole-chain-bisect-first': { store: 'B', decision: 'NEW', id: 'L18',
    why: 'No existing entry covers "read the whole chain / bisect first" (Non-Negotiable #3, 2026-09-15).' },
  'lesson-check-source-never-answer-from-memory': { store: 'B', decision: 'MERGE', target: 'L02-check-before-you-assert',
    why: 'Same rule as L02 (check a live source before asserting a fact) — Non-Negotiable #2, adds 2026-09-15 evidence.' },
  'lesson-instruction-is-a-contract': { store: 'B', decision: 'NEW', id: 'L19',
    why: 'No existing entry covers instruction-as-contract / "I will" as commitment (Non-Negotiable #1, 2026-09-15).' },
  'lesson-working-means-a-human-received-it': { store: 'B', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01: "working" must be verified via a real outcome channel, never an exit code or a green check.' },
  'lesson-free-tier-guards-must-sum-not-sample': { store: 'B', decision: 'NEW', id: 'L20',
    why: 'No existing entry covers billing/quota guard aggregation correctness.' },
  'lesson-price-the-baa-before-choosing-a-host': { store: 'B', decision: 'NEW', id: 'L21',
    why: 'No existing entry covers pricing compliance artifacts as part of a hosting decision.' },
  'lesson-review-transport-wrappers-for-negotiation-effects': { store: 'B', decision: 'NEW', id: 'L22',
    why: 'No existing entry covers reviewing transport wrappers for client/server negotiation effects.' },
  'lesson-success-signal-from-system-of-record': { store: 'B', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01: success must come from a re-read of the system of record, never a pipe/exit-code artifact.' },
  'lesson-ruflo-mcp-memory-different-store': { store: 'B', decision: 'MERGE', target: 'G-capture-and-enforcement-must-share-a-store',
    why: 'Concrete instance of the exact rule already stated by G-capture-and-enforcement-must-share-a-store.' },
  'lesson-spusbdatatype-empty-use-ioreg': { store: 'B', decision: 'NEW', id: 'L23',
    why: 'No existing entry covers this machine-specific USB detection trap.' },
  'lesson-parallel-window-playbook': { store: 'B', decision: 'NEW', id: 'L24',
    why: 'No existing entry covers concurrent-worktree git safety.' },
  'lesson-inferred-cause-is-fabrication': { store: 'B', decision: 'MERGE', target: 'G-fabrication-feels-like-recall',
    why: 'Fuller/earlier narrative version of the exact rule already bridged as G-fabrication-feels-like-recall (same opening line).' },

  // ── Store C (project, 35 untagged rows across default/lessons/ruvnet-brain namespaces — the task
  //    brief's estimate of "5 keys" undercounted this store; 45 lesson-* rows exist live, 10 already
  //    bridged as P-*, 35 handled here) ──
  'lesson-claude-p-context-shedding-20260914': { store: 'C', decision: 'NEW', id: 'L25',
    why: 'No existing entry covers claude -p context-shedding flags/cost.' },
  'lesson-claude-p-context-cost-20260914': { store: 'C', decision: 'MERGE', target: 'L25',
    why: 'Same measurement as lesson-claude-p-context-shedding-20260914 (earlier snapshot of the same finding).' },
  'lesson-digest-cannot-see-ancestry-1789374': { store: 'C', decision: 'MERGE', target: 'G-green-ci-on-a-subset-proves-nothing',
    why: 'Same mechanism: a verifier run without the flag that enables the real check reports green while checking less than assumed.' },
  'lesson-docs-only-merges-still-gate-1789350': { store: 'C', decision: 'MERGE', target: 'G-green-ci-on-a-subset-proves-nothing',
    why: 'Same mechanism: running only the tests an authoring agent cited (a subset) and treating it as full-suite green.' },
  'lesson-try-catch-parse-is-not-validation-1789348': { store: 'C', decision: 'NEW', id: 'L26',
    why: 'No existing entry covers this specific validation-depth coding pattern.' },
  'lesson-release-completion-is-live-20260823': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01: a release is not done until the live surface is verified, never the push/CI signal.' },
  'lesson-build-update-means-shipped-20260821': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01, applied to the release rail: one surface updated is not "shipped".' },
  'lesson-release-blocked-stale-txn-1787241710': { store: 'C', decision: 'NEW', id: 'L27',
    why: 'No existing entry covers this specific release-transaction runbook fact.' },
  'lesson-agentdb-root-cause-FIXED-1787241183': { store: 'C', decision: 'NEW', id: 'L28',
    why: 'No existing entry covers the Node-ABI/better-sqlite3 durability root cause.' },
  'lesson-agentdb-durability-root-cause-1787215055': { store: 'C', decision: 'MERGE', target: 'L28',
    why: 'Earlier snapshot of the same root-cause investigation as lesson-agentdb-root-cause-FIXED-1787241183.' },
  'lesson-automation-cannot-ack-itself': { store: 'C', decision: 'NEW', id: 'L29',
    why: 'No existing entry covers self-satisfiable monitoring predicates (explicitly flagged in its own text as not yet promoted).' },
  'lesson-ruvnet-wins-disagreements-1784676096': { store: 'C', decision: 'MERGE', target: 'G-assume-ruv-is-right-then-find-the-piece',
    why: 'Same rule already bridged as G-assume-ruv-is-right-then-find-the-piece, earlier phrasing.' },
  'lesson-raison-detre-capability-advocacy-1784672810': { store: 'C', decision: 'MERGE', target: 'L30',
    why: 'Supporting proof case for the same product-thesis rule as lesson-brain-must-advocate-not-answer-1784672438.' },
  'lesson-brain-must-advocate-not-answer-1784672438': { store: 'C', decision: 'NEW', id: 'L30',
    why: 'No existing entry covers proactive capability advocacy as the product thesis.' },
  'lesson-learning-loop-must-be-on-by-default-1784661439': { store: 'C', decision: 'MERGE', target: 'L30',
    why: 'Same "installed but dormant is a defect" rule as lesson-brain-must-advocate-not-answer-1784672438, restated.' },
  'lesson-shipped-means-walk-every-channel-1784075400': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01: never say shipped/fixed/works without walking the actual user path.' },
  'lesson-assumptions-equal-failure-1784345758515': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01, stated as its own absolute: an assumption about live state is a failure, not a shortcut.' },
  'lesson-verify-all-release-channels-1784345360076': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01, applied across every release channel independently.' },
  'lesson-narrative-version-sacrosanct-1784322539404': { store: 'C', decision: 'MERGE', target: 'L05-version-is-the-update-signal',
    why: 'Same rule L05 already states explicitly ("the release narrative is updated to match").' },
  'lesson-proof-not-fake-1784316621498': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same rule as L01: a status must be derived from a verifiable artifact, never asserted/hardcoded.' },
  'lesson-big-passages-is-required-not-dup-1784082256000': { store: 'C', decision: 'NEW', id: 'L31',
    why: 'No existing entry covers QA-the-bundle-not-the-workspace.' },
  'lesson-capture-lessons-not-transcripts': { store: 'C', decision: 'MERGE', target: 'P-capture-outcomes-not-prompts',
    why: 'Same "curated signal vs raw telemetry" rule already bridged as P-capture-outcomes-not-prompts.' },
  'lesson-telemetry-drowns-signal': { store: 'C', decision: 'MERGE', target: 'P-capture-outcomes-not-prompts',
    why: 'Same "curated signal vs raw telemetry" rule already bridged as P-capture-outcomes-not-prompts.' },
  'lesson-verify-by-mechanism': { store: 'C', decision: 'MERGE', target: 'L32',
    why: 'Same rule as lesson-verify-by-mechanism-not-instance, shorter form, different worked example.' },
  'lesson-never-cp-live-db': { store: 'C', decision: 'MERGE', target: 'P-never-cp-a-live-database',
    why: 'Same rule already bridged as P-never-cp-a-live-database, shorter form.' },
  'lesson-npx-disease': { store: 'C', decision: 'MERGE', target: 'L32',
    why: 'The worked example cited inside lesson-verify-by-mechanism-not-instance\'s own text; same mechanism-not-instance rule.' },
  'lesson-npx-disease-1784075245': { store: 'C', decision: 'MERGE', target: 'L32',
    why: 'Duplicate of lesson-npx-disease under a different key/namespace; same mechanism-not-instance rule.' },
  'lesson-inventory-before-you-buy': { store: 'C', decision: 'MERGE', target: 'P-apply-what-you-just-researched',
    why: 'Same "don\'t default to the tool already in hand, inventory what exists first" rule as P-apply-what-you-just-researched.' },
  'lesson-verify-by-mechanism-not-instance': { store: 'C', decision: 'NEW', id: 'L32',
    why: 'No existing entry covers verify-by-mechanism vs verify-by-instance; the fullest statement of this repeated (2x independent) lesson.' },
  'lesson-kling-sound-presence': { store: 'C', decision: 'NEW', id: 'L33',
    why: 'No existing entry covers Kling audio-presence verification.' },
  'lesson-version-is-the-update-signal': { store: 'C', decision: 'MERGE', target: 'L05-version-is-the-update-signal',
    why: 'Same rule L05 already states; this is the original project-side statement of it.' },
  'lesson-feedback-tier-first-promotion': { store: 'C', decision: 'MERGE', target: 'L01-verify-with-a-capable-channel',
    why: 'Same "never fabricate a success signal" family as L01 — blanket --success true fabricates gold labels.' },
  'lesson-adr174-two-tier-memory': { store: 'C', decision: 'NEW', id: 'L34',
    why: 'No existing entry covers AgentDB\'s two-tier memory_entries/distill architecture.' },
  'lesson-write-path-gate-adr-0012': { store: 'C', decision: 'MERGE', target: 'G-always-search-ruvnet-first',
    why: 'Documents the enforcement mechanism (ground-before-write.sh) for the rule G-always-search-ruvnet-first already states.' },
  'lesson-never-impersonate-ruv-tools': { store: 'C', decision: 'MERGE', target: 'L06-use-the-real-tool',
    why: 'Same rule as L06: search for rUv\'s version before hand-rolling a capability, and disclose a hand-roll as one.' },

  // Appeared live in BOTH stores under the SAME key (createdAt 2026-09-26, during this migration's
  // own research window — the store is actively written by concurrent sessions/hooks, exactly what
  // the refuse-on-unmapped guard below exists to catch rather than silently miss). `store: 'either'`
  // means this decision applies no matter which store the row was read from — see buildPlan().
  'lesson-blast-radius-machine-wide-changes': { store: 'either', decision: 'MERGE', target: 'L07-blast-radius-not-social-comfort',
    why: 'Same "gate on blast radius" rule as L07, elaborated for the machine-wide-surface case (cross-project verification + Tier A Opus pre-review). Appears in both stores under the same key.' },
};

// ── Decide + apply ───────────────────────────────────────────────────────────────────────────────

/** For a source row not covered by MANUAL_MAP, is it already accounted for under the deterministic
 *  lesson-bridge id (G-<slug> for global, P-<slug> for project)? Detected by full-text presence of
 *  the row's own key inside that candidate lesson's evidence — the same fact lesson-bridge's own
 *  lessonFromRow() bakes into evidence, so this is not a guess, it is reading what is already there. */
function autoDetect(row, storeLabel, lessonsById) {
  const slug = row.key.replace(/^lesson-/, '');
  const prefix = storeLabel === 'B' ? 'G-' : 'P-';
  const candidateId = prefix + slug;
  const candidate = lessonsById.get(candidateId);
  if (candidate && alreadyCites(candidate, row.key)) {
    return { decision: 'MERGE', target: candidateId, why: `Already bridged by lesson-bridge.mjs as ${candidateId} (evidence cites this exact key).` };
  }
  // Fallback: the key might already be cited under a DIFFERENT id (e.g. a prior manual merge, or a
  // human hand-edit) even without the deterministic id existing. Scan every lesson once.
  for (const l of lessonsById.values()) {
    if (alreadyCites(l, row.key)) {
      return { decision: 'MERGE', target: l.id, why: `Already cited in ${l.id}'s evidence.` };
    }
  }
  return null;
}

function buildPlan(rows, storeLabel, lessonsById) {
  const plan = [];
  const unmapped = [];
  for (const row of rows) {
    const auto = autoDetect(row, storeLabel, lessonsById);
    const manual = MANUAL_MAP[row.key];
    if (auto) {
      plan.push({ row, storeLabel, decision: 'MERGE', target: auto.target, why: auto.why, alreadyDone: true });
      continue;
    }
    if (manual && (manual.store === storeLabel || manual.store === 'either')) {
      if (manual.decision === 'NEW') {
        plan.push({ row, storeLabel, decision: 'NEW', target: manual.id, why: manual.why });
      } else {
        plan.push({ row, storeLabel, decision: 'MERGE', target: manual.target, why: manual.why });
      }
      continue;
    }
    unmapped.push(row);
  }
  return { plan, unmapped };
}

function projectFor(storeLabel) { return storeLabel === 'B' ? 'global' : PROJECT_LABEL; }
function dbFor(storeLabel) { return storeLabel === 'B' ? GLOBAL_DB : PROJECT_DB; }

/** Apply one plan entry against the in-memory lessons array (mutated in place, id-keyed). Returns
 *  'written' | 'skipped-idempotent' | 'created'. */
function applyEntry(entry, lessonsById, order) {
  const { row, storeLabel, decision, target } = entry;
  const label = projectFor(storeLabel);
  const dbPath = dbFor(storeLabel);
  const citation = citationFor(label, dbPath, row);

  if (decision === 'NEW') {
    const existing = lessonsById.get(target);
    if (existing) {
      if (alreadyCites(existing, row.key)) return 'skipped-idempotent';
      existing.evidence.push(citation);
      return 'written';
    }
    const meta = NEW_META[target];
    if (!meta) throw new Error(`No NEW_META entry for id ${target} (key ${row.key})`);
    const lesson = makeLesson({
      id: target,
      statement: meta.statement,
      trigger: meta.trigger,
      enforcement: meta.enforcement,
      severity: meta.severity,
      origin: meta.origin,
      status: meta.status,
      ratifiedBy: meta.ratifiedBy,
      projects: meta.projects || (storeLabel === 'B' ? [] : ['ruvnet-brain']),
      evidence: [citation],
    });
    lessonsById.set(target, lesson);
    order.push(target);
    return 'created';
  }

  // MERGE
  const existing = lessonsById.get(target);
  if (!existing) throw new Error(`MERGE target ${target} not found for key ${row.key} — check MANUAL_MAP / processing order`);
  if (alreadyCites(existing, row.key)) return 'skipped-idempotent';
  existing.evidence.push(citation);
  return 'written';
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !apply;
  const json = argv.includes('--json');

  const before = loadLessons();
  const lessonsById = new Map(before.map((l) => [l.id, { ...l, evidence: [...l.evidence] }]));
  const order = []; // ids created during this run, for stable NEW-first processing already guaranteed by two passes

  const rowsB = readStoreB();
  const rowsC = readStoreC();

  const { plan: planB, unmapped: unmappedB } = buildPlan(rowsB, 'B', lessonsById);
  const { plan: planC, unmapped: unmappedC } = buildPlan(rowsC, 'C', lessonsById);
  const unmapped = [...unmappedB, ...unmappedC];

  if (unmapped.length) {
    console.error(`\n  REFUSING: ${unmapped.length} lesson-* row(s) matched neither an already-bridged id nor MANUAL_MAP.`);
    console.error('  Losing a row silently is the one failure this script exists to prevent. Add a decision for:');
    for (const r of unmapped) console.error(`      ${r.key}`);
    process.exit(1);
  }

  // Pass 1: NEW (creates canonical ids other MERGEs in this same run may target).
  // Pass 2: MERGE (targets are now resolvable whether pre-existing or freshly created).
  const allEntries = [...planB, ...planC];
  const news = allEntries.filter((e) => e.decision === 'NEW');
  const merges = allEntries.filter((e) => e.decision === 'MERGE');

  const results = [];
  for (const e of news) results.push({ ...e, result: dryRun ? (lessonsById.has(e.target) && alreadyCites(lessonsById.get(e.target), e.row.key) ? 'skipped-idempotent' : (lessonsById.has(e.target) ? 'written' : 'created')) : applyEntry(e, lessonsById, order) });
  for (const e of merges) results.push({ ...e, result: dryRun ? (lessonsById.has(e.target) && alreadyCites(lessonsById.get(e.target), e.row.key) ? 'skipped-idempotent' : 'written') : applyEntry(e, lessonsById, order) });

  // ── Report ──
  const table = results
    .sort((a, b) => (a.storeLabel === b.storeLabel ? a.row.key.localeCompare(b.row.key) : a.storeLabel.localeCompare(b.storeLabel)))
    .map((e) => ({
      store: e.storeLabel, key: e.row.key, decision: e.decision, target: e.target,
      result: e.result, why: e.why,
    }));

  if (json) {
    console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', totalSourceRows: rowsB.length + rowsC.length,
      storeB: rowsB.length, storeC: rowsC.length, before: before.length, table }, null, 2));
  } else {
    console.log(`\n  lesson-migrate-agentdb.mjs — ${dryRun ? 'DRY RUN (nothing written)' : 'APPLY'}`);
    console.log(`  Store B (global, ${GLOBAL_DB} ns=${GLOBAL_NS}): ${rowsB.length} lesson-* row(s)`);
    console.log(`  Store C (project, ${PROJECT_DB}, all namespaces): ${rowsC.length} lesson-* row(s)`);
    console.log(`  Total source rows: ${rowsB.length + rowsC.length}\n`);
    console.log('  #    store  key'.padEnd(58) + 'decision  target'.padEnd(28) + 'result');
    console.log('  ' + '-'.repeat(110));
    table.forEach((row, i) => {
      console.log(`  ${String(i + 1).padStart(3)}  ${row.store.padEnd(5)}  ${row.key.padEnd(52)} `
        + `${row.decision.padEnd(9)} ${String(row.target).padEnd(20)} ${row.result}`);
    });
    console.log('\n  why (one line per row):');
    table.forEach((row, i) => console.log(`  ${String(i + 1).padStart(3)}. ${row.key} -> ${row.target}: ${row.why}`));
  }

  if (dryRun) {
    if (!json) console.log(`\n  DRY RUN — nothing written. Re-run with --apply to write ${results.filter((r) => r.result !== 'skipped-idempotent').length} change(s).\n`);
    return;
  }

  // ── Real write, through the store's own locked/atomic/backed-up updater ──
  updateLessons((current) => {
    const currentById = new Map(current.map((l) => [l.id, l]));
    for (const id of lessonsById.keys()) {
      const updated = lessonsById.get(id);
      if (currentById.has(id)) {
        // Existing lesson: statement/trigger/etc untouched; only evidence may have grown.
        const idx = current.findIndex((l) => l.id === id);
        if (updated.evidence.length !== current[idx].evidence.length) {
          current[idx] = makeLesson({ ...current[idx], evidence: updated.evidence });
        }
      } else {
        current.push(updated);
      }
    }
    return current;
  });

  const after = loadLessons();
  console.log(`\n  APPLIED: store ${before.length} -> ${after.length} lesson(s) `
    + `(${after.length - before.length} new, ${results.filter((r) => r.result === 'written').length} evidence line(s) added, `
    + `${results.filter((r) => r.result === 'skipped-idempotent').length} already present)\n`);
}

main();
