import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCorpusReceipt } from '../../scripts/corpus-candidate.mjs';
import { sealedCorpusBundle } from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RELEASE = path.join(ROOT, 'scripts/release.mjs');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// Every case starts from a GENUINE sealed bundle and the receipt actually derived from its bytes,
// then mutates exactly one thing. Until 2026-09-13 this fixture was a text file named
// ruvnet-brain.zip plus a hand-written receipt whose outer sha256 happened to match; that stopped
// being possible when runProtectedCorpusSeed took over the deep verifyCorpusReceipt re-derivation
// from the deleted scripts/corpus-seed-publish.mjs (ADR-085) — the publisher now re-extracts the
// archive and rebuilds the candidate from it, so only a real bundle can reach `gh`.
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-authority-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'gh-calls.jsonl');
  const gh = path.join(bin, 'gh-fixture.mjs');
  fs.writeFileSync(gh, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') {
  if (process.env.GH_VIEW_MODE === 'exists') process.exit(0);
  console.error(process.env.GH_VIEW_MODE === 'ambiguous' ? 'network timeout' : 'release not found');
  process.exit(1);
}
process.exit(0);
`);
  fs.chmodSync(gh, 0o755);

  const { bundle } = await sealedCorpusBundle(dir); // <dir>/ruvnet-brain.zip
  const receiptFile = path.join(dir, 'corpus-receipt.json');
  const receipt = await createCorpusReceipt({
    bundleFile: bundle,
    receiptFile,
    builderSourceSha: HEAD,
    createdAt: '2026-08-21T12:34:56.000Z',
  });
  const digest = receipt.archive.sha256;
  const tag = `corpus-sha256-${digest}`;
  const args = [
    '--corpus-seed', '--corpus-tag', tag,
    '--corpus-bundle', bundle,
    '--corpus-receipt', receiptFile,
    '--target', HEAD,
    '--repo', 'stuinfla/ruvnet-brain',
  ];
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_CALL_LOG: log,
    GH_VIEW_MODE: 'missing',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'protected-release',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_SHA: HEAD,
    GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
    GH_TOKEN: 'fixture-token',
    RUVNET_GH_COMMAND: process.execPath,
    RUVNET_GH_SCRIPT: path.join(bin, 'gh-fixture.mjs'),
  };
  return { dir, bundle, digest, receipt, receiptFile, tag, args, env, log };
}

function run(f, { args = f.args, env = f.env } = {}) {
  return spawnSync(process.execPath, [RELEASE, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function replaceArg(args, name, value) {
  const copy = [...args];
  copy[copy.indexOf(name) + 1] = value;
  return copy;
}

function writeReceipt(f) {
  fs.writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
}

describe('protected corpus-seed release authority', () => {
  it.each([
    ['outside GitHub Actions', (f) => { delete f.env.GITHUB_ACTIONS; }],
    ['wrong workflow', (f) => { f.env.GITHUB_WORKFLOW = 'ci'; }],
    ['wrong repository', (f) => { f.env.GITHUB_REPOSITORY = 'attacker/fork'; }],
    ['non-dispatch event', (f) => { f.env.GITHUB_EVENT_NAME = 'push'; }],
    ['unprotected ref', (f) => { f.env.GITHUB_REF_PROTECTED = 'false'; }],
  ])('refuses %s before invoking gh', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/protected-release GitHub workflow/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    ['target differs from HEAD', (f) => { f.args = replaceArg(f.args, '--target', 'f'.repeat(40)); }],
    ['GITHUB_SHA differs from HEAD', (f) => { f.env.GITHUB_SHA = 'f'.repeat(40); }],
    ['receipt source differs from target', (f) => { f.receipt.builderSourceSha = 'f'.repeat(40); writeReceipt(f); }],
  ])('refuses when %s', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target.*HEAD.*GITHUB_SHA.*receipt/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('requires a full lowercase digest tag bound to the receipt and bundle bytes', async () => {
    for (const tag of ['corpus-sha256-short', `v${'a'.repeat(64)}`, `corpus-sha256-${'A'.repeat(64)}`]) {
      const f = await fixture();
      const result = run(f, { args: replaceArg(f.args, '--corpus-tag', tag) });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/corpus tag/i);
    }
    const f = await fixture();
    fs.appendFileSync(f.bundle, 'tampered');
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/archive.*receipt/i);
  });

  it.each([
    ['relative bundle', (f) => { f.args = replaceArg(f.args, '--corpus-bundle', path.basename(f.bundle)); }],
    ['relative receipt', (f) => { f.args = replaceArg(f.args, '--corpus-receipt', path.basename(f.receiptFile)); }],
    ['bundle directory', (f) => { f.args = replaceArg(f.args, '--corpus-bundle', f.dir); }],
    ['receipt directory', (f) => { f.args = replaceArg(f.args, '--corpus-receipt', f.dir); }],
  ])('refuses %s', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/absolute regular file/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    ['receipt kind', (f) => { f.receipt.kind = 'forged'; }],
    ['schema downgrade', (f) => { f.receipt.schemaVersion = 1; }],
    ['failure arrays', (f) => { f.receipt.missingSidecars = ['alpha.meta.json']; }],
    ['store count', (f) => { f.receipt.storeCount = 2; }],
    ['generation ledger binding', (f) => { f.receipt.generationLedger.sha256 = 'nope'; }],
    ['archive name', (f) => { f.receipt.archive.file = 'other.zip'; }],
    ['generator binding', (f) => { f.receipt.generator.corpusCandidateSha256 = 'e'.repeat(64); }],
    ['store provenance', (f) => { f.receipt.stores[0].sourceCommit = ''; }],
    ['store kind', (f) => { f.receipt.stores[0].kind = 'not-a-kind'; }],
    ['private exclusion list', (f) => { f.receipt.excludedPrivateStores = 'secret'; }],
  ])('refuses invalid %s binding', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    writeReceipt(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/corpus receipt/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('refuses a receipt whose per-store digests were forged after sealing — the outer archive digest alone is not proof', async () => {
    // The check scripts/corpus-seed-publish.mjs used to run before delegating to release.mjs, moved
    // into runProtectedCorpusSeed on 2026-09-13 (ADR-085). The bundle is untouched, so its sha256
    // and byte length still match both the receipt and the tag, every field is well-formed, and
    // the generator/target bindings hold — only one store file's DECLARED digest is forged. No
    // shape or identity check above can see that; only re-deriving the candidate from the
    // archive's own bytes can, and it must happen before gh is ever invoked.
    const f = await fixture();
    f.receipt.stores[0].files[0].sha256 = 'f'.repeat(64);
    writeReceipt(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not verify against the sealed archive[\s\S]*does not match the exact corpus archive contents/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    ['existing tag', 'exists', /already exists.*refusing to overwrite/i],
    ['ambiguous lookup', 'ambiguous', /cannot prove.*absent/i],
  ])('fails closed for %s', async (_name, mode, message) => {
    const f = await fixture();
    f.env.GH_VIEW_MODE = mode;
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', 'stuinfla/ruvnet-brain']);
  });

  it('creates one non-latest non-draft prerelease containing exactly the bound bundle and receipt', async () => {
    const f = await fixture();
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', 'stuinfla/ruvnet-brain']);
    expect(calls[1]).toEqual([
      'release', 'create', f.tag,
      '--prerelease', '--latest=false',
      '--target', HEAD,
      '--repo', 'stuinfla/ruvnet-brain',
      '--title', `Immutable corpus seed ${f.digest.slice(0, 16)}`,
      '--notes', expect.stringContaining(`Archive SHA-256: ${f.digest}`),
      f.bundle, f.receiptFile,
    ]);
    expect(calls[1]).not.toContain('--draft');
    expect(calls[1]).not.toContain('--clobber');
  });
});
