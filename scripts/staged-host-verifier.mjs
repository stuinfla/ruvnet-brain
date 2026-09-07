import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHostMatrixAsync } from './host-install-matrix.mjs';
import { validatePlanAgainstCoverage } from './retrieval-canary.mjs';
import { extractZip } from '../kb/zip-extract.mjs';
import { tarExtractionInvocation } from './publication-receipt.mjs';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function readCandidateRetrieval({ manifest, planFile, coverageFile }) {
  if (!planFile || !coverageFile) throw new Error('candidate retrieval requires sealed plan and coverage files');
  const plan = JSON.parse(fs.readFileSync(planFile));
  const coverageBytes = fs.readFileSync(coverageFile);
  const coverage = JSON.parse(coverageBytes);
  // An observed baseline defines the delta only; it never supplies candidate PASS evidence.
  validatePlanAgainstCoverage(plan, coverage, { allowObservedBaseline: true });
  const npm = manifest.members?.filter(({ role }) => role === 'npm') || [];
  const bundle = manifest.members?.filter(({ role }) => role === 'bundle') || [];
  const coverageSha256 = crypto.createHash('sha256').update(coverageBytes).digest('hex');
  if (npm.length !== 1 || bundle.length !== 1
    || plan.candidate.sourceSha !== manifest.candidateSha
    || plan.candidate.packageSha256 !== npm[0].sha256 || plan.candidate.archiveSha256 !== bundle[0].sha256
    || plan.coverage.sha256 !== coverageSha256 || plan.candidate.coverageSha256 !== coverageSha256
    || plan.coverage.bytes !== coverageBytes.length
    || coverage.releaseIdentity?.sourceSnapshot !== manifest.candidateSha
    || coverage.releaseIdentity?.version !== manifest.version || coverage.releaseIdentity?.tag !== manifest.tag
    || plan.candidate.publicLedgerSha256 !== coverage.generationLedger?.sha256
    || plan.candidate.publicLedgerBytes !== coverage.generationLedger?.bytes
    || plan.candidate.publicStoreCount !== coverage.generationLedger?.storeCount
    || plan.candidate.publicInventoryPartitionSha256 !== coverage.publicInventoryPartitionSha256) {
    throw new Error('candidate retrieval plan, coverage or artifact identity mismatch');
  }
  return { plan, sourceSha: manifest.candidateSha, artifactSha256: npm[0].sha256,
    candidateArchiveSha256: bundle[0].sha256, packageBytes: npm[0].size, bundleBytes: bundle[0].size };
}

export function verifyCandidateRetrievalAssets({ retrieval, assets }) {
  for (const [file, digest, bytes] of [[assets.packagePath, retrieval.artifactSha256, retrieval.packageBytes],
    [assets.bundlePath, retrieval.candidateArchiveSha256, retrieval.bundleBytes]]) {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || fs.statSync(file).size !== bytes || sha256(file) !== digest) {
      throw new Error(`candidate artifact does not match sealed retrieval input: ${file}`);
    }
  }
  return true;
}
const locate = (name) => {
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { return null; }
};

const run = (name, args, options) => {
  const result = spawnSync(name, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message);
    throw new Error(`${path.basename(name)} ${args.join(' ')} failed: ${detail.slice(-5000)}`);
  }
  return result;
};

// The doctor verdict has ONE rule, in host-install-matrix.mjs. This name is kept because
// tests/unit/staged-host-verifier.test.mjs pins it, but it is now an alias, not a second copy.
export { classifyDoctor as classifyDoctorResult } from './host-install-matrix.mjs';

const preparePackage = async ({ packagePath, bundlePath }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-staged-host-'));
  try {
    const extraction = tarExtractionInvocation(packagePath, temp);
    run('tar', extraction.args, { cwd: extraction.cwd });
    const packageRoot = path.join(temp, 'package');
    const bundleRoot = path.join(packageRoot, 'dist', 'ruvnet-brain');
    fs.mkdirSync(bundleRoot, { recursive: true });
    await extractZip(bundlePath, bundleRoot);
    const nested = path.join(bundleRoot, 'ruvnet-brain');
    if (fs.existsSync(nested)) {
      for (const name of fs.readdirSync(nested)) fs.renameSync(path.join(nested, name), path.join(bundleRoot, name));
      fs.rmdirSync(nested);
    }
    return { temp, packageRoot };
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
};

export function stagedHostVerifier({ assets, identity, retrieval }, { runMatrix = runHostMatrixAsync } = {}) {
  return {
    async verify({ source, assets: observedAssets = assets }) {
      if (retrieval) verifyCandidateRetrievalAssets({ retrieval, assets: observedAssets });
      const prepared = await preparePackage(observedAssets);
      try {
        // The loop, the mode names, the env and the doctor verdict all live in
        // scripts/host-install-matrix.mjs, shared with the published-side check in
        // publication-receipt.mjs. This file used to carry its own copy, which had drifted to
        // different mode names (claude/codex/dual vs claudeOnly/codexOnly/dual) and a different
        // install shape than the one that runs after publication — so the two halves of a release
        // were judging different things and could not be compared. Only the STAGED-vs-PUBLISHED
        // difference is real, and it is now a named variant rather than a second implementation.
        const matrix = await runMatrix({
          packageRoot: prepared.packageRoot,
          version: identity.version,
          variant: 'staged',
          locate,
          temp: prepared.temp,
          retrieval,
        });
        if (retrieval) verifyCandidateRetrievalAssets({ retrieval, assets: observedAssets });
        if (matrix.verdict !== 'PASS') {
          return { verdict: 'FAIL', source, error: matrix.error, fixtures: matrix.fixtures };
        }
        return {
          verdict: 'PASS',
          source,
          artifactSha256: sha256(observedAssets.packagePath),
          fixtures: matrix.fixtures,
        };
      } catch (error) {
        return { verdict: 'FAIL', source, error: error.message, fixtures: {} };
      } finally {
        fs.rmSync(prepared.temp, { recursive: true, force: true });
      }
    },
  };
}
