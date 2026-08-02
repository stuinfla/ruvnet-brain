import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as replay from '../../scripts/learning-replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

let dir;
beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, '.ruvnet-brain'), { recursive: true });
  dir = fs.mkdtempSync(path.join(ROOT, '.ruvnet-brain', 'proof-test-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exec = (worked) => ({
  ran: true,
  argv: ['ruflo', 'memory', 'search'],
  exit: worked ? 0 : 1,
  exitOk: worked,
  retrieved: worked,
  why: worked ? 'exit 0; seeded memory retrieved' : 'exit 1; required option missing',
  output: worked ? 'note-caching-stra... The caching strategy' : '[ERROR] Required option missing: --query',
});

function armRecord({ trap, treated, passing }) {
  const memory = trap === replay.TRAP.MEMORY_SEARCH;
  return treated ? {
    class: passing ? 'flagged' : (memory ? 'positional' : 'partial'),
    subcommandCorrect: true,
    command: passing
      ? (memory
        ? 'ruflo memory search -q "caching strategy" --path .swarm/memory.db'
        : 'ruflo hooks post-task --task "release retry-budget investigation" --agent tester --success --store-results')
      : (memory
        ? 'ruflo memory search "caching strategy" --path .swarm/memory.db'
        : 'ruflo hooks post-task --task-id release-retry-budget-investigation --success true'),
    forcedCommand: false,
    exec: exec(passing),
    lessonIndex: passing ? 0 : -1,
    firstToolIndex: passing ? 1 : 0,
    lessonBeforeFirstToolCall: passing,
    model: 'gpt-5.6-sol',
  } : {
    class: memory ? 'positional' : 'partial',
    subcommandCorrect: true,
    command: memory
      ? 'ruflo memory search "caching strategy" --path .swarm/memory.db'
      : 'ruflo hooks post-task --task-id release-retry-budget-investigation --success true',
    exec: exec(false),
    lessonDelivered: false,
    model: 'gpt-5.6-sol',
  };
}

function proofRef({ trap, run, arm, record, sourceSha = HEAD, mutant = null }) {
  const envelope = { schema: 2, sourceSha, trap, mutant, run, arm, record };
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  const hash = sha256(bytes);
  const file = path.join(dir, `${hash}.json`);
  fs.writeFileSync(file, bytes);
  return { path: path.relative(ROOT, file), sha256: hash, sourceSha, mutant };
}

function runRecord({ trap, passing = true, i = 1, error = null, mutant = null }) {
  const treatedRecord = armRecord({ trap, treated: true, passing });
  const controlRecord = armRecord({ trap, treated: false, passing: false });
  return {
    i,
    verdict: error ? replay.VERDICT.UNKNOWN : (passing ? replay.VERDICT.PASS : replay.VERDICT.FAIL),
    why: error
      ? `harness could not measure this run: ${error}`
      : (passing ? 'treated action executed and retrieved' : `treated arm produced "${treatedRecord.class}", not the token`),
    error,
    treated: { ...treatedRecord, transcript: proofRef({ trap, mutant, run: i, arm: 'treated', record: treatedRecord }) },
    control: { ...controlRecord, transcript: proofRef({ trap, mutant, run: i, arm: 'control', record: controlRecord }) },
  };
}

function artifact({ trap = replay.TRAP.MEMORY_SEARCH, passing = true, mutant = null, run = null, top = {} } = {}) {
  const row = run || runRecord({ trap, passing, mutant });
  const passes = passing ? 1 : 0;
  return {
    invariant: replay.INVARIANT,
    verdict: passing ? replay.VERDICT.PASS : replay.VERDICT.FAIL,
    why: passing ? '1/1 runs passed' : '0/1 runs passed',
    sha: HEAD,
    at: new Date().toISOString(),
    host: 'codex',
    model: 'gpt-5.6-sol',
    modelResolved: 'gpt-5.6-sol',
    mutant,
    trap,
    task: trap,
    taskHash: sha256(trap),
    n: 1,
    passes,
    fails: passing ? 0 : 1,
    unknowns: 0,
    controlTokenRuns: 0,
    controlWorkedRuns: 0,
    treatedTokenRuns: passes,
    executionGate: {
      treatedSubcommandRuns: 1,
      treatedExecutedRuns: passes,
      treatedRetrievedRuns: passes,
    },
    rate: passes,
    promotion: { projectCount: 2, sourceProjects: ['a', 'b'], promoted: true },
    record: { lessonId: `lesson-${trap}` },
    refresh: { lessonSurvived: true },
    runs: [row],
    ...top,
  };
}

function writeArtifact(value, name = `artifact-${Math.random()}.json`) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function mutantFiles(overrides = {}) {
  return Object.fromEntries([replay.TRAP.MEMORY_SEARCH, replay.TRAP.POST_TASK].map((trap) => [trap,
    Object.fromEntries(['delete-lesson', 'brain-off-treated'].map((mutant) => {
      const key = `${trap}/${mutant}`;
      const value = overrides[key] || artifact({ trap, passing: false, mutant });
      return [mutant, writeArtifact(value, `${trap}-${mutant}.json`)];
    })),
  ]));
}

describe('receipt verification recomputes evidence instead of trusting JSON claims', () => {
  it('writes a bounded content-addressed proof and omits the raw task', () => {
    const treated = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: true, passing: true });
    const control = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: false, passing: false });
    const result = replay.aggregate([{
      i: 1,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
      treatedSubcommandCorrect: treated.subcommandCorrect,
      treatedExecOk: treated.exec.exitOk,
      treatedRetrieved: treated.exec.retrieved,
      treatedExecWhy: treated.exec.why,
      controlWorked: false,
      error: null,
      treated,
      control,
    }]);
    const privateTask = 'PRIVATE fixture task that must never enter committed evidence';
    const file = path.join(dir, 'round-trip.json');
    const value = replay.writeArtifact(file, result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      task: privateTask,
      proofRoot: path.join(dir, 'proof'),
    });
    expect(value).not.toHaveProperty('task');
    expect(value.runs[0].treated.transcript.path).toContain(path.basename(dir));
    expect(fs.readFileSync(file, 'utf8')).not.toContain(privateTask);
    expect(replay.checkArtifact({ file, repo: ROOT }).status).toBe(replay.VERDICT.PASS);
  });

  it('redacts the host home directory before hashing published evidence', () => {
    const treated = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: true, passing: true });
    const control = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: false, passing: false });
    treated.command = `${os.homedir()}/.npm-global/bin/ruflo memory search -q "caching strategy"`;
    treated.exec.argv = [`${os.homedir()}/.npm-global/bin/ruflo`, 'memory', 'search'];
    treated.exec.output = `loaded from ${os.homedir()}/private-cache`;
    const result = replay.aggregate([{
      i: 1,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
      treatedSubcommandCorrect: treated.subcommandCorrect,
      treatedExecOk: treated.exec.exitOk,
      treatedRetrieved: treated.exec.retrieved,
      treatedExecWhy: treated.exec.why,
      controlWorked: false,
      error: null,
      treated,
      control,
    }]);
    const file = path.join(dir, 'redacted.json');
    const value = replay.writeArtifact(file, result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      proofRoot: path.join(dir, 'redacted-proof'),
    });
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).not.toContain(os.homedir());
    expect(bytes).toContain('$HOME/.npm-global/bin/ruflo');
    expect(value.runs[0].treated.exec.argv[0]).toBe('$HOME/.npm-global/bin/ruflo');
  });

  it('binds proof identity to the mutant, not only trap/run/arm', () => {
    const treated = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: true, passing: false });
    const control = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: false, passing: false });
    const result = replay.aggregate([{
      i: 1,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: false,
      treatedSubcommandCorrect: true,
      treatedExecOk: false,
      treatedRetrieved: false,
      treatedExecWhy: treated.exec.why,
      controlWorked: false,
      error: null,
      treated,
      control,
    }]);
    const proofRoot = path.join(dir, 'mutant-proofs');
    const deleted = replay.writeArtifact(path.join(dir, 'delete.json'), result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      mutant: 'delete-lesson',
      task: 'fixture',
      proofRoot,
    });
    const disabled = replay.writeArtifact(path.join(dir, 'brain-off.json'), result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      mutant: 'brain-off-treated',
      task: 'fixture',
      proofRoot,
    });
    expect(deleted.runs[0].treated.transcript.sha256)
      .not.toBe(disabled.runs[0].treated.transcript.sha256);
  });

  it('rejects a data-only edit that changes top-level counts without changing red runs', () => {
    const file = writeArtifact(artifact({ passing: false, top: { verdict: replay.VERDICT.PASS, passes: 1, fails: 0, rate: 1 } }));
    const checked = replay.checkArtifact({ file, repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.FAIL);
    expect(checked.why).toMatch(/recomputed|does not match/i);
  });

  it('rejects a receipt when a referenced transcript was deleted', () => {
    const value = artifact();
    fs.rmSync(path.join(ROOT, value.runs[0].treated.transcript.path));
    const checked = replay.checkArtifact({ file: writeArtifact(value), repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
    expect(checked.why).toMatch(/transcript/i);
  });

  it('rejects a receipt when a transcript hash is wrong', () => {
    const value = artifact();
    value.runs[0].treated.transcript.sha256 = '0'.repeat(64);
    const checked = replay.checkArtifact({ file: writeArtifact(value), repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
    expect(checked.why).toMatch(/hash/i);
  });

  it('rejects a receipt whose transcript names a different source SHA', () => {
    const value = artifact();
    value.runs[0].treated.transcript.sourceSha = 'f'.repeat(40);
    const checked = replay.checkArtifact({ file: writeArtifact(value), repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
    expect(checked.why).toMatch(/source/i);
  });

  it('rejects a run with a missing control arm', () => {
    const value = artifact();
    delete value.runs[0].control;
    expect(replay.checkArtifact({ file: writeArtifact(value), repo: ROOT }).status).not.toBe(replay.VERDICT.PASS);
  });

  it('recomputes a harness-error arm as UNKNOWN even if top-level JSON says PASS', () => {
    const value = artifact({ run: runRecord({ trap: replay.TRAP.MEMORY_SEARCH, error: 'spawn failed' }) });
    expect(replay.checkArtifact({ file: writeArtifact(value), repo: ROOT }).status).toBe(replay.VERDICT.UNKNOWN);
  });
});

describe('portfolio and mutant checks consume recomputed run evidence', () => {
  it('rejects a portfolio whose memory receipt claims PASS over a failing run', () => {
    const forgedPass = (trap, passing) => ({
      verdict: replay.VERDICT.PASS,
      why: '3/3 runs passed',
      n: 3,
      passes: 3,
      fails: 0,
      unknowns: 0,
      treatedTokenRuns: 3,
      controlTokenRuns: 0,
      controlWorkedRuns: 0,
      executionGate: {
        treatedSubcommandRuns: 3,
        treatedExecutedRuns: 3,
        treatedRetrievedRuns: 3,
      },
      rate: 1,
      runs: [1, 2, 3].map((i) => runRecord({ trap, passing, i })),
    });
    const memory = artifact({
      passing: false,
      top: forgedPass(replay.TRAP.MEMORY_SEARCH, false),
    });
    const post = artifact({
      trap: replay.TRAP.POST_TASK,
      top: forgedPass(replay.TRAP.POST_TASK, true),
    });
    const checked = replay.checkPortfolio({
      files: {
        [replay.TRAP.MEMORY_SEARCH]: writeArtifact(memory, 'memory.json'),
        [replay.TRAP.POST_TASK]: writeArtifact(post, 'post.json'),
      },
      mutantFiles: mutantFiles(),
      repo: ROOT,
    });
    expect(checked.status).toBe(replay.VERDICT.FAIL);
    expect(checked.why).toMatch(/memory-search-query/i);
  });

  it('rejects generic mutant failures whose arms never executed', () => {
    const generic = artifact({ passing: false, mutant: 'delete-lesson' });
    generic.runs[0].why = 'generic failure';
    generic.runs[0].treated.exec.ran = false;
    generic.runs[0].control.exec.ran = false;
    const checked = replay.checkMutantArtifacts({
      files: mutantFiles({ [`${replay.TRAP.MEMORY_SEARCH}/delete-lesson`]: generic }),
      repo: ROOT,
    });
    expect(checked.status).not.toBe(replay.VERDICT.PASS);
    expect(checked.why).toMatch(/execut|causal|expected/i);
  });

  it('rejects a mutant receipt containing an UNKNOWN run', () => {
    const unknown = artifact({ passing: false, mutant: 'brain-off-treated', top: { unknowns: 1, fails: 0 } });
    unknown.runs[0].verdict = replay.VERDICT.UNKNOWN;
    unknown.runs[0].error = 'executor unavailable';
    const checked = replay.checkMutantArtifacts({
      files: mutantFiles({ [`${replay.TRAP.MEMORY_SEARCH}/brain-off-treated`]: unknown }),
      repo: ROOT,
    });
    expect(checked.status).not.toBe(replay.VERDICT.PASS);
    expect(checked.why).toMatch(/unknown|measure/i);
  });
});

describe('archive retention is chronological and receipt-aware', () => {
  function runDir(name, createdAt) {
    const base = path.join(dir, name);
    fs.mkdirSync(path.join(base, 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(base, 'run-manifest.json'), JSON.stringify({ createdAt, sequence: Date.parse(createdAt) }));
    return base;
  }

  it('prunes the oldest manifest time, never the lexicographically smallest random name', () => {
    const old = runDir('run-z-old', '2026-01-01T00:00:00.000Z');
    const fresh = runDir('run-a-new', '2026-02-01T00:00:00.000Z');
    expect(replay.pruneArchive).toBeTypeOf('function');
    replay.pruneArchive({ base: fresh }, { keepRuns: 1 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('never deletes a run containing a transcript referenced by the accepted receipt', () => {
    const old = runDir('run-z-preserved', '2026-01-01T00:00:00.000Z');
    const transcript = path.join(old, 'transcripts', 'accepted.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const fresh = runDir('run-a-new', '2026-02-01T00:00:00.000Z');
    expect(replay.pruneArchive).toBeTypeOf('function');
    replay.pruneArchive({ base: fresh }, { keepRuns: 1, preservePaths: [transcript] });
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('learning replay source boundaries', () => {
  it('refuses a dirty load-bearing source identity before an expensive replay', () => {
    const repo = path.join(dir, 'identity-repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'gate.mjs'), 'export const gate = true;\n');
    spawnSync('git', ['add', 'gate.mjs'], { cwd: repo });
    spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'fixture'], { cwd: repo });
    expect(replay.checkSourceIdentity).toBeTypeOf('function');
    expect(replay.checkSourceIdentity({ repo, loadBearing: ['gate.mjs'] }).clean).toBe(true);
    fs.appendFileSync(path.join(repo, 'gate.mjs'), 'export const dirty = true;\n');
    const dirty = replay.checkSourceIdentity({ repo, loadBearing: ['gate.mjs'] });
    expect(dirty.clean).toBe(false);
    expect(dirty.why).toMatch(/dirty|uncommitted/i);
  });

  it('keeps every replay source module below 500 lines', () => {
    const files = fs.readdirSync(path.join(ROOT, 'scripts'))
      .filter((name) => /^learning-replay(?:-[a-z-]+)?\.mjs$/.test(name));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8').split('\n').length;
      expect(lines, `${file} must stay below 500 lines`).toBeLessThan(500);
    }
  });
});
