// ADR-0102 G-053 / G-002 / G-001 / G-014 — every turn-capture guard is proven by breaking it.
// Each mutant takes the REAL module, applies ONE named mutation, and the same scenario that passes on the
// real file must FAIL on the mutant. A mutation that changes nothing throws (it would test the real file).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, commit, createStore, fakeRuflo, git, rows, tmp } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'plugin', 'scripts');
const OUTCOME = 'Concluded the mutation fixture: every guard in the turn writer is broken one at a time and the scenario '
  + 'that passes on the real module must fail on the mutant, otherwise the guard is decoration and not a control.';
const TOKEN = ['gh', 'p_'].join('') + 'Mn8Bv7Cx6Za5Sd4Fg3Hj2Kl1Qw0ErTyUiOp';
const NAME = 'Ottoline Fairweather-Smythe';

let saved;
const mutants = [];
beforeAll(() => { saved = process.env.RUVNET_RUFLO_CWD_ROOT; process.env.RUVNET_RUFLO_CWD_ROOT = tmp('mut-cwd-'); });
afterAll(() => {
  for (const file of mutants) fs.rmSync(file, { force: true });
  if (saved === undefined) delete process.env.RUVNET_RUFLO_CWD_ROOT; else process.env.RUVNET_RUFLO_CWD_ROOT = saved;
});
afterEach(cleanup);

async function load(file, find, replace) {
  if (!find) return import(pathToFileURL(path.join(SCRIPTS, file)).href);
  const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  if (!src.includes(find)) throw new Error(`mutation anchor not found in ${file}: ${find.slice(0, 80)}`);
  const target = path.join(SCRIPTS, `_mutant-${mutants.length}-${file}`);
  fs.writeFileSync(target, src.replace(find, replace));
  mutants.push(target);
  return import(pathToFileURL(target).href);
}

function stop(m, { projectDir, home, ruflo, text = OUTCOME, settings = null, swap = null }) {
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  if (settings) {
    fs.mkdirSync(path.join(brainHome, 'turn-capture'), { recursive: true });
    fs.writeFileSync(path.join(brainHome, 'turn-capture', 'settings.json'), JSON.stringify(settings));
  }
  const launches = [];
  const report = m.captureTurnOutcome({ projectDir, event: 'Stop', host: 'claude', env: {}, home, brainHome, ruflo,
    payload: { session_id: 's', last_assistant_message: text }, launch: (steps, opts) => { launches.push({ steps, opts }); return {}; } });
  if (swap) swap();
  const results = launches.flatMap(({ steps, opts }) => m.runSteps({ steps, receipts: opts.receipts }));
  return { report, results, launches, brainHome };
}

function foreign() {
  const dir = tmp('mut-foreign-');
  fs.mkdirSync(path.join(dir, '.swarm'));
  createStore(path.join(dir, '.swarm', 'memory.db'));
  return { swarm: path.join(dir, '.swarm'), db: path.join(dir, '.swarm', 'memory.db') };
}

// Each scenario returns true when the guard held.
const SCENARIOS = {
  hookRefusesSymlinkedStore: (m) => {
    const p = adoptedProject(); const f = foreign();
    fs.rmSync(path.join(p.dir, '.swarm'), { recursive: true }); fs.symlinkSync(f.swarm, path.join(p.dir, '.swarm'));
    const { report } = stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin });
    return report.scope === 'refused' && report.queued === false && rows(f.db, 'turns').length === 0;
  },
  hookRefusesLinkedStoreFile: (m) => {
    // The resolver accepts both (in-root symlink, hard link): only the containment check refuses them.
    const p = adoptedProject(); const other = path.join(p.dir, 'other.db'); createStore(other);
    fs.rmSync(path.join(p.dir, '.swarm', 'memory.db')); fs.symlinkSync(other, path.join(p.dir, '.swarm', 'memory.db'));
    const linked = stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin }).report;
    const q = adoptedProject(); const f = foreign();
    fs.rmSync(path.join(q.dir, '.swarm', 'memory.db')); fs.linkSync(f.db, path.join(q.dir, '.swarm', 'memory.db'));
    const hard = stop(m, { projectDir: q.dir, home: q.home, ruflo: fakeRuflo().bin }).report;
    return linked.scope === 'refused' && hard.scope === 'refused' && rows(other, 'turns').length === 0 && rows(f.db, 'turns').length === 0;
  },
  workerRechecksAfterRace: (m) => {
    const p = adoptedProject(); const f = foreign();
    const swap = () => { fs.renameSync(path.join(p.dir, '.swarm'), path.join(p.dir, '.swarm-moved')); fs.symlinkSync(f.swarm, path.join(p.dir, '.swarm')); };
    stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin, swap });
    return rows(f.db, 'turns').length === 0;
  },
  bareProjectWritesNothing: (m) => {
    const home = tmp('mut-home-'); const ruflo = fakeRuflo();
    const { report } = stop(m, { projectDir: tmp('mut-bare-'), home, ruflo: ruflo.bin });
    return report.queued === false && ruflo.calls().length === 0 && !fs.existsSync(path.join(home, '.claude', 'global-memory'));
  },
  worktreeWritesCanonicalStore: (m) => {
    const p = adoptedProject(); commit(p.dir, p.env, 'README.md', 'init');
    const wt = path.join(tmp('mut-wt-'), 'wt'); git(p.dir, p.env, 'worktree', 'add', '-q', wt);
    stop(m, { projectDir: wt, home: p.home, ruflo: fakeRuflo().bin });
    return rows(path.join(p.dir, '.swarm', 'memory.db'), 'turns').length === 1;
  },
  tokenRedactedInStore: (m) => {
    const p = adoptedProject();
    stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin, text: `${OUTCOME} used ${TOKEN}` });
    const stored = rows(path.join(p.dir, '.swarm', 'memory.db'), 'turns');
    return stored.length === 1 && !stored[0].content.includes(TOKEN);
  },
  noTextOnWorkerArgv: (m) => {
    const p = adoptedProject();
    const { launches } = stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin, text: `${OUTCOME} for ${NAME}` });
    return launches.length === 1 && !JSON.stringify(launches[0].steps).includes(NAME);
  },
  jsonlHashOnly: (m) => {
    const p = adoptedProject();
    stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo().bin });
    const line = JSON.parse(fs.readFileSync(path.join(p.dir, '.swarm', 'agentdb-turns.jsonl'), 'utf8').trim());
    return JSON.stringify(Object.keys(line)) === JSON.stringify(['ts', 'key', 'hash', 'len']);
  },
  persistedOptOutHonoured: (m) => {
    const p = adoptedProject(); const ruflo = fakeRuflo();
    const { report } = stop(m, { projectDir: p.dir, home: p.home, ruflo: ruflo.bin, settings: { capture: 'off' } });
    return report.queued === false && ruflo.calls().length === 0;
  },
  silentSkipIsFailure: (m) => {
    const p = adoptedProject();
    const { results } = stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo({ importMode: 'skip' }).bin });
    return results.length === 1 && results[0].ok === false;
  },
  firstStderrLineInReceipt: (m) => {
    const p = adoptedProject();
    const { results } = stop(m, { projectDir: p.dir, home: p.home, ruflo: fakeRuflo({ importMode: 'fail' }).bin });
    return results[0]?.error === '[ERROR] Import error: database is locked';
  },
};

const MUTANTS = [
  ['G-053 hook: containment check ignored (in-root symlink and hard link)', 'hookRefusesLinkedStoreFile',
    "    const problem = storeContainmentProblem(db);\n    return problem ?", '    const problem = null;\n    return problem ?'],
  ['G-053 worker: re-check removed (replacement race)', 'workerRechecksAfterRace',
    "const problem = storeContainmentProblem(step.db, { allowMissing: step.scope === 'global' });", 'const problem = null;'],
  ['G-002: unadopted projects default to the global store', 'bareProjectWritesNothing',
    "if (settings.unadopted === 'global')", "if (settings.unadopted !== 'nothing')"],
  ['G-002: worktree resolves to its own checkout', 'worktreeWritesCanonicalStore',
    'const db = resolution.canonicalAgentDbPath;', "const db = path.join(resolution.checkoutRoot, '.swarm', 'memory.db');"],
  ['G-001: redaction removed', 'tokenRedactedInStore',
    "import { redactText, userLevelAgentdbHooks } from './continuity-events.mjs';",
    "import { userLevelAgentdbHooks } from './continuity-events.mjs';\nconst redactText = (t) => String(t ?? '');"],
  ['G-001: value handed to the worker on argv', 'noTextOnWorkerArgv',
    'key: record.key, spool, hash });', 'key: record.key, spool, hash, value: record.value });'],
  ['G-001: plaintext in the jsonl index', 'jsonlHashOnly',
    'hash, len: record.value.length }', 'hash, len: record.value.length, value: record.value }'],
  ['G-001: persisted opt-out ignored', 'persistedOptOutHonoured',
    "if (read.settings.capture === 'off')", 'if (false)'],
  ['G-014: exit 0 trusted without read-back', 'silentSkipIsFailure',
    "if (row.readBack === 'verified') row.ok = true;", 'if (true) row.ok = true;'],
  ['G-014: stderr discarded', 'firstStderrLineInReceipt',
    'const said = safeLine(r.stderr) ||', "const said = '' ||"],
];

describe('turn capture guards hold on the real module', () => {
  for (const name of Object.keys(SCENARIOS)) {
    it(`real: ${name}`, async () => { expect(SCENARIOS[name](await load('turn-outcome-capture.mjs'))).toBe(true); });
  }
});

describe('each mutant turns its scenario red', () => {
  for (const [label, scenario, find, replace] of MUTANTS) {
    it(`mutant — ${label}`, async () => {
      const m = await load('turn-outcome-capture.mjs', find, replace);
      expect(SCENARIOS[scenario](m)).toBe(false);
    });
  }
  it('mutant — G-014: failures not counted, so doctor/SessionStart say ✓', async () => {
    const status = (m) => {
      const brainHome = tmp('mut-receipts-');
      fs.mkdirSync(path.join(brainHome, 'turn-capture'));
      fs.writeFileSync(path.join(brainHome, 'turn-capture', 'receipts.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), kind: 'store', db: '/s/memory.db', ok: false, status: 1, error: 'boom' })}\n`);
      return m.turnRecordingLine(m.turnRecordingStatus({ db: '/s/memory.db', env: { RUVNET_BRAIN_HOME: brainHome } }));
    };
    expect(status(await load('turn-capture-state.mjs'))).toMatch(/^turn recording failing 1\/1/);
    expect(status(await load('turn-capture-state.mjs', 'else { status.failed += 1;', 'else {'))).not.toMatch(/failing/);
  });
});

it('the fake ruflo binary runs on this platform', () => {
  expect(spawnSync(process.execPath, ['--version']).status).toBe(0);
});
