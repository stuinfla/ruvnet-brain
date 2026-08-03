import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const transaction = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction.mjs'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction-provider.mjs'), 'utf8');
const bundle = fs.readFileSync(path.join(ROOT, 'scripts/build-bundle.mjs'), 'utf8');

const position = (source, needle) => {
  const found = source.indexOf(needle);
  expect(found, `missing release operation: ${needle}`).toBeGreaterThanOrEqual(0);
  return found;
};

describe('release publication is one remote durable staged transaction', () => {
  it('binds signed append-only receipts to exact candidate and artifact identity', () => {
    expect(transaction).toContain('transactionIdFor');
    expect(transaction).toContain('candidateSha: identity.candidateSha');
    expect(transaction).toContain('packageIntegrity: identity.packageIntegrity');
    expect(transaction).toContain('bundleSha256: identity.bundleSha256');
    expect(transaction).toContain('crypto.sign');
    expect(transaction).toContain('previousReceiptDigest');
    expect(provider).toContain("command('gh', ['release', 'upload', anchor.tag, file, '--repo', REPO])");
    expect(provider).toContain('refusing to replace staged asset with different bytes');
    expect(provider).not.toContain("'--clobber'");
    expect(provider).toContain("'pack', `${PACKAGE}@candidate-v${identity.version}`");
    expect(provider).toContain('staged npm package integrity mismatch');
  });

  it('creates a remote draft before the first externally visible candidate mutation', () => {
    expect(position(transaction, "append('remote-prepared'"))
      .toBeLessThan(position(transaction, "intend('npm-stage-intent'"));
    expect(position(transaction, "intend('npm-stage-intent'"))
      .toBeLessThan(position(transaction, 'adapter.stageNpm'));
    expect(provider).toContain("'-F', 'draft=true'");
  });

  it('stages npm and GitHub non-latest before changing either default', () => {
    const operations = [
      'adapter.stageNpm',
      'adapter.publishDraftNonLatest',
      'adapter.promoteNpm',
      'adapter.makeGithubLatest',
      "append('channels-converged'",
    ].map((needle) => position(transaction, needle));
    expect(operations).toEqual([...operations].sort((a, b) => a - b));
    expect(provider).toContain("'make_latest=false'");
    expect(provider).toContain("'make_latest=true'");
  });

  it('requires bundle, signature, digest, and sealed package as one staged asset set', () => {
    expect(release).toContain('const assets = {');
    expect(release).toContain('bundleSignaturePath: `${zip}.sig`');
    expect(release).toContain('bundleDigestPath: `${zip}.sha256`');
    expect(release).toContain('packagePath: sealedPackageArtifact');
    expect(release).toContain('signed release asset missing');
    expect(provider).toContain('assets.packagePath');
  });

  it('rebuilds and audits the exact extracted archive before signing', () => {
    expect(bundle).toContain('fs.rmSync(ZIP, { force: true })');
    expect(bundle).toContain("await import('../kb/zip-extract.mjs')");
    expect(bundle).toContain('const packagedAudit = await auditRvfIndexes(packagedRvfs)');
    expect(position(release, "runOrDie('build release bundle'"))
      .toBeLessThan(position(release, "runOrDie('sign release bundle'"));
  });

  it('fails closed on competing transactions and duplicate drafts', () => {
    expect(transaction).toContain('pending release ${competing[0].transactionId} blocks');
    expect(transaction).toContain('duplicate matching drafts require reconciliation');
    expect(transaction).toContain('release receipt sequence gap or replay');
    expect(transaction).toContain('release receipt chain conflict');
  });

  it('uses guarded compensation and preserves an explicit human-only abort terminal', () => {
    expect(transaction).toContain("if (observed.version !== identity.version) throw new Error('npm latest changed during compensation')");
    expect(provider).toContain('refusing compensation: npm latest is');
    expect(transaction).toContain("if (!authorized) throw new Error('release abort requires explicit human authorization')");
  });

  it('creates final public evidence before appending channels-converged', () => {
    expect(position(provider, "'scripts/publication-receipt.mjs'"))
      .toBeLessThan(position(provider, "'scripts/release-proof.mjs'"));
    expect(position(transaction, 'adapter.finalize'))
      .toBeLessThan(position(transaction, "append('channels-converged'"));
    expect(provider).toContain("'scripts/verify-channels.mjs'");
    expect(provider).toContain("'scripts/published-surface-probe.mjs', '--json'");
  });
});
