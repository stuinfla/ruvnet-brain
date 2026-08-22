#!/usr/bin/env node
import crypto from 'node:crypto';
import { canonicalJson, digest } from './coverage-integrity.mjs';
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
  if (review?.schemaVersion !== 1 || review?.kind !== 'ruvnet-brain-independent-review'
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
  if (digest(reviewPayload(review)) !== review.receiptSha256) throw new Error('independent review receipt digest mismatch');
  return review;
}

export function createIndependentReviewReceipt(input) {
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-independent-review', ...input };
  return validateIndependentReviewReceipt({ ...payload, receiptSha256: digest(payload) });
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

export function buildPublicVerificationAggregate(leaves, reviews) {
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
    deltaCitationRate: delta.filter(({ retrievalHit, citationResolved }) => retrievalHit === true && citationResolved === true).length / delta.length,
    skipped: leaves.reduce((sum, leaf) => sum + leaf.skipped + leaf.retrieval.metrics.skipped, 0),
    unknown: leaves.reduce((sum, leaf) => sum + leaf.unknown + leaf.retrieval.metrics.unknown, 0),
  };
  if (metrics.recallAt10 < 0.98 || metrics.deltaCitationRate !== 1 || metrics.skipped || metrics.unknown) {
    throw new Error('public verification aggregate retrieval acceptance failed');
  }
  if (!Array.isArray(reviews) || reviews.length !== REQUIRED_REVIEW_MODELS.length) {
    throw new Error('public verification aggregate requires exactly two independent reviews');
  }
  reviews.forEach(validateIndependentReviewReceipt);
  const byModel = new Map(reviews.map((review) => [review.model, review]));
  if (byModel.size !== REQUIRED_REVIEW_MODELS.length || REQUIRED_REVIEW_MODELS.some((model) => !byModel.has(model))) {
    throw new Error('required independent review models are missing or duplicated');
  }
  const firstReview = byModel.get(REQUIRED_REVIEW_MODELS[0]);
  for (const model of REQUIRED_REVIEW_MODELS) {
    const review = byModel.get(model);
    if (review.sourceSha !== identity.sourceSha || review.artifactSha256 !== identity.artifactSha256
      || review.payloadId !== identity.payloadId || review.productContractSha256 !== firstReview.productContractSha256
      || review.rubricSha256 !== firstReview.rubricSha256) throw new Error(`${model} review identity or rubric differs`);
  }
  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-public-verification-aggregate',
    identity,
    coverage: first.coverage,
    lanes: required.map((lane) => ({ lane, leafSha256: byLane.get(lane).leafSha256 })),
    reviews: REQUIRED_REVIEW_MODELS.map((model) => ({ model, receiptSha256: byModel.get(model).receiptSha256,
      score: byModel.get(model).score })),
    evidence: { leaves: required.map((lane) => structuredClone(byLane.get(lane))),
      reviews: REQUIRED_REVIEW_MODELS.map((model) => structuredClone(byModel.get(model))) },
    productContractSha256: firstReview.productContractSha256,
    rubricSha256: firstReview.rubricSha256,
    metrics,
    verdict: 'PASS',
    untested: [],
  };
}

export function signPublicVerificationAggregate({ leaves, reviews }, privateKey) {
  const payload = buildPublicVerificationAggregate(leaves, reviews);
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
  if (!Array.isArray(aggregate.evidence?.leaves) || !Array.isArray(aggregate.evidence?.reviews)) {
    throw new Error('public verification aggregate lacks raw leaf or review evidence');
  }
  const rebuilt = buildPublicVerificationAggregate(aggregate.evidence.leaves, aggregate.evidence.reviews);
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
  if (aggregate.reviews?.length !== REQUIRED_REVIEW_MODELS.length
    || REQUIRED_REVIEW_MODELS.some((model) => !aggregate.reviews.some((row) => row.model === model
      && Number.isInteger(row.score) && row.score >= 95 && HEX64.test(String(row.receiptSha256 || ''))))
    || !HEX64.test(String(aggregate.productContractSha256 || '')) || !HEX64.test(String(aggregate.rubricSha256 || ''))) {
    throw new Error('public verification aggregate reviews are incomplete');
  }
  if (expectedIdentity && canonicalJson(aggregate.identity) !== canonicalJson(expectedIdentity)) {
    throw new Error('public verification aggregate identity differs from the release transaction');
  }
  return aggregate;
}
