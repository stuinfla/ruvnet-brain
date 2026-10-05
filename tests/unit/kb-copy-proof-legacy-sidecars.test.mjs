import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { kbCopyProof } from '../../plugin/scripts/kb-copy-proof.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture({ privateStore = false, extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-legacy-sidecars-'));
  roots.push(root);
  const liveDir = path.join(root, 'live');
  const copyDir = path.join(root, 'copy');
  fs.mkdirSync(liveDir); fs.mkdirSync(copyDir);
  fs.writeFileSync(path.join(liveDir, 'SOURCE.json'), JSON.stringify({ stores: [{ kbName: 'agentdb', updateManaged: !privateStore }] }));
  fs.writeFileSync(path.join(liveDir, 'agentdb.big.rvf'), 'live public fixture');
  fs.writeFileSync(path.join(copyDir, 'SOURCE.json'), '{}');
  // This positive fixture's differing public metadata has the existing exact release-file witness.
  fs.writeFileSync(path.join(copyDir, 'ARCHIVE-MANIFEST.json'), JSON.stringify({ files: [{ path: 'SOURCE.json', bytes: 2,
    sha256: crypto.createHash('sha256').update('{}').digest('hex') }] }));
  for (const [name, bytes] of Object.entries(extra)) fs.writeFileSync(path.join(copyDir, name), bytes);
  return { liveDir, copyDir };
}

describe('legacy public .big sidecar classification (#335)', () => {
  it.each(['meta.json', 'passages.jsonl', 'symbols.json'])('recognizes agentdb.big.%s without modifying any evidence', (suffix) => {
    const name = `agentdb.big.${suffix}`;
    const dirs = fixture({ extra: { [name]: 'preserved original bytes' } });
    expect(kbCopyProof(dirs)).toMatchObject({ disposable: true, unique: [] });
    expect(fs.readFileSync(path.join(dirs.copyDir, name), 'utf8')).toBe('preserved original bytes');
  });

  it('retains missing or divergent private legacy sidecars even with public coverage', () => {
    const name = 'agentdb.big.passages.jsonl';
    const dirs = fixture({ privateStore: true, extra: { [name]: 'private original' } });
    fs.writeFileSync(path.join(dirs.liveDir, 'COVERAGE.json'), JSON.stringify({ rows: [{ name: 'agentdb' }] }));
    expect(kbCopyProof(dirs)).toMatchObject({ disposable: false, unique: [{ file: name, why: 'private file absent from the live brain' }] });
    fs.writeFileSync(path.join(dirs.liveDir, name), 'different private bytes');
    expect(kbCopyProof(dirs)).toMatchObject({ disposable: false, unique: [{ file: name, why: 'private file differs from the live brain' }] });
    fs.writeFileSync(path.join(dirs.liveDir, name), 'private original');
    expect(kbCopyProof(dirs).disposable).toBe(true);
  });

  it('keeps unrelated helper files, unknown suffixes, unfenced stores and symlinks', () => {
    const dirs = fixture({ extra: { 'agentdb.big.meta.json': '{}', 'agentdb.big.notes.json': 'user notes',
      'other.big.passages.jsonl': 'unknown store', 'helper.test.mjs': 'user helper' } });
    fs.symlinkSync('agentdb.big.meta.json', path.join(dirs.copyDir, 'agentdb.big.symbols.json'));
    const result = kbCopyProof(dirs);
    expect(result.disposable).toBe(false);
    expect(result.unique.map(({ file }) => file).sort()).toEqual([
      'agentdb.big.notes.json', 'agentdb.big.symbols.json', 'helper.test.mjs', 'other.big.passages.jsonl',
    ]);
    expect(fs.readlinkSync(path.join(dirs.copyDir, 'agentdb.big.symbols.json'))).toBe('agentdb.big.meta.json');
  });
});
