import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packedCandidate } from '../helpers/packed-candidate.mjs';

describe('continuity consumes the sealed release candidate', () => {
  it('never repacks supplied bytes or falls back after an invalid explicit path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-continuity-'));
    const run = vi.fn();
    try {
      const archive = path.join(dir, 'candidate.tgz');
      fs.writeFileSync(archive, 'immutable fixture archive');
      expect(packedCandidate({ sealedPackage: archive, run })).toBe(archive);
      expect(() => packedCandidate({ sealedPackage: path.join(dir, 'missing'), run })).toThrow();
      expect(() => packedCandidate({ sealedPackage: dir, run })).toThrow(/regular archive/);
      expect(run).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('permits one explicit local diagnostic pack and propagates its failure', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '[{"filename":"candidate.tgz"}]' }));
    expect(packedCandidate({ root: '/source', destination: '/temporary', run })).toBe(path.join('/temporary', 'candidate.tgz'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1][0]).toBe('pack');
    expect(() => packedCandidate({ run: () => ({ status: 1, stderr: 'pack failed' }) })).toThrow('pack failed');
  });
});
