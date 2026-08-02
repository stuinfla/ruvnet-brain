#!/usr/bin/env node
/**
 * scripts/learning-replay.mjs — the COUNTERFACTUAL REPLAY TRAP (ADR-058 §D4, DDD-0013 Context 1,
 * aggregate `CounterfactualTrap`). Invariant name: **LEARNING-REPLAY**.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS INVERTS, and why it exists at all.
 *
 * `scripts/behavioral-l1-l4.mjs`'s L4 asserts that the brain's own injected prose CONTAINS the words
 * 'take the wheel', 'SPARC', 'swarm'. That is a check on what the brain SAID. It cannot fail on an
 * agent that ignored every word of it, and it certified "behavioral, all pass" for weeks while
 * nothing downstream was measured at all. This file measures the opposite thing and only that thing:
 *
 *     did an agent's PRODUCED ARTIFACT change, against a control that did not receive the lesson.
 *
 * The oracle is a parse of a command string — `plugin/scripts/hook-input.mjs:findInvocations()`,
 * executable-position classification, the same anti-corruption boundary DDD-0013 mandates against
 * the host's Bash envelope. It is never a similarity score and never a model grading a model.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TRAP, concretely (ADR-058 §D4 specifies it so it cannot dissolve into intention).
 *
 *   RECORD, in fixture-project-A: the correction that `ruflo memory search` takes its query with the
 *   `-q` flag and rejects a bare positional. This is a FACT ABOUT THE REAL CLI, verified against the
 *   real global binary (`~/.npm-global/bin/ruflo memory search --help` prints
 *   `-q, --query   Search query (required)`), not recalled. An oracle built on a false premise is
 *   worthless, so the harness RE-VERIFIES it at run time (`verifyRufloFlag()`) and refuses to run
 *   against a CLI whose interface no longer matches.
 *
 *   REPLAY, in fixture-project-B: a fresh session, a DIFFERENTLY-WORDED task ("recall the note about
 *   the caching strategy") that shares no content word with the lesson. String-matching the lesson
 *   text cannot be what carries it; only the flag can.
 *
 *   PASS requires all of:
 *     (a) the lesson is in the transcript BEFORE the first tool call — measured as stream position,
 *         not asserted from the fact that UserPromptSubmit "happens first";
 *     (b) the treated arm's produced command carries the token where the BRAIN-OFF CONTROL's does not;
 *     (c) it still holds after a nightly refresh runs between record and replay — the refresh is
 *         real: a new Stable-Spine generation is installed into the fixture brain home and the
 *         pointer flipped, so the replay's hooks execute from a DIFFERENT code root than the record
 *         did, and `ruflo memory distill run` / `ruflo memory backup` (the two commands
 *         scripts/nightly-wrapper.sh actually runs nightly) are run against project A's store.
 *     (d) the produced command NAMES THE REAL SUBCOMMAND, EXECUTES against the real fixture store,
 *         EXITS 0, and ACTUALLY RETRIEVES the memory the task asked for. See "THE EXECUTION GATE".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE INVALIDATION RULE — DDD-0013 invariant 6, and the whole point of the file.
 *
 *     A trap whose CONTROL run also produces the token is INVALID. The result is INCONCLUSIVE.
 *     NEVER a pass.
 *
 * If the model would have got it right anyway, the trap measured nothing — it measured the model's
 * priors. This is encoded as CODE, not as a comment: `aggregate()` computes `controlTokenRuns`
 * FIRST and the PASS branch is unreachable while it is non-zero, and a final assertion throws if a
 * PASS verdict is ever paired with a successful control. A check that can report PASS on a
 * meaningless measurement is the L4 defect rebuilt one file to the left.
 *
 * (DDD-0013 invariant 6 words the invalid outcome as `UNKNOWN`; ADR-058 §D4 words it `INCONCLUSIVE`.
 * This file emits INCONCLUSIVE and treats it as strictly non-PASS, which satisfies both — the two
 * documents disagree on the LABEL, never on the consequence.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE EXECUTION GATE — added 2026-07-28, closing the largest single deduction in the D4 re-score.
 *
 * An independent grader (GPT-5.6-Sol) scored this dimension 44/100 and named the reason exactly:
 *
 *     "The recorded replay says PASS 3/3, yet all three treated commands have subcommandCorrect:
 *      false … PASS depends on token use, control contrast and lesson delivery — not successful
 *      command execution or successful retrieval. The suite currently certifies unusable learned
 *      behavior."
 *
 * It was right, and the block that used to sit here — arguing the subcommand is REPORTED and not
 * GATED because the lesson only taught the flag — was a defensible claim about the LESSON and an
 * indefensible one about the CLAIM. The trap's headline is "learning demonstrated". A command that
 * would fail if anyone ran it demonstrates nothing, whatever it says about the flag.
 *
 * So the verdict now additionally requires, per run, that the treated arm's produced command:
 *   1. names the real subcommand (`subcommandCorrect`) — no longer observed-only;
 *   2. EXECUTES against the real fixture store and exits 0;
 *   3. actually RETRIEVES the memory project B's task asked for — asserted on RETURNED CONTENT.
 *
 * Point 3 is not redundant with point 2, and this is the whole reason exit status alone is not
 * admissible. Measured live on this machine, 2026-07-28, against the real global binary:
 *
 *     ruflo memory search -q "caching strategy" --path <db>  → EXIT 0 · "Found 1 results"
 *     ruflo memory recall -q "caching strategy" --path <db>  → EXIT 0 · prints the `memory` HELP
 *     ruflo recall        -q "caching strategy"              → EXIT 1 · "Unknown command: recall"
 *     ruflo memory search    "caching strategy" --path <db>  → EXIT 1 · "Required option missing: --query"
 *     ruflo memory search -q "<absent phrase>"  --path <db>  → EXIT 0 · "[WARN] No results found"
 *
 * `ruflo memory recall -q` — the exact command two of the three certified runs produced — EXITS 0.
 * An exit-status gate would have passed it. Only an assertion on returned content catches it. (Line
 * 5 is the same lesson from the other side: a perfectly-formed search that finds nothing also exits
 * 0. Retrieval is the claim; exit status is not.)
 *
 * WHAT THE FIXTURE HAD TO CHANGE FOR THIS TO BE MEASURABLE, stated rather than finessed: project B's
 * prompt already asserted "earlier in this project someone recorded a note about the caching
 * strategy", and that was FALSE of the fixture world — project B's store was empty. So the harness
 * now seeds that note into project B's own `.swarm/memory.db` (`seedProjectBMemory`). This is a fix
 * to the FIXTURE, not to the lesson: the seeded note says nothing about `-q`, no arm ever sees its
 * text (the recorder blocks every command before it runs), and the lesson text is untouched. Without
 * it, even a flawless `ruflo memory search -q "caching strategy"` would retrieve nothing and the new
 * gate would be measuring a harness bug — Rule 22 check (d).
 *
 * SAFETY. The recorder BLOCKS the agent's command on purpose (a fixture agent must not run anything
 * on a real machine, and must not learn the answer from a CLI's own `--help` mid-run). That is kept.
 * Execution happens OUT OF BAND, after the arm is over, in the harness — and never through a shell:
 * `executeProducedCommand()` runs the argv `findInvocations()` already parsed, so pipes, redirects,
 * substitutions and metacharacters are structurally absent. It also refuses to run a mutating
 * subcommand, and refuses any `--path`/`--db` pointing outside the fixture world. Both refusals mark
 * the run NOT-RETRIEVED, so every one of them can only LOWER the rate.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A RATE, NEVER A VERDICT. N runs, PASS at >= 2/3 of them, transcripts archived. One run of a
 * stochastic system is an anecdote; the artifact records k/n and every arm's classification.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE ARMS ACTUALLY DIFFER BY — the product's OWN switch, not a harness flag.
 *
 * Both arms run the identical fixture, the identical prompt, the identical hook registration
 * (`hook-shim.mjs unprompted-speech UserPromptSubmit`, exactly as plugin/hooks/hooks.json registers
 * it). The ONLY difference is the presence of the `brain-off` sentinel in the arm's
 * RUVNET_BRAIN_STATE_DIR — ADR-054's real consent switch, whose `offBehavior: 'silence'` contract
 * for the unprompted plane means the control receives ZERO bytes. That is why mutant 2 ("run the
 * treated arm brain-disabled") is not a separate code path: it IS the control condition.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * COST. Real model tokens, priced in the open (ADR-058 §D4: "the one standing spend"). Default model
 * is haiku — the trap measures whether CONTEXT REACHES the agent, not whether the agent is clever.
 * Measured 2026-07-27 on this machine: ~$0.10 and ~8s of wall clock per arm, 2 arms per run.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * USAGE
 *   node scripts/learning-replay.mjs                 # N=3 replay, real tokens, writes the artifact
 *   node scripts/learning-replay.mjs --n 1           # one run
 *   node scripts/learning-replay.mjs --check         # NO tokens: gate on the committed artifact
 *   node scripts/learning-replay.mjs --dry-run       # NO tokens: build fixtures, prove the wire, UNKNOWN
 *   node scripts/learning-replay.mjs --mutant <name> # see MUTANTS below
 * Exit: 0 = PASS. 1 = FAIL. 3 = INCONCLUSIVE. 4 = UNKNOWN. (Only 0 is a pass, by construction.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findInvocations } from '../plugin/scripts/hook-input.mjs';
import { makeLesson, saveLessons, loadLessons } from './lesson-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The invariant name the release-gate vector in scripts/claims-verify.mjs consumes. */
export const INVARIANT = 'LEARNING-REPLAY';

export const VERDICT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNKNOWN: 'UNKNOWN',
  INCONCLUSIVE: 'INCONCLUSIVE',
});
/** Exit codes. PASS is the ONLY zero — UNKNOWN is never a pass, and neither is INCONCLUSIVE. */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3, UNKNOWN: 4 });

/** The committed, machine-readable result artifact. */
export const RESULT_FILE = path.join(ROOT, 'data', 'learning-replay-result.json');
export const POST_TASK_RESULT_FILE = path.join(ROOT, 'data', 'learning-replay-post-task-result.json');

export const TRAP = Object.freeze({
  MEMORY_SEARCH: 'memory-search-query',
  POST_TASK: 'hooks-post-task-persistence',
});

export const POST_TASK_PROMPT =
  'Record successful completion of the release retry-budget investigation in ruflo hooks learning, '
  + 'assign it to the tester agent, and persist the routing decision for later sessions. '
  + 'Use the terminal CLI, not an MCP tool. Do not inspect help or run any setup command. '
  + 'Run exactly one post-task command now, then tell me what you ran.';
export const POST_TASK_LESSON =
  'A ruflo hooks post-task call persists a reusable routing outcome only when it includes all three: '
  + '--task with the task description, --agent with the executor, and --store-results; a success/task-id alone '
  + 'may print success but does not create the routing decision that later learning reads.';

function trapSpec(id = TRAP.MEMORY_SEARCH) {
  if (id === TRAP.POST_TASK) {
    return {
      id,
      lessonId: 'FX-D4-ruflo-hooks-post-task-persistence',
      prompt: POST_TASK_PROMPT,
      lesson: POST_TASK_LESSON,
      memoryKey: 'lesson-ruflo-hooks-post-task-persistence',
      recordQuery: 'ruflo hooks post task routing persistence',
      check: 'the produced ruflo hooks post-task command includes --task, --agent, and --store-results',
    };
  }
  return {
    id: TRAP.MEMORY_SEARCH,
    lessonId: 'FX-D4-ruflo-memory-search-flag',
    prompt: REPLAY_PROMPT,
    lesson: LESSON_STATEMENT,
    memoryKey: 'lesson-ruflo-memory-search-flag',
    recordQuery: 'ruflo CLI memory query flag',
    check: 'the produced ruflo memory search command delivers its query through -q/--query',
  };
}

/**
 * The files whose change invalidates a recorded result. `--check` refuses to call a result CURRENT
 * for a SHA if any of these moved since — ADR-056's currency discipline, applied to a token-priced
 * measurement that cannot be re-run on every commit.
 */
export const LOAD_BEARING = Object.freeze([
  'scripts/learning-replay.mjs',
  'scripts/ci/learning-replay-recorder.mjs',
  'scripts/ci/learning-replay-codex-adapter.mjs',
  'scripts/lesson-store.mjs',
  'plugin/scripts/lesson-store.mjs',
  'plugin/scripts/lesson-gate.mjs',
  'plugin/scripts/lesson-command-scope.mjs',
  'plugin/scripts/lesson-presentation.mjs',
  'plugin/scripts/lesson-hooks.sh',
  'plugin/scripts/unprompted-runtime.mjs',
  'plugin/scripts/hook-shim.mjs',
  'plugin/scripts/hook-input.mjs',
]);

// ── THE ORACLE ──────────────────────────────────────────────────────────────────────────────────
/**
 * Classify ONE produced command against the machine-checkable token.
 *
 *   'flagged'    — a ruflo invocation that delivers its query through `-q` / `--query`.
 *                  THIS IS THE TOKEN — and it is the token ADR-058 §D4 names, verbatim:
 *                  "the produced command uses -q where the brain-off control uses the positional form".
 *   'positional' — a ruflo invocation carrying a bare positional query and no -q/--query. The exact
 *                  wrong form the lesson names.
 *   'other'      — ruflo invoked, but the query arrives some other way (`--topic`, `--project`), or
 *                  no query at all.
 *   'none'       — no ruflo invocation at all.
 *
 * `--query` counts as the token even though the lesson says `-q`: the live `--help` prints them as
 * ONE option (`-q, --query`), so failing the long form would make the oracle reject a command that is
 * correct. An oracle stricter than the interface it models measures its own arbitrariness. The
 * consequence is faced rather than tuned away — a control arm that reaches `--query` on its own
 * INVALIDATES the trap, which is invariant 6 doing its job.
 *
 * ── THE SUBCOMMAND: REPORTED (2026-07-27) → GATED (2026-07-28) ───────────────────────────────────
 * The first shipped oracle also required `ruflo memory search`; the first real N=3 measured treated
 * 3/3 carrying `-q` against control 0/3 — a clean separation — and scored it 0/3 FAIL, because the
 * treated arm spelled it `ruflo recall -q …` / `ruflo memory recall -q …`. That was read as a
 * harness error (the lesson taught the flag and said nothing about the subcommand) and the gate was
 * relaxed to observed-only.
 *
 * That relaxation is REVERSED, and the reversal is the point of the whole change. Both readings of
 * the 2026-07-27 evidence are true at once, and only one of them is about the CLAIM:
 *   · about the LESSON — right. The lesson carries the flag; failing the treatment on a subcommand
 *     it never mentioned measures the model's priors about rUv's command tree.
 *   · about the CLAIM — wrong, and the grader caught it. The invariant's headline is that LEARNING
 *     WAS DEMONSTRATED. `ruflo recall -q "x"` exits 1. `ruflo memory recall -q "x"` exits 0 and
 *     prints the help. Certifying "learning demonstrated" on a command that retrieves nothing is
 *     the L4 defect rebuilt one file to the left — proof that something was SAID, not that anything
 *     WORKED.
 *
 * The honest resolution is to keep the token oracle exactly as narrow as it was (so nothing is
 * credited to the lesson that the control reaches unaided) and to add the gate the claim actually
 * needs: the command has to WORK. `subcommandCorrect` is now one of the conditions, and
 * `aggregate()` carries an assertion making `subcommandCorrect: false` structurally unable to
 * coexist with a PASS verdict — the same shape as the invariant-6 guard beside it. If the rate
 * falls as a result, the rate was wrong before; the lesson text is NOT tuned to recover it.
 */
export function classifyCommand(cmd) {
  const invocations = findInvocations(String(cmd || ''), ['ruflo', 'claude-flow']);
  if (!invocations.length) return 'none';
  let sawPositional = false;
  for (const inv of invocations) {
    const args = inv.args.filter((a) => a !== '');
    if (args.some((a) => a === '-q' || a === '--query' || a.startsWith('--query='))) return 'flagged';
    // Bare (non-flag, non-flag-value) tokens. A flag consumes the token after it unless that token
    // is itself a flag — generic, so `--topic "x"` and `-n default` are handled without a whitelist
    // that would rot the moment rUv adds an option.
    const bare = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) { if (!a.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) i++; continue; }
      bare.push(a);
    }
    // Which bare token is the QUERY rather than a subcommand? A subcommand is one short lowercase
    // word; a query is a phrase. So: a bare token past the first that contains whitespace (or is
    // implausibly long) is a positional query, as is any third bare token.
    // ONLY THE LABEL DEPENDS ON THIS. The verdict keys on `flagged` vs not-`flagged` and on `none`;
    // 'positional' and 'other' are both simply "did not carry the token". A mislabel here can never
    // move PASS/FAIL/INCONCLUSIVE — it can only make the reported description of a control arm less
    // precise, which is why a heuristic is acceptable HERE and nowhere near the token itself.
    const queryish = (t) => /\s/.test(t) || t.length > 24;
    if (bare.length >= 3 || bare.slice(1).some(queryish)) sawPositional = true;
  }
  return sawPositional ? 'positional' : 'other';
}

/** GATING since 2026-07-28: was the invocation the REAL `ruflo memory search`? */
export function subcommandCorrect(cmd) {
  for (const inv of findInvocations(String(cmd || ''), ['ruflo', 'claude-flow'])) {
    const words = inv.args.filter((a) => a !== '' && !a.startsWith('-'));
    const mi = words.indexOf('memory');
    if (mi !== -1 && words[mi + 1] === 'search') return true;
  }
  return false;
}

/** The token test, isolated so every caller asks it the same way. */
export const carriesToken = (cls) => cls === 'flagged';

/** The second trap is deliberately a different Ruflo surface and a different required option. */
function optionValue(args, short, long) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === short || arg === long) return args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
  }
  return null;
}

export function classifyPostTaskCommand(cmd) {
  const invocations = findInvocations(String(cmd || ''), ['ruflo', 'claude-flow']);
  if (!invocations.length) return 'none';
  let sawPostTask = false;
  for (const inv of invocations) {
    const args = inv.args.filter(Boolean);
    const hi = args.indexOf('hooks');
    if (hi === -1 || args[hi + 1] !== 'post-task') continue;
    sawPostTask = true;
    const task = optionValue(args, '-t', '--task');
    const agent = optionValue(args, '-a', '--agent');
    const store = args.includes('--store-results')
      || args.some((a) => a.startsWith('--store-results=') && !/=false$/i.test(a));
    if (task && agent && store) return 'flagged';
  }
  return sawPostTask ? 'partial' : 'other';
}

export function postTaskSubcommandCorrect(cmd) {
  return findInvocations(String(cmd || ''), ['ruflo', 'claude-flow'])
    .some((inv) => {
      const words = inv.args.filter((a) => a !== '' && !a.startsWith('-'));
      const hi = words.indexOf('hooks');
      return hi !== -1 && words[hi + 1] === 'post-task';
    });
}

// ── THE EXECUTION GATE ──────────────────────────────────────────────────────────────────────────
/**
 * The note project B's prompt already claimed was there. Seeding it makes the FIXTURE match the
 * TASK; it does not touch the lesson (nothing here mentions `-q`) and no arm ever reads it, because
 * the recorder blocks every command the agent produces before it can run.
 */
export const PROJECT_B_MEMORY_KEY = 'note-caching-strategy';
export const PROJECT_B_MEMORY_VALUE =
  'The caching strategy for this project: responses are memoized in a two-tier LRU, '
  + 'warm tier in memory and cold tier on disk, invalidated by content hash.';

/**
 * What "retrieved" looks like on the wire. Every one of these strings was READ OFF the real global
 * binary's real output on 2026-07-28 (see the EXECUTION GATE note in the header), never guessed.
 *
 * The positive markers are chosen to survive the table truncation `ruflo memory search` applies:
 * the real row prints as `| note-caching-stra... | 0.79 | default | The caching strategy for this
 * pr... |`, so a 12-char key prefix and a 20-char value prefix are both intact. `memory retrieve -k`
 * prints both in full.
 */
export const RETRIEVAL_EVIDENCE = Object.freeze({
  positive: Object.freeze([PROJECT_B_MEMORY_KEY.slice(0, 12), PROJECT_B_MEMORY_VALUE.slice(0, 20)]),
  negative: Object.freeze([
    /No results found/i,            // memory search -q "<absent>"   → EXIT 0, and retrieved nothing
    /Unknown command/i,             // ruflo recall -q "x"           → EXIT 1
    /Required option missing/i,     // memory search "positional"    → EXIT 1
    /Usage:\s*claude-flow memory/i, // memory recall -q "x"          → EXIT 0, prints the help
    /\[ERROR\]/,
  ]),
});

/**
 * Did the command RETRIEVE, as opposed to merely exit 0? Asserted on returned content in both
 * directions: any known failure shape is disqualifying even at exit 0, and silence is not evidence —
 * the output must NAME the seeded memory.
 */
export function assertRetrieved(out) {
  const s = String(out || '');
  for (const re of RETRIEVAL_EVIDENCE.negative) {
    if (re.test(s)) return { retrieved: false, why: `the command's own output matched a known FAILURE shape ${re}` };
  }
  const hit = RETRIEVAL_EVIDENCE.positive.find((p) => s.includes(p));
  if (!hit) return { retrieved: false, why: 'the output names neither the seeded memory key nor its stored text — nothing was retrieved' };
  return { retrieved: true, why: `the output carries the seeded memory (matched "${hit}")` };
}

/**
 * Subcommands that WRITE. Checked only at subcommand position (the first two non-flag words), so a
 * query that happens to contain one of these words is not mistaken for the verb.
 */
const MUTATING_SUBCOMMANDS = new Set(['store', 'delete', 'rm', 'purge', 'cleanup', 'compress', 'import', 'export', 'backup', 'init', 'configure']);

/** Execute the real CLI, or an injected JavaScript fixture, without a shell on every platform. */
function spawnRuflo(bin, args, options) {
  if (/\.[cm]?js$/i.test(bin)) {
    return spawnSync(process.execPath, [bin, ...args], options);
  }
  return spawnSync(bin, args, options);
}

export function assertPostTaskPersisted({ args, output, cwd }) {
  const task = optionValue(args, '-t', '--task');
  const agent = optionValue(args, '-a', '--agent');
  const taskId = optionValue(args, '-i', '--task-id')
    || String(output || '').match(/Recording outcome for task:\s*([a-zA-Z0-9_-]+)/)?.[1]
    || null;
  if (!task || !agent || !taskId || !args.includes('--store-results')) {
    return { retrieved: false, why: 'the command did not carry --task, --agent, --store-results, and a resolvable task id' };
  }
  let outcomes;
  let memory;
  try {
    outcomes = JSON.parse(fs.readFileSync(path.join(cwd, '.claude-flow', 'routing-outcomes.json'), 'utf8'));
    memory = JSON.parse(fs.readFileSync(path.join(cwd, '.claude-flow', 'memory', 'store.json'), 'utf8'));
  } catch (error) {
    return { retrieved: false, why: `the expected persistence stores were not readable: ${error.message}` };
  }
  const outcome = (outcomes.outcomes || []).find((row) =>
    row.task === task && row.agent === agent && row.success === true);
  const decision = memory.entries?.[`routing-decision:${taskId}`];
  let decisionValue = null;
  try { decisionValue = decision ? JSON.parse(decision.value) : null; } catch { /* invalid evidence */ }
  if (!outcome || !decision || decisionValue?.task !== task || decisionValue?.agent !== agent) {
    return { retrieved: false, why: 'stdout said success, but no matching routing outcome plus routing-decision memory row persisted' };
  }
  if (!/\[OK\]\s*Task outcome recorded:\s*SUCCESS/i.test(String(output || ''))) {
    return { retrieved: false, why: 'persistence rows exist but this invocation did not report successful task recording' };
  }
  return {
    retrieved: true,
    why: `matching routing outcome and routing-decision:${taskId} memory row persisted`,
  };
}

/**
 * RUN the produced command and report what actually happened.
 *
 * Never through a shell: the argv is the one `findInvocations()` already parsed out of the agent's
 * string, so shell metacharacters cannot survive into execution. Two refusals bound the blast
 * radius, and both report NOT-RETRIEVED, so neither can ever raise the rate.
 */
export function executeProducedCommand(cmd, {
  cwd,
  ruflo = RUFLO_BIN,
  base = null,
  trap = TRAP.MEMORY_SEARCH,
} = {}) {
  const nope = (why, extra = {}) => ({ ran: false, argv: null, exit: null, exitOk: false, retrieved: false, why, output: '', ...extra });
  const invocations = findInvocations(String(cmd || ''), ['ruflo', 'claude-flow']);
  if (!invocations.length) return nope('no ruflo invocation in the produced command — there was nothing to execute');
  const args = invocations[0].args.filter((a) => a !== '');

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--path' || a === '--db' || a.startsWith('--path=') || a.startsWith('--db=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
      const abs = path.resolve(cwd, String(raw || ''));
      if (!base || !(abs === path.resolve(base) || abs.startsWith(path.resolve(base) + path.sep))) {
        return nope(`refused to execute: the produced command points its store at ${abs}, outside the fixture world`, { argv: ['ruflo', ...args] });
      }
    }
  }
  const verbs = args.filter((a) => !a.startsWith('-')).slice(0, 2);
  const mutating = verbs.find((w) => MUTATING_SUBCOMMANDS.has(w));
  if (mutating) return nope(`refused to execute a MUTATING ruflo subcommand ("${mutating}") — a retrieval claim is not proven by a write`, { argv: ['ruflo', ...args] });

  const env = { ...process.env };
  delete env.CLAUDE_FLOW_DB_PATH;
  delete env.CLAUDE_FLOW_MEMORY_PATH;
  const r = spawnRuflo(ruflo, args, { cwd, encoding: 'utf8', timeout: 120_000, env, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) return nope(`spawn failed: ${r.error.message}`, { argv: ['ruflo', ...args] });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const routed = trap === TRAP.POST_TASK
    ? assertPostTaskPersisted({ args, output: out, cwd })
    : assertRetrieved(out);
  return {
    ran: true,
    argv: ['ruflo', ...args],
    exit: r.status,
    exitOk: r.status === 0,
    retrieved: routed.retrieved,
    why: `exit ${r.status}; ${routed.why}`,
    output: out.slice(0, 1200),
  };
}

/**
 * ONE run's verdict. Order of the branches IS the invariant: the control is judged BEFORE the
 * treated arm can be credited with anything.
 */
export function verdictForRun(run) {
  const {
    treatedClass, controlClass, lessonBeforeFirstToolCall, error,
    treatedSubcommandCorrect, treatedExecOk, treatedRetrieved, treatedExecWhy,
    controlWorked,
  } = run;
  if (error) return { verdict: VERDICT.UNKNOWN, why: `harness could not measure this run: ${error}` };
  // NO COMPARABLE CONTROL ARTIFACT IS NOT A WIN. If the control never invoked ruflo at all, there is
  // no counterfactual to difference against — the treated arm may have "changed" against nothing.
  // Deliberately strict, and it can only ever LOWER the rate: an unopposed treated arm is UNKNOWN.
  if (controlClass === 'none') {
    return { verdict: VERDICT.UNKNOWN, why: 'the control arm produced no ruflo invocation at all — there is no comparable artifact to difference against' };
  }
  if (treatedClass === 'none') {
    return { verdict: VERDICT.FAIL, why: 'the treated arm produced no ruflo invocation at all' };
  }
  // INVARIANT 6, FIRST AND UNCONDITIONALLY. WIDENED 2026-07-28, never narrowed: carrying the token
  // still invalidates on its own (that bar is unchanged, so nothing the control reaches unaided can
  // start being credited to the lesson), and a control whose command WORKED — executed and retrieved
  // — invalidates too, even by a route the classifier does not call `flagged`. An OR can only make
  // more runs invalid; it can never turn an invalid run into a pass.
  if (carriesToken(controlClass) || controlWorked === true) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      why: carriesToken(controlClass)
        ? `the CONTROL arm produced the token (${controlClass}) — the model would have got it right without the lesson, so this trap measured nothing`
        : `the CONTROL arm's command EXECUTED AND RETRIEVED (class "${controlClass}") — the model would have got it right without the lesson, so this trap measured nothing`,
    };
  }
  if (!carriesToken(treatedClass)) {
    return { verdict: VERDICT.FAIL, why: `treated arm produced "${treatedClass}", not the token` };
  }
  // ── THE EXECUTION GATE (2026-07-28) ──
  // Ordered cheapest-to-most-informative so the `why` names the FIRST thing that was wrong.
  if (treatedSubcommandCorrect !== true) {
    return { verdict: VERDICT.FAIL, why: 'treated arm carried the token on the WRONG SUBCOMMAND — a right flag on a command that is not `ruflo memory search` is not learned behavior, it is an unusable command' };
  }
  if (treatedExecOk !== true) {
    return { verdict: VERDICT.FAIL, why: `treated arm's produced command did not execute successfully: ${treatedExecWhy || 'not executed'}` };
  }
  if (treatedRetrieved !== true) {
    return { verdict: VERDICT.FAIL, why: `treated arm's command exited 0 but RETRIEVED NOTHING: ${treatedExecWhy || 'no retrieval evidence'}` };
  }
  if (lessonBeforeFirstToolCall !== true) {
    return { verdict: VERDICT.FAIL, why: 'treated arm carried the token but the lesson was NOT observed in the transcript before the first tool call' };
  }
  return { verdict: VERDICT.PASS, why: `treated "${treatedClass}" vs control "${controlClass}"; the produced command executed (exit 0) and returned the required meaningful outcome; lesson delivered before the first tool call` };
}

/**
 * The RATE. N runs in, one verdict + a k/n out.
 *
 * PASS is structurally unreachable while any control succeeded: `controlTokenRuns` is computed
 * before the branch and the assertion at the bottom re-checks it. Removing either guard and running
 * the `seed-control` mutant is how you prove this is real rather than decorative.
 */
export function aggregate(runs, { threshold = 2 / 3 } = {}) {
  const perRun = runs.map((r) => ({ ...r, ...verdictForRun(r) }));
  const n = perRun.length;
  const passes = perRun.filter((r) => r.verdict === VERDICT.PASS).length;
  const fails = perRun.filter((r) => r.verdict === VERDICT.FAIL).length;
  const unknowns = perRun.filter((r) => r.verdict === VERDICT.UNKNOWN).length;
  const controlTokenRuns = perRun.filter((r) => carriesToken(r.controlClass)).length;
  const controlWorkedRuns = perRun.filter((r) => r.controlWorked === true).length;
  // The EFFECT SIZE, reported even when the verdict is INCONCLUSIVE. An invalid trap still measured
  // two real rates, and printing only `passes` throws away the more informative half: "treated 3/3,
  // control 1/3" says something a bare "2/3 below the bar" does not. This is a report, never an
  // input to the verdict — the verdict stays governed by invariant 6 above.
  const treatedTokenRuns = perRun.filter((r) => carriesToken(r.treatedClass)).length;
  // The execution gate's own rates, reported whatever the verdict. "treated 3/3 carried the token,
  // 0/3 of them worked" is the sentence the old artifact could not say, and it is the sentence the
  // grader had to reconstruct by hand from `subcommandCorrect: false`.
  const treatedSubcommandRuns = perRun.filter((r) => r.treatedSubcommandCorrect === true).length;
  const treatedExecutedRuns = perRun.filter((r) => r.treatedExecOk === true).length;
  const treatedRetrievedRuns = perRun.filter((r) => r.treatedRetrieved === true).length;

  let verdict, why;
  if (n === 0) {
    verdict = VERDICT.UNKNOWN; why = 'zero runs executed — an empty run is not a pass';
  } else if (controlTokenRuns > 0 || controlWorkedRuns > 0) {
    verdict = VERDICT.INCONCLUSIVE;
    why = `${controlTokenRuns}/${n} CONTROL run(s) produced the token and ${controlWorkedRuns}/${n} executed+retrieved — DDD-0013 invariant 6: the trap is INVALID, not passed`;
  } else if (passes / n >= threshold) {
    verdict = VERDICT.PASS;
    why = `${passes}/${n} runs passed (bar ${Math.ceil(threshold * n)}/${n})`;
  } else if (unknowns > 0 && passes + fails < n) {
    verdict = VERDICT.UNKNOWN;
    const executorError = perRun.map((r) => r.error).find(Boolean);
    why = executorError
      ? `${unknowns}/${n} run(s) could not be measured; executor error: ${executorError}`
      : `${unknowns}/${n} run(s) could not be measured; ${passes}/${n} passed — below the bar with the reason unknown`;
  } else {
    verdict = VERDICT.FAIL;
    why = `${passes}/${n} runs passed — below the ${Math.ceil(threshold * n)}/${n} bar`;
  }

  // The guards that make the two invariants CODE rather than prose. If either throws, the branch
  // order above was edited and the trap is unsafe — a stop-the-line event, not a warning.
  if (verdict === VERDICT.PASS && (controlTokenRuns > 0 || controlWorkedRuns > 0)) {
    throw new Error('LEARNING-REPLAY: refusing to report PASS while a control arm produced the token or a working command (DDD-0013 invariant 6)');
  }
  // The grader's finding, made structurally impossible: `subcommandCorrect: false` can no longer sit
  // inside a PASS. Same for a command that did not execute or retrieved nothing.
  const brokenPass = perRun.find((r) => r.verdict === VERDICT.PASS
    && (r.treatedSubcommandCorrect !== true || r.treatedExecOk !== true || r.treatedRetrieved !== true));
  if (brokenPass) {
    throw new Error(`LEARNING-REPLAY: refusing to report a PASS run whose produced command was unusable (run ${brokenPass.i}: subcommandCorrect=${brokenPass.treatedSubcommandCorrect}, exitOk=${brokenPass.treatedExecOk}, retrieved=${brokenPass.treatedRetrieved})`);
  }
  return {
    verdict, why, n, passes, fails, unknowns,
    controlTokenRuns, controlWorkedRuns, treatedTokenRuns,
    treatedSubcommandRuns, treatedExecutedRuns, treatedRetrievedRuns,
    rate: n ? +(passes / n).toFixed(4) : 0, runs: perRun,
  };
}

// ── the real CLI's real interface, re-verified at run time ──────────────────────────────────────
export const RUFLO_BIN = process.env.RUVNET_RUFLO_BIN || path.join(os.homedir(), '.npm-global', 'bin', 'ruflo');

/**
 * Re-verify the premise. Rule 0 applied to the one fact the whole oracle rests on: `ruflo memory
 * search` must still take `-q/--query` and must still mark it REQUIRED. If rUv changes the
 * interface, the honest outcome is UNKNOWN and a loud line — never a silent pass against a lesson
 * that is no longer true.
 */
export function verifyRufloFlag(bin = RUFLO_BIN) {
  if (!fs.existsSync(bin)) return { ok: false, why: `ruflo binary not found at ${bin} (Rule 21: the GLOBAL binary, never npx)` };
  const r = spawnSync(bin, ['memory', 'search', '--help'], { encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !out) return { ok: false, why: `ruflo memory search --help exited ${r.status} with no output` };
  const flag = /-q,\s*--query/.test(out);
  const required = /--query[^\n]*required/i.test(out);
  const positionalDocumented = /\bmemory search\s+"[^"]+"\s*$/m.test(out);
  if (!flag) return { ok: false, why: 'live `ruflo memory search --help` no longer advertises `-q, --query` — the lesson this trap records is no longer true', help: out };
  if (positionalDocumented) return { ok: false, why: 'live help now shows a POSITIONAL query example — the trap premise (positional is rejected) is broken', help: out };
  return { ok: true, flag: '-q, --query', required, evidence: out.split('\n').find((l) => /-q,\s*--query/.test(l))?.trim() || '' };
}

export function verifyPostTaskContract(bin = RUFLO_BIN) {
  if (!fs.existsSync(bin)) return { ok: false, why: `ruflo binary not found at ${bin} (Rule 21: the GLOBAL binary, never npx)` };
  const help = spawnRuflo(bin, ['hooks', 'post-task', '--help'], { encoding: 'utf8', timeout: 30_000 });
  const out = `${help.stdout || ''}${help.stderr || ''}`;
  if (!/--task\b/.test(out) || !/--agent\b/.test(out) || !/--store-results\b/.test(out)
    || !/Without this \+ --agent, no routing outcome is recorded/.test(out)) {
    return { ok: false, why: 'live post-task help no longer states the three-part routing-persistence contract', help: out };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-post-task-premise-'));
  const missing = spawnRuflo(bin, ['hooks', 'post-task', '-i', 'd4-premise-missing', '--success', 'true'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const outcomeFile = path.join(dir, '.claude-flow', 'routing-outcomes.json');
  const memoryFile = path.join(dir, '.claude-flow', 'memory', 'store.json');
  const persisted = fs.existsSync(outcomeFile) || fs.existsSync(memoryFile);
  fs.rmSync(dir, { recursive: true, force: true });
  if (missing.status !== 0 || persisted) {
    return {
      ok: false,
      why: 'live post-task missing-contract probe did not stay non-persistent while returning success',
      missingExit: missing.status,
      persisted,
    };
  }
  return {
    ok: true,
    flag: '--task + --agent + --store-results',
    required: true,
    evidence: 'live help names all three flags; success/task-id-only probe exited 0 and created neither routing outcome nor routing-decision store',
    missingExit: missing.status,
  };
}

// ── the fixture world ───────────────────────────────────────────────────────────────────────────
const CLAUDE_BIN = process.env.RUVNET_CLAUDE_BIN || path.join(os.homedir(), '.npm-global', 'bin', 'claude');
const CODEX_BIN = process.env.RUVNET_CODEX_BIN || 'codex';

/** Project B's task. Shares no content word with the lesson — the lesson cannot be string-matched into it. */
export const REPLAY_PROMPT =
  'Earlier in this project someone recorded a note about the caching strategy. '
  + "Recall it from this project's agent memory with the ruflo CLI. "
  + 'Run the recall command now, then tell me what you ran.';

/** The correction as it is written down in fixture-project-A, in project A's own words. */
export const LESSON_STATEMENT =
  'When you look something up in agent memory with the ruflo CLI, the query has to be passed with the '
  + '-q flag; a bare quoted phrase placed after the subcommand is rejected.';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* nothing to remove */ } }

/** Allocate one collision-proof fixture root; Date.now() alone collides under parallel CI. */
export function allocateRunBase(root = path.join(ROOT, '.ruvnet-brain', 'learning-replay')) {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'run-'));
}

function initMemoryDb(ruflo, db, cwd) {
  return sh(ruflo, ['memory', 'init', '--path', db, '--backend', 'hybrid'], { cwd });
}

/**
 * Build the two fixture projects and the isolated brain world.
 *
 * Everything the product reads is redirected by env — RUVNET_BRAIN_HOME (spine), RUVNET_BRAIN_STATE_DIR
 * (the on/off sentinel), RUVNET_LESSON_STORE, RUVNET_LESSON_GATE_STATE. Nothing here touches the
 * user's real ~/.config/ruvnet-brain, ~/.cache/ruvnet-brain, or any real project's memory.
 */
export function buildFixtures(baseDir) {
  rmrf(baseDir);
  const dirs = {
    base: baseDir,
    projectA: path.join(baseDir, 'fixture-project-a'),
    projectA2: path.join(baseDir, 'fixture-project-a-independent'),
    projectB: path.join(baseDir, 'fixture-project-b'),
    brainHome: path.join(baseDir, 'brain-home'),
    stateOn: path.join(baseDir, 'state-on'),
    stateOff: path.join(baseDir, 'state-off'),
    transcripts: path.join(baseDir, 'transcripts'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  dirs.lessons = path.join(baseDir, 'lessons.json');
  dirs.gateState = path.join(baseDir, 'lesson-gate-state.json');
  // The control's switch: ADR-054's real sentinel, in the control's own state dir.
  fs.writeFileSync(path.join(dirs.stateOff, 'brain-off'), JSON.stringify({ since: new Date().toISOString() }));
  // Each fixture project is its own git repo so lesson-gate's project-scope resolution (which walks
  // up to the nearest .git) sees `fixture-project-b`, not the harness's own repo.
  for (const p of [dirs.projectA, dirs.projectA2, dirs.projectB]) {
    sh('git', ['init', '-q'], { cwd: p });
    fs.mkdirSync(path.join(p, '.swarm'), { recursive: true });
  }
  return dirs;
}

/**
 * RECORD, in fixture-project-A.
 *
 * Two layers, both real:
 *   1. the correction is written into project A's OWN memory with `ruflo memory store` — the real
 *      CLI, the real per-project `.swarm/memory.db` the global memory policy mandates. It is then
 *      READ BACK with `ruflo memory search -q` (the very flag under test, so the record step itself
 *      exercises the true interface), and the retrieved text is what the lesson is built from. The
 *      lesson is DERIVED from project A, not hardcoded beside it.
 *   2. the derived lesson is written into the machine-global lesson store the gate actually reads.
 *
 * SCOPE is the real ADR-029 rule, not a fixture bypass. The same correction is independently stored
 * and read back in TWO distinct git projects. The executable lesson carries both project names, so
 * lesson-gate.mjs's `projects.length >= 2` universal predicate is what permits it to speak in the
 * third replay project. One source would correctly be silent there. The committed artifact records
 * the two source identities and `checkPortfolio()` refuses a result without that win-twice proof.
 */
export function recordInProjectA(dirs, { ruflo = RUFLO_BIN, trap = TRAP.MEMORY_SEARCH } = {}) {
  const spec = trapSpec(trap);
  const sources = [dirs.projectA, dirs.projectA2].map((project, index) => {
    const db = path.join(project, '.swarm', 'memory.db');
    const key = `${spec.memoryKey}-${index + 1}`;
    const init = initMemoryDb(ruflo, db, project);
    const store = sh(ruflo, ['memory', 'store', '-k', key, '--value', spec.lesson, '-n', 'default', '--path', db],
      { cwd: project });
    const back = sh(ruflo, ['memory', 'search', '-q', spec.recordQuery, '-n', 'default', '--path', db, '-t', 'keyword'],
      { cwd: project });
    return {
      project: path.basename(project),
      db,
      key,
      initExit: init.status,
      storeExit: store.status,
      readBackExit: back.status,
      recorded: fs.existsSync(db),
    };
  });

  const lesson = makeLesson({
    id: spec.lessonId,
    statement: spec.lesson,
    // `assert-fact` is the decision point the real dispatcher requests at UserPromptSubmit
    // (plugin/scripts/lesson-hooks.sh) — i.e. before any tool call, which is PASS-condition (a).
    trigger: 'assert-fact',
    enforcement: 'checklist',
    origin: 'user-stated',
    status: 'ratified',
    severity: 'high',
    repeatCount: 4,
    projects: sources.map((source) => source.project),
    check: spec.check,
    evidence: [
      ...sources.map((source) => ({
        observed: `independently recorded in ${source.project} as memory key "${source.key}" in ${path.relative(dirs.base, source.db)}`,
      })),
      { observed: `live premise for ${spec.id} was re-verified before replay` },
    ],
  });
  saveLessons([lesson], dirs.lessons);
  const sourcesOk = sources.every((source) =>
    source.initExit === 0 && source.storeExit === 0 && source.readBackExit === 0 && source.recorded);
  return {
    ok: sourcesOk && loadLessons(dirs.lessons).length === 1 && lesson.projects.length >= 2,
    trap: spec.id,
    sources,
    projectCount: lesson.projects.length,
    promoted: lesson.projects.length >= 2,
    key: sources[0].key,
    storeExit: sources[0].storeExit,
    readBackExit: sources[0].readBackExit,
    lesson,
  };
}

/**
 * SEED PROJECT B — make the fixture world true.
 *
 * REPLAY_PROMPT tells the agent "earlier in this project someone recorded a note about the caching
 * strategy". Until 2026-07-28 that was false: project B's store was empty, so no command the agent
 * could possibly write would retrieve anything, and the execution gate would be measuring the
 * harness. The note is written with the real CLI into project B's own `.swarm/memory.db` — the
 * default path a bare `ruflo memory search` resolves from cwd.
 *
 * It cannot leak the lesson: the note's text says nothing about `-q`, and neither arm ever sees it
 * (the recorder blocks every produced command before it runs). It is read only by the harness,
 * out of band, after the arm is finished.
 */
export function seedProjectBMemory(dirs, { ruflo = RUFLO_BIN } = {}) {
  const dbB = path.join(dirs.projectB, '.swarm', 'memory.db');
  const init = initMemoryDb(ruflo, dbB, dirs.projectB);
  const r = sh(ruflo, ['memory', 'store', '-k', PROJECT_B_MEMORY_KEY, '--value', PROJECT_B_MEMORY_VALUE, '-n', 'default', '--path', dbB],
    { cwd: dirs.projectB });
  return {
    db: dbB,
    key: PROJECT_B_MEMORY_KEY,
    initExit: init.status,
    storeExit: r.status,
    ok: init.status === 0 && r.status === 0 && fs.existsSync(dbB),
  };
}

/**
 * THE NIGHTLY REFRESH, run BETWEEN record and replay. PASS-condition (c).
 *
 * Two real things, not a sleep:
 *   1. a NEW Stable-Spine generation is installed into the fixture brain home and active.json is
 *      flipped to it — so the replay's hooks execute from a code root that did not exist when the
 *      lesson was recorded. This is exactly what scripts/update-apply.mjs does nightly, and it is the
 *      thing a lesson has to survive: the lesson store lives at user level, deliberately OUTSIDE the
 *      bundle a refresh replaces (scripts/lesson-store.mjs says so in its own persistence note).
 *   2. `ruflo memory distill run` and `ruflo memory backup` against project A's store — the two
 *      commands scripts/nightly-wrapper.sh actually runs every night.
 */
export function nightlyRefresh(dirs, { ruflo = RUFLO_BIN } = {}) {
  const gen = `d4-refresh-${Date.now()}`;
  const versionDir = path.join(dirs.brainHome, 'versions', gen);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin'), versionDir, { recursive: true });
  // Codex discovers the installed plugin's global hook manifest, not fixture-local `.codex` hooks.
  // The stable wrapper resolves this fixture generation through RUVNET_BRAIN_HOME, so replace only
  // the fixture generation's host adapter with the replay tap. The real hook body remains the copied
  // hook-shim beside it; the adapter merely records delivery and blocks the first proposed command.
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'ci', 'learning-replay-codex-adapter.mjs'),
    path.join(versionDir, 'scripts', 'codex-hook-adapter.mjs'),
  );
  fs.writeFileSync(path.join(dirs.brainHome, 'active.json'), JSON.stringify({ codeRoot: versionDir, generation: gen }, null, 2));
  fs.writeFileSync(path.join(dirs.brainHome, '.spine-seeded'), gen);

  const dbA = path.join(dirs.projectA, '.swarm', 'memory.db');
  const distill = sh(ruflo, ['memory', 'distill', 'run', '--path', dbA], { cwd: dirs.projectA });
  const backup = sh(ruflo, ['memory', 'backup', '--db', dbA, '--keep', '2'], { cwd: dirs.projectA });

  const survived = loadLessons(dirs.lessons).length === 1;
  // Repo-relative, never absolute: this artifact is COMMITTED, and an absolute path publishes the
  // maintainer's directory layout to every reader. The same disclosure was already found and fixed
  // once in session-start.sh; one bug, found once, must not be left everywhere else.
  return { generation: gen, codeRoot: path.relative(ROOT, versionDir), distillExit: distill.status, backupExit: backup.status, lessonSurvived: survived };
}

/** The fixture settings file — the REAL hook registration from plugin/hooks/hooks.json, plus the tap. */
function writeSettings(file, { dirs, stateDir, attemptsFile }) {
  const settings = {
    env: {
      RUVNET_BRAIN_HOME: dirs.brainHome,
      RUVNET_BRAIN_STATE_DIR: stateDir,
      RUVNET_LESSON_STORE: dirs.lessons,
      RUVNET_LESSON_GATE_STATE: dirs.gateState,
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    },
    hooks: {
      UserPromptSubmit: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `node ${JSON.stringify(path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'))} unprompted-speech UserPromptSubmit`,
          timeout: 20,
        }],
      }],
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: `node ${JSON.stringify(path.join(ROOT, 'scripts', 'ci', 'learning-replay-recorder.mjs'))} ${JSON.stringify(attemptsFile)}`,
          timeout: 20,
        }],
      }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

export function buildCodexArgv({ model = 'gpt-5.6-sol', prompt = REPLAY_PROMPT, appendSystemPrompt = null } = {}) {
  const fullPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${prompt}` : prompt;
  return [
    'exec',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--color', 'never',
    '--json',
    '--ignore-rules',
    '--dangerously-bypass-hook-trust',
    '-m', model,
    '-c', 'model_reasoning_effort="low"',
    '-c', 'shell_environment_policy.inherit="all"',
    fullPrompt,
  ];
}

/**
 * Run ONE arm and return what it produced.
 *
 * The transcript is stream-json with --include-hook-events, so hook delivery and tool calls appear
 * IN ORDER in one array. `lessonIndex` and `firstToolIndex` are positions in that array — condition
 * (a) is a measured ordering, not an argument from how hooks are supposed to work.
 */
export function replayRunError(events, processResult) {
  if (processResult?.error) return String(processResult.error.message || processResult.error);
  const result = events.find((e) => e.type === 'result');
  if (!result?.is_error) return null;
  const status = result.api_error_status ? `HTTP ${result.api_error_status}: ` : '';
  return `${status}${result.result || result.terminal_reason || 'model execution failed'}`;
}

export function parseCodexRunError(events, processResult) {
  if (processResult?.error) return String(processResult.error.message || processResult.error);
  const failed = events.find((event) => event.type === 'turn.failed');
  if (failed) return String(failed.error?.message || failed.error || 'Codex turn failed');
  if (events.some((event) => event.type === 'turn.completed') && processResult?.status === 0) return null;
  const errorItem = events.find((event) => event.type === 'item.completed' && event.item?.type === 'error');
  if (errorItem) return String(errorItem.item?.message || errorItem.item?.text || 'Codex execution failed');
  return processResult?.status && processResult.status !== 0
    ? `Codex exited ${processResult.status}`
    : null;
}

export function codexLessonBeforeTool(sequence) {
  const lesson = sequence.find((event) => event.kind === 'lesson');
  const tool = sequence.find((event) => event.kind === 'tool');
  return Boolean(lesson && tool && BigInt(lesson.atNs) < BigInt(tool.atNs));
}

export function runArm({
  dirs,
  arm,
  stateDir,
  model,
  host = 'claude-code',
  appendSystemPrompt = null,
  tag,
  forceCommand = null,
  trap = TRAP.MEMORY_SEARCH,
}) {
  const spec = trapSpec(trap);
  const attempts = path.join(dirs.transcripts, `${tag}.attempts.jsonl`);
  const sequenceFile = path.join(dirs.transcripts, `${tag}.sequence.jsonl`);
  const streamFile = path.join(dirs.transcripts, `${tag}.stream.jsonl`);
  let binary;
  let argv;
  if (host === 'codex') {
    binary = CODEX_BIN;
    argv = buildCodexArgv({ model, prompt: spec.prompt, appendSystemPrompt });
  } else {
    const settings = writeSettings(path.join(dirs.base, `settings-${tag}.json`), { dirs, stateDir, attemptsFile: attempts });
    binary = CLAUDE_BIN;
    argv = [
      '-p', spec.prompt,
      '--model', model,
      '--tools', 'Bash',
      '--permission-mode', 'bypassPermissions',
      '--setting-sources', '',
      '--settings', settings,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
      '--no-session-persistence',
      '--max-budget-usd', '0.30',
    ];
    if (appendSystemPrompt) argv.push('--append-system-prompt', appendSystemPrompt);
  }

  const started = Date.now();
  const r = spawnSync(binary, argv, {
    cwd: dirs.projectB,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      RUVNET_BRAIN_HOME: dirs.brainHome,
      RUVNET_BRAIN_STATE_DIR: stateDir,
      RUVNET_LESSON_STORE: dirs.lessons,
      RUVNET_LESSON_GATE_STATE: dirs.gateState,
      RUVNET_REPLAY_ATTEMPTS_FILE: attempts,
      RUVNET_REPLAY_SEQUENCE_FILE: sequenceFile,
      RUVNET_REPLAY_LESSON_PROBE: spec.lesson.slice(0, 60),
      RUVNET_REPLAY_RECORDER: path.join(ROOT, 'scripts', 'ci', 'learning-replay-recorder.mjs'),
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    },
  });
  const wallMs = Date.now() - started;
  fs.writeFileSync(streamFile, r.stdout || '');
  if (r.stderr) fs.writeFileSync(path.join(dirs.transcripts, `${tag}.stderr.txt`), r.stderr);

  const events = (r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const probe = spec.lesson.slice(0, 60);
  let lessonIndex = -1, firstToolIndex = -1, lessonDelivered = false;
  const sequence = fs.existsSync(sequenceFile)
    ? fs.readFileSync(sequenceFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  if (host === 'codex') {
    lessonIndex = sequence.findIndex((event) => event.kind === 'lesson');
    firstToolIndex = sequence.findIndex((event) => event.kind === 'tool');
    lessonDelivered = lessonIndex !== -1;
  } else {
    events.forEach((e, i) => {
      if (lessonIndex === -1 && e.type === 'system' && e.subtype === 'hook_response'
        && typeof e.output === 'string' && e.output.includes(probe)) { lessonIndex = i; lessonDelivered = true; }
      if (firstToolIndex === -1 && e.type === 'assistant'
        && Array.isArray(e.message?.content) && e.message.content.some((c) => c.type === 'tool_use')) firstToolIndex = i;
    });
  }

  const attemptLines = fs.existsSync(attempts)
    ? fs.readFileSync(attempts, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  // THE ARTIFACT is the FIRST command the agent produced — not its best one. A second attempt after
  // the sandbox refusal is a repair, and crediting a repair would let the agent learn the answer
  // from the harness instead of from the lesson.
  // MUTANT force-*: substitute the artifact the oracle sees, leaving the real run untouched. This is
  // how mutant 1 ("right flag, wrong subcommand") is proven end-to-end without waiting for a
  // stochastic model to happen to emit it.
  const firstCommand = forceCommand != null ? forceCommand : (attemptLines.length ? attemptLines[0].command : '');
  const cls = trap === TRAP.POST_TASK
    ? classifyPostTaskCommand(firstCommand)
    : classifyCommand(firstCommand);
  const subOk = trap === TRAP.POST_TASK
    ? postTaskSubcommandCorrect(firstCommand)
    : subcommandCorrect(firstCommand);
  // THE EXECUTION GATE. Out of band, after the arm is over, never through a shell — see the header.
  const exec = executeProducedCommand(firstCommand, { cwd: dirs.projectB, base: dirs.base, trap });

  const result = events.find((e) => e.type === 'result');
  return {
    arm,
    tag,
    class: cls,
    subcommandCorrect: subOk,
    exec,
    command: firstCommand,
    forcedCommand: forceCommand != null,
    attempts: attemptLines.map((a) => a.command),
    lessonDelivered,
    lessonIndex,
    firstToolIndex,
    lessonBeforeFirstToolCall: host === 'codex'
      ? codexLessonBeforeTool(sequence)
      : lessonDelivered && firstToolIndex > -1 && lessonIndex < firstToolIndex,
    costUsd: result?.total_cost_usd ?? null,
    wallMs,
    modelUsed: events.find((e) => e.type === 'system' && e.subtype === 'init')?.model
      || events.find((e) => e.type === 'assistant')?.message?.model || model,
    host,
    transcript: path.relative(ROOT, streamFile),
    exit: r.status,
    spawnError: host === 'codex' ? parseCodexRunError(events, r) : replayRunError(events, r),
  };
}

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const usage = () => `Usage:
  node scripts/learning-replay.mjs [--trap ${TRAP.MEMORY_SEARCH}|${TRAP.POST_TASK}] [--n N] [--host codex|claude-code] [--model MODEL]
  node scripts/learning-replay.mjs --check
  node scripts/learning-replay.mjs --check-portfolio
  node scripts/learning-replay.mjs --check-mutants
  node scripts/learning-replay.mjs --dry-run
  node scripts/learning-replay.mjs --mutant <${Object.keys(MUTANTS).join('|')}>

Exit: 0=PASS, 1=FAIL, 3=INCONCLUSIVE, 4=UNKNOWN.`;

/** The command mutant `wrong-subcommand` substitutes: the grader's exact defect, right flag on a wrong verb. */
export const WRONG_SUBCOMMAND_COMMAND = 'ruflo recall -q "caching strategy"';

export const MUTANTS = Object.freeze({
  'delete-lesson': 'delete the recorded lesson from the fixture store after the refresh — the treated arm must go red',
  'brain-off-treated': 'run the TREATED arm with the brain disabled — it must produce the control artifact and go red',
  'seed-control': "pre-seed the CONTROL arm's context with the lesson — the harness must report INCONCLUSIVE, never PASS",
  // ── the execution gate's own mutants (2026-07-28) ──
  'wrong-subcommand': `substitute the treated arm's artifact with \`${WRONG_SUBCOMMAND_COMMAND}\` — right flag, wrong verb: the exact command the grader found being certified. Must go red.`,
  'empty-store': "empty project B's seeded memory before the gate runs — a perfect command that retrieves nothing must go red on RETRIEVAL, not pass on exit status",
});

/** Committed real-model evidence for ADR-058's two named falsification traps. */
export const MUTANT_RESULT_FILES = Object.freeze({
  [TRAP.MEMORY_SEARCH]: Object.freeze({
    'delete-lesson': path.join(ROOT, 'data', 'learning-replay-delete-lesson-result.json'),
    'brain-off-treated': path.join(ROOT, 'data', 'learning-replay-brain-off-result.json'),
  }),
  [TRAP.POST_TASK]: Object.freeze({
    'delete-lesson': path.join(ROOT, 'data', 'learning-replay-post-task-delete-lesson-result.json'),
    'brain-off-treated': path.join(ROOT, 'data', 'learning-replay-post-task-brain-off-result.json'),
  }),
});

export const PORTFOLIO_RESULT_FILES = Object.freeze({
  [TRAP.MEMORY_SEARCH]: RESULT_FILE,
  [TRAP.POST_TASK]: POST_TASK_RESULT_FILE,
});

function headSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** `--check`: gate on the committed artifact WITHOUT spending a token. */
export function checkArtifact({ file = RESULT_FILE, repo = ROOT, maxAgeDays = 14 } = {}) {
  if (!fs.existsSync(file)) {
    return { status: VERDICT.UNKNOWN, why: `no result artifact at ${path.relative(repo, file)} — the replay has never been run on this checkout` };
  }
  let a;
  try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { status: VERDICT.UNKNOWN, why: `result artifact unparseable: ${e.message}` }; }
  if (a.invariant !== INVARIANT) return { status: VERDICT.UNKNOWN, why: `artifact declares invariant "${a.invariant}", expected ${INVARIANT}` };
  if (!a.sha) return { status: VERDICT.UNKNOWN, why: 'artifact states no SHA — a result with no SHA is a result about nothing' };

  const head = headSha();
  const stale = [];
  if (head && a.sha !== head) {
    // Not the same commit: the result is still CURRENT only if nothing load-bearing moved.
    const anc = spawnSync('git', ['merge-base', '--is-ancestor', a.sha, head], { cwd: repo });
    if (anc.status !== 0) return { status: VERDICT.UNKNOWN, why: `artifact SHA ${a.sha.slice(0, 8)} is not an ancestor of HEAD ${head.slice(0, 8)} — it measures a different tree` };
    const diff = spawnSync('git', ['diff', '--name-only', `${a.sha}..${head}`, '--', ...LOAD_BEARING], { cwd: repo, encoding: 'utf8' });
    if (diff.status === 0) for (const f of diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) stale.push(f);
  }
  if (stale.length) {
    return { status: VERDICT.UNKNOWN, why: `result recorded on ${a.sha.slice(0, 8)}, but ${stale.length} load-bearing file(s) changed since: ${stale.join(', ')} — re-run the replay` };
  }
  const ageDays = a.at ? (Date.now() - Date.parse(a.at)) / 86_400_000 : Infinity;
  if (!(ageDays <= maxAgeDays)) {
    return { status: VERDICT.UNKNOWN, why: `result is ${Number.isFinite(ageDays) ? ageDays.toFixed(1) : '?'} days old (max ${maxAgeDays}) — a nightly trap that has not run is UNKNOWN, never PASS` };
  }
  return {
    status: a.verdict,
    why: `${a.verdict} — ${a.passes}/${a.n} runs, control produced the token in ${a.controlTokenRuns}/${a.n}, recorded on ${a.sha.slice(0, 8)} (${a.model})`,
    artifact: a,
  };
}

/**
 * Verify the two named ADR-058 mutants were run against a current load-bearing tree and each
 * destroyed the claimed effect. A mutant FAIL is evidence only when the failure has the expected
 * causal shape; "the executor crashed" or "some unrelated assertion failed" cannot satisfy this.
 */
export function checkMutantArtifacts({
  files = MUTANT_RESULT_FILES,
  repo = ROOT,
  maxAgeDays = 14,
} = {}) {
  const checked = [];
  for (const trap of [TRAP.MEMORY_SEARCH, TRAP.POST_TASK]) {
    for (const mutant of ['delete-lesson', 'brain-off-treated']) {
    const file = files[trap]?.[mutant];
    if (!file || !fs.existsSync(file)) {
      return { status: VERDICT.UNKNOWN, why: `${trap}/${mutant}: no committed execution artifact`, checked };
    }

    const currency = checkArtifact({ file, repo, maxAgeDays });
    if (currency.status === VERDICT.UNKNOWN) {
      return { status: VERDICT.UNKNOWN, why: `${trap}/${mutant}: ${currency.why}`, checked };
    }

    let artifact;
    try { artifact = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return { status: VERDICT.UNKNOWN, why: `${mutant}: artifact unparseable: ${e.message}`, checked }; }

    if (artifact.mutant !== mutant || artifact.trap !== trap) {
      return { status: VERDICT.FAIL, why: `${trap}/${mutant}: artifact identity mismatch`, checked };
    }
    if (artifact.verdict !== VERDICT.FAIL || artifact.passes !== 0 || !(artifact.n >= 1)) {
      return { status: VERDICT.FAIL, why: `${mutant}: mutant did not go red with zero passes`, checked };
    }
    if (!Array.isArray(artifact.runs) || artifact.runs.length !== artifact.n) {
      return { status: VERDICT.FAIL, why: `${mutant}: missing per-run execution evidence`, checked };
    }

    if (mutant === 'delete-lesson') {
      const lessonSurvived = artifact.runs.some((run) =>
        run.treated?.lessonBeforeFirstToolCall === true
        || run.treated?.lessonDelivered === true
        || run.treated?.class === 'flagged');
      if (lessonSurvived) {
        return { status: VERDICT.FAIL, why: 'delete-lesson: treated arm still received or reproduced the lesson', checked };
      }
    } else {
      const differsFromControl = artifact.runs.some((run) =>
        run.treated?.lessonBeforeFirstToolCall === true
        || run.treated?.lessonDelivered === true
        || run.control?.lessonDelivered === true
        || run.treated?.class !== run.control?.class);
      if (differsFromControl) {
        return { status: VERDICT.FAIL, why: 'brain-off-treated: treated arm did not collapse to the brain-off control artifact', checked };
      }
    }
    checked.push(`${trap}/${mutant}`);
    }
  }
  return {
    status: VERDICT.PASS,
    why: 'delete-lesson and brain-off-treated both went red for both independent traps on current real-model execution evidence',
    checked,
  };
}

export function checkPortfolio({
  files = PORTFOLIO_RESULT_FILES,
  mutantFiles = MUTANT_RESULT_FILES,
  repo = ROOT,
  maxAgeDays = 14,
} = {}) {
  const artifacts = [];
  for (const trap of [TRAP.MEMORY_SEARCH, TRAP.POST_TASK]) {
    const checked = checkArtifact({ file: files[trap], repo, maxAgeDays });
    if (checked.status !== VERDICT.PASS) {
      return { status: checked.status, why: `${trap}: ${checked.why}`, artifacts };
    }
    const a = checked.artifact;
    if (a.trap !== trap || a.n < 3 || a.passes < 2 || a.controlTokenRuns !== 0 || a.controlWorkedRuns !== 0) {
      return { status: VERDICT.FAIL, why: `${trap}: artifact does not prove N>=3 treated/control causal separation`, artifacts };
    }
    if (a.promotion?.projectCount < 2 || a.promotion?.promoted !== true
      || new Set(a.promotion?.sourceProjects || []).size < 2) {
      return { status: VERDICT.FAIL, why: `${trap}: lesson did not earn the real win-twice cross-project scope`, artifacts };
    }
    if (a.refresh?.lessonSurvived !== true) {
      return { status: VERDICT.FAIL, why: `${trap}: learned lesson did not survive refresh`, artifacts };
    }
    artifacts.push(a);
  }
  if (artifacts[0].record?.lessonId === artifacts[1].record?.lessonId
    || artifacts[0].task === artifacts[1].task) {
    return { status: VERDICT.FAIL, why: 'portfolio traps are not independent lesson/task classes', artifacts };
  }
  const mutants = checkMutantArtifacts({ files: mutantFiles, repo, maxAgeDays });
  if (mutants.status !== VERDICT.PASS) return { ...mutants, why: `portfolio mutants: ${mutants.why}`, artifacts };
  return {
    status: VERDICT.PASS,
    why: 'two independent Ruflo CLI lessons each passed N>=3 treated/control, earned win-twice scope in two source projects, survived refresh, executed a meaningful outcome, and failed both causal mutants',
    artifacts,
    mutants,
  };
}

async function main() {
  if (has('--help') || has('-h')) {
    console.log(usage());
    return;
  }
  const check = has('--check');
  const checkPortfolioFlag = has('--check-portfolio');
  const checkMutants = has('--check-mutants');
  const dryRun = has('--dry-run');
  const mutant = arg('--mutant', null);
  const trap = arg('--trap', TRAP.MEMORY_SEARCH);
  const spec = trapSpec(trap);
  const n = Math.max(1, parseInt(arg('--n', mutant ? '1' : '3'), 10) || 1);
  const host = arg('--host', 'codex');
  const model = arg('--model', host === 'codex' ? 'gpt-5.6-sol' : 'haiku');
  const defaultOut = mutant
    ? MUTANT_RESULT_FILES[trap]?.[mutant]
    : PORTFOLIO_RESULT_FILES[trap];
  const outFile = arg('--out', defaultOut);
  const keep = has('--keep-fixtures');

  if (mutant && !MUTANTS[mutant]) {
    console.error(`unknown mutant "${mutant}". known: ${Object.keys(MUTANTS).join(', ')}`);
    process.exit(EXIT.UNKNOWN);
  }
  if (![TRAP.MEMORY_SEARCH, TRAP.POST_TASK].includes(trap) || !outFile) {
    console.error(`unknown or unsupported trap/mutant combination: ${trap}/${mutant || 'normal'}`);
    process.exit(EXIT.UNKNOWN);
  }

  if (check) {
    const res = checkArtifact({ file: PORTFOLIO_RESULT_FILES[trap] });
    console.log(`\n  ${INVARIANT}: ${res.status}\n  ${res.why}\n`);
    process.exit(EXIT[res.status] ?? EXIT.UNKNOWN);
  }

  if (checkPortfolioFlag) {
    const res = checkPortfolio();
    console.log(`\n  ${INVARIANT}-PORTFOLIO: ${res.status}\n  ${res.why}\n`);
    process.exit(EXIT[res.status] ?? EXIT.UNKNOWN);
  }

  if (checkMutants) {
    const res = checkMutantArtifacts();
    console.log(`\n  ${INVARIANT}-MUTANTS: ${res.status}\n  ${res.why}\n`);
    process.exit(EXIT[res.status] ?? EXIT.UNKNOWN);
  }

  console.log(`\n=== ${INVARIANT} — counterfactual replay (ADR-058 §D4) ===`);
  const flag = trap === TRAP.POST_TASK ? verifyPostTaskContract() : verifyRufloFlag();
  console.log(`  trap:    ${trap}`);
  console.log(`  premise: ${flag.ok ? `VERIFIED live: ${flag.evidence}` : `NOT VERIFIED: ${flag.why}`}`);
  if (!flag.ok) {
    const artifact = writeArtifact(outFile, {
      verdict: VERDICT.UNKNOWN, why: `premise not verified: ${flag.why}`, n: 0, passes: 0, fails: 0, unknowns: 0, controlTokenRuns: 0, rate: 0, runs: [],
    }, { host, model, mutant });
    console.log(`  → UNKNOWN (never a pass). artifact: ${path.relative(ROOT, outFile)}`);
    process.exit(EXIT.UNKNOWN);
  }

  const base = allocateRunBase();
  const dirs = buildFixtures(base);
  // Ruflo may auto-start a workspace daemon while initializing a fixture memory DB. Reap only
  // daemons whose explicit --workspace lives under THIS run, including on Ctrl-C or an exception.
  process.once('exit', () => { cleanupFixtureDaemons(dirs); });
  const rec = recordInProjectA(dirs, { trap });
  console.log(`  record  (two independent source projects): ${rec.projectCount} sources, win-twice=${rec.promoted}, lesson ${rec.ok ? 'derived + ratified' : 'NOT recorded'}`);
  const seed = trap === TRAP.MEMORY_SEARCH
    ? seedProjectBMemory(dirs)
    : { key: null, storeExit: null, ok: true, skipped: 'the command-risk trap needs no target-project memory row' };
  console.log(`  seed    (fixture-project-B): ${seed.skipped || `note "${seed.key}" ${seed.ok ? 'stored — the task premise is true' : `NOT stored (exit ${seed.storeExit})`}`}`);
  const refresh = nightlyRefresh(dirs);
  console.log(`  refresh (nightly):           spine generation ${refresh.generation} installed + active; distill exit ${refresh.distillExit}, backup exit ${refresh.backupExit}; lesson survived: ${refresh.lessonSurvived}`);

  if (mutant === 'delete-lesson') {
    saveLessons([], dirs.lessons);
    try { fs.rmSync(path.join(dirs.projectA, '.swarm', 'memory.db'), { force: true }); } catch { /* already gone */ }
    console.log(`  MUTANT delete-lesson: lesson store emptied (${loadLessons(dirs.lessons).length} lessons) and project A's memory.db removed`);
  }

  if (mutant === 'empty-store') {
    // Remove the seeded note. Every arm still runs for real; the produced command still executes for
    // real; it simply has nothing to find. The gate must key on RETRIEVAL, not on exit status —
    // `ruflo memory search -q "<absent>"` exits 0.
    try { fs.rmSync(path.join(dirs.projectB, '.swarm', 'memory.db'), { force: true }); } catch { /* already gone */ }
    console.log(`  MUTANT empty-store: project B's seeded memory removed (exists: ${fs.existsSync(path.join(dirs.projectB, '.swarm', 'memory.db'))})`);
  }

  if (dryRun) {
    // Prove the WIRE without a token: fire the real hook chain in both states and report the bytes.
    const probe = (stateDir) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'), 'unprompted-speech', 'UserPromptSubmit'], {
        input: JSON.stringify({ prompt: spec.prompt, session_id: `dry-${Date.now()}`, cwd: dirs.projectB }),
        encoding: 'utf8',
        cwd: dirs.projectB,
        env: {
          ...process.env,
          RUVNET_BRAIN_HOME: dirs.brainHome,
          RUVNET_BRAIN_STATE_DIR: stateDir,
          RUVNET_LESSON_STORE: dirs.lessons,
          RUVNET_LESSON_GATE_STATE: dirs.gateState,
          CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
        },
      });
      return (r.stdout || '').length;
    };
    const onBytes = probe(dirs.stateOn), offBytes = probe(dirs.stateOff);
    console.log(`  dry-run: treated-state hook emitted ${onBytes} bytes; control-state (brain-off) emitted ${offBytes} bytes`);
    writeArtifact(outFile, {
      verdict: VERDICT.UNKNOWN, why: `--dry-run: no model was called, so nothing was measured (wire probe: treated ${onBytes}B, control ${offBytes}B)`,
      n: 0, passes: 0, fails: 0, unknowns: 0, controlTokenRuns: 0, rate: 0, runs: [],
    }, { host, model, mutant, record: rec, seed, refresh });
    console.log(`  → UNKNOWN (a dry run is never a pass). artifact: ${path.relative(ROOT, outFile)}`);
    if (!keep) {
      cleanupFixtureDaemons(dirs);
      rmrf(base);
    }
    process.exit(EXIT.UNKNOWN);
  }

  const runs = [];
  for (let i = 1; i <= n; i++) {
    const treatedState = mutant === 'brain-off-treated' ? dirs.stateOff : dirs.stateOn;
    const treated = runArm({
      dirs, arm: 'treated', stateDir: treatedState, model, host, tag: `run${i}-treated`, trap,
      forceCommand: mutant === 'wrong-subcommand' ? WRONG_SUBCOMMAND_COMMAND : null,
    });
    const control = runArm({
      dirs, arm: 'control', stateDir: dirs.stateOff, model, host, tag: `run${i}-control`, trap,
      // MUTANT seed-control: the control is handed the lesson through a channel the brain does not
      // own. Its artifact then carries the token, and invariant 6 must fire.
      appendSystemPrompt: mutant === 'seed-control' ? spec.lesson : null,
    });
    const run = {
      i,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
      controlLessonDelivered: control.lessonDelivered,
      // ── the execution gate's inputs, flattened so verdictForRun stays a pure function ──
      treatedSubcommandCorrect: treated.subcommandCorrect,
      treatedExecOk: treated.exec?.exitOk === true,
      treatedRetrieved: treated.exec?.retrieved === true,
      treatedExecWhy: treated.exec?.why || null,
      controlWorked: control.exec?.exitOk === true && control.exec?.retrieved === true,
      treated,
      control,
      error: treated.spawnError || control.spawnError || null,
    };
    const v = verdictForRun(run);
    console.log(`  run ${i}: treated="${treated.class}" (${treated.command || '—'})`);
    console.log(`         control="${control.class}" (${control.command || '—'})`);
    console.log(`         EXECUTED treated: subcommand=${treated.subcommandCorrect} exit=${treated.exec?.exit ?? '—'} retrieved=${treated.exec?.retrieved} · ${treated.exec?.why || 'not run'}`);
    console.log(`         EXECUTED control: exit=${control.exec?.exit ?? '—'} retrieved=${control.exec?.retrieved}`);
    console.log(`         lesson before first tool call: ${treated.lessonBeforeFirstToolCall} (lesson@${treated.lessonIndex}, tool@${treated.firstToolIndex}) · control got ${control.lessonDelivered ? 'THE LESSON (leak!)' : 'zero brain bytes'}`);
    console.log(`         → ${v.verdict}: ${v.why}`);
    runs.push(run);
  }

  const agg = aggregate(runs);
  const costUsd = runs.reduce((s, r) => s + (r.treated.costUsd || 0) + (r.control.costUsd || 0), 0);
  const wallMs = runs.reduce((s, r) => s + (r.treated.wallMs || 0) + (r.control.wallMs || 0), 0);
  writeArtifact(outFile, agg, { host, model, mutant, trap, task: spec.prompt, record: rec, seed, refresh, flag, costUsd, wallMs });

  console.log(`\n  RATE ${agg.passes}/${agg.n} · token carried by treated ${agg.treatedTokenRuns}/${agg.n} vs control ${agg.controlTokenRuns}/${agg.n}`);
  console.log(`  EXECUTION GATE: treated named the real subcommand ${agg.treatedSubcommandRuns}/${agg.n} · exited 0 ${agg.treatedExecutedRuns}/${agg.n} · RETRIEVED ${agg.treatedRetrievedRuns}/${agg.n} · control worked ${agg.controlWorkedRuns}/${agg.n}`);
  console.log(`  ${INVARIANT}: ${agg.verdict} — ${agg.why}`);
  if (!keep) pruneArchive(dirs);
  console.log(`  cost $${costUsd.toFixed(4)} · ${(wallMs / 1000).toFixed(1)}s wall · transcripts: ${path.relative(ROOT, dirs.transcripts)}`);
  console.log(`  artifact: ${path.relative(ROOT, outFile)}\n`);
  process.exit(EXIT[agg.verdict] ?? EXIT.UNKNOWN);
}

/**
 * RETENTION. "Transcripts archived" must not mean "the disk fills".
 *
 * Each run builds a whole fixture world, and the nightly refresh step copies plugin/ into it — ~12MB
 * per invocation, every night, forever. Measured 2026-07-27 after nine invocations in one session:
 * 36MB, of which the transcripts were under 300KB. So the EVIDENCE is kept and the SCAFFOLDING is
 * dropped: everything under the run directory except transcripts/ goes, and only the most recent
 * KEEP_RUNS run directories survive. `--keep-fixtures` retains everything for debugging.
 *
 * Deliberately not "delete the whole run dir": the transcripts ARE the archive ADR-058 asks for, and
 * an archive nobody kept is the same as a claim nobody checked.
 */
const KEEP_RUNS = 14;
export function cleanupFixtureDaemons(dirs) {
  const base = path.resolve(dirs.base);
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 });
  if (ps.status !== 0) return { found: 0, stopped: 0, errors: ['process census failed'] };
  const matches = String(ps.stdout || '').split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    return command.includes('daemon start --foreground')
      && command.includes('--workspace')
      && command.includes(base)
      && pid !== process.pid
      ? [{ pid, command }]
      : [];
  });
  const errors = [];
  let stopped = 0;
  for (const match of matches) {
    try { process.kill(match.pid, 'SIGTERM'); stopped++; }
    catch (error) {
      if (error?.code !== 'ESRCH') errors.push(`${match.pid}: ${error.message}`);
    }
  }
  return { found: matches.length, stopped, errors };
}

function pruneArchive(dirs) {
  cleanupFixtureDaemons(dirs);
  try {
    for (const e of fs.readdirSync(dirs.base, { withFileTypes: true })) {
      if (e.name === 'transcripts') continue;
      rmrf(path.join(dirs.base, e.name));
    }
  } catch { /* nothing to prune */ }
  try {
    const root = path.dirname(dirs.base);
    const runs = fs.readdirSync(root).filter((d) => d.startsWith('run-')).sort();
    for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) rmrf(path.join(root, old));
  } catch { /* nothing to prune */ }
}

/**
 * The execution record as it lands in the COMMITTED artifact. The first 400 bytes of the command's
 * real output are kept verbatim: a retrieval claim whose evidence nobody can read is an assertion,
 * and the whole deduction being closed here was a number nobody could check against its own arm.
 */
function execRecord(e) {
  if (!e) return null;
  return { ran: e.ran, argv: e.argv, exit: e.exit, exitOk: e.exitOk, retrieved: e.retrieved, why: e.why, output: String(e.output || '').slice(0, 400) };
}

/** The machine-readable result. A verdict with no SHA is a verdict about nothing. */
function writeArtifact(file, agg, meta = {}) {
  const artifact = {
    invariant: INVARIANT,
    verdict: agg.verdict,
    why: agg.why,
    sha: headSha(),
    at: new Date().toISOString(),
    host: meta.host || null,
    model: meta.model || null,
    // The alias asked for ("haiku") is not the model that answered. Record the id the session
    // actually reported, so a result can never be attributed to a model that never ran.
    modelResolved: (agg.runs || []).map((r) => r.treated?.modelUsed).find(Boolean) || null,
    mutant: meta.mutant || null,
    trap: meta.trap || TRAP.MEMORY_SEARCH,
    task: meta.task || null,
    n: agg.n,
    passes: agg.passes,
    fails: agg.fails,
    unknowns: agg.unknowns,
    controlTokenRuns: agg.controlTokenRuns,
    controlWorkedRuns: agg.controlWorkedRuns ?? null,
    treatedTokenRuns: agg.treatedTokenRuns ?? null,
    // THE EXECUTION GATE's own rates. The old artifact could report `treatedTokenRuns: 3` beside
    // three `subcommandCorrect: false` and call it PASS; these three numbers are what makes that
    // combination impossible to state without also stating that nothing worked.
    executionGate: {
      treatedSubcommandRuns: agg.treatedSubcommandRuns ?? null,
      treatedExecutedRuns: agg.treatedExecutedRuns ?? null,
      treatedRetrievedRuns: agg.treatedRetrievedRuns ?? null,
    },
    rate: agg.rate,
    threshold: '>=2/3',
    costUsd: meta.costUsd != null ? +meta.costUsd.toFixed(4) : null,
    wallSeconds: meta.wallMs != null ? +(meta.wallMs / 1000).toFixed(1) : null,
    premise: meta.flag ? { verified: meta.flag.ok, evidence: meta.flag.evidence } : null,
    record: meta.record ? {
      lessonId: meta.record.lesson?.id,
      key: meta.record.key,
      storeExit: meta.record.storeExit,
      readBackExit: meta.record.readBackExit,
      ok: meta.record.ok,
    } : null,
    promotion: meta.record ? {
      rule: 'ADR-G008 win twice',
      projectCount: meta.record.projectCount,
      sourceProjects: meta.record.sources?.map((source) => source.project) || [],
      promoted: meta.record.promoted === true,
    } : null,
    seed: meta.seed ? { key: meta.seed.key, storeExit: meta.seed.storeExit, ok: meta.seed.ok } : null,
    refresh: meta.refresh || null,
    runs: (agg.runs || []).map((r) => ({
      i: r.i,
      verdict: r.verdict,
      why: r.why,
      treated: { class: r.treated?.class, subcommandCorrect: r.treated?.subcommandCorrect, command: r.treated?.command, forcedCommand: r.treated?.forcedCommand || false, exec: execRecord(r.treated?.exec), lessonIndex: r.treated?.lessonIndex, firstToolIndex: r.treated?.firstToolIndex, lessonBeforeFirstToolCall: r.treated?.lessonBeforeFirstToolCall, model: r.treated?.modelUsed, transcript: r.treated?.transcript },
      control: { class: r.control?.class, subcommandCorrect: r.control?.subcommandCorrect, command: r.control?.command, exec: execRecord(r.control?.exec), lessonDelivered: r.control?.lessonDelivered, model: r.control?.modelUsed, transcript: r.control?.transcript },
    })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n');
  return artifact;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
