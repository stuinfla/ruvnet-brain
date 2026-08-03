import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const transaction = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction.mjs'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction-provider.mjs'), 'utf8');
const bundle = fs.readFileSync(path.join(ROOT, 'scripts/build-bundle.mjs'), 'utf8');
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const protectedWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');

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
    expect(provider).toContain('fetch(metadata.dist.tarball');
    expect(provider).not.toContain("command('npm', ['pack'");
    expect(provider).toContain('staged npm package integrity mismatch');
  });

  it('creates a remote draft before the first externally visible candidate mutation', () => {
    expect(position(transaction, "append('remote-prepared'"))
      .toBeLessThan(position(transaction, "transition('npm-stage-intent'"));
    expect(position(transaction, "transition('npm-stage-intent'"))
      .toBeLessThan(position(transaction, 'adapter.stageNpm'));
    expect(provider).toContain("'-F', 'draft=true'");
  });

  it('stages npm and GitHub non-latest before changing either default', () => {
    const operations = [
      'adapter.stageNpm',
      'adapter.publishDraftNonLatest',
      'adapter.promoteNpm',
      'adapter.makeGithubLatest',
    ].map((needle) => position(transaction, needle));
    operations.push(transaction.lastIndexOf("append('channels-converged'"));
    expect(operations).toEqual([...operations].sort((a, b) => a - b));
    expect(provider).toContain("'make_latest=false'");
    expect(provider).toContain("'make_latest=true'");
  });

  it('requires bundle, signature, digest, and sealed package as one staged asset set', () => {
    expect(release).toContain('const assets = {');
    expect(release).toContain("bundleSignaturePath: path.join(payloadRoot, 'ruvnet-brain.zip.sig')");
    expect(release).toContain("bundleDigestPath: path.join(payloadRoot, 'ruvnet-brain.zip.sha256')");
    expect(release).toContain("packagePath: byRole.get('npm')");
    expect(release).toContain('signed release asset missing');
    expect(provider).toContain('assets.packagePath');
  });

  it('builds once in candidate CI, signs once in the protected seal job, and never rebuilds in the publisher', () => {
    expect(bundle).toContain('fs.rmSync(ZIP, { force: true })');
    expect(bundle).toContain("await import('../kb/zip-extract.mjs')");
    expect(bundle).toContain('const packagedAudit = await auditRvfIndexes(packagedRvfs)');
    expect(ci).toContain('node scripts/build-bundle.mjs');
    expect(protectedWorkflow).toContain('Reuse persisted signature or sign exactly once');
    expect(protectedWorkflow).toContain('node scripts/sign-bundle.mjs');
    expect(release).not.toContain("runOrDie('build release bundle'");
    expect(release).not.toContain("runOrDie('sign release bundle'");
  });

  it('fails closed on competing transactions and duplicate drafts', () => {
    expect(transaction).toContain('pending release ${competing[0].transactionId} blocks');
    expect(transaction).toContain('duplicate matching drafts require reconciliation');
    expect(transaction).toContain('release receipt sequence gap or replay');
    expect(transaction).toContain('release receipt chain conflict');
  });

  it('uses guarded compensation and preserves an explicit human-only abort terminal', () => {
    expect(transaction).toContain("snapshot.npm?.latestVersion !== prior?.npmLatest");
    expect(provider).toContain('refusing compensation: npm latest is');
    expect(transaction).toContain("if (!authorized) throw new Error('release abort requires explicit human authorization')");
  });

  it('creates final public evidence before appending channels-converged', () => {
    expect(position(provider, "'scripts/publication-receipt.mjs'"))
      .toBeLessThan(position(provider, "'scripts/release-proof.mjs'"));
    expect(position(transaction, 'adapter.finalize'))
      .toBeLessThan(transaction.lastIndexOf("append('channels-converged'"));
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(provider).not.toContain("'scripts/published-surface-probe.mjs', '--json'");
    expect(provider).toContain('publication.postPublicationChecks');
  });
});
