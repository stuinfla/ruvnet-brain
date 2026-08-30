import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/convergence-manifest.mjs');

describe('convergence manifest', () => {
  it('proves the committed source surfaces converge', () => {
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(JSON.parse(output).ok).toBe(true);
  });

  it('records the complete source and ADR inventory', () => {
    const manifest = path.join(ROOT, 'data/convergence-manifest.json');
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(value.trackedFileCount).toBeGreaterThan(800);
    expect(value.adrInventory.length).toBeGreaterThan(70);
    expect(value.ownershipChecks).toEqual(['version:check', 'doc:currency', 'wired:check']);
  });
});
