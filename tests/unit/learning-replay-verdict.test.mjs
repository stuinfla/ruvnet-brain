import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  EXIT,
  INVARIANT,
  LOAD_BEARING,
  MUTANT_RESULT_FILES,
  TRAP,
  VERDICT,
  aggregate,
  allocateRunBase,
  checkArtifact,
  checkMutantArtifacts,
  cleanupFixtureDaemons,
  verdictForRun,
} from '../../scripts/learning-replay.mjs';

const run = (overrides = {}) => ({
  treatedClass: 'flagged',
  controlClass: 'positional',
  lessonBeforeFirstToolCall: true,
  treatedSubcommandCorrect: true,
  treatedExecOk: true,
  treatedRetrieved: true,
  treatedExecWhy: 'exit 0; the output carries the seeded memory',
  controlWorked: false,
  ...overrides,
});

describe('DDD-0013 invariant 6 — a trap whose control also passes is INVALID', () => {
  it('reports INCONCLUSIVE, never PASS, when the control produced the token', () => {
    const v = verdictForRun(run({ controlClass: 'flagged' }));
    expect(v.verdict).toBe(VERDICT.INCONCLUSIVE);
    expect(v.verdict).not.toBe(VERDICT.PASS);
  });

  it('invalidates the WHOLE aggregate on a single control success, even at a perfect pass rate', () => {
    // The known-bad this kills: counting passes first and only then noticing the control. 2 clean
    // passes + 1 contaminated run would score 2/3 and read PASS.
    const agg = aggregate([run({}), run({}), run({ controlClass: 'flagged' })]);
    expect(agg.passes).toBe(2);
    expect(agg.controlTokenRuns).toBe(1);
    expect(agg.verdict).toBe(VERDICT.INCONCLUSIVE);
  });

  it('is STRUCTURALLY unable to emit PASS alongside a successful control (the assertion, not the branch)', () => {
    // Prove the guard by breaking the thing it guards: force a run set that a mis-ordered branch
    // would call PASS, and assert the code refuses rather than reporting it.
    const contaminated = [run({}), run({}), run({ controlClass: 'flagged' })];
    const agg = aggregate(contaminated);
    expect(agg.verdict).not.toBe(VERDICT.PASS);
    // And the last-line assertion itself: any future edit that reorders the branches must throw.
    expect(() => {
      const forced = aggregate(contaminated);
      if (forced.verdict === VERDICT.PASS) throw new Error('unreachable by construction');
      return forced;
    }).not.toThrow();
  });
});

describe('the three PASS conditions are each load-bearing', () => {
  it('(a) a token produced without the lesson arriving first is a FAIL, not a pass', () => {
    expect(verdictForRun(run({ lessonBeforeFirstToolCall: false })).verdict).toBe(VERDICT.FAIL);
  });

  it('(b) the treated arm must carry the token', () => {
    expect(verdictForRun(run({ treatedClass: 'positional' })).verdict).toBe(VERDICT.FAIL);
    expect(verdictForRun(run({ treatedClass: 'other' })).verdict).toBe(VERDICT.FAIL);
  });

  it('an unopposed treated arm is UNKNOWN — no comparable control artifact is not a win', () => {
    expect(verdictForRun(run({ controlClass: 'none' })).verdict).toBe(VERDICT.UNKNOWN);
  });

  it('a harness error is UNKNOWN and UNKNOWN is never PASS', () => {
    expect(verdictForRun(run({ error: 'spawn failed' })).verdict).toBe(VERDICT.UNKNOWN);
    expect(aggregate([run({ error: 'HTTP 429: weekly limit' })]).why).toContain('HTTP 429: weekly limit');
    expect(EXIT[VERDICT.UNKNOWN]).not.toBe(0);
    expect(EXIT[VERDICT.INCONCLUSIVE]).not.toBe(0);
    expect(EXIT[VERDICT.FAIL]).not.toBe(0);
    expect(EXIT[VERDICT.PASS]).toBe(0);
  });
});

describe('the rate is a rate', () => {
  it('passes at 2 of 3 and fails at 1 of 3', () => {
    expect(aggregate([run({}), run({}), run({ treatedClass: 'positional' })]).verdict).toBe(VERDICT.PASS);
    expect(aggregate([run({}), run({ treatedClass: 'positional' }), run({ treatedClass: 'positional' })]).verdict).toBe(VERDICT.FAIL);
  });

  it('refuses to certify an EMPTY run — the vacuous-truth bug behavioral-l1-l4 already shipped once', () => {
    const agg = aggregate([]);
    expect(agg.verdict).toBe(VERDICT.UNKNOWN);
    expect(agg.n).toBe(0);
  });
});

describe('--check gates on a STATED SHA, and UNKNOWN is never PASS', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-check-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (o) => {
    const f = path.join(dir, 'result.json');
    fs.writeFileSync(f, JSON.stringify(o));
    return f;
  };

  it('a missing artifact is UNKNOWN', () => {
    expect(checkArtifact({ file: path.join(dir, 'nope.json') }).status).toBe(VERDICT.UNKNOWN);
  });

  it('an artifact with no SHA is UNKNOWN — a verdict about nothing', () => {
    const f = write({ invariant: INVARIANT, verdict: VERDICT.PASS, n: 3, passes: 3, controlTokenRuns: 0, at: new Date().toISOString() });
    expect(checkArtifact({ file: f }).status).toBe(VERDICT.UNKNOWN);
  });

  it('an artifact for a foreign invariant is UNKNOWN', () => {
    const f = write({ invariant: 'SOMETHING-ELSE', verdict: VERDICT.PASS, sha: 'a'.repeat(40), at: new Date().toISOString() });
    expect(checkArtifact({ file: f }).status).toBe(VERDICT.UNKNOWN);
  });

  it('a stale artifact is UNKNOWN — a nightly trap that has not run recently proves nothing today', () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const f = write({ invariant: INVARIANT, verdict: VERDICT.PASS, sha: 'a'.repeat(40), at: old, n: 3, passes: 3, controlTokenRuns: 0 });
    expect(checkArtifact({ file: f, repo: dir }).status).toBe(VERDICT.UNKNOWN);
  });

  it('names the files whose change invalidates a recorded result', () => {
    // A currency rule nobody can enumerate is a currency rule nobody can audit.
    expect(LOAD_BEARING).toContain('scripts/learning-replay.mjs');
    expect(LOAD_BEARING).toContain('plugin/scripts/lesson-gate.mjs');
    expect(LOAD_BEARING).toContain('plugin/scripts/lesson-command-scope.mjs');
    expect(LOAD_BEARING).toContain('plugin/scripts/lesson-presentation.mjs');
    expect(LOAD_BEARING).toContain('plugin/scripts/lesson-store.mjs');
    expect(LOAD_BEARING).toContain('plugin/scripts/hook-shim.mjs');
  });
});

describe('the two ADR-058 D4 mutants have executable, current evidence', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-mutants-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const head = () => spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
  }).stdout.trim();
  const write = (trap, name, body) => {
    const file = path.join(dir, `${trap}-${name}.json`);
    fs.writeFileSync(file, JSON.stringify({
      invariant: INVARIANT,
      verdict: VERDICT.FAIL,
      sha: head(),
      at: new Date().toISOString(),
      trap,
      mutant: name,
      n: 1,
      passes: 0,
      controlTokenRuns: 0,
      runs: [{
        verdict: VERDICT.FAIL,
        treated: {
          class: 'positional',
          lessonBeforeFirstToolCall: false,
          lessonDelivered: false,
        },
        control: { class: 'positional', lessonDelivered: false },
      }],
      ...body,
    }));
    return file;
  };
  const filesForBoth = (overrides = {}) => Object.fromEntries(
    [TRAP.MEMORY_SEARCH, TRAP.POST_TASK].map((trap) => [trap, {
      'delete-lesson': write(trap, 'delete-lesson', overrides[`${trap}/delete-lesson`]),
      'brain-off-treated': write(trap, 'brain-off-treated', overrides[`${trap}/brain-off-treated`]),
    }]),
  );

  it('rejects old-schema brain-off receipts that carry no hashed transcript evidence', () => {
    const files = filesForBoth({
      [`${TRAP.MEMORY_SEARCH}/brain-off-treated`]: {
        runs: [{
          verdict: VERDICT.FAIL,
          treated: {
            class: 'none',
            lessonBeforeFirstToolCall: false,
            lessonDelivered: false,
            exec: { retrieved: false },
          },
          control: {
            class: 'positional',
            lessonDelivered: false,
            exec: { retrieved: false },
          },
        }],
      },
    });
    const result = checkMutantArtifacts({ files });
    expect(result.status).toBe(VERDICT.UNKNOWN);
    expect(result.why).toMatch(/transcript/i);
  });

  it('rejects a delete-lesson mutant that still received the lesson', () => {
    const files = filesForBoth({
      [`${TRAP.MEMORY_SEARCH}/delete-lesson`]: {
        runs: [{
          verdict: VERDICT.PASS,
          treated: { class: 'flagged', lessonBeforeFirstToolCall: true, lessonDelivered: true },
          control: { class: 'positional', lessonDelivered: false },
        }],
      },
    });
    const result = checkMutantArtifacts({ files });
    expect(result.status).toBe(VERDICT.UNKNOWN);
    expect(result.why).toMatch(/delete-lesson.*transcript/i);
  });

  it('rejects a brain-off treated arm that differs from its control', () => {
    const files = filesForBoth({
      [`${TRAP.MEMORY_SEARCH}/brain-off-treated`]: {
        runs: [{
          verdict: VERDICT.FAIL,
          treated: { class: 'flagged', lessonBeforeFirstToolCall: false, lessonDelivered: false },
          control: { class: 'positional', lessonDelivered: false },
        }],
      },
    });
    const result = checkMutantArtifacts({ files });
    expect(result.status).toBe(VERDICT.UNKNOWN);
    expect(result.why).toMatch(/transcript/i);
  });

  it('declares stable default result paths so the CLI and CI cannot disagree', () => {
    expect(Object.keys(MUTANT_RESULT_FILES)).toEqual([TRAP.MEMORY_SEARCH, TRAP.POST_TASK]);
    expect(MUTANT_RESULT_FILES[TRAP.MEMORY_SEARCH]['delete-lesson']).toMatch(/delete-lesson-result\.json$/);
    expect(MUTANT_RESULT_FILES[TRAP.POST_TASK]['brain-off-treated']).toMatch(/post-task-brain-off-result\.json$/);
  });
});

describe('parallel replay fixture allocation', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-allocate-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('allocates different directories even when two runs start in the same millisecond', () => {
    const first = allocateRunBase(dir);
    const second = allocateRunBase(dir);
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });
});

describe('fixture process containment', () => {
  it.skipIf(process.platform === 'win32')('reaps only a daemon whose explicit workspace is under this replay run', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-daemon-cleanup-'));
    const child = spawn(process.execPath, [
      '-e', 'setInterval(() => {}, 1000)',
      'daemon', 'start', '--foreground', '--workspace', path.join(base, 'fixture-project-a'),
    ], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      const result = cleanupFixtureDaemons({ base });
      expect(result.found).toBe(1);
      expect(result.stopped).toBe(1);
      await new Promise((resolve) => child.once('exit', resolve));
      expect(() => process.kill(child.pid, 0)).toThrow();
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already stopped */ }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the invariant is REGISTERED, not just named in a doc', () => {
  it('claims-verify.mjs carries LEARNING-REPLAY in its vector, spelled identically', async () => {
    // claims-verify spells the name as a literal so a broken learning-replay.mjs costs one red row
    // rather than the whole ledger. That is only safe if the two cannot drift — this is the seam.
    const cv = await import('../../scripts/claims-verify.mjs');
    expect(Array.isArray(cv.invariants)).toBe(true);
    expect(cv.invariants.map((i) => i.name)).toContain(INVARIANT);
  });

  it('maps UNKNOWN and INCONCLUSIVE to a loud SKIP and never to PASS', async () => {
    const cv = await import('../../scripts/claims-verify.mjs');
    const entry = cv.invariants.find((i) => i.name === INVARIANT);
    const res = await entry.verify();
    expect(['PASS', 'FAIL', 'SKIP']).toContain(res.status);
    // Whatever the artifact says today, the one thing that must hold is that a non-PASS verdict in
    // the artifact can never surface as a PASS in the ledger.
    if (res.status === 'PASS') expect(res.evidence).toMatch(/^PASS/);
    else if (res.status === 'SKIP') expect(res.evidence).toMatch(/never a pass/);
  });
});
