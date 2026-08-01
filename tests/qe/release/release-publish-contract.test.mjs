import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const source = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const bundleSource = fs.readFileSync(path.join(ROOT, 'scripts/build-bundle.mjs'), 'utf8');

const position = (needle) => {
  const found = source.indexOf(needle);
  expect(found, `missing release operation: ${needle}`).toBeGreaterThanOrEqual(0);
  return found;
};

describe('release publication is bound to one candidate', () => {
  it('targets the exact HEAD and verifies the resulting remote tag before npm changes', () => {
    expect(source).toContain("const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']");
    expect(source).toContain("'--target', head");
    expect(source).toContain('release tag already identifies different bytes');
    expect(source).toContain('published GitHub Release tag is not candidate HEAD');
    expect(position('publishedTagSha !== head')).toBeLessThan(position("runOrDie('npm publish'"));
  });

  it('supports annotated and lightweight tags without accepting a collision', () => {
    expect(source).toContain('`refs/tags/${tag}^{}`');
    expect(source).toContain("ref?.endsWith('^{}')");
    expect(source).toMatch(/remoteTagSha && remoteTagSha !== head/);
  });

  it('fails closed in build-sign-release-npm-verify order', () => {
    const operations = [
      "runOrDie('build release bundle'",
      "runOrDie('sign release bundle'",
      "runOrDie('create signed GitHub Release'",
      "runOrDie('npm publish'",
      "runOrDie('npm dist-tag latest'",
      "runOrDie('verify-channels'",
    ].map(position);
    expect(operations).toEqual([...operations].sort((a, b) => a - b));
  });

  it('requires the bundle, signature, digest, and sealed package as one release asset set', () => {
    expect(source).toContain('const assets = [zip, `${zip}.sig`, `${zip}.sha256`, sealedPackageArtifact]');
    expect(source).toContain('signed release asset missing');
    expect(source).toContain("'release', 'create', tag, ...assets");
    expect(source).toContain("runOrDie('npm publish', 'npm', ['publish', sealedPackageArtifact, '--tag', 'latest'])");
  });

  it('rebuilds and audits the exact extracted archive before the signer can run', () => {
    expect(bundleSource).toContain('fs.rmSync(ZIP, { force: true })');
    expect(bundleSource).toContain("await import('../kb/zip-extract.mjs')");
    expect(bundleSource).toContain('const packagedAudit = await auditRvfIndexes(packagedRvfs)');
    expect(bundleSource).toContain('exact archive proof:');
    expect(position("runOrDie('build release bundle'"))
      .toBeLessThan(position("runOrDie('sign release bundle'"));
  });

  it('is retryable without moving an existing tag or duplicating assets', () => {
    expect(source).toContain("'release', 'view', tag");
    expect(source).toContain("'release', 'upload', tag, ...assets, '--clobber'");
    expect(source).toContain('already on npm — skipping publish');
    expect(source).toContain("runOrDie('npm dist-tag latest'");
  });

  it('records a recoverable cross-channel transaction before the first remote mutation', () => {
    const transaction = position('release-transaction');
    expect(transaction).toBeLessThan(position("runOrDie('create signed GitHub Release'"));
    expect(source).toContain('github-published-npm-pending');
    expect(source).toContain('channels-converged');
  });

  it('binds the transaction to signed artifact bytes across retries', () => {
    expect(source).toContain('bundleSha256');
    expect(source).toContain('priorTxn.bundleSha256 === bundleSha256');
    expect(source).toContain('unfinished release transaction requires reconciliation');
  });

  it('does not overwrite an unfinished transaction for another candidate', () => {
    expect(source).toContain('unfinished release transaction');
    expect(position('unfinished release transaction'))
      .toBeLessThan(position("recordReleaseTransaction('prepared'"));
  });

  it('resumes a pending candidate without rebuilding nondeterministic bundle bytes', () => {
    expect(position('const priorTxn = readReleaseTransaction()'))
      .toBeLessThan(position("runOrDie('build release bundle'"));
    expect(source).toContain('resume existing signed release assets');
  });

  it('claims channel convergence only after the live channel verifier succeeds', () => {
    expect(position("recordReleaseTransaction('channels-converged'"))
      .toBeGreaterThan(position("runOrDie('verify-channels'"));
  });
});
