#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest, validateCoverageLedger } from './coverage-integrity.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const ordered = (value) => [...value].sort((a, b) => a.localeCompare(b));
const storeOf = (row) => String(row?.artifact?.store || '').toLowerCase();
const setDigest = (values) => digest(ordered(values));

function checkedSet(values, expectedDigest, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)
    || canonicalJson(values) !== canonicalJson(ordered(values)) || new Set(values).size !== values.length
    || setDigest(values) !== expectedDigest) throw new Error(`${label} set is invalid`);
  return values;
}

function defaultReadPassages(assetsDir, store) {
  const file = path.join(assetsDir, `${store}.passages.jsonl`);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`${store} passage inventory is missing`);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${store} passage ${index + 1} is invalid: ${error.message}`); }
  });
}

function planPayload(plan) {
  const { planSha256: _planSha256, ...payload } = plan;
  return payload;
}

function regular(file, label) {
  const resolved = path.resolve(file || '');
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted regular file`);
  return resolved;
}

function queryEvidenceSourcePayload(evidence) {
  return {
    schemaVersion: evidence?.schemaVersion,
    kind: evidence?.kind,
    queryStoreSetSha256: evidence?.queryStoreSetSha256,
    queries: evidence?.queries,
  };
}

const normalizedQuery = (query) => String(query || '').trim().replace(/\s+/g, ' ').toLowerCase();

function queryEvidenceReceiptPayload(evidence) {
  const { receiptSha256: _receiptSha256, ...payload } = evidence;
  return payload;
}

export function sealRetrievalQueryEvidence(evidence) {
  const sourcePayload = queryEvidenceSourcePayload(evidence);
  const payload = {
    ...sourcePayload,
    sourceCommit: evidence?.sourceCommit,
    sourcePath: evidence?.sourcePath,
    sourceBlobSha256: digest(sourcePayload),
  };
  return { ...payload, receiptSha256: digest(payload) };
}

export function validateRetrievalQueryEvidence(evidence) {
  const keys = Object.keys(evidence || {}).sort();
  const expectedKeys = ['kind', 'queries', 'queryStoreSetSha256', 'receiptSha256', 'schemaVersion',
    'sourceBlobSha256', 'sourceCommit', 'sourcePath'];
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)
    || evidence?.schemaVersion !== 2 || evidence?.kind !== 'ruvnet-brain-retrieval-query-evidence'
    || !HEX40.test(String(evidence.sourceCommit || '')) || typeof evidence.sourcePath !== 'string'
    || !evidence.sourcePath || path.isAbsolute(evidence.sourcePath)
    || evidence.sourcePath.split(/[\\/]/).includes('..')
    || !HEX64.test(String(evidence.queryStoreSetSha256 || ''))
    || !evidence.queries || typeof evidence.queries !== 'object' || Array.isArray(evidence.queries)
    || Object.keys(evidence.queries).length === 0
    || evidence.sourceBlobSha256 !== digest(queryEvidenceSourcePayload(evidence))
    || evidence.receiptSha256 !== digest(queryEvidenceReceiptPayload(evidence))) {
    throw new Error('independent retrieval query evidence is malformed');
  }
  const stores = ordered(Object.keys(evidence.queries));
  if (digest(stores) !== evidence.queryStoreSetSha256) {
    throw new Error('independent retrieval query evidence store set is invalid');
  }
  const seenQueries = new Set();
  for (const store of stores) {
    const row = evidence.queries[store];
    const expected = row?.expected;
    const normalized = normalizedQuery(row?.query);
    if (Object.keys(row || {}).sort().join(',') !== 'expected,query,recordSha256'
      || typeof row.query !== 'string' || row.query !== row.query.trim().replace(/\s+/g, ' ')
      || normalized.length < 24 || seenQueries.has(normalized)
      || !expected || Object.keys(expected).sort().join(',') !== 'passageSha256,path'
      || typeof expected.path !== 'string' || !expected.path || path.isAbsolute(expected.path)
      || expected.path.split(/[\\/]/).includes('..')
      || !HEX64.test(String(expected.passageSha256 || ''))
      || row.recordSha256 !== digest({ store, query: row.query, expected })) {
      throw new Error(`independent retrieval query evidence for ${store} is malformed`);
    }
    seenQueries.add(normalized);
  }
  return evidence;
}

export function verifyQueryOracleSource(queryEvidence, candidateSourceSha, {
  cwd = process.cwd(), run = spawnSync, allowSquashedSource = false,
} = {}) {
  validateRetrievalQueryEvidence(queryEvidence);
  if (!HEX40.test(String(candidateSourceSha || '')) || queryEvidence.sourceCommit === candidateSourceSha) {
    throw new Error('query oracle source identity is invalid');
  }
  const ancestor = run('git', ['merge-base', '--is-ancestor', queryEvidence.sourceCommit, candidateSourceSha],
    { cwd, encoding: 'utf8' });
  const strictAncestor = !ancestor.error && ancestor.status === 0;
  if (!strictAncestor && !allowSquashedSource) throw new Error('query oracle source is not a strict candidate ancestor');
  const shown = run('git', ['show', `${queryEvidence.sourceCommit}:${queryEvidence.sourcePath}`],
    { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  let sourcePayload;
  try { sourcePayload = queryEvidenceSourcePayload(JSON.parse(Buffer.from(shown.stdout || '').toString('utf8'))); }
  catch { throw new Error('query oracle source payload is not valid JSON'); }
  if (shown.error || shown.status !== 0 || digest(sourcePayload) !== queryEvidence.sourceBlobSha256) {
    throw new Error('query oracle source payload differs from its immutable Git identity');
  }
  const candidateShown = run('git', ['show', `${candidateSourceSha}:${queryEvidence.sourcePath}`],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let candidateEvidence;
  try { candidateEvidence = JSON.parse(String(candidateShown.stdout || '')); }
  catch { throw new Error('candidate query oracle evidence is not valid JSON'); }
  if (candidateShown.error || candidateShown.status !== 0
    || canonicalJson(candidateEvidence) !== canonicalJson(queryEvidence)) {
    throw new Error('supplied query oracle evidence differs from candidate tracked bytes');
  }
  return queryEvidence;
}

const sha256Buffer = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export function validateRetrievalCanaryPlan(plan) {
  const observedBaseline = plan?.baseline?.kind === 'ruvnet-brain-observed-failed-public-baseline';
  const baselineReceiptValid = observedBaseline
    ? plan.baseline.integrity === 'DEGRADED' && plan.baseline.historicalCorpusReceipt === false && plan.baseline.candidateVerificationEligible === false
      && HEX64.test(String(plan.baseline.observationReceiptSha256 || '')) && HEX64.test(String(plan.baseline.discrepancyDigest || ''))
    : plan?.baseline?.kind === 'ruvnet-brain-verified-public-baseline'
      && HEX64.test(String(plan?.baseline?.verificationReceiptSha256 || ''));
  if (plan?.schemaVersion !== 2 || plan?.kind !== 'ruvnet-brain-retrieval-canary-plan'
    || !HEX64.test(String(plan.coverage?.sha256 || '')) || !Number.isSafeInteger(plan.coverage?.bytes)
    || plan.coverage.bytes < 1 || !HEX64.test(String(plan.coverage?.releaseCoverageGeneration || ''))
    || !HEX64.test(String(plan.baseline?.archiveSha256 || '')) || !baselineReceiptValid
    || !HEX64.test(String(plan.baseline?.archiveManifestSha256 || '')) || !Number.isSafeInteger(plan.baseline?.archiveBytes)
    || !Number.isSafeInteger(plan.baseline?.storeCount) || plan.baseline.storeCount < 1
    || !Array.isArray(plan.baseline?.stores) || plan.baseline.stores.length !== plan.baseline.storeCount
    || !HEX64.test(String(plan.baseline?.storeSetSha256 || ''))
    || !HEX40.test(String(plan.candidate?.sourceSha || '')) || !HEX64.test(String(plan.candidate?.packageSha256 || ''))
    || !HEX64.test(String(plan.candidate?.archiveSha256 || ''))
    || !HEX64.test(String(plan.candidate?.coverageSha256 || '')) || !HEX64.test(String(plan.candidate?.publicLedgerSha256 || ''))
    || !HEX64.test(String(plan.candidate?.publicInventoryPartitionSha256 || ''))
    || !Number.isSafeInteger(plan.candidate?.publicLedgerBytes) || plan.candidate.publicLedgerBytes < 1
    || !Number.isSafeInteger(plan.candidate?.publicStoreCount) || plan.candidate.publicStoreCount < 1
    || !HEX64.test(String(plan.oracle?.receiptSha256 || ''))
    || !HEX64.test(String(plan.oracle?.queryStoreSetSha256 || ''))
    || !HEX40.test(String(plan.oracle?.sourceCommit || '')) || !HEX64.test(String(plan.oracle?.sourceBlobSha256 || ''))
    || !plan.denominator || plan.k !== 10
    || !Array.isArray(plan.cases) || plan.cases.length === 0) throw new Error('retrieval canary plan is malformed');
  const ids = plan.cases.map((row) => row.id);
  const evidence = validateRetrievalQueryEvidence(plan.oracle?.evidence);
  if (evidence.receiptSha256 !== plan.oracle.receiptSha256
    || evidence.queryStoreSetSha256 !== plan.oracle.queryStoreSetSha256
    || evidence.sourceCommit !== plan.oracle.sourceCommit
    || evidence.sourceBlobSha256 !== plan.oracle.sourceBlobSha256) {
    throw new Error('retrieval canary oracle differs from its sealed query evidence');
  }
  const baselineStores = ordered(plan.baseline.stores.map((store) => String(store).toLowerCase()));
  if (new Set(baselineStores).size !== baselineStores.length
    || digest(baselineStores) !== plan.baseline.storeSetSha256) throw new Error('retrieval baseline store set is invalid');
  checkedSet(plan.denominator.eligibleStores, plan.denominator.eligibleStoreSetSha256, 'eligible denominator');
  checkedSet(plan.denominator.deltaStores, plan.denominator.deltaStoreSetSha256, 'delta denominator');
  checkedSet(plan.denominator.legacyPopulationStores, plan.denominator.legacyPopulationStoreSetSha256,
    'legacy population denominator');
  checkedSet(plan.denominator.legacySelectedStores, plan.denominator.legacySelectedStoreSetSha256,
    'legacy selected denominator');
  if (setDigest(plan.denominator.eligibleStores) !== plan.oracle.queryStoreSetSha256) {
    throw new Error('oracle denominator differs from eligible coverage');
  }
  if (new Set(ids).size !== ids.length) throw new Error('retrieval canary plan has duplicate case ids');
  if ((!plan.cases.some(({ cohort }) => cohort === 'delta') && plan.noDelta !== true)
    || !plan.cases.some(({ cohort }) => cohort === 'legacy')) {
    throw new Error('retrieval canary plan requires delta and legacy cohorts');
  }
  for (const row of plan.cases) {
    const oracleRow = evidence.queries[row.expected?.repo];
    if (!['delta', 'legacy'].includes(row.cohort) || typeof row.query !== 'string' || row.query.length < 24
      || typeof row.expected?.repo !== 'string' || !row.expected.repo
      || typeof row.expected?.path !== 'string' || !row.expected.path
      || row.id !== `${row.cohort}:${row.expected.repo}`
      || !HEX64.test(String(row.expected?.passageSha256 || ''))
      || !HEX64.test(String(row.oracleRecordSha256 || ''))
      || !oracleRow || row.query !== oracleRow.query
      || canonicalJson(row.expected) !== canonicalJson({ repo: row.expected.repo, ...oracleRow.expected })
      || row.oracleRecordSha256 !== oracleRow.recordSha256) {
      throw new Error(`retrieval canary ${row.id || '(missing)'} is malformed`);
    }
  }
  const deltaCases = ordered(plan.cases.filter(({ cohort }) => cohort === 'delta').map(({ expected }) => expected.repo));
  const legacyCases = ordered(plan.cases.filter(({ cohort }) => cohort === 'legacy').map(({ expected }) => expected.repo));
  if (canonicalJson(deltaCases) !== canonicalJson(plan.denominator.deltaStores)
    || canonicalJson(legacyCases) !== canonicalJson(plan.denominator.legacySelectedStores)
    || plan.cohorts?.delta !== deltaCases.length || plan.cohorts?.legacy !== legacyCases.length) {
    throw new Error('retrieval canary cases differ from the sealed denominator');
  }
  if (digest(planPayload(plan)) !== plan.planSha256) throw new Error('retrieval canary plan digest mismatch');
  return plan;
}
export function validatePlanAgainstCoverage(plan, coverage, { allowObservedBaseline = false } = {}) {
  validateRetrievalCanaryPlan(plan);
  if (plan.baseline.kind === 'ruvnet-brain-observed-failed-public-baseline' && !allowObservedBaseline) {
    throw new Error('observed failed-public baseline is not candidate-verification eligible');
  }
  const checked = validateCoverageLedger(coverage);
  if (!checked.valid) throw new Error(`coverage ledger is invalid: ${checked.failures.join('; ')}`);
  const generation = coverage.kind === 'ruvnet-brain-release-coverage'
    ? coverage.releaseCoverageGeneration : coverage.coverageGeneration;
  const eligible = ordered(coverage.rows.filter((row) => row.kind === 'repository'
    && row.disposition === 'eligible' && row.status === 'CURRENT').map(storeOf));
  if (!eligible.length || new Set(eligible).size !== eligible.length) throw new Error('eligible coverage denominator is invalid');
  const baseline = new Set(plan.baseline.stores);
  const delta = eligible.filter((store) => !baseline.has(store));
  const legacy = eligible.filter((store) => baseline.has(store));
  if (generation !== plan.coverage.releaseCoverageGeneration
    || canonicalJson(eligible) !== canonicalJson(plan.denominator.eligibleStores)
    || canonicalJson(delta) !== canonicalJson(plan.denominator.deltaStores)
    || canonicalJson(legacy) !== canonicalJson(plan.denominator.legacyPopulationStores)
    || plan.denominator.legacySelectedStores.some((store) => !legacy.includes(store))) {
    throw new Error('retrieval canary plan differs from exact coverage denominator');
  }
  return plan;
}
export function buildRetrievalCanaryPlan({ coverage, baseline, candidate, coverageIdentity = null, queryEvidence, assetsDir = '.',
  readPassages = defaultReadPassages, legacySampleSize, allowNoDelta = false } = {}) {
  const checked = validateCoverageLedger(coverage);
  if (!checked.valid) throw new Error(`coverage ledger is invalid: ${checked.failures.join('; ')}`);
  const coverageGeneration = coverage.kind === 'ruvnet-brain-release-coverage'
    ? coverage.releaseCoverageGeneration : coverage.coverageGeneration;
  if (!HEX64.test(String(coverageGeneration || ''))) throw new Error('coverage has no exact generation identity');
  const observedBaseline = baseline?.kind === 'ruvnet-brain-observed-failed-public-baseline';
  const receiptValid = observedBaseline
    ? baseline?.integrity === 'DEGRADED' && baseline?.historicalCorpusReceipt === false && baseline?.candidateVerificationEligible === false
      && HEX64.test(String(baseline?.observationReceiptSha256 || '')) && HEX64.test(String(baseline?.discrepancyDigest || ''))
      && Array.isArray(baseline?.ledgerDiscrepancies) && Array.isArray(baseline?.provenanceGaps)
    : baseline?.kind === 'ruvnet-brain-verified-public-baseline'
      && HEX64.test(String(baseline?.verificationReceiptSha256 || ''));
  if (baseline?.schemaVersion !== 1 || !receiptValid
    || !HEX64.test(String(baseline.archiveSha256 || '')) || !Number.isSafeInteger(baseline.archiveBytes) || baseline.archiveBytes < 1
    || !HEX64.test(String(baseline.archiveManifestSha256 || ''))
    || !Array.isArray(baseline.stores) || baseline.stores.length === 0 || baseline.storeCount !== baseline.stores.length
    || new Set(baseline.stores.map((store) => String(store).toLowerCase())).size !== baseline.stores.length) {
    throw new Error('verified failed-public baseline identity is malformed');
  }
  if (!candidate || (coverage.kind === 'ruvnet-brain-release-coverage'
    && candidate.sourceSha !== coverage.releaseIdentity?.sourceSnapshot)) {
    throw new Error('candidate source identity differs from release coverage');
  }
  if (!HEX40.test(String(candidate?.sourceSha || '')) || !HEX64.test(String(candidate?.packageSha256 || ''))
    || !HEX64.test(String(candidate?.archiveSha256 || ''))
    || !HEX64.test(String(candidate?.coverageSha256 || '')) || !HEX64.test(String(candidate?.publicLedgerSha256 || ''))
    || !Number.isSafeInteger(candidate?.publicLedgerBytes) || candidate.publicLedgerBytes < 1
    || !Number.isSafeInteger(candidate?.publicStoreCount) || candidate.publicStoreCount < 1
    || !HEX64.test(String(candidate?.publicInventoryPartitionSha256 || ''))) {
    throw new Error('candidate public artifact identity is malformed');
  }
  if (coverage.kind === 'ruvnet-brain-release-coverage') {
    const baselineReceiptSha256 = observedBaseline ? baseline.observationReceiptSha256 : baseline.verificationReceiptSha256;
    if (baseline.tag !== coverage.corpusSeed?.tag || baseline.archiveSha256 !== coverage.corpusSeed?.archiveSha256
      || baseline.archiveBytes !== coverage.corpusSeed?.archiveBytes || baselineReceiptSha256 !== coverage.corpusSeed?.receiptSha256) {
      throw new Error('failed-public baseline differs from the release corpus seed identity');
    }
    if (candidate.publicLedgerSha256 !== coverage.generationLedger?.sha256
      || candidate.publicLedgerBytes !== coverage.generationLedger?.bytes
      || candidate.publicStoreCount !== coverage.generationLedger?.storeCount
      || candidate.publicInventoryPartitionSha256 !== coverage.publicInventoryPartitionSha256
      || !coverageIdentity || candidate.coverageSha256 !== coverageIdentity.sha256
      || !Number.isSafeInteger(coverageIdentity.bytes) || coverageIdentity.bytes < 1) {
      throw new Error('candidate identity differs from exact release coverage evidence');
    }
  }
  validateRetrievalQueryEvidence(queryEvidence);
  if (queryEvidence.sourceCommit === candidate.sourceSha) throw new Error('independent query source is not pre-candidate');
  const eligible = coverage.rows.filter((row) => row.kind === 'repository' && row.disposition === 'eligible');
  if (!eligible.length || eligible.some((row) => row.status !== 'CURRENT' || !storeOf(row))) {
    throw new Error('eligible repository coverage is incomplete');
  }
  const duplicateStores = eligible.map(storeOf).filter((store, index, stores) => stores.indexOf(store) !== index);
  if (duplicateStores.length) throw new Error(`eligible repository stores are duplicated: ${ordered(new Set(duplicateStores)).join(', ')}`);
  const eligibleStores = ordered(eligible.map(storeOf));
  if (queryEvidence.queryStoreSetSha256 !== setDigest(eligibleStores)
    || canonicalJson(ordered(Object.keys(queryEvidence.queries))) !== canonicalJson(eligibleStores)) {
    const oracleStores = new Set(Object.keys(queryEvidence.queries));
    const missing = eligibleStores.filter((store) => !oracleStores.has(store));
    const extra = [...oracleStores].filter((store) => !eligibleStores.includes(store)).sort();
    throw new Error(`independent query oracle does not cover the exact eligible store set (eligible=${eligibleStores.length}, oracle=${oracleStores.size}, missing=${missing.join(',') || 'none'}, extra=${extra.join(',') || 'none'})`);
  }
  const baselineStores = new Set(baseline.stores.map((name) => String(name).toLowerCase()));
  const delta = eligible.filter((row) => !baselineStores.has(storeOf(row)));
  const legacyPool = eligible.filter((row) => baselineStores.has(storeOf(row)));
  if ((!delta.length && !allowNoDelta) || !legacyPool.length) throw new Error('coverage does not establish both failed-seed delta and legacy cohorts');
  const passages = new Map(eligible.map((row) => [storeOf(row), readPassages(assetsDir, storeOf(row))]));
  const rankedLegacy = legacyPool.map((row) => ({ row, count: passages.get(storeOf(row)).length }))
    .sort((a, b) => a.count - b.count || storeOf(a.row).localeCompare(storeOf(b.row)));
  const strata = new Map();
  rankedLegacy.forEach((entry, index) => {
    const stratum = Math.min(3, Math.floor(index * 4 / rankedLegacy.length));
    if (!strata.has(stratum)) strata.set(stratum, []);
    strata.get(stratum).push(entry);
  });
  const sampleCount = Math.min(legacyPool.length, legacySampleSize ?? Math.max(10, Math.ceil(eligible.length * 0.1)));
  if (sampleCount < strata.size) throw new Error(`legacy sample must cover all ${strata.size} passage-count strata`);
  const selected = [];
  for (const [stratum, entries] of strata) {
    entries.sort((a, b) => digest(`${coverageGeneration}:${stratum}:${storeOf(a.row)}`)
      .localeCompare(digest(`${coverageGeneration}:${stratum}:${storeOf(b.row)}`)));
    selected.push({ ...entries.shift(), stratum });
  }
  while (selected.length < sampleCount) {
    let advanced = false;
    for (const [stratum, entries] of strata) if (entries.length && selected.length < sampleCount) {
      selected.push({ ...entries.shift(), stratum }); advanced = true;
    }
    if (!advanced) break;
  }
  const legacy = selected.map(({ row, stratum, count }) => ({ row, stratum, passageCount: count }));
  const cases = [...delta.map((row) => ({ row, cohort: 'delta' })),
    ...legacy.map(({ row, stratum, passageCount }) => ({ row, cohort: 'legacy', stratum, passageCount }))]
    .map(({ row, cohort, stratum = null, passageCount }) => {
      const store = storeOf(row);
      const observedPassageCount = passageCount ?? passages.get(store).length;
      const evidence = queryEvidence.queries[store];
      const matches = passages.get(store).filter((row) => row.path === evidence?.expected?.path
        && digest(row) === evidence.expected.passageSha256);
      if (!evidence || matches.length !== 1) {
        throw new Error(`${store} has no sealed independent query evidence`);
      }
      return {
        id: `${cohort}:${store}`,
        cohort,
        stratum,
        passageCount: observedPassageCount,
        query: evidence.query.trim(),
        oracleRecordSha256: evidence.recordSha256,
        expected: { repo: store, ...evidence.expected },
        source: { key: row.key, upstreamSha: row.upstream?.sha || null, artifactSha256: row.artifact?.rvfSha256 || null,
          queryEvidenceReceiptSha256: queryEvidence.receiptSha256 },
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    schemaVersion: 2,
    kind: 'ruvnet-brain-retrieval-canary-plan',
    coverage: { sha256: coverageIdentity.sha256, bytes: coverageIdentity.bytes,
      releaseCoverageGeneration: coverageGeneration },
    baseline: { kind: baseline.kind, tag: baseline.tag, archiveSha256: baseline.archiveSha256, archiveBytes: baseline.archiveBytes,
      archiveManifestSha256: baseline.archiveManifestSha256,
      ...(observedBaseline ? { integrity: baseline.integrity, historicalCorpusReceipt: false,
        candidateVerificationEligible: false, observationReceiptSha256: baseline.observationReceiptSha256,
        discrepancyDigest: baseline.discrepancyDigest } : { verificationReceiptSha256: baseline.verificationReceiptSha256 }),
      stores: ordered(baseline.stores.map((store) => String(store).toLowerCase())),
      storeCount: baseline.storeCount,
      storeSetSha256: digest(ordered(baseline.stores.map((store) => String(store).toLowerCase()))) },
    candidate: structuredClone(candidate),
    denominator: {
      eligibleStores,
      eligibleStoreSetSha256: setDigest(eligibleStores),
      deltaStores: ordered(delta.map(storeOf)),
      deltaStoreSetSha256: setDigest(delta.map(storeOf)),
      legacyPopulationStores: ordered(legacyPool.map(storeOf)),
      legacyPopulationStoreSetSha256: setDigest(legacyPool.map(storeOf)),
      legacySelectedStores: ordered(legacy.map(({ row }) => storeOf(row))),
      legacySelectedStoreSetSha256: setDigest(legacy.map(({ row }) => storeOf(row))),
    },
    oracle: { receiptSha256: queryEvidence.receiptSha256,
      queryStoreSetSha256: queryEvidence.queryStoreSetSha256,
      sourceCommit: queryEvidence.sourceCommit, sourceBlobSha256: queryEvidence.sourceBlobSha256,
      evidence: structuredClone(queryEvidence) },
    noDelta: delta.length === 0,
    cohorts: { delta: delta.length, legacy: legacy.length,
      legacyStrata: [...strata.keys()].sort().map((stratum) => ({ stratum,
        population: rankedLegacy.filter((_entry, index) => Math.min(3, Math.floor(index * 4 / rankedLegacy.length)) === stratum).length,
        selected: legacy.filter((entry) => entry.stratum === stratum).length })) },
    k: 10,
    cases,
  };
  const plan = validateRetrievalCanaryPlan({ ...payload, planSha256: digest(payload) });
  return validatePlanAgainstCoverage(plan, coverage, { allowObservedBaseline: observedBaseline });
}
function resultRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  throw new Error('search result has no results array');
}

function receiptPayload(receipt) {
  const { receiptSha256: _receiptSha256, ...payload } = receipt;
  return payload;
}
export function validateRetrievalCanaryReceipt(receipt, { plan, requireAcceptance = true } = {}) {
  validateRetrievalCanaryPlan(plan);
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'ruvnet-brain-retrieval-canary-receipt'
    || !HEX40.test(String(receipt.sourceSha || '')) || !HEX64.test(String(receipt.artifactSha256 || ''))
    || !HEX64.test(String(receipt.candidateArchiveSha256 || ''))
    || !HEX64.test(String(receipt.coverageGeneration || '')) || !HEX64.test(String(receipt.planSha256 || ''))
    || !Array.isArray(receipt.cases) || !receipt.cases.length) throw new Error('retrieval canary receipt is malformed');
  if (digest(receiptPayload(receipt)) !== receipt.receiptSha256) throw new Error('retrieval canary receipt digest mismatch');
  if (receipt.sourceSha !== plan.candidate.sourceSha
    || receipt.candidateArchiveSha256 !== plan.candidate.archiveSha256
    || receipt.artifactSha256 !== plan.candidate.packageSha256
    || receipt.coverageGeneration !== plan.coverage.releaseCoverageGeneration
    || receipt.planSha256 !== plan.planSha256 || receipt.k !== 10 || plan.k !== 10
    || canonicalJson(receipt.cases.map(({ id, cohort }) => ({ id, cohort })))
      !== canonicalJson(plan.cases.map(({ id, cohort }) => ({ id, cohort })))) {
    throw new Error('retrieval canary receipt denominator differs from the sealed plan');
  }
  if (receipt.cases.some((row) => !['COMPLETED', 'UNKNOWN', 'SKIPPED'].includes(row.status)
    || (row.retrievalHit === true && (row.status !== 'COMPLETED' || !Number.isInteger(row.rank)
      || row.rank < 1 || row.rank > 10))
    || (row.retrievalHit !== true && (row.rank !== null || row.citationResolved === true)))) {
    throw new Error('retrieval canary case state is invalid');
  }
  for (const row of receipt.cases) {
    const expected = plan.cases.find(({ id }) => id === row.id)?.expected;
    const ranked = row.retrievalHit ? row.citations?.[row.rank - 1] : null;
    if (row.retrievalHit && (String(ranked?.repo || '').toLowerCase() !== expected.repo
      || ranked?.path !== expected.path
      || (row.citationResolved === true && (row.citationEvidence?.passageSha256 !== expected.passageSha256
        || !HEX64.test(String(row.citationEvidence?.passageFileSha256 || '')))))) {
      throw new Error(`retrieval canary ${row.id} hit or citation evidence differs from the sealed plan`);
    }
  }
  const delta = receipt.cases.filter(({ cohort }) => cohort === 'delta');
  const hits = receipt.cases.filter(({ retrievalHit }) => retrievalHit === true).length;
  const unknown = receipt.cases.filter(({ status }) => status === 'UNKNOWN').length;
  const skipped = receipt.cases.filter(({ status }) => status === 'SKIPPED').length;
  const metrics = {
    total: receipt.cases.length,
    hits,
    deltaTotal: delta.length,
    deltaHits: delta.filter(({ retrievalHit }) => retrievalHit === true).length,
    deltaCitations: delta.filter(({ retrievalHit, citationResolved }) => retrievalHit === true && citationResolved === true).length,
    recallAt10: hits / receipt.cases.length,
    deltaCitationRate: delta.length ? delta.filter(({ retrievalHit, citationResolved }) => retrievalHit === true && citationResolved === true).length / delta.length : 0,
    unknown,
    skipped,
  };
  if (canonicalJson(metrics) !== canonicalJson(receipt.metrics)) throw new Error('retrieval canary metrics were not derived from case evidence');
  if (requireAcceptance && (metrics.deltaCitationRate !== 1 || metrics.recallAt10 < 0.98 || unknown || skipped)) {
    throw new Error('retrieval canary acceptance failed');
  }
  return receipt;
}

export async function runRetrievalCanaries({ plan, sourceSha, artifactSha256, candidateArchiveSha256,
  search, citationResolver, concurrency = 3 } = {}) {
  validateRetrievalCanaryPlan(plan);
  if (!HEX40.test(String(sourceSha || '')) || !HEX64.test(String(artifactSha256 || ''))
    || !HEX64.test(String(candidateArchiveSha256 || '')) || sourceSha !== plan.candidate.sourceSha
    || artifactSha256 !== plan.candidate.packageSha256
    || candidateArchiveSha256 !== plan.candidate.archiveSha256
    || typeof search !== 'function' || typeof citationResolver !== 'function') {
    throw new Error('retrieval canary execution identity is invalid');
  }
  const cases = new Array(plan.cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), plan.cases.length) }, async () => {
    for (let index = next++; index < plan.cases.length; index = next++) {
      const canary = plan.cases[index];
      try {
        const rows = resultRows(await search({ query: canary.query, k: 10 }));
        const top = rows.slice(0, 10);
        const rank = top.findIndex((row) => String(row?.repo || '').toLowerCase() === canary.expected.repo
          && row?.path === canary.expected.path);
        const matched = rank >= 0 ? top[rank] : null;
        const resolved = matched ? await citationResolver(matched, canary.expected) : { resolved: false };
        cases[index] = { id: canary.id, cohort: canary.cohort, status: 'COMPLETED', retrievalHit: rank >= 0,
          citationResolved: resolved?.resolved === true, citationEvidence: resolved?.evidence || null,
          rank: rank >= 0 ? rank + 1 : null, citations: top.map(({ repo, path: hitPath }) => ({ repo, path: hitPath })) };
      } catch (error) {
        cases[index] = { id: canary.id, cohort: canary.cohort, status: 'UNKNOWN', retrievalHit: false,
          citationResolved: false, citationEvidence: null, rank: null, citations: [], error: error.message };
      }
    }
  }));
  const delta = cases.filter(({ cohort }) => cohort === 'delta');
  const hits = cases.filter(({ retrievalHit }) => retrievalHit).length;
  const metrics = { total: cases.length, hits, deltaTotal: delta.length, deltaHits: delta.filter(({ retrievalHit }) => retrievalHit).length,
    deltaCitations: delta.filter(({ retrievalHit, citationResolved }) => retrievalHit && citationResolved).length,
    recallAt10: hits / cases.length, deltaCitationRate: delta.length ? delta.filter(({ retrievalHit, citationResolved }) => retrievalHit && citationResolved).length / delta.length : 0,
    unknown: cases.filter(({ status }) => status === 'UNKNOWN').length,
    skipped: cases.filter(({ status }) => status === 'SKIPPED').length };
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-retrieval-canary-receipt', sourceSha, artifactSha256,
    candidateArchiveSha256,
    coverageGeneration: plan.coverage.releaseCoverageGeneration, planSha256: plan.planSha256, k: 10, cases, metrics };
  return validateRetrievalCanaryReceipt({ ...payload, receiptSha256: digest(payload) }, { plan, requireAcceptance: false });
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function buildPlanFromFiles({ coverageFile, baselineFile, candidateFile, oracleFile, assetsDir,
  outFile, cwd = process.cwd() }) {
  const coveragePath = regular(coverageFile, 'coverage');
  const coverageBytes = fs.readFileSync(coveragePath);
  const coverage = JSON.parse(coverageBytes);
  const baseline = JSON.parse(fs.readFileSync(regular(baselineFile, 'baseline'), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(regular(candidateFile, 'candidate identity'), 'utf8'));
  const queryEvidence = JSON.parse(fs.readFileSync(regular(oracleFile, 'query oracle'), 'utf8'));
  verifyQueryOracleSource(queryEvidence, candidate.sourceSha, { cwd });
  const plan = buildRetrievalCanaryPlan({ coverage, baseline, candidate, queryEvidence,
    coverageIdentity: { sha256: sha256Buffer(coverageBytes), bytes: coverageBytes.length },
    assetsDir: regular(path.join(path.resolve(assetsDir), 'PRIVATE-STORES.json'), 'assets private fence')
      && path.resolve(assetsDir) });
  const output = path.resolve(outFile || 'release-evidence/retrieval-canary-plan.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const plan = buildPlanFromFiles({ coverageFile: arg(argv, '--coverage'), baselineFile: arg(argv, '--baseline'),
      candidateFile: arg(argv, '--candidate'), oracleFile: arg(argv, '--oracle'), assetsDir: arg(argv, '--assets'),
      outFile: arg(argv, '--out'), cwd: arg(argv, '--repo') || process.cwd() });
    console.log(JSON.stringify({ ok: true, planSha256: plan.planSha256, cases: plan.cases.length }));
  } catch (error) {
    console.error(`[retrieval-canary] ${error.message}`);
    process.exitCode = 1;
  }
}
