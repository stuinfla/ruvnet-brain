#!/usr/bin/env node
/**
 * learning-enable.mjs — answers "is rUv learning actually ON?" with EVIDENCE, and refuses to
 * pretend there is a switch when there isn't one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS FILE EXISTS TO PREVENT (2026-07-21, caught before it shipped)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A survey of this machine reported, as the headline finding of the night: "26 rUv learning hooks
 * are installed and ZERO are enabled — learning is off." Stuart had been asking "is learning
 * actually on?" all evening and was told no.
 *
 * That finding was FALSE, in both directions, and it was read straight off `ruflo hooks list`:
 *
 *     | pre-edit  | PreToolUse | No | | | Never |     ← "Enabled: No", 26 times
 *
 * Reading the actual installed source rather than trusting the table
 * (~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/
 *  mcp-tools/hooks-tools.js, `export const hooksList`) shows the handler is a HARDCODED STATIC
 * ARRAY. It takes no input (`inputSchema: { properties: {} }`), opens no file, reads no database,
 * and stamps every one of the 26 entries with the literal `status: 'active'`. Confirmed live via
 * `ruflo hooks list --format json` — the payload contains `"status": "active"` and has NO `enabled`
 * key at all.
 *
 * The CLI renderer (commands/hooks.js, `listCommand`) then draws a column keyed `enabled`:
 *
 *     { key: 'enabled', ..., format: (v) => v ? output.success('Yes') : output.dim('No') }
 *
 * `v` is `undefined` for every row, so it prints "No" 26 times. The same mismatch empties the
 * Priority and Executions columns and makes Last Executed read "Never" for everything. Proof the
 * table is inert: `ruflo hooks list --enabled`, which is documented as "show only enabled hooks",
 * returns all 26 rows unchanged — the CLI passes the filter to a handler that accepts no arguments.
 *
 * So BOTH readings of that table are worthless as an answer to "is learning on?":
 *   • "Enabled: No"      → a field-name bug. Not a state. Never was.
 *   • `status: "active"` → a hardcoded literal in a catalog of which subcommands exist. Also not a state.
 *
 * `ruflo hooks list` is a MENU, not a dashboard. It cannot answer the question in either direction.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT "ENABLED" ACTUALLY MEANS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * There is no ruflo-side enable flag: `ruflo hooks enable` and `ruflo hooks disable` do not exist
 * (both fall through to the help text, verified live). There is no per-hook config file under
 * ~/.ruflo or ~/.claude-flow — the only file there with an `enabled` key is first-run-enabled.json,
 * which is `{"enabled":{"spinner":true}}`, about a CLI spinner, and a trap for any detector that
 * greps for the word.
 *
 * rUv's learner is driven by the ruflo DAEMON and the `mcp__ruflo__hooks_*` MCP tools that agents
 * call. It is NOT driven by entries in Claude Code's ~/.claude/settings.json. That distinction is
 * the whole ballgame, because it is the second way to get this wrong: this machine has ZERO ruflo
 * learning hooks wired into settings.json (the only `ruflo` command there is a statusline helper)
 * and yet the learner had recorded 457 trajectories and 457 patterns, last adapted 67 minutes
 * before this was written. A detector that concluded "no ruflo hooks in settings.json → learning is
 * off" would be just as wrong as the one that read the table, and far more convincing.
 *
 * The ONLY honest signal is the learner's own accumulated state, which is a real file with real
 * counters that move: ~/.claude-flow/neural/stats.json. scripts/learnings.mjs already treats it as
 * the source of truth for the console's "What I've learned" panel; this agrees with it rather than
 * inventing a second, disagreeing answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY --enable REFUSES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * You cannot enable something that has no enabled state. There is no verified command that turns
 * those 26 rows to "Yes", because nothing reads them. The tempting move — wiring `ruflo hooks
 * post-edit` into every PostToolUse in ~/.claude/settings.json — would be a GUESS dressed as a fix:
 * it edits a file that affects every project on this machine, to solve a problem that does not
 * exist, duplicating capture the daemon is already doing. So --enable writes nothing and prints
 * what actually drives the learner instead.
 *
 * This whole file is therefore READ-ONLY BY CONSTRUCTION. It never opens a file for writing, which
 * is a stronger guarantee than backing one up: there is no write path to get wrong, and the tests
 * assert ~/.claude/settings.json is byte-identical afterwards.
 *
 * Usage:
 *   node scripts/learning-enable.mjs [--status]   report real state with evidence (default)
 *   node scripts/learning-enable.mjs --enable     refuse, and explain what genuinely drives learning
 *   node scripts/learning-enable.mjs --disable    refuse, same reason, inverted
 *   node scripts/learning-enable.mjs --json       machine-readable state
 *
 * Exit codes: 0 = reported. 2 = refused (deliberate non-action, distinct from 1 = error).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve HOME honestly. os.homedir() consults $HOME on POSIX, but reading it explicitly first
 * means the tests can point this at a temp HOME without depending on that implementation detail
 * — and means a caller can audit a different machine's dotfiles without lying about whose they are.
 */
const homeOf = (home) => home || process.env.HOME || os.homedir();

/**
 * Staleness threshold: a learner that hasn't adapted in a week is idle, not off.
 *
 * EXPORTED because capability-registry.mjs needs the same number and used to have no staleness check
 * at all — it called a learner last adapted 400 days ago "on", while this file called the identical
 * file "IDLE — nothing in 400 days". One constant, one definition; a second copy is a future
 * disagreement with a delay fuse on it.
 */
export const STALE_DAYS = 7;

/**
 * Read the learner's accumulated state — the real signal.
 *
 * Rule: if the file is missing or unparseable we return null counters, NEVER 0. "0 patterns" is a
 * claim that the learner ran and learned nothing; "not checked" is the truth when we never found
 * the file. Shipping the former as the latter is how a detector starts lying.
 */
export function readLearnerState({ home, now = Date.now() } = {}) {
  const HOME = homeOf(home);
  const statsPath = path.join(HOME, '.claude-flow', 'neural', 'stats.json');

  let raw = null;
  let parsed = null;
  try { raw = fs.readFileSync(statsPath, 'utf8'); } catch { /* no learner on this machine yet */ }
  if (raw !== null) { try { parsed = JSON.parse(raw); } catch { /* present but corrupt */ } }

  // `Number(v)` was the bug, not the guard around it. Number(null) === 0, Number('') === 0 and
  // Number(false) === 0 are all finite, so the previous `Number.isFinite(Number(v))` accepted three
  // non-numbers as a MEASURED ZERO — the precise substitution this function's docstring above forbids.
  // MEASURED: `{"trajectoriesRecorded": null}` produced the verdict "the learner file exists and
  // GENUINELY records 0 trajectories", the word "genuinely" attached to a value nobody ever counted.
  // A counter is a counter only when it arrives as a JSON number.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // Timestamps are NOT counters and must not share their reader. `lastAdaptation` is written as epoch
  // milliseconds today, but an upstream switch to ISO-8601 is the single most ordinary schema change
  // there is — and under num() an ISO string returns null, which nulls `days`, which makes the IDLE
  // branch unreachable. MEASURED: a learner idle 400 days reported "ON — the learner is accumulating"
  // purely because its timestamp was a string. The staleness check evaporated on exactly the drift it
  // was written to survive, so this reader accepts both shapes and still refuses everything else.
  const ts = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
    return null;
  };

  const trajectories = parsed ? num(parsed.trajectoriesRecorded) : null;
  const patterns = parsed ? num(parsed.patternsLearned) : null;
  const lastMs = parsed ? ts(parsed.lastAdaptation) : null;

  return {
    statsPath,
    present: raw !== null,
    corrupt: raw !== null && parsed === null,
    trajectories,
    patterns,
    lastAdaptationMs: lastMs,
    // `lastMs ? …` treated epoch 0 as "no timestamp"; `=== null` is the only honest test for absence.
    ageMinutes: lastMs === null ? null : Math.floor((now - lastMs) / 60000),
  };
}

/**
 * Is the ruflo daemon alive? This is the process that feeds the learner, so its liveness is
 * corroborating evidence — but NOT proof on its own, and not required: a dead daemon with fresh
 * counters still means learning ran. Reported as a separate line, never folded into the verdict.
 */
export function readDaemonState({ home } = {}) {
  const HOME = homeOf(home);
  const pidPath = path.join(HOME, '.claude-flow', 'daemon.pid');
  let pid = null;
  try { pid = Number(String(fs.readFileSync(pidPath, 'utf8')).trim()); } catch { return { pidPath, pid: null, alive: null }; }
  if (!Number.isInteger(pid) || pid <= 0) return { pidPath, pid: null, alive: null };
  // Signal 0 probes existence without touching the process.
  try { process.kill(pid, 0); return { pidPath, pid, alive: true }; }
  catch (e) { return { pidPath, pid, alive: e.code === 'EPERM' }; }
}

/**
 * Count ruflo LEARNING hooks wired into Claude Code's settings.json.
 *
 * Reported for completeness and explicitly labelled NOT REQUIRED, because the honest finding is
 * that this number was 0 on a machine that was actively learning. It is here so nobody re-derives
 * the wrong conclusion from its absence later. A statusline helper is not a learning hook, so
 * matching bare "ruflo" would overcount — we match a `ruflo hooks <subcommand>` invocation.
 */
export function readSettingsWiring({ home } = {}) {
  const HOME = homeOf(home);
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return { settingsPath, present: false, learningHooks: null }; }

  // TWO REAL CRASHES, both from a hand-edited settings.json, both reproduced with exit code 1 and a
  // raw stack trace — which is the worst possible outcome for a command whose entire job is to tell
  // a worried person whether learning is on. It left them unable to find out at all.
  //
  //   `null`  is valid JSON, so the try above succeeds and cfg is null → `cfg.hooks` threw
  //           "TypeError: Cannot read properties of null (reading 'hooks')".
  //   `hooks: {command: …}` written as an object instead of the array the schema wants → the inner
  //           for..of threw "TypeError: object is not iterable".
  //
  // This file invites hand-editing (it prints the path), so malformed shapes are an EXPECTED state,
  // not an exceptional one. A structural surprise degrades to "not checked" — null, never 0, because
  // a count of 0 is a claim about their configuration and null is the truth about our reading of it.
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { settingsPath, present: true, learningHooks: null };
  if (cfg.hooks !== undefined && (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks))) {
    return { settingsPath, present: true, learningHooks: null };
  }
  const groups = cfg.hooks || {};

  // AN UNREADABLE SUB-STRUCTURE POISONS THE COUNT, and it must. Guarding the iteration with
  // `Array.isArray(x) ? x : []` stops the crash and then quietly SKIPS the malformed entry — so a
  // settings.json with one hook group written as an object came back as a confident `0`, meaning
  // "we looked everywhere and found no ruflo learning hooks." We did not look everywhere; we
  // skipped the part we could not parse. That is this file's own thesis violated three lines below
  // where it is stated, and its regression test caught it.
  //
  // A partially-read structure yields null ("not checked"), never a total. Losing the count of the
  // entries we COULD read is the correct trade: an incomplete count presented as a complete one is
  // the failure mode, and there is no honest way to render "at least 3" in a field documented as
  // an exact number.
  let unreadable = false;
  let count = 0;
  for (const entries of Object.values(groups)) {
    if (!Array.isArray(entries)) { unreadable = true; continue; }
    for (const entry of entries) {
      if (entry?.hooks !== undefined && !Array.isArray(entry.hooks)) { unreadable = true; continue; }
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (/\bruflo\b[^"]*\bhooks\b/.test(String(h?.command || ''))) count += 1;
      }
    }
  }
  return { settingsPath, present: true, learningHooks: unreadable ? null : count };
}

/** Derive the verdict from the evidence. Never asserted, never cached, never guessed. */
export function verdict(learner) {
  if (!learner.present) {
    return { code: 'NO_LEARNER_STATE', headline: 'NOT LEARNING YET — no learner state on this machine' };
  }
  if (learner.corrupt) {
    return { code: 'CORRUPT', headline: 'UNKNOWN — learner state file exists but is unreadable' };
  }
  const t = learner.trajectories;
  const p = learner.patterns;
  if (t === null && p === null) {
    return { code: 'UNKNOWN_SHAPE', headline: 'UNKNOWN — learner state file has no recognisable counters' };
  }

  // PARTIAL DRIFT IS STILL DRIFT. Upstream does not rename both counters in the same release, and the
  // half-renamed case is the one that reaches users. Every line below needs BOTH numbers — to compare
  // them against zero, and to print them — so one unread counter is one unanswerable question.
  //
  // The two failures this replaces were mirror images of the same coercion, and both were MEASURED on
  // real bytes. `{trajectories_recorded: 457, patternsLearned: 0}` fell through `(t || 0) === 0` —
  // null coerced to 0 — and reported "genuinely records 0 trajectories and 0 patterns" to a machine
  // holding 457. Read the other way, `{trajectoriesRecorded: null, patternsLearned: 457}` reached the
  // ON branch and rendered the literal string "null work sessions recorded and 457 patterns learned".
  // A confident OFF and a printed "null" from one missing field.
  //
  // This is the guard num() exists to enable, placed where it survives: the `|| 0` three lines below
  // it discarded null the instant it was produced, so the correct reader upstream bought nothing.
  if (t === null || p === null) {
    const missing = t === null ? 'trajectoriesRecorded' : 'patternsLearned';
    const seen = t === null ? `patternsLearned=${p}` : `trajectoriesRecorded=${t}`;
    return {
      code: 'UNKNOWN_PARTIAL',
      missingField: missing,
      headline: `UNKNOWN — learner state file is half-readable (${seen}, but ${missing} is not a number this version can read)`,
    };
  }

  if (t === 0 && p === 0) {
    return { code: 'INITIALISED_EMPTY', headline: 'INITIALISED BUT EMPTY — learner exists, has recorded nothing' };
  }
  const days = learner.ageMinutes === null ? null : Math.floor(learner.ageMinutes / 1440);
  if (days !== null && days >= STALE_DAYS) {
    return { code: 'IDLE', headline: `IDLE — learned before, but nothing in ${days} days` };
  }
  return { code: 'ON', headline: 'ON — the learner is accumulating' };
}

/**
 * Gather everything, and NEVER throw doing it.
 *
 * The guards inside readSettingsWiring cover the two shapes that actually crashed, but the outer
 * belt matters independently: this function is the entry point for the CLI *and* for
 * capability-registry's learning row, so an unanticipated structural surprise anywhere below must
 * degrade to an honest UNKNOWN rather than take down the page that was asked the question. A
 * crashed probe and a probe reporting "off" are equally useless to the reader; only one of them is
 * also a lie, and neither is acceptable when "I could not tell" is available and true.
 */
export function gatherState(opts = {}) {
  const learner = readLearnerState(opts);
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  return {
    learner,
    daemon: safe(() => readDaemonState(opts), { pidPath: null, pid: null, alive: null }),
    settings: safe(() => readSettingsWiring(opts), { settingsPath: null, present: false, learningHooks: null }),
    verdict: safe(() => verdict(learner), { code: 'CORRUPT', headline: 'UNKNOWN — learner state could not be interpreted' }),
  };
}

/** "not checked" beats a confident 0. Every rendered number passes through here. */
const show = (v) => (v === null || v === undefined ? 'not checked' : String(v));

const tilde = (p, HOME) => (p.startsWith(HOME) ? p.replace(HOME, '~') : p);

function renderStatus(state, HOME) {
  const { learner, daemon, settings, verdict: v } = state;
  const L = [];
  L.push('');
  L.push('rUv learning — actual state');
  L.push('');
  L.push(`  ${v.headline}`);
  L.push('');
  L.push('  Evidence (all read at render time):');
  L.push(`    trajectories recorded : ${show(learner.trajectories)}`);
  L.push(`    patterns learned      : ${show(learner.patterns)}`);
  L.push(`    last adaptation       : ${learner.ageMinutes === null ? 'not checked' : `${learner.ageMinutes} min ago`}`);
  L.push(`    source                : ${tilde(learner.statsPath, HOME)}${learner.present ? '' : '  (absent)'}`);
  L.push(`    ruflo daemon          : ${daemon.alive === null ? 'no pid file' : daemon.alive ? `running (pid ${daemon.pid})` : `pid ${daemon.pid} not running`}`);
  L.push('');
  L.push('  Not evidence, despite appearances:');
  L.push('    `ruflo hooks list` prints "Enabled: No" for all 26 hooks. That column is a');
  L.push('    field-name bug, not a state — the handler returns `status: "active"` from a');
  L.push('    hardcoded array and has no `enabled` key for the renderer to read. Proof:');
  L.push('    `ruflo hooks list --enabled` still returns all 26. Ignore that table.');
  L.push('');
  L.push(`    ruflo learning hooks in settings.json: ${show(settings.learningHooks)} — and this is NOT required.`);
  L.push('    The learner is fed by the ruflo daemon and the mcp__ruflo__hooks_* tools, not by');
  L.push('    Claude Code hook entries. A count of 0 here does not mean learning is off.');
  L.push('');
  return L.join('\n');
}

function renderRefusal(which) {
  const L = [];
  L.push('');
  L.push(`REFUSING --${which}: there is nothing to ${which}.`);
  L.push('');
  L.push('  The 26 hooks in `ruflo hooks list` have no enabled state to toggle. The "Enabled"');
  L.push('  column is a field-name bug (handler returns `status: "active"`; renderer reads a');
  L.push('  nonexistent `enabled` key), and `ruflo hooks enable` / `ruflo hooks disable` do not');
  L.push('  exist — both fall through to the help text.');
  L.push('');
  L.push('  This command will not edit ~/.claude/settings.json to fake it. That file affects every');
  L.push('  project on this machine, and wiring `ruflo hooks ...` into it would duplicate capture');
  L.push('  the daemon already performs — a guess dressed as a fix.');
  L.push('');
  L.push('  What actually drives the learner (verified commands, run them yourself):');
  L.push('    ruflo hooks intelligence --status    initialise / inspect the intelligence system');
  L.push('    ruflo hooks intelligence --train     force one training cycle');
  L.push('    ruflo hooks metrics                  learning metrics dashboard');
  L.push('');
  L.push('  To see whether learning is on, with evidence:');
  L.push('    node scripts/learning-enable.mjs --status');
  L.push('');
  return L.join('\n');
}

function main(argv) {
  const has = (f) => argv.includes(f);
  const HOME = homeOf();

  if (has('--enable') || has('--disable')) {
    process.stdout.write(renderRefusal(has('--enable') ? 'enable' : 'disable'));
    return 2;
  }

  const state = gatherState();
  if (has('--json')) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${renderStatus(state, HOME)}\n`);
  return 0;
}

// BASENAME, not path identity — see the same note in hook-registry.mjs. The strict form stopped
// firing once `scripts/learning-enable.mjs` became a re-export shim over this payload copy, turning
// the documented `node scripts/learning-enable.mjs --status` into a silent no-op.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}learning-enable.mjs`)) {
  process.exit(main(process.argv.slice(2)));
}
