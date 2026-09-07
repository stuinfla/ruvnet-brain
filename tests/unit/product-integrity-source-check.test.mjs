import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productIntegrityGovernedPaths, runProductIntegrityCli } from '../../scripts/product-integrity-contract.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-source-'));
  roots.push(root);
  for (const file of productIntegrityGovernedPaths()) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture source\n');
  }
  return root;
}
function check(root) {
  let output = '';
  const code = runProductIntegrityCli(['--check-source'], { root, stdout: { write: text => { output += text; } } });
  return { code, report: JSON.parse(output) };
}

describe('architecture QA checks named source, not only contract syntax', () => {
  it('reports source presence separately from unexecuted behavior', () => {
    const { code, report } = check(fixture());
    expect(code).toBe(0);
    expect(report).toMatchObject({ verdict: 'PASS', scope: 'source-presence', behaviorVerified: false, missing: [], invalid: [] });
  });
  it('fails with the exact absent implementation and acceptance test', () => {
    const root = fixture();
    for (const file of ['kb/update-storage-transaction.mjs', 'tests/acceptance/cross-host-project-resume.test.mjs']) fs.unlinkSync(path.join(root, file));
    const { code, report } = check(root);
    expect(code).toBe(1);
    expect(report.missing).toEqual(['kb/update-storage-transaction.mjs', 'tests/acceptance/cross-host-project-resume.test.mjs']);
  });
  it('refuses directories and symlinks in place of governed source', () => {
    const root = fixture();
    const file = path.join(root, 'kb/update-storage-transaction.mjs');
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(check(root).report.invalid).toEqual(['kb/update-storage-transaction.mjs']);
    fs.rmdirSync(file);
    fs.symlinkSync(path.join(root, 'kb/forge-update.mjs'), file);
    expect(check(root).code).toBe(1);
    expect(check(root).report.invalid).toEqual(['kb/update-storage-transaction.mjs']);
  });
});
