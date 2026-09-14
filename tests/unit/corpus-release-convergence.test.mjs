import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transactionIdFor } from '../../scripts/release-transaction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('corpus and release convergence wiring', () => {
  it('pins CI to the committed seed descriptor and its digest', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(root, 'data/corpus-seed.json'), 'utf8'));
    expect(seed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(seed.bytes).toBeGreaterThan(0);
    expect(typeof seed.tag).toBe('string');
    expect(seed.tag.length).toBeGreaterThan(0);
    expect(seed.tag).not.toBe('latest');
    // The committed seed tag is either the real content-addressed identity (corpus-sha256-<digest>
    // of the exact seed bytes — see scripts/corpus-candidate.mjs's verifySeedBaseline)
    // or, for a seed minted before content-addressing existed, a pinned exception — sync-version-
    // ignore: an immutable external seed tag, never the candidate product version. A pinned tag is
    // legitimate ONLY when the bootstrap pipeline that consumes it explicitly acknowledges the pin:
    // scripts/corpus-reconcile.mjs's assertBootstrapIdentity requires allowPinnedTag=true for
    // exactly this case, matched here by --allow-pinned-seed-tag in the workflow that invokes it.
    // This is the test's real intent — that the committed pointer and the code consuming it agree —
    // preserved for either tag form rather than one hard-pinned literal string.
    const contentAddressed = seed.tag === `corpus-sha256-${seed.sha256}`;
    if (!contentAddressed) {
      const seedWorkflow = fs.readFileSync(path.join(root, '.github/workflows/corpus-seed.yml'), 'utf8');
      expect(seedWorkflow).toContain('--allow-pinned-seed-tag');
    }
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
