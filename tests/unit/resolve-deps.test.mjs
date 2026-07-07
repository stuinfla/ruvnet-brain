// tests/unit/resolve-deps.test.mjs — the portable dep resolver decides WHERE the KB finds its RVF store
// and MiniLM cache on any machine, so its selection contract earns real tests. Drafted by agentic-qe
// (`aqe test generate kb/resolve-deps.mjs`, 24 assertions); rewritten here to assert the observable
// contract against a REAL temp filesystem (no fs mocks) so the tests survive an internal rewrite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseModelCache, configureModel, loadRvf } from '../../kb/resolve-deps.mjs';

const MODEL_SLUG = 'Xenova/all-MiniLM-L6-v2';
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.KB_MODEL_CACHE; });

describe('chooseModelCache — model-cache selection', () => {
  it('honors KB_MODEL_CACHE verbatim when set (explicit override wins)', () => {
    process.env.KB_MODEL_CACHE = '/explicit/cache/path';
    expect(chooseModelCache()).toBe('/explicit/cache/path');
  });
  it('KB_MODEL_CACHE wins even over a present local model dir', () => {
    process.env.KB_MODEL_CACHE = '/explicit/cache/path';
    fs.mkdirSync(path.join(tmp, MODEL_SLUG), { recursive: true });
    expect(chooseModelCache()).toBe('/explicit/cache/path');
  });
  it('falls back to a kb-local "models-cache" dir when no override is set', () => {
    delete process.env.KB_MODEL_CACHE;
    const r = chooseModelCache();
    expect(typeof r).toBe('string');
    expect(r.endsWith(path.join('kb', 'models-cache'))).toBe(true);
  });
});

describe('configureModel — offline-first embedder wiring', () => {
  it('points transformers at the given cache dir', () => {
    const T = { env: {} };
    configureModel(T, tmp);
    expect(T.env.localModelPath).toBe(tmp);
  });
  it('ALLOWS remote download when the model is NOT already cached', () => {
    const T = { env: {} };
    const r = configureModel(T, tmp); // tmp has no Xenova/... subdir
    expect(r.haveLocalModel).toBe(false);
    expect(T.env.allowRemoteModels).toBe(true);
  });
  it('DISABLES remote download when the model IS already cached (offline-first)', () => {
    fs.mkdirSync(path.join(tmp, MODEL_SLUG), { recursive: true });
    const T = { env: {} };
    const r = configureModel(T, tmp);
    expect(r.haveLocalModel).toBe(true);
    expect(T.env.allowRemoteModels).toBe(false);
  });
  it('returns the cache path it was given (round-trips modelCache)', () => {
    const r = configureModel({ env: {} }, tmp);
    expect(r.modelCache).toBe(tmp);
  });
});

describe('loadRvf — resolves the RVF SDK from the project', () => {
  it('returns the @ruvector/rvf module and a "via" provenance string', () => {
    const r = loadRvf(); // @ruvector/rvf is installed in this repo's node_modules
    expect(r.mod).toBeTruthy();
    expect(typeof r.via).toBe('string');
    expect(r.via.length).toBeGreaterThan(0);
  });
});
