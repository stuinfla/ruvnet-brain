import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/resolve-deps.mjs', () => ({ loadTransformers: vi.fn() }));
vi.mock('../../kb/model-requirements.mjs', () => ({
  modelCacheReady: vi.fn(() => true), materializeModelRevision: vi.fn(),
}));
let cache;
afterEach(() => {
  if (cache) fs.rmSync(cache, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});
it.each([false, true])('enables remote recovery once after rejecting ready cache; retry fails=%s', async (retryFails) => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-cache-retry-'));
  const ceDir = path.join(cache, 'Xenova/ms-marco-MiniLM-L-6-v2');
  fs.mkdirSync(ceDir, { recursive: true });
  fs.writeFileSync(path.join(ceDir, 'corrupt.onnx'), 'disposable');
  const permissions = [];
  const T = {
    env: {},
    AutoTokenizer: { from_pretrained: vi.fn(async () => {
      permissions.push(T.env.allowRemoteModels);
      if (permissions.length === 1) throw new Error('corrupt cached model');
      expect(fs.existsSync(ceDir)).toBe(false);
      if (!T.env.allowRemoteModels || retryFails) throw new Error('refetch unavailable');
      return () => ({});
    }) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () =>
      async () => ({ logits: { dims: [1, 1], data: [1.25] } })) },
  };
  const { loadTransformers } = await import('../../kb/resolve-deps.mjs');
  loadTransformers.mockResolvedValue({ T, modelCache: cache });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { warmReranker } = await import('../../kb/forge-rerank.mjs');
  if (retryFails) await expect(warmReranker()).rejects.toThrow('refetch unavailable');
  else await expect(warmReranker()).resolves.toBeUndefined();
  expect(permissions).toEqual([false, true]);
  expect(T.AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(2);
});
