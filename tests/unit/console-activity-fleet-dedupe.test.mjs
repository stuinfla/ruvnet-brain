// console-activity-fleet-dedupe.test.mjs — issue #500: the fleet scan counted ONE database twice.
//
// THE DEFECT. findMemoryStores() recorded `project: dir` for every `.swarm` directory it met. A nested
// docs/adr/.swarm (it held only learning-metadata.json) resolves, through resolveProjectStore, to the
// PARENT repo's canonical store — so the same memory.db was listed under two project paths and its rows
// were summed twice into "memories machine-wide".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratch, seedMemoryDb, makeRunner, IMPORT } from './helpers/console-child.mjs';
import { findMemoryStores } from '../../scripts/onboarding-console.mjs';

let tmp;
beforeEach(() => { tmp = scratch('console-fleet-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return fs.realpathSync(dir);
}

describe('#500 findMemoryStores', () => {
  it('a nested docs/adr/.swarm that resolves to the parent store yields ONE database, named for the project root', () => {
    const proj = gitRepo(path.join(tmp, 'root', 'alpha'));
    seedMemoryDb(path.join(proj, '.swarm', 'memory.db'), 3);
    fs.mkdirSync(path.join(proj, 'docs', 'adr', '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'adr', '.swarm', 'learning-metadata.json'), '{}');
    const found = findMemoryStores(path.join(tmp, 'root'));
    expect(found).toHaveLength(1);
    expect(found[0].db).toBe(path.join(proj, '.swarm', 'memory.db'));
    expect(found[0].project).toBe(proj); // the resolved root, not docs/adr
  });

  it('same-named independent repos stay separate', () => {
    const a = gitRepo(path.join(tmp, 'root', 'a', 'app'));
    const b = gitRepo(path.join(tmp, 'root', 'b', 'app'));
    seedMemoryDb(path.join(a, '.swarm', 'memory.db'), 2);
    seedMemoryDb(path.join(b, '.swarm', 'memory.db'), 5);
    const found = findMemoryStores(path.join(tmp, 'root'));
    expect(found.map((f) => f.db).sort()).toEqual([path.join(a, '.swarm', 'memory.db'), path.join(b, '.swarm', 'memory.db')].sort());
  });
});

describe('#500 stale cache is not trusted', () => {
  const cachePath = () => path.join(tmp, '.cache', 'ruvnet-brain', 'console-cache.json');
  const seed = (activity) => {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ activity, trust: null }));
  };
  const machineFor = (activity) => {
    const proj = path.join(tmp, 'proj');
    seed(activity);
    const db = path.join(proj, '.swarm', 'memory.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const r = spawnSync('sqlite3', [db, "CREATE TABLE memory_entries(key TEXT, namespace TEXT, status TEXT, type TEXT, content TEXT, access_count INTEGER, created_at INTEGER, updated_at INTEGER);"]);
    if (r.status !== 0) throw new Error('seed failed');
    const { runJSON } = makeRunner(tmp);
    return runJSON(`${IMPORT} console.log(JSON.stringify(m.gatherActivity(${JSON.stringify(proj)}).machine));`);
  };
  const body = { at: Date.now(), projects: [{ name: 'x', rel: 'x', memories: 999, lastTouched: 1 }], totalMemories: 999 };

  it('control: a current-schema cache is adopted', () => {
    expect(machineFor({ ...body, schema: 3 }).totalMemories).toBe(999);
  });
  it('an old (schema-less) cache is ignored: the page says warming, never the old double-counted total', () => {
    const m = machineFor(body);
    expect(m.warming).toBe(true);
    expect(m.totalMemories).toBeNull();
  });
});
