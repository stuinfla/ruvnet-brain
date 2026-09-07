import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as models from '../../kb/model-requirements.mjs';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-preservation-'));
  roots.push(root);
  return root;
}

describe('S4 does not introduce destructive model-cache optimization', () => {
  it('cannot reclaim an ancestor of the canonical cache', () => {
    const legacy = fixture();
    const canonical = path.join(legacy, 'canonical');
    fs.mkdirSync(canonical);
    // The restored historical implementation accepts an empty descendant during verification
    // and recursively deletes its ancestor, including the canonical directory itself.
    if (models.reclaimRedundantModelCache) models.reclaimRedundantModelCache(legacy, canonical);
    expect(fs.existsSync(canonical)).toBe(true);
    expect(models.reclaimRedundantModelCache).toBeUndefined();
  });

  for (const failure of ['EIO', 'EXDEV']) {
    it(`preserves an already good model when link/copy operations fail with ${failure}`, () => {
      const root = fixture();
      const model = models.BGE_MODEL;
      const destination = models.modelPath(root, model);
      for (const file of ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']) {
        for (const revision of ['', 'pinned']) {
          const target = path.join(destination, revision, file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `${revision || 'good'}:${file}`);
        }
      }
      const fail = () => { throw Object.assign(new Error('injected filesystem failure'), { code: failure }); };
      vi.spyOn(fs, 'linkSync').mockImplementation(fail);
      vi.spyOn(fs, 'copyFileSync').mockImplementation(fail);
      vi.spyOn(fs, 'cpSync').mockImplementation(fail);
      let error;
      try { models.materializeModelRevision(root, model, 'pinned'); } catch (caught) { error = caught; }
      for (const file of ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']) {
        expect(fs.existsSync(path.join(destination, file))).toBe(true);
        expect(fs.readFileSync(path.join(destination, file), 'utf8')).toBe(`good:${file}`);
      }
      expect(error).toBeUndefined();
      expect(fs.linkSync).not.toHaveBeenCalled();
      expect(fs.copyFileSync).not.toHaveBeenCalled();
      expect(fs.cpSync).not.toHaveBeenCalled();
    });
  }

  it('does not add model-cache reclamation to doctor', () => {
    const installer = fs.readFileSync(new URL('../../bin/install.mjs', import.meta.url), 'utf8');
    expect(installer.includes('reclaimRedundantModelCache')).toBe(false);
  });
});
