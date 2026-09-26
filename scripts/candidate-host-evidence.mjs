#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagedHostVerifier, readCandidateRetrieval, verifyCandidateRetrievalAssets } from './staged-host-verifier.mjs';
import { payloadIdFor } from './release-payload.mjs';
import { validateRetrievalCanaryReceipt } from './retrieval-canary.mjs';
import { HOST_WARMUP_TIMEOUT_MS, RELEASE_SEARCH_DEADLINE_MS } from './host-install-matrix.mjs';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

export async function buildCandidateHostEvidence({ manifestFile, packagePath, bundlePath, planFile, coverageFile, failureFile },
  { createVerifier = stagedHostVerifier, sequentialSearches = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const payloadId = payloadIdFor(manifest);
  const identity = { version: manifest.version, candidateSha: manifest.candidateSha, payloadId };
  const retrieval = readCandidateRetrieval({ manifest, planFile, coverageFile });
  verifyCandidateRetrievalAssets({ retrieval, assets: { packagePath, bundlePath } });
  const result = await createVerifier({ assets: { packagePath, bundlePath }, identity, retrieval, sequentialSearches })
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
  const leaves = [];
  const failures = [];
  for (const [mode, name] of Object.entries(modeNames)) {
    const fixture = result.fixtures?.[mode];
    const grounding = fixture?.grounding;
    const warmupGrounding = fixture?.warmupGrounding;
    const hasReceipt = (receipt) => receipt && ['repo', 'path', 'file', 'storedPath']
      .every((field) => typeof receipt[field] === 'string' && receipt[field].trim());
    if (!Number.isFinite(fixture?.warmupMs) || fixture.warmupMs < 0 || fixture.warmupMs > HOST_WARMUP_TIMEOUT_MS
      || !hasReceipt(warmupGrounding) || warmupGrounding.repo !== 'ruvnet-brain') {
      failures.push(`${name} did not produce a grounded worker warmup within ${HOST_WARMUP_TIMEOUT_MS}ms (${fixture?.warmupMs ?? 'unmeasured'}ms)`);
    }
    if (!Number.isFinite(fixture?.searchMs) || fixture.searchMs < 0 || fixture.searchMs > RELEASE_SEARCH_DEADLINE_MS) {
      failures.push(`${name} first measured cited search exceeded the ${RELEASE_SEARCH_DEADLINE_MS}ms candidate deadline (${fixture?.searchMs ?? 'unmeasured'}ms)`);
    }
    if (fixture?.status !== 'PASS' || fixture?.process?.status !== 0 || !hasReceipt(grounding)) {
      failures.push(`${name} did not produce a clean installed-search grounding receipt`);
    }
    try { validateRetrievalCanaryReceipt(fixture?.retrieval, { plan: retrieval.plan }); }
    catch (error) { failures.push(`${name} retrieval canary rejected: ${error.message}`); }
    leaves.push({
      name,
      sha: manifest.candidateSha,
      payloadId,
      status: fixture?.status === 'PASS' && fixture?.process?.status === 0 && hasReceipt(grounding) ? 'completed' : 'failed',
      conclusion: failures.length ? 'failure' : 'success',
      verdict: 'PASS',
      source: 'candidate-host-evidence',
      mode,
      functionalSearch: fixture?.status === 'PASS',
      searchExit: fixture?.process?.status ?? null,
      warmupMs: fixture?.warmupMs,
      warmupGrounding,
      searchMs: fixture?.searchMs,
      grounding,
      retrieval: fixture?.retrieval,
      artifactSha256: retrieval.artifactSha256,
    });
  }
  if (failures.length) {
    const failure = {
      schemaVersion: 1, kind: 'ruvnet-brain-candidate-host-failure', verdict: 'FAIL',
      sha: manifest.candidateSha, payloadId, artifactSha256: retrieval.artifactSha256,
      candidateArchiveSha256: retrieval.candidateArchiveSha256, planSha256: retrieval.plan.planSha256,
      failures, result,
    };
    if (failureFile) fs.writeFileSync(path.resolve(failureFile), JSON.stringify(failure, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    throw new Error(`candidate host matrix failed: ${failures.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    sha: manifest.candidateSha,
    hostPlatform: process.platform,
    payloadId,
    artifactSha256: retrieval.artifactSha256,
    leaves,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await buildCandidateHostEvidence({ manifestFile: arg('--manifest'),
    packagePath: arg('--package'), bundlePath: arg('--bundle'), planFile: arg('--plan'), coverageFile: arg('--coverage'), failureFile: arg('--out') ? `${arg('--out')}.failure.json` : null },
  { sequentialSearches: process.argv.includes('--sequential-searches') });
  fs.writeFileSync(path.resolve(arg('--out')), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ verdict: 'PASS', payloadId: evidence.payloadId, leaves: evidence.leaves.map(({ name }) => name) }));
}
