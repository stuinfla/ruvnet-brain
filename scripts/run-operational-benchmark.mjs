#!/usr/bin/env node
// Source-span operational benchmark. Each receipt preserves the exact query, raw customer-path
// output, citation resolution, oracle match, and latency. It never edits historical eval baselines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OPERATIONAL_FIXTURES,
  gradeOperationalFixture,
  latencyDistribution,
  verifyFixtureSourceSupport,
} from '../evals/operational-benchmark.v1.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');

export async function runOperationalBenchmark({ fixtures = OPERATIONAL_FIXTURES, kb = KB, timeoutMs = 240_000 } = {}) {
  const reader = path.join(kb, 'forge-ask-all.mjs');
  const verifierPath = path.join(kb, 'verify-citation.mjs');
  if (!fs.existsSync(reader) || !fs.existsSync(verifierPath)) throw new Error(`RuvNet Brain runtime or verifier missing under ${kb}`);
  const { verifyGrounding } = await import(pathToFileURL(verifierPath).href);
  const oracleFiles = new Map();
  for (const fixture of fixtures) {
    if (!fixture.expectedFact) continue;
    const oracleFile = path.join(ROOT, fixture.oraclePath || 'kb/capability-cards.md');
    if (!fs.existsSync(oracleFile)) throw new Error(`Operational source oracle missing for ${fixture.id}: ${oracleFile}`);
    oracleFiles.set(oracleFile, true);
    const oracleText = fs.readFileSync(oracleFile, 'utf8');
    const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();
    if (fixture.expectedFact && !normalize(oracleText).includes(normalize(fixture.expectedFact))) {
      throw new Error(`Source oracle drift for ${fixture.id}: expected fact is absent from ${oracleFile}`);
    }
  }
  const receipts = [];
  for (const fixture of fixtures) {
    if (fixture.availability) {
      receipts.push({ fixtureId: fixture.id, class: fixture.class, query: fixture.query, availability: fixture.availability, grade: { pass: false, reason: 'fixture-not-measurable-with-available-source-oracle' } });
      process.stderr.write(`UNAVAILABLE ${fixture.id} ${fixture.availability}\n`);
      continue;
    }
    const started = performance.now();
    let output = '';
    let stderr = '';
    let error = null;
    let processOk = false;
    let processExitCode = null;
    try {
      const args = [reader, '--dir', kb, '--q', fixture.query, '--k', '5'];
      if (process.env.EVAL_FULL_CORPUS !== '1') args.push('--bounded');
      const result = await execFileAsync(process.execPath, args, { cwd: kb, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env });
      output = String(result.stdout ?? '');
      stderr = String(result.stderr ?? '');
      processOk = true;
      processExitCode = 0;
    } catch (caught) {
      error = caught?.message ?? String(caught);
      output = String(caught?.stdout ?? '');
      stderr = String(caught?.stderr ?? '');
      processExitCode = Number.isInteger(caught?.code) ? caught.code : null;
    }
    const elapsedMs = Math.round(performance.now() - started);
    const verification = await verifyGrounding(output, kb);
    const sourceSupport = processOk ? await verifyFixtureSourceSupport(fixture, verification, kb) : null;
    const grade = gradeOperationalFixture(fixture, { output, verification, sourceSupport, processOk });
    receipts.push({
      fixtureId: fixture.id,
      class: fixture.class,
      query: fixture.query,
      expectedRepos: fixture.expectedRepos,
      expectedFact: fixture.expectedFact,
      elapsedMs,
      processOk,
      processExitCode,
      error,
      stderr,
      verification,
      sourceSupport,
      grade,
      rawOutput: output,
    });
    process.stderr.write(`${grade.pass ? 'PASS' : 'FAIL'} ${fixture.id} ${elapsedMs}ms\n`);
  }
  const classes = Object.fromEntries([...new Set(fixtures.map((fixture) => fixture.class))].map((name) => [
    name,
    {
      pass: receipts.filter((row) => row.class === name && !row.availability && row.grade.pass).length,
      n: receipts.filter((row) => row.class === name && !row.availability).length,
      unavailable: receipts.filter((row) => row.class === name && row.availability).length,
      latency: latencyDistribution(receipts.filter((row) => row.class === name && !row.availability).map((row) => row.elapsedMs)),
    },
  ]));
  return {
    schema: 'ruvnet-brain-operational-benchmark/v1',
    generatedAt: new Date().toISOString(),
    runtime: {
      kb: path.resolve(kb),
      nodeExecutable: process.execPath,
      nodeVersion: process.version,
      readerSha256: await hashFile(reader),
      verifierSha256: await hashFile(verifierPath),
      fixtureSha256: await hashFile(path.join(ROOT, 'evals', 'operational-benchmark.v1.mjs')),
      oracleSha256: Object.fromEntries(await Promise.all([...oracleFiles.keys()].map(async (file) => [path.relative(ROOT, file), await hashFile(file)]))),
      sourceManifestSha256: await hashExistingFiles(kb, ['SOURCE.json', 'RVF-GENERATIONS.json', 'PUBLIC-RVF-GENERATIONS.json']),
    },
    evaluationConfig: { lane: process.env.EVAL_FULL_CORPUS === '1' ? 'full-corpus' : 'bounded', k: 5, timeoutMs, sequential: true },
    identityScope: 'Entry-point, verifier, checked manifests, capability-card oracle, and each evidence-bearing passage store are SHA-256 bound. This is not a signed release archive or a hash of every transitive package/model input.',
    claimBoundary: { sourceSupportedRetrievalUtility: 'measured', generatedAnswerUsefulness: 'UNKNOWN; this retrieval tool does not provide a generated answer to grade' },
    classes,
    passed: receipts.filter((row) => row.grade.pass).length,
    total: receipts.filter((row) => !row.availability).length,
    unavailable: receipts.filter((row) => row.availability).map(({ fixtureId, availability }) => ({ fixtureId, availability })),
    receipts,
  };
}

async function hashFile(file) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function hashExistingFiles(dir, names) {
  const result = {};
  for (const name of names) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) result[name] = await hashFile(file);
  }
  return result;
}

async function main() {
  const classIndex = process.argv.indexOf('--class');
  const selectedClass = classIndex >= 0 ? process.argv[classIndex + 1] : null;
  const fixtures = selectedClass ? OPERATIONAL_FIXTURES.filter((fixture) => fixture.class === selectedClass) : OPERATIONAL_FIXTURES;
  if (!fixtures.length) throw new Error(`No operational fixtures for class ${selectedClass}`);
  const report = await runOperationalBenchmark({ fixtures });
  const outDir = path.join(ROOT, 'evals', 'operational-runs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ pass: report.passed === report.total, passed: report.passed, total: report.total, classes: report.classes, receipt: out }, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 2; });
}
