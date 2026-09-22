// tests/unit/release-vector.test.mjs — the release gate must be UNGAMEABLE, not merely correct.
//
// THE DEFECT THIS DESCENDS FROM (2026-07-27, same commit, both derived from real checks):
//   README.md   "L1–L4 behavioral harness — all pass"
//   graders     18/100 on a stranger's machine
// Neither statement was a lie. A composite absorbed the 18. Averaging is the mechanism by which a
// product's worst property becomes invisible while every individual check stays honest — so the
// tests below do not check that the current numbers are good. They check that the SHAPE of the
// aggregation cannot hide a bad one, whatever the numbers are next month.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as RV from '../../scripts/release-vector.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');

const inv = (name, state) => ({ name, dimension: 'Dx', state, why: 'fixture' });

function copiedFixture(relativeFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-vector-fixture-'));
  for (const relative of relativeFiles) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO, relative), target);
  }
  return root;
}

function d3FixtureRunner(root) {
  return () => {
    const source = fs.readFileSync(path.join(root, 'plugin/scripts/session-start-core.mjs'), 'utf8');
    return source.includes('surfaceSignals({ env, cwd, stateDir, hookDir, emit, now });')
      ? { state: 'PASS', why: 'isolated lifecycle fixture passes' }
      : { state: 'FAIL', why: 'isolated lifecycle fixture has no red-to-surface consumer' };
  };
}

describe('the verdict is the vector MINIMUM — a bad cell can never be averaged away', () => {
  it('one FAIL among seven PASS yields FAIL, not 87%', () => {
    const v = RV.verdictOf([...Array(7).fill(inv('ok', 'PASS')), inv('bad', 'FAIL')]);
    expect(v).toBe('FAIL');
  });

  it('one UNKNOWN among seven PASS yields UNKNOWN — silence is not consent', () => {
    // `behavioral-l1-l4.mjs --levels L5` selected zero checks and printed OVERALL: PASS, exit 0.
    // A run that measured nothing certified itself. UNKNOWN must sink the verdict for that reason.
    expect(RV.verdictOf([...Array(7).fill(inv('ok', 'PASS')), inv('dunno', 'UNKNOWN')])).toBe('UNKNOWN');
  });

  it('FAIL outranks UNKNOWN downward — the worst cell wins, in both orders', () => {
    expect(RV.verdictOf([inv('a', 'UNKNOWN'), inv('b', 'FAIL')])).toBe('FAIL');
    expect(RV.verdictOf([inv('a', 'FAIL'), inv('b', 'UNKNOWN')])).toBe('FAIL');
  });

  it('an EMPTY vector is UNKNOWN, never PASS — measuring nothing is not a pass', () => {
    expect(RV.verdictOf([])).toBe('UNKNOWN');
  });

  it('all-PASS is the ONLY way to reach PASS', () => {
    expect(RV.verdictOf(Array(8).fill(inv('ok', 'PASS')))).toBe('PASS');
    for (const bad of ['FAIL', 'UNKNOWN']) {
      expect(RV.verdictOf([...Array(7).fill(inv('ok', 'PASS')), inv('x', bad)])).not.toBe('PASS');
    }
  });
});

describe('no averaging operation EXISTS on this aggregate — by construction, not by convention', () => {
  it('the module exposes no mean/average/score/percent/composite function', () => {
    // DDD-0013 invariant 2 is a statement about the CODE, not about our intentions. If someone adds
    // `export function score()` later, this test makes them read why it was forbidden.
    const forbidden = /^(average|mean|score|percent|percentage|composite|overall|aggregate|total)$/i;
    const offenders = Object.keys(RV).filter((k) => forbidden.test(k));
    expect(offenders, `averaging surface(s) appeared on the release vector: ${offenders.join(', ')}`).toEqual([]);
  });

  it('and the source contains no arithmetic mean over the results', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/release-vector.mjs'), 'utf8');
    const live = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(live).not.toMatch(/\.length\s*\)?\s*\*\s*100/);   // n/total * 100
    expect(live).not.toMatch(/reduce\([^)]*\+\s*\w+\s*[,)]/); // summing states
  });
});

describe('every invariant carries a real incident and a real detector', () => {
  it('eight invariants, one per dimension D1–D8, no duplicates', () => {
    expect(RV.INVARIANTS).toHaveLength(8);
    const dims = RV.INVARIANTS.map((i) => i.dimension).sort();
    expect(dims).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']);
  });

  it('each names a dated failure — a detector with no incident behind it is a checkbox', () => {
    for (const i of RV.INVARIANTS) {
      expect(i.incident, `${i.name} has no incident`).toBeTruthy();
      expect(i.incident.length, `${i.name}'s incident is too thin to be real`).toBeGreaterThan(40);
      expect(typeof i.detect).toBe('function');
    }
  });
});

describe('release-vector runners cross the Windows command-shim boundary', () => {
  it('D3 executes the available npx.cmd shim instead of returning UNKNOWN', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-release-vector-win32-'));
    const shim = path.join(dir, 'npx.cmd');
    const actualPlatform = process.platform;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const previousPath = process.env.PATH;
    const previousComSpec = process.env.ComSpec;
    try {
      fs.writeFileSync(
        shim,
        actualPlatform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
      );
      if (actualPlatform !== 'win32') {
        fs.chmodSync(shim, 0o755);
        const commandInterpreter = path.join(dir, 'cmd.exe');
        fs.writeFileSync(commandInterpreter, [
          '#!/bin/sh',
          '[ "$1" = /d ] && [ "$2" = /c ] && [ "$3" = npx.cmd ]',
          '',
        ].join('\n'));
        fs.chmodSync(commandInterpreter, 0o755);
        process.env.ComSpec = commandInterpreter;
      }
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      process.env.PATH = dir;

      const d3 = RV.INVARIANTS.find((i) => i.name === 'CONTINUITY-PLANE-FIRES');
      expect(await d3.detect()).toMatchObject({ state: 'PASS' });
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previousComSpec;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('one evaluated vector supplies both CLI formats and exit behavior', () => {
  const resultFor = (verdict, { dirty = false } = {}) => ({
    sha: 'a'.repeat(40),
    lineage: { sha: 'a'.repeat(40), tree: 'b'.repeat(40), dirty },
    results: [
      { name: 'GOOD', dimension: 'D1', state: 'PASS', why: 'fixture pass', sha: 'a'.repeat(40), elapsedMs: 3 },
      { name: 'BLOCKED', dimension: 'D4', state: verdict, why: 'fixture evidence', sha: 'a'.repeat(40), elapsedMs: 7 },
    ],
    verdict: dirty ? 'FAIL' : verdict,
  });

  it('renders text and JSON from the same result without another detector call', () => {
    const result = resultFor('UNKNOWN');
    const text = RV.formatVectorOutput(result);
    expect(text).toMatch(/UNKNOWN\s+D4\s+BLOCKED/);
    expect(text).toContain('(7ms) fixture evidence');
    expect(text).toContain('release metadata must read DEGRADED');
    for (const banned of RV.BANNED_WHEN_DEGRADED) expect(text).toContain(banned);

    const json = JSON.parse(RV.formatVectorOutput(result, { json: true }));
    expect(json).toEqual(result);
    expect(json.results.map(({ elapsedMs }) => elapsedMs)).toEqual([3, 7]);

    const failedText = RV.formatVectorOutput(resultFor('FAIL'));
    expect(failedText).toContain('FAIL');
    expect(failedText).toContain('release metadata must read DEGRADED');
  });

  it('only PASS exits zero; FAIL, UNKNOWN, and dirty lineage remain blocking', () => {
    expect(RV.exitCodeForVerdict('PASS')).toBe(0);
    expect(RV.exitCodeForVerdict('FAIL')).toBe(1);
    expect(RV.exitCodeForVerdict('UNKNOWN')).toBe(1);
    const dirty = resultFor('PASS', { dirty: true });
    expect(RV.verdictWithLineage(dirty.results, dirty.lineage)).toBe('FAIL');
    expect(RV.exitCodeForVerdict(dirty.verdict)).toBe(1);
    expect(RV.formatVectorOutput(dirty)).toContain('DIRTY (release-blocking)');
  });

  it('does not print the degraded ban list for a clean PASS result', () => {
    const text = RV.formatVectorOutput(resultFor('PASS'));
    expect(text).toContain('verdict: PASS');
    expect(text).not.toContain('release metadata must read DEGRADED');
  });

  it('emits ordered per-invariant start and completion timing callbacks', async () => {
    const events = [];
    const measured = await RV.evaluate([
      { name: 'FIRST', dimension: 'D1', detect: () => ({ state: 'PASS', why: 'first' }) },
      { name: 'SECOND', dimension: 'D2', detect: () => ({ state: 'UNKNOWN', why: 'second' }) },
    ], {}, {
      onInvariantStart: ({ name }) => events.push({ phase: 'start', name }),
      onInvariantComplete: ({ name, elapsedMs }) => events.push({ phase: 'complete', name, elapsedMs }),
    });
    expect(events.map(({ phase, name }) => [phase, name])).toEqual([
      ['start', 'FIRST'], ['complete', 'FIRST'], ['start', 'SECOND'], ['complete', 'SECOND'],
    ]);
    expect(events.filter(({ phase }) => phase === 'complete').every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
    expect(measured.results.map(({ elapsedMs }) => elapsedMs)).toHaveLength(2);
  });
});

describe('KNOWN-BAD MUTANTS — the gate proven to go red on real breakage', () => {
  it('isolates simultaneous D3 mutants and preserves tracked source bytes', async () => {
    const tracked = [
      'plugin/hooks/hooks.json',
      'plugin/scripts/session-start-core.mjs',
    ];
    const before = Object.fromEntries(tracked.map((relative) => [
      relative,
      fs.readFileSync(path.join(REPO, relative)),
    ]));
    const registrationRoot = copiedFixture([
      'plugin/scripts/session-start-core.mjs',
      ...tracked,
    ]);
    const consumerRoot = copiedFixture([
      'plugin/scripts/session-start-core.mjs',
      ...tracked,
    ]);
    try {
      const hooks = path.join(registrationRoot, 'plugin/hooks/hooks.json');
      fs.writeFileSync(hooks, fs.readFileSync(hooks, 'utf8')
        .replaceAll('session-start', 'session-start-DISABLED-BY-MUTANT'));
      const consumer = path.join(consumerRoot, 'plugin/scripts/session-start-core.mjs');
      fs.writeFileSync(consumer, fs.readFileSync(consumer, 'utf8')
        .replace(
          'surfaceSignals({ env, cwd, stateDir, hookDir, emit, now });',
          'void 0; // MUTANT: signal consumer deleted',
        ));
      const d3 = RV.INVARIANTS.find((item) => item.name === 'CONTINUITY-PLANE-FIRES');
      const [registration, missingConsumer] = await Promise.all([
        d3.detect({ root: registrationRoot, runCommand: d3FixtureRunner(registrationRoot) }),
        d3.detect({ root: consumerRoot, runCommand: d3FixtureRunner(consumerRoot) }),
      ]);
      expect(registration).toMatchObject({ state: 'FAIL' });
      expect(missingConsumer).toMatchObject({ state: 'FAIL' });
      expect(registration.why).toMatch(/not registered/i);
      expect(missingConsumer.why).toMatch(/behavior|lifecycle|surface/i);
      for (const relative of tracked) {
        expect(fs.readFileSync(path.join(REPO, relative))).toEqual(before[relative]);
      }
    } finally {
      fs.rmSync(registrationRoot, { recursive: true, force: true });
      fs.rmSync(consumerRoot, { recursive: true, force: true });
    }
  });

  it('MUTANT: unregister SessionStart from the shipped hooks.json → D3 goes FAIL', async () => {
    // The F5 class: a capability that exists on disk and is never registered will never fire.
    // The detector must read the REGISTRATION, so this mutant edits the registration, not the file.
    const real = RV.INVARIANTS.find((i) => i.name === 'CONTINUITY-PLANE-FIRES');
    const root = copiedFixture([
      'plugin/scripts/session-start-core.mjs',
      'plugin/hooks/hooks.json',
      'plugin/scripts/session-start-core.mjs',
    ]);
    const options = { root, runCommand: d3FixtureRunner(root) };
    try {
      expect((await real.detect(options)).state).toBe('PASS');
      const p = path.join(root, 'plugin/hooks/hooks.json');
      const before = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, before.replaceAll('session-start', 'session-start-DISABLED-BY-MUTANT'));
      const after = await real.detect(options);
      expect(after.state).toBe('FAIL');
      expect(after.why).toMatch(/not registered/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('MUTANT: delete the shipped red→surface consumer → D3 goes FAIL even while registration remains', async () => {
    // The prior D3 gate stopped at hooks.json registration. That proves a command is named, not
    // that a red CI verdict reaches a maintainer or that green stays silent. Delete the actual
    // session-start consumer while leaving the observer, poller, and registration intact: a
    // behavioral gate must catch the resulting silence.
    const real = RV.INVARIANTS.find((i) => i.name === 'CONTINUITY-PLANE-FIRES');
    const root = copiedFixture([
      'plugin/scripts/session-start-core.mjs',
      'plugin/hooks/hooks.json',
      'plugin/scripts/session-start-core.mjs',
    ]);
    const options = { root, runCommand: d3FixtureRunner(root) };
    const call = 'surfaceSignals({ env, cwd, stateDir, hookDir, emit, now });';
    try {
      expect((await real.detect(options)).state).toBe('PASS');
      const p = path.join(root, 'plugin/scripts/session-start-core.mjs');
      const before = fs.readFileSync(p, 'utf8');
      expect(before).toContain(call);
      fs.writeFileSync(p, before.replace(call, 'void 0; // MUTANT: signal consumer deleted'));
      const after = await real.detect(options);
      expect(after.state).toBe('FAIL');
      expect(after.why).toMatch(/behavior|lifecycle|surface/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('MUTANT: sever the selfcheck→exitCode wire → D8 goes FAIL even with the matrix present', async () => {
    // This is the ACTUAL historical 40/100 defect: the workflow ran, the check ran, and the verdict
    // evaporated at process exit. The matrix file still exists in this mutant — proving the detector
    // binds to the substance (the exit wire) and not to the ceremony (a YAML file being present).
    const real = RV.INVARIANTS.find((i) => i.name === 'INSTALL-FAILS-LOUD');
    const root = copiedFixture(['bin/install.mjs', '.github/workflows/stranger-matrix.yml']);
    try {
      expect((await real.detect({ root })).state).toBe('PASS');
      const p = path.join(root, 'bin/install.mjs');
      const before = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, before.replace(/process\.exitCode\s*=\s*selfcheck/, 'void (selfcheck'));
      const after = await real.detect({ root });
      expect(after.state).toBe('FAIL');
      expect(after.why).toMatch(/never reaches process\.exitCode/);
      expect(fs.existsSync(path.join(root, '.github/workflows/stranger-matrix.yml'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('MUTANT: a stale replay artifact graded against another SHA reads UNKNOWN, not PASS', async () => {
    // Gate C++ v1 graded the PARENT commit and reported on the candidate. A verdict is only ever
    // about the SHA it was measured on; a mismatched one measured a different product.
    const real = RV.INVARIANTS.find((i) => i.name === 'LEARNING-REPLAY');
    const after = await real.detect({
      checkReplay: () => ({ status: 'UNKNOWN', why: 'artifact source is not an ancestor of candidate' }),
    });
    expect(after.state).toBe('UNKNOWN');
    expect(after.why).toMatch(/not an ancestor|different tree|stale/i);
  });

  it('MUTANT: a replay whose CONTROL also succeeded reads UNKNOWN — an invalid trap is not a pass', async () => {
    // DDD-0013 invariant 6, the exact inversion of L4: if the brain-off control produced the same
    // artifact, the trap measured nothing about the brain. INCONCLUSIVE must never round up.
    const real = RV.INVARIANTS.find((i) => i.name === 'LEARNING-REPLAY');
    const after = await real.detect({
      checkReplay: () => ({ status: 'INCONCLUSIVE', why: 'control arm also succeeded' }),
    });
    expect(after.state).toBe('UNKNOWN');
    expect(after.why).toMatch(/control|inconclusive/i);
  });
});

describe('the CLI is the door that actually gets walked through', () => {
  // One invocation executes the real D1-D8 graph. Both formats and non-PASS rendering are tested
  // above from one evaluated result, avoiding a second graph execution. The outer 180s process
  // bound and every detector's own timeout remain unchanged.
  it('executes the real graph once and returns its machine verdict, SHA, timings, and exit mapping', () => {
    const r = spawnSync('node', ['scripts/release-vector.mjs', '--json', '--timings'], { cwd: REPO, encoding: 'utf8', timeout: 180_000 });
    expect(r.status, `the runner must complete within its existing 180s bound; partial timing trace: ${r.stderr}`).not.toBeNull();
    const j = JSON.parse(r.stdout);
    expect(j.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(j.results).toHaveLength(8);
    expect(j.verdict).toBe(RV.verdictWithLineage(j.results, j.lineage));
    for (const x of j.results) {
      expect(x.sha).toBe(j.sha);   // every result stamped with the same SHA
      expect(Number.isFinite(x.elapsedMs)).toBe(true);
      expect(x.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(r.status).toBe(RV.exitCodeForVerdict(j.verdict));
    const timingEvents = r.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const starts = timingEvents.filter(({ phase }) => phase === 'start').map(({ name }) => name);
    const completions = timingEvents.filter(({ phase }) => phase === 'complete');
    expect(starts).toEqual(j.results.map(({ name }) => name));
    expect(completions.map(({ name }) => name)).toEqual(starts);
    expect(completions.map(({ elapsedMs }) => elapsedMs)).toEqual(j.results.map(({ elapsedMs }) => elapsedMs));
    const text = RV.formatVectorOutput(j);
    expect(text).toContain(`verdict: ${j.verdict}`);
    if (j.verdict !== 'PASS') {
      for (const banned of RV.BANNED_WHEN_DEGRADED) expect(text).toContain(banned);
    }
  }, 190_000);
});
