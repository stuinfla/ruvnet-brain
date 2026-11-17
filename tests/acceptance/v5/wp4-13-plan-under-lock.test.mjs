// WP4 / review F10: (1) every decision that depends on the home is made under the install lock. An
// install of release 2 is held after its first plan; release 3 installs completely meanwhile; when the
// held run continues it must refuse release 2 as older than the installed 3, not put 2 over it from
// its stale plan. (2) A first web install killed after it committed, before it recorded its address
// as the update source, is finished by the next run with that address recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, repo, setup, waitFor } from './helpers.mjs';
import { KILL_STEP, cliAsync, pointerOf, serveRelease } from './wp4-helpers.mjs';

const HOLD = {
  file: 'packages/cli/install.mjs',
  find: '  const first = await makePlan(home, release, src);\n  if (planOnly) return { plan: first, src };\n',
  replace: "  const first = await makePlan(home, release, src);\n  if (planOnly) return { plan: first, src };\n  if (process.env.WP4_HOLD) { fs.writeFileSync(`${process.env.WP4_HOLD}.ready`, ''); while (fs.existsSync(process.env.WP4_HOLD)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }\n",
};
const stepsOf = (r) => r.stderr.split('\n').filter((l) => l.startsWith('wp4-step ')).map((l) => l.slice(9));

test('WP4-13 the install plan is made under the lock, and committed recovery records the update source (review F10)', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp4-13');
  const tree = ctx.tree({ patches: [HOLD, KILL_STEP] });
  const rel1 = tree.release(tree.build(THREE), { number: 1, version: '5.0.1' });
  const pack2 = tree.build([...THREE, repo('delta-graph')]);
  const rel2 = tree.release(pack2, { number: 2, version: '5.0.2' });
  const rel3 = tree.release(pack2, { number: 3, version: '5.0.3' });

  // (1) A held install of release 2, overtaken by release 3.
  const home = ctx.tmp('rb5-home-');
  assert.equal(tree.cli(home, ['install', '--from', rel1]).status, 0);
  const hold = path.join(ctx.tmp('rb5-hold-'), 'hold');
  fs.writeFileSync(hold, '');
  const held = cliAsync(tree, home, ['update', '--from', rel2], { env: { WP4_HOLD: hold } });
  await waitFor(() => fs.existsSync(`${hold}.ready`), 60_000, 'the held install to finish its first plan');
  const three = tree.cli(home, ['update', '--from', rel3]);
  assert.equal(three.status, 0, `release 3 installs while release 2 is held: ${three.stderr}`);
  fs.rmSync(hold);
  const two = await held;
  assert.equal(pointerOf(home).releaseNumber, 3, `release 3 must stay installed; the held run left release ${pointerOf(home).releaseNumber} (${two.stdout}${two.stderr})`);
  assert.notEqual(two.status, 0, `the held release 2 must be refused: ${two.stdout}${two.stderr}`);
  assert.match(two.stderr, /release 2 is older than the installed release 3/);

  // (2) A first web install killed between its commit and recording its address.
  const web = await serveRelease(rel1);
  t.after(() => web.close());
  const fresh = ctx.tmp('rb5-home-');
  const full = await cliAsync(tree, ctx.tmp('rb5-home-'), ['install', '--from', web.url]);
  assert.equal(full.status, 0, full.stderr);
  const at = stepsOf(full).indexOf('record-config') + 1;
  assert.ok(at > 0, `the install has a step between its commit and recording the address: ${stepsOf(full)}`);
  const killed = await cliAsync(tree, fresh, ['install', '--from', web.url], { env: { WP4_KILL_AT: String(at) } });
  assert.ok(killed.signal === 'SIGKILL' || killed.status !== 0, 'the run dies by the kill');
  const cfgFile = path.join(fresh, 'state', 'config.json');
  const cfg = () => (fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {});
  assert.equal(cfg().updateUrl ?? null, null, 'killed before the address was recorded');
  const again = tree.cli(fresh, ['clean']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /finished an interrupted install/);
  assert.equal(cfg().updateUrl, web.url, 'recovery of the committed install records its update source');
});
