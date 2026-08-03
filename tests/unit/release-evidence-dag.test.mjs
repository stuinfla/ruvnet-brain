import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('release evidence DAG', () => {
  it('builds one npm candidate and fans those exact bytes into release QE and stranger hosts', () => {
    const ci = read('.github/workflows/ci.yml');
    const stranger = read('.github/workflows/stranger-matrix.yml');
    expect(ci.match(/npm pack --json/g)).toHaveLength(1);
    expect(ci).toContain('RUVNET_SEALED_PACKAGE=$artifact');
    expect(ci.indexOf('Build the immutable npm candidate exactly once'))
      .toBeLessThan(ci.indexOf('Exact-artifact release QE'));
    expect(stranger).not.toMatch(/^\s*run:\s*npm pack/m);
    expect(stranger).toContain('actions/download-artifact@v4');
    expect(stranger).toContain('release-evidence-${{ env.CANDIDATE_SHA }}');
  });

  it('keeps source gates out of the protected publication branch', () => {
    const release = read('scripts/release.mjs');
    const checkOnly = release.indexOf('if (!PUBLISH) {');
    const transaction = release.indexOf('if (PUBLISH) {', checkOnly + 1);
    expect(checkOnly).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(checkOnly);
    const sourceGates = release.slice(checkOnly, transaction);
    expect(sourceGates).toContain("runOrDie('npm test'");
    expect(sourceGates).toContain("runOrDie('vitest unit'");
    expect(sourceGates).toContain("runOrDie('version sync'");
    expect(release).not.toContain("runOrDie('git push'");
    expect(release).not.toContain('fetchLatestCiVerdict');
  });

  it('verifies public channels once per publish through transaction finalization', () => {
    const release = read('scripts/release.mjs');
    const provider = read('scripts/release-transaction-provider.mjs');
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(provider).toContain('publication.postPublicationChecks');
    expect(release).toContain('if (!PUBLISH) {\n  step(\'E\'');
  });
});
