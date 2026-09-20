import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindCapabilityOnlyGeneration, prepareCapabilityOnlyInputs, pruneCapabilityOnlySelfStore } from '../../scripts/refresh-capability-only-store.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-store-refresh-'));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 2, kind: 'ruvnet-brain-runtime-generation-ledger', brainVersion: '4.3.26',
    releaseTag: 'v4.3.26', sourceSnapshot: 'a'.repeat(40),
    stores: { 'cognitum-ruos': { file: 'cognitum-ruos.big.rvf', sourceCommit: null } },
  }));
  return dir;
}

describe('refresh capability-only store', () => {
  it('replaces source-bearing ruOS sidecars with the single curated capability passage', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'cognitum-ruos.symbols.json'), 'private symbol index');
    fs.writeFileSync(path.join(dir, 'cognitum-ruos.rvf'), 'legacy private vector');
    const { sourceText } = prepareCapabilityOnlyInputs(dir);
    const expected = fs.readFileSync(new URL('../../kb/capability-summaries/cognitum-ruos/CAPABILITIES.md', import.meta.url), 'utf8');
    const passages = fs.readFileSync(path.join(dir, 'cognitum-ruos.passages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'cognitum-ruos.meta.json'), 'utf8'));
    expect(sourceText).toBe(expected);
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ path: 'CAPABILITIES.md', text: expected });
    expect(Object.values(meta.entries)).toHaveLength(1);
    expect(Object.values(meta.entries)[0]).toMatchObject({ path: 'CAPABILITIES.md', kind: 'doc' });
    expect(fs.existsSync(path.join(dir, 'cognitum-ruos.symbols.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cognitum-ruos.rvf'))).toBe(false);
  });

  it('rebinds the runtime ledger to the rebuilt RVF bytes and enforces the public 768-dim contract', () => {
    const dir = fixture();
    prepareCapabilityOnlyInputs(dir);
    const bytes = Buffer.from('fresh summary-only RVF');
    fs.writeFileSync(path.join(dir, 'cognitum-ruos.big.rvf'), bytes);
    fs.writeFileSync(path.join(dir, 'cognitum-ruos.big.rvf.embed.json'), JSON.stringify({
      model: 'Xenova/bge-base-en-v1.5', dimensions: 768,
    }));
    const row = bindCapabilityOnlyGeneration(dir, { builtUtc: '2026-09-20T00:00:00.000Z' });
    expect(row).toMatchObject({
      file: 'cognitum-ruos.big.rvf',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, model: 'Xenova/bge-base-en-v1.5', dimensions: 768,
      sourceCommit: null, builtUtc: '2026-09-20T00:00:00.000Z',
    });
  });

  it('rejects a rebuilt store with the wrong dimensionality', () => {
    const dir = fixture();
    prepareCapabilityOnlyInputs(dir);
    fs.writeFileSync(path.join(dir, 'cognitum-ruos.big.rvf'), 'fresh store');
    fs.writeFileSync(path.join(dir, 'cognitum-ruos.big.rvf.embed.json'), JSON.stringify({
      model: 'Xenova/bge-base-en-v1.5', dimensions: 384,
    }));
    expect(() => bindCapabilityOnlyGeneration(dir)).toThrow(/768-dim/);
  });

  it('prunes historical ruOS primer passages, metadata IDs, RVF vectors, and generation identity', async () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'ruvnet-brain.big.rvf'), 'before');
    fs.writeFileSync(path.join(dir, 'ruvnet-brain.passages.jsonl'), [
      { id: 'keep', path: 'kb/other.md', text: 'public' },
      { id: 'private-1', path: 'kb/cognitum-ruos-primer.md', text: 'internal source detail' },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'ruvnet-brain.meta.json'), JSON.stringify({ entries: {
      'kb/other.md': { chunkIds: ['keep'] },
      'kb/cognitum-ruos-primer.md': { chunkIds: ['private-1'] },
    } }));
    let deleted;
    const fakeDb = {
      delete: async ids => { deleted = ids; fs.writeFileSync(path.join(dir, 'ruvnet-brain.big.rvf'), 'after'); },
      compact: async () => {}, close: async () => {},
    };
    const result = await pruneCapabilityOnlySelfStore(dir, { RvfDatabase: { open: async () => fakeDb } });
    expect(result).toEqual({ removed: 1 });
    expect(deleted).toEqual(['private-1']);
    expect(fs.readFileSync(path.join(dir, 'ruvnet-brain.passages.jsonl'), 'utf8')).not.toContain('cognitum-ruos-primer');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ruvnet-brain.meta.json'), 'utf8')).entries)
      .not.toHaveProperty('kb/cognitum-ruos-primer.md');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'RVF-GENERATIONS.json'), 'utf8')).stores['ruvnet-brain'])
      .toMatchObject({ bytes: 5, sha256: crypto.createHash('sha256').update('after').digest('hex') });
  });
});
