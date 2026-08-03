import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mergeManagedCatalog } from '../../scripts/model-router-catalog.mjs';

const MANAGED = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, '../../config/model-router/catalog.template.json'),
  'utf8',
));

describe('issue #87 — managed catalog additions and user overlay preservation', () => {
  it('adds Opus 5 to an old catalog while preserving overrides and never enabling a metered candidate', () => {
    const existing = {
      updated: '2026-07-12 (local)',
      candidates: [
        { id: 'claude-opus-4-8', provider: 'anthropic', harness: [], subscription: [], tier: 'mid', disabled: true },
        { id: 'custom/local', provider: 'local', harness: ['claude-code'], subscription: [], tier: 'cheap' },
      ],
    };
    const merged = mergeManagedCatalog(existing, MANAGED);
    expect(merged.candidates.find((candidate) => candidate.id === 'claude-opus-4-8')).toEqual(existing.candidates[0]);
    expect(merged.candidates).toContainEqual(existing.candidates[1]);
    expect(merged.candidates.find((candidate) => candidate.id === 'claude-opus-5')).toMatchObject({
      provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier',
    });
    expect(merged.candidates.filter((candidate) => candidate.provider === 'openrouter' && !existing.candidates.some((old) => old.id === candidate.id)))
      .toEqual([]);
  });

  it('is idempotent', () => {
    const once = mergeManagedCatalog({ candidates: [] }, MANAGED);
    expect(mergeManagedCatalog(once, MANAGED)).toEqual(once);
  });

  it('the Console renders every launchable development model and marks receipts separately', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../console/app.js'), 'utf8');
    expect(source).toMatch(/const devRows = pool\s*\.filter/);
    expect(source).toMatch(/recommended\?\.model === p\.id/);
    expect(source).toContain('All ${devRows.length} launchable Claude Code models are shown');
    expect(source).not.toMatch(/const devRows = bestPerTier/);
  });
});
