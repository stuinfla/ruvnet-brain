// WP9-01 migration beside 4.7. On a synthetic 4.7.28 installation (a public store, two private stores
// whose text carries a random canary, a recorded "no" to automatic updates, the 03:30 job's files and
// the 4.7 host entries): the plan changes nothing; --apply installs version 5 beside 4.7 and version 5
// answers; automatic update is off; not one byte of private text is in the version 5 home; every file
// of 4.7 (home, job file, link) is byte-identical; no host file is touched without --register-hosts.
// A 4.7 home that is a link to another disk gets its version 5 home on that disk, behind a link.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_ENV, THREE, setup } from './helpers.mjs';
import { filesContaining, hashTree, make47, runCli, searchV5, world47 } from './wp9-helpers.mjs';

const Q = 'how does the quillfeather index descend its layers with marrowlight';

test('WP9-01 migrate puts version 5 beside 4.7 and changes nothing of 4.7', { timeout: 400_000 }, async (t) => {
  const ctx = setup(t, 'wp9-01');
  const tree = ctx.tree();
  const rel = tree.release(tree.build(THREE));
  const s = make47(ctx);
  const before = world47(s);
  const hostsBefore = hashTree(s.claude);
  const codexBefore = fs.readFileSync(s.codexToml, 'utf8');

  // The plan: everything it will do and leave, and nothing written.
  const plan = runCli(tree, s, ['migrate', '--from', rel]);
  assert.equal(plan.status, 0, plan.stderr);
  for (const want of [/private store client-meetings .*NOT carried/, /private store owner-notes .*NOT carried/, /scheduled job \(launchd\).*left in place/, /auto-update off/, /4\.7 files changed: none/]) {
    assert.match(plan.stdout, want, `the plan must say ${want}`);
  }
  assert.match(plan.stdout, new RegExp(`everything else in ${s.defaultHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(5 entries besides kb/.*\\): left in place, not used by version 5`), 'the plan lists what it leaves');
  assert.match(plan.stdout, /model-routing system .*model-router: left in place, not used by version 5/, 'and the 4.7 router folder');
  assert.equal(fs.existsSync(s.home5), false, 'the plan must write nothing');
  assert.deepEqual(world47(s), before, 'the plan must not change 4.7');

  // Under the test marker a 4.7 home under a protected folder is refused before anything is read.
  const guarded = runCli(tree, s, ['migrate', '--from', rel], { RUVNET_BRAIN5_PROTECTED_HOME: s.user });
  assert.equal(guarded.status, 1, `a test run must refuse a 4.7 home under a protected folder: ${guarded.stdout}`);
  assert.match(guarded.stderr, /migrate refused: test run \(RUVNET_BRAIN5_TEST=1\): .* is under the protected home/);

  // Apply.
  const r = runCli(tree, s, ['migrate', '--apply', '--from', rel]);
  assert.equal(r.status, 0, `migrate --apply failed: ${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /private stores left in 4\.7, not carried: client-meetings, owner-notes/);
  const res = await searchV5(ctx, tree, s.home5, Q);
  assert.equal(res.files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', `version 5 must answer after migration: ${res.text.slice(0, 300)}`);
  const cfg = JSON.parse(runCli(tree, s, ['config', 'show']).stdout);
  assert.equal(cfg.autoUpdate, false, 'the recorded "no" to automatic updates must be carried');
  assert.deepEqual(filesContaining(s.home5, s.canary), [], 'no private text may reach the version 5 home');
  assert.equal(fs.existsSync(path.join(s.home5, 'private')), false, 'nothing is carried into private/ by this command');
  assert.deepEqual(world47(s), before, 'migration must not change one byte of 4.7');
  assert.deepEqual(hashTree(s.claude), hostsBefore, 'no host file is touched without --register-hosts');
  assert.equal(fs.readFileSync(s.codexToml, 'utf8'), codexBefore, 'the Codex settings are untouched');
  const rec = JSON.parse(fs.readFileSync(path.join(s.home5, 'state', 'migration.json'), 'utf8'));
  assert.equal(rec.step, 'done');
  assert.deepEqual(rec.privateLeft.sort(), ['client-meetings', 'owner-notes']);

  // Running it again is harmless.
  const again = runCli(tree, s, ['migrate', '--apply', '--from', rel]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already migrated/);
  assert.deepEqual(world47(s), before);

  // 4.7 moved to another disk: version 5's home goes on that disk, behind a link at the usual place.
  const m = make47(ctx, { autoUpdate: 'yes', linked: true });
  const mBefore = world47(m);
  const lr = runCli(tree, m, ['migrate', '--apply', '--from', rel], { [HOME_ENV]: '' });
  assert.equal(lr.status, 0, `${lr.stdout}\n${lr.stderr}`);
  assert.equal(fs.lstatSync(m.home5).isSymbolicLink(), true, 'the version 5 home is a link at the usual place');
  assert.equal(fs.realpathSync(m.home5), path.join(fs.realpathSync(path.dirname(m.real)), 'ruvnet-brain-5'), 'and its folder is next to the 4.7 folder');
  assert.ok(fs.existsSync(path.join(m.home5, 'current.json')), 'version 5 is installed there');
  assert.deepEqual(world47(m), mBefore, 'the moved 4.7 is unchanged');
  const mcfg = JSON.parse(runCli(tree, m, ['config', 'show']).stdout);
  assert.equal(mcfg.autoUpdate, true, 'a "yes" leaves the default');

  // 4.7 switched off by its own switch: version 5 is installed with the brake on and is not registered.
  const o = make47(ctx, { brainOff: true });
  const oHosts = hashTree(o.claude);
  const or = runCli(tree, o, ['migrate', '--apply', '--from', rel, '--register-hosts']);
  assert.equal(or.status, 0, `${or.stdout}\n${or.stderr}`);
  assert.match(or.stdout, /host registration skipped: 4\.7 was switched off/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(o.home5, 'state', 'brake.json'), 'utf8')).on, true, 'the 4.7 "off" is carried as the brake');
  assert.deepEqual(hashTree(o.claude), oHosts, 'a switched-off brain is not registered with any host');
  assert.ok(fs.existsSync(o.offFile), "4.7's own switch file is left where it is");
});
