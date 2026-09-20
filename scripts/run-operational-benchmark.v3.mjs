#!/usr/bin/env node
// v3 validates independently frozen source facts against corpus bytes before running retrieval.
// Missing corpus facts remain explicit CORPUS_GAP outcomes and block qualification.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OPERATIONAL_FIXTURES_V3,
  ORACLE_CATALOG,
  gradeOperationalFixtureV3,
  matchClaimSlots,
  preflightOperationalOracle,
} from '../evals/operational-benchmark.v3.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_KB = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
const { createHash } = await import('node:crypto');
const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashBytes = async (file) => digestBytes(fs.readFileSync(file));
const hashIfPresent = async (file) => fs.existsSync(file) ? hashBytes(file) : null;

async function readCatalog(catalog, catalogFile) {
  if (catalog) return { value: catalog, file: null, sha256: digestBytes(Buffer.from(JSON.stringify(catalog))) };
  const file = path.resolve(ROOT, catalogFile || ORACLE_CATALOG);
  try {
    const bytes = fs.readFileSync(file);
    return { value: JSON.parse(bytes.toString('utf8')), file, sha256: digestBytes(bytes) };
  }
  catch (error) { return { value: null, file, error: error.message }; }
}

export async function runOperationalBenchmarkV3({ fixtures = OPERATIONAL_FIXTURES_V3, kb = DEFAULT_KB,
  catalog = null, catalogFile = ORACLE_CATALOG, timeoutMs = 240_000, runQuery = null,
  verify = null, now = () => new Date().toISOString() } = {}) {
  const reader = path.join(kb, 'forge-ask-all.mjs');
  const verifierPath = path.join(kb, 'verify-citation.mjs');
  if (!fs.existsSync(reader) || !fs.existsSync(verifierPath)) throw new Error(`RuvNet Brain runtime or verifier missing under ${kb}`);
  const loaded = await readCatalog(catalog, catalogFile);
  const catalogSha256AtStart = loaded.sha256 ?? null;
  const verifier = verify || (await import(pathToFileURL(verifierPath).href)).verifyGrounding;
  const preflight = loaded.error
    ? new Map(fixtures.map((fixture) => [fixture.id, { status: 'INVALID_ORACLE', reason: `oracle catalog cannot be read: ${loaded.error}` }]))
    : await preflightOperationalOracle({ fixtures, catalog: loaded.value, catalogPath: loaded.file, kbDir: kb });
  const receipts = [];
  for (const fixture of fixtures) {
    const oracle = preflight.get(fixture.id) || { status: 'INVALID_ORACLE', reason: 'fixture preflight result is missing' };
    if (oracle.status !== 'PASS') {
      const grade = gradeOperationalFixtureV3(fixture, { processOk: true, preflightStatus: oracle.status });
      receipts.push({ fixtureId: fixture.id, class: fixture.class, query: fixture.query, preflight: oracle,
        processOk: false, elapsedMs: null, grade });
      process.stderr.write(`${oracle.status} ${fixture.id} ${oracle.reason}\n`);
      continue;
    }

    const started = performance.now();
    let output = '';
    let stderr = '';
    let error = null;
    let processExitCode = null;
    let processOk = false;
    try {
      const result = runQuery
        ? await runQuery(fixture, { kb, timeoutMs })
        : await execFileAsync(process.execPath, [reader, '--dir', kb, '--q', fixture.query, '--k', '5',
          ...(process.env.EVAL_FULL_CORPUS === '1' ? [] : ['--bounded'])],
        { cwd: kb, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env });
      output = String(result?.stdout ?? '');
      stderr = String(result?.stderr ?? '');
      processOk = result?.code === undefined ? result?.status === undefined || result.status === 0 : result.code === 0;
      processExitCode = result?.code ?? result?.status ?? 0;
      if (!processOk) error = 'retrieval process returned a nonzero status';
    } catch (caught) {
      error = caught?.message ?? String(caught);
      output = String(caught?.stdout ?? '');
      stderr = String(caught?.stderr ?? '');
      processExitCode = Number.isInteger(caught?.code) ? caught.code : null;
    }
    const elapsedMs = Math.round(performance.now() - started);
    const verification = processOk ? await verifier(output, kb) : null;
    const sourceSupport = fixture.class === 'negative' || fixture.class === 'ambiguity'
      ? null : matchClaimSlots(oracle, verification);
    const grade = gradeOperationalFixtureV3(fixture, { output, verification, sourceSupport,
      processOk, preflightStatus: oracle.status });
    receipts.push({ fixtureId: fixture.id, class: fixture.class, query: fixture.query,
      preflight: { status: oracle.status, resolvedSlots: oracle.resolvedSlots?.map((slot) => ({
        id: slot.id, alternatives: slot.alternatives.map(({ repo, path: sourcePath, passageSha256, store, storeSha256 }) =>
          ({ repo, path: sourcePath, passageSha256, store, storeSha256 })),
      })) ?? [] }, elapsedMs, processOk, processExitCode, error, stderr, verification, sourceSupport,
      grade, rawOutput: output });
    process.stderr.write(`${grade.status} ${fixture.id} ${elapsedMs}ms\n`);
  }

  // Close the receipt over the inputs after replay as well as before it. If any pinned corpus
  // bytes or oracle catalog moved mid-run, demote every affected row so a race cannot pass.
  const corpusChanged = loaded.value?.corpus && (
    await hashIfPresent(path.join(kb, 'ARCHIVE-MANIFEST.json')) !== loaded.value.corpus.archiveManifestSha256
    || await hashIfPresent(path.join(kb, 'SOURCE.json')) !== loaded.value.corpus.sourceManifestSha256);
  const oracleChanged = loaded.file && await hashIfPresent(loaded.file) !== catalogSha256AtStart;
  if (corpusChanged || oracleChanged) {
    for (const row of receipts) {
      if (row.preflight?.status !== 'PASS') continue;
      row.preflight = { status: corpusChanged ? 'CORPUS_GAP' : 'INVALID_ORACLE',
        reason: corpusChanged ? 'pinned corpus identity changed during replay' : 'oracle catalog bytes changed during replay' };
      row.grade = { pass: false, status: row.preflight.status, reason: row.preflight.reason };
    }
  }
  const storeIdentities = new Map();
  for (const row of receipts) {
    for (const slot of row.preflight?.resolvedSlots ?? []) {
      for (const alt of slot.alternatives ?? []) storeIdentities.set(alt.store, alt.storeSha256);
    }
  }
  for (const [store, expectedSha256] of storeIdentities) {
    const actual = await hashIfPresent(path.join(kb, store));
    if (actual === expectedSha256) continue;
    for (const row of receipts) {
      const bound = (row.preflight?.resolvedSlots ?? []).some((slot) => slot.alternatives?.some((alt) => alt.store === store));
      if (!bound || row.preflight.status !== 'PASS') continue;
      row.preflight = { status: 'CORPUS_GAP', reason: `source passage store ${store} changed or disappeared during replay` };
      row.grade = { pass: false, status: 'CORPUS_GAP', reason: row.preflight.reason };
    }
  }

  const classes = Object.fromEntries([...new Set(fixtures.map(({ class: fixtureClass }) => fixtureClass))].map((name) => {
    const rows = receipts.filter((row) => row.class === name);
    const measured = rows.filter((row) => row.preflight?.status === 'PASS');
    const latencies = measured.filter((row) => Number.isFinite(row.elapsedMs)).map((row) => row.elapsedMs).sort((a, b) => a - b);
    const percentile = (f) => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * f) - 1)] : null;
    return [name, { pass: measured.filter((row) => row.grade.pass).length, n: measured.length,
      corpusGap: rows.filter((row) => row.preflight?.status === 'CORPUS_GAP').length,
      invalidOracle: rows.filter((row) => row.preflight?.status === 'INVALID_ORACLE').length,
      latency: { n: latencies.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: latencies.at(-1) ?? null } }];
  }));
  const [readerSha256, verifierSha256, archiveManifestSha256, sourceManifestSha256,
    fixtureSha256, oracleCatalogSha256] = await Promise.all([
    hashBytes(reader), hashBytes(verifierPath), hashIfPresent(path.join(kb, 'ARCHIVE-MANIFEST.json')),
    hashIfPresent(path.join(kb, 'SOURCE.json')),
    hashBytes(path.join(ROOT, 'evals/operational-benchmark.v3.mjs')),
    Promise.resolve(catalogSha256AtStart),
  ]);
  const measured = receipts.filter((row) => row.preflight?.status === 'PASS');
  const unavailable = receipts.filter((row) => row.preflight?.status === 'CORPUS_GAP')
    .map(({ fixtureId, preflight: result }) => ({ fixtureId, reason: result.reason }));
  const invalidOracle = receipts.filter((row) => row.preflight?.status === 'INVALID_ORACLE')
    .map(({ fixtureId, preflight: result }) => ({ fixtureId, reason: result.reason }));
  return {
    schema: 'ruvnet-brain-operational-benchmark/v3', generatedAt: now(),
    runtime: { kb: path.resolve(kb), nodeExecutable: process.execPath, nodeVersion: process.version,
      readerSha256, verifierSha256, archiveManifestSha256, sourceManifestSha256,
      fixtureSha256, oracleCatalogSha256 },
    evaluationConfig: { lane: process.env.EVAL_FULL_CORPUS === '1' ? 'full-corpus' : 'bounded',
      k: 5, timeoutMs, sequential: true, preflightBeforeSearch: true },
    claimBoundary: { sourceSupportedRetrieval: 'measured', generatedAnswerUsefulness: 'UNKNOWN; this is a retrieval tool evaluation' },
    classes, passed: measured.filter((row) => row.grade.pass).length,
    measured: measured.length, total: fixtures.length, corpusGaps: unavailable,
    invalidOracles: invalidOracle,
    qualificationPass: measured.length === fixtures.length && invalidOracle.length === 0
      && unavailable.length === 0 && measured.every((row) => row.grade.pass),
    receipts,
  };
}

async function main() {
  const kb = process.env.RUVNET_BRAIN_KB || DEFAULT_KB;
  const report = await runOperationalBenchmarkV3({ fixtures: OPERATIONAL_FIXTURES_V3, kb });
  const outDir = path.join(ROOT, 'evals', 'operational-runs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `v3-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ qualificationPass: report.qualificationPass, measured: report.measured,
    total: report.total, corpusGaps: report.corpusGaps.length, invalidOracles: report.invalidOracles.length,
    classes: report.classes, receipt: out }, null, 2));
  if (!report.qualificationPass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 2; });
}
