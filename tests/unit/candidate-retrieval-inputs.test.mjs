import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readCandidateRetrieval, verifyCandidateRetrievalAssets } from '../../scripts/staged-host-verifier.mjs';
import { candidateRetrievalFixture } from '../fixtures/candidate-retrieval-fixture.mjs';
import { sha256File } from '../../scripts/coverage-integrity.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-inputs-')); roots.push(dir);
  const assets = { packagePath: path.join(dir, 'package.tgz'), bundlePath: path.join(dir, 'bundle.zip') };
  fs.writeFileSync(assets.packagePath, 'sealed npm'); fs.writeFileSync(assets.bundlePath, 'sealed bundle');
  const f = candidateRetrievalFixture({ packageSha256: sha256File(assets.packagePath), archiveSha256: sha256File(assets.bundlePath) });
  const planFile = path.join(dir, 'plan.json'), coverageFile = path.join(dir, 'coverage.json');
  fs.writeFileSync(planFile, JSON.stringify(f.plan)); fs.writeFileSync(coverageFile, f.coverageBytes);
  const manifest = { candidateSha: f.sourceSha, version: '9.9.9', tag: 'v9.9.9', members: [
    { role: 'npm', sha256: f.artifactSha256, size: fs.statSync(assets.packagePath).size },
    { role: 'bundle', sha256: f.candidateArchiveSha256, size: fs.statSync(assets.bundlePath).size },
  ] };
  return { manifest, planFile, coverageFile, assets };
}
it('binds coverage and sealed plan to both candidate artifacts', () => {
  const f = fixture(); const retrieval = readCandidateRetrieval(f);
  expect(verifyCandidateRetrievalAssets({ retrieval, assets: f.assets })).toBe(true);
});
it.each(['missing-plan', 'source', 'package', 'bundle', 'coverage', 'coverage-bytes'])('rejects %s before host execution', (mutant) => {
  const f = fixture();
  if (mutant === 'missing-plan') delete f.planFile;
  if (mutant === 'source') f.manifest.candidateSha = 'e'.repeat(40);
  if (mutant === 'package') f.manifest.members[0].sha256 = 'e'.repeat(64);
  if (mutant === 'bundle') f.manifest.members[1].sha256 = 'e'.repeat(64);
  if (mutant === 'coverage') fs.writeFileSync(f.coverageFile, '{}');
  if (mutant === 'coverage-bytes') fs.appendFileSync(f.coverageFile, '\n');
  expect(() => readCandidateRetrieval(f)).toThrow();
});
it.each(['packagePath', 'bundlePath'])('detects %s mutations after measurement', (key) => {
  const f = fixture(); const retrieval = readCandidateRetrieval(f);
  fs.appendFileSync(f.assets[key], 'mutation');
  expect(() => verifyCandidateRetrievalAssets({ retrieval, assets: f.assets })).toThrow(/candidate artifact/);
});
