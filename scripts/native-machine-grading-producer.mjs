#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndependentReviewReceipt } from './independent-review-receipt.mjs';
import { runSubscriptionHost } from './dual-host-deliberation.mjs';

const REVIEWERS = Object.freeze({
  'claude-fable-5-1': { keyEnv: 'RUVNET_FABLE_REVIEW_SIGNING_KEY', host: 'claude-code', provider: 'firstParty' },
  'gpt-6-astra': { keyEnv: 'RUVNET_ASTRA_REVIEW_SIGNING_KEY', host: 'codex', provider: 'openai' },
});
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
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
  return { ...receipt, producer: { kind: 'native-subscription-machine-grading', host: policy.host,
    inputSha256: sha256(JSON.stringify(input)), reviewer } };
}

export async function produceFromNativeHost({ input, reviewer, signingKey, cwd = process.cwd(), runHost = runSubscriptionHost } = {}) {
  const policy = REVIEWERS[reviewer];
  if (!policy) throw new Error('reviewer is not an adopted native identity');
  const result = await runHost(policy.host, 'review', { releaseIdentity: input.releaseIdentity,
    sourceSha: input.sourceSha, artifactSha256: input.artifactSha256, payloadId: input.payloadId,
    oracle: input.retrievalOracleReview });
  if (!result?.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
    throw new Error('native reviewer did not return a structured machine-grade judgment');
  }
  const judgment = { ...input, ...result.value,
    id: reviewer, model: reviewer, provider: policy.provider,
    execution: { ...input.execution, nativeHost: policy.host, subscriptionAuthenticated: true } };
  return produceNativeMachineGrade({ input: judgment, reviewer, signingKey });
}

export function main(args = process.argv.slice(2), env = process.env) {
  try {
    const inputFile = arg(args, '--input'); const outFile = arg(args, '--out'); const reviewer = arg(args, '--reviewer');
    if (!inputFile || !outFile || !reviewer) throw new Error('usage: --input <json> --out <json> --reviewer <identity>');
    const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
    const policy = REVIEWERS[reviewer];
    const receipt = produceNativeMachineGrade({ input, reviewer, signingKey: env[policy?.keyEnv] });
    fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ verdict: receipt.verdict, reviewer, receiptSha256: receipt.receiptSha256 })}\n`);
    return 0;
  } catch (error) { process.stderr.write(`native-machine-grading-producer: ${error.message}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
