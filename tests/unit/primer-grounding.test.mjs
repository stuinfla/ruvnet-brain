import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countPrimerReferences, writeGroundedPrimer } from '../../scripts/primer-grounding.mjs';

describe('primer citation admission before publication', () => {
  it('preserves an existing primer and rejects a thin generation before any write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primer-grounding-'));
    const output = path.join(dir, 'primer.md');
    try {
      fs.writeFileSync(output, 'previous accepted primer');
      expect(() => writeGroundedPrimer({ primer: 'uncited prose', sourcePaths: ['src/a.js'], output })).toThrow(/THIN/);
      expect(fs.readFileSync(output, 'utf8')).toBe('previous accepted primer');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not turn one ambiguous basename into multiple citations', () => {
    expect(countPrimerReferences('`README.md`', ['a/README.md', 'b/README.md'])).toEqual([]);
    expect(countPrimerReferences('`a/README.md`', ['a/README.md', 'b/README.md'])).toEqual(['a/README.md']);
  });
  it('writes only after six distinct retrieved paths are cited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primer-grounding-'));
    try {
      const sourcePaths = Array.from({ length: 6 }, (_, i) => `src/file-${i}.js`);
      const primer = sourcePaths.map((file) => '`' + file + '`').join('\n');
      const output = path.join(dir, 'primer.md');
      const refs = writeGroundedPrimer({ primer, sourcePaths, output });
      expect(refs).toEqual(sourcePaths);
      expect(fs.readFileSync(output, 'utf8')).toBe(primer);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
