// tests/unit/learning-replay.test.mjs — the falsifiability proofs for the D4 counterfactual trap.
//
// The deduction this whole module closes is "L5 is explicitly unbuilt", and the trap that closes it
// is worth exactly as much as its INVALIDATION rule. DDD-0013 invariant 6:
//
//     A trap whose CONTROL run also produces the token is INVALID — INCONCLUSIVE, never a pass.
//
// So every test here is written to FAIL against the plausible broken version of the code it covers:
// an aggregate() that scores passes before checking the control, an oracle that greps for "-q"
// instead of parsing executable position, a `--check` that treats a missing or stale artifact as a
// pass. The three end-to-end mutants (delete-lesson, brain-off-treated, seed-control) are run
// against real model tokens by `node scripts/learning-replay.mjs --mutant <name>`; these are the
// cheap, deterministic half that runs on every CI push.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INVARIANT, VERDICT, EXIT, classifyCommand, subcommandCorrect, carriesToken,
  verdictForRun, aggregate, checkArtifact, LOAD_BEARING,
  assertRetrieved, executeProducedCommand, RETRIEVAL_EVIDENCE,
  PROJECT_B_MEMORY_KEY, PROJECT_B_MEMORY_VALUE, RUFLO_BIN, MUTANTS, WRONG_SUBCOMMAND_COMMAND,
  replayRunError, buildCodexArgv, parseCodexRunError, codexLessonBeforeTool,
  checkMutantArtifacts, MUTANT_RESULT_FILES, allocateRunBase,
  TRAP, classifyPostTaskCommand, postTaskSubcommandCorrect, verifyPostTaskContract,
  assertPostTaskPersisted,
  cleanupFixtureDaemons,
  buildFixtures, nightlyRefresh,
} from '../../scripts/learning-replay.mjs';
import { spawn, spawnSync } from 'node:child_process';

describe('CLI help is side-effect free', () => {
  it('--help prints usage, exits zero, and does not overwrite the replay artifact', () => {
    const artifact = path.resolve(import.meta.dirname, '../../data/learning-replay-result.json');
    const before = fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8') : null;
    const r = spawnSync(process.execPath, ['scripts/learning-replay.mjs', '--help'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8') : null).toBe(before);
  });
});

describe('executor failures remain visible in replay evidence', () => {
  it('preserves a subscription rate-limit result as the arm error', () => {
    const events = [{
      type: 'result',
      is_error: true,
      api_error_status: 429,
      terminal_reason: 'api_error',
      result: "You've hit your weekly limit",
    }];
    expect(replayRunError(events, {})).toContain("HTTP 429");
    expect(replayRunError(events, {})).toContain("weekly limit");
  });

  it('preserves a Codex turn failure instead of treating an empty artifact as model behavior', () => {
    const events = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'error', message: 'capacity exhausted' } },
      { type: 'turn.failed', error: { message: 'capacity exhausted' } },
    ];
    expect(parseCodexRunError(events, { status: 1 })).toContain('capacity exhausted');
  });

  it('does not mistake Codex advisory hook notices for a failed completed turn', () => {
    const events = [
      { type: 'item.completed', item: { type: 'error', message: 'hook trust bypass is enabled' } },
      { type: 'turn.started' },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ];
    expect(parseCodexRunError(events, { status: 0 })).toBeNull();
  });
});

describe('Codex subscription replay host', () => {
  it('installs the stable wrapper that routes fixture hooks into the isolated generation', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-codex-wrapper-'));
    try {
      const dirs = buildFixtures(base);
      const refresh = nightlyRefresh(dirs);
      expect(fs.existsSync(path.join(dirs.brainHome, 'codex-hook.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(
        dirs.brainHome, 'versions', refresh.generation, 'scripts', 'codex-hook-adapter.mjs',
      ))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('records and blocks a synthetic Codex command through the complete stable-wrapper path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-codex-hook-path-'));
    try {
      const dirs = buildFixtures(base);
      nightlyRefresh(dirs);
      const attempts = path.join(dirs.transcripts, 'preflight.attempts.jsonl');
      const sequence = path.join(dirs.transcripts, 'preflight.sequence.jsonl');
      const command = 'ruflo memory search -q "caching strategy" --path .swarm/memory.db';
      const result = spawnSync(process.execPath, [
        path.join(dirs.brainHome, 'codex-hook.mjs'), 'unprompted-speech', 'PreToolUse-bash',
      ], {
        cwd: dirs.projectB,
        encoding: 'utf8',
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'exec_command',
          tool_input: { cmd: command },
          cwd: dirs.projectB,
          session_id: 'd4-preflight',
        }),
        env: {
          ...process.env,
          RUVNET_BRAIN_HOME: dirs.brainHome,
          RUVNET_REPLAY_ATTEMPTS_FILE: attempts,
          RUVNET_REPLAY_SEQUENCE_FILE: sequence,
          RUVNET_REPLAY_RECORDER: path.join(
            path.resolve(import.meta.dirname, '../..'), 'scripts', 'ci', 'learning-replay-recorder.mjs',
          ),
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(JSON.parse(fs.readFileSync(attempts, 'utf8').trim()).command).toBe(command);
      expect(JSON.parse(fs.readFileSync(sequence, 'utf8').trim()).kind).toBe('tool');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('runs Codex read-only with the installed Brain plugin hooks trusted', () => {
    const args = buildCodexArgv({ model: 'gpt-5.6-sol', prompt: 'fixture prompt' });
    expect(args.slice(0, 2)).toEqual(['exec', '--ephemeral']);
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--json');
    expect(args).not.toContain('--ignore-user-config');
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args).toContain('shell_environment_policy.inherit="all"');
    expect(args).toContain('gpt-5.6-sol');
    expect(args.at(-1)).toBe('fixture prompt');
    expect(args.join(' ')).not.toMatch(/max-budget-usd|permission-mode|include-hook-events/);
  });

  it('proves lesson delivery happened before the first recorded tool attempt', () => {
    expect(codexLessonBeforeTool([
      { kind: 'lesson', atNs: '100' },
      { kind: 'tool', atNs: '200' },
    ])).toBe(true);
    expect(codexLessonBeforeTool([
      { kind: 'tool', atNs: '100' },
      { kind: 'lesson', atNs: '200' },
    ])).toBe(false);
    expect(codexLessonBeforeTool([{ kind: 'tool', atNs: '100' }])).toBe(false);
  });
});

// A PASSING run under the CURRENT oracle: the token, the real subcommand, a command that executed
// and retrieved, and the lesson before the first tool call. Every test below removes exactly one.
const run = (o) => ({
  treatedClass: 'flagged',
  controlClass: 'positional',
  lessonBeforeFirstToolCall: true,
  treatedSubcommandCorrect: true,
  treatedExecOk: true,
  treatedRetrieved: true,
  treatedExecWhy: 'exit 0; the output carries the seeded memory',
  controlWorked: false,
  ...o,
});

describe('the oracle is a PARSE, not a grep', () => {
  it('scores the token only when the query is actually delivered through -q/--query', () => {
    expect(classifyCommand('ruflo memory search -q "caching strategy"')).toBe('flagged');
    expect(classifyCommand('ruflo memory search --query "caching strategy"')).toBe('flagged');
    expect(classifyCommand('ruflo memory search --query=caching')).toBe('flagged');
  });

  it('calls the positional form what it is', () => {
    expect(classifyCommand('ruflo memory search "caching strategy"')).toBe('positional');
    expect(classifyCommand('ruflo memory search -n default "caching"')).toBe('positional');
  });

  it('does NOT score a mention of the command inside a quoted argument — a string that names a call is not a call', () => {
    // The known-bad: /-q/.test(cmd) scores every one of these. This is the #12 lesson generalized,
    // and it is the difference between measuring an artifact and measuring prose.
    expect(classifyCommand('echo "ruflo memory search -q hello"')).toBe('none');
    expect(classifyCommand('git commit -m "use ruflo memory search -q from now on"')).toBe('none');
    expect(classifyCommand('grep -r "ruflo memory search -q" .')).toBe('none');
  });

  it('reports a ruflo invocation that carries no query at all as neither form', () => {
    expect(classifyCommand('ruflo memory search')).toBe('other');
    expect(classifyCommand('ruflo recall --topic "caching strategy"')).toBe('other');
  });

  it('returns none when ruflo is never invoked as an executable', () => {
    expect(classifyCommand('which ruflo')).toBe('none');
    expect(classifyCommand('ls -la')).toBe('none');
    expect(classifyCommand('')).toBe('none');
  });

  it('sees through npx wrappers and absolute paths', () => {
    expect(classifyCommand('npx ruflo@latest memory search -q "x"')).toBe('flagged');
    expect(classifyCommand('/Users/x/.npm-global/bin/ruflo memory search -q "x"')).toBe('flagged');
    expect(classifyCommand('$HOME/.npm-global/bin/ruflo memory search "caching strategy"')).toBe('positional');
    expect(classifyCommand('$HOME/.npm-global/bin/ruflo memory search -q "x"')).toBe('flagged');
    expect(subcommandCorrect('$HOME/.npm-global/bin/ruflo memory search -q "x"')).toBe(true);
    expect(classifyCommand('echo "$HOME/.npm-global/bin/ruflo memory search -q x"')).toBe('none');
  });

  it('separates the TOKEN from the SUBCOMMAND — both are real, and both are now gated', () => {
    expect(subcommandCorrect('ruflo memory search -q "x"')).toBe(true);
    expect(subcommandCorrect('ruflo recall -q "x"')).toBe(false);
    // The token IS carried by the wrong-subcommand form — which is exactly why the token alone was
    // never sufficient, and why `ruflo recall -q` was certified as a PASS until 2026-07-28.
    expect(carriesToken(classifyCommand('ruflo recall -q "x"'))).toBe(true);
  });
});

function writePostTaskFixtureBinary(dir) {
  // A shebang-only executable cannot be launched by child_process on Windows. The production
  // helper runs injected .cjs fixtures through process.execPath while leaving the real Ruflo
  // binary path untouched, so this contract test exercises the same JavaScript fixture everywhere.
  const file = path.join(dir, 'ruflo-fixture.cjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--task Task description. Without this + --agent, no routing outcome is recorded.');
  console.log('--agent Agent that executed the task');
  console.log('--store-results Also persist the routing decision');
  process.exit(0);
}
const value = (short, long) => {
  const i = args.findIndex((arg) => arg === short || arg === long);
  return i >= 0 ? args[i + 1] : null;
};
const id = value('-i', '--task-id') || 'fixture-auto';
const task = value('-t', '--task');
const agent = value('-a', '--agent');
console.log('[INFO] Recording outcome for task: ' + id);
console.log('[OK] Task outcome recorded: SUCCESS');
if (task && agent) {
  const flow = path.join(process.cwd(), '.claude-flow');
  fs.mkdirSync(flow, { recursive: true });
  fs.writeFileSync(path.join(flow, 'routing-outcomes.json'), JSON.stringify({
    outcomes: [{ task, agent, success: true, quality: 0.85 }],
  }));
  if (args.includes('--store-results')) {
    const memory = path.join(flow, 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'store.json'), JSON.stringify({
      entries: {
        ['routing-decision:' + id]: {
          value: JSON.stringify({ task, agent, success: true, quality: 0.85 }),
        },
      },
    }));
  }
}
`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('the independent hooks post-task persistence trap', () => {
  it('scores the token only when task, agent, and store-results are all present', () => {
    const full = 'ruflo hooks post-task -i d4-one --success true --task "stabilize retry budget" --agent tester --store-results';
    expect(classifyPostTaskCommand(full)).toBe('flagged');
    expect(classifyPostTaskCommand('ruflo hooks post-task -i d4-one --success true')).toBe('partial');
    expect(classifyPostTaskCommand('ruflo hooks post-task --task "x" --agent tester')).toBe('partial');
    expect(classifyPostTaskCommand(`echo "${full}"`)).toBe('none');
  });

  it('requires the real hooks post-task command tree', () => {
    expect(postTaskSubcommandCorrect('ruflo hooks post-task -i d4-one --success true')).toBe(true);
    expect(postTaskSubcommandCorrect('ruflo hooks pre-task -i d4-one')).toBe(false);
  });

  it('verifies the three-part persistence contract through an injected CLI fixture', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-post-contract-'));
    try {
      const verified = verifyPostTaskContract(writePostTaskFixtureBinary(base));
      expect(verified.ok, verified.why).toBe(true);
      expect(verified.missingExit).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('executes the safe treated form and reads back both persistence layers', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-post-task-'));
    try {
      const fixture = writePostTaskFixtureBinary(base);
      const result = executeProducedCommand(
        'ruflo hooks post-task -i d4-post-live --success true --task "stabilize retry budget" --agent tester --store-results',
        { cwd: base, base, trap: TRAP.POST_TASK, ruflo: fixture },
      );
      expect(result.exit, result.output).toBe(0);
      expect(result.retrieved, result.why).toBe(true);
      expect(result.why).toMatch(/routing outcome.*routing-decision/i);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('MUTANT: stdout success without store-results is not persistence', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-post-task-no-store-'));
    try {
      const fixture = writePostTaskFixtureBinary(base);
      const result = executeProducedCommand(
        'ruflo hooks post-task -i d4-post-no-store --success true --task "stabilize retry budget" --agent tester',
        { cwd: base, base, trap: TRAP.POST_TASK, ruflo: fixture },
      );
      expect(result.exit, result.output).toBe(0);
      expect(result.retrieved).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('MUTANT: fabricated stdout cannot replace the persisted rows', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-post-task-fake-'));
    try {
      const evidence = assertPostTaskPersisted({
        args: ['hooks', 'post-task', '-i', 'd4-fake', '--success', 'true', '--task', 'stabilize retry budget', '--agent', 'tester', '--store-results'],
        output: '[OK] Task outcome recorded: SUCCESS',
        cwd: base,
      });
      expect(evidence.retrieved).toBe(false);
      expect(evidence.why).toMatch(/stores were not readable/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── THE EXECUTION GATE ──────────────────────────────────────────────────────────────────────────
// The grader's finding, verbatim: "PASS depends on token use, control contrast and lesson delivery —
// not successful command execution or successful retrieval." These tests fail against the oracle as
// it shipped on 2026-07-27.
describe('the execution gate — a command that would not work is not learned behavior', () => {
  it('MUTANT 1 — right flag, WRONG subcommand is FAIL, not PASS', () => {
    const v = verdictForRun(run({ treatedSubcommandCorrect: false }));
    expect(v.verdict).toBe(VERDICT.FAIL);
    expect(v.verdict).not.toBe(VERDICT.PASS);
    expect(v.why).toMatch(/WRONG SUBCOMMAND/);
  });

  it('MUTANT 2 — the command executed and exited 0 but RETRIEVED NOTHING is FAIL', () => {
    // Deliberately exitOk:true. `ruflo memory search -q "<absent>"` really does exit 0, so an
    // exit-status gate passes this run. Only the retrieval assertion catches it.
    const v = verdictForRun(run({ treatedExecOk: true, treatedRetrieved: false }));
    expect(v.verdict).toBe(VERDICT.FAIL);
    expect(v.why).toMatch(/RETRIEVED NOTHING/);
  });

  it('a command that never executed at all is FAIL', () => {
    expect(verdictForRun(run({ treatedExecOk: false })).verdict).toBe(VERDICT.FAIL);
  });

  it('MUTANT 3 — a CONTROL arm whose command WORKED is INCONCLUSIVE even without the token', () => {
    const v = verdictForRun(run({ controlClass: 'positional', controlWorked: true }));
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.verdict).not.toBe(VERDICT.PASS);
  });

  it('`subcommandCorrect: false` is STRUCTURALLY unable to coexist with a PASS verdict', () => {
    // Prove the guard by breaking the thing it guards: hand aggregate() a run set that the
    // 2026-07-27 oracle scored 3/3 PASS — three treated arms carrying the token on `ruflo recall`.
    const asShipped = [
      run({ treatedSubcommandCorrect: false, treatedExecOk: false, treatedRetrieved: false }),
      run({ treatedSubcommandCorrect: false, treatedExecOk: false, treatedRetrieved: false }),
      run({ treatedSubcommandCorrect: false, treatedExecOk: false, treatedRetrieved: false }),
    ];
    const agg = aggregate(asShipped);
    expect(agg.passes).toBe(0);
    expect(agg.verdict).toBe(VERDICT.FAIL);
    expect(agg.treatedTokenRuns).toBe(3);        // the token WAS carried, and is still reported
    expect(agg.treatedSubcommandRuns).toBe(0);   // …and nothing worked, which is now impossible to omit
    expect(agg.treatedRetrievedRuns).toBe(0);
  });

  it('every PASS aggregate can emit carries working execution evidence — the property the tripwire guards', () => {
    // aggregate() recomputes every per-run verdict, so a PASS beside red evidence cannot be
    // constructed from outside; the throw in aggregate() is a tripwire on a future edit of
    // verdictForRun, and this is the property it protects, checked over what aggregate can emit.
    const clean = aggregate([run({}), run({}), run({})]);
    expect(clean.verdict).toBe(VERDICT.PASS);
    const passes = clean.runs.filter((x) => x.verdict === VERDICT.PASS);
    expect(passes.length).toBe(3);
    for (const r of passes) {
      expect(r.treatedSubcommandCorrect).toBe(true);
      expect(r.treatedExecOk).toBe(true);
      expect(r.treatedRetrieved).toBe(true);
    }
    // …and one broken arm in the set costs that run its pass, at every mixed ratio.
    expect(aggregate([run({}), run({}), run({ treatedRetrieved: false })]).passes).toBe(2);
    expect(aggregate([run({}), run({ treatedRetrieved: false }), run({ treatedRetrieved: false })]).verdict).toBe(VERDICT.FAIL);
  });

  it('names both new mutants so the gate is reproducible, not just asserted', () => {
    expect(Object.keys(MUTANTS)).toContain('wrong-subcommand');
    expect(Object.keys(MUTANTS)).toContain('empty-store');
    expect(subcommandCorrect(WRONG_SUBCOMMAND_COMMAND)).toBe(false);
    expect(carriesToken(classifyCommand(WRONG_SUBCOMMAND_COMMAND))).toBe(true);
  });
});

describe('assertRetrieved reads RETURNED CONTENT, never exit status', () => {
  it('accepts the real `memory search` hit, truncation and all', () => {
    // The real table row, copied from live output on 2026-07-28.
    const real = '[INFO] Searching: "caching strategy" (semantic)\n'
      + '| note-caching-stra... |  0.79 | default   | The caching strategy for this pr... |\n'
      + '[INFO] Found 1 results';
    expect(assertRetrieved(real).retrieved).toBe(true);
  });

  it('rejects every failure shape the live CLI actually emits — including the two that EXIT 0', () => {
    // measured 2026-07-28, real global binary:
    expect(assertRetrieved('[INFO] Searching: "x" (semantic)\n[WARN] No results found').retrieved).toBe(false); // exit 0
    expect(assertRetrieved('\nMemory Management Commands\n\nUsage: claude-flow memory <subcommand> [options]\n').retrieved).toBe(false); // exit 0
    expect(assertRetrieved('[ERROR] Unknown command: recall').retrieved).toBe(false); // exit 1
    expect(assertRetrieved('[ERROR] Required option missing: --query').retrieved).toBe(false); // exit 1
  });

  it('treats silence as absence — an empty output is not a retrieval', () => {
    expect(assertRetrieved('').retrieved).toBe(false);
    expect(assertRetrieved(undefined).retrieved).toBe(false);
  });

  it('derives its positive markers from the seed, so the two cannot drift', () => {
    expect(PROJECT_B_MEMORY_KEY.startsWith(RETRIEVAL_EVIDENCE.positive[0])).toBe(true);
    expect(PROJECT_B_MEMORY_VALUE.startsWith(RETRIEVAL_EVIDENCE.positive[1])).toBe(true);
  });
});

describe('executeProducedCommand bounds its own blast radius', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-exec-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('does not execute a command with no ruflo invocation', () => {
    const e = executeProducedCommand('ls -la', { cwd: dir, base: dir });
    expect(e.ran).toBe(false);
    expect(e.retrieved).toBe(false);
  });

  it('REFUSES a store path outside the fixture world, and refusal is never a retrieval', () => {
    const e = executeProducedCommand('ruflo memory search -q "x" --path /Users/someone/real/.swarm/memory.db', { cwd: dir, base: dir });
    expect(e.ran).toBe(false);
    expect(e.retrieved).toBe(false);
    expect(e.why).toMatch(/outside the fixture world/);
  });

  it('REFUSES a mutating subcommand — a write does not prove a read', () => {
    for (const cmd of ['ruflo memory purge -n default', 'ruflo memory delete -k x', 'ruflo memory store -k x --value y']) {
      const e = executeProducedCommand(cmd, { cwd: dir, base: dir });
      expect(e.ran).toBe(false);
      expect(e.retrieved).toBe(false);
    }
  });

  it('does not let shell metacharacters reach a shell — the argv is the parsed one', () => {
    // If this ever ran through a shell, the `; touch` would land a file. It must not.
    const canary = path.join(dir, 'CANARY');
    executeProducedCommand(`ruflo memory search -q "x" ; touch ${JSON.stringify(canary)}`, { cwd: dir, base: dir });
    expect(fs.existsSync(canary)).toBe(false);
  });

  it('refuses the observed discovery-prefix compound instead of executing its first --help call', () => {
    const fixture = path.join(dir, 'ruflo-fixture.cjs');
    fs.writeFileSync(fixture, 'process.stdout.write("fixture should not execute")');
    const observed = 'ruflo memory search --help && ruflo memory search -q "caching strategy" --path .swarm/memory.db';
    const result = executeProducedCommand(observed, { cwd: dir, base: dir, ruflo: fixture });
    expect(result.ran).toBe(false);
    expect(result.retrieved).toBe(false);
    expect(result.why).toMatch(/first and only Ruflo invocation/i);
  });
});

// The one test in this file that spends real seconds against the real CLI. It is here because the
// entire execution gate rests on the claim that `ruflo memory recall -q` EXITS 0 — a claim that is
// worthless if recalled rather than checked, and that silently rots if rUv changes the CLI.
describe('the live CLI still behaves the way the gate assumes (Rule 0, re-checked every run)', () => {
  const haveRuflo = fs.existsSync(RUFLO_BIN);

  /**
   * PRECONDITION: the live CLI must be able to round-trip a memory at all.
   *
   * Measured 2026-08-12 against global ruflo v3.38.0 (it worked on 3.34.0, last successful row
   * 2026-08-10 16:59): `memory store` prints a full receipt table, an entry id, and
   * "[OK] Data stored successfully" — then `memory retrieve -k <that key>` reports "Key not found"
   * and direct SQL shows no row. Reproduced on BOTH the project and global stores, with the daemon
   * running AND stopped, and no .db file modified anywhere in the following 60s.
   *
   * That is an UPSTREAM break, not a defect in this gate's logic — so failing here every run would
   * teach people that red is normal, which is the erosion this repo has already paid for. It is also
   * not something to silence: a skip nobody can see reads as a pass.
   *
   * So the block is skipped ONLY when the round-trip is genuinely broken, and it says so loudly on
   * stderr with the version. The moment ruflo can store-and-retrieve again, these cases run again on
   * their own — no code change, no one to remember.
   */
  const roundTrips = (() => {
    if (!haveRuflo) return false;
    let probe;
    try {
      probe = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-probe-'));
      const pdb = path.join(probe, '.swarm', 'memory.db');
      fs.mkdirSync(path.join(probe, '.swarm'), { recursive: true });
      spawnSync(RUFLO_BIN, ['memory', 'init', '--path', pdb, '--backend', 'hybrid'], { encoding: 'utf8', timeout: 120_000, cwd: probe });
      const key = `precheck-${process.pid}-${Math.random().toString(16).slice(2)}`;
      spawnSync(RUFLO_BIN, ['memory', 'store', '-k', key, '--value', 'precheck', '-n', 'default', '--path', pdb], { encoding: 'utf8', timeout: 120_000, cwd: probe });
      const got = spawnSync(RUFLO_BIN, ['memory', 'retrieve', '-k', key, '--path', pdb], { encoding: 'utf8', timeout: 120_000, cwd: probe });
      return !/Key not found/i.test(`${got.stdout || ''}${got.stderr || ''}`);
    } catch { return false; }
    finally { try { if (probe) fs.rmSync(probe, { recursive: true, force: true }); } catch { /* best effort */ } }
  })();

  if (haveRuflo && !roundTrips) {
    const v = spawnSync(RUFLO_BIN, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    process.stderr.write(
      `\n  ⚠ LIVE-CLI PRECONDITION FAILED — skipping the live gate cases.\n`
      + `    \`ruflo memory store\` reports success and \`memory retrieve -k\` cannot find the key.\n`
      + `    ruflo ${String(v.stdout || v.stderr || '?').trim().split('\n')[0]}. This is upstream of this repo.\n`
      + `    These cases resume automatically once a store/retrieve round-trip works again.\n\n`,
    );
  }
  const t = (haveRuflo && roundTrips) ? it : it.skip;
  let dir, db;
  beforeEach(() => {
    if (!haveRuflo) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-live-'));
    fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
    db = path.join(dir, '.swarm', 'memory.db');
    spawnSync(RUFLO_BIN, ['memory', 'init', '--path', db, '--backend', 'hybrid'], { encoding: 'utf8', timeout: 120_000, cwd: dir });
    spawnSync(RUFLO_BIN, ['memory', 'store', '-k', PROJECT_B_MEMORY_KEY, '--value', PROJECT_B_MEMORY_VALUE, '-n', 'default', '--path', db], { encoding: 'utf8', timeout: 120_000, cwd: dir });
  });
  afterEach(() => {
    if (dir) {
      // `memory init/store` may auto-start a workspace daemon. Stop it while the workspace still
      // exists; deleting the directory first orphaned one daemon per live test invocation.
      spawnSync(RUFLO_BIN, ['daemon', 'stop', '--quiet'], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
      });
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  t('the CORRECT command retrieves', () => {
    const e = executeProducedCommand('ruflo memory search -q "caching strategy" --path .swarm/memory.db', { cwd: dir, base: dir });
    expect(e.ran).toBe(true);
    expect(e.exit).toBe(0);
    expect(e.retrieved).toBe(true);
  }, 180_000);

  t('`ruflo memory recall -q` EXITS 0 and retrieves NOTHING — the exact defect exit status cannot see', () => {
    const e = executeProducedCommand('ruflo memory recall -q "caching strategy" --path .swarm/memory.db', { cwd: dir, base: dir });
    expect(e.ran).toBe(true);
    expect(e.exit).toBe(0);          // <- an exit-status gate passes this
    expect(e.retrieved).toBe(false); // <- the retrieval assertion does not
  }, 180_000);

  t('MUTANT 2 live — a perfect command against an EMPTY store exits 0 and retrieves nothing', () => {
    // Remove the whole closed fixture store, including WAL/SHM sidecars. Deleting only memory.db
    // lets Ruflo replay the seeded row from memory.db-wal into the "empty" replacement.
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(db), { recursive: true });
    spawnSync(RUFLO_BIN, ['memory', 'init', '--path', db, '--backend', 'hybrid'], { encoding: 'utf8', timeout: 120_000, cwd: dir });
    const e = executeProducedCommand('ruflo memory search -q "caching strategy" --path .swarm/memory.db', { cwd: dir, base: dir });
    expect(e.exit).toBe(0);
    expect(e.retrieved).toBe(false);
  }, 180_000);
});
