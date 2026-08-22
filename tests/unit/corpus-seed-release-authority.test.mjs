import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runProtectedCorpusSeed } from '../../scripts/release.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-authority-'));
  dirs.push(dir);
  const bundle = path.join(dir, 'ruvnet-brain.zip');
  fs.writeFileSync(bundle, 'sealed corpus bundle');
  const digest = sha256(bundle);
  const receiptFile = path.join(dir, 'corpus-receipt.json');
  const receipt = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-corpus-candidate',
    builderSourceSha: HEAD,
    createdAt: '2026-08-21T12:34:56.000Z',
    coverageGeneration: 'coverage-2026-08-21',
    storeCount: 1,
    stores: [{
      name: 'alpha', sourceCommit: 'a'.repeat(40), builtUtc: '2026-08-21T12:00:00.000Z',
      model: 'local', dimensions: 384,
      files: [{ file: 'alpha.big.rvf', sha256: 'a'.repeat(64), bytes: 1 }],
    }],
    privateFence: { file: 'PRIVATE-STORES.json', sha256: 'b'.repeat(64), bytes: 2 },
    eligibilityPolicy: { file: 'source-coverage.json', sha256: 'c'.repeat(64), bytes: 3 },
    generationLedger: { file: 'RVF-GENERATIONS.json', sha256: 'd'.repeat(64), bytes: 4 },
    excludedPrivateStores: ['secret'],
    duplicateRvfDigests: [],
    unreceiptedRvfFiles: [],
    missingSidecars: [],
    archive: { file: path.basename(bundle), sha256: digest, bytes: fs.statSync(bundle).size },
    generator: { corpusCandidateSha256: sha256(path.join(ROOT, 'scripts/corpus-candidate.mjs')) },
  };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
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
    GH_VIEW_MODE: 'missing',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'protected-release',
    GITHUB_SHA: HEAD,
    GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
  };
  return { dir, bundle, digest, receipt, receiptFile, tag, args, env, calls: [] };
}

function run(f, { args = f.args, env = f.env } = {}) {
  const commandRun = (command, commandArgs) => {
    if (command === 'git') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    if (command !== 'gh') return { status: 127, stdout: '', stderr: `unexpected command: ${command}` };
    f.calls.push(commandArgs);
    if (commandArgs[0] === 'release' && commandArgs[1] === 'view') {
      if (env.GH_VIEW_MODE === 'exists') return { status: 0, stdout: '', stderr: '' };
      return {
        status: 1,
        stdout: '',
        stderr: env.GH_VIEW_MODE === 'ambiguous' ? 'network timeout' : 'release not found',
      };
    }
    return { status: 0, stdout: 'created', stderr: '' };
  };
  try {
    const result = runProtectedCorpusSeed({ argv: args, env, root: ROOT, run: commandRun });
    return { status: 0, stdout: JSON.stringify(result), stderr: '' };
  } catch (error) {
    return { status: 1, stdout: '', stderr: error.message };
  }
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
  ])('refuses %s before invoking gh', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/protected-release GitHub workflow/i);
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['target differs from HEAD', (f) => { f.args = replaceArg(f.args, '--target', 'f'.repeat(40)); }],
    ['GITHUB_SHA differs from HEAD', (f) => { f.env.GITHUB_SHA = 'f'.repeat(40); }],
    ['receipt source differs from target', (f) => { f.receipt.builderSourceSha = 'f'.repeat(40); writeReceipt(f); }],
  ])('refuses when %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target.*HEAD.*GITHUB_SHA.*receipt/i);
    expect(f.calls).toEqual([]);
  });

  it('requires a full lowercase digest tag bound to the receipt and bundle bytes', () => {
    for (const tag of ['corpus-sha256-short', `v${'a'.repeat(64)}`, `corpus-sha256-${'A'.repeat(64)}`]) {
      const f = fixture();
      const result = run(f, { args: replaceArg(f.args, '--corpus-tag', tag) });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/corpus tag/i);
    }
    const f = fixture();
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
  ])('refuses %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/absolute regular file/i);
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['receipt kind', (f) => { f.receipt.kind = 'forged'; }],
    ['failure arrays', (f) => { f.receipt.missingSidecars = ['alpha.meta.json']; }],
    ['store count', (f) => { f.receipt.storeCount = 2; }],
    ['policy binding', (f) => { f.receipt.eligibilityPolicy.sha256 = 'nope'; }],
    ['archive name', (f) => { f.receipt.archive.file = 'other.zip'; }],
    ['generator binding', (f) => { f.receipt.generator.corpusCandidateSha256 = 'e'.repeat(64); }],
    ['store provenance', (f) => { f.receipt.stores[0].sourceCommit = ''; }],
    ['private exclusion list', (f) => { f.receipt.excludedPrivateStores = 'secret'; }],
  ])('refuses invalid %s binding', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    writeReceipt(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/corpus receipt/i);
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['existing tag', 'exists', /already exists.*refusing to overwrite/i],
    ['ambiguous lookup', 'ambiguous', /cannot prove.*absent/i],
  ])('fails closed for %s', (_name, mode, message) => {
    const f = fixture();
    f.env.GH_VIEW_MODE = mode;
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', 'stuinfla/ruvnet-brain']);
  });

  it('creates one non-latest non-draft prerelease containing exactly the bound bundle and receipt', () => {
    const f = fixture();
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', 'stuinfla/ruvnet-brain']);
    expect(f.calls[1]).toEqual([
      'release', 'create', f.tag,
      '--prerelease', '--latest=false',
      '--target', HEAD,
      '--repo', 'stuinfla/ruvnet-brain',
      '--title', `Immutable corpus seed ${f.digest.slice(0, 16)}`,
      '--notes', expect.stringContaining(`Archive SHA-256: ${f.digest}`),
      f.bundle, f.receiptFile,
    ]);
    expect(f.calls[1]).not.toContain('--draft');
    expect(f.calls[1]).not.toContain('--clobber');
  });
});
