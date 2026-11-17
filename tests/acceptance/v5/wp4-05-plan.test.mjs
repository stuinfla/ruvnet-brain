// WP4 install --plan: the plan printed before an install, an update and an update that retires a
// generation equals what the real run then writes and removes (compared file by file), every path
// seen while it runs (a recursive folder watch) is either in the plan or one of its temporary names,
// `--plan` itself writes nothing, and nothing changes outside the brain home (the user's home folder
// is snapshotted too). Break: the installer writes one file outside the plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_HOME, assertScratch, diff, snapshot } from './wp4-helpers.mjs';
import { THREE, repo, setup, sleep } from './helpers.mjs';

function parsePlan(stdout) {
  const sections = {};
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (/^\S.*:$/.test(line)) sections[(cur = line.slice(0, -1))] = [];
    else if (line.startsWith('  ') && cur) sections[cur].push(line.trim());
    else cur = null;
  }
  return sections;
}

const globRx = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/<pid>/g, '\\d+').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const files = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.endsWith('/')));

async function watched(dir, prefix, run) {
  const seen = new Set();
  const w = fs.watch(dir, { recursive: true }, (_, name) => name && seen.add(String(name).split(path.sep).join('/')));
  try {
    const r = run();
    await sleep(300);
    return { r, seen: [...seen].filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)).filter(Boolean) };
  } finally {
    w.close();
  }
}

test('WP4-05 install --plan lists exactly what the install writes', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp4-05');
  const tree = ctx.tree();
  const rels = [
    tree.release(tree.build(THREE), { number: 1, version: '5.0.1' }),
    tree.release(tree.build([...THREE, repo('delta-graph')]), { number: 2, version: '5.0.2' }),
    tree.release(tree.build(THREE.slice(0, 2)), { number: 3, version: '5.0.3' }),
  ];
  const parent = ctx.tmp('rb5-parent-');
  const home = path.join(parent, 'brain');
  assertScratch(home);
  const userBefore = snapshot(FAKE_HOME);
  let seenTotal = 0;

  for (const [i, rel] of rels.entries()) {
    const verb = i ? 'update' : 'install';
    const before = files(snapshot(home));
    const pl = tree.cli(home, [verb, '--from', rel, '--plan']);
    assert.equal(pl.status, 0, pl.stderr);
    if (!i) assert.equal(fs.existsSync(home), false, '--plan must not create the brain home');
    const plan = parsePlan(pl.stdout);
    assert.ok(plan['will write']?.length > 10 && plan['temporary (removed before the command ends)'], `the plan must list its writes: ${pl.stdout}`);
    assert.deepEqual(files(snapshot(home)), before, '--plan must write nothing');

    const { r, seen } = await watched(parent, 'brain/', () => tree.cli(home, [verb, '--from', rel]));
    assert.equal(r.status, 0, r.stderr);
    const d = diff(before, files(snapshot(home)));
    const wrote = [...d.added, ...d.changed].sort();
    // A `**` entry is a folder the run replaces whole (the shim): its files are matched by pattern, and
    // the first install must write each one; every other entry is one exact file.
    const globs = plan['will write'].filter((w) => w.includes('*')).map(globRx);
    const literal = plan['will write'].filter((w) => !w.includes('*'));
    assert.deepEqual(wrote.filter((f) => !globs.some((rx) => rx.test(f))), [...literal].sort(), `${verb} ${i + 1}: the files written must be exactly the plan's (a file outside the plan was written, or a planned one was not)`);
    if (!i) for (const rx of globs) assert.ok(wrote.some((f) => rx.test(f)), `${verb} ${i + 1}: the planned ${rx} was not written`);
    const removedDirs = plan['will remove'];
    for (const f of d.removed) assert.ok(removedDirs.some((x) => f.startsWith(`${x}/`)), `${verb} ${i + 1}: ${f} was removed but is not in the plan's removals`);
    for (const x of removedDirs) assert.equal(fs.existsSync(path.join(home, ...x.split('/'))), false, `${x} is planned for removal and is still there`);
    const allowed = [...plan['will write'], ...plan['temporary (removed before the command ends)']].map(globRx);
    const stray = seen.filter((n) => !allowed.some((rx) => rx.test(n) || rx.test(`${n}/_`)) && !plan['will write'].some((w) => w.startsWith(`${n}/`)) && !removedDirs.some((x) => n === x || n.startsWith(`${x}/`)) && !['app', 'packs', 'state', 'state/status'].includes(n));
    assert.deepEqual(stray, [], `${verb} ${i + 1}: paths seen during the run that are outside the plan`);
    if (i === 2) assert.ok(removedDirs.length === 2, `the third release retires the first generation: ${removedDirs}`);
    seenTotal += seen.length;
  }
  assert.deepEqual(snapshot(FAKE_HOME), userBefore, 'nothing may change in the user home folder');
  t.diagnostic(`${seenTotal} paths observed by the folder watch`);
});
