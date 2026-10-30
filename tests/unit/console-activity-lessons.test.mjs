// console-activity-lessons.test.mjs — issue #499: Brain Activity showed an unreadable count as 0 and
// confused two different things under the word "lessons".
//   approvedLessons = the ratified rules in the machine-wide lesson store (what the Lessons card lists)
//   agentdbLessons  = rows in this project's AgentDB `lessons` namespace
// An AgentDB that is empty reads 0; one that cannot be read reads null (Unknown) — never 0.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { scratch, makeRunner, IMPORT, REPO } from './helpers/console-child.mjs';

let tmp;
beforeEach(() => { tmp = scratch('console-act-les-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const row = (id, status = 'ratified', extra = {}) => ({
  id, statement: `Rule ${id}: check the real source before stating the fact.`, trigger: 'assert-fact',
  enforcement: 'checklist', evidence: [{ observed: `fixture ${id}` }], origin: 'user-stated',
  sourceClass: 'current-user', status, ratifiedBy: status === 'candidate' ? null : 'user', demoted: false, ...extra,
});
const writeLessons = (rows) => {
  const f = path.join(tmp, 'lessons.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, updated: new Date().toISOString(), lessons: rows }));
  return f;
};
const proj = () => path.join(tmp, 'proj');
const dbFile = () => path.join(proj(), '.swarm', 'memory.db');
function emptyDb() {
  fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
  const r = spawnSync('sqlite3', [dbFile(), 'CREATE TABLE memory_entries(key TEXT, namespace TEXT, status TEXT, type TEXT, content TEXT, access_count INTEGER, created_at INTEGER, updated_at INTEGER);']);
  if (r.status !== 0) throw new Error('seed failed');
}
function activity(store) {
  const { runJSON } = makeRunner(tmp);
  return runJSON(`${IMPORT} console.log(JSON.stringify(m.gatherActivity(${JSON.stringify(proj())})));`, { RUVNET_LESSON_STORE: store });
}
const four = () => writeLessons([row('A'), row('B'), row('C', 'active'), row('D'), row('E', 'candidate'), row('F', 'ratified', { demoted: true })]);

describe('#499 server figures', () => {
  it('4 approved lessons and an AgentDB with 0 lesson rows: approvedLessons 4, agentdbLessons 0, memories 0', () => {
    emptyDb();
    const d = activity(four());
    expect(d.approvedLessons).toMatchObject({ available: true, count: 4, applicable: 4 }); // 4 unscoped rules apply everywhere
    expect(d.totals.agentdbLessons).toBe(0);
    expect(d.totals.lessons).toBe(0); // legacy alias
    expect(d.totals.memories).toBe(0);
  });

  it('a corrupt memory.db reports memories/lessons as null (unknown), not 0', () => {
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    fs.writeFileSync(dbFile(), 'this is not a sqlite database '.repeat(50));
    const d = activity(four());
    expect(d.hasStore).toBe(true);
    expect(d.totals.memories).toBeNull();
    expect(d.totals.agentdbLessons).toBeNull();
    expect(d.approvedLessons.count).toBe(4);
  });

  it('no store at all still returns the approvals', () => {
    fs.mkdirSync(proj(), { recursive: true });
    const d = activity(four());
    expect(d.hasStore).toBe(false);
    expect(d.approvedLessons).toMatchObject({ available: true, count: 4, applicable: 4 });
  });

  it('an unreadable lesson store is available:false, never a zero count', () => {
    fs.mkdirSync(proj(), { recursive: true });
    const f = path.join(tmp, 'lessons.json');
    fs.writeFileSync(f, '{ not json');
    const d = activity(f);
    expect(d.approvedLessons.available).toBe(false);
    expect(d.approvedLessons.count).toBeNull();
  });
});

describe('#499 client figures (console/activity.js loaded in a node:vm, no DOM)', () => {
  const ctx = { document: { getElementById: () => null }, fetch: () => { throw new Error('must not fetch'); }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'console/activity.js'), 'utf8'), ctx);
  const F = (d) => JSON.parse(JSON.stringify(ctx.activityFigures(d)));

  it('renders Unknown for every null, 0 only for a real zero', () => {
    const f = F({ totals: { memories: null, agentdbLessons: null }, approvedLessons: { available: false, count: null }, machine: { totalMemories: null, warming: true } });
    expect([f.memories, f.agentdbLessons, f.approvedLessons, f.machine]).toEqual(['Unknown', 'Unknown', 'Unknown', 'Unknown']);
    const z = F({ totals: { memories: 0, agentdbLessons: 0 }, approvedLessons: { available: true, count: 4 }, machine: { totalMemories: 1234 } });
    expect([z.memories, z.agentdbLessons, z.approvedLessons, z.machine]).toEqual(['0', '0', '4', '1,234']);
  });

  it('missing payload pieces are Unknown, and the legacy `lessons` field is still honoured', () => {
    expect(F({}).memories).toBe('Unknown');
    expect(F({ totals: { lessons: 7 } }).agentdbLessons).toBe('7'); // sync-version-ignore: the literal IS the fixture (input 7 must render as '7'), not a derivable product fact
  });

  it('the false claim is gone from the source', () => {
    const src = fs.readFileSync(path.join(REPO, 'console/activity.js'), 'utf8');
    expect(src).not.toMatch(/no automatic distillation|no auto-distill/i);
  });
});

describe('#499 applicable vs machine-wide approvals, with their metadata', () => {
  const scoped = () => writeLessons([
    row('UNSCOPED'),                                        // applies anywhere, by declaration
    row('HERE', 'ratified', { projects: ['Code-proj'] }),   // stored names carry a Code- prefix
    row('OTHER', 'ratified', { projects: ['elsewhere'] }),  // another project's lesson: approved, not applicable
    row('SUFFIX', 'ratified', { projects: ['myproj'] }),    // a bare shared tail ("proj") must NOT match
    row('UNIVERSAL', 'active', { projects: ['alpha', 'beta'], enforcement: 'inject' }), // proven in >= 2 projects
    row('CAND', 'candidate'),                               // not approved
  ]);

  it('count is machine-wide, applicable is this project only, by the same rule as lesson-gate', () => {
    emptyDb();
    const d = activity(scoped());
    expect(d.approvedLessons.count).toBe(5);
    expect(d.approvedLessons.applicable).toBe(3);
    expect(d.approvedLessons.items.map((i) => i.id).sort()).toEqual(['HERE', 'UNIVERSAL', 'UNSCOPED']);
  });

  it('a linked worktree is judged by the canonical project name, exactly as the gate does (one rule)', async () => {
    const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }); if (r.status !== 0) throw new Error(r.stderr); };
    const main = path.join(tmp, 'proj-main'); fs.mkdirSync(main, { recursive: true });
    git(main, 'init', '-q'); git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'i');
    const wt = path.join(tmp, 'feature-branch-x'); git(main, 'worktree', 'add', '-q', '-b', 'fx', wt);
    const store = writeLessons([row('HOME', 'ratified', { projects: ['proj-main'] }), row('WTNAME', 'ratified', { projects: ['feature-branch-x'] })]);
    const { runJSON } = makeRunner(tmp);
    const d = runJSON(`${IMPORT} console.log(JSON.stringify(m.gatherActivity(${JSON.stringify(wt)})));`, { RUVNET_LESSON_STORE: store });
    expect(d.approvedLessons.items.map((i) => i.id)).toEqual(['HOME']);
    const { lessonApplies, projectNameFor } = await import('../../plugin/scripts/lesson-store.mjs');
    expect(['HOME', 'WTNAME'].filter((id) => lessonApplies({ projects: id === 'HOME' ? ['proj-main'] : ['feature-branch-x'] }, projectNameFor(wt)))).toEqual(['HOME']);
  });

  it('each applicable lesson carries id/title/scope/enforcement/ratified, bounded', () => {
    emptyDb();
    const u = activity(scoped()).approvedLessons.items.find((i) => i.id === 'UNIVERSAL');
    expect(u).toMatchObject({ id: 'UNIVERSAL', scope: 'alpha, beta', enforcement: 'inject', ratified: true, status: 'active' });
    expect(u.title).toMatch(/^Rule UNIVERSAL/);
    const many = writeLessons(Array.from({ length: 40 }, (_, i) => row(`L${i}`)));
    const a = activity(many).approvedLessons;
    expect(a.applicable).toBe(40);
    expect(a.items).toHaveLength(25);
    expect(a.itemsTruncated).toBe(true);
  });

  it('observations, patterns and episodes are each measured; an unreadable table is null, not 0', () => {
    emptyDb();
    const sql = ["INSERT INTO memory_entries VALUES('o1','learning-observations','active','x','c',0,1,1);",
      "INSERT INTO memory_entries VALUES('o2','learning-observations','active','x','c',0,1,1);",
      "INSERT INTO memory_entries VALUES('o3','learning-observations','deleted','x','c',0,1,1);",
      'CREATE TABLE reasoning_patterns(id INTEGER); INSERT INTO reasoning_patterns VALUES(1);'].join(' ');
    expect(spawnSync('sqlite3', [dbFile(), sql]).status).toBe(0);
    const t = activity(four()).totals;
    expect(t.observations).toBe(2);   // active rows in learning-observations only
    expect(t.patterns).toBe(1);
    expect(t.episodes).toBeNull();    // no episodes table: Unknown, never 0
  });
});

describe('#499 client copy and fallback (console/activity.js in node:vm)', () => {
  const load = (document, fetchImpl) => {
    const ctx = { document, fetch: fetchImpl, console, setInterval: () => 0, setTimeout: () => 0 };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(REPO, 'console/activity.js'), 'utf8'), ctx);
    return ctx;
  };
  const base = load({ getElementById: () => null }, () => { throw new Error('must not fetch'); });
  const j = (v) => JSON.parse(JSON.stringify(v));
  const d = { totals: { memories: 1500, agentdbLessons: 0, observations: 1450, patterns: 658, episodes: 658 },
    approvedLessons: { available: true, count: 9, applicable: 4, items: [{ id: 'A1', title: 'Check <b>the</b> source', scope: 'all projects', enforcement: 'review', ratified: true, status: 'ratified' }], itemsTruncated: false },
    machine: { totalMemories: 9000 } };

  it('narration quotes the pipeline\'s own measurements and never claims distillation makes lessons', () => {
    const text = j(base.activityNarration(d)).join(' | ');
    expect(text).toContain('1,450 workflow observations');
    expect(text).toContain('658 structural patterns');
    expect(text).toContain('658 episodes');
    expect(text).toContain('4 approved lessons apply here (9 machine-wide)');
    expect(text).toMatch(/into patterns and episodes — not into lessons/);
    expect(text).not.toMatch(/0 lessons distilled|no auto-distill/i);
  });

  it('a pipeline count that is unreadable reads Unknown in the narration', () => {
    const text = j(base.activityNarration({ ...d, totals: { memories: 5, agentdbLessons: 0, observations: null, patterns: null, episodes: null } })).join(' | ');
    expect(text).toContain('Unknown workflow observations, Unknown structural patterns, Unknown episodes');
  });

  it('the drawer lists each applicable lesson with scope and enforcement, escaped, and says Unknown when unreadable', () => {
    const html = base.activityApprovedHTML(d);
    expect(html).toContain('4 approved lessons apply to this project · 9 approved machine-wide');
    expect(html).toContain('scope: all projects');
    expect(html).toContain('enforcement: review');
    expect(html).toContain('ratified by you');
    expect(html).not.toContain('<b>the</b>'); // title text is escaped
    expect(base.activityApprovedHTML({ approvedLessons: { available: false } })).toContain('Unknown');
  });

  it('the empty-lessons copy no longer implies distillation writes lesson rows', () => {
    const src = fs.readFileSync(path.join(REPO, 'console/activity.js'), 'utf8');
    expect(src).not.toMatch(/distilled in the background at session end or compaction when learning is on/);
    expect(src).toMatch(/Lessons are ratified by you; background distillation/);
  });

  it('no string on the card calls distillation output "lessons": records are lesson records, ratified ones approved lessons', () => {
    const src = fs.readFileSync(path.join(REPO, 'console/activity.js'), 'utf8');
    expect(src).not.toMatch(/distilled lessons|kept lessons|what survived distillation|what survives distillation/i);
    expect(src).not.toMatch(/ lessons — the keepers/);
    expect(src).not.toMatch(/ab-gate">distill</); // the gate is not a distillation of memories into lessons
    expect(src).toMatch(/lesson records — the keepers/);
    expect(src).toMatch(/Background distillation makes patterns and episodes, not lessons/);
    expect(src).not.toMatch(/F\.lessons \+ ' (?:distilled )?lessons/); // a bare AgentDB count is never labelled 'lessons'
  });

  it('degradeWithApprovals: with no readable project store the card still shows the independently readable approvals', async () => {
    const els = {};
    const el = (id) => (els[id] ??= { id, innerHTML: '', addEventListener() {}, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false } });
    const doc = { getElementById: el, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, addEventListener() {}, documentElement: {} };
    const payload = { hasStore: false, project: 'p', approvedLessons: d.approvedLessons, totals: undefined };
    load(doc, () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(els['body-activity'].innerHTML).toContain('memories: Unknown');
    expect(els['body-activity'].innerHTML).toContain('<b>9</b> approved lessons are in force on this machine');
    expect(els['body-activity'].innerHTML).toContain('<b>4</b> apply to this project');
    expect(els['chips-activity'].innerHTML).toContain('9 approved lessons (machine-wide)');
  });

  it('control: with no approvals either, the card degrades to the plain "not readable" notice', async () => {
    const els = {};
    const el = (id) => (els[id] ??= { id, innerHTML: '', addEventListener() {} });
    const doc = { getElementById: el, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, addEventListener() {}, documentElement: {} };
    load(doc, () => Promise.resolve({ ok: true, json: () => Promise.resolve({ hasStore: false, approvedLessons: { available: false } }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(els['body-activity'].innerHTML).toContain('memory store not readable right now');
  });
});
