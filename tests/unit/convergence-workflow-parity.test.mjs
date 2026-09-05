import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('convergence manifest workflow parity', () => {
  it('regenerates the synthetic merge manifest before the Windows unit suite reads it', () => {
    const windowsJob = workflow.slice(
      workflow.indexOf('  windows-unit:'),
      workflow.indexOf('  warm-brain:'),
    );
    const checkout = windowsJob.indexOf('- uses: actions/checkout@v4');
    const regenerate = windowsJob.indexOf('run: npm run convergence:write');
    const unitSuite = windowsJob.indexOf('--name windows-unit');

    expect(checkout).toBeGreaterThan(-1);
    expect(regenerate).toBeGreaterThan(checkout);
    expect(unitSuite).toBeGreaterThan(regenerate);
  });
});
