// ADR-0091 D5 through the REAL assembler: a degraded corpus -- one store carried at its previous
// bytes (STALE + carry), one eligible store with no bytes at all (MISSING + failure) -- assembles,
// projects and re-validates on the full seed path. The same bundle stripped of the records is still
// refused. And the validator clients installed BEFORE D5 (origin/main before e76a182d, 2026-09-28) refuses
// the degraded bundle, fail-closed: such a client keeps its corpus. Since 2026-10-17 a bounded degraded
// generation publishes (the D10 soak constant is gone); the customer canary proves the installed path
// (tests/unit/corpus-canary.test.mjs, "a generation with a carried store").
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { SEED_IDENTITY, buildCorpus, buildRuntimeRoot, readJson, tempDir, writeCoverage } from '../helpers/assemble-bundle-fixture.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const IDENTITY = { version: '7.7.7-fixture', sourceSnapshot: 'a'.repeat(40) };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const MISSED = '9'.repeat(40);

const degrade = ({ withRecords = true } = {}) => (rows) => {
  const alpha = rows.find((row) => row.name === 'alpha');
  alpha.status = 'STALE';
  alpha.reasons = ['receipt sourceCommit differs from upstream HEAD'];
  alpha.upstream = { ...alpha.upstream, sha: MISSED };
  if (withRecords) {
    alpha.carry = { reason: 'qa: forge-refresh failed', carriedSourceCommit: alpha.artifact.sourceCommit,
      missedUpstream: MISSED, attempts: 1, carriedCommittedAt: null };
  }
  rows.push({
    key: 'repo:ruvnet/newrepo', kind: 'repository', name: 'newrepo', url: 'https://github.com/ruvnet/newrepo',
    routing: { description: null, homepageUrl: null, capabilityCardPresent: false }, disposition: 'eligible',
    upstream: { sha: MISSED, committedAt: null, pushedAt: null, updatedAt: null },
    artifact: { store: 'newrepo', sourceCommit: null, ingestedAt: null, rvfSha256: null, bytesVerified: false,
      passagesPresent: false, cardPresent: false },
    status: 'MISSING', reasons: ['canonical RVF is absent'],
    ...(withRecords ? { failure: { reason: 'transient: git clone failed', attempts: 2 } } : {}),
  });
};

describe('a degraded corpus through assembleBundle (ADR-0091 D5)', () => {
  it('assembles, projects and re-validates: carried store shipped, MISSING store excluded', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    writeCoverage(runtimeRoot, corpusDir, { mutate: degrade() });
    const outDir = path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: SEED_IDENTITY });
    expect(result.projection.binding.valid).toBe(true);
    const directory = validateCoverageDirectory(outDir, { expectedVersion: IDENTITY.version, expectedSourceSnapshot: IDENTITY.sourceSnapshot });
    expect(directory.failures).toEqual([]);
    expect(directory.publicInventory.repositories).toEqual(['alpha', 'beta']);
    const release = readJson(path.join(outDir, 'COVERAGE.json'));
    expect(release.rows.find((row) => row.name === 'alpha')).toMatchObject({ status: 'STALE', carry: { missedUpstream: MISSED } });
    expect(release.rows.find((row) => row.name === 'newrepo')).toMatchObject({ status: 'MISSING', failure: { attempts: 2 } });
    expect(fs.existsSync(path.join(outDir, 'newrepo.big.rvf'))).toBe(false);
  });

  it('refuses the same corpus when the rows carry no carry/failure record (still fail-closed)', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    writeCoverage(runtimeRoot, corpusDir, { mutate: degrade({ withRecords: false }) });
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir: path.join(tempDir(dirs, 'out'), 'ruvnet-brain'),
      identity: IDENTITY, seedIdentity: SEED_IDENTITY })).rejects.toThrow(/an eligible repository is not CURRENT/);
  });

  it('the validator installed clients already run (pre-D5 origin/main) REJECTS the degraded bundle -- the D10 constraint', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    writeCoverage(runtimeRoot, corpusDir, { mutate: degrade() });
    const outDir = path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: SEED_IDENTITY });
    let installed;
    try {
      installed = execFileSync('git', ['show', 'origin/main:plugin/scripts/coverage-integrity.mjs'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return; // no origin/main in this checkout: nothing to compare against
    }
    if (installed.includes('eligibleRepositoryStanding')) return; // origin/main already carries D5
    const legacyFile = path.join(tempDir(dirs, 'legacy-validator'), 'coverage-integrity.mjs');
    fs.writeFileSync(legacyFile, installed);
    const legacy = await import(pathToFileURL(legacyFile).href);
    const verdict = legacy.validateCoverageDirectory(outDir, { expectedVersion: IDENTITY.version });
    expect(verdict.valid).toBe(false);
    expect(verdict.failures.join('; ')).toMatch(/an eligible repository is not CURRENT/);
  });
});
