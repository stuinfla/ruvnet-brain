#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest } from './coverage-integrity.mjs';
import { transactionIdFor } from './release-transaction.mjs';
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const ALLOWED_INDEPENDENT_REVIEWERS = Object.freeze([
  Object.freeze({ identity: 'claude-fable-5', model: 'claude-fable-5', provider: 'firstParty' }),
  Object.freeze({ identity: 'gpt-5.6-sol', model: 'gpt-5.6-sol', provider: 'openai' })]);

const INPUT_KEYS = Object.freeze([
  'artifactSha256', 'deductions', 'execution', 'findings', 'id', 'independent', 'model', 'payloadId',
  'payloadSha256', 'productContractSha256', 'provider', 'releaseIdentity', 'reviewedAt', 'rubricSha256',
  'retrievalOracleReview', 'score', 'sourceSha', 'sourceTree', 'subjectProducerIdentity', 'untested', 'verdict',
]);
const CORE_KEYS = Object.freeze([
  ...INPUT_KEYS, 'kind', 'releaseIdentitySha256', 'schemaVersion', 'signatureAlgorithm', 'signingKeyId',
]);
const RECEIPT_KEYS = Object.freeze([...CORE_KEYS, 'receiptSha256', 'signature']);
const RELEASE_KEYS = Object.freeze([
  'bundleDigestSha256', 'bundleSha256', 'bundleSignatureSha256', 'candidateSha', 'corpusSeedSha256',
  'evidenceDigest', 'generationLedgerSha256', 'package', 'packageAssetName', 'packageIntegrity',
  'packageSha256', 'payloadId', 'repository', 'tag', 'transactionId', 'version',
]);
const REQUIRED_RELEASE_KEYS = Object.freeze([
  'bundleSha256', 'candidateSha', 'evidenceDigest', 'package', 'packageIntegrity', 'packageSha256',
  'payloadId', 'repository', 'tag', 'transactionId', 'version',
]);
const FINDING_KEYS = Object.freeze(['code', 'evidence', 'severity', 'summary']);
const DEDUCTION_KEYS = Object.freeze(['code', 'evidence', 'points', 'reason']);
const SEVERITIES = Object.freeze(['info', 'minor', 'major', 'critical']);
const ORACLE_REVIEW_KEYS = Object.freeze(['kind', 'oracleReceiptSha256', 'queryStoreSetSha256', 'recordCount',
  'recordSetSha256', 'records', 'schemaVersion', 'untested', 'verdict']);
const ORACLE_RECORD_KEYS = Object.freeze(['evidence', 'oracleRecordSha256', 'relevant', 'store', 'untested', 'verdict']);
const EXPECTED_ORACLE_KEYS = Object.freeze(['oracleReceiptSha256', 'queryStoreSetSha256', 'records', 'stores']);
const EXPECTED_ORACLE_REQUIRED = Object.freeze(['oracleReceiptSha256', 'queryStoreSetSha256', 'stores']);

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label, required = allowed) {
  plainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown field: ${unknown.sort()[0]}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${label} is missing field: ${missing[0]}`);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`${label} is invalid`); return value;
}
function hex(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`); return value;
}

function sortedUniqueStrings(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw new Error(`${label} must be an array`);
  const sorted = values.map((value, index) => text(value, `${label}[${index}]`)).sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicates`);
  return sorted;
}

function normalizeFindings(findings) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array');
  const rows = findings.map((finding, index) => {
    exactKeys(finding, FINDING_KEYS, `findings[${index}]`);
    if (!SEVERITIES.includes(finding.severity)) throw new Error(`findings[${index}] severity is invalid`);
    return {
      code: text(finding.code, `findings[${index}].code`),
      severity: finding.severity,
      summary: text(finding.summary, `findings[${index}].summary`),
      evidence: sortedUniqueStrings(finding.evidence, `findings[${index}].evidence`, { allowEmpty: false }),
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(rows.map(({ code }) => code)).size !== rows.length) throw new Error('findings contain duplicate codes');
  return rows;
}

function normalizeDeductions(deductions) {
  if (!Array.isArray(deductions)) throw new Error('deductions must be an array');
  const rows = deductions.map((deduction, index) => {
    exactKeys(deduction, DEDUCTION_KEYS, `deductions[${index}]`);
    if (!Number.isInteger(deduction.points) || deduction.points < 1 || deduction.points > 100) {
      throw new Error(`deductions[${index}].points is invalid`);
    }
    return {
      code: text(deduction.code, `deductions[${index}].code`),
      points: deduction.points,
      reason: text(deduction.reason, `deductions[${index}].reason`),
      evidence: sortedUniqueStrings(deduction.evidence, `deductions[${index}].evidence`, { allowEmpty: false }),
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(rows.map(({ code }) => code)).size !== rows.length) throw new Error('deductions contain duplicate codes');
  return rows;
}

export function validateRetrievalOracleReview(review, { requireAcceptance = false } = {}) {
  exactKeys(review, ORACLE_REVIEW_KEYS, 'retrieval oracle semantic review');
  if (review.schemaVersion !== 1 || review.kind !== 'ruvnet-brain-retrieval-oracle-semantic-review') {
    throw new Error('retrieval oracle semantic review schema is invalid');
  }
  hex(review.oracleReceiptSha256, HEX64, 'retrieval oracle receipt SHA-256');
  hex(review.queryStoreSetSha256, HEX64, 'retrieval oracle store-set SHA-256');
  hex(review.recordSetSha256, HEX64, 'retrieval oracle record-set SHA-256');
  if (!Array.isArray(review.records) || !review.records.length) throw new Error('retrieval oracle semantic records are missing');
  const records = review.records.map((record, index) => {
    exactKeys(record, ORACLE_RECORD_KEYS, `retrieval oracle semantic records[${index}]`);
    const store = text(record.store, `retrieval oracle semantic records[${index}].store`);
    if (store !== store.toLowerCase()) throw new Error('retrieval oracle semantic record store is not canonical');
    hex(record.oracleRecordSha256, HEX64, `retrieval oracle semantic records[${index}].oracleRecordSha256`);
    if (typeof record.relevant !== 'boolean' || !['PASS', 'FAIL'].includes(record.verdict)) {
      throw new Error('retrieval oracle semantic record verdict is invalid');
    }
    const evidence = sortedUniqueStrings(record.evidence, `retrieval oracle semantic records[${index}].evidence`,
      { allowEmpty: false });
    const untested = sortedUniqueStrings(record.untested, `retrieval oracle semantic records[${index}].untested`);
    const blocked = record.relevant !== true || untested.length > 0;
    if ((record.verdict === 'PASS') === blocked) throw new Error('retrieval oracle semantic record verdict is not evidence-derived');
    return { store, oracleRecordSha256: record.oracleRecordSha256, relevant: record.relevant,
      verdict: record.verdict, evidence, untested };
  }).sort((left, right) => left.store.localeCompare(right.store));
  if (new Set(records.map(({ store }) => store)).size !== records.length) {
    throw new Error('retrieval oracle semantic records contain duplicate stores');
  }
  if (!Number.isSafeInteger(review.recordCount) || review.recordCount !== records.length) {
    throw new Error('retrieval oracle semantic record count is incomplete');
  }
  const stores = records.map(({ store }) => store);
  const recordSet = records.map(({ store, oracleRecordSha256 }) => ({ store, oracleRecordSha256 }));
  if (review.queryStoreSetSha256 !== digest(stores) || review.recordSetSha256 !== digest(recordSet)) {
    throw new Error('retrieval oracle semantic store or record set digest differs');
  }
  const untested = sortedUniqueStrings(review.untested, 'retrieval oracle semantic untested scope');
  if (!['PASS', 'FAIL'].includes(review.verdict)) throw new Error('retrieval oracle semantic review verdict is invalid');
  const blocked = untested.length > 0 || records.some(({ verdict }) => verdict !== 'PASS');
  if ((review.verdict === 'PASS') === blocked) throw new Error('retrieval oracle semantic review verdict is not evidence-derived');
  if (requireAcceptance && blocked) throw new Error('retrieval oracle semantic review is failed or untested');
  return { schemaVersion: 1, kind: review.kind, oracleReceiptSha256: review.oracleReceiptSha256,
    queryStoreSetSha256: review.queryStoreSetSha256, recordCount: records.length, recordSetSha256: review.recordSetSha256,
    records, verdict: review.verdict, untested };
}

function normalizeExpectedOracle(expected) {
  exactKeys(expected, EXPECTED_ORACLE_KEYS, 'expected retrieval oracle', EXPECTED_ORACLE_REQUIRED);
  hex(expected.oracleReceiptSha256, HEX64, 'expected retrieval oracle receipt SHA-256');
  hex(expected.queryStoreSetSha256, HEX64, 'expected retrieval oracle store-set SHA-256');
  const stores = sortedUniqueStrings(expected.stores, 'expected retrieval oracle stores', { allowEmpty: false });
  if (canonicalJson(stores) !== canonicalJson(expected.stores)
    || digest(stores) !== expected.queryStoreSetSha256) throw new Error('expected retrieval oracle store set is invalid');
  const records = expected.records === undefined ? null : expected.records.map((record, index) => {
    exactKeys(record, ['oracleRecordSha256', 'store'], `expected retrieval oracle records[${index}]`);
    text(record.store, `expected retrieval oracle records[${index}].store`);
    hex(record.oracleRecordSha256, HEX64, `expected retrieval oracle records[${index}].oracleRecordSha256`);
    return { store: record.store, oracleRecordSha256: record.oracleRecordSha256 };
  }).sort((left, right) => left.store.localeCompare(right.store));
  if (records && canonicalJson(records.map(({ store }) => store)) !== canonicalJson(stores)) {
    throw new Error('expected retrieval oracle records differ from its store set');
  }
  return { oracleReceiptSha256: expected.oracleReceiptSha256, queryStoreSetSha256: expected.queryStoreSetSha256,
    stores, ...(records ? { records } : {}) };
}

export function retrievalOracleExpectationFromPlan(plan) {
  if (plan?.schemaVersion !== 2 || plan?.kind !== 'ruvnet-brain-retrieval-canary-plan') {
    throw new Error('retrieval canary plan is invalid for semantic review');
  }
  const stores = plan.denominator?.eligibleStores;
  const queries = plan.oracle?.evidence?.queries;
  if (!queries || typeof queries !== 'object' || Array.isArray(queries)
    || canonicalJson(Object.keys(queries).sort()) !== canonicalJson(stores)) {
    throw new Error('retrieval canary plan lacks complete sealed oracle query evidence');
  }
  return normalizeExpectedOracle({ oracleReceiptSha256: plan.oracle?.receiptSha256,
    queryStoreSetSha256: plan.oracle?.queryStoreSetSha256,
    stores, records: stores.map((store) => ({ store, oracleRecordSha256: queries[store]?.recordSha256 })) });
}

function assertOracleReviewMatches(review, expected) {
  const normalized = validateRetrievalOracleReview(review, { requireAcceptance: true });
  if (normalized.oracleReceiptSha256 !== expected.oracleReceiptSha256
    || normalized.queryStoreSetSha256 !== expected.queryStoreSetSha256
    || canonicalJson(normalized.records.map(({ store }) => store)) !== canonicalJson(expected.stores)) {
    throw new Error('review does not cover the complete oracle store set or exact oracle identity');
  }
  if (expected.records && normalized.recordSetSha256 !== digest(expected.records)) {
    throw new Error('retrieval oracle record identity differs from the sealed oracle');
  }
}

function normalizeReleaseIdentity(identity) {
  exactKeys(identity, RELEASE_KEYS, 'release identity', REQUIRED_RELEASE_KEYS);
  const normalized = Object.fromEntries(RELEASE_KEYS.filter((key) => Object.hasOwn(identity, key))
    .map((key) => [key, identity[key]]));
  text(normalized.repository, 'release repository');
  text(normalized.package, 'release package');
  text(normalized.version, 'release version');
  if (normalized.tag !== `v${normalized.version}`) throw new Error('release tag does not match version');
  hex(normalized.candidateSha, HEX40, 'release candidate SHA');
  for (const key of ['payloadId', 'evidenceDigest', 'packageSha256', 'bundleSha256', 'transactionId',
    'bundleDigestSha256', 'bundleSignatureSha256', 'corpusSeedSha256', 'generationLedgerSha256']) {
    if (normalized[key] !== undefined) hex(normalized[key], HEX64, `release ${key}`);
  }
  text(normalized.packageIntegrity, 'release package integrity');
  if (normalized.packageAssetName !== undefined) text(normalized.packageAssetName, 'release package asset name');
  if (normalized.transactionId !== transactionIdFor(normalized)) throw new Error('release transaction identity differs');
  return normalized;
}

function reviewerFor(input) {
  const reviewer = ALLOWED_INDEPENDENT_REVIEWERS.find(({ identity }) => identity === input.id);
  if (!reviewer || input.model !== reviewer.model || input.provider !== reviewer.provider || input.id !== input.model) {
    throw new Error('reviewer identity, model, and provider are not an allowed exact tuple');
  }
  return reviewer;
}

function normalizeExecution(execution, reviewer) {
  const required = reviewer.identity === 'gpt-5.6-sol'
    ? ['catalogRowSha256', 'invocationDigest', 'subscriptionAuthenticated', 'threadId']
    : ['invocationDigest', 'subscriptionAuthenticated'];
  if (reviewer.identity === 'gpt-5.6-sol'
    && (!Object.hasOwn(execution || {}, 'threadId') || !Object.hasOwn(execution || {}, 'catalogRowSha256'))) {
    throw new Error('GPT review thread and catalog evidence are required');
  }
  exactKeys(execution, required, 'review execution');
  if (execution.subscriptionAuthenticated !== true) throw new Error('review execution is not subscription authenticated');
  hex(execution.invocationDigest, HEX64, 'review invocation digest');
  if (reviewer.identity === 'gpt-5.6-sol') {
    text(execution.threadId, 'GPT review thread');
    hex(execution.catalogRowSha256, HEX64, 'GPT review catalog row');
  }
  return Object.fromEntries(required.map((key) => [key, execution[key]]));
}

function normalizeInput(input) {
  exactKeys(input, INPUT_KEYS, 'independent review input');
  const reviewer = reviewerFor(input);
  const releaseIdentity = normalizeReleaseIdentity(input.releaseIdentity);
  const findings = normalizeFindings(input.findings);
  const deductions = normalizeDeductions(input.deductions);
  const untested = sortedUniqueStrings(input.untested, 'untested scope');
  const retrievalOracleReview = validateRetrievalOracleReview(input.retrievalOracleReview);
  text(input.subjectProducerIdentity, 'subject producer identity');
  if (input.subjectProducerIdentity === input.id) throw new Error('self-review is forbidden');
  hex(input.sourceSha, HEX40, 'source SHA');
  hex(input.sourceTree, HEX40, 'source tree');
  for (const [label, value] of [['artifact SHA-256', input.artifactSha256], ['payload id', input.payloadId],
    ['payload SHA-256', input.payloadSha256], ['product contract SHA-256', input.productContractSha256],
    ['rubric SHA-256', input.rubricSha256]]) hex(value, HEX64, label);
  if (input.sourceSha !== releaseIdentity.candidateSha || input.artifactSha256 !== releaseIdentity.packageSha256
    || input.payloadId !== releaseIdentity.payloadId) throw new Error('reviewed source, artifact, or payload differs from release identity');
  if (input.independent !== true) throw new Error('review must declare independent execution');
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100
    || input.score !== 100 - deductions.reduce((sum, { points }) => sum + points, 0)) {
    throw new Error('review score does not equal 100 minus deductions');
  }
  if (!['PASS', 'FAIL'].includes(input.verdict)) throw new Error('review verdict is invalid');
  const blocked = input.score < 95 || untested.length > 0 || retrievalOracleReview.verdict !== 'PASS'
    || findings.some(({ severity }) => severity === 'critical');
  if (input.verdict === 'PASS' && retrievalOracleReview.verdict !== 'PASS') {
    throw new Error('PASS review has a failed or untested retrieval oracle semantic review');
  }
  if (input.verdict === 'PASS' && blocked) throw new Error('PASS review has a score below 95, critical finding, or untested scope');
  if (input.verdict === 'FAIL' && !blocked) throw new Error('FAIL review has no acceptance blocker');
  if (typeof input.reviewedAt !== 'string' || Number.isNaN(Date.parse(input.reviewedAt))
    || new Date(input.reviewedAt).toISOString() !== input.reviewedAt) throw new Error('review timestamp must be exact UTC ISO-8601');
  return {
    ...input,
    releaseIdentity,
    findings,
    deductions,
    untested,
    retrievalOracleReview,
    execution: normalizeExecution(input.execution, reviewer),
  };
}

function asKey(key, kind) {
  let parsed;
  try {
    parsed = key?.type === kind && key?.asymmetricKeyType ? key
      : kind === 'private' ? crypto.createPrivateKey(key) : crypto.createPublicKey(key);
  }
  catch { throw new Error(`review signing ${kind} key is invalid`); }
  if (parsed.asymmetricKeyType !== 'ed25519') throw new Error(`review signing ${kind} key must be Ed25519`);
  return parsed;
}

function keyId(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function signingPayload(receipt) {
  const { receiptSha256: _receiptSha256, signature: _signature, ...payload } = receipt;
  return payload;
}

function assertNormalizedCore(core) {
  exactKeys(core, CORE_KEYS, 'independent review receipt core');
  if (core.schemaVersion !== 2 || core.kind !== 'ruvnet-brain-independent-review'
    || core.signatureAlgorithm !== 'Ed25519') throw new Error('independent review receipt schema is invalid');
  hex(core.releaseIdentitySha256, HEX64, 'release identity SHA-256');
  hex(core.signingKeyId, HEX64, 'review signing key id');
  const normalized = normalizeInput(Object.fromEntries(INPUT_KEYS.map((key) => [key, core[key]])));
  if (canonicalJson(normalized) !== canonicalJson(Object.fromEntries(INPUT_KEYS.map((key) => [key, core[key]])))) {
    throw new Error('independent review receipt arrays are not canonical');
  }
  if (core.releaseIdentitySha256 !== digest(core.releaseIdentity)) throw new Error('release identity digest mismatch');
}

export function createIndependentReviewReceipt(input, privateKey) {
  const normalized = normalizeInput(input);
  const privateObject = asKey(privateKey, 'private');
  const publicObject = crypto.createPublicKey(privateObject);
  const payload = {
    schemaVersion: 2,
    kind: 'ruvnet-brain-independent-review',
    ...normalized,
    releaseIdentitySha256: digest(normalized.releaseIdentity),
    signatureAlgorithm: 'Ed25519',
    signingKeyId: keyId(publicObject),
  };
  assertNormalizedCore(payload);
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateObject).toString('base64');
  const signed = { ...payload, signature };
  return { ...signed, receiptSha256: digest(signed) };
}

export function verifyIndependentReviewReceipt(receipt, publicKey) {
  exactKeys(receipt, RECEIPT_KEYS, 'independent review receipt');
  const payload = signingPayload(receipt);
  assertNormalizedCore(payload);
  const publicObject = asKey(publicKey, 'public');
  if (receipt.signingKeyId !== keyId(publicObject)) throw new Error('review signing key identity differs');
  if (typeof receipt.signature !== 'string' || !BASE64.test(receipt.signature)
    || Buffer.from(receipt.signature, 'base64').length !== 64) throw new Error('review signature is malformed');
  const signed = { ...payload, signature: receipt.signature };
  if (receipt.receiptSha256 !== digest(signed)) throw new Error('independent review receipt digest mismatch');
  if (!crypto.verify(null, Buffer.from(canonicalJson(payload)), publicObject, Buffer.from(receipt.signature, 'base64'))) {
    throw new Error('independent review receipt signature mismatch');
  }
  return receipt;
}

function publicKeyFor(source, identity) {
  return source instanceof Map ? source.get(identity) : source && typeof source === 'object' ? source[identity] : undefined;
}

const reviewedIdentity = (receipt) => ({
  subjectProducerIdentity: receipt.subjectProducerIdentity,
  sourceSha: receipt.sourceSha,
  sourceTree: receipt.sourceTree,
  artifactSha256: receipt.artifactSha256,
  payloadId: receipt.payloadId,
  payloadSha256: receipt.payloadSha256,
  releaseIdentitySha256: receipt.releaseIdentitySha256,
  productContractSha256: receipt.productContractSha256,
  rubricSha256: receipt.rubricSha256,
  retrievalOracleReview: {
    oracleReceiptSha256: receipt.retrievalOracleReview.oracleReceiptSha256,
    queryStoreSetSha256: receipt.retrievalOracleReview.queryStoreSetSha256,
    recordCount: receipt.retrievalOracleReview.recordCount,
    recordSetSha256: receipt.retrievalOracleReview.recordSetSha256,
  },
});

export function validateIndependentReviewPair(receipts, { publicKeysByReviewer, expectedIdentity = null,
  expectedOracle = null } = {}) {
  if (!Array.isArray(receipts) || receipts.length !== ALLOWED_INDEPENDENT_REVIEWERS.length) {
    throw new Error('independent review pair requires exactly two receipts');
  }
  const identities = receipts.map(({ id }) => id);
  const allowed = ALLOWED_INDEPENDENT_REVIEWERS.map(({ identity }) => identity);
  if (new Set(identities).size !== allowed.length || allowed.some((identity) => !identities.includes(identity))) {
    throw new Error('independent review pair requires two distinct allowed reviewers');
  }
  const ordered = allowed.map((identity) => receipts.find((receipt) => receipt.id === identity));
  for (const receipt of ordered) {
    const publicKey = publicKeyFor(publicKeysByReviewer, receipt.id);
    if (!publicKey) throw new Error(`public key is missing for reviewer ${receipt.id}`);
    verifyIndependentReviewReceipt(receipt, publicKey);
    if (receipt.verdict !== 'PASS' || receipt.score < 95 || receipt.untested.length) {
      throw new Error('public verification requires two passing reviews with no untested scope');
    }
    validateRetrievalOracleReview(receipt.retrievalOracleReview, { requireAcceptance: true });
  }
  const identity = reviewedIdentity(ordered[0]);
  if (ordered.slice(1).some((receipt) => canonicalJson(reviewedIdentity(receipt)) !== canonicalJson(identity))) {
    throw new Error('independent reviewers reviewed identity differs');
  }
  if (expectedIdentity && canonicalJson(identity) !== canonicalJson(expectedIdentity)) {
    throw new Error('independent review pair differs from expected reviewed identity');
  }
  if (expectedOracle) {
    const expected = normalizeExpectedOracle(expectedOracle);
    ordered.forEach((receipt) => assertOracleReviewMatches(receipt.retrievalOracleReview, expected));
  }
  return ordered;
}

const CLI_OPTIONS = Object.freeze({
  produce: Object.freeze(['--input', '--out']),
  verify: Object.freeze(['--public-key', '--receipt']),
  'verify-pair': Object.freeze([
    '--expected-identity', '--fable', '--fable-public-key', '--retrieval-plan', '--sol', '--sol-public-key',
  ]),
});

function parseCli(args) {
  const command = args[0];
  const allowed = CLI_OPTIONS[command];
  if (!allowed) throw new Error('command must be produce, verify, or verify-pair');
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.includes(name)) throw new Error(`unknown ${command} option: ${String(name)}`);
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (Object.hasOwn(options, name)) throw new Error(`${name} may be supplied only once`);
    options[name] = value;
  }
  const required = allowed.filter((name) => name !== '--expected-identity');
  const missing = required.filter((name) => !options[name]);
  if (missing.length) throw new Error(`${command} requires ${missing.join(', ')}`);
  return { command, options };
}

function readRegular(file, label) {
  const resolved = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return fs.readFileSync(resolved, 'utf8');
}

function readJson(file, label) {
  try { return JSON.parse(readRegular(file, label)); }
  catch (error) {
    if (error.message.startsWith(label)) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
}

function writeReceipt(file, receipt) {
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }

export function main(args = process.argv.slice(2), runtime = {}) {
  const env = runtime.env || process.env;
  const stdout = runtime.stdout || process.stdout;
  const stderr = runtime.stderr || process.stderr;
  try {
    const { command, options } = parseCli(args);
    if (command === 'produce') {
      if (!env.RUVNET_REVIEW_SIGNING_KEY) throw new Error('RUVNET_REVIEW_SIGNING_KEY is required');
      const receipt = createIndependentReviewReceipt(
        readJson(options['--input'], 'review input'),
        env.RUVNET_REVIEW_SIGNING_KEY,
      );
      writeReceipt(options['--out'], receipt);
      stdout.write(`${JSON.stringify({ verdict: receipt.verdict, reviewer: receipt.id,
        receiptSha256: receipt.receiptSha256 })}\n`);
      return 0;
    }
    if (command === 'verify') {
      const receipt = readJson(options['--receipt'], 'review receipt');
      verifyIndependentReviewReceipt(receipt, readRegular(options['--public-key'], 'review public key'));
      stdout.write(`${JSON.stringify({ verdict: receipt.verdict, reviewer: receipt.id,
        receiptSha256: receipt.receiptSha256 })}\n`);
      return 0;
    }
    const receipts = [readJson(options['--fable'], 'Fable review receipt'),
      readJson(options['--sol'], 'Sol review receipt')];
    const ordered = validateIndependentReviewPair(receipts, {
      publicKeysByReviewer: {
        'claude-fable-5': readRegular(options['--fable-public-key'], 'Fable review public key'),
        'gpt-5.6-sol': readRegular(options['--sol-public-key'], 'Sol review public key'),
      },
      expectedIdentity: options['--expected-identity']
        ? readJson(options['--expected-identity'], 'expected review identity') : null,
      expectedOracle: retrievalOracleExpectationFromPlan(
        readJson(options['--retrieval-plan'], 'retrieval canary plan')),
    });
    const reviews = ordered.map(({ id, receiptSha256 }) => ({ id, receiptSha256 }));
    stdout.write(`${JSON.stringify({ verdict: 'PASS', reviews, pairSha256: digest(reviews) })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`independent-review-receipt: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
