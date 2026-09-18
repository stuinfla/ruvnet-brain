import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../kb/resolve-deps.mjs', () => ({
  loadRvf: () => ({
    via: 'hermetic-fixture',
    mod: { RvfDatabase: { openReadonly: async () => ({
      query: async () => [{ id: 'chunk-a', distance: 0.1 }, { id: 'chunk-b', distance: 0.2 }],
    }) } },
  }),
  loadTransformers: async () => ({
    via: 'hermetic-fixture', modelCache: os.tmpdir(),
    T: { env: { allowRemoteModels: false }, pipeline: async () => async () => ({ data: new Float32Array([1, 0, 0]) }) },
  }),
}));
vi.mock('../../kb/model-requirements.mjs', () => ({
  configureTransformersModel: () => {}, materializeModelRevision: () => {},
}));

import { searchKb } from '../../kb/forge-ask.mjs';

const roots = [];
afterEach(() => {
  delete process.env.KB_RETRIEVAL_STAGE_TRACE;
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-real-stage-trace-'));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, 'sample.rvf'), 'hermetic RVF placeholder');
  fs.writeFileSync(path.join(dir, 'sample.passages.jsonl'), [
    { id: 'chunk-a', path: 'answer.md', title: 'Answer', text: 'answer text' },
    { id: 'chunk-b', path: 'answer.md', title: 'Answer', text: 'answer continuation' },
  ].map(JSON.stringify).join('\n') + '\n');
  return dir;
}

describe('real searchKb stage trace seam', () => {
  it('captures raw and collapsed stages only when opted in, without changing normal shape', async () => {
    const dir = fixture();
    const off = await searchKb({ dir, name: 'sample', query: 'answer', k: 1 });
    const trace = path.join(dir, 'trace.jsonl');
    process.env.KB_RETRIEVAL_STAGE_TRACE = trace;
    const on = await searchKb({ dir, name: 'sample', query: 'answer', k: 1 });
    expect(Object.keys(off[0])).not.toContain('_rawRank');
    expect(on[0]._rawRank).toBe(1);
    const { _rawRank, ...onShape } = on[0];
    expect(_rawRank).toBe(1);
    expect(onShape).toEqual(off[0]);
    const records = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map((record) => record.stage)).toEqual(['raw-dense', 'post-document-collapse']);
    expect(records[0].candidates[0]).toMatchObject({ id: 'chunk-a', path: 'answer.md', rawRank: 1, distance: 0.1 });
    expect(records[1].candidates).toHaveLength(1);
  });

  it('does not invoke the trace writer or mapping work when disabled', async () => {
    const dir = fixture();
    const writer = vi.spyOn(fs, 'appendFileSync');
    await searchKb({ dir, name: 'sample', query: 'answer', k: 1 });
    expect(writer).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'trace.jsonl'))).toBe(false);
  });

  it('keeps retrieval successful when the trace destination is unwritable', async () => {
    const dir = fixture();
    process.env.KB_RETRIEVAL_STAGE_TRACE = path.join(dir, 'trace.jsonl');
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('diagnostic destination unavailable'); });
    await expect(searchKb({ dir, name: 'sample', query: 'answer', k: 1 })).resolves.toHaveLength(1);
  });
});
