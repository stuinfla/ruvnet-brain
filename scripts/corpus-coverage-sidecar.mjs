#!/usr/bin/env node
// scripts/corpus-coverage-sidecar.mjs — ADR-0091 D6.2: a corpus generation publishes its own sealed
// coverage, as two small release assets beside the archive, WITHOUT bumping the schema-3 receipt.
//
// Why a sidecar and not a receipt field: three readers require receipt schema 3 exactly
// (corpus-next-seed.mjs, release.mjs, corpus-candidate.mjs), and ADR-0091 D3 runs OLDER readers on the
// nightly, so a schema bump breaks the nightly in one direction or the other. New readers use the
// sidecar; old readers never look at it.
//
// Why it is needed at all (found while implementing D5): a corpus archive carries NO coverage file,
// and the receipt binds none, so nothing downstream of preparation could tell a degraded generation
// (carried / missing stores) from a fully current one. The coverage lived only in a 14-day workflow
// artifact. D6's code-release path needs the generation's sealed coverage to assemble single-pass,
// the publisher (release.mjs) binds it to the receipt and names a degraded generation's stores from it,
// and the watchdog's 7-day carry rule and corpus-next-seed's code-release refusal of a degraded seed
// both read it. (The former ADR-0091 D10 soak gate also read it; that gate was removed 2026-10-17.)
//
//   CORPUS-COVERAGE.json  -- the sealed ruvnet-brain-corpus-coverage ledger, exact bytes.
//   coverage-receipt.json -- { generationTag, archiveSha256, archiveBytes, coverageSha256, ... }.
//
// A reader NEVER trusts the sidecar's own `degraded` summary: verifyCoverageSidecar recomputes it
// from the coverage bytes the sidecar binds.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eligibleRepositoryStanding, validateCoverageLedger } from '../plugin/scripts/coverage-integrity.mjs';

export const COVERAGE_ASSET = 'CORPUS-COVERAGE.json';
export const COVERAGE_RECEIPT_ASSET = 'coverage-receipt.json';
export const COVERAGE_RECEIPT_KIND = 'ruvnet-brain-corpus-coverage-receipt';
const CORPUS_TAG = /^corpus-sha256-([0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`[corpus-coverage-sidecar] ${message}`);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const lower = (value) => String(value || '').toLowerCase();

function parseCoverage(bytes) {
  let coverage;
  try { coverage = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch (error) { fail(`coverage is unreadable (${error.message})`); }
  const checked = validateCoverageLedger(coverage);
  if (coverage?.kind !== 'ruvnet-brain-corpus-coverage' || !checked.valid) {
    fail(`coverage is not a valid sealed ruvnet-brain-corpus-coverage ledger (${checked.failures.join('; ') || coverage?.kind})`);
  }
  return coverage;
}

/**
 * Every eligible row, classified by the SAME predicate the installed validator uses. Anything that is
 * neither shipped nor a recorded absence is a blocker: such a coverage cannot describe a publishable
 * generation at all.
 */
export function coverageStanding(coverage) {
  const carried = [];
  const missing = [];
  const blockers = [];
  const shipped = [];
  for (const row of coverage.rows.filter((entry) => entry.disposition === 'eligible')) {
    const store = lower(row.artifact?.store);
    const standing = row.kind === 'repository' ? eligibleRepositoryStanding(row)
      : row.status === 'CURRENT' && row.carry === undefined && row.failure === undefined ? 'shipped' : null;
    if (standing === null) blockers.push(`${row.key}:${row.status}`);
    else if (standing === 'absent') missing.push(store);
    else {
      if (row.carry) carried.push(store);
      shipped.push({ row, store });
    }
  }
  const sorted = (values) => [...new Set(values)].sort();
  return { carried: sorted(carried), missing: sorted(missing), blockers, shipped };
}

/**
 * The coverage describes THIS archive, not merely "a" corpus: every shipped eligible row's measured
 * RVF digest (and, for a repository, its source generation) must be exactly what the schema-3
 * receipt binds for that store, and the receipt's repository stores must be exactly the shipped
 * repository rows -- no store the coverage does not account for, none it claims that is absent.
 */
export function bindCoverageToReceipt({ coverage, receipt }) {
  const standing = coverageStanding(coverage);
  if (standing.blockers.length) {
    fail(`coverage has ${standing.blockers.length} eligible row(s) that are neither shipped nor a recorded absence `
      + `(${standing.blockers.slice(0, 5).join(', ')})`);
  }
  const stores = new Map((Array.isArray(receipt?.stores) ? receipt.stores : []).map((store) => [lower(store?.name), store]));
  for (const { row, store } of standing.shipped) {
    const bound = stores.get(store);
    if (!bound) fail(`coverage row ${row.key} names store ${store}, which the receipt does not bind`);
    const rvf = (bound.files || []).find((file) => lower(file?.file) === `${store}.big.rvf`);
    if (!rvf || lower(rvf.sha256) !== lower(row.artifact?.rvfSha256)) {
      fail(`coverage row ${row.key} was measured against different ${store} RVF bytes than the receipt binds`);
    }
    if (row.kind === 'repository' && lower(bound.sourceCommit) !== lower(row.artifact?.sourceCommit)) {
      fail(`coverage row ${row.key} records a different ${store} source generation than the receipt`);
    }
  }
  const shippedRepositories = new Set(standing.shipped.filter(({ row }) => row.kind === 'repository').map(({ store }) => store));
  const receiptRepositories = [...stores.values()].filter((store) => store?.kind === 'repository').map((store) => lower(store.name));
  const unaccounted = receiptRepositories.filter((store) => !shippedRepositories.has(store)).sort();
  if (unaccounted.length) fail(`receipt binds repository store(s) the coverage does not ship: ${unaccounted.join(', ')}`);
  const shippedAbsent = standing.missing.filter((store) => stores.has(store));
  if (shippedAbsent.length) fail(`coverage records store(s) as MISSING that the receipt ships: ${shippedAbsent.join(', ')}`);
  return { carried: standing.carried, missing: standing.missing };
}

export function createCoverageReceipt({ generationTag, archiveSha256, archiveBytes, coverageBytes }) {
  const digestMatch = CORPUS_TAG.exec(String(generationTag || ''));
  if (!digestMatch || digestMatch[1] !== archiveSha256) fail('generation tag must be corpus-sha256-<the archive sha256>');
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1) fail('archive byte length is malformed');
  const coverage = parseCoverage(coverageBytes);
  const { carried, missing } = coverageStanding(coverage);
  return {
    schemaVersion: 1,
    kind: COVERAGE_RECEIPT_KIND,
    generationTag,
    archiveSha256,
    archiveBytes,
    coverageFile: COVERAGE_ASSET,
    coverageSha256: sha256(coverageBytes),
    coverageBytes: Buffer.byteLength(coverageBytes),
    coverageGeneration: coverage.coverageGeneration,
    degraded: { carried, missing },
  };
}

/**
 * The reader. Verifies the sidecar names THIS generation and THESE coverage bytes, re-validates the
 * coverage ledger, and recomputes the degraded summary rather than trusting the sidecar's copy.
 */
export function verifyCoverageSidecar({ sidecar, coverageBytes, generationTag, archiveSha256, archiveBytes = null }) {
  const keys = ['archiveBytes', 'archiveSha256', 'coverageBytes', 'coverageFile', 'coverageGeneration', 'coverageSha256',
    'degraded', 'generationTag', 'kind', 'schemaVersion'];
  if (!sidecar || typeof sidecar !== 'object' || JSON.stringify(Object.keys(sidecar).sort()) !== JSON.stringify(keys)
    || sidecar.schemaVersion !== 1 || sidecar.kind !== COVERAGE_RECEIPT_KIND) fail('coverage receipt shape is not recognized');
  if (sidecar.generationTag !== generationTag || !HEX64.test(String(archiveSha256 || '')) || sidecar.archiveSha256 !== archiveSha256
    || (archiveBytes !== null && sidecar.archiveBytes !== archiveBytes)) {
    fail(`coverage receipt names ${sidecar.generationTag}/${sidecar.archiveSha256}, not ${generationTag}/${archiveSha256}`);
  }
  if (sidecar.coverageFile !== COVERAGE_ASSET || sidecar.coverageSha256 !== sha256(coverageBytes)
    || sidecar.coverageBytes !== Buffer.byteLength(coverageBytes)) {
    fail('coverage bytes are not the ones the coverage receipt binds');
  }
  const coverage = parseCoverage(coverageBytes);
  if (sidecar.coverageGeneration !== coverage.coverageGeneration) fail('coverage receipt names another coverage generation');
  const { carried, missing, blockers } = coverageStanding(coverage);
  if (blockers.length) fail(`coverage has eligible row(s) that are neither shipped nor a recorded absence (${blockers.slice(0, 5).join(', ')})`);
  if (JSON.stringify(sidecar.degraded) !== JSON.stringify({ carried, missing })) {
    fail('coverage receipt\'s degraded summary disagrees with the coverage it binds');
  }
  return { coverage, degraded: { carried, missing } };
}

/** Writes the two assets into `dir` (a fresh directory the publisher owns), returning their paths. */
export function writeCoverageAssets({ dir, coverageFile, generationTag, archiveSha256, archiveBytes }) {
  const coverageBytes = fs.readFileSync(coverageFile);
  const receipt = createCoverageReceipt({ generationTag, archiveSha256, archiveBytes, coverageBytes });
  fs.mkdirSync(dir, { recursive: true });
  const coverageOut = path.join(dir, COVERAGE_ASSET);
  const receiptOut = path.join(dir, COVERAGE_RECEIPT_ASSET);
  fs.writeFileSync(coverageOut, coverageBytes, { flag: 'wx' });
  fs.writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return { coverageFile: coverageOut, receiptFile: receiptOut, receipt };
}

const arg = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

// CLI: `--verify --sidecar <f> --coverage <f> --tag <t> --archive-sha256 <h> [--archive-bytes <n>]`
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!argv.includes('--verify')) { stderr.write('usage: corpus-coverage-sidecar.mjs --verify ...\n'); return 2; }
  try {
    const bytes = arg(argv, '--archive-bytes');
    const result = verifyCoverageSidecar({
      sidecar: JSON.parse(fs.readFileSync(arg(argv, '--sidecar'), 'utf8')),
      coverageBytes: fs.readFileSync(arg(argv, '--coverage')),
      generationTag: arg(argv, '--tag'),
      archiveSha256: arg(argv, '--archive-sha256'),
      archiveBytes: bytes === undefined ? null : Number(bytes),
    });
    stdout.write(`${JSON.stringify({ ok: true, coverageGeneration: result.coverage.coverageGeneration, degraded: result.degraded })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main();
