import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSourceScopeReceipt, validateSourceScopeReceipt, digest } from '../../scripts/source-scope-receipt.mjs';

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
  it('binds the complete repository inventory and every byte-read governed file without certifying semantic review', () => {
    const input = fixture();
    const receipt = buildSourceScopeReceipt({ ...input, sourceSha: 'a'.repeat(40), governedPaths: ['src/b.mjs', 'src/a.mjs'] });
    expect(receipt.repository.fileCount).toBe(2);
    expect(receipt).toMatchObject({ schemaVersion: 2, evidenceScope: 'complete-repository-byte-inventory', semanticReview: { status: 'UNKNOWN', performed: false } });
    expect(receipt.governed.files.every(row => row.bytesReadComplete === true && !Object.hasOwn(row, 'readComplete'))).toBe(true);
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
    receipt.governed.files[0].bytesReadComplete = false;
    expect(() => validateSourceScopeReceipt(receipt, input)).toThrow(/malformed/);
  });
});

it('a legacy readComplete receipt is not current semantic or byte-inventory authority', () => {
  const input = fixture(), receipt = buildSourceScopeReceipt({ ...input, governedPaths: ['src/a.mjs'] });
  const legacy = { ...receipt, schemaVersion: 1 };
  delete legacy.evidenceScope; delete legacy.semanticReview;
  legacy.governed = { ...legacy.governed, files: legacy.governed.files.map(({ bytesReadComplete, ...row }) => ({ ...row, readComplete: true })) };
  const { receiptSha256, ...body } = legacy; legacy.receiptSha256 = digest(body);
  expect(() => validateSourceScopeReceipt(legacy, input)).toThrow(/malformed|legacy/);
});
it('rehashing a semantic PASS or readComplete flag cannot upgrade byte evidence into review', () => {
  const input = fixture(), receipt = buildSourceScopeReceipt({ ...input, governedPaths: ['src/a.mjs'] });
  for (const mutate of [copy => { copy.semanticReview = { status: 'PASS', performed: true }; },
    copy => { copy.governed.files[0].readComplete = true; }]) {
    const copy = structuredClone(receipt); mutate(copy); const { receiptSha256, ...body } = copy; copy.receiptSha256 = digest(body);
    expect(() => validateSourceScopeReceipt(copy, input)).toThrow(/malformed|differs/);
  }
});
