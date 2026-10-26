// tests/unit/model-cache-cold.test.mjs — proves the capability battery tells a COLD model cache
// (embedder never downloaded, expected on a fresh machine) apart from a real retrieval OUTAGE.
//
// The bug (docs/4.0-READINESS.md §6 item 1): a cold cache made every battery question print the same
// "(no hit)" a genuine outage prints, so a healthy brain on a fresh machine looked broken. The fix is
// evidence-based — the embedder file is on disk or it is not — and the load-bearing property is the
// ASYMMETRY: cold requires no-hit AND model-absent, so an outage (model PRESENT, retrieval dead) can
// never be softened to "cold". These tests break that guard to confirm it fails on masked outages.
// (Repo names below are neutral placeholders — the classifier is name-agnostic.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  resolveModelCache,
  requiredEmbedderModels,
  modelPresent,
  classifyBattery,
  EMBEDDER_REL,
  BGE_EMBEDDER_REL,
} from '../../plugin/test/model-cache.mjs';
import {
  configureTransformersModel,
  materializeModelRevision,
  modelCacheReady,
} from '../../kb/model-requirements.mjs';

let tmp;
const savedEnv = {};
// A WARM model is the three files the strict offline reader loads, not merely its folder (#301).
const warm = (rel) => {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  for (const f of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) fs.writeFileSync(path.join(dir, f), '{}');
};
const ENV_KEYS = ['KB_MODEL_CACHE', 'RUVNET_BRAIN_HOME'];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-test-'));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('resolveModelCache — mirrors the MCP server (server.mjs) cache resolution', () => {
  it('honors KB_MODEL_CACHE verbatim (explicit override wins)', () => {
    expect(resolveModelCache({ KB_MODEL_CACHE: '/explicit/models' })).toBe('/explicit/models');
  });
  it('falls back to <RUVNET_BRAIN_HOME>/models when no KB_MODEL_CACHE', () => {
    expect(resolveModelCache({ RUVNET_BRAIN_HOME: '/brain' })).toBe(path.join('/brain', 'models'));
  });
  it('falls back to ~/.cache/ruvnet-brain/models with neither env set (the MCP default)', () => {
    expect(resolveModelCache({})).toBe(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'models'));
  });
});

describe('modelPresent — the one honest signal: is the embedder on disk?', () => {
  it('false when the embedder leaf dir is absent (cold cache)', () => {
    expect(modelPresent(tmp)).toBe(false);
  });
  it('true only when Xenova/all-MiniLM-L6-v2 actually exists (warm cache)', () => {
    warm(EMBEDDER_REL);
    expect(modelPresent(tmp)).toBe(true);
  });
  it('#301: a folder left by an unfinished download (no onnx/model_quantized.onnx) is MISSING, not warm', () => {
    fs.mkdirSync(path.join(tmp, EMBEDDER_REL), { recursive: true });
    fs.writeFileSync(path.join(tmp, EMBEDDER_REL, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(tmp, EMBEDDER_REL, 'config.json'), '{}');
    expect(modelPresent(tmp)).toBe(false);
  });
  it('the reranker being present does NOT warm the query path (must still read cold)', () => {
    // A machine can hold the cross-encoder (Xenova/ms-marco-MiniLM-L-6-v2) yet lack the embedder —
    // exactly the state of ~/.cache/ruvnet-brain/models that produced this bug. It must read cold.
    fs.mkdirSync(path.join(tmp, 'Xenova', 'ms-marco-MiniLM-L-6-v2'), { recursive: true });
    expect(modelPresent(tmp)).toBe(false);
  });
});

describe('requiredEmbedderModels — follows the installed RVF sidecars', () => {
  it('requires BGE when canonical big stores declare BGE, not the unrelated MiniLM fallback', () => {
    fs.writeFileSync(path.join(tmp, 'ruflo.big.rvf'), '');
    fs.writeFileSync(
      path.join(tmp, 'ruflo.big.rvf.embed.json'),
      JSON.stringify({ model: 'Xenova/bge-base-en-v1.5', dimensions: 768 }),
    );
    expect(requiredEmbedderModels(tmp)).toEqual(['Xenova/bge-base-en-v1.5']);
    warm(EMBEDDER_REL);
    expect(modelPresent(tmp, requiredEmbedderModels(tmp))).toBe(false);
    warm(BGE_EMBEDDER_REL);
    expect(modelPresent(tmp, requiredEmbedderModels(tmp))).toBe(true);
  });

  it('deduplicates models and ignores orphan sidecars whose RVF is absent', () => {
    for (const name of ['a', 'b']) {
      fs.writeFileSync(path.join(tmp, `${name}.big.rvf`), '');
      fs.writeFileSync(
        path.join(tmp, `${name}.big.rvf.embed.json`),
        JSON.stringify({ model: 'Xenova/bge-base-en-v1.5' }),
      );
    }
    fs.writeFileSync(
      path.join(tmp, 'orphan.rvf.embed.json'),
      JSON.stringify({ model: 'Xenova/all-MiniLM-L6-v2' }),
    );
    expect(requiredEmbedderModels(tmp)).toEqual(['Xenova/bge-base-en-v1.5']);
  });

  it('matches the reader: a canonical big store supersedes its legacy small store', () => {
    fs.writeFileSync(path.join(tmp, 'ruflo.rvf'), '');
    fs.writeFileSync(
      path.join(tmp, 'ruflo.rvf.embed.json'),
      JSON.stringify({ model: 'Xenova/all-MiniLM-L6-v2' }),
    );
    fs.writeFileSync(path.join(tmp, 'ruflo.big.rvf'), '');
    fs.writeFileSync(
      path.join(tmp, 'ruflo.big.rvf.embed.json'),
      JSON.stringify({ model: 'Xenova/bge-base-en-v1.5' }),
    );
    expect(requiredEmbedderModels(tmp)).toEqual(['Xenova/bge-base-en-v1.5']);
  });

  it('falls back to MiniLM only when no readable installed-store sidecar exists', () => {
    expect(requiredEmbedderModels(tmp)).toEqual(['Xenova/all-MiniLM-L6-v2']);
    fs.writeFileSync(path.join(tmp, 'broken.rvf'), '');
    fs.writeFileSync(path.join(tmp, 'broken.rvf.embed.json'), '{bad json');
    expect(requiredEmbedderModels(tmp)).toEqual(['Xenova/all-MiniLM-L6-v2']);
  });
});

describe('configureTransformersModel — reads and downloads through the same cache', () => {
  it('sets both localModelPath and cacheDir to the detector-visible cache', () => {
    const T = { env: {} };
    const r = configureTransformersModel(T, tmp, 'Xenova/bge-base-en-v1.5');
    expect(T.env.localModelPath).toBe(tmp);
    expect(T.env.cacheDir).toBe(tmp);
    expect(T.env.allowRemoteModels).toBe(true);
    expect(r.local).toBe(false);
  });

  it('disables remote loading when that exact model is already local', () => {
    for (const file of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) {
      const target = path.join(tmp, BGE_EMBEDDER_REL, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'ready');
    }
    const T = { env: {} };
    const r = configureTransformersModel(T, tmp, 'Xenova/bge-base-en-v1.5');
    expect(T.env.allowRemoteModels).toBe(false);
    expect(r.local).toBe(true);
  });

  it('materializes a complete pinned revision into the canonical offline path', () => {
    const model = 'Xenova/bge-base-en-v1.5';
    const revision = 'exact-sha';
    for (const file of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) {
      const target = path.join(tmp, BGE_EMBEDDER_REL, revision, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `pinned:${file}`);
    }
    expect(modelCacheReady(tmp, model)).toBe(false);
    expect(materializeModelRevision(tmp, model, revision)).toBe(true);
    expect(modelCacheReady(tmp, model)).toBe(true);
    expect(fs.readFileSync(path.join(tmp, BGE_EMBEDDER_REL, 'tokenizer.json'), 'utf8')).toBe('pinned:tokenizer.json');
  });

  it('serializes concurrent process materialization of one shared model cache', async () => {
    const model = 'Xenova/bge-base-en-v1.5';
    const revision = 'exact-sha';
    for (const file of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) {
      const target = path.join(tmp, BGE_EMBEDDER_REL, revision, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `pinned:${file}`);
    }
    const moduleUrl = new URL('../../kb/model-requirements.mjs', import.meta.url).href;
    const code = [
      `import { materializeModelRevision } from ${JSON.stringify(moduleUrl)};`,
      `if (!materializeModelRevision(${JSON.stringify(tmp)}, ${JSON.stringify(model)}, ${JSON.stringify(revision)})) process.exit(1);`,
    ].join('\n');
    const exits = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: 'ignore' });
      child.once('exit', resolve);
    })));
    expect(exits).toEqual([0, 0, 0, 0]);
    expect(modelCacheReady(tmp, model)).toBe(true);
    expect(fs.existsSync(path.join(tmp, BGE_EMBEDDER_REL) + '.materialize-lock')).toBe(false);
  });
});

describe('classifyBattery — cold vs outage vs pass', () => {
  it('PASS: a valid in-threshold hit from the expected repo', () => {
    expect(classifyBattery({ repo: 'repo-a', repoOk: true, relOk: true, haveModel: true })).toBe('pass');
    // a hit is real evidence of a working model even if the cache check somehow disagreed
    expect(classifyBattery({ repo: 'repo-a', repoOk: true, relOk: true, haveModel: false })).toBe('pass');
  });

  it('COLD: no parseable hit AND the embedder model is absent', () => {
    expect(classifyBattery({ repo: undefined, repoOk: true, relOk: true, haveModel: false })).toBe('cold');
  });

  it('OUTAGE stays FAIL: no hit while the model IS present is a genuine retrieval failure, never cold', () => {
    // THE load-bearing assertion. If this ever returned 'cold', a real outage would be masked as a
    // benign cold cache — the exact dishonesty this whole change exists to prevent.
    expect(classifyBattery({ repo: undefined, repoOk: true, relOk: true, haveModel: true })).toBe('fail');
  });

  it('FAIL: a hit parsed but below the relevance floor, model present (real but wrong answer)', () => {
    expect(classifyBattery({ repo: 'repo-b', repoOk: true, relOk: false, haveModel: true })).toBe('fail');
  });
  it('FAIL: a hit parsed from the wrong repo, model present', () => {
    expect(classifyBattery({ repo: 'wrong-repo', repoOk: false, relOk: true, haveModel: true })).toBe('fail');
  });

  it('the ONLY thing that flips a no-hit fail→cold is the model disappearing from disk', () => {
    const noHit = { repo: undefined, repoOk: true, relOk: true };
    expect(classifyBattery({ ...noHit, haveModel: true })).toBe('fail');   // outage
    expect(classifyBattery({ ...noHit, haveModel: false })).toBe('cold');  // cold cache
    // and with the model present there is NO no-hit input that yields 'cold' — proven by construction:
    for (const repoOk of [true, false]) for (const relOk of [true, false]) {
      expect(classifyBattery({ repo: undefined, repoOk, relOk, haveModel: true })).not.toBe('cold');
    }
  });
});
