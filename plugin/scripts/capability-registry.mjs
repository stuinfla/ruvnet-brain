#!/usr/bin/env node
/**
 * capability-registry.mjs — the data model behind "the top things you own and don't use".
 *
 * WHY THIS EXISTS, and why it is a REGISTRY rather than more detectors.
 *
 * `capability-audit.mjs` answers "what is dormant?" and it answers it well, but it only speaks up
 * when a detector decides something is WRONG. That shape cannot answer the flat question a person
 * actually asks — "is X on?" — because a healthy capability produces no finding at all, and silence
 * is indistinguishable from "I never looked." The console needs a row per capability whether the
 * news is good, bad, or unavailable.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: 'unknown' is a first-class state, and it outranks
 * 'off' every single time a probe could not run. Reporting "off" for something you failed to
 * measure is not a rounding error — it is the exact lie the whole project was built to kill, and
 * it is *easy* to commit here because every underlying helper has a falsy default.
 *
 * That is not a hypothetical. While this file was being written (2026-07-22, ~00:22) a live probe of
 * this repo's own `.swarm/memory.db` came back `{unreadable: 'unable to open database file (14)',
 * learns: false}` — and a naive `learns ? 'on' : 'off'` would have reported "memory distillation is
 * OFF". Re-running the identical query 90 seconds later returned 1201 memories, 99.8% embedded, 596
 * distilled patterns: the store was fully healthy and the first read had simply lost a race with a
 * concurrent writer holding the WAL. One transient lock, and the console would have told its owner
 * to fix a system that was already working. Every detector below therefore maps "could not read" to
 * 'unknown' WITH THE REASON, and only ever says 'off' about a value it genuinely observed.
 *
 * THE SECOND RULE: `turnOn` is null unless the exact command was run with `--help` and the
 * subcommand confirmed present. A confidently-wrong command is worse than no command — it sends a
 * person to a shell to be told "unknown subcommand", which costs them trust in every other row on
 * the page. Six of the eleven capabilities below have `turnOn: null` for that reason, and each one
 * records the negative check that produced the null, so nobody re-litigates it from memory.
 *
 * (That count said FOUR until 2026-08-05 and the real number was seven — stale by three, in the
 * paragraph explaining why nulls must be re-checked. Counted, not remembered:
 * `grep -c '^    turnOn: null,'`. Issue #116 removed one, leaving six.)
 *
 *   learning-hooks       `ruflo hooks --help` lists list/route/metrics/pretrain/... and NO
 *                        enable|disable subcommand (grep for "enable" exits 1). There is no CLI
 *                        that flips them on; inventing one would be fabrication. Deeper still,
 *                        that capability's own detector proves there is no readable on/off state
 *                        to flip — see the long note on it before trusting any hook table.
 *   harness-evolution    CORRECTED 2026-08-05 (issue #116). This block used to read "No `evolve`"
 *                        and called it VERIFIED NULL. That measurement DRIFTED. Re-measured live
 *                        against ruflo v3.34.0, which is what a user actually has:
 *                          --subcommand  One of: score | genome | mcp-scan | threat-model |
 *                          oia-audit | audit-list | audit-trend | similarity | drift-from-history |
 *                          mint | redblue | learn | gepa | evolve | bench | flywheel
 *                        `evolve` is there, and so are `bench` and `flywheel`.
 *
 *                        The stale claim was LOAD-BEARING, not commentary: it justified
 *                        `turnOn: null`, so the console could never offer an action that had since
 *                        started existing. A null justified by a measurement must be re-measured,
 *                        or it silently becomes a lie — the same failure mode as every other
 *                        drifted assertion in this repo, sitting inside the registry whose whole
 *                        job is to describe what is actually available.
 *
 *                        The offer names its precondition. plugin/skills/brain-score/SKILL.md:97 is
 *                        explicit that the WRITE layer needs OPENROUTER_API_KEY and that we must
 *                        never claim the evolve loop "just works" without it, so the human text
 *                        says so rather than handing someone a command that will fail.
 *   lessons-in-force     Deliberate, not missing: `lesson-seed.mjs --apply` stores CANDIDATES only,
 *                        because "the model does not get to ratify its own rules." A turnOn here
 *                        would hand the model the pen it was explicitly denied.
 *   session-capture,
 *   write-gates,
 *   nightly-refresh      Turning these on means editing settings.json / loading a launchd plist —
 *                        multi-step machine mutation with no single verified command, and global
 *                        Rule 10 forbids handing out system-mutating one-liners unprompted.
 *
 * Everything here is READ-ONLY. It observes; it never installs, enables, or writes.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Two facts this file must NOT restate in its own words, because it already did and both were wrong
// (issues #112, #113): the name of the nightly job the installer loads, and which hooks a session
// really has wired. Both are imported from the modules that own them, statically — a missing sibling
// here is a broken build caught by tests, not a runtime degradation to paper over.
import { NIGHTLY_LABEL } from './nightly-controller.mjs';
import { buildRegistry, REPO } from './hook-registry.mjs';

const HOME = os.homedir();

/**
 * REPO is WHERE THIS CODE IS INSTALLED. It is NOT the user's project, and confusing the two was the
 * single most damaging bug this file has shipped.
 *
 * Every `scope: PROJECT` detector used to read REPO, and `auditAll()` took no argument, so the two
 * project-scoped rows always described the ruvnet-brain package directory no matter where the person
 * running the console actually stood. Proven in both directions, and the second one is the harmful one:
 *
 *   from an empty folder:  "write-gates | ON | 6 gates can refuse a write, and 203 refusals have been
 *                           recorded" — ruvnet-brain's own numbers, presented as the user's.
 *   from a real project
 *   holding a healthy
 *   16MB memory store:     "memory-distillation | ABSENT | no memory store exists for this project
 *                           yet" — plus a turnOn button offering to fix a problem they do not have.
 *
 * Anyone not standing inside a ruvnet-brain checkout — which is every user — got one of those two.
 * `capability-audit.mjs` had this right from the start (process.cwd(), with a --repo override); the
 * registry was the file that disagreed, so the registry is the file that changed.
 *
 * REPO survives for exactly one honest purpose: it is the root `dispatchGateWiring()` hands to
 * hook-registry's buildRegistry(). It is IMPORTED from that module rather than recomputed here,
 * because `..` from this file stopped meaning "the repo root" when this file moved into the payload
 * (2026-08-06) — and hook-registry.mjs is the module that owns resolving that root across both
 * shipped layouts. One answer, in the one place that already had to know it.
 *
 * Resolving the scripts THIS package ships is a SEPARATE job, and it is SCRIPTS_DIR's — see below.
 */
const DAY = 86_400_000;

/**
 * A turnOn command must name its script ABSOLUTELY (a relative `node scripts/x.mjs` only runs for
 * someone standing inside a checkout), and it must name a script that EXISTS — the house rule is
 * "never render a control without a real executor", and capability-registry.test.mjs enforces it.
 *
 * Two candidate homes, probed in that order, because this package ships in two shapes:
 *   1. SCRIPTS_DIR      — a sibling inside the payload. True in EVERY shipped layout (the Spine's
 *                         versions/<gen>/scripts, the plugin cache's <ver>/scripts, and this file's
 *                         own <src>/plugin/scripts), so payload tools resolve everywhere.
 *   2. <root>/scripts   — the repo-root scripts/ dir, which exists in a git checkout and in the npm
 *                         tarball but NOT in the flattened plugin payload. Tools that live only
 *                         there (distill-project.mjs, route-cheap.mjs — both wired into the console's
 *                         remedy registry and the installer's router-tools copy, so relocating them
 *                         is a different change with a different blast radius) resolve here.
 *
 * NULL WHEN NEITHER HOLDS IT. `turnOn: null` is an established, tested shape in this file — it is how
 * every capability with no verified command already renders — and both consumers (console-engine's
 * offer builder and anticipate.sh's one line) already treat a null/blank cmd as "no button". Emitting
 * a plausible-looking `node …/route-cheap.mjs` that ENOENTs on a Spine install would be strictly
 * worse than saying nothing: the whole point of this registry is that it does not claim what it did
 * not check.
 */
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
function selfScript(name, args) {
  const home = [SCRIPTS_DIR, path.join(REPO, 'scripts')].find((d) => fs.existsSync(path.join(d, name)));
  if (!home) return null;
  // plain quotes, not JSON.stringify: JSON doubles every backslash on Windows and users copy-paste this
  return `node "${path.join(home, name)}"${args ? ` ${args}` : ''}`;
}
/** `{human, cmd}` only when the executor is really there; otherwise null. See selfScript() above. */
const selfTurnOn = (human, name, args) => {
  const cmd = selfScript(name, args);
  return cmd ? { human, cmd } : null;
};

/** The four states. 'absent' means "not installed here", which is NOT the same as "installed and off". */
/**
 * IDLE — "you think this is on; it is set up and it is not running."
 *
 * THE STATE THIS PRODUCT EXISTS FOR, and it was missing. Owner, 2026-07-24: "this is exactly what we
 * mean by people thinking something is 'On' only to find out it is not really running and working the
 * way they thought it would — that is exactly what this tool is for."
 *
 * It was found on ourselves. `cheap-model-routing` reported ON off a receipt count alone: any n > 0
 * meant on, forever. The router had 38 receipts, an active policy and a current catalog — and had not
 * routed anything in 4.8 days, because the PreToolUse gate that would invoke it was written on
 * 2026-07-13 and never wired into settings.json. Configured, proven, and inert. The age was even
 * PRINTED in the evidence string and did not touch the verdict, which is the tell: we had the fact and
 * threw it away at the moment of judgement.
 *
 * IDLE is deliberately NOT a flavour of OFF. Off means "we looked and it is not running" and points at
 * turnOn. Idle means "it ran, it works, nothing is calling it now" and points at a WIRING question —
 * usually a hook that was built and never installed. Collapsing the two would send someone to
 * re-enable a thing that is already enabled, which is how a diagnosis becomes a wild goose chase.
 *
 * The horizon is a property of the capability, not a constant: a nightly job idle for 2 days is
 * broken, a router idle for 2 days may just be a quiet weekend. Each detector passes its own.
 */
export const STATE = Object.freeze({ ON: 'on', OFF: 'off', IDLE: 'idle', UNKNOWN: 'unknown', ABSENT: 'absent' });
export const SCOPE = Object.freeze({ PROJECT: 'project', USER: 'user', MACHINE: 'machine' });

/**
 * Sibling helpers are loaded ONCE, lazily, and a load failure degrades to 'unknown' instead of
 * taking the whole registry down. Top-level await keeps every detect() synchronous, which matters:
 * a sync detector cannot be half-awaited by a caller that forgot, and the console renders these
 * rows during a request. The repo has been bitten by a silent import landmine before, so a helper
 * that vanishes must produce an honest "could not load", never a confident zero.
 */
const helpers = {};
for (const [name, spec] of Object.entries({
  memoryDoctor: './memory-doctor.mjs',
  lessonStore: './lesson-store.mjs',
  lessonPromote: './lesson-promote.mjs',
  gates: './gates.mjs',
  // learning-enable.mjs owns the ONE reading of the learner's state file. It is imported rather than
  // re-implemented because the two used to disagree out loud: on a stats.json whose counters had been
  // renamed upstream, this registry said "off — 0 trajectories, 0 patterns, nothing has been learned"
  // while learning-enable, reading the identical bytes, said "UNKNOWN — no recognisable counters".
  // Both shipped, on one machine, in the same minute. Two answers to one question is worse than
  // either answer alone, so the second implementation is gone rather than merely corrected.
  learningEnable: './learning-enable.mjs',
})) {
  try { helpers[name] = await import(spec); }
  catch (e) { helpers[name] = null; helpers[`${name}Err`] = String(e?.message || e).split('\n')[0].slice(0, 90); }
}

const row = (state, evidence) => ({ state, evidence });
const daysSince = (ms) => (ms ? Math.round((Date.now() - ms) / DAY) : null);

/** Read+parse JSON, distinguishing "absent" from "unreadable" — collapsing them hides real corruption. */
function readJSON(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { err: String(e?.message || e).split('\n')[0].slice(0, 80) }; }
}

/** Newest mtime of a file, or null when it does not exist / cannot be stat'd. Never 0 — 0 reads as 1970. */
function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/** Count non-blank lines. Returns null (unknown) rather than 0 when the file cannot be read. */
function lineCount(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; }
  catch { return null; }
}

/**
 * Is a PreToolUse gate on subagent dispatch wired to the cheap-model router?
 *
 * READ THE MERGED REGISTRY, NOT ONE FILE (issue #112). This used to scan `~/.claude/settings.json`
 * for the literal string `route-dispatch.sh`, which is how the LEGACY standalone install wires the
 * gate — and is invisible to the way most people now have it. A plugin-marketplace install wires it
 * in the plugin's own `hooks.json` as `hook-shim.mjs route-dispatch`, never touching settings.json,
 * so `gateWired` was false for every plugin user no matter how correctly the hook was installed. The
 * console then told them "nothing can invoke it" about a gate that was wired.
 *
 * hook-registry.mjs already enumerates every registry a session loads and resolves each command to
 * its HANDLER through hook-shim.mjs's own dispatch table — so `route-dispatch.sh` is recognised
 * whether it is named directly or reached through the shim, and the wiring is found in whichever
 * layer holds it. That module is the authority; this one asks it rather than describing hooks again.
 *
 * WHICH COPY COUNTS, and this is the whole care of the function. The question is what THIS MACHINE
 * loads, so the two code copies nothing boots are excluded: the repo's own `plugin/hooks/hooks.json`
 * is the PREIMAGE (a checkout can be ahead of the installed plugin, and reading the preimage instead
 * of the booted copy is the adjacent-door defect ADR-055 F16 names), and the marketplace clone is
 * where installs are fetched FROM. What Claude Code actually booted on a marketplace install is the
 * plugin-cache copy — and because a cache directory outlives the plugin being switched off, that one
 * counts only while the plugin is enabled.
 */
export function dispatchGateWiring({ repo = REPO, home = HOME } = {}) {
  const PREIMAGE = new Set(['plugin', 'marketplace-clone']);
  // 'codex' joined hook-registry.mjs's mesh 2026-08-20 (Dream Cycle cross-host-conformance) so M1/
  // M3/M5/M6 could see codex-hooks.json — but this function asks a CLAUDE CODE question ("is a
  // PreToolUse gate on subagent dispatch wired to the cheap-model router" for THIS session), and
  // Claude Code never loads codex-hooks.json under any circumstance. Without this exclusion, a
  // resolved codex route-dispatch registration (now correctly matched to route-dispatch.sh via the
  // shared shim table) reported `wired: true` on a machine that had never installed Codex at all —
  // caught by re-running this function before/after the hook-registry.mjs change.
  const NOT_CLAUDE_CODE = new Set(['codex']);
  let records;
  try { records = buildRegistry({ repo, home }).records; }
  catch { return { wired: false, layer: null, unreadable: true }; }
  const hits = records.filter((r) => r.event === 'PreToolUse'
    && r.handler === 'route-dispatch.sh'
    && r.tools.some((t) => t === 'Task' || t === 'Agent' || t === '*')
    && !PREIMAGE.has(r.layer)
    && !NOT_CLAUDE_CODE.has(r.layer));
  const external = hits.find((r) => r.layer !== 'plugin-installed');
  if (external) return { wired: true, layer: external.layer, unreadable: false };
  const enabled = Object.entries(readJSON(path.join(home, '.claude/settings.json')).value?.enabledPlugins || {})
    .some(([k, v]) => k.startsWith('ruvnet-brain@') && v === true);
  const ours = enabled ? hits[0] : null;
  return { wired: Boolean(ours), layer: ours ? ours.layer : null, unreadable: false };
}

/**
 * Locate the ONE global ruflo (global Rule 21 — never npx, which masks a stale global install).
 *
 * LOCATES. NEVER EXECUTES. That distinction is load-bearing and was learned the expensive way: an
 * earlier version of the learning-hooks detector ran `ruflo hooks list` to count rows, and ruflo
 * responds to ANY invocation by auto-starting its daemon and adopting the caller's cwd as its
 * workspace. Measured on a scratch HOME: one call to auditAll() left a live `node cli.js daemon
 * start --foreground` process running after the script exited, plus four files written into HOME
 * (.claude-flow/daemon.pid, daemon-state.json, logs/daemon.log, update-state.json).
 *
 * This is a READ-ONLY status page. Hundreds of people opening it must not each acquire an
 * unrequested long-lived process and a polluted home directory as the price of asking a question.
 * `command -v` is safe because it resolves a name without running the program behind it.
 */
function rufloBin() {
  const p = path.join(HOME, '.npm-global/bin/ruflo');
  if (fs.existsSync(p)) return p;

  // NO LOGIN SHELL. This used to run `sh -lc 'command -v ruflo'`, and the `-l` sources the user's
  // entire profile — every export, nvm/rbenv shim, and one-off line anyone has ever pasted into
  // .profile — as the price of answering "is ruflo installed?". Arbitrary startup code executed by a
  // page whose defining promise, stated four lines above, is that it only observes. Milder than the
  // daemon spawn already removed from this file, and the same category of mistake.
  //
  // PATH lookup does the same job with no shell at all: resolving a name against directories, which
  // is all `command -v` was ever wanted for here.
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, `ruflo${ext}`);
      try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

/**
 * Count hook entries that carry an actual command, across a settings.json hook group array.
 *
 * Counting the GROUPS instead — `hooks.PreCompact.length` — is the bug this replaces. A matcher
 * group is a container; `[{matcher:'.*',hooks:[]}]` has length 1 and runs nothing at all. Verified:
 * a settings.json holding exactly that for both boundaries made this registry report session capture
 * "on — both boundaries are covered", which is a fabricated status about a machine that would lose
 * every session. Only a non-empty `command` string is evidence that anything executes.
 */
function countHookCommands(groups) {
  if (!Array.isArray(groups)) return 0;
  let n = 0;
  for (const g of groups) {
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (typeof h?.command === 'string' && h.command.trim()) n += 1;
    }
  }
  return n;
}

/**
 * Commands at a session boundary that plausibly PERSIST STATE — the only ones "session capture" is a
 * true statement about.
 *
 * Deliberately a whitelist of named mechanisms rather than "any command": the boundary tells you when
 * something runs, never what it does, and this row claims what it does. `echo done` at SessionEnd is
 * a registered hook and captures nothing. Each pattern below is a real writer — the global autocapture
 * hook, ruflo/claude-flow's own session and memory subcommands, agentdb, or a script whose name says
 * it captures/persists — so a match is evidence, not a guess.
 *
 * Returns null (never 0) when any part of the structure is unparseable. See the caller: an incomplete
 * count rendered as a complete one is the failure this whole file exists to refuse.
 */
const CAPTURE_COMMAND = /(agentdb|autocapture|auto-capture|session-end|session_end|sessionend|precompact|pre-compact|memory[\s_-]*(store|save|persist)|\bruflo\b[^"]*\b(memory|session|hooks)\b|claude-flow[^"]*\b(memory|session|hooks)\b|(capture|persist|snapshot|checkpoint)[\w-]*\.(mjs|js|sh|py))/i;

function countCaptureCommands(groups) {
  if (groups === undefined) return 0;          // nothing registered at this boundary is a real answer
  if (!Array.isArray(groups)) return null;     // present but unreadable — not the same as absent
  let n = 0;
  for (const g of groups) {
    if (g?.hooks !== undefined && !Array.isArray(g.hooks)) return null;
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      const cmd = typeof h?.command === 'string' ? h.command.trim() : '';
      if (!cmd) continue;
      if (CAPTURE_COMMAND.test(cmd)) n += 1;
    }
  }
  return n;
}

// ── The capabilities ─────────────────────────────────────────────────────────────────────────────
// Ordered by blast radius: the ones whose dormancy costs the most sit at the top, because this list
// is rendered in order and nobody reads to the bottom.

export const CAPABILITIES = [
  {
    key: 'learning-hooks',
    label: 'Learning hooks',
    whatItBuysYou: 'Your AI writes down which approach actually worked and reuses it next time, instead of solving the same problem from scratch every session.',
    scope: SCOPE.MACHINE,
    // VERIFIED NULL: there is no enable command, and — more importantly — no readable state to flip.
    turnOn: null,
    /**
     * THIS DETECTOR RETURNS 'unknown' ON PURPOSE, AND THE FIRST VERSION OF IT WAS A LIE.
     *
     * It originally parsed the `Enabled` column of `ruflo hooks list` and reported, confidently:
     * "all 26 registered hooks report Enabled: No … nothing is being learned from your sessions."
     * That is the single most alarming sentence this registry could print, and it was false. It was
     * caught within the hour by cross-checking against the installed ruflo source, and every step
     * was then re-verified here rather than taken on trust:
     *
     *   · `ruflo hooks list --format json` returns rows of {name, type, status:"active"} — there is
     *     NO `enabled` key in the payload at all.
     *   · The CLI renderer draws a column keyed `enabled`, so `v` is `undefined` for every row and
     *     the formatter prints its falsy branch: "No", 26 times. Same artifact empties Priority and
     *     Executions and makes Last Executed read "Never" for everything.
     *   · `ruflo hooks list --enabled`, documented as "Show only enabled hooks", returns the exact
     *     same 27 lines as the unfiltered call — the filter is passed to a handler that takes no
     *     arguments.
     *   · The handler itself (@claude-flow/cli .../mcp-tools/hooks-tools.js, `export const
     *     hooksList`) contains zero reads of any file, database, or env var, and the string
     *     "enabled" does not appear in it. It is a hardcoded catalog of which subcommands exist.
     *
     * So `ruflo hooks list` is a MENU, not a dashboard, and BOTH readings of it are worthless:
     * "Enabled: No" is a field-name bug, and status:"active" is a literal in a static array. It
     * cannot answer "is learning on?" in either direction, which makes 'unknown' the only honest
     * state available from this source — and 'off' the precise false accusation the header warns
     * about, committed against rUv's own tooling.
     *
     * The MEASURED answer lives in the `workflow-pattern-learning` row, which counts trajectories
     * and patterns actually recorded. Outcomes are evidence; a catalog of subcommands is not.
     */
    /**
     * AND IT NO LONGER RUNS `ruflo hooks list` AT ALL — which is the second lesson, layered on the
     * first. Having established above that the table cannot answer the question in either direction,
     * the old code still SHELLED OUT to fetch it, purely to print a row count in a sentence whose
     * substance is "this number tells you nothing." That cost a daemon and four files in the user's
     * home directory (see rufloBin) for a fact we then disclaim in the same breath.
     *
     * A probe whose result you have already decided to disregard should not be run. So presence is
     * established from the binary on disk — a fact a status page is entitled to read — and the state
     * stays honestly unknown, pointing at the row that measures OUTCOMES instead.
     */
    detect() {
      const bin = rufloBin();
      if (!bin) return row(STATE.ABSENT, 'ruflo is not installed on this machine, so there are no learning hooks to enable');
      return row(STATE.UNKNOWN, 'ruflo is installed, but whether its learning hooks are switched on cannot be read from it: `ruflo hooks list` is a static catalog of available subcommands, not a state readout (its own --enabled filter returns every row unchanged, and its handler reads no file, database, or env var). Rather than run a command whose answer we would have to disclaim — and which starts a background daemon to produce it — nothing is claimed here. Measured learning activity is reported by the workflow-learning row instead.');
    },
  },

  {
    key: 'memory-distillation',
    label: 'Memory distillation',
    whatItBuysYou: 'Loose notes from past sessions get mined into reusable patterns, so your AI recalls the lesson instead of re-reading every old note to find it.',
    scope: SCOPE.PROJECT,
    // The offer points at scripts/distill-project.mjs, NOT at bare `ruflo memory distill run`, and the
    // difference is the whole reason ADR-047 was rejected. Both duelists found the same hole: the
    // registry offers `turnOn` commands whose promised undo lives on a DIFFERENT execution path than
    // the action actually handed to the user. Here that was literal — the inverse advertised for
    // distillation restores snapshots that `health-repair.mjs --distill-fleet` takes, while this line
    // used to hand over the raw command, which (verified against `--help`) takes no snapshot at all.
    // Run it, dislike the result, and there was nothing to go back to.
    //
    // The wrapper sequences rUv's own commands so the operation is reversible: WAL-safe
    // `ruflo memory backup` FIRST (cp on a live WAL DB silently amputates the newest transactions —
    // this project has lost data that way), a durable fsync'd receipt fail-closed BEFORE any mutation,
    // `distill run --db` scoped to THIS project rather than whatever the cwd implies, and a verified
    // pattern delta reported as a measurement. `--restore` is the tested inverse.
    //
    // PROVEN end to end against the real store, 2026-07-24: 644 → 648 patterns (+4), restore → 644,
    // re-run → 648, five durable receipts, $0.0000. This is the ONE capability whose undo has actually
    // been run rather than merely promised — which is precisely what makes it the only one offerable.
    turnOn: selfTurnOn(
      'Mine this project\'s stored memories into reusable patterns (snapshots first; reversible)',
      'distill-project.mjs',
    ),
    detect({ project = process.cwd() } = {}) {
      const db = path.join(project, '.swarm/memory.db');
      if (!fs.existsSync(db)) return row(STATE.ABSENT, `no memory store exists for this project yet (${path.join(path.basename(project), '.swarm/memory.db')} is not present)`);
      if (!helpers.memoryDoctor) return row(STATE.UNKNOWN, `the memory diagnostic could not be loaded (${helpers.memoryDoctorErr}) — distillation state not checked`);

      let d;
      try { d = helpers.memoryDoctor.diagnose(db); }
      catch (e) { return row(STATE.UNKNOWN, `the memory store could not be diagnosed: ${String(e?.message || e).slice(0, 60)}`); }

      // THE UNREADABLE CASE, and the entire reason this file states its rule twice. `learns` is false
      // in BOTH the dead case and the could-not-open case, so trusting it blindly turns a failed read
      // into a false accusation. The STATE here was always right; the REASON was not.
      //
      // What this used to say, to every unreadable store without distinction: "this is often a passing
      // lock from another session, not a fault; re-check before acting." That sentence generalised ONE
      // real observation — a store that read unreadable and then healthy 90 seconds later, which was a
      // genuine concurrent writer — into a blanket explanation for every failure mode. It was wrong on
      // this very repo, whose WAL sidecars had been renamed to .CORRUPT-*: that store was structurally
      // unopenable, re-checking would never have cleared it, and the console told its owner to wait.
      // Advice that cannot work is worse than no advice, because the person takes it.
      //
      // The open failure itself is now handled properly in memory-doctor's q() (resting-WAL fallback),
      // so what reaches here is a real lock or a real fault — and it says which it can distinguish
      // rather than asserting one of them.
      if (d.unreadable) {
        const locked = /lock|busy|writer/i.test(String(d.unreadable));
        return row(STATE.UNKNOWN, locked
          ? `the memory store is currently held by another process (${d.unreadable}) — that is a passing lock, not a fault; re-checking in a moment should clear it`
          : `the memory store could not be read (${d.unreadable}) — this is not a transient lock, so re-checking will not clear it; the store or its journal files need attention before distillation state can be established`);
      }
      if (d.schemaless) return row(STATE.UNKNOWN, 'the store exists but has no memory_entries table (pre-AgentDB schema, never initialised) — nothing to distill yet, and nothing is broken');
      if (typeof d.total !== 'number') return row(STATE.UNKNOWN, 'the store opened but returned no countable rows — distillation state not established');

      if (d.total === 0) return row(STATE.ABSENT, 'the memory store is empty, so there is nothing to distill yet');
      if (d.learns) return row(STATE.ON, `${d.patterns} reusable patterns distilled from ${d.real} memories (${(d.cover * 100).toFixed(1)}% embedded)`);
      if (d.patterns === 0) return row(STATE.OFF, `${d.total} memories stored and ${(d.cover * 100).toFixed(1)}% embedded, but 0 have been distilled into patterns — the store records and forgets`);
      // "BARELY RUN" IS NOT "NOT RUNNING". This returned STATE.OFF while its own sentence says the
      // thing has produced patterns — used-and-weak reported as never-used. OFF is a claim that we
      // looked and found it stopped; here we looked and found it working, thinly. Reporting a working
      // capability as off sends the user to switch on something already on, and it corrupts the
      // dormancy predicate that ADR-047 wants to build offers from: a capability that HAS run is not
      // a dormancy finding, whatever its ratio. The weak ratio is still said out loud — it belongs in
      // the evidence, which is where a concern with no action attached should live.
      // Found by Fable 5 in the ADR-047 duel, 2026-07-24.
      return row(STATE.ON, `only ${d.patterns} patterns from ${d.real} memories — distillation has run, but thinly`);
    },
  },

  {
    key: 'workflow-pattern-learning',
    label: 'Workflow learning',
    whatItBuysYou: 'Your AI picks up how you personally like work done and carries that across every project, rather than starting each one as a stranger.',
    scope: SCOPE.USER,
    // VERIFIED: `ruflo hooks pretrain --help` exists (4-step pipeline + embeddings, --path default '.').
    turnOn: { human: 'Bootstrap the learner from this repository', cmd: 'ruflo hooks pretrain' },
    /**
     * DELEGATED to learning-enable.mjs, which is the only place the learner's state file is read.
     * The hand-rolled version this replaces committed BOTH of the mistakes this file warns about:
     *
     *   SCHEMA DRIFT READ AS A MEASUREMENT. `Number(r.value?.trajectoriesRecorded) || 0` turns
     *   NaN into 0, so the day rUv renames that field every user is simultaneously told "the learner
     *   file exists but records 0 trajectories and 0 patterns — nothing has been learned yet."
     *   Reproduced on a stats.json carrying 457 real trajectories under `trajectories_recorded`:
     *   this row said OFF; learning-enable, on the same bytes, said UNKNOWN. Its `num()` returns
     *   null rather than 0 precisely so an unreadable counter can never masquerade as a measured
     *   zero — which is the header's rule, implemented once, correctly, in the other file.
     *
     *   NO STALENESS. A learner last adapted 400 days ago reported "on — 457 sessions recorded",
     *   while learning-enable called the same file "IDLE — nothing in 400 days". Freshness is part
     *   of the verdict, not a footnote, and STALE_DAYS now has exactly one definition.
     */
    detect() {
      if (!helpers.learningEnable) return row(STATE.UNKNOWN, `the learner probe could not be loaded (${helpers.learningEnableErr}) — learning state not checked`);
      let learner;
      let v;
      try {
        learner = helpers.learningEnable.readLearnerState({ home: HOME });
        v = helpers.learningEnable.verdict(learner);
      } catch (e) { return row(STATE.UNKNOWN, `the learner state could not be read (${String(e?.message || e).slice(0, 60)}) — learning state not checked`); }

      const traj = learner.trajectories;
      const pat = learner.patterns;
      const days = learner.ageMinutes === null ? null : Math.floor(learner.ageMinutes / 1440);
      switch (v.code) {
        case 'NO_LEARNER_STATE':
          return row(STATE.ABSENT, 'no learner state exists yet (~/.claude-flow/neural/stats.json has never been written)');
        case 'CORRUPT':
          return row(STATE.UNKNOWN, 'the learner state file exists but could not be parsed — counts not checked, and nothing is concluded from an unreadable file');
        case 'UNKNOWN_SHAPE':
          // The drift case, stated as the obstacle it is. NEVER "0 trajectories" — that is a claim
          // about the learner; this is a claim about our ability to read it.
          return row(STATE.UNKNOWN, 'the learner state file exists but carries no counters this version recognises — the field names have probably changed upstream, so whether it has learned anything cannot be read here');
        case 'UNKNOWN_PARTIAL':
          // HALF-DRIFT, and the half we cannot read decides the answer. Rendering the readable half
          // as though it settled the question is how "null work sessions recorded and 457 patterns
          // learned" reached a user's screen. One unread counter, one honest unknown.
          return row(STATE.UNKNOWN, `the learner state file is only half-readable — ${v.missingField} is not a number this version recognises, so the counters cannot be compared and no verdict is drawn from the half that did parse`);
        case 'INITIALISED_EMPTY':
          return row(STATE.OFF, 'the learner file exists and genuinely records 0 trajectories and 0 patterns — it has been created but never fed');
        case 'IDLE':
          // WAS STATE.OFF UNTIL 2026-07-24, AND THAT WAS THE SAME BUG THIS FILE ADDED STATE.IDLE TO END.
          //
          // The verdict is literally named IDLE and its own sentence says "ran before and has gone
          // quiet" — the textbook definition of the state added to the top of this file hours earlier.
          // It kept returning OFF because STATE.IDLE was wired into exactly ONE detector
          // (cheap-model-routing) and no others. One bug, found once, fixed once, left everywhere else.
          //
          // WHY IT MATTERS BEYOND TIDINESS: OFF means "we looked and it is not running" and points the
          // user at turnOn. A learner holding hundreds of trajectories is not off — it worked, and
          // something stopped calling it. Offering to "turn on" an already-populated learner is the
          // category error that put "457 patterns learned" next to an invitation to enable it.
          // Found by Fable 5 in the ADR-047 duel, one file over from where I had just fixed it.
          return row(STATE.IDLE, `${traj} work sessions and ${pat} patterns were recorded, but nothing in ${days} days — the learner ran before and has gone quiet. It is not off; something that fed it stopped.`);
        default: {
          // TWO IDENTICAL NUMBERS ARE ONE FACT, NOT TWO ACHIEVEMENTS.
          //
          // Measured live 2026-07-24: trajectoriesRecorded 1114, patternsLearned 1114 — exactly 1:1.
          // Rendered as "1114 work sessions recorded AND 1114 patterns learned", that reads as two
          // independent wins and implies a distillation step. Fable 5's verdict, and it is right: a
          // sharp reader sees the 1:1 instantly and concludes the counter is counting itself.
          //
          // WHAT I DID NOT CONCLUDE: that ruflo's learner is fake. Grounded in rUv's own source
          // (ruflo/v3/@claude-flow/memory/src/persistent-sona.ts), extractPatternsFromTrajectory()
          // stores a pattern ONLY when findSimilarPatterns() finds no near-duplicate — so patterns
          // ARE deduplicated by design and the ratio should sit below 1:1. I cannot explain an exact
          // 1:1 from the code I have read, and the counters in ~/.claude-flow/neural/stats.json may
          // be written by a different path than that module. Unexplained is not the same as false.
          //
          // So this says only what is observed. When the two counts are equal we report ONE number
          // and name the identity out loud, which is both honest and the more interesting signal —
          // it tells the reader something is worth asking about instead of quietly inflating.
          const when = days === null ? '' : `, last updated ${days} day${days === 1 ? '' : 's'} ago`;
          if (traj === pat && traj > 0) {
            return row(STATE.ON, `${traj} work sessions recorded, and the pattern count matches it exactly (${pat}) — one pattern per session, with no reduction between them${when}`);
          }
          return row(STATE.ON, `${traj} work sessions recorded and ${pat} patterns learned${when}`);
        }
      }
    },
  },

  {
    key: 'cheap-model-routing',
    label: 'Cheap-model routing',
    whatItBuysYou: 'Reading and summarising work runs on a model that costs a fraction of the top-tier one, and each run leaves a receipt showing what it saved.',
    scope: SCOPE.MACHINE,
    // VERIFIED: `node scripts/route-cheap.mjs` prints its usage line requiring --task; script present in repo.
    // ABSOLUTE, via selfScript(). `node scripts/route-cheap.mjs` is copy-pasteable only by someone
    // already standing in a ruvnet-brain checkout; everyone else got `Cannot find module`. A real
    // executor behind an unreachable path is a dead button with extra steps.
    turnOn: selfTurnOn('Route one read-only task through the cheap path', 'route-cheap.mjs', '--task "<text>"'),
    detect() {
      const bin = path.join(HOME, '.npm-global/bin/agentic-flow');
      const installed = fs.existsSync(bin);
      const receipts = process.env.METAHARNESS_RECEIPTS || path.join(HOME, '.claude/metaharness/routing-receipts.jsonl');
      const n = lineCount(receipts);

      // Receipts are the proof, and they outrank installation: a receipt file with lines means this
      // genuinely ran, even if the binary later moved. Absence of the binary AND of receipts is the
      // only honest 'absent'.
      if (n === null && !fs.existsSync(receipts)) {
        return installed
          ? row(STATE.OFF, 'agentic-flow is installed but no routing receipt has ever been written — the cheap path exists and has never been used')
          : row(STATE.ABSENT, 'agentic-flow is not installed and no routing receipts exist, so cheap routing has never been set up here');
      }
      if (n === null) return row(STATE.UNKNOWN, 'the routing receipt ledger exists but could not be read — usage not checked');
      if (n === 0) return row(STATE.OFF, 'the routing receipt ledger is present but empty — no task has been routed to a cheaper model');
      const age = daysSince(mtimeOf(receipts));

      // THE AGE NOW DECIDES, INSTEAD OF DECORATING. This line used to return ON for any n > 0 and
      // merely MENTION the age in the evidence — so a router with 38 receipts and nothing invoking it
      // for a fortnight read as healthy. We were holding the disproving fact and printing it politely.
      //
      // 7 days: this path should fire on ordinary sessions, so a full quiet week means something
      // upstream stopped calling it — not that the user had a light week. Measured on this machine
      // 2026-07-24: 38 receipts, last one 4.8 days old, and the PreToolUse gate that invokes it
      // (plugin/scripts/route-dispatch.sh, written 2026-07-13) had never been added to settings.json.
      // Built, correct, and unwired — which no state in this registry could previously express.
      // MEASURE THE CAUSE, NOT A SYMPTOM. An age threshold alone is a proxy and it FAILED on the real
      // case: measured 2026-07-24, the last receipt was 5 days old — under any sane horizon — while the
      // router was in fact never being consulted at all. A quiet week and a severed wire look identical
      // from the receipt file, so read the wire directly.
      //
      // Two things must both be true for the host-limited dispatch audit to record anything: a
      // PreToolUse hook on subagent dispatch and the opt-in profile it refuses to act without
      // (route-dispatch.sh exits 0 when
      // profile.json is absent). Either missing ⇒ the router cannot fire, regardless of how healthy
      // the receipt ledger looks.
      const profile = fs.existsSync(path.join(HOME, '.claude/model-router/profile.json'));
      // ONE READING OF THE WIRING, from the module that owns it — see dispatchGateWiring(). Scanning
      // settings.json here was a second, narrower implementation of that question, and it answered
      // "not wired" for every plugin-marketplace install (issue #112).
      const gate = dispatchGateWiring();
      const gateWired = gate.wired;
      // THE ONE RULE OF THIS FILE. A census we could not take is not a gate we observed to be
      // missing, and "nothing can invoke it" is a claim about the user's machine.
      if (gate.unreadable) return row(STATE.UNKNOWN, `${n} routing receipt${n === 1 ? '' : 's'} recorded, but the hook registries on this machine could not be read — whether anything is wired to invoke the router was not checked`);

      if (!gateWired || !profile) {
        const missing = [!gateWired && 'no PreToolUse gate on Task|Agent is wired to route-dispatch.sh',
          !profile && 'no ~/.claude/model-router/profile.json (the opt-in the gate requires)'].filter(Boolean).join('; and ');
        return row(STATE.IDLE,
          `set up and proven — ${n} routing receipt${n === 1 ? '' : 's'} recorded — but nothing can invoke it: ${missing}. `
          + 'Every receipt so far came from someone running the router by hand. Until the gate is wired, subagents keep '
          + 'inheriting this session\'s model, which is the single largest cost leak in the harness.');
      }

      const IDLE_AFTER_DAYS = 7;
      if (age !== null && age > IDLE_AFTER_DAYS) {
        return row(STATE.IDLE,
          `set up and proven — ${n} routing receipt${n === 1 ? '' : 's'} recorded — but nothing has routed through it in ${age} days. `
          + 'It is configured; something that should be calling it is not. Check that the subagent-dispatch gate is wired '
          + '(a PreToolUse hook on Task|Agent) and that ~/.claude/model-router/profile.json exists — without either, the router is never consulted.');
      }
      return row(STATE.ON, `${n} routing receipt${n === 1 ? '' : 's'} recorded${age === null ? '' : `, most recent ${age} day${age === 1 ? '' : 's'} ago`}`);
    },
  },

  {
    key: 'cross-project-lessons',
    label: 'Cross-project lessons',
    whatItBuysYou: 'A rule you have taught in three separate projects gets applied everywhere, instead of being re-taught project by project forever.',
    scope: SCOPE.USER,
    // VERIFIED: `lesson-promote.mjs --apply` exists (backs up first, reversible — see its header).
    turnOn: selfTurnOn('Promote the processes you have proven in several projects', 'lesson-promote.mjs', '--apply'),
    detect() {
      if (!helpers.lessonPromote) return row(STATE.UNKNOWN, `the cross-project scanner could not be loaded (${helpers.lessonPromoteErr}) — promotion state not checked`);
      let result;
      try { result = helpers.lessonPromote.analyze(helpers.lessonPromote.collectLessons()); }
      catch (e) { return row(STATE.UNKNOWN, `the cross-project lesson scan failed (${String(e?.message || e).slice(0, 60)}) — promotion state not checked`); }

      const scanned = result?.scanned || {};
      const promotable = result?.promotable || [];
      if (!scanned.lessons) return row(STATE.ABSENT, 'no per-project lessons were found to compare, so there is nothing to promote yet');

      // EFFECT IN FORCE, not backlog remaining. REJECTED by both duelists 2026-07-24: the old rule was
      // ON iff promotable.length === 0, so teaching two new lessons anywhere flipped a WORKING capability
      // to OFF — permanently, since the backlog always re-arms. Measured on this machine: it read OFF
      // while the promoted block was sitting in the user's global CLAUDE.md, put there the same day.
      // Worse, the evidence string carries a live counter and stateHashOf() hashes that prose, so every
      // tick minted a fresh "the world changed, you may speak again" token — a perpetual-nag engine.
      // Dormant must mean INSTALLED, USABLE, NEVER USED. Promotion writes a marked block into the user's
      // global instructions; the presence of that block is the only honest evidence it is in use.
      let promotedInForce = false;
      try {
        promotedInForce = fs.readFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), 'utf8')
          .includes('BEGIN ruvnet-brain: promoted-lessons');
      } catch { promotedInForce = false; }

      if (promotedInForce) {
        return row(STATE.ON, promotable.length
          ? `cross-project promotion is in force in your global instructions; ${promotable.length} further process${promotable.length === 1 ? '' : 'es'} ${promotable.length === 1 ? 'has' : 'have'} since become eligible (from ${scanned.lessons} lessons across ${scanned.projects} projects)`
          : `cross-project promotion is in force in your global instructions, and nothing further is waiting (from ${scanned.lessons} lessons across ${scanned.projects} projects)`);
      }
      if (promotable.length === 0) return row(STATE.ON, `${scanned.lessons} lessons across ${scanned.projects} projects scanned, and none are stuck at project level`);
      return row(STATE.OFF, `promotion has never been applied on this machine, and ${promotable.length} process${promotable.length === 1 ? '' : 'es'} you have taught in multiple separate projects ${promotable.length === 1 ? 'is' : 'are'} still trapped at project level (from ${scanned.lessons} lessons across ${scanned.projects} projects)`);
    },
  },

  {
    key: 'lessons-in-force',
    label: 'Lessons in force',
    whatItBuysYou: 'The corrections you have given your AI actually constrain what it does next, rather than sitting in a file it never consults.',
    scope: SCOPE.USER,
    // VERIFIED NULL, BY DESIGN: ratification is deliberately withheld from the model (see header).
    turnOn: null,
    detect() {
      if (!helpers.lessonStore) return row(STATE.UNKNOWN, `the lesson store could not be loaded (${helpers.lessonStoreErr}) — enforcement state not checked`);
      const file = helpers.lessonStore.STORE_PATH;
      if (!fs.existsSync(file)) return row(STATE.ABSENT, 'no lessons have been recorded yet on this machine');
      let lessons;
      try { lessons = helpers.lessonStore.loadLessons(); }
      catch (e) { return row(STATE.UNKNOWN, `the lesson store could not be read (${String(e?.message || e).slice(0, 60)}) — enforcement state not checked`); }
      if (!Array.isArray(lessons) || lessons.length === 0) return row(STATE.ABSENT, 'the lesson store exists but holds no lessons yet');

      const S = helpers.lessonStore.STATUS || {};
      const inForce = lessons.filter((l) => l?.status === S.RATIFIED || l?.status === S.ACTIVE).length;
      // AWAITING YOU means RATIFIABLE BY YOU (issue #125). This counted every CANDIDATE, including
      // the seeded imported-owner lessons — which `ratify()` refuses by design and `pending()`
      // excludes, so `lesson-ratify --list` correctly reported "0 awaiting your decision" while this
      // card said 12 were awaiting ratification. Two surfaces, two answers, and the card's was the
      // one asking the user to act on something that cannot be acted on. The quarantine is right;
      // describing it as a pending decision is not.
      //
      // Delegated to the store's own pending(), rather than re-deriving the predicate here — a
      // second copy is exactly how these two numbers drifted apart in the first place.
      const ratifiable = typeof helpers.lessonStore.pending === 'function'
        ? helpers.lessonStore.pending(lessons).length
        : lessons.filter((l) => l?.status === S.CANDIDATE && !l?.demoted).length;
      const quarantined = lessons.filter((l) => l?.status === S.CANDIDATE).length - ratifiable;
      if (inForce > 0) return row(STATE.ON, `${inForce} of ${lessons.length} lessons are ratified and can affect what your AI does`);
      if (ratifiable > 0) {
        return row(STATE.OFF, `${ratifiable} recorded lesson(s) are candidates awaiting your ratification — none of them can influence anything yet`);
      }
      // Nothing is actually waiting on the user. Say what IS true instead of inventing a decision.
      return row(STATE.OFF, quarantined > 0
        ? `${quarantined} bundled maintainer lesson(s) are quarantined and cannot be ratified — nothing is awaiting your decision`
        : 'no lessons are in force yet, and none are awaiting your decision');
    },
  },

  {
    key: 'harness-evolution',
    label: 'Harness self-improvement',
    // Issue #116: this was `turnOn: null`, justified by a "VERIFIED NULL: evolve is not among them"
    // measurement that has since drifted — ruflo v3.34.0 ships evolve, bench and flywheel. The
    // precondition is named in the human text because brain-score/SKILL.md:97 requires the WRITE
    // layer's OPENROUTER_API_KEY to be disclosed rather than discovered on failure.
    turnOn: {
      human: 'Evolve the harness and keep only measured winners (needs OPENROUTER_API_KEY; without it, `--subcommand score` is the free read-only layer)',
      cmd: 'ruflo metaharness --subcommand evolve',
    },
    whatItBuysYou: 'The rules your AI works by get tested against each other, and the version that measurably does better becomes the new default.',
    scope: SCOPE.MACHINE,
    // VERIFIED NULL: `ruflo metaharness --help` enumerates its subcommands and `evolve` is not among them.
    turnOn: null,
    detect({ project = process.cwd() } = {}) {
      const policy = path.join(HOME, '.claude-flow/harness-active-policy.json');
      // The archive is a per-project artifact even though the ACTIVE POLICY it feeds is machine-wide,
      // so it is read from where the user stands. Reading it from REPO is what made a fresh machine
      // appear to have run self-improvement it had never run.
      const archive = path.join(project, '.metaharness/archive.json');
      const p = readJSON(policy);
      const haveArchive = fs.existsSync(archive);

      if (p.err) return row(STATE.UNKNOWN, `the active-policy file exists but could not be parsed (${p.err}) — cannot tell whether an evolved policy is in force`);
      if (!p.missing && p.value?.championId) {
        const age = p.value.appliedAt ? daysSince(p.value.appliedAt) : null;
        const tier = p.value.provenanceTier || 'unknown provenance';
        return row(STATE.ON, `an evolved policy is active machine-wide (${String(p.value.championId).slice(0, 20)}…, provenance ${tier}${age === null ? '' : `, applied ${age} day${age === 1 ? '' : 's'} ago`})`);
      }
      // IDLE, not OFF: the sentence says it HAS RUN. Off means never used and points at turnOn;
      // this ran and stopped, which is a wiring question. Same class as the learner fix above.
      // Found by GPT-5.6-Sol in the ADR-047 duel, 2026-07-24.
      if (haveArchive) return row(STATE.IDLE, 'self-improvement has run in this repo but no evolved policy is currently in force — nothing it discovered is being used');
      return row(STATE.ABSENT, 'self-improvement has never run here and no evolved policy is active');
    },
  },

  {
    key: 'write-gates',
    label: 'Write gates',
    whatItBuysYou: 'Your AI is stopped before it writes something you have already told it not to, instead of you catching it in review.',
    scope: SCOPE.PROJECT,
    // Turning a gate on means hand-editing settings.json hook arrays — no single verified command.
    turnOn: null,
    detect({ project = process.cwd() } = {}) {
      if (!helpers.gates) return row(STATE.UNKNOWN, `the gate survey could not be loaded (${helpers.gatesErr}) — gate state not checked`);
      let survey;
      try { survey = helpers.gates.gatesSurvey({ repo: project }); }
      catch (e) { return row(STATE.UNKNOWN, `the gate survey failed (${String(e?.message || e).slice(0, 60)}) — gate state not checked`); }

      const s = survey?.summary || {};
      if (!s.armed) return row(STATE.ABSENT, 'no gates are wired on this machine or in this project');
      // "1 gates are wired" shipped, because the plural on `refusal` was handled and the one on
      // `gate` beside it was not. Small, but this surface is read by people deciding whether to
      // trust it, and sloppy copy reads as sloppy measurement.
      const gates = (n) => `${n} gate${n === 1 ? '' : 's'}`;
      // ON, not OFF: gates ARE wired and ARE reading every move — they just cannot refuse one. That
      // is a weaker MODE of running, not an absence of running. Reporting it OFF tells the user to
      // switch on something already on, and hides that they have advisory coverage today.
      // Found by GPT-5.6-Sol in the ADR-047 duel, 2026-07-24.
      if (!s.blocking) return row(STATE.ON, `${gates(s.armed)} ${s.armed === 1 ? 'is' : 'are'} wired but ${s.armed === 1 ? 'it cannot' : 'none of them can'} actually refuse anything — ${s.armed === 1 ? 'it is' : 'they are'} advisory`);
      // Receipts began only once the ledger was added, so "0 caught" is genuinely ambiguous between
      // "never fired" and "fired before we were counting". Say armed, and say the caveat.
      const caught = s.caughtTotal || 0;
      return row(STATE.ON, caught > 0
        ? `${gates(s.blocking)} can refuse a write, and ${caught} refusal${caught === 1 ? ' has' : 's have'} been recorded (${s.caughtThisWeek || 0} this week)`
        : `${gates(s.blocking)} can refuse a write; no refusals are recorded yet, which may mean nothing has warranted one`);
    },
  },

  {
    key: 'session-capture',
    label: 'Session capture',
    whatItBuysYou: 'What you worked out in a long session survives when the conversation is compacted or ends, instead of being lost with the window.',
    scope: SCOPE.MACHINE,
    // Registering hooks means editing settings.json by hand — no single verified command.
    turnOn: null,
    detect() {
      const r = readJSON(path.join(HOME, '.claude/settings.json'));
      if (r.missing) return row(STATE.ABSENT, 'no Claude Code settings file exists on this machine yet');
      if (r.err) return row(STATE.UNKNOWN, `the settings file could not be parsed (${r.err}) — capture hooks not checked`);
      const hooksRoot = r.value?.hooks;
      if (hooksRoot !== undefined && (!hooksRoot || typeof hooksRoot !== 'object' || Array.isArray(hooksRoot))) {
        return row(STATE.UNKNOWN, 'the settings file has a hooks section this version cannot interpret — capture hooks not counted');
      }
      const hooks = hooksRoot || {};
      // COUNT COMMANDS, NOT MATCHER GROUPS. See countHookCommands: `[{matcher:'.*',hooks:[]}]` has
      // length 1 and executes nothing, and the old `.length` check called that "both boundaries are
      // covered" — a fabricated ON on a machine that saves nothing.
      //
      // AND COUNT *CAPTURE* COMMANDS, NOT ANY COMMAND. The old count accepted whatever was wired at
      // those two boundaries, so a shell logger and a terminal beep — neither of which saves a byte of
      // session state — produced "Session capture: ON". MEASURED with exactly that pair. The boundary
      // a command is attached to says WHEN it runs, never WHAT it does, and this row's whole claim is
      // about what it does. A command is only counted when it names a mechanism known to persist state.
      //
      // A MALFORMED GROUP POISONS THE COUNT rather than being skipped — the same rule, and the same
      // words, as learning-enable.readSettingsWiring, which documents at length why skipping an
      // unparseable entry and reporting the remainder as a total is this project's signature lie.
      // MEASURED: a PreCompact written as an object instead of an array was silently skipped and the
      // row reported OFF — "nothing is saved when a session compacts" — about a machine whose capture
      // hook we simply failed to parse. Identical structure to the bug fixed in that file, opposite
      // treatment, same commit.
      const pre = countCaptureCommands(hooks.PreCompact);
      const end = countCaptureCommands(hooks.SessionEnd);
      if (pre === null || end === null) {
        return row(STATE.UNKNOWN, `the ${pre === null ? 'pre-compaction' : 'session-end'} hook list could not be parsed, so whether anything is registered there cannot be read — no conclusion is drawn from the half that did parse`);
      }
      // "registered", never "capturing" — the same standard the MCP row holds itself to twenty lines
      // below. A settings entry proves a command is wired to fire; no local artifact proves it ever
      // ran or that it succeeded when it did, and claiming captured state from a config file would be
      // exactly the fabricated status this registry exists to refuse.
      if (pre && end) return row(STATE.ON, 'a state-saving hook is registered at both boundaries: one before compaction and one at session end — registered, which is not the same as proven to have captured anything');
      // ON, not OFF: one boundary IS covered. Partially configured is not never-used — half the
      // sessions are being saved today, and calling that "off" both understates what they have and
      // invites them to re-enable a thing already running. The gap is named in the evidence, which is
      // where a real but partial shortfall belongs. Found by GPT-5.6-Sol, 2026-07-24.
      if (pre || end) return row(STATE.ON, `a state-saving hook is registered only at ${pre ? 'the pre-compaction' : 'the session-end'} boundary — the other one loses its state`);
      return row(STATE.OFF, 'no hook that saves session state is registered at either boundary, so nothing is kept when a session compacts or closes');
    },
  },

  {
    key: 'mcp-servers',
    label: 'Connected tools (MCP)',
    whatItBuysYou: 'Your AI can reach the services you have hooked up — your notes, your browser, your deployment host — instead of only what is in the chat.',
    scope: SCOPE.USER,
    // VERIFIED: `claude mcp --help` lists `add <name> <commandOrUrl> [args...]`.
    turnOn: { human: 'Connect a tool', cmd: 'claude mcp add <name> <commandOrUrl>' },
    detect() {
      const r = readJSON(path.join(HOME, '.claude.json'));
      if (r.missing) return row(STATE.ABSENT, 'no Claude Code config file exists on this machine yet');
      if (r.err) return row(STATE.UNKNOWN, `the config file could not be parsed (${r.err}) — connected tools not counted`);
      const names = Object.keys(r.value?.mcpServers || {});
      if (!names.length) return row(STATE.OFF, 'no tools are configured');
      // "configured", NEVER "connected". No local artifact proves a server answered, and claiming a
      // live connection from a config entry would be a fabricated status.
      return row(STATE.ON, `${names.length} tools are configured (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}) — configured, which is not the same as currently reachable`);
    },
  },

  {
    key: 'nightly-refresh',
    label: 'Nightly refresh',
    whatItBuysYou: 'Your knowledge base updates itself overnight, so what your AI knows about your tools does not quietly go stale.',
    scope: SCOPE.MACHINE,
    // Loading a launchd job is machine mutation with no single verified command; global Rule 10.
    turnOn: null,
    detect() {
      // launchd is macOS-only. On any other platform this is UNCHECKABLE, not off — this repo has
      // already shipped a macOS-only assumption that went red the moment it met the Linux CI runner,
      // and reporting "your nightly job is off" to a Linux user would be that same bug with worse
      // consequences, because it reads as an actionable fault rather than a test failure.
      if (process.platform !== 'darwin') return row(STATE.UNKNOWN, `scheduled jobs are managed by launchd, which does not exist on ${process.platform} — this cannot be checked here`);
      let out;
      try { out = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 15_000 }); }
      catch (e) { return row(STATE.UNKNOWN, `could not list scheduled jobs (${String(e?.message || e).split('\n')[0].slice(0, 60)}) — nightly state not checked`); }

      // THIS ROW IS ABOUT THE NIGHTLY KNOWLEDGE-BASE REFRESH, so it counts the nightly refresh — not
      // every launchd job whose label happens to start com.ruvnet. MEASURED on this machine: that
      // prefix match reported "11 refresh jobs are loaded and every one last exited cleanly" while
      // sweeping in goldie-weekly, npx-witness, issue-fix, npm-token-renew, issue-watch,
      // routing-flywheel, brain-gists, npx-72h-verdict and nightly-watchdog. Exactly ONE of the
      // eleven (brain-nightly) was the thing the sentence claimed to describe. Ten unrelated jobs
      // were being offered as evidence for a capability none of them implements.
      //
      // AND THE UNDER-COUNTING TWIN, which cost more (issue #113). The pattern below is a guess at
      // what a refresh job is CALLED, and the one job this row is actually about is not called that:
      // the installer loads `com.ruvnet.brain-update`, which contains neither "nightly" nor
      // "refresh". So the console reported "no nightly refresh job is loaded" about a job that was
      // loaded, scheduled for 03:47 and running nightly — a detector blind to its own installer.
      // The label is now taken from nightly-controller.mjs, the module the console already uses to
      // turn this job on and off, instead of being described a second time as a pattern here.
      const NIGHTLY = /^com\.ruvnet\.[\w.-]*(nightly|refresh)/i;
      const all = out.split('\n')
        .map((l) => l.split('\t'))
        .filter((c) => c.length >= 3 && /^com\.ruvnet\./.test(c[2] || ''))
        .map((c) => ({ label: c[2].trim(), exit: c[1] }));
      // The watchdog watches the refresh; it is not the refresh, and counting it inflates the answer.
      const jobs = all.filter((j) => j.label === NIGHTLY_LABEL
        || (NIGHTLY.test(j.label) && !/watchdog/i.test(j.label)));
      if (!jobs.length) {
        return row(STATE.ABSENT, all.length
          ? `no nightly refresh job is loaded on this machine (${all.length} other RuvNet job${all.length === 1 ? '' : 's'} are scheduled, but none of them is the knowledge-base refresh)`
          : 'no scheduled refresh jobs are loaded on this machine');
      }

      const name = (j) => j.label.replace('com.ruvnet.', '');
      // FAILING IS NOT DORMANT. REJECTED by both duelists 2026-07-24: a job that is loaded, scheduled and
      // has RUN is installed and IN USE — a non-zero exit is a HEALTH problem belonging to the alarm
      // channel, never a "you should switch this on" offer. Reporting it OFF is a category error, and it
      // fired here for the worst possible reason: brain-nightly exited non-zero because the publish guard
      // CORRECTLY refused to release from a non-main branch. A working safety guard was being reported as
      // a dormant capability the user should go turn on.
      const failing = jobs.filter((j) => j.exit !== '0' && j.exit !== '-');
      if (failing.length) return row(STATE.ON, `${jobs.length} nightly refresh job${jobs.length === 1 ? '' : 's'} loaded and running, but ${failing.length} last exited non-zero (${failing.slice(0, 3).map((j) => `${name(j)}=${j.exit}`).join(', ')}) — installed and in use, so this is a health problem to look into, not a capability to switch on`);

      // "-" IS NOT "0". launchd prints "-" for a job that has never run in this boot, and the old
      // check lumped it in with success — so "every one last exited cleanly" could describe a job
      // that has never executed once. That is the silence-reads-as-health failure the positive-
      // confirmation standing order exists to kill, stated on the surface that is supposed to enforce it.
      const neverRan = jobs.filter((j) => j.exit === '-');
      if (neverRan.length === jobs.length) {
        return row(STATE.UNKNOWN, `${jobs.length} nightly refresh job${jobs.length === 1 ? ' is' : 's are'} loaded (${jobs.map(name).slice(0, 3).join(', ')}) but ${jobs.length === 1 ? 'it has' : 'none has'} run since this machine last booted, so whether the refresh actually works here has not been demonstrated`);
      }
      if (neverRan.length) {
        return row(STATE.ON, `${jobs.length} nightly refresh jobs are loaded; ${jobs.length - neverRan.length} last exited cleanly and ${neverRan.length} (${neverRan.map(name).slice(0, 3).join(', ')}) have not run since boot`);
      }
      return row(STATE.ON, `${jobs.length} nightly refresh job${jobs.length === 1 ? '' : 's'} loaded (${jobs.map(name).slice(0, 3).join(', ')}), and every one last exited cleanly`);
    },
  },
];

/**
 * Run every detect() and return one row per capability. NEVER throws: this feeds an advisory
 * surface, and a surface that can crash the page it advises on is worse than no surface. A detector
 * that throws is reported as 'unknown' with the thrown message — the failure becomes visible data
 * rather than a missing row, because a silently dropped capability is indistinguishable from one
 * that does not exist.
 */
export function auditAll({ project = process.cwd() } = {}) {
  // The default is the CALLER'S directory, not this package's. See the note on REPO: taking no
  // argument at all is what made every project-scoped row describe the wrong folder.
  const ctx = { project: path.resolve(project), home: HOME };
  const observedAt = new Date().toISOString();
  return CAPABILITIES.map((c) => {
    let r;
    try { r = c.detect(ctx); }
    catch (e) { r = row(STATE.UNKNOWN, `this check failed to run (${String(e?.message || e).split('\n')[0].slice(0, 70)})`); }
    // A detector returning something malformed must not silently become 'undefined' on the page.
    const state = Object.values(STATE).includes(r?.state) ? r.state : STATE.UNKNOWN;
    const evidence = typeof r?.evidence === 'string' && r.evidence.trim()
      ? r.evidence
      : 'this check returned no evidence, so its state is unknown';
    return {
      key: c.key,
      label: c.label,
      whatItBuysYou: c.whatItBuysYou,
      scope: c.scope,
      turnOn: c.turnOn,
      state,
      evidence,
      // A digest binds proactive routing to this audit invocation's observed bytes. Synthetic test
      // registries do not carry it and remain compatible with the delivery seam.
      evidenceDigest: crypto.createHash('sha256').update(evidence).digest('hex'),
      evidenceObservedAt: observedAt,
      // WHICH project a project-scoped row is about, named rather than assumed. "no memory store
      // exists for this project" is only checkable by a reader who can see which folder was read.
      ...(c.scope === SCOPE.PROJECT ? { project: ctx.project } : {}),
    };
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('capability-registry.mjs');
if (invokedDirectly) {
  // --project mirrors capability-audit.mjs's --repo: the project-scoped rows are about a directory,
  // and the person running this must be able to say which one rather than inferring it.
  const pi = process.argv.indexOf('--project');
  const project = pi >= 0 && process.argv[pi + 1] ? path.resolve(process.argv[pi + 1]) : process.cwd();
  const rows = auditAll({ project });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

  const MARK = { on: '●', off: '○', unknown: '?', absent: '·' };
  const off = rows.filter((r) => r.state === STATE.OFF);
  console.log(`\n  ${rows.length} capabilities checked on this machine`);
  console.log(`  (project-scoped rows describe ${project.replace(HOME, '~')})\n`);
  for (const r of rows) {
    console.log(`  ${MARK[r.state]} ${r.label.padEnd(24)} ${r.state.toUpperCase()}  [${r.scope}]`);
    console.log(`      ${r.evidence}`);
    if (r.state === STATE.OFF) {
      console.log(`      buys you: ${r.whatItBuysYou}`);
      // No verified command is stated as exactly that. Silence would read as "nothing can be done".
      console.log(r.turnOn ? `      turn on: ${r.turnOn.cmd}` : `      turn on: no verified one-line command exists for this`);
    }
    console.log('');
  }
  console.log(`  ${off.length} of ${rows.length} are installed and switched off.\n`);
}
