#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndependentReviewReceipt } from './independent-review-receipt.mjs';
import { runSubscriptionHost, validateStageValue } from './dual-host-deliberation.mjs';
import { probeSubscriptionHosts } from './subscription-hosts.mjs';
import { nativeReviewEvidenceDigest, writeNativeEvidenceSidecar } from './native-review-evidence.mjs';

const REVIEWERS = Object.freeze({
  'claude-fable-5-1': { keyEnv: 'RUVNET_FABLE_REVIEW_SIGNING_KEY', host: 'claude-code', provider: 'firstParty' },
  'gpt-6-astra': { keyEnv: 'RUVNET_ASTRA_REVIEW_SIGNING_KEY', host: 'codex', provider: 'openai' },
});
const arg = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

export function produceNativeMachineGrade({ input, reviewer, signingKey } = {}) {
  const policy = REVIEWERS[reviewer];
  if (!policy) throw new Error('reviewer is not an adopted native identity');
  if (!signingKey) throw new Error(`${policy.keyEnv} is required`);
  if (input?.id !== reviewer || input.model !== reviewer || input.provider !== policy.provider) {
    throw new Error('native reviewer identity/provider differs from policy');
  }
  if (input.execution?.nativeHost !== policy.host || input.execution?.subscriptionAuthenticated !== true
    || typeof input.execution?.invocationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.execution.invocationDigest)) {
    throw new Error('native subscription execution provenance is incomplete');
  }
  const receipt = createIndependentReviewReceipt(input, signingKey);
  return receipt;
}

export async function produceFromNativeHost({ input, reviewer, signingKey, cwd = process.cwd(), runHost = runSubscriptionHost, onEvidence = null } = {}) {
  const policy = REVIEWERS[reviewer];
  if (!policy) throw new Error('reviewer is not an adopted native identity');
  if (input.artifactPath) {
    const artifact = path.resolve(cwd, input.artifactPath);
    const stat = fs.lstatSync(artifact);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('review artifact must be a regular non-symlink file');
    const artifactSha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    if (artifactSha !== input.artifactSha256) throw new Error('review artifact bytes differ from requested subject');
  }
  const result = await runHost(policy.host, 'review', { releaseIdentity: input.releaseIdentity,
    sourceSha: input.sourceSha, artifactSha256: input.artifactSha256, payloadId: input.payloadId,
    sourceTree: input.sourceTree, productContractSha256: input.productContractSha256,
    rubricSha256: input.rubricSha256, oracle: input.retrievalOracleReview,
    artifactPath: input.artifactPath }, { cwd });
  if (!result?.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
    throw new Error('native reviewer did not return a structured machine-grade judgment');
  }
  if (!result.extra?.evidence || typeof result.extra.canonicalDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(result.extra.canonicalDigest)
    || nativeReviewEvidenceDigest(result.extra.evidence) !== result.extra.canonicalDigest) {
    throw new Error('native reviewer transport evidence is missing or tampered');
  }
  try { validateStageValue('review', result.value); } catch (error) { throw new Error(`native reviewer judgment is invalid: ${error.message}`); }
  if (result.value.artifactSha256 !== input.artifactSha256 || !result.value.execution
    || result.value.execution.nativeHost !== policy.host || result.value.execution.subscriptionAuthenticated !== true
    || result.value.execution.requestedModel !== reviewer || result.value.execution.modelIdentityClass !== 'requested-only'
    || (policy.host === 'codex' ? (!result.value.execution.threadId || result.value.execution.sessionId !== null)
      : (!result.value.execution.sessionId || result.value.execution.threadId !== null))
    || result.value.execution.invocationDigest !== result.extra.canonicalDigest) {
    throw new Error('native reviewer judgment is not bound to the requested review artifact');
  }
  const evidence = result.extra.evidence;
  if (evidence.nativeHost !== policy.host || evidence.requestedModel !== reviewer
    || evidence.modelIdentityClass !== result.value.execution.modelIdentityClass
    || evidence.threadId !== (result.value.execution.threadId ?? null)
    || evidence.sessionId !== (result.value.execution.sessionId ?? null)) {
    throw new Error('native reviewer transport identity differs from execution provenance');
  }
  const judgmentKeys = ['deductions', 'findings', 'retrievalOracleReview', 'score', 'untested', 'verdict', 'reviewedAt'];
  const judgment = { ...input, ...Object.fromEntries(judgmentKeys
    .filter((key) => Object.hasOwn(result.value, key)).map((key) => [key, result.value[key]])),
    id: reviewer, model: reviewer, provider: policy.provider,
    execution: { ...result.value.execution, invocationDigest: result.extra.canonicalDigest } };
  delete judgment.artifactPath;
  const receipt = produceNativeMachineGrade({ input: judgment, reviewer, signingKey });
  if (typeof onEvidence === 'function') onEvidence(result.extra.evidence);
  return receipt;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  try {
    const inputFile = arg(args, '--input'); const outFile = arg(args, '--out'); const reviewer = arg(args, '--reviewer');
    if (!inputFile || !outFile || !reviewer) throw new Error('usage: --input <json> --out <json> --reviewer <identity>');
    const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
    if (!input.artifactPath || !input.sourceTree) throw new Error('review artifact path and source tree are required');
    const cwd = arg(args, '--cwd') || process.cwd();
    const actualSource = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (actualSource !== input.sourceSha) throw new Error('review source commit differs from requested subject');
    const actualTree = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    if (actualTree !== input.sourceTree) throw new Error('review source tree differs from requested subject');
    if (execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
      throw new Error('review source tree is dirty');
    }
    const policy = REVIEWERS[reviewer];
    if (!policy) throw new Error('reviewer is not an adopted native identity');
    const probe = probeSubscriptionHosts()[policy.host === 'claude-code' ? 'claude' : 'codex'];
    if (!probe?.eligible) throw new Error(`${policy.host} subscription authentication is not verified`);
    let evidence;
    const receipt = await produceFromNativeHost({ input, reviewer, signingKey: env[policy.keyEnv], cwd,
      onEvidence: (value) => { evidence = value; } });
    const evidenceFile = `${path.resolve(outFile)}.native-evidence.json`;
    if (fs.existsSync(path.resolve(outFile))) throw new Error('review receipt already exists');
    writeNativeEvidenceSidecar(evidenceFile, evidence);
    try {
      fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      try { fs.rmSync(evidenceFile, { force: true }); } catch { /* preserve original failure */ }
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ verdict: receipt.verdict, reviewer, receiptSha256: receipt.receiptSha256 })}\n`);
    return 0;
  } catch (error) { process.stderr.write(`native-machine-grading-producer: ${error.message}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
