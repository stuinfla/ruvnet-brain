import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReplaySource } from '../helpers/learning-replay-source.mjs';

let ROOT, HEAD, replay, source;
beforeAll(async () => {
  source = createReplaySource();
  ROOT = source.repo;
  HEAD = source.sha;
  replay = await import(pathToFileURL(path.join(ROOT, 'scripts/learning-replay.mjs')).href);
});
afterAll(() => source?.cleanup());

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
      : (passing
        ? `treated "${treatedRecord.class}" vs control "${controlRecord.class}"; the produced command executed and returned the required outcome`
        : `treated arm produced "${treatedRecord.class}", not the token`),
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

// The workflow step runs under bash with a fake `npm`, so it is POSIX-only and listed for linux and macos only in
// scripts/release-qualification-contract.mjs; the portfolio exit-code contract itself stays in learning-replay-proof.test.mjs.
describe('the learning-replay workflow step', () => {
  const files = () => replay.PORTFOLIO_RESULT_FILES;
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/learning-replay.mjs'), '--check-portfolio', ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  // A trap the portfolio accepts on its merits (N=3, 3/3 recomputed passes), and all four causal mutants at their
  // real paths: tolerance re-checks every artifact (Codex 4.7.21 r4 #2), so a stale fixture must be otherwise valid.
  const passingTrap = (trap, top = {}) => artifact({ trap, top: {
    n: 3, passes: 3, fails: 0, treatedTokenRuns: 3, rate: 1,
    executionGate: { treatedSubcommandRuns: 3, treatedExecutedRuns: 3, treatedRetrievedRuns: 3 },
    runs: [1, 2, 3].map((i) => runRecord({ trap, i })),
    ...top,
  } });
  const mutantPaths = () => Object.entries(replay.MUTANT_RESULT_FILES)
    .flatMap(([trap, byName]) => Object.entries(byName).map(([mutant, file]) => [trap, mutant, file]));
  function place({ memory, post, mutants = true }) {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    for (const [trap, value] of [[replay.TRAP.MEMORY_SEARCH, memory], [replay.TRAP.POST_TASK, post]]) {
      if (value === null) fs.rmSync(files()[trap], { force: true });
      else fs.writeFileSync(files()[trap], `${JSON.stringify(value, null, 2)}\n`);
    }
    for (const [trap, mutant, file] of mutantPaths()) {
      if (!mutants) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, `${JSON.stringify(artifact({ trap, passing: false, mutant }), null, 2)}\n`);
    }
  }
  const failing = () => ({ memory: artifact({ passing: false }), post: artifact({ trap: replay.TRAP.POST_TASK }) });
  const stale = () => ({
    memory: passingTrap(replay.TRAP.MEMORY_SEARCH, { at: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
    post: passingTrap(replay.TRAP.POST_TASK),
  });
  afterEach(() => place({ memory: null, post: null, mutants: false }));

  describe('the portfolio step as the workflow runs it', () => {
    const YML = path.resolve(import.meta.dirname, '../../.github/workflows/learning-replay.yml');
    function stepScript() {
      const lines = fs.readFileSync(YML, 'utf8').split('\n');
      const start = lines.findIndex((l) => l.includes('- name: LEARNING-REPLAY-PORTFOLIO'));
      const run = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
      const indent = lines[run + 1].match(/^\s*/)[0].length;
      const body = [];
      for (let i = run + 1; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^\s*/)[0].length >= indent); i++) body.push(lines[i].slice(indent));
      return body.join('\n');
    }
    function step(strict) {
      const bin = fs.mkdtempSync(path.join(dir, 'bin-'));
      // `npm run --silent learning:replay:check -- [args]` → the real CLI in the fixture source.
      fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/bash\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$1" = "--" ] && shift\n`
        + `exec "${process.execPath}" "${path.join(ROOT, 'scripts/learning-replay.mjs')}" --check-portfolio "$@"\n`, { mode: 0o755 });
      const summary = path.join(bin, 'summary.md');
      const r = spawnSync('bash', ['-e', '-c', stepScript()], { cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STRICT: strict, GITHUB_STEP_SUMMARY: summary } });
      return { status: r.status, out: r.stdout };
    }

    it('the STRICT input defaults off and only a manual dispatch can turn it on', () => {
      expect(fs.readFileSync(YML, 'utf8')).toMatch(/STRICT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.strict_portfolio == true \}\}/);
    });

    it('schedule/push/dispatch: a recomputed FAIL is red', () => {
      place(failing());
      const r = step('false');
      expect(r.status).toBe(1);
      expect(r.out).toContain('::error title=LEARNING-REPLAY portfolio');
    });

    it('schedule/push/dispatch: out-of-date evidence is green and annotated; strict_portfolio makes it red', () => {
      place(stale());
      const soft = step('false');
      expect(soft.status).toBe(0);
      expect(soft.out).toContain('::warning title=LEARNING-REPLAY portfolio not current');
      expect(step('true').status).toBe(4);
    });

    it('a missing artifact is red even when not strict', () => {
      place({ memory: null, post: null });
      expect(step('false').status).toBe(4);
    });

    it('a stale trap does not hide a missing or failing artifact behind it: red even when not strict', () => {
      place({ ...stale(), post: null });
      const missing = step('false');
      expect(missing.status).toBe(4);
      expect(missing.out).not.toContain('::warning title=LEARNING-REPLAY portfolio not current');
      place({ ...stale(), post: artifact({ trap: replay.TRAP.POST_TASK, passing: false }) });
      expect(step('false').status).toBe(1);
      place({ ...stale(), mutants: false });
      expect(step('false').status).toBe(4);
    });
  });
});
