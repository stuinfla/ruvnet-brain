// 2026-11-06: agentdb was carried STALE because a concurrent worker's first model download created the
// model folder before its files, and forge-refresh then treated "folder exists" as "cached" and forbade
// the download it needed ("local_files_only ... tokenizer.json not found locally"). Two defences are
// pinned here: readiness is the file set (not the folder), and the model is warmed ONCE, serially,
// before any corpus-reconcile worker starts.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeReconciliation } from '../../scripts/corpus-reconcile.mjs';
import { loadEmbedderPipeline, warmModelCache, WARM_MODEL, WARM_REVISION } from '../../kb/warm-model-cache.mjs';
import { modelCacheReady, modelPath } from '../../kb/model-requirements.mjs';

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-model-')); temps.push(d); return d; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });
const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** Write the three files the strict offline reader loads, in the pinned-revision layout. */
function writeModel(cache, revisioned = true) {
  const root = revisioned ? path.join(modelPath(cache, WARM_MODEL), WARM_REVISION) : modelPath(cache, WARM_MODEL);
  fs.mkdirSync(path.join(root, 'onnx'), { recursive: true });
  for (const file of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) {
    fs.writeFileSync(path.join(root, file), 'x');
  }
}
/** A fake transformers namespace whose pipeline() "downloads" only when remote loading is allowed. */
function fakeTransformers(cache, { completes = true } = {}) {
  const T = { env: {}, loads: [] };
  T.pipeline = async (task, model, options) => {
    T.loads.push({ task, model, options, allowRemote: T.env.allowRemoteModels, cacheDir: T.env.cacheDir });
    if (!T.env.allowRemoteModels && !modelCacheReady(cache, model)) throw new Error('local_files_only: tokenizer.json not found locally');
    if (completes) writeModel(cache);
    return () => {};
  };
  return T;
}

describe('warmModelCache (serial model warm-up)', () => {
  it('a folder without its files (a half-started download) is NOT ready: it downloads, then the cache is complete', async () => {
    const cache = temp();
    fs.mkdirSync(modelPath(cache, WARM_MODEL), { recursive: true }); // exactly the state the racing worker saw
    expect(modelCacheReady(cache, WARM_MODEL)).toBe(false);
    const T = fakeTransformers(cache);
    const result = await warmModelCache({ cache, loadT: async () => ({ T }), log: () => {} });
    expect(result.downloaded).toBe(true);
    expect(T.loads).toHaveLength(1);
    expect(T.loads[0]).toMatchObject({ model: WARM_MODEL, allowRemote: true, cacheDir: cache });
    expect(T.loads[0].options).toMatchObject({ quantized: true, revision: WARM_REVISION });
    expect(modelCacheReady(cache, WARM_MODEL)).toBe(true); // promoted to the canonical offline location
  });

  it('an already-complete cache is left alone: no load, no network', async () => {
    const cache = temp();
    writeModel(cache, false);
    const T = fakeTransformers(cache);
    const result = await warmModelCache({ cache, loadT: async () => ({ T }), log: () => {} });
    expect(result.downloaded).toBe(false);
    expect(T.loads).toHaveLength(0);
  });

  it('fails loudly when the load leaves the cache incomplete', async () => {
    const cache = temp();
    const T = fakeTransformers(cache, { completes: false });
    await expect(warmModelCache({ cache, loadT: async () => ({ T }), log: () => {} })).rejects.toThrow(/still incomplete/);
  });
});

describe('forge-refresh readiness gate', () => {
  it('goes through the shared file-set loader, not the folder-existence check that caused the Nov 6 carry', () => {
    const source = read('kb/forge-refresh.mjs');
    expect(source).not.toMatch(/allowRemoteModels\s*=\s*!fs\.existsSync\(/);
    expect(source).toMatch(/loadEmbedderPipeline\(T, cache, \{ model: config\.model, revision: config\.revision \}\)/);
  });

  it('the warm-up pin equals the BGE pin forge-refresh and forge-big embed with', () => {
    expect(read('kb/forge-refresh.mjs')).toContain(`revision: '${WARM_REVISION}'`);
    expect(read('kb/forge-big.mjs')).toContain(`const MODEL_REVISION = '${WARM_REVISION}'`);
  });
});

// The Nov 6 failure was an INTERLEAVING, so it is reproduced as one: separate "processes" (each with its
// own transformers env) share one cache directory, and a slow first download is observed half-written.
describe('concurrent cache writers (the actual Nov 6 interleaving)', () => {
  const tick = () => new Promise((resolve) => { setImmediate(resolve); });
  /** One fake process: its own env, a shared on-disk cache, and a download that lands file by file. */
  function fakeProcess(cache, { onFolderCreated = null, oldGate = false } = {}) {
    const T = { env: {}, downloads: 0 };
    T.pipeline = async (_task, model, { revision }) => {
      if (oldGate) T.env.allowRemoteModels = !fs.existsSync(modelPath(cache, model)); // the pre-fix gate
      if (!T.env.allowRemoteModels) {
        if (!modelCacheReady(cache, model)) throw new Error('local_files_only=true ... tokenizer.json not found locally');
        return () => {};
      }
      T.downloads += 1;
      const root = path.join(modelPath(cache, model), revision);
      fs.mkdirSync(path.join(root, 'onnx'), { recursive: true });
      if (onFolderCreated) await onFolderCreated(); // the folder now exists, its files do not
      for (const file of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) {
        await tick();
        fs.writeFileSync(path.join(root, file), 'x');
      }
      return () => {};
    };
    return T;
  }
  /** Start A's download, and start B exactly while A's folder exists without its files. */
  async function raceTwo(cache, { oldGate }) {
    let release;
    const folderSeen = new Promise((resolve) => { release = resolve; });
    let proceed;
    const bFinished = new Promise((resolve) => { proceed = resolve; });
    const a = fakeProcess(cache, { onFolderCreated: async () => { release(); await bFinished; } });
    const b = fakeProcess(cache, { oldGate });
    const aRun = loadEmbedderPipeline(a, cache);
    await folderSeen; // A has created <model>/<revision>/ but written nothing
    expect(modelCacheReady(cache, WARM_MODEL)).toBe(false);
    const bRun = loadEmbedderPipeline(b, cache).finally(proceed);
    return { a, b, aRun, bRun };
  }

  it('harness check: the PRE-fix folder gate loses this race with the logged error', async () => {
    const cache = temp();
    let release; const folderSeen = new Promise((r) => { release = r; });
    let proceed; const bDone = new Promise((r) => { proceed = r; });
    const a = fakeProcess(cache, { onFolderCreated: async () => { release(); await bDone; } });
    const b = fakeProcess(cache);
    const aRun = (async () => { a.env.allowRemoteModels = true; return a.pipeline('t', WARM_MODEL, { revision: WARM_REVISION }); })();
    await folderSeen;
    // B uses the old gate: the model folder exists, so remote loading is switched off.
    b.env.allowRemoteModels = !fs.existsSync(modelPath(cache, WARM_MODEL));
    expect(b.env.allowRemoteModels).toBe(false);
    await expect(b.pipeline('t', WARM_MODEL, { revision: WARM_REVISION })).rejects.toThrow(/tokenizer\.json not found locally/);
    proceed();
    await aRun;
  });

  it('with the file-set gate, the second process sees "not ready", downloads for itself, and neither fails', async () => {
    const cache = temp();
    const { a, b, aRun, bRun } = await raceTwo(cache, { oldGate: false });
    await expect(Promise.all([aRun, bRun])).resolves.toBeDefined();
    expect(b.downloads).toBe(1); // it did not take the folder as proof of a cached model
    expect(a.downloads).toBe(1);
    expect(modelCacheReady(cache, WARM_MODEL)).toBe(true);
  });

  it('harness check 2: the same two-process race with the pre-fix gate inside the loader fails B', async () => {
    const cache = temp();
    const { aRun, bRun } = await raceTwo(cache, { oldGate: true });
    await expect(bRun).rejects.toThrow(/tokenizer\.json not found locally/);
    await aRun;
  });

  it('after the serial warm-up, five concurrent workers all read locally: zero downloads, zero races', async () => {
    const cache = temp();
    const warmer = fakeProcess(cache);
    await warmModelCache({ cache, loadT: async () => ({ T: warmer }), log: () => {} });
    expect(warmer.downloads).toBe(1);
    const workers = Array.from({ length: 5 }, () => fakeProcess(cache));
    await Promise.all(workers.map((T) => loadEmbedderPipeline(T, cache)));
    expect(workers.map((T) => T.downloads)).toEqual([0, 0, 0, 0, 0]);
    expect(workers.every((T) => T.env.allowRemoteModels === false)).toBe(true);
  });
});

describe('executeReconciliation warms the model before any worker starts', () => {
  const sha = (c) => c.repeat(40);
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const FAMILY = ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json'];
  function fixture() {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    fs.writeFileSync(path.join(root, 'kb', 'warm-model-cache.mjs'), '// fixture');
    const rvf = 'seed alpha rvf';
    for (const suffix of FAMILY) fs.writeFileSync(path.join(assetsDir, `alpha${suffix}`), suffix === '.big.rvf' ? rvf : '{}\n');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: {
      file: 'alpha.big.rvf', sourceCommit: sha('0'), bytes: Buffer.byteLength(rvf), sha256: hash(rvf),
      model: WARM_MODEL, dimensions: 768, builtUtc: '2026-08-20T00:00:00.000Z' } } }));
    fs.writeFileSync(path.join(assetsDir, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', stores: {} }));
    return { root, assetsDir, workspaceDir: path.join(root, 'clones') };
  }
  const plan = [{ name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha', upstreamSha: sha('a'),
    ledgerSourceCommit: null, reason: 'sourceCommit differs' }];
  const runner = (calls, { warmStatus = 0 } = {}) => (command, args) => {
    calls.push([command, ...args]);
    if (String(args[0]).endsWith('warm-model-cache.mjs')) return { status: warmStatus, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'clone') { fs.mkdirSync(args.at(-1), { recursive: true }); return { status: 0 }; }
    if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${sha('a')}\n` };
    if (String(args[0]).endsWith('forge-refresh.mjs')) return { status: 1, stdout: '', stderr: '' }; // carry; irrelevant here
    return { status: 0, stdout: '', stderr: '' };
  };

  it('runs the warm-up exactly once, before the first clone or forge-refresh', async () => {
    const calls = [];
    const logs = [];
    await executeReconciliation({ plan, ...fixture(), run: runner(calls), log: (l) => logs.push(l) });
    const warm = calls.findIndex((c) => String(c[1]).endsWith('warm-model-cache.mjs'));
    const firstWorker = calls.findIndex((c) => c[0] === 'git');
    expect(warm).toBe(0);
    expect(warm).toBeLessThan(firstWorker);
    expect(calls.filter((c) => String(c[1]).endsWith('warm-model-cache.mjs'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('embedder model warmed before workers started'))).toBe(true);
  });

  it('a failed warm-up is logged and does not stop the stores from running (per-store carry rules still apply)', async () => {
    const calls = [];
    const logs = [];
    const result = await executeReconciliation({ plan, ...fixture(), run: runner(calls, { warmStatus: 1 }), log: (l) => logs.push(l) });
    expect(logs.some((l) => l.includes('model warm-up failed'))).toBe(true);
    expect(calls.some((c) => String(c[1]).endsWith('forge-refresh.mjs'))).toBe(true);
    expect(result.carried.map((row) => row.store)).toEqual(['alpha']);
  });

  it('a failed warm leaving partial bytes never overlaps cache writers across five store workers', async () => {
    const f = fixture();
    const stores = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const ledgerPath = path.join(f.assetsDir, 'RVF-GENERATIONS.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    for (const store of stores.slice(1)) {
      for (const suffix of FAMILY) fs.copyFileSync(path.join(f.assetsDir, `alpha${suffix}`), path.join(f.assetsDir, `${store}${suffix}`));
      ledger.stores[store] = { ...ledger.stores.alpha, file: `${store}.big.rvf` };
    }
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    const cache = path.join(f.root, 'cache');
    const partial = path.join(cache, 'model_quantized.onnx');
    fs.mkdirSync(cache);
    let active = 0;
    let maxActive = 0;
    let writes = 0;
    const calls = [];
    const baseRun = runner(calls, { warmStatus: 1 });
    const run = async (command, args) => {
      if (String(args[0]).endsWith('warm-model-cache.mjs')) {
        fs.writeFileSync(partial, 'half-written');
        return baseRun(command, args);
      }
      if (String(args[0]).endsWith('forge-refresh.mjs')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // This represents a real shared-cache writer holding a partial file across an await.
        fs.writeFileSync(partial, 'incomplete');
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        fs.writeFileSync(partial, 'complete');
        writes += 1;
        active -= 1;
      }
      return baseRun(command, args);
    };
    const result = await executeReconciliation({ ...f, plan: stores.map((store) => ({ ...plan[0], name: store, store })),
      run, concurrency: 5, log: () => {} });
    expect(writes).toBe(5);
    expect(maxActive).toBe(1);
    expect(fs.readFileSync(partial, 'utf8')).toBe('complete');
    expect(result.carried).toHaveLength(5);
  });

});
