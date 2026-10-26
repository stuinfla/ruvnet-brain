// Real-path proof for the nightly refresh engine. This intentionally uses the actual local BGE
// embedder and @ruvector/rvf; run explicitly because model load makes it heavier than normal CI.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-refresh-real-'));
const repo = path.join(tmp, 'repo');
const out = path.join(tmp, 'kb');
fs.mkdirSync(repo);
fs.mkdirSync(out);

const BGE_MODEL = path.join(
  'Xenova',
  'bge-base-en-v1.5',
  '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
  'onnx',
  'model_quantized.onnx',
);
const modelCache = [
  process.env.KB_MODEL_CACHE,
  path.join(os.homedir(), '.cache', 'ruvnet-brain', 'models'),
  path.join(ROOT, 'kb', 'models-cache'),
].filter(Boolean).find((candidate) => fs.existsSync(path.join(candidate, BGE_MODEL)));
if (!modelCache) {
  console.warn('[forge-refresh-real] SKIP — complete local BGE model unavailable; refusing a network-dependent test');
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeCorpus(alphaText) {
  fs.writeFileSync(path.join(repo, 'alpha.md'), `# Alpha\n\n${alphaText}\n`);
  fs.writeFileSync(path.join(repo, 'beta.md'), '# Beta\n\nBeta remains byte-for-byte unchanged.\n');
}

function refresh() {
  return spawnSync(process.execPath, [
    'kb/forge-refresh.mjs',
    '--repo', repo,
    '--out', out,
    '--name', 'tiny',
    '--structural-only',
  ], {
    cwd: ROOT,
    env: { ...process.env, RUVNET_BIG_SHARDS: '1', CE_DEBUG: '1', ...(modelCache ? { KB_MODEL_CACHE: modelCache } : {}) },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function passagesByPath() {
  return new Map(
    fs.readFileSync(path.join(out, 'tiny.passages.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((row) => [row.path, row]),
  );
}

describe.skipIf(!modelCache)('forge-refresh real full -> incremental path', () => {
  it('embeds only the changed file on pass two and preserves the unchanged stable ID', () => {
    // Without kb deps forge-big cannot load @xenova/transformers and the run fails with a resolver error
    // three layers down. Name the cause first, as a failure, not a skip.
    const kbDeps = path.join(ROOT, 'kb', 'node_modules');
    expect(fs.existsSync(kbDeps), `kb/node_modules missing: cd kb && npm ci (looked at ${kbDeps})`).toBe(true);
    writeCorpus('Alpha generation one.');
    const first = refresh();
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(first.stdout).toMatch(/safe full fallback/);
    expect(fs.existsSync(path.join(out, 'tiny.big.rvf'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'tiny.rvf'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'tiny.big.passages.jsonl'))).toBe(false);
    const before = passagesByPath();

    writeCorpus('Alpha generation two changed only this file.');
    const second = refresh();
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(second.stdout).toMatch(/\[refresh\] incremental: keep=1, add=1, delete=1/);
    expect(second.stdout).toMatch(/1\/1 changed chunks/);
    const after = passagesByPath();

    expect(after.get('beta.md').id).toBe(before.get('beta.md').id);
    expect(after.get('alpha.md').id).not.toBe(before.get('alpha.md').id);
    const generations = JSON.parse(fs.readFileSync(path.join(out, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(generations.stores.tiny.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 10 * 60 * 1000);
});
