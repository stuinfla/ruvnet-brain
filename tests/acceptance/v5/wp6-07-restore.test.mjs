// WP6: a failure injected between "packages promoted" and "release promoted" restores the previous
// release. The fault is injected through the rail's channel interface (a channel whose release step
// throws), loaded from the scratch tree so the break applies; both pointers must come back byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { THREE, repo, setup } from './helpers.mjs';
import { appVersion, gateFor, rail, receiptsFor, sealed, writeJson } from './wp6-helpers.mjs';

test('WP6 a failure between the two promotions restores the previous release', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp6-07');
  const tree = ctx.tree();
  const version = appVersion(tree);
  const channel = ctx.tmp('rb5-wp6-ch-');
  const ready = (rel) => {
    const st = rail(tree, ['stage', '--release', rel, '--channel', channel]);
    assert.equal(st.status, 0, st.out);
    const tag = st.stdout.match(/staged (\S+)/)[1];
    const staged = path.join(channel, 'staged', tag);
    const receipts = receiptsFor(staged);
    return { tag, staged, receipts, gate: gateFor(staged) };
  };

  const one = sealed(ctx, tree, { number: 1 });
  assert.equal(one.r.status, 0, one.r.out);
  const r1 = ready(one.rel);
  const rc = ctx.tmp('rb5-wp6-rc-');
  r1.receipts.forEach((r) => writeJson(path.join(rc, `${r.os}.json`), r));
  const g = path.join(ctx.tmp('rb5-wp6-gate-'), 'gate.json');
  writeJson(g, r1.gate);
  const p1 = rail(tree, ['promote', '--channel', channel, '--tag', r1.tag, '--version', version, '--receipts', rc, '--gate', g]);
  assert.equal(p1.status, 0, p1.out);

  const two = sealed(ctx, tree, { number: 2, pack: tree.build([...THREE, repo('delta-graph')]) });
  assert.equal(two.r.status, 0, two.r.out);
  const r2 = ready(two.rel);
  const pointers = ['packages.json', 'latest.json'].map((f) => path.join(channel, f));
  const before = pointers.map((f) => fs.readFileSync(f));

  const { fsChannel, promote } = await import(pathToFileURL(path.join(tree.root, 'packages', 'release', 'promote.mjs')).href);
  const real = fsChannel(channel);
  let packagesMoved = false;
  const faulty = {
    ...real,
    promote(step, ...rest) {
      if (step === 'release') {
        packagesMoved = JSON.parse(fs.readFileSync(pointers[0], 'utf8')).tag === r2.tag;
        throw new Error('injected fault between packages promoted and release promoted');
      }
      return real.promote(step, ...rest);
    },
  };
  assert.throws(
    () => promote({ tag: r2.tag, channel: faulty, receipts: r2.receipts, gate: r2.gate, version, publicKeyPem: tree.keys.publicPem }),
    /promotion failed at the release step \(injected fault.*\); the previous release was restored/,
  );
  assert.equal(packagesMoved, true, 'the fault must land after the packages pointer moved');
  pointers.forEach((f, i) => assert.ok(Buffer.compare(before[i], fs.readFileSync(f)) === 0, `${path.basename(f)}: the previous release must be restored byte for byte`));
  assert.equal(JSON.parse(fs.readFileSync(pointers[1], 'utf8')).tag, r1.tag);

  // With no fault the same release promotes.
  const ok = promote({ tag: r2.tag, channel: real, receipts: r2.receipts, gate: r2.gate, version, publicKeyPem: tree.keys.publicPem });
  assert.equal(ok.outcome, 'published');
});
