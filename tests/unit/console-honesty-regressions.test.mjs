// tests/unit/console-honesty-regressions.test.mjs — the eight bugs three adversarial reviewers found
// in the capability surface, each pinned so it cannot come back.
//
// WHY A SEPARATE FILE. Every one of these shipped GREEN. The suite was passing, the code looked
// careful, and the comments in it were correct about the principle while the line below them broke
// it. That is the signature of this whole class of bug: it is not caught by testing the happy path,
// because the happy path is exactly where these all behave. Each test below therefore FORCES the
// real failure — a renamed field, a stale timestamp, an empty hook array, a settings file from the
// future, four processes saving at once — rather than asserting the shape of a healthy answer.
//
// THE ONE RULE THEY ALL SERVE: a state that was not measured may never be rendered as a measurement.
// 'unknown' outranks 'off'; 'off' is never inferred from silence; and an instrument that could not
// run is never reported as an instrument that found nothing.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The registry's contract (tests/unit/capability-registry.test.mjs): every UNKNOWN names its obstacle.
const UNKNOWN_NAMES_OBSTACLE = /could not|cannot|not checked|does not exist|failed|unknown|has probably changed/i;

// GitHub's Windows runners don't ship the sqlite3 CLI (confirmed live: `Error: spawnSync sqlite3
// ENOENT`, windows-unit job of run 30202790095) — and scripts/memory-doctor.mjs's read path shells
// out to it exclusively. Gate on the CLI itself so the sqlite-backed tests run wherever sqlite3
// genuinely exists and honestly self-skip where the capability under test cannot function at all.
const hasSqlite3 = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;

/** Build a minimal, real memory.db fixture the memory-distillation probe (memory-doctor.mjs) reads
 *  as a healthy, learning store: one embedded memory_entries row (BLOB embedding, non-zero length)
 *  and one promoted reasoning_patterns row. Other tables the probe queries (episodes, skills, ...)
 *  are deliberately absent — memory-doctor.mjs treats "no such table" as real schema variance, not
 *  an error, so a minimal two-table fixture is sufficient and honest. */
function makeMemoryStore(projectDir) {
  const db = path.join(projectDir, '.swarm/memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  execFileSync('sqlite3', [db,
    "CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, namespace TEXT, value TEXT, embedding BLOB); "
    + "CREATE TABLE reasoning_patterns(id INTEGER PRIMARY KEY, pattern TEXT, promoted INTEGER DEFAULT 0); "
    + "INSERT INTO memory_entries(namespace,value,embedding) VALUES ('lesson','fixture memory',X'0102030405060708'); "
    + "INSERT INTO reasoning_patterns(pattern,promoted) VALUES ('fixture pattern',1);"]);
  return db;
}

/** Make a throwaway HOME. These probes read ~/.claude-flow and ~/.claude, so the only honest way to
 *  test what they say about "a machine" is to give them a machine we built. */
function tmpHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'honesty-'));
  fs.mkdirSync(path.join(h, '.claude-flow/neural'), { recursive: true });
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  return h;
}

/**
 * Run a snippet in a CHILD process with a chosen HOME.
 *
 * In-process env juggling cannot do this job: capability-registry.mjs captures `const HOME =
 * os.homedir()` at module load, so by the time a test could set process.env.HOME the value is
 * already baked. A child is also the only way to observe the thing D2 was actually about — what the
 * probe leaves behind on the filesystem after it exits.
 */
function inHome(home, src) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    // os.homedir() reads USERPROFILE on win32 and HOME elsewhere — set both or the child
    // resolves the REAL runner profile and every probe honestly answers 'absent'.
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 60_000,
  });
  return { out: r.stdout || '', err: r.stderr || '', code: r.status };
}

const detect = (key) => `
  const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/capability-registry.mjs')).href)});
  const r = m.CAPABILITIES.find((c) => c.key === ${JSON.stringify(key)}).detect();
  process.stdout.write(JSON.stringify(r));
`;

describe('a read-only status check must leave the machine exactly as it found it', () => {
  it('writes nothing into HOME and starts no background daemon', () => {
    // THE CRITICAL ONE. `rufloBin()` located ruflo and the learning-hooks detector then RAN it
    // (`ruflo hooks list`, cwd: HOME) purely to count rows in a table the same detector goes on to
    // declare unreadable. ruflo responds to any invocation by auto-starting its daemon and adopting
    // the caller's cwd as its workspace, so one call to auditAll() on a scratch HOME left a live
    // `node cli.js daemon start --foreground` process running after exit, plus four files:
    // .claude-flow/{daemon.pid, daemon-state.json, logs/daemon.log, update-state.json}.
    //
    // Hundreds of people are meant to open this page. Each one would have acquired an unrequested
    // long-lived process and a polluted home directory as the price of asking "what's turned on?"
    //
    // File count is the assertion rather than a ps grep: daemon.pid is written into HOME, so a
    // daemon cannot start without tripping this, and the check stays portable on a CI box.
    const home = tmpHome();
    try {
      const before = new Set(fs.readdirSync(home));
      inHome(home, `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/capability-registry.mjs')).href)});
        m.auditAll();
      `);
      // The daemon was spawned detached and took a moment to write its pid file; a synchronous
      // check immediately after exit would have passed even while the bug was live.
      // Portable synchronous sleep: sleep.exe lives in Git's usr/bin, which is NOT on the
      // windows runner PATH (bash.exe is). Atomics.wait blocks this thread on every OS.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);

      const written = [];
      const walk = (d, rel = '') => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const r = path.join(rel, e.name);
          if (e.isDirectory()) walk(path.join(d, e.name), r);
          else written.push(r);
        }
      };
      walk(home);
      const strays = written.filter((f) => !before.has(f.split(path.sep)[0]));
      expect(strays, `a read-only audit wrote into HOME: ${strays.join(', ')}`).toEqual([]);
      expect(fs.existsSync(path.join(home, '.claude-flow/daemon.pid')),
        'a status check started a background daemon').toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 90_000);
});

describe('the learner row reports what it measured, never what it failed to read', () => {
  it('says unknown — not off — when the counters have been renamed upstream', () => {
    // FORCED REAL FAILURE. `Number(x) || 0` turns NaN into 0, so on the day rUv renames
    // trajectoriesRecorded every user is told at once: "the learner file exists but records 0
    // trajectories and 0 patterns — nothing has been learned yet." Reproduced against a stats.json
    // carrying 457 REAL trajectories under `trajectories_recorded`: this row said OFF while
    // learning-enable.mjs, reading the identical bytes, said UNKNOWN. Two shipped answers to one
    // question, on one machine, in the same minute.
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, '.claude-flow/neural/stats.json'), JSON.stringify({
        trajectories_recorded: 457, patterns_learned: 457, lastAdaptation: Date.now(),
      }));
      const r = JSON.parse(inHome(home, detect('workflow-pattern-learning')).out);
      expect(r.state, 'a field we cannot read is not a zero we measured').toBe('unknown');
      expect(r.state).not.toBe('off');
      expect(r.evidence).toMatch(/recognise|changed/i);
      // The specific sentence that must never return: a fabricated count presented as an observation.
      expect(r.evidence).not.toMatch(/records 0 trajectories/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('reports ONE fact when trajectories and patterns are identical — not two achievements', () => {
    // Fable 5's catch, measured live 2026-07-24: trajectoriesRecorded 1114, patternsLearned 1114.
    // Rendered as "N recorded AND N learned" that reads as two independent wins and implies a
    // distillation step between them. A sharp reader sees the 1:1 and concludes the counter is
    // counting itself — so the copy must name the identity rather than let it imply reduction.
    //
    // NOTE ON WHAT THIS DOES NOT ASSERT: nothing here claims ruflo's learner is wrong. rUv's own
    // persistent-sona.ts deduplicates patterns, so a below-1:1 ratio is the designed behaviour and an
    // exact 1:1 is unexplained — unexplained is not false. The test only guards OUR rendering.
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, '.claude-flow/neural/stats.json'), JSON.stringify({
        trajectoriesRecorded: 1114, patternsLearned: 1114, lastAdaptation: Date.now(),
      }));
      const r = JSON.parse(inHome(home, detect('workflow-pattern-learning')).out);
      expect(r.state).toBe('on');
      expect(r.evidence, 'the 1:1 identity must be stated, not implied away').toMatch(/matches it exactly|no reduction/i);
      expect(r.evidence, 'must not read as two independent achievements')
        .not.toMatch(/1114 work sessions recorded and 1114 patterns learned/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('still reports BOTH numbers when they genuinely differ', () => {
    // The fix must not flatten real signal: a genuine reduction is the interesting case and must
    // survive. If this ever starts collapsing unequal counts, the honesty fix has overreached.
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, '.claude-flow/neural/stats.json'), JSON.stringify({
        trajectoriesRecorded: 900, patternsLearned: 120, lastAdaptation: Date.now(),
      }));
      const r = JSON.parse(inHome(home, detect('workflow-pattern-learning')).out);
      expect(r.evidence).toMatch(/900/);
      expect(r.evidence).toMatch(/120/);
      expect(r.evidence).not.toMatch(/matches it exactly/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('says idle — never on, and no longer off — for a learner that has recorded nothing in over a year', () => {
    // The registry had NO staleness check at all: a learner last adapted 400 days ago reported
    // "on — 457 work sessions recorded", while learning-enable called the same file "IDLE — nothing
    // in 400 days". STALE_DAYS now has one definition, imported rather than re-typed.
    //
    // UPDATED 2026-07-24: the expectation moved from 'off' to 'idle', and the reason matters more
    // than the string. The INVARIANT this test has always guarded is "a dead learner must never read
    // as on" — it asserted 'off' only because 'off' was the sole non-on state that existed when it
    // was written. STATE.IDLE now names this case exactly ("ran before, nothing is calling it"), and
    // 'off' has become the WRONG answer here: off means "we looked and it is not running" and points
    // the user at turnOn, which for a learner already holding 457 trajectories is the category error
    // that put "457 patterns learned" beside an invitation to enable it. Found by Fable 5 in the
    // ADR-047 duel.
    //
    // The `.not.toBe('on')` line below is the load-bearing one and is kept EXPLICIT rather than
    // implied by toBe('idle'): if a future refactor invents another state, this test must still fail
    // for the original reason, not silently pass because the string happened to change.
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, '.claude-flow/neural/stats.json'), JSON.stringify({
        trajectoriesRecorded: 457, patternsLearned: 457, lastAdaptation: Date.now() - 400 * 86_400_000,
      }));
      const r = JSON.parse(inHome(home, detect('workflow-pattern-learning')).out);
      expect(r.state, 'a learner dead for 400 days is NEVER "on"').not.toBe('on');
      expect(r.state, 'a populated-but-quiet learner is idle (wiring gap), not off (never used)').toBe('idle');
      expect(r.evidence).toMatch(/400 days/);
      // It must not send the user to switch on a thing that already ran.
      expect(r.evidence, 'idle evidence must not read as "never used"').toMatch(/ran before|not off/i);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

describe('session capture counts commands, not containers', () => {
  it('does not report "on" when both hook groups are empty', () => {
    // FABRICATED STATUS, reproduced exactly. The detector counted matcher GROUPS —
    // `hooks.PreCompact.length` — and `[{matcher:'.*',hooks:[]}]` has length 1 while executing
    // nothing. That produced "on — both boundaries are covered: a hook runs before compaction and
    // another at session end" on a machine that would silently lose every session it ever had.
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
        hooks: { PreCompact: [{ matcher: '.*', hooks: [] }], SessionEnd: [{ matcher: '.*', hooks: [] }] },
      }));
      const r = JSON.parse(inHome(home, detect('session-capture')).out);
      // Empty inspected declarations prove neither native absence nor activation.
      expect(r.state, 'zero declared commands cannot be "on"').not.toBe('on');
      expect(r.state, 'uninspected runtime hooks must not become a measured OFF').toBe('unknown');
      expect(r.evidence).toMatch(/no state-saving declaration was observed/i);
      expect(r.evidence).toMatch(/runtime.*not checked/i);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('reports "on" only as declared wiring, never as proven to have captured anything', () => {
    // The standard the MCP row already held itself to, applied here too: a settings entry proves a
    // command is wired to fire. No local artifact proves it ever ran, so the wording must not imply
    // that it did. Same discipline as "configured, which is not the same as currently reachable".
    const home = tmpHome();
    try {
      fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: '.*', hooks: [{ command: 'node capture.mjs' }] }],
          SessionEnd: [{ matcher: '.*', hooks: [{ command: 'node capture.mjs' }] }],
        },
      }));
      const r = JSON.parse(inHome(home, detect('session-capture')).out);
      expect(r.state).toBe('on');
      expect(r.evidence, 'an "on" derived from config must name the declared boundaries')
        .toMatch(/declared at compaction and session end/i);
      expect(r.evidence, 'declared commands must never imply observed native execution or capture')
        .toMatch(/not proof of native activation or successful capture/i);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

describe('a hand-edited settings.json must never crash the thing asked whether learning is on', () => {
  // Both of these exited 1 with a raw stack trace — the worst outcome for a command whose only job
  // is to answer a worried person's question. It left them unable to find out at all.
  const cases = [
    ['literal null (valid JSON, so the parse succeeds and cfg.hooks throws)', 'null'],
    ['hooks written as an object rather than an array (not iterable)',
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x', hooks: { command: 'ruflo hooks pre-edit' } }] } })],
    ['a top-level array where an object belongs', '[]'],
  ];
  for (const [label, body] of cases) {
    it(`survives ${label}`, () => {
      const home = tmpHome();
      try {
        fs.writeFileSync(path.join(home, '.claude/settings.json'), body);
        const r = inHome(home, `
          const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/learning-enable.mjs')).href)});
          const s = m.gatherState({ home: ${JSON.stringify(home)} });
          process.stdout.write(JSON.stringify({ hooks: s.settings.learningHooks, code: s.verdict.code }));
        `);
        expect(r.code, `crashed: ${r.err.split('\n')[0]}`).toBe(0);
        const got = JSON.parse(r.out);
        // null, never 0. A count of 0 is a claim about their configuration; null is the truth about
        // our reading of it, and this file's whole thesis is that those are different sentences.
        expect(got.hooks, 'an unreadable shape must not report a measured zero').toBe(null);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }, 60_000);
  }
});

describe('a broken instrument is never reported as a clean bill of health', () => {
  it('counts detector failures instead of swallowing them into an all-clear', () => {
    // With all three detectors forced to throw, auditCapabilities() returned `[]` — which is exactly
    // what a perfectly healthy machine returns — and the CLI printed "No dormant capability found on
    // this machine. That is a real answer, not a shrug." Total instrument failure, rendered as a
    // confident all-clear, with copy that explicitly forecloses the doubt.
    const r = inHome(os.homedir(), `
      const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/capability-audit.mjs')).href)});
      m.DETECTORS.length = 0;
      m.DETECTORS.push(function detectA() { throw new Error('EACCES: permission denied'); });
      m.DETECTORS.push(function detectB() { throw new Error('Unexpected token in JSON'); });
      process.stdout.write(JSON.stringify(m.auditCapabilities()));
    `);
    const audit = JSON.parse(r.out);
    expect(audit.findings).toEqual([]);
    expect(audit.failures.length, 'a thrown detector must survive as visible data').toBe(2);
    expect(audit.ran, 'zero checks ran, and the caller has to be able to know that').toBe(0);
    expect(audit.total).toBe(2);
    expect(audit.failures[0].reason).toMatch(/EACCES/);
  }, 60_000);

  it('never prints the "real answer, not a shrug" line when a check could not run', () => {
    // The copy is the defect here, not just the data: "that is a real answer" is a claim about
    // COVERAGE, and it may only be made when coverage was total. Asserted against the CLI's actual
    // stdout, because that string is what a person reads.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
    try {
      // A directory where archive.json must be a file: a real EISDIR from a real detector, not a stub.
      fs.mkdirSync(path.join(dir, '.metaharness/archive.json'), { recursive: true });
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/capability-audit.mjs'), '--repo', dir],
        { encoding: 'utf8', timeout: 60_000 });
      const out = r.stdout || '';
      if (/could not run/.test(out)) {
        expect(out, 'an all-clear was claimed while a check was broken').not.toMatch(/real answer, not a shrug/);
      } else {
        // No detector happened to fail here; the unit test above carries the load. Assert only the
        // invariant that always holds: the all-clear must state its coverage rather than assert trust.
        expect(/No dormant capability/.test(out) ? /checks ran/.test(out) : true).toBe(true);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('the settings write path cannot lose a choice the user made', () => {
  it('refuses to overwrite settings written by a NEWER version, and leaves the bytes untouched', () => {
    // loadSettings already refused to reinterpret a v2 file and its comment said, correctly, that
    // guessing "is how settings get silently downgraded on the next save". The next save then did
    // precisely that: six deliberate choices went in, four came back as defaults and two were
    // deleted outright, and the receipt read "saved; previous settings kept at …bak-…".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-'));
    const file = path.join(dir, 'settings.json');
    try {
      const original = JSON.stringify({
        version: 2,
        settings: { learningScope: 'user', advocacy: 'all', autoApply: true, newProjectDefaults: true, telemetry: 'off' },
      }, null, 2);
      fs.writeFileSync(file, original);
      const r = inHome(os.homedir(), `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/user-settings.mjs')).href)});
        process.stdout.write(JSON.stringify(m.saveSettings({ advocacy: 'off' }, { file: ${JSON.stringify(file)} })));
      `);
      const res = JSON.parse(r.out);
      expect(res.ok, 'a save that would destroy a newer file must not report success').toBe(false);
      expect(res.log).toMatch(/refusing/i);
      // Byte-identical. "We backed it up first" is not a defence for deleting live data.
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('still RECOVERS from a corrupt file rather than refusing forever', () => {
    // The other half, and the reason the refusal above is narrow. Corrupt bytes hold nothing worth
    // protecting, so refusing there would strand the user with a broken file and no way to repair it
    // from the console — a guard that traps the person it was written for. The first version of the
    // refusal fix conflated the two and this contract caught it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-'));
    const file = path.join(dir, 'settings.json');
    try {
      fs.writeFileSync(file, 'not json at all');
      const r = inHome(os.homedir(), `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/user-settings.mjs')).href)});
        const res = m.saveSettings({ autoApply: true }, { file: ${JSON.stringify(file)} });
        process.stdout.write(JSON.stringify({ ok: res.ok, backup: res.backup, healthy: m.loadSettings(${JSON.stringify(file)}).healthy }));
      `);
      const res = JSON.parse(r.out);
      expect(res.ok, 'a corrupt file must be recoverable, not a permanent lockout').toBe(true);
      expect(fs.existsSync(res.backup), 'the corrupt bytes are kept, not discarded').toBe(true);
      expect(res.healthy).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('loses nothing when four processes save different settings simultaneously', async () => {
    // MEASURED BEFORE THE FIX: 19 of 20 trials lost at least one setting, every writer returning
    // ok:true with no error and no warning — the user clicks four toggles and two quietly do not
    // stick. Read-modify-write did not solve this; it only narrowed the window.
    //
    // THIS TEST WAS ITSELF BLIND FOR ONE COMMIT, which is worth more than the bug it guards. The
    // writers were launched with `spawnSync` inside `.map()` — and spawnSync BLOCKS. Each child ran
    // to completion before the next was even created (stamped at 400/484/568ms in the identical
    // harness), so "four processes save simultaneously" was four processes saving one after another.
    // Sequential read-modify-write never loses a key even with no lock at all, so this test would
    // have stayed green if withLock were deleted outright — a passing test asserting nothing, which
    // is worse than no test because it is counted as coverage.
    //
    // Async `spawn` + Promise.all is what makes it real: all four exist before any of them writes,
    // and the shared release instant then actually releases them together. The control below proves
    // the harness can still see the failure.
    // advocacy is a 1-5 dial since ADR-052 (was a 3-value enum) — 4 is just a real, non-default value,
    // same role 'important-only' played before: proving the race doesn't silently drop this key.
    const KEYS = [['learningScope', 'user'], ['advocacy', 4], ['autoApply', true], ['newProjectDefaults', true]];

    /** Launch all writers first, THEN wait. The ordering here is the entire point of this test. */
    const raceOnce = async (module, fnSrc) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-'));
      const file = path.join(dir, 'settings.json');
      const startAt = Date.now() + 500;   // a shared release instant, now reachable by all four
      const kids = KEYS.map(([k, v]) => spawn(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(pathToFileURL(module).href)});
        // SLEEP to the shared instant — never a busy spin. The first version spun hot for the whole
        // lead time, pinning four processes at 100% CPU and starving the ONNX worker-pool tests
        // running in parallel: forge-rerank-workers failed ~1 run in 3 while passing alone. A test
        // that breaks a neighbouring test is a defect in this file, not a flake in that one.
        // Timer granularity is a few ms and a save takes far longer than that, so the overlap this
        // test depends on survives — and the CONTROL below is what proves it, every run.
        const lead = ${startAt} - Date.now();
        if (lead > 0) await new Promise((r) => setTimeout(r, lead));
        ${fnSrc(JSON.stringify(k), JSON.stringify(v), JSON.stringify(file))}
      `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      const codes = await Promise.all(kids.map((c) => new Promise((res, rej) => {
        let err = '';
        c.stderr.on('data', (d) => { err += d; });
        c.on('error', rej);
        c.on('close', (code) => res({ code, err }));
      })));
      return { dir, file, codes };
    };

    for (let trial = 0; trial < 3; trial++) {
      const { dir, file, codes } = await raceOnce(
        path.join(REPO, 'scripts/user-settings.mjs'),
        (k, v, f) => `m.saveSettings({ [${k}]: ${v} }, { file: ${f} });`,
      );
      try {
        for (const c of codes) expect(c.code, `writer crashed: ${c.err}`).toBe(0);
        const got = JSON.parse(fs.readFileSync(file, 'utf8')).settings;
        for (const [k, v] of KEYS) {
          expect(got[k], `trial ${trial}: "${k}" was silently discarded by a concurrent save`).toEqual(v);
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }, 120_000);

  it('CONTROL: the concurrency harness above can actually observe a lost write', async () => {
    // A regression test for the regression test. The previous harness was blind and nobody could tell,
    // because a blind harness and a working lock produce byte-identical output: green.
    //
    // This runs the SAME four-writers-at-one-instant shape against a deliberately unlocked
    // read-modify-write — the exact code withLock replaced — and requires it to lose something. If
    // this ever starts passing cleanly, the harness has stopped overlapping the writers and every
    // concurrency guarantee in the test above is unverified, whatever colour the suite reports.
    const KEYS = ['a', 'b', 'c', 'd'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-control-'));
    const file = path.join(dir, 'unlocked.json');
    try {
      fs.writeFileSync(file, '{}');
      const startAt = Date.now() + 500;
      const kids = KEYS.map((k) => spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        // SLEEP to the shared instant — never a busy spin. The first version spun hot for the whole
        // lead time, pinning four processes at 100% CPU and starving the ONNX worker-pool tests
        // running in parallel: forge-rerank-workers failed ~1 run in 3 while passing alone. A test
        // that breaks a neighbouring test is a defect in this file, not a flake in that one.
        // Timer granularity is a few ms and a save takes far longer than that, so the overlap this
        // test depends on survives — and the CONTROL below is what proves it, every run.
        const lead = ${startAt} - Date.now();
        if (lead > 0) await new Promise((r) => setTimeout(r, lead));
        const prev = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
        // The window: read, yield, write. No lock, exactly like the console's old saveConfig.
        await new Promise((r) => setTimeout(r, 40));
        fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ ...prev, [${JSON.stringify(k)}]: true }));
      `], { stdio: ['ignore', 'pipe', 'pipe'] }));
      await Promise.all(kids.map((c) => new Promise((res) => c.on('close', res))));

      const got = JSON.parse(fs.readFileSync(file, 'utf8'));
      const lost = KEYS.filter((k) => got[k] !== true);
      expect(lost.length,
        'the unlocked control kept ALL four keys — the writers are not actually overlapping, so the '
        + 'concurrency test above proves nothing').toBeGreaterThan(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 3 — the defects three reviewers found in the fixes for round 2.
//
// Every one of these shipped green as well, and several were introduced BY the previous round's
// repairs: a lock added to the undo path whose receipt was never checked, a `num()` corrected in one
// file and discarded three lines later in another, a concurrency test whose writers did not overlap.
// A fix is not a fix until the failure it claims to close is reproduced and then refused.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('a counter is a counter only when it is actually a number', () => {
  const write = (home, stats) => {
    fs.writeFileSync(path.join(home, '.claude-flow/neural/stats.json'), JSON.stringify(stats));
  };
  const verdictIn = (home) => JSON.parse(inHome(home, `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/learning-enable.mjs')).href)});
    const s = m.readLearnerState({ home: process.env.HOME });
    process.stdout.write(JSON.stringify({ v: m.verdict(s), s }));
  `).out);

  it('does not read an explicit JSON null as a measured zero', () => {
    // `Number(null) === 0` is finite, so the old guard accepted null, '' and false as measurements.
    // The verdict it produced said the learner "GENUINELY records 0 trajectories" — the word
    // "genuinely" attached to a value that was never counted.
    for (const bad of [null, '', false]) {
      const home = tmpHome();
      try {
        write(home, { trajectoriesRecorded: bad, patternsLearned: bad });
        const { v, s } = verdictIn(home);
        expect(s.trajectories, `${JSON.stringify(bad)} must not read as a number`).toBeNull();
        expect(v.code, `${JSON.stringify(bad)} must not produce a measured verdict`).not.toBe('INITIALISED_EMPTY');
        expect(v.headline).not.toMatch(/genuinely/i);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  }, 60_000);

  it('refuses a verdict when only ONE counter drifted, in both directions', () => {
    // Upstream does not rename both fields in one release. Half-drift read as a full measurement
    // produced a confident OFF on a machine with 457 trajectories one way, and the literal string
    // "null work sessions recorded and 457 patterns learned" the other.
    const cases = [
      { trajectories_recorded: 457, patternsLearned: 0 },
      { trajectoriesRecorded: null, patternsLearned: 457 },
    ];
    for (const stats of cases) {
      const home = tmpHome();
      try {
        write(home, stats);
        const { v } = verdictIn(home);
        expect(v.code, `${JSON.stringify(stats)} is not measurable and must not be measured`).toBe('UNKNOWN_PARTIAL');

        const r = JSON.parse(inHome(home, detect('workflow-pattern-learning')).out);
        expect(r.state, 'a half-read file is unknown, never off').toBe('unknown');
        expect(r.evidence, 'a raw null must never be interpolated into user-facing prose').not.toMatch(/\bnull\b/);
        expect(r.evidence).not.toMatch(/genuinely records 0/);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  }, 60_000);

  it('still detects staleness when the timestamp arrives as an ISO string', () => {
    // num() nulled any non-number, which nulled `days`, which made the IDLE branch unreachable: a
    // learner idle 400 days reported "ON — the learner is accumulating" purely because its timestamp
    // was a string. The staleness check evaporated on exactly the drift it was written to survive.
    const home = tmpHome();
    try {
      write(home, {
        trajectoriesRecorded: 457,
        patternsLearned: 457,
        lastAdaptation: new Date(Date.now() - 400 * 864e5).toISOString(),
      });
      const { v } = verdictIn(home);
      expect(v.code, 'a 400-day-old learner is idle whatever shape its timestamp is in').toBe('IDLE');
      expect(v.headline).toMatch(/400 days/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

describe('a project-scoped answer must be about the user\'s project', () => {
  it('does not describe the installed package when run from somewhere else', () => {
    // The harmful direction: standing in an empty folder and being shown ruvnet-brain's own gate
    // counts and refusal history as though they were yours.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
    try {
      const rows = JSON.parse(execFileSync(process.execPath, [
        path.join(REPO, 'scripts/capability-registry.mjs'), '--json', '--project', dir,
      ], { encoding: 'utf8', cwd: REPO }));

      const mem = rows.find((r) => r.key === 'memory-distillation');
      expect(mem.state, 'an empty folder genuinely has no memory store').toBe('absent');
      expect(fs.realpathSync(mem.project), 'a project row must name the project it read')
        .toBe(fs.realpathSync(dir));

      const gates = rows.find((r) => r.key === 'write-gates');
      expect(gates.evidence, 'this repo\'s refusal history is not the user\'s').not.toMatch(/\d+ refusals have been recorded/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.skipIf(!hasSqlite3)('sees a memory store that IS there when pointed at the right project', () => {
    // The other direction, which is the one that offers to fix a non-problem: a healthy store
    // reported ABSENT because the registry was looking at its own directory instead.
    //
    // REDESIGNED 2026-07-26 (was CI-red on every checkout since 2026-07-25, run 30202790095): this
    // used to point --project at REPO itself and rely on the ruvnet-brain checkout's OWN local
    // `.swarm/memory.db` — 16MB of real project memory that exists only on the author's Mac.
    // `.swarm/` is gitignored machine state; a fresh CI checkout genuinely has no store there, so
    // the row was honestly 'absent' and the assertion failed for real — the test was never
    // exercising the registry's project-routing, only a fact about one developer's laptop. It now
    // builds its own fixture store in a temp project, so the claim holds on any machine, and it
    // asserts against the fixture's OWN project path so a regression to reading REPO/cwd instead of
    // --project (the original bug this guards) still fails it even where REPO has a real store.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'has-memory-'));
    try {
      makeMemoryStore(target);
      const rows = JSON.parse(execFileSync(process.execPath, [
        path.join(REPO, 'scripts/capability-registry.mjs'), '--json', '--project', target,
      ], { encoding: 'utf8', cwd: os.tmpdir() }));
      const mem = rows.find((r) => r.key === 'memory-distillation');
      expect(mem.state, 'a fixture store with an embedded memory and a promoted pattern; ABSENT would be a lie').not.toBe('absent');
      // Never REPO's own install directory or cwd — reading the wrong directory reports a real
      // user's store as absent while presenting the tool's own numbers as though they were theirs.
      expect(fs.realpathSync(mem.project), 'a project row must name the project it actually read').toBe(fs.realpathSync(target));
    } finally { fs.rmSync(target, { recursive: true, force: true }); }
  }, 60_000);

  it('offers turnOn commands that are runnable from anywhere', () => {
    // `node scripts/lesson-promote.mjs --apply` is copy-pasteable only by someone already standing in
    // a ruvnet-brain checkout. Everyone else got `Cannot find module`.
    const rows = JSON.parse(execFileSync(process.execPath, [
      path.join(REPO, 'scripts/capability-registry.mjs'), '--json',
    ], { encoding: 'utf8', cwd: os.tmpdir() }));
    for (const r of rows) {
      if (!r.turnOn?.cmd) continue;
      const rel = r.turnOn.cmd.match(/node\s+"?([^"\s]+\.mjs)"?/);
      if (rel) expect(path.isAbsolute(rel[1]), `${r.key}: "${r.turnOn.cmd}" only runs from inside this repo`).toBe(true);
    }
  }, 60_000);
});

describe('a resting database is not an unreadable one', () => {
  it.skipIf(!hasSqlite3)('reads a WAL store whose sidecars are not present', () => {
    // mode=ro cannot open a WAL database without an existing -shm, and a read-only connection may not
    // create one, so SQLite returns CANTOPEN(14) — the normal state of every store nobody is using.
    // This was live on the owner's own machine: the repo's sidecars had been renamed .CORRUPT-*, so
    // every read of its healthy 16MB store returned unreadable and the console reported UNKNOWN
    // forever, while advising the user to "re-check in a moment".
    //
    // AND CONFIRMED LIVE 2026-07-26 on ubuntu 24.04 / apt sqlite3 3.45.1 (the exact build the
    // "check" CI job installs): unlike macOS's bundled 3.51.0, that build does NOT throw CANTOPEN
    // on a plain mode=ro open of a resting WAL db — it succeeds AND vivifies -shm/-wal as a side
    // effect, which is how this test caught a real product bug in memory-doctor.mjs's q() (its only
    // sidecar guard lived in a catch block a non-throwing build never reached; now the mode is
    // chosen up front from sidecar presence). Body unchanged — it is what caught the regression;
    // only the sqlite3-CLI gate is new, matching the windows-unit `spawnSync sqlite3 ENOENT`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
    const db = path.join(dir, 'memory.db');
    try {
      execFileSync('sqlite3', [db, 'PRAGMA journal_mode=WAL; CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, namespace TEXT, value TEXT); INSERT INTO memory_entries(namespace,value) VALUES("x","y");']);
      fs.rmSync(`${db}-wal`, { force: true });
      fs.rmSync(`${db}-shm`, { force: true });

      const d = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/memory-doctor.mjs')).href)});
        process.stdout.write(JSON.stringify(m.diagnose(${JSON.stringify(db)})));
      `], { encoding: 'utf8' }));

      expect(d.unreadable, 'a resting WAL store is readable, not broken').toBeFalsy();
      expect(d.total).toBe(1);
      // And the read must not have written anything into the user's directory.
      expect(fs.existsSync(`${db}-wal`), 'a read-only diagnosis must not create WAL sidecars').toBe(false);
      expect(fs.existsSync(`${db}-shm`), 'a read-only diagnosis must not create shm sidecars').toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('does not blame a passing lock for a fault that will never clear', () => {
    // Every unreadable store got "this is often a passing lock from another session … re-check before
    // acting" — one real observation generalised into a blanket explanation. Advice that cannot work
    // is worse than none, because the person takes it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corruptdb-'));
    const db = path.join(dir, '.swarm/memory.db');
    try {
      fs.mkdirSync(path.dirname(db), { recursive: true });
      fs.writeFileSync(db, 'this is definitively not a sqlite database');
      const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/capability-registry.mjs')).href)});
        const c = m.CAPABILITIES.find((c) => c.key === 'memory-distillation');
        process.stdout.write(JSON.stringify(c.detect({ project: ${JSON.stringify(dir)} })));
      `], { encoding: 'utf8' }));

      expect(r.state, 'an unreadable store is unknown, never off').toBe('unknown');
      expect(r.evidence, 'an unknown names its obstacle').toMatch(UNKNOWN_NAMES_OBSTACLE);
      expect(r.evidence, 'a structural fault must not be described as a passing lock').not.toMatch(/passing lock/);
      if (/could not be read/.test(r.evidence)) {
        expect(r.evidence, 'a structural fault must not be described as transient').toMatch(/not a transient lock/);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('does call a REAL held lock passing — the one case where re-checking will clear it', async () => {
    // FORCED REAL STATE: another connection holds the store in WAL exclusive locking mode mid-write,
    // so the doctor's separate sqlite3 reader genuinely gets "database is locked".
    const { DatabaseSync } = await import('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockeddb-'));
    const file = path.join(dir, '.swarm/memory.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const holder = new DatabaseSync(file);
    try {
      holder.exec("PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, namespace TEXT, embedding BLOB); INSERT INTO memory_entries (namespace) VALUES ('x');");
      holder.exec("BEGIN EXCLUSIVE; INSERT INTO memory_entries (namespace) VALUES ('y');");
      const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/capability-registry.mjs')).href)});
        const c = m.CAPABILITIES.find((c) => c.key === 'memory-distillation');
        process.stdout.write(JSON.stringify(c.detect({ project: ${JSON.stringify(dir)} })));
      `], { encoding: 'utf8' }));
      expect(r.state, 'a locked store is unknown, never off').toBe('unknown');
      expect(r.evidence).toMatch(/lock/);
      expect(r.evidence, 'a real lock is the one case that IS passing').toMatch(/passing lock/);
      expect(r.evidence, 'an unknown names its obstacle').toMatch(UNKNOWN_NAMES_OBSTACLE);
    } finally {
      holder.exec('COMMIT'); holder.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a boundary tells you WHEN something runs, never WHAT it does', () => {
  const withSettings = (hooks) => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks }));
    return home;
  };

  it('does not report session capture ON for hooks that capture nothing', () => {
    // MEASURED: a shell logger and a terminal beep at the two boundaries produced "Session capture:
    // ON". Neither saves a byte of session state.
    const home = withSettings({
      PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo "compacting" >> /tmp/log.txt' }] }],
      SessionEnd: [{ matcher: '.*', hooks: [{ type: 'command', command: 'printf "\\a"' }] }],
    });
    try {
      const r = JSON.parse(inHome(home, detect('session-capture')).out);
      expect(r.state, 'a logger and a beep are not session capture').not.toBe('on');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('still reports ON for hooks that genuinely persist state', () => {
    const home = withSettings({
      PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/agentdb-autocapture.mjs' }] }],
      SessionEnd: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/agentdb-autocapture.mjs' }] }],
    });
    try {
      const r = JSON.parse(inHome(home, detect('session-capture')).out);
      expect(r.state, 'the real autocapture hook must still read as ON').toBe('on');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('returns unknown, not off, when a hook list cannot be parsed', () => {
    // A PreCompact written as an object was silently skipped and the row reported "nothing is saved
    // when a session compacts" — about a machine whose capture hook we merely failed to read. This is
    // the same skip-and-report-zero bug learning-enable.readSettingsWiring fixes and documents.
    const home = withSettings({
      PreCompact: { matcher: '.*', hooks: [{ type: 'command', command: 'node autocapture.mjs' }] },
      SessionEnd: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node autocapture.mjs' }] }],
    });
    try {
      const r = JSON.parse(inHome(home, detect('session-capture')).out);
      expect(r.state, 'an unparseable hook list is unknown, never off').toBe('unknown');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

describe('an undo must really have happened', () => {
  it('does not report success when the lock stopped it from writing', () => {
    // The F2 fix wrapped the restore in withLock and never checked the receipt. withLock returns
    // {timedOut:true} WITHOUT CALLING fn, so revert reported "restored your previous settings from
    // …bak-…" with the file byte-for-byte unchanged — the fabricated-success bug placed inside the
    // one operation whose entire promise is that it really happened.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-'));
    const file = path.join(dir, 'settings.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { autoApply: false } }));
      fs.writeFileSync(`${file}.bak-2026-01-01T00-00-00-000Z`, JSON.stringify({ version: 1, settings: { autoApply: true } }));
      const before = fs.readFileSync(file, 'utf8');
      // A FRESH lock held by "another process" — not stale, so it will not be broken.
      fs.writeFileSync(`${file}.lock`, `${process.pid} ${new Date().toISOString()}\n`);

      const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/user-settings.mjs')).href)});
        process.stdout.write(JSON.stringify(m.revertSettings({ file: ${JSON.stringify(file)} })));
      `], { encoding: 'utf8', timeout: 60_000 }));

      expect(r.ok, 'a revert that wrote nothing must not claim to have restored anything').toBe(false);
      expect(r.log).toMatch(/NOTHING was restored/);
      expect(fs.readFileSync(file, 'utf8'), 'the file must be untouched').toBe(before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
