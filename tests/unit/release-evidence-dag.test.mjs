import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('same-run release evidence DAG', () => {
  it('builds one npm candidate and never rebuilds it in downstream lanes', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci.match(/npm pack --json/g)).toHaveLength(1);
    expect(ci).toContain('RUVNET_SEALED_PACKAGE=$artifact');
    expect(ci.indexOf('Build the immutable npm candidate exactly once'))
      .toBeLessThan(ci.indexOf('Exact-artifact release QE'));
    for (const workflow of ['integration-linux.yml', 'ux-qe.yml', 'stranger-matrix.yml', 'protected-release.yml']) {
      expect(read(`.github/workflows/${workflow}`), `${workflow} must consume the sealed candidate`).not.toMatch(/^\s*run:\s*npm pack/m);
    }
  });

  it('persists a source-bound artifact receipt from every reusable lane', () => {
    const producers = [
      ['ci.yml', 'release-evidence-${{ inputs.candidate_sha }}'],
      ['integration-linux.yml', 'integration-evidence-${{ inputs.candidate_sha }}'],
      ['ux-qe.yml', 'ux-evidence-${{ inputs.candidate_sha }}'],
      ['stranger-matrix.yml', 'stranger-evidence-${{ inputs.candidate_sha }}'],
    ];
    for (const [file, artifact] of producers) {
      const source = read(`.github/workflows/${file}`);
      expect(source, `${file} must upload its receipt`).toContain('actions/upload-artifact@v4');
      expect(source, `${file} receipt must be candidate-bound`).toContain(`name: ${artifact}`);
    }
  });

  it('downloads and validates every same-run lane receipt before aggregation', () => {
    const source = read('.github/workflows/protected-release.yml');
    const aggregate = source.indexOf('node scripts/release-evidence-aggregate.mjs');
    expect(aggregate).toBeGreaterThan(-1);
    for (const artifact of ['release-evidence-', 'integration-evidence-', 'ux-evidence-', 'stranger-evidence-']) {
      const download = source.indexOf(`name: ${artifact}`);
      expect(download, `${artifact} receipt must be restored`).toBeGreaterThan(-1);
      expect(download, `${artifact} receipt must be restored before aggregation`).toBeLessThan(aggregate);
    }
    expect(source.slice(0, aggregate)).toContain('node scripts/release-proof.mjs --candidate');
    expect(source).not.toContain('NEEDS_JSON: ${{ toJson(needs) }}');
  });

  it('keeps source gates out of the protected provider-mutation branch', () => {
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

  it('keeps public-byte verification out of publication and in the protected matrix', () => {
    const release = read('scripts/release.mjs');
    const provider = read('scripts/release-transaction-provider.mjs');
    const workflow = read('.github/workflows/protected-release.yml');
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(provider).not.toContain('publication.postPublicationChecks');
    expect(workflow).toContain('node scripts/public-verification-lane.mjs');
    expect(workflow).toContain('node scripts/public-verification-finalizer.mjs');
    expect(release).toContain("if (!PUBLISH) {\n  step('E'");
  });
});
