// ADR-0091 D6.7 — guard the workflow text. Both committed-seed consumers in ci.yml (the release-QE
// build and the warm-brain/require-brain job) must RESOLVE their seed through corpus-next-seed.mjs in
// code-release mode, never read data/corpus-seed.json directly; the build must go through the one
// dual-path orchestrator; and the legacy two-pass projection must be reachable only from there (where
// assemblyPathFor admits it only for a committed-bootstrap seed -- tests/unit/code-release-corpus.test.mjs).
// Also pins the corpus publisher's coverage hand-off (D6.2) and the publish-time guard's placement (D6.6).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const job = (source, name) => {
  const start = source.indexOf(`\n  ${name}:\n`);
  expect(start, `ci.yml has no ${name} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};
const RESOLVE = /node scripts\/corpus-next-seed\.mjs --repo "\$GITHUB_REPOSITORY" --require-coverage/;

describe('ci.yml corpus seed consumers (ADR-0091 D6.7)', () => {
  const ci = read('.github/workflows/ci.yml');

  it.each(['warm-brain', 'release-qe'])('%s resolves its seed through corpus-next-seed.mjs --require-coverage', (name) => {
    const body = job(ci, name);
    expect(body).toMatch(RESOLVE);
    expect(body).not.toMatch(/require\(['"]\.\/data\/corpus-seed\.json['"]\)/);
    expect(body).not.toContain('--pin');
  });

  it('no job in ci.yml reads the committed bootstrap descriptor directly', () => {
    expect(ci).not.toContain('data/corpus-seed.json');
  });

  it('release-qe seals the RESOLVED descriptor as corpus-seed.json release evidence and assembles through the dual-path orchestrator', () => {
    const body = job(ci, 'release-qe');
    expect(body).toContain('--out "$RUNNER_TEMP/release-evidence/corpus-seed.json"');
    expect(body).toContain('node scripts/code-release-corpus.mjs assemble --descriptor "$descriptor"');
    expect(body).toContain('--member "corpus-seed=$RUNNER_TEMP/release-evidence/corpus-seed.json"');
    // The coverage sidecar is fetched only for a generation seed, and handed to the orchestrator.
    expect(body).toContain('--pattern CORPUS-COVERAGE.json --pattern coverage-receipt.json');
  });

  it('the legacy two-pass projection and the capability-only mutation are not invoked from the workflow text', () => {
    for (const forbidden of ['--legacy-seed-projection', 'refresh-capability-only-store.mjs', 'rvf-index-audit.mjs --dir',
      'node scripts/release-projection.mjs', 'node scripts/build-bundle.mjs']) {
      expect(ci, `${forbidden} must live behind assemblyPathFor, not in ci.yml`).not.toContain(forbidden);
    }
    const orchestrator = read('scripts/code-release-corpus.mjs');
    const legacyBranch = orchestrator.slice(orchestrator.indexOf('if (mode === LEGACY_TWO_PASS)'), orchestrator.indexOf('// SINGLE-PASS.'));
    for (const legacyOnly of ["'--legacy-seed-projection'", "script('refresh-capability-only-store.mjs')", "'--repair'"]) {
      expect(legacyBranch).toContain(legacyOnly);
      expect(orchestrator.split(legacyOnly).length - 1, `${legacyOnly} must appear only in the legacy branch`).toBe(1);
    }
  });

  it('the corpus publisher is handed the generation\'s sealed coverage (D6.2)', () => {
    const release = read('.github/workflows/protected-release.yml');
    expect(release).toMatch(/node scripts\/release\.mjs --corpus-seed --stage-candidate[\s\S]{0,400}--corpus-coverage "\$staged\/source-coverage\.json"/);
    expect(read('.github/workflows/corpus-seed.yml')).toContain('cp data/source-coverage.json "$staged/source-coverage.json"');
  });

  it('the code publisher re-checks for a newer generation BEFORE the release transaction uploads anything (D6.6)', () => {
    const publisher = read('scripts/release.mjs');
    const guard = publisher.indexOf('await assertNoNewerCorpusGeneration(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publisher.indexOf('await runReleaseTransaction('));
  });
});
