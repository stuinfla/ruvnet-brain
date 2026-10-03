// ADR-0102 G-053 / G-002 / G-001 / G-014 — the turn writer end to end: the REAL hook-side capture, the
// REAL detached-worker body (runSteps) and a fake ruflo that writes a real SQLite store. Every fixture
// is a temp tree; no credential-shaped literal appears in source (built at runtime).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureTurnOutcome, runSteps } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { turnRecordingLine, turnRecordingStatus } from '../../plugin/scripts/turn-capture-state.mjs';
import { buildBrief } from '../../plugin/scripts/continuity-brief.mjs';
import { adoptedProject, cleanup, commit, createStore, fakeRuflo, git, rows, tmp } from '../helpers/continuity-fixture.mjs';

const OUTCOME = 'Concluded the containment work: the turn writer now resolves the canonical adopted root, refuses '
  + 'symlinked or hard-linked stores, and proves every write by reading the row back by its exact key, so a skipped '
  + 'import can never be reported as a recorded turn.';
const TOKEN = ['gh', 'p_'].join('') + 'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0EdCbA';
const NAME = 'Philippa Quarrington-Vale';

let saved;
beforeAll(() => { saved = process.env.RUVNET_RUFLO_CWD_ROOT; process.env.RUVNET_RUFLO_CWD_ROOT = tmp('turn-cwd-'); });
afterAll(() => { if (saved === undefined) delete process.env.RUVNET_RUFLO_CWD_ROOT; else process.env.RUVNET_RUFLO_CWD_ROOT = saved; });
afterEach(cleanup);

/** Fire one Stop through the capture, then run the worker body exactly as the detached process would. */
function stop({ projectDir, home, ruflo, text = OUTCOME, session = 's1', swapBeforeWorker = null }) {
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const launches = [];
  const report = captureTurnOutcome({ projectDir, event: 'Stop', host: 'claude', env: {}, home, brainHome, ruflo,
    payload: { session_id: session, last_assistant_message: text }, launch: (steps, opts) => { launches.push({ steps, opts }); return { launched: true }; } });
  if (swapBeforeWorker) swapBeforeWorker();
  const results = launches.flatMap(({ steps, opts }) => runSteps({ steps, receipts: opts.receipts }));
  return { report, results, launches, brainHome };
}

function foreignStore() {
  const dir = tmp('turn-foreign-');
  fs.mkdirSync(path.join(dir, '.swarm'));
  createStore(path.join(dir, '.swarm', 'memory.db'));
  return { dir, swarm: path.join(dir, '.swarm'), db: path.join(dir, '.swarm', 'memory.db') };
}

const globalDir = (home) => path.join(home, '.claude', 'global-memory');

describe('G-053: the turn writer is contained to the canonical adopted root', () => {
  const cases = {
    'directory symlink (.swarm → a foreign store)': (p, f) => { fs.rmSync(path.join(p.dir, '.swarm'), { recursive: true }); fs.symlinkSync(f.swarm, path.join(p.dir, '.swarm')); },
    'file symlink (memory.db → a foreign store)': (p, f) => { fs.rmSync(path.join(p.dir, '.swarm', 'memory.db')); fs.symlinkSync(f.db, path.join(p.dir, '.swarm', 'memory.db')); },
    'in-root file symlink (memory.db → another file inside the root)': (p) => {
      const other = path.join(p.dir, 'other.db'); createStore(other);
      fs.rmSync(path.join(p.dir, '.swarm', 'memory.db')); fs.symlinkSync(other, path.join(p.dir, '.swarm', 'memory.db'));
    },
    'hard link (memory.db shares a foreign inode)': (p, f) => { fs.rmSync(path.join(p.dir, '.swarm', 'memory.db')); fs.linkSync(f.db, path.join(p.dir, '.swarm', 'memory.db')); },
    'WAL side file symlink (memory.db-wal → foreign)': (p, f) => { fs.symlinkSync(`${f.db}-wal`, path.join(p.dir, '.swarm', 'memory.db-wal')); },
  };
  for (const [label, plant] of Object.entries(cases)) {
    it(`${label}: 0 foreign writes, no global fallback, a failing receipt`, () => {
      const p = adoptedProject();
      const f = foreignStore();
      plant(p, f);
      const ruflo = fakeRuflo();
      const { report, brainHome } = stop({ projectDir: p.dir, home: p.home, ruflo: ruflo.bin });
      expect(report).toMatchObject({ queued: false, scope: 'refused' });
      expect(report.skipped).toMatch(/^store refused: /);
      expect(rows(f.db, 'turns')).toHaveLength(0);
      expect(ruflo.calls()).toHaveLength(0);
      expect(fs.existsSync(globalDir(p.home))).toBe(false);
      expect(fs.existsSync(`${f.db}-wal`)).toBe(false);
      const receipts = fs.readFileSync(path.join(brainHome, 'turn-capture', 'receipts.jsonl'), 'utf8');
      expect(receipts).toMatch(/"ok":false/);
    });
  }

  it('replacement race: .swarm swapped for a symlink after the hook chose it — the worker re-checks and writes nothing', () => {
    const p = adoptedProject();
    const f = foreignStore();
    const ruflo = fakeRuflo();
    const swap = () => {
      fs.renameSync(path.join(p.dir, '.swarm'), path.join(p.dir, '.swarm-moved'));
      fs.symlinkSync(f.swarm, path.join(p.dir, '.swarm'));
    };
    const { report, results } = stop({ projectDir: p.dir, home: p.home, ruflo: ruflo.bin, swapBeforeWorker: swap });
    expect(report.queued, JSON.stringify(report)).toBe(true);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toMatch(/^refused before write: store directory is a symlink/);
    expect(rows(f.db, 'turns')).toHaveLength(0);
    expect(rows(path.join(p.dir, '.swarm-moved', 'memory.db'), 'turns')).toHaveLength(0);
    expect(ruflo.calls().filter((c) => c.argv[1] === 'import')).toHaveLength(0);
    expect(fs.existsSync(globalDir(p.home))).toBe(false);
  });

});

describe('G-002: linked worktrees write to the canonical store; projects without a store write nothing', () => {
  it('a Stop from a git worktree child lands in <repo>/.swarm/memory.db tagged with the repo name, 0 rows global', () => {
    const p = adoptedProject();
    commit(p.dir, p.env, 'README.md', 'init');
    const wt = path.join(tmp('turn-wt-'), 'wt');
    git(p.dir, p.env, 'worktree', 'add', '-q', wt);
    const ruflo = fakeRuflo();
    const { report, results } = stop({ projectDir: wt, home: p.home, ruflo: ruflo.bin });
    expect(report).toMatchObject({ queued: true, scope: 'project', db: path.join(p.dir, '.swarm', 'memory.db') });
    expect(results[0]).toMatchObject({ ok: true, readBack: 'verified' });
    const stored = rows(path.join(p.dir, '.swarm', 'memory.db'), 'turns');
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain(`project=${path.basename(p.dir)} `);
    expect(fs.existsSync(path.join(wt, '.swarm'))).toBe(false);
    expect(fs.existsSync(globalDir(p.home))).toBe(false);
  });

  it('a project without .swarm writes nothing anywhere (conservative default pending D8)', () => {
    const home = tmp('turn-home-');
    const project = tmp('turn-bare-');
    const ruflo = fakeRuflo();
    const { report, brainHome } = stop({ projectDir: project, home, ruflo: ruflo.bin });
    expect(report).toMatchObject({ queued: false, scope: 'none' });
    expect(ruflo.calls()).toHaveLength(0);
    expect(fs.existsSync(globalDir(home))).toBe(false);
    expect(fs.existsSync(path.join(project, '.swarm'))).toBe(false);
    expect(fs.existsSync(path.join(brainHome, 'turn-capture', 'spool'))).toBe(false);
  });
});

describe('G-001: nothing raw is written, nothing rides on argv', () => {
  it('a token and a name: the token is in NO file under the project, home and scratch; neither is on any ruflo argv; modes are private', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const text = `${OUTCOME} Pushed with ${TOKEN} on behalf of ${NAME}.`;
    const { results, launches, brainHome } = stop({ projectDir: p.dir, home: p.home, ruflo: ruflo.bin, text });
    expect(results[0]).toMatchObject({ ok: true, readBack: 'verified' });
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : [])) : []);
    const files = [...walk(p.dir), ...walk(p.home), ...walk(process.env.RUVNET_RUFLO_CWD_ROOT), ...walk(path.dirname(ruflo.bin))];
    expect(files.filter((file) => fs.readFileSync(file).includes(TOKEN))).toEqual([]);
    const stored = rows(path.join(p.dir, '.swarm', 'memory.db'), 'turns')[0].content;
    expect(stored).toContain('[REDACTED:token]');
    for (const call of ruflo.calls()) {
      expect(call.all.join(' ')).not.toContain(TOKEN);
      expect(call.all.join(' ')).not.toContain(NAME);
      expect(call.all.join(' ')).not.toContain('Concluded the containment work');
    }
    // The worker's own argv (launchDetached serialises exactly this) carries no turn text.
    expect(JSON.stringify(launches.map((l) => l.steps))).not.toContain(NAME);
    const jsonl = path.join(p.dir, '.swarm', 'agentdb-turns.jsonl');
    expect(Object.keys(JSON.parse(fs.readFileSync(jsonl, 'utf8').trim()))).toEqual(['ts', 'key', 'hash', 'len']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(jsonl).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(brainHome, 'turn-capture', 'receipts.jsonl')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(brainHome, 'turn-capture', 'spool')).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(path.join(brainHome, 'turn-capture', 'spool'))).toEqual([]);
    expect(ruflo.calls().every((c) => !c.cwd.startsWith(p.dir))).toBe(true);
  });
});

describe('G-014: capture failures are truthful', () => {
  it('a failing ruflo puts its first stderr line in the receipt; a silent skip (exit 0, no row) is a failure too; doctor/brief text says failing N/M', () => {
    const p = adoptedProject();
    const failing = stop({ projectDir: p.dir, home: p.home, ruflo: fakeRuflo({ importMode: 'fail' }).bin, session: 'f1' });
    expect(failing.results[0]).toMatchObject({ ok: false, status: 1, error: '[ERROR] Import error: database is locked' });
    const skipped = stop({ projectDir: p.dir, home: p.home, ruflo: fakeRuflo({ importMode: 'skip' }).bin, session: 'f2', text: `${OUTCOME} second` });
    expect(skipped.results[0]).toMatchObject({ ok: false, status: 0, readBack: 'missing' });
    expect(skipped.results[0].error).toMatch(/exited 0 but the row was not found on exact read-back \(- Skipped \(duplicates\): 1\)/);
    const ok = stop({ projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin, session: 'f3', text: `${OUTCOME} third` });
    expect(ok.results[0]).toMatchObject({ ok: true });
    const db = path.join(p.dir, '.swarm', 'memory.db');
    const env = { RUVNET_BRAIN_HOME: failing.brainHome };
    const status = turnRecordingStatus({ db, env, home: p.home });
    expect(status).toMatchObject({ total: 3, failed: 2 });
    expect(turnRecordingLine(status)).toMatch(/^turn recording failing 2\/3 in 7d — last error: ruflo exited 0 but the row was not found/);
    const brief = buildBrief({ projectDir: p.dir, env: { ...env, HOME: p.home }, home: p.home, persistState: false });
    expect(brief.context).toContain('turn recording failing 2/3');
  });
});

it('the platform under test has a temp dir (sanity for the fixture roots)', () => { expect(fs.existsSync(os.tmpdir())).toBe(true); });
