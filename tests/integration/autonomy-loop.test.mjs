// tests/integration/autonomy-loop.test.mjs — ADR-0011 Phase 1's Test Contract, exercised against
// the two artifacts it names: scripts/loop-checkpoint.mjs (the durable state) and
// plugin/scripts/ground-ruvnet.sh (the UserPromptSubmit hook that turns that state into directives
// the model actually reads). The contract text (ADR-0011, Phase 1):
//
//   "A seeded unattended loop (i) runs ≥3 iterations without asking a question, (ii) survives
//   `kill -9` and resumes from checkpoint without repeating completed steps, (iii) halts on
//   done-criteria, (iv) halts and asks when a fenced action is required, and (v) halts after two
//   no-progress iterations."
//
// This suite proves each clause as a real subprocess-level assertion, never a call into the
// exported functions directly — both artifacts are meant to be invoked as separate processes (a
// CLI killed and restarted; a shell hook fed prompt JSON on stdin), so testing anything less would
// not actually prove the contract holds across a process boundary. Every checkpoint CLI call passes
// an explicit --dir into a fresh mkdtemp'd project directory; the hook is invoked exactly as its own
// header specifies: prompt JSON on stdin, CLAUDE_PLUGIN_ROOT pointed at this repo's plugin/, and cwd
// set to that same temp project dir (never this repo).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CHECKPOINT_CLI = path.join(REPO_ROOT, 'scripts/loop-checkpoint.mjs');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'plugin/scripts/ground-ruvnet.sh');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');

let tmp;

beforeEach(() => {
  // A fresh temp project dir per test — never the repo itself, per the artifact's own contract
  // (the hook's cwd is meant to be the user's project, not ruvnet-brain).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-loop-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Every call is a genuinely separate `node` process — this is what makes the kill-9-resume test
// (ii) meaningful: the "fresh read" is not a second function call in the same process, it is a
// process with zero memory of anything that ran before it.
function runCheckpoint(args) {
  const r = spawnSync('node', [CHECKPOINT_CLI, ...args], { encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeCp({ iteration, next, doneCriteria = 'exit 1', blockers }) {
  const args = ['write', '--dir', tmp, '--iteration', String(iteration), '--done-criteria', doneCriteria, '--next', next];
  if (blockers !== undefined) args.push('--blockers', blockers);
  return runCheckpoint(args);
}

function checkCp() {
  return runCheckpoint(['check', '--dir', tmp]);
}

// Invoked exactly per the hook's own header: prompt JSON piped on stdin, CLAUDE_PLUGIN_ROOT set,
// cwd = the temp project dir (defaults to `tmp`, overridable for the resume test).
function runHook(prompt, { cwd = tmp, env = {} } = {}) {
  const r = spawnSync('bash', [HOOK_SCRIPT], {
    cwd,
    input: JSON.stringify({ prompt }),
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      RUVNET_AUTONOMOUS: '', // explicit default: only ON when a test opts in
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('(i) runs without asking — an autonomous prompt flips the hook into AUTONOMOUS MODE; a plain build prompt does not', () => {
  it('an autonomous prompt ("keep working autonomously... do not stop") emits AUTONOMOUS MODE with an explicit instruction not to ask the go/no-go', () => {
    const out = runHook('keep working autonomously until tests pass, do not stop');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/AUTONOMOUS MODE/);
    expect(out.stdout).toMatch(/NEVER halt to ask/);
    expect(out.stdout).toMatch(/do NOT ask "Want me to build it now\?" or any\s+go\/no-go/);
  });

  it('a non-autonomous build prompt ("implement the retry policy") does NOT emit AUTONOMOUS MODE', () => {
    const out = runHook('implement the retry policy');
    expect(out.status).toBe(0);
    expect(out.stdout).not.toMatch(/AUTONOMOUS MODE/);
  });
});

describe('(ii) kill -9 resume — a checkpoint survives a fresh process, and the hook injects it as a RESUME block', () => {
  it('a fresh `read` process (no shared memory with the writer) returns the exact next/iteration that was written', () => {
    const w = writeCp({ iteration: 2, next: 'step C' });
    expect(w.status).toBe(0);

    // This is a brand-new `node` invocation — the only thing connecting it to the write above is
    // the file on disk. That is the property "survives kill -9" actually requires.
    const r = runCheckpoint(['read', '--dir', tmp]);
    expect(r.status).toBe(0);
    const cp = JSON.parse(r.stdout);
    expect(cp.next).toBe('step C');
    expect(cp.iteration).toBe(2);
  });

  it('the hook, run with cwd = the checkpoint\'s temp dir on an autonomous prompt, injects a RESUME block containing the checkpoint (including "step C")', () => {
    writeCp({ iteration: 2, next: 'step C' });
    const out = runHook('keep working autonomously until tests pass, do not stop', { cwd: tmp });
    expect(out.stdout).toMatch(/RESUME/);
    expect(out.stdout).toMatch(/step C/);
    // The RESUME line explicitly says not to repeat completed work — the other half of clause (ii).
    expect(out.stdout).toMatch(/do not repeat done work/);
  });
});

describe('(iii) done halt — `check` exits 3 only when doneCriteria is a shell command that actually exits 0', () => {
  it('exits 3 (DONE) when --done-criteria is "exit 0"', () => {
    const w = writeCp({ iteration: 1, next: 'ship it', doneCriteria: 'exit 0' });
    expect(w.status).toBe(0);
    const c = checkCp();
    expect(c.status).toBe(3);
  });

  it('does not exit 3 when --done-criteria is "exit 1" (a real, failing command)', () => {
    const w = writeCp({ iteration: 1, next: 'ship it', doneCriteria: 'exit 1' });
    expect(w.status).toBe(0);
    const c = checkCp();
    expect(c.status).not.toBe(3);
  });
});

describe('(iv) fence — the AUTONOMOUS MODE block states the HARD FENCE, names publish / force-push / secrets, and instructs stop-and-name-the-click', () => {
  it('names the fenced actions and the required response when hit', () => {
    const out = runHook('keep working autonomously until tests pass, do not stop');
    expect(out.stdout).toMatch(/HARD FENCE/);
    expect(out.stdout).toMatch(/publish/i);
    expect(out.stdout).toMatch(/--force|force-push/i);
    expect(out.stdout).toMatch(/secrets/i);
    expect(out.stdout).toMatch(/stop, and name the exact click/i);
  });
});

describe('(v) two-strike no-progress — three writes with an unchanged `next` trip NO-PROGRESS; a changed `next` resets it', () => {
  it('noProgressCount reaches >=2 after three same-`next` writes, and `check` exits 4', () => {
    writeCp({ iteration: 1, next: 'same step', doneCriteria: 'exit 1' });
    writeCp({ iteration: 2, next: 'same step', doneCriteria: 'exit 1' });
    const w3 = writeCp({ iteration: 3, next: 'same step', doneCriteria: 'exit 1' });
    const cp3 = JSON.parse(w3.stdout);
    expect(cp3.noProgressCount).toBeGreaterThanOrEqual(2);

    const c = checkCp();
    expect(c.status).toBe(4);
  });

  it('a write with a DIFFERENT `next` resets noProgressCount to 0, and `check` goes back to 0 (given failing done-criteria)', () => {
    writeCp({ iteration: 1, next: 'same step', doneCriteria: 'exit 1' });
    writeCp({ iteration: 2, next: 'same step', doneCriteria: 'exit 1' });
    writeCp({ iteration: 3, next: 'same step', doneCriteria: 'exit 1' });
    expect(checkCp().status).toBe(4); // confirm it actually tripped, before proving the reset

    const w4 = writeCp({ iteration: 4, next: 'different step', doneCriteria: 'exit 1' });
    const cp4 = JSON.parse(w4.stdout);
    expect(cp4.noProgressCount).toBe(0);

    const c = checkCp();
    expect(c.status).toBe(0);
  });
});

describe('RUVNET_AUTONOMOUS=1 forces AUTONOMOUS MODE even on a prompt with no autonomy language', () => {
  it('a plain build prompt ("implement the retry policy") still emits AUTONOMOUS MODE when RUVNET_AUTONOMOUS=1', () => {
    const out = runHook('implement the retry policy', { env: { RUVNET_AUTONOMOUS: '1' } });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/AUTONOMOUS MODE/);
  });
});
