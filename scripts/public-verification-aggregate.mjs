#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest } from './coverage-integrity.mjs';
import { retrievalOracleExpectationFromPlan, validateRetrievalOracleReview } from './independent-review-receipt.mjs';
import { validateRetrievalCanaryPlan, validateRetrievalCanaryReceipt } from './retrieval-canary.mjs';

export const PUBLIC_VERIFICATION_OS = Object.freeze(['linux', 'macos', 'windows']);
export const PUBLIC_VERIFICATION_MODES = Object.freeze(['claude', 'codex', 'dual']);
export const REQUIRED_REVIEW_MODELS = Object.freeze(['claude-fable-5', 'gpt-5.6-sol']);

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function unsignedLeaf(leaf) {
  const { leafSha256: _leafSha256, ...payload } = leaf;
  return payload;
}

export function validatePublicVerificationLeaf(leaf) {
  if (leaf?.schemaVersion !== 1 || leaf?.kind !== 'ruvnet-brain-public-verification-leaf'
    || !PUBLIC_VERIFICATION_OS.includes(leaf.os) || !PUBLIC_VERIFICATION_MODES.includes(leaf.mode)
    || !HEX40.test(String(leaf.sourceSha || '')) || !HEX64.test(String(leaf.artifactSha256 || ''))
    || !HEX64.test(String(leaf.bundleSha256 || '')) || !HEX64.test(String(leaf.payloadId || ''))
    || !HEX64.test(String(leaf.hostRegistryDigest || '')) || !HEX64.test(String(leaf.coverageGeneration || ''))
    || !HEX64.test(String(leaf.canaryPlanSha256 || '')) || !HEX64.test(String(leaf.releaseTransactionId || ''))
    || leaf.tag !== `v${leaf.version}` || leaf.status !== 'completed' || leaf.verdict !== 'PASS') {
    throw new Error('public verification leaf identity or verdict is invalid');
  }
  if (digest(unsignedLeaf(leaf)) !== leaf.leafSha256) throw new Error('public verification leaf digest mismatch');
  if (leaf.publicBytes?.npmExact !== true || leaf.publicBytes?.githubExact !== true
    || leaf.publicBytes?.bundleExact !== true || leaf.installed?.version !== leaf.version
    || leaf.installed?.loaderVerified !== true) throw new Error(`${leaf.os}/${leaf.mode} public bytes or loader are unverified`);
  if (leaf.coverage?.verified !== true || leaf.coverage.eligibleCurrent !== leaf.coverage.eligibleTotal
    || leaf.coverage.gistCurrent !== leaf.coverage.gistTotal) throw new Error(`${leaf.os}/${leaf.mode} coverage is incomplete`);
  if (!Array.isArray(leaf.untested) || leaf.untested.length || leaf.skipped !== 0 || leaf.unknown !== 0) {
    throw new Error(`${leaf.os}/${leaf.mode} has untested, skipped, or unknown evidence`);
  }
  const retrievalPlan = validateRetrievalCanaryPlan(leaf.retrievalPlan);
  if (retrievalPlan.planSha256 !== leaf.canaryPlanSha256
    || retrievalPlan.candidate.archiveSha256 !== leaf.bundleSha256) {
    throw new Error(`${leaf.os}/${leaf.mode} retrieval plan identity differs`);
  }
  const retrieval = validateRetrievalCanaryReceipt(leaf.retrieval, { plan: retrievalPlan });
  if (retrieval.sourceSha !== leaf.sourceSha || retrieval.artifactSha256 !== leaf.artifactSha256
    || retrieval.candidateArchiveSha256 !== leaf.bundleSha256
    || retrieval.coverageGeneration !== leaf.coverageGeneration || retrieval.planSha256 !== leaf.canaryPlanSha256) {
    throw new Error(`${leaf.os}/${leaf.mode} retrieval identity differs`);
  }
  return leaf;
}

export function createPublicVerificationLeaf(input) {
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-public-verification-leaf', ...input };
  return validatePublicVerificationLeaf({ ...payload, leafSha256: digest(payload) });
}

function aggregatePayload(aggregate) {
  const { aggregateSha256: _aggregateSha256, signature: _signature, ...payload } = aggregate;
  return payload;
}

function reviewPayload(review) {
  const { receiptSha256: _receiptSha256, ...payload } = review;
  return payload;
}

export function validateIndependentReviewReceipt(review) {
  if (review?.schemaVersion !== 2 || review?.kind !== 'ruvnet-brain-independent-review'
    || !REQUIRED_REVIEW_MODELS.includes(review.model) || review.id !== review.model
    || review.independent !== true || review.verdict !== 'PASS' || !Number.isInteger(review.score) || review.score < 95
    || !HEX40.test(String(review.sourceSha || '')) || !HEX64.test(String(review.artifactSha256 || ''))
    || !HEX64.test(String(review.payloadId || '')) || !HEX64.test(String(review.productContractSha256 || ''))
    || !HEX64.test(String(review.rubricSha256 || '')) || !Array.isArray(review.deductions)
    || !Array.isArray(review.untested) || review.untested.length || !review.execution?.subscriptionAuthenticated
    || typeof review.execution?.invocationDigest !== 'string' || !HEX64.test(review.execution.invocationDigest)) {
    throw new Error('independent review receipt is malformed, below 95, or incomplete');
  }
  if (review.model === 'claude-fable-5' && review.provider !== 'firstParty') {
    throw new Error('Fable 5 review did not use the verified first-party subscription path');
  }
  if (review.model === 'gpt-5.6-sol' && (review.provider !== 'openai' || typeof review.execution.threadId !== 'string'
    || !review.execution.threadId || !HEX64.test(String(review.execution.catalogRowSha256 || '')))) {
    throw new Error('GPT-5.6-Sol review lacks live catalog and thread evidence');
  }
  const semantic = validateRetrievalOracleReview(review.retrievalOracleReview, { requireAcceptance: true });
  if (canonicalJson(semantic) !== canonicalJson(review.retrievalOracleReview)) {
    throw new Error('retrieval oracle semantic review is not canonical');
  }
  if (digest(reviewPayload(review)) !== review.receiptSha256) throw new Error('independent review receipt digest mismatch');
  return review;
}

export function createIndependentReviewReceipt(input) {
  const semantic = validateRetrievalOracleReview(input?.retrievalOracleReview, { requireAcceptance: true });
  const payload = { schemaVersion: 2, kind: 'ruvnet-brain-independent-review', ...input,
    retrievalOracleReview: semantic };
  return validateIndependentReviewReceipt({ ...payload, receiptSha256: digest(payload) });
}

function validateReviewOracleAgainstPlan(review, retrievalPlan) {
  const expected = retrievalOracleExpectationFromPlan(retrievalPlan);
  const semantic = validateRetrievalOracleReview(review.retrievalOracleReview, { requireAcceptance: true });
  const stores = semantic.records.map(({ store }) => store);
  if (semantic.oracleReceiptSha256 !== expected.oracleReceiptSha256
    || semantic.queryStoreSetSha256 !== expected.queryStoreSetSha256
    || canonicalJson(stores) !== canonicalJson(expected.stores)) {
    throw new Error(`${review.model} semantic review does not cover the complete oracle store set or exact oracle identity`);
  }
  const oracleQueries = retrievalPlan.oracle?.evidence?.queries;
  if (!oracleQueries || typeof oracleQueries !== 'object' || Array.isArray(oracleQueries)
    || canonicalJson(Object.keys(oracleQueries).sort()) !== canonicalJson(expected.stores)) {
    throw new Error('retrieval plan lacks complete sealed oracle query evidence');
  }
  if (semantic.records.some((row) => oracleQueries[row.store]?.recordSha256 !== row.oracleRecordSha256)) {
    throw new Error(`${review.model} semantic review record differs from the retrieval plan`);
  }
  return semantic;
}

const identityOf = (leaf) => ({
  sourceSha: leaf.sourceSha,
  version: leaf.version,
  tag: leaf.tag,
  artifactSha256: leaf.artifactSha256,
  bundleSha256: leaf.bundleSha256,
  payloadId: leaf.payloadId,
  hostRegistryDigest: leaf.hostRegistryDigest,
  coverageGeneration: leaf.coverageGeneration,
  canaryPlanSha256: leaf.canaryPlanSha256,
  releaseTransactionId: leaf.releaseTransactionId,
});

export function buildPublicVerificationAggregate(leaves) {
  if (!Array.isArray(leaves) || leaves.length !== PUBLIC_VERIFICATION_OS.length * PUBLIC_VERIFICATION_MODES.length) {
    throw new Error('public verification requires exactly nine leaves');
  }
  leaves.forEach(validatePublicVerificationLeaf);
  const byLane = new Map(leaves.map((leaf) => [`${leaf.os}/${leaf.mode}`, leaf]));
  const required = PUBLIC_VERIFICATION_OS.flatMap((os) => PUBLIC_VERIFICATION_MODES.map((mode) => `${os}/${mode}`));
  if (byLane.size !== required.length || required.some((lane) => !byLane.has(lane))) {
    throw new Error('public verification lanes are missing or duplicated');
  }
  const first = byLane.get(required[0]);
  const identity = identityOf(first);
  for (const lane of required) {
    const leaf = byLane.get(lane);
    if (canonicalJson(identityOf(leaf)) !== canonicalJson(identity)) throw new Error(`${lane} public verification identity differs`);
    if (canonicalJson(leaf.coverage) !== canonicalJson(first.coverage)) throw new Error(`${lane} coverage projection differs`);
  }
  const retrievalCases = leaves.flatMap((leaf) => leaf.retrieval.cases);
  const delta = retrievalCases.filter(({ cohort }) => cohort === 'delta');
  const metrics = {
    leaves: leaves.length,
    retrievalCases: retrievalCases.length,
    retrievalHits: retrievalCases.filter(({ retrievalHit }) => retrievalHit === true).length,
    deltaCases: delta.length,
    deltaHits: delta.filter(({ retrievalHit }) => retrievalHit === true).length,
    recallAt10: retrievalCases.filter(({ retrievalHit }) => retrievalHit === true).length / retrievalCases.length,
    // A release with no corpus delta has no delta citations to score; the sealed
    // retrieval plan carries noDelta=true and still requires the legacy cohort.
    deltaCitationRate: delta.length === 0 ? 1 : delta.filter(({ retrievalHit, citationResolved }) => retrievalHit === true && citationResolved === true).length / delta.length,
    skipped: leaves.reduce((sum, leaf) => sum + leaf.skipped + leaf.retrieval.metrics.skipped, 0),
    unknown: leaves.reduce((sum, leaf) => sum + leaf.unknown + leaf.retrieval.metrics.unknown, 0),
  };
  if (metrics.recallAt10 < 0.98 || metrics.deltaCitationRate !== 1 || metrics.skipped || metrics.unknown) {
    throw new Error('public verification aggregate retrieval acceptance failed');
  }
  const oracle = first.retrievalPlan.oracle;
  if (!oracle || !HEX64.test(String(oracle.receiptSha256 || ''))
    || !HEX64.test(String(oracle.queryStoreSetSha256 || ''))
    || oracle.queryStoreSetSha256 !== digest(first.retrievalPlan.denominator.eligibleStores)) {
    throw new Error('sealed retrieval oracle identity is incomplete');
  }
  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-public-verification-aggregate',
    identity,
    coverage: first.coverage,
    lanes: required.map((lane) => ({ lane, leafSha256: byLane.get(lane).leafSha256 })),
    evidence: { leaves: required.map((lane) => structuredClone(byLane.get(lane))) },
    retrievalOracle: {
      oracleReceiptSha256: oracle.receiptSha256,
      queryStoreSetSha256: oracle.queryStoreSetSha256,
      recordCount: first.retrievalPlan.denominator.eligibleStores.length,
    },
    metrics,
    verdict: 'PASS',
    untested: [],
  };
}

export function signPublicVerificationAggregate({ leaves }, privateKey) {
  const payload = buildPublicVerificationAggregate(leaves);
  const aggregateSha256 = digest(payload);
  const signed = { ...payload, aggregateSha256 };
  return { ...signed, signature: crypto.sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString('base64') };
}

export function verifyPublicVerificationAggregate(aggregate, publicKey, expectedIdentity = null) {
  if (aggregate?.schemaVersion !== 1 || aggregate?.kind !== 'ruvnet-brain-public-verification-aggregate'
    || aggregate.verdict !== 'PASS' || !Array.isArray(aggregate.untested) || aggregate.untested.length
    || !HEX64.test(String(aggregate.aggregateSha256 || '')) || typeof aggregate.signature !== 'string') {
    throw new Error('public verification aggregate is malformed');
  }
  const payload = aggregatePayload(aggregate);
  if (digest(payload) !== aggregate.aggregateSha256) throw new Error('public verification aggregate digest mismatch');
  if (!Array.isArray(aggregate.evidence?.leaves)) {
    throw new Error('public verification aggregate lacks raw leaf evidence');
  }
  const rebuilt = buildPublicVerificationAggregate(aggregate.evidence.leaves);
  if (canonicalJson(rebuilt) !== canonicalJson(payload)) {
    throw new Error('public verification aggregate differs from rebuilt raw evidence');
  }
  const signed = { ...payload, aggregateSha256: aggregate.aggregateSha256 };
  if (!crypto.verify(null, Buffer.from(canonicalJson(signed)), publicKey, Buffer.from(aggregate.signature, 'base64'))) {
    throw new Error('public verification aggregate signature mismatch');
  }
  const required = PUBLIC_VERIFICATION_OS.flatMap((os) => PUBLIC_VERIFICATION_MODES.map((mode) => `${os}/${mode}`));
  if (aggregate.lanes?.length !== required.length || new Set(aggregate.lanes.map(({ lane }) => lane)).size !== required.length
    || required.some((lane) => !aggregate.lanes.some((row) => row.lane === lane && HEX64.test(String(row.leafSha256 || ''))))) {
    throw new Error('public verification aggregate lanes are incomplete');
  }
  if (aggregate.metrics?.leaves !== 9 || aggregate.metrics?.recallAt10 < 0.98
    || aggregate.metrics?.deltaCitationRate !== 1 || aggregate.metrics?.skipped !== 0 || aggregate.metrics?.unknown !== 0
    || aggregate.coverage?.verified !== true || aggregate.coverage.eligibleCurrent !== aggregate.coverage.eligibleTotal
    || aggregate.coverage.gistCurrent !== aggregate.coverage.gistTotal) {
    throw new Error('public verification aggregate evidence is incomplete');
  }
  if (aggregate.retrievalOracle?.oracleReceiptSha256 !== aggregate.evidence.leaves[0].retrievalPlan.oracle.receiptSha256
    || aggregate.retrievalOracle?.queryStoreSetSha256 !== aggregate.evidence.leaves[0].retrievalPlan.oracle.queryStoreSetSha256
    || aggregate.retrievalOracle?.recordCount !== aggregate.evidence.leaves[0].retrievalPlan.denominator.eligibleStores.length) {
    throw new Error('public verification aggregate retrieval oracle identity is incomplete');
  }
  if (expectedIdentity && canonicalJson(aggregate.identity) !== canonicalJson(expectedIdentity)) {
    throw new Error('public verification aggregate identity differs from the release transaction');
  }
  return aggregate;
}

function parseCliArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--lanes', '--out'].includes(flag) || !value) {
      throw new Error('usage: public-verification-aggregate.mjs --lanes <dir> --out <file>');
    }
    parsed[flag.slice(2)] = value;
  }
  if (!parsed.lanes || !parsed.out || Object.keys(parsed).length !== 2) {
    throw new Error('usage: public-verification-aggregate.mjs --lanes <dir> --out <file>');
  }
  return parsed;
}

function readExactJsonFiles(directory, count, label) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== count || entries.some((entry) => !entry.isFile() || !entry.name.endsWith('.json'))) {
    throw new Error(`${label} directory must contain exactly ${count} JSON files`);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
}

function readLaneLeaves(directory) {
  const wrappers = readExactJsonFiles(directory, PUBLIC_VERIFICATION_OS.length, 'lane');
  const byOs = new Map();
  for (const wrapper of wrappers) {
    const payload = { schemaVersion: wrapper?.schemaVersion, kind: wrapper?.kind, os: wrapper?.os,
      leaves: wrapper?.leaves };
    if (payload.schemaVersion !== 1 || payload.kind !== 'ruvnet-brain-public-verification-os-lane'
      || !PUBLIC_VERIFICATION_OS.includes(payload.os) || byOs.has(payload.os)
      || !Array.isArray(payload.leaves) || payload.leaves.length !== PUBLIC_VERIFICATION_MODES.length
      || payload.leaves.some((leaf) => leaf?.os !== payload.os)
      || digest(payload) !== wrapper.laneSha256) {
      throw new Error('public verification OS lane wrapper is malformed, duplicated, or tampered');
    }
    payload.leaves.forEach(validatePublicVerificationLeaf);
    byOs.set(payload.os, payload.leaves);
  }
  if (PUBLIC_VERIFICATION_OS.some((osName) => !byOs.has(osName))) {
    throw new Error('public verification OS lane wrapper is missing');
  }
  return PUBLIC_VERIFICATION_OS.flatMap((osName) => byOs.get(osName));
}

export function generatePublicVerificationAggregate({ lanesDirectory, outputFile, privateKey }) {
  if (!privateKey) throw new Error('RUVNET_SIGNING_KEY is required');
  if (fs.existsSync(outputFile)) throw new Error(`refusing to overwrite existing aggregate: ${outputFile}`);
  const leaves = readLaneLeaves(lanesDirectory);
  const aggregate = signPublicVerificationAggregate({ leaves }, privateKey);
  fs.writeFileSync(outputFile, `${JSON.stringify(aggregate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return aggregate;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const aggregate = generatePublicVerificationAggregate({
    lanesDirectory: options.lanes,
    outputFile: options.out,
    privateKey: process.env.RUVNET_SIGNING_KEY,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, aggregateSha256: aggregate.aggregateSha256,
    leaves: aggregate.metrics.leaves })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
