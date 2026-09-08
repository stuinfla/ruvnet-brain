import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const qe = fs.readFileSync(path.join(ROOT, 'scripts/qe/agentic-qe-4.3.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release-candidate-preflight.yml'), 'utf8');

describe('early public artifact QE', () => {
  it('runs the bounded packed-artifact boundary and host-convergence cases', () => {
    expect(qe).toContain("'early-public': [");
    for (const file of [
      'tests/qe/release/packed-clean-install.test.mjs',
      'tests/qe/release/issue-64-host-convergence.test.mjs',
      'tests/unit/npm-tarball-codex.test.mjs',
    ]) expect(qe).toContain(`'${file}'`);
  });

  it('is a required three-OS candidate gate and stays before publication', () => {
    expect(workflow).toContain('early-public:');
    expect(workflow).toContain('early-public-${{ github.sha }}-${{ matrix.os_name }}');
    expect(workflow).toContain('node scripts/qe/agentic-qe-4.3.mjs --lane early-public');
    const aggregate = workflow.indexOf('node scripts/prepublication-evidence.mjs');
    const early = workflow.indexOf('early-public-${{ github.sha }}-${{ matrix.os_name }}');
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(aggregate);
    expect(workflow).toContain('needs: [ci, integration, ux, stranger, early-public]');
  });
});
