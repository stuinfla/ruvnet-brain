import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transactionIdFor } from '../../scripts/release-transaction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('corpus and release convergence wiring', () => {
  it('pins CI to the committed seed descriptor and its digest', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(root, 'data/corpus-seed.json'), 'utf8'));
    expect(seed.tag).toBe('v4.2.1-dev');
    expect(seed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(seed.bytes).toBeGreaterThan(0);
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('data/corpus-seed.json');
    expect(workflow).toContain('SEED_SHA256');
    expect(workflow).not.toMatch(/gh release download --repo[^\n]+--pattern ruvnet-brain\.zip/);
  });

  it('binds corpus seed and generation ledger digests into release identity', () => {
    const base = { repository: 'r', package: 'p', version: '1', tag: 'v1', candidateSha: 'a', packageIntegrity: 'i', bundleSha256: 'b' };
    expect(transactionIdFor({ ...base, corpusSeedSha256: 'c', generationLedgerSha256: 'd' }))
      .not.toBe(transactionIdFor(base));
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/protected-release.yml'), 'utf8');
    const publish = workflow.indexOf('node scripts/release.mjs --publish');
    const fetch = workflow.lastIndexOf('git fetch --no-tags origin main', publish);
    expect(fetch).toBeGreaterThan(0);
    expect(publish - fetch).toBeLessThan(800);
  });
});
