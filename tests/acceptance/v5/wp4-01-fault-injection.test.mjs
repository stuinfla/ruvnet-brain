// WP4 fault injection: the installer is killed (SIGKILL, so no cleanup code runs) at every step of an
// install, of an update, and of an update that fails after the switch. After each kill a search
// answers from whatever the pointer names, and the next run of the same command ends in exactly the
// state a run that was never interrupted ends in: the same files, the same pointer, no leftovers.
// Break: the journal is not read (recovery removed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, KILL_STEP, layout, pointerOf } from './wp4-helpers.mjs';
import { THREE, repo, setup } from './helpers.mjs';

const BROKEN_WORKER = {
  file: 'packages/server/worker.mjs',
  find: "parentPort.on('message', (m) => {",
  replace: "parentPort.on('message', (m) => {\n  if (m) { parentPort.postMessage({ id: m.id, ok: false, error: 'this app build is broken (test fixture)' }); return; }",
};

const stepsOf = (r) => r.stderr.split('\n').filter((l) => l.startsWith('wp4-step ')).map((l) => l.slice(9));

function leftovers(home) {
  const bad = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(home, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (/\.(partial|tmp)$|\.damaged-|^state\/(journal|lock)\.json$/.test(r)) bad.push(r);
      if (e.isDirectory()) walk(r);
    }
  })('');
  return bad;
}

test('WP4-01 a kill at any step of install or update is undone or finished by the next run', { timeout: 590_000 }, async (t) => {
  const ctx = setup(t, 'wp4-01');
  const tree = ctx.tree({ patches: [KILL_STEP] });
  const broken = ctx.tree({ patches: [KILL_STEP, BROKEN_WORKER], keys: tree.keys });
  const rel1 = tree.release(tree.build(THREE), { number: 1, version: '5.0.1' });
  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const rel2 = tree.release(pack2, { number: 2, version: '5.0.2' });
  const relBad = broken.release(pack2, { number: 2, version: '5.0.3' });

  const fresh = () => {
    const h = ctx.tmp('rb5-home-');
    assertScratch(h);
    return h;
  };
  const base = fresh();
  const r0 = tree.cli(base, ['install', '--from', rel1]);
  assert.equal(r0.status, 0, r0.stderr);
  const installSteps = stepsOf(r0);
  const afterInstall = layout(base);
  const before = fs.readFileSync(path.join(base, 'current.json'), 'utf8');
  const copyBase = () => {
    const h = fresh();
    fs.cpSync(base, h, { recursive: true });
    return h;
  };
  const u0home = copyBase();
  const u0 = tree.cli(u0home, ['update', '--from', rel2]);
  assert.equal(u0.status, 0, u0.stderr);
  const updateSteps = stepsOf(u0);
  const afterUpdate = layout(u0home);
  const b0 = tree.cli(copyBase(), ['update', '--from', relBad]);
  assert.equal(b0.status, 1, 'the broken update is rolled back');
  const badSteps = stepsOf(b0);
  assert.ok(installSteps.length >= 12 && updateSteps.length >= 12 && badSteps.length >= 9, `steps: ${installSteps} | ${updateSteps} | ${badSteps}`);

  const cases = [
    { name: 'install', steps: installSteps, home: fresh, args: ['install', '--from', rel1], want: afterInstall, exit: 0 },
    { name: 'update', steps: updateSteps, home: copyBase, args: ['update', '--from', rel2], want: afterUpdate, exit: 0 },
    { name: 'failing update', steps: badSteps, home: copyBase, args: ['update', '--from', relBad], want: afterInstall, exit: 1 },
  ];
  let kills = 0;
  for (const c of cases) {
    for (let n = 1; n <= c.steps.length; n++) {
      const home = c.home();
      const k = tree.cli(home, c.args, { env: { WP4_KILL_AT: String(n) } });
      const at = `${c.name} killed at step ${n} (${c.steps[n - 1]})`;
      assert.ok(k.signal === 'SIGKILL' || (process.platform === 'win32' && k.status !== 0), `${at}: the run must die by the kill, got status ${k.status}`);
      assert.equal(stepsOf(k).length, n, `${at}: died at the wrong step`);
      kills++;

      if (pointerOf(home)) {
        const srv = await ctx.server(tree, home);
        const r = await srv.search('gloamwick journal');
        // A broken app that was switched in when the kill came answers in keyword-only safe mode
        // until the next run puts the pointer back; every other state answers normally.
        assert.ok(!r.isError && r.files.length > 0, `${at}: a session opened now must still answer: ${r.text.slice(0, 200)}`);
        if (c.name !== 'failing update') assert.equal(r.mode, 'MODE · normal', `${at}: a session opened now must search normally: ${r.mode}`);
        await srv.close();
      } else assert.equal(c.name, 'install', `${at}: an update must never leave the home without a pointer`);

      const again = tree.cli(home, c.args);
      assert.equal(again.status, c.exit, `${at}: the rerun ended with ${again.status}: ${again.stderr}`);
      assert.deepEqual(layout(home), c.want, `${at}: after the rerun the home must match an uninterrupted ${c.name}`);
      assert.deepEqual(leftovers(home), [], `${at}: leftovers after the rerun`);
      if (c.name === 'failing update') assert.equal(fs.readFileSync(path.join(home, 'current.json'), 'utf8'), before, `${at}: the pointer must be back byte for byte`);
    }
  }
  t.diagnostic(`${kills} kills: install ${installSteps.length} steps (${installSteps.join(' ')}), update ${updateSteps.length}, failing update ${badSteps.length}`);
});
