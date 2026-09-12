// seal-gist-receipt-policy.test.mjs — the exact regression that made every gist read FAILED.
//
// WHY THIS FILE EXISTS. Measured live 2026-09-12: resealing the gist receipt against the real
// installed corpus (~/.cache/ruvnet-brain/kb) still left validateGistAggregateReceipt throwing
// "observation differs from coverage" for all 492 gists, even immediately after a fresh, correct
// reseal. Root cause: this script's `--policy` (external-sources.json, no-corpus-repos.json)
// silently defaulted to `--assets`, but source-coverage.mjs's own buildCoverage() defaults policy
// to the REPO's kb/ regardless of where assets live. The install cache has no external-sources.json
// of its own, so the old default fell back to an empty external list -- 218 repos sealed into the
// receipt's combined hash instead of buildCoverage's real 228 -- and the mismatched REPOSITORY half
// of that one combined hash broke the GIST half of validation for all 492 gists, though nothing
// about any gist was wrong. A test that only calls the CLI end-to-end would need live GitHub
// access; this tests the pure resolution function instead, on a real temp directory layout.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePolicyDir, REPO_KB } from '../../scripts/seal-gist-receipt.mjs';

describe('seal-gist-receipt — policy directory must not silently follow --assets', () => {
  it('defaults to the repo kb/, never to an --assets override, when --policy is omitted', () => {
    const fakeAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-gist-assets-'));
    try {
      const resolved = resolvePolicyDir(['--assets', fakeAssets]);
      expect(resolved, 'policy must default to the repo kb, matching source-coverage.mjs main()').toBe(REPO_KB);
      expect(resolved).not.toBe(fakeAssets);
      // The repo's real external-sources.json must actually be there and non-empty -- the whole
      // point of the fix is that this file gets read, not silently treated as absent.
      const externalPath = path.join(resolved, 'external-sources.json');
      expect(fs.existsSync(externalPath), 'REPO_KB must contain the real policy file').toBe(true);
      const sources = JSON.parse(fs.readFileSync(externalPath, 'utf8')).sources;
      expect(Array.isArray(sources) && sources.length > 0, 'external sources must be non-empty').toBe(true);
    } finally {
      fs.rmSync(fakeAssets, { recursive: true, force: true });
    }
  });

  it('honours an explicit --policy override', () => {
    const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-gist-policy-'));
    try {
      expect(resolvePolicyDir(['--assets', 'kb', '--policy', explicit])).toBe(explicit);
    } finally {
      fs.rmSync(explicit, { recursive: true, force: true });
    }
  });
});
