import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSourceScopeReceipt, validateSourceScopeReceipt } from '../../scripts/source-scope-receipt.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-source-scope-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.mjs'), 'export const b = 2;\n');
  const inventory = () => ['src/a.mjs', 'src/b.mjs'];
  return { root, inventory };
}

describe('no-guess source scope receipt', () => {
  it('binds the complete repository inventory and every fully-read governed file', () => {
    const input = fixture();
    const receipt = buildSourceScopeReceipt({ ...input, sourceSha: 'a'.repeat(40), governedPaths: ['src/b.mjs', 'src/a.mjs'] });
    expect(receipt.repository.fileCount).toBe(2);
    expect(receipt.governed.files.map(({ path: relative }) => relative)).toEqual(['src/a.mjs', 'src/b.mjs']);
    expect(validateSourceScopeReceipt(receipt, input)).toBe(receipt);
  });

  it('rejects an omitted, mutated, unsafe, or forged governed surface', () => {
    const input = fixture();
    expect(() => buildSourceScopeReceipt({ ...input, governedPaths: ['src/missing.mjs'] })).toThrow(/outside repository inventory/);
    expect(() => buildSourceScopeReceipt({ ...input, governedPaths: ['../escape'] })).toThrow(/outside repository inventory|unsafe/);
    const receipt = buildSourceScopeReceipt({ ...input, governedPaths: ['src/a.mjs'] });
    fs.appendFileSync(path.join(input.root, 'src', 'a.mjs'), '// changed\n');
    expect(() => validateSourceScopeReceipt(receipt, input)).toThrow(/differs from the current/);
    receipt.governed.files[0].readComplete = false;
    expect(() => validateSourceScopeReceipt(receipt, input)).toThrow(/malformed/);
  });
});
