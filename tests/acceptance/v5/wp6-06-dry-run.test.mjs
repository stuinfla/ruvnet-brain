// WP6: a dry-run release into a fork-like channel (a folder) goes seal, pre-release, install-and-probe,
// promote; promotion is refused when any one operating system's probe failed or is missing.
// The install-and-probe step runs for real on this machine (real installer, real server, doctor).
// Linux, macOS and Windows each run it in the release-candidate workflow's matrix; here the receipts
// for the two other systems are copies of this machine's real receipt relabelled, standing in for
// those matrix legs (they test promotion's rule, not the other systems).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { THREE, repo, setup } from './helpers.mjs';
import { REQUIRED_OS, appVersion, gateFor, rail, sealed, writeJson } from './wp6-helpers.mjs';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('WP6 dry run: seal, pre-release, install-and-probe, promote; one failed system refuses promotion', { timeout: 420_000 }, async (t) => {
  const ctx = setup(t, 'wp6-06');
  const tree = ctx.tree();
  const version = appVersion(tree);
  const channel = ctx.tmp('rb5-wp6-fork-');

  // 1. seal, 2. pre-release: staged under a v5 tag that the 4.7 rail can never read as its own.
  const one = sealed(ctx, tree, { number: 1 });
  assert.equal(one.r.status, 0, one.r.out);
  const st = rail(tree, ['stage', '--release', one.rel, '--channel', channel]);
  assert.equal(st.status, 0, st.out);
  const tag = st.stdout.match(/staged (\S+)/)[1];
  assert.equal(tag, `brain5-${version}-r1`);
  assert.doesNotMatch(tag, /^v\d+\.\d+\.\d+$|^corpus-sha256-/, 'a v5 tag must never look like a 4.7 code or corpus release');
  assert.equal(fs.existsSync(path.join(channel, 'latest.json')), false, 'a pre-release is not what any machine reads');

  // 3. install-and-probe on this machine through the real installer and server.
  const receipts = ctx.tmp('rb5-wp6-rc-');
  const pr = rail(tree, ['probe', '--release', path.join(channel, 'staged', tag), '--out', path.join(receipts, 'here.json')]);
  assert.equal(pr.status, 0, `install-and-probe must pass on this machine: ${pr.out}`);
  const here = read(path.join(receipts, 'here.json'));
  assert.equal(here.ok, true);
  assert.ok(here.probes.length >= 3 && here.probes.every((p) => p.pass && p.mode === 'MODE · normal'), JSON.stringify(here.probes));
  assert.equal(here.doctor.exit, 0, `doctor's verdict while the server runs: ${here.doctor.line}`);
  assert.match(here.doctor.line, /OK/);
  assert.match(here.launcher ?? '', /^shim\/plugin\/claude\/bin\/rb5(\.cmd)?$/, 'the probe starts the server through the registered launcher, as a host does (review F05)');
  for (const os of REQUIRED_OS.filter((o) => o !== here.os)) writeJson(path.join(receipts, `${os}.json`), { ...here, os });
  const gate1 = path.join(ctx.tmp('rb5-wp6-gate-'), 'gate.json');
  writeJson(gate1, gateFor(path.join(channel, 'staged', tag)));

  // 4. promote: both pointers name the release.
  const outcome = path.join(ctx.tmp('rb5-wp6-out-'), 'outcome.json');
  const p1 = rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', version, '--receipts', receipts, '--gate', gate1, '--outcome', outcome]);
  assert.equal(p1.status, 0, `the dry run must promote: ${p1.out}`);
  assert.equal(read(outcome).outcome, 'published');
  assert.equal(read(path.join(channel, 'latest.json')).tag, tag);
  assert.equal(read(path.join(channel, 'packages.json')).tag, tag);
  const again = rail(tree, ['promote', '--channel', channel, '--tag', tag, '--version', version, '--receipts', receipts, '--gate', gate1]);
  assert.equal(again.status, 0, again.out);
  assert.match(again.stdout, /^no-change/, 'the same release promoted again is a no-change night');

  // A second release, probed on two systems only, or with one system failed, is not promoted.
  const two = sealed(ctx, tree, { number: 2, pack: tree.build([...THREE, repo('delta-graph')]) });
  assert.equal(two.r.status, 0, two.r.out);
  const st2 = rail(tree, ['stage', '--release', two.rel, '--channel', channel]);
  assert.equal(st2.status, 0, st2.out);
  const tag2 = st2.stdout.match(/staged (\S+)/)[1];
  const latestBefore = fs.readFileSync(path.join(channel, 'latest.json'));
  const rc2 = ctx.tmp('rb5-wp6-rc2-');
  const pr2 = rail(tree, ['probe', '--release', path.join(channel, 'staged', tag2), '--out', path.join(rc2, 'here.json')]);
  assert.equal(pr2.status, 0, pr2.out);
  const here2 = read(path.join(rc2, 'here.json'));
  const gate2 = path.join(ctx.tmp('rb5-wp6-gate-'), 'gate.json');
  writeJson(gate2, gateFor(path.join(channel, 'staged', tag2)));
  const promote2 = () => rail(tree, ['promote', '--channel', channel, '--tag', tag2, '--version', version, '--receipts', rc2, '--gate', gate2]);
  const others = REQUIRED_OS.filter((o) => o !== here2.os);
  writeJson(path.join(rc2, `${others[0]}.json`), { ...here2, os: others[0] });
  const missing = promote2();
  assert.notEqual(missing.status, 0, `promotion must be refused with a system's receipt missing: ${missing.out}`);
  assert.match(missing.stderr, new RegExp(`no install-and-probe receipt from ${others[1]}`));
  const failedOs = REQUIRED_OS.includes('windows') && here2.os !== 'windows' ? 'windows' : others[1];
  for (const os of others) writeJson(path.join(rc2, `${os}.json`), { ...here2, os, ...(os === failedOs ? { ok: false, error: 'probe "x" did not find its file' } : {}) });
  const failed = promote2();
  assert.notEqual(failed.status, 0, `promotion must be refused when the ${failedOs} probe failed: ${failed.out}`);
  assert.match(failed.stderr, new RegExp(`install-and-probe check failed on ${failedOs}`));
  assert.ok(Buffer.compare(latestBefore, fs.readFileSync(path.join(channel, 'latest.json'))) === 0, 'the promoted release must be untouched');

  // The probe step can fail: a signed release whose pack fails its probes gives a red receipt.
  // (signed with the low-level signer, which the workflow never calls, as S8 does).
  const badPack = tree.build([...THREE, repo('delta-graph')]);
  const db = new DatabaseSync(path.join(badPack, 'lexical.db'));
  db.exec('DELETE FROM fts');
  db.close();
  tree.reassemble(badPack);
  const bad = tree.release(badPack, { number: 3 });
  const r3 = path.join(ctx.tmp('rb5-wp6-rc3-'), 'r.json');
  const pr3 = rail(tree, ['probe', '--release', bad, '--out', r3]);
  assert.notEqual(pr3.status, 0, `a release whose pack fails its probes must give a failed receipt: ${pr3.out}`);
  assert.equal(read(r3).ok, false);
  assert.match(read(r3).error, /probes/);
});
