#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagedHostVerifier, readCandidateRetrieval, verifyCandidateRetrievalAssets } from './staged-host-verifier.mjs';
import { payloadIdFor } from './release-payload.mjs';
import { validateRetrievalCanaryReceipt } from './retrieval-canary.mjs';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

export async function buildCandidateHostEvidence({ manifestFile, packagePath, bundlePath, planFile, coverageFile, failureFile },
  { createVerifier = stagedHostVerifier } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const payloadId = payloadIdFor(manifest);
  const identity = { version: manifest.version, candidateSha: manifest.candidateSha, payloadId };
  const retrieval = readCandidateRetrieval({ manifest, planFile, coverageFile });
  verifyCandidateRetrievalAssets({ retrieval, assets: { packagePath, bundlePath } });
  const result = await createVerifier({ assets: { packagePath, bundlePath }, identity, retrieval })
    .verify({ source: 'candidate', assets: { packagePath, bundlePath } });
  verifyCandidateRetrievalAssets({ retrieval, assets: { packagePath, bundlePath } });
  if (result.verdict !== 'PASS') {
    if (failureFile) fs.writeFileSync(path.resolve(failureFile), JSON.stringify({
      schemaVersion: 1, kind: 'ruvnet-brain-candidate-host-failure', verdict: 'FAIL',
      sha: manifest.candidateSha, payloadId, artifactSha256: retrieval.artifactSha256,
      candidateArchiveSha256: retrieval.candidateArchiveSha256, planSha256: retrieval.plan.planSha256,
      result,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    throw new Error(`candidate host matrix failed: ${result.error || 'unknown'}`);
  }

  const modeNames = { claude: 'claude-only', codex: 'codex-only', dual: 'dual-host' };
  const leaves = Object.entries(modeNames).map(([mode, name]) => {
    const fixture = result.fixtures?.[mode];
    const grounding = fixture?.grounding;
    const grounded = grounding && ['repo', 'path', 'file', 'storedPath']
      .every((field) => typeof grounding[field] === 'string' && grounding[field].trim());
    if (fixture?.status !== 'PASS' || fixture?.process?.status !== 0 || !grounded) {
      throw new Error(`${name} did not produce a clean installed-search grounding receipt`);
    }
    validateRetrievalCanaryReceipt(fixture.retrieval, { plan: retrieval.plan });
    return {
      name,
      sha: manifest.candidateSha,
      payloadId,
      status: fixture.status === 'PASS' ? 'completed' : 'failed',
      conclusion: 'success',
      verdict: 'PASS',
      source: 'candidate-host-evidence',
      mode,
      functionalSearch: true,
      searchExit: fixture.process.status,
      grounding,
      retrieval: fixture.retrieval,
      artifactSha256: retrieval.artifactSha256,
    };
  });
  return {
    schemaVersion: 1,
    sha: manifest.candidateSha,
    payloadId,
    artifactSha256: retrieval.artifactSha256,
    leaves,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await buildCandidateHostEvidence({ manifestFile: arg('--manifest'),
    packagePath: arg('--package'), bundlePath: arg('--bundle'), planFile: arg('--plan'), coverageFile: arg('--coverage'), failureFile: arg('--out') ? `${arg('--out')}.failure.json` : null });
  fs.writeFileSync(path.resolve(arg('--out')), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ verdict: 'PASS', payloadId: evidence.payloadId, leaves: evidence.leaves.map(({ name }) => name) }));
}
