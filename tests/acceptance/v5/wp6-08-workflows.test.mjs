// WP6: the v5 workflow files, parsed (a strict YAML subset reader; see wp6-yaml.mjs). They are inert
// until cutover; no step can continue on error and no input or variable skips the gate; a pull
// request (from a fork or not) cannot start them, and the signing secret is only in the one seal step
// of an environment-bound job; every action is pinned to an exact commit and Node to an exact
// version; nothing is installed from the network; the only signing call is `rail.mjs seal`; and the
// one-publisher gate (scripts/release-authority.mjs) sees no publish operation in them or in
// packages/release, and does scan packages/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, setup } from './helpers.mjs';
import { workflows } from './wp6-helpers.mjs';
import { detectPublisherActions, findUnauthorizedPublishers } from '../../../scripts/release-authority.mjs';

const NAMES = ['v5-nightly-dispatch.yml', 'v5-pack-build.yml', 'v5-release-candidate.yml', 'v5-watchdog.yml'];
const GUARD = "github.repository == 'stuinfla/ruvnet-brain'";

function walk(v, fn, at = '') {
  fn(v, at);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${at}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, fn, `${at}.${k}`);
}

test('WP6 the v5 workflows are inert, cannot skip the gate or continue on error, and are pinned', { timeout: 60_000 }, async (t) => {
  const ctx = setup(t, 'wp6-08');
  const { files } = workflows(ctx, 'wp6-08');
  assert.deepEqual(Object.keys(files), NAMES, 'exactly the four v5 workflow files');

  const runs = [];
  for (const [name, { text, doc }] of Object.entries(files)) {
    assert.match(text.split('\n').slice(0, 6).join('\n'), /VERSION 5 ONLY\. INERT UNTIL CUTOVER/, `${name} says at its top that it is inert`);
    const on = doc.on;
    for (const trig of Object.keys(on)) assert.ok(['workflow_dispatch', 'push', 'workflow_call'].includes(trig), `${name}: trigger ${trig} is not allowed (only workflow_dispatch, push to release/5.*, workflow_call)`);
    if (on.push) assert.deepEqual(on.push, { branches: ['release/5.*'] }, `${name}: push only to release/5.* branches`);
    if (on.workflow_call) assert.equal(name, 'v5-pack-build.yml', `${name}: only the pack build is callable`);
    for (const k of Object.keys(on.workflow_dispatch?.inputs ?? {})) assert.doesNotMatch(k, /skip|gate|optional|force|bypass|dry/i, `${name}: input ${k} looks like a switch that skips a step`);
    for (const [k, v] of Object.entries(doc.permissions)) assert.ok(v === 'read' || v === 'none' || (name === 'v5-nightly-dispatch.yml' && k === 'actions' && v === 'write'), `${name}: top-level permission ${k}: ${v}`);
    walk(doc, (v, at) => {
      if (/\.continue-on-error$/.test(at)) assert.fail(`${name}${at}: continue-on-error is not allowed`);
      if (/\.permissions\.(contents|id-token|packages|deployments|statuses|checks|pull-requests|issues)$/.test(at)) assert.notEqual(v, 'write', `${name}${at}: write permission`);
      if (/\.permissions$/.test(at) && typeof v === 'string') assert.fail(`${name}${at}: blanket permissions ${v}`);
      if (typeof v === 'string' && /secrets\./.test(v)) assert.equal(`${name}${at}`, 'v5-release-candidate.yml.jobs.seal.steps[3].env.RUVNET_BRAIN5_SIGNING_KEY', `the signing secret may appear only in the seal step: ${name}${at}`);
      if (/\.secrets$/.test(at)) assert.fail(`${name}${at}: secrets may not be passed on`);
      if (/\.uses$/.test(at)) assert.match(v, /^(\.\/\.github\/workflows\/v5-[a-z-]+\.yml|[\w.-]+\/[\w.-]+@[0-9a-f]{40})$/, `${name}${at}: every action must be pinned to an exact commit: ${v}`);
      if (/\.node-version$/.test(at)) assert.match(String(v), /^\d+\.\d+\.\d+$/, `${name}${at}: Node must be an exact version`);
      if (/\.run$/.test(at)) runs.push({ name, at, v });
    });
    for (const [id, job] of Object.entries(doc.jobs)) {
      assert.equal(job.if, GUARD, `${name} job ${id} runs only in the owner's repository`);
      for (const s of job.steps ?? []) assert.ok(s.if === undefined || /^steps\.decide\.outputs\.dispatch == 'true'$/.test(s.if), `${name} job ${id}: a step condition could skip it: ${s.if}`);
    }
  }
  for (const r of runs) {
    assert.doesNotMatch(r.v, /\|\|\s*(true|:|exit 0)\b|set \+e/, `${r.name}${r.at}: a command may not ignore its failure`);
    assert.doesNotMatch(r.v, /\bnpm (ci|install|i)\b|\bnpx\b|\byarn\b|\bpnpm\b|\bpip install\b|\bcurl\b|\bwget\b/, `${r.name}${r.at}: nothing is installed from the network`);
    assert.doesNotMatch(r.v, /packages\/release\/release\.mjs/, `${r.name}${r.at}: the low-level signer is never called by a workflow`);
  }
  const count = (re) => runs.filter((r) => re.test(r.v));
  assert.deepEqual(count(/rail\.mjs seal\b/).map((r) => `${r.name}${r.at}`), ['v5-release-candidate.yml.jobs.seal.steps[3].run'], 'exactly one signing call: rail.mjs seal in the seal job');

  const rc = files['v5-release-candidate.yml'].doc;
  assert.equal(rc.jobs.seal.environment, 'v5-release', 'the signing job is bound to its environment');
  assert.deepEqual(rc.jobs.probe.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest'], 'install-and-probe on three operating systems');
  assert.equal(rc.jobs.probe.strategy['fail-fast'], false);
  assert.match(rc.jobs.gate.steps.map((s) => s.run ?? '').join('\n'), /node packages\/release\/gate\/gate\.mjs --release /, 'the answer gate runs');
  assert.deepEqual([...rc.jobs.promote.needs].sort(), ['gate', 'probe', 'seal'], 'promote waits for the seal, every probe and the gate');
  assert.match(rc.jobs.promote.steps.map((s) => s.run ?? '').join('\n'), /rail\.mjs promote .*--receipts .*--gate /, 'promote is given the receipts and the gate result');
  assert.deepEqual(Object.keys(rc.on.workflow_dispatch.inputs), ['version']);
  assert.equal(Object.keys(rc.jobs).join(','), 'pack,seal,probe,gate,promote');

  // One-publisher gate: no publish operation in the v5 workflows or packages/release, and packages/ is scanned.
  for (const n of NAMES) assert.deepEqual(detectPublisherActions(`.github/workflows/${n}`, files[n].text), [], `${n} holds no publish operation`);
  const relDir = path.join(ROOT, 'packages', 'release');
  for (const f of fs.readdirSync(relDir).filter((x) => x.endsWith('.mjs'))) assert.deepEqual(detectPublisherActions(`packages/release/${f}`, fs.readFileSync(path.join(relDir, f), 'utf8')), [], `packages/release/${f} holds no publish operation`);
  const scratch = ctx.tmp('rb5-wp6-ra-');
  fs.mkdirSync(path.join(scratch, 'packages', 'release'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'packages', 'release', 'rogue.mjs'), "execFileSync('npm', ['publish']);\n");
  assert.deepEqual(findUnauthorizedPublishers(scratch), [{ file: 'packages/release/rogue.mjs', action: 'npm-publish' }], 'the one-publisher gate scans packages/');
});
