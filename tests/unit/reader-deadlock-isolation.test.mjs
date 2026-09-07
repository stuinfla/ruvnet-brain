import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { createReaderDeadlockFixture } from '../helpers/reader-deadlock-fixture.mjs';

const roots = [];
const script = path.resolve(import.meta.dirname, '../regression/reader-deadlock-pr0p.mjs');
function fixture(score = 1) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deadlock-guard-test-')));
  roots.push(root);
  const kb = path.join(root, 'kb');
  const cache = path.join(root, 'models');
  const model = path.join(cache, 'Xenova/ms-marco-MiniLM-L-6-v2/onnx/model.onnx');
  fs.mkdirSync(kb);
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, '01234567890123456789');
  fs.writeFileSync(path.join(root, '.reader-deadlock-fixture'), 'disposable\n');
  fs.writeFileSync(path.join(kb, 'forge-rerank.mjs'), `export async function rerankPairs(q,docs){return docs.map(d=>({...d,ceScore:${score}}));}`);
  fs.writeFileSync(path.join(kb, 'resolve-deps.mjs'), `export async function loadTransformers(){return {modelCache:${JSON.stringify(cache)}};}`);
  return { root, kb, cache, model };
}
function run(f, mode, args = []) {
  return spawnSync(process.execPath, [script, mode, '--dir', f.kb, ...args], {
    env: { ...process.env, KB_MODEL_CACHE: f.cache }, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('refuses intentional corruption without a disposable fixture root before touching model bytes', () => {
  const f = fixture();
  const result = run(f, 'test');
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(f.model, 'utf8')).toBe('01234567890123456789'); // sync-version-ignore: fixture bytes
});

it.each(['prime', 'test'])('does not call a null-score fallback a successful %s', mode => {
  const f = fixture(null);
  const result = run(f, mode, ['--fixture-root', f.root]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/finite.*score/i);
});

it('copies model bytes before corruption and leaves the source cache unchanged', () => {
  const source = fixture();
  const isolated = createReaderDeadlockFixture({ kbDir: source.kb, modelCache: source.cache });
  roots.push(isolated.root);
  // The fake resolver obeys the same explicit model-cache input as the real resolver.
  fs.writeFileSync(path.join(isolated.kb, 'resolve-deps.mjs'),
    'export async function loadTransformers(){return {modelCache:process.env.KB_MODEL_CACHE};}');
  const result = run(isolated, 'test', ['--fixture-root', isolated.root]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('call #2 OK');
  const relative = path.relative(source.cache, source.model);
  expect(fs.statSync(path.join(isolated.cache, relative)).size).toBe(4);
  expect(fs.readFileSync(source.model, 'utf8')).toBe('01234567890123456789'); // sync-version-ignore: fixture bytes
});

it('rejects a resolver that sends corruption outside the disposable fixture', () => {
  const ambient = fixture();
  const isolated = fixture();
  fs.writeFileSync(path.join(isolated.kb, 'resolve-deps.mjs'),
    `export async function loadTransformers(){return {modelCache:${JSON.stringify(ambient.cache)}};}`);
  const result = run(isolated, 'test', ['--fixture-root', isolated.root]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/inside the disposable fixture/);
  expect(fs.readFileSync(ambient.model, 'utf8')).toBe('01234567890123456789'); // sync-version-ignore: fixture bytes
});
