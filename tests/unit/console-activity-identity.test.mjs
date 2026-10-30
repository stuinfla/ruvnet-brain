// console-activity-identity.test.mjs — issue #500: which project is "you" in the machine-wide list, and one
// database counted once. Identity is the store's dev:inode (pathIdentity), never the folder name.
//   same-named independent repos · a linked git worktree · a symlinked .swarm · a hard-linked memory.db ·
//   the fleet dedupe in refreshFleetCache · the schema check in loadConsoleCache · cache readback.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { scratch, makeRunner, IMPORT, REPO } from './helpers/console-child.mjs';

let tmp;
beforeEach(() => { tmp = scratch('console-ident-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
const repo = (dir) => { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'i'); return fs.realpathSync(dir); };
const idOf = (file) => { const s = fs.statSync(file); return `${s.dev}:${s.ino}`; };
// Entries scanned from the default `Code` and `src` roots under HOME=tmp.
const store = (p, rows) => {
  const db = path.join(p, '.swarm', 'memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const sql = ['CREATE TABLE memory_entries(key TEXT, namespace TEXT, status TEXT, type TEXT, content TEXT, access_count INTEGER, created_at INTEGER, updated_at INTEGER);'];
  for (let i = 0; i < rows; i++) sql.push(`INSERT INTO memory_entries VALUES ('k${i}','default','active','semantic','v',0,1,1);`);
  const r = spawnSync('sqlite3', [db, sql.join(' ')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return db;
};

function measure(projDir) {
  const { runJSON } = makeRunner(tmp);
  return runJSON(`${IMPORT} m.refreshFleetCache(); const a = m.gatherActivity(${JSON.stringify(projDir)}); console.log(JSON.stringify({ projectId: a.projectId, hasStore: a.hasStore, machine: a.machine }));`);
}

describe('#500 server identity', () => {
  it('two unrelated repos with the same folder name: each is itself; ids differ; both are listed', () => {
    const a = repo(path.join(tmp, 'Code', 'one', 'app')); const b = repo(path.join(tmp, 'src', 'two', 'app'));
    const da = store(a, 2); const db = store(b, 5);
    const r = measure(a);
    expect(r.projectId).toBe(idOf(da));
    expect(r.projectId).not.toBe(idOf(db));
    const apps = r.machine.projects.filter((p) => p.name === 'app');
    expect(apps.map((p) => p.id).sort()).toEqual([idOf(da), idOf(db)].sort());
    expect(r.machine.totalMemories).toBe(7);
    // the SAME fleet seen from the other repo must flip which row is "you"
    expect(measure(b).projectId).toBe(idOf(db));
  });

  it('a linked git worktree is the same project as its main checkout: one fleet row, one identity (refreshFleetCache dedupe)', () => {
    const main = repo(path.join(tmp, 'Code', 'main'));
    const dbm = store(main, 3);
    const wt = path.join(tmp, 'src', 'wt');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wtb');
    fs.mkdirSync(path.join(wt, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.swarm', 'learning-metadata.json'), '{}'); // a metadata-only .swarm, as in the report
    const r = measure(wt);
    expect(r.projectId).toBe(idOf(dbm));
    expect(r.machine.projects).toHaveLength(1);
    expect(r.machine.totalMemories).toBe(3); // 6 if the two scan roots' hits for one database were both summed
  });

  it('a symlinked .swarm resolves to the real store and is not counted again', () => {
    const real = repo(path.join(tmp, 'Code', 'real'));
    const dbr = store(real, 4);
    const lnk = repo(path.join(tmp, 'src', 'lnk'));
    fs.symlinkSync(path.join(real, '.swarm'), path.join(lnk, '.swarm'));
    const r = measure(real);
    expect(r.machine.totalMemories).toBe(4);
    expect(r.machine.projects.map((p) => p.id)).toEqual([idOf(dbr)]);
  });

  it('a hard-linked memory.db is refused by the resolver, so it is neither a second project nor a double count', () => {
    const real = repo(path.join(tmp, 'Code', 'real'));
    const dbr = store(real, 4);
    const hard = repo(path.join(tmp, 'src', 'hard'));
    fs.mkdirSync(path.join(hard, '.swarm'), { recursive: true });
    fs.linkSync(dbr, path.join(hard, '.swarm', 'memory.db'));
    expect(fs.statSync(dbr).nlink).toBe(2);
    expect(measure(hard).hasStore).toBe(false); // refused, not silently adopted
    const bystander = repo(path.join(tmp, 'Code', 'bystander'));
    store(bystander, 1);
    // The resolver refuses every name of a multiply-linked store, so the fleet holds only the bystander.
    expect(measure(bystander).machine.totalMemories).toBe(1);
  });
});

describe('#500 cache: schema check at startup (loadConsoleCache) and readback', () => {
  const cachePath = () => path.join(tmp, '.cache', 'ruvnet-brain', 'console-cache.json');
  const run = (src) => makeRunner(tmp).runJSON(`${IMPORT} ${src}`);
  const proj = () => { const p = repo(path.join(tmp, 'Code', 'proj')); store(p, 1); return p; };

  it('startup refuses a cache whose schema is old: loadConsoleCache() is false and the fleet is warming, not the old total', () => {
    const p = proj();
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ activity: { at: Date.now(), projects: [{ name: 'x', memories: 999 }], totalMemories: 999 }, trust: null }));
    const r = run(`const restored = m.loadConsoleCache(); const a = m.gatherActivity(${JSON.stringify(p)}); console.log(JSON.stringify({ restored, machine: a.machine }));`);
    expect(r.restored).toBe(false);
    expect(r.machine.warming).toBe(true);
    expect(r.machine.totalMemories).toBeNull();
  });

  it('readback: what one process measured and saved is what a fresh process restores, ids included', () => {
    const p = proj();
    const first = run(`m.refreshFleetCache(); console.log(JSON.stringify(m.gatherActivity(${JSON.stringify(p)}).machine));`);
    const again = run(`const restored = m.loadConsoleCache(); const a = m.gatherActivity(${JSON.stringify(p)}); console.log(JSON.stringify({ restored, machine: a.machine, projectId: a.projectId }));`);
    expect(again.restored).toBe(true);
    expect(again.machine.totalMemories).toBe(first.totalMemories);
    expect(again.machine.projects[0].id).toBe(again.projectId);
  });
});

describe('#500 client: "you are here" by identity, not folder name (console/activity.js in node:vm)', () => {
  const ctx = { document: { getElementById: () => null }, fetch: () => { throw new Error('must not fetch'); }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'console/activity.js'), 'utf8'), ctx);
  const U = (d) => JSON.parse(JSON.stringify(ctx.activityUniverse(d)));
  const fleet = [{ id: '1:10', name: 'app', memories: 5 }, { id: '1:20', name: 'app', memories: 2 }, { id: '1:30', name: 'other', memories: 1 }];

  it('picks the same-named row whose id matches, and leaves the other "app" among the others', () => {
    const u = U({ project: 'app', projectId: '1:20', machine: { projects: fleet } });
    expect(u.me.id).toBe('1:20');
    expect(u.others.map((p) => p.id)).toEqual(['1:10', '1:30']);
  });
  it('no identity on the payload means no match — never a guess from the name', () => {
    const u = U({ project: 'app', machine: { projects: fleet } });
    expect(u.me).toBeNull();
    expect(u.others).toHaveLength(3);
  });
});
