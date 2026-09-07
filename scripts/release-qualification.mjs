#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './coverage-integrity.mjs';
import { sourceIdentity } from './qa-contract.mjs';
import { RELEASE_REQUIREMENTS } from './release-qualification-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];

export function qualificationPlan(suite = 'source') {
  const requirements = RELEASE_REQUIREMENTS[suite];
  if (!requirements?.length) throw new Error('unknown qualification suite');
  const files = requirements.flatMap((entry) => entry.files);
  if (new Set(files).size !== files.length || files.some((file) => !file.startsWith('tests/')
    || !file.endsWith('.test.mjs') || file.includes('..'))) throw new Error('invalid qualification inventory');
  return { requirements, files, contractSha256: digest(requirements) };
}

export function assessTestReport(report, files, root = ROOT, platform = PLATFORM) {
  if (!['linux', 'macos', 'windows'].includes(platform)) throw new Error('invalid test report platform');
  const paths = platform === 'windows' ? path.win32 : path.posix;
  if (typeof root !== 'string' || !paths.isAbsolute(root)) throw new Error('test report checkout root must be absolute');
  const results = report?.testResults;
  if (!Array.isArray(results) || results.length !== files.length) throw new Error('test report file inventory differs');
  const expected = new Set(files.map((file) => paths.resolve(root, file)));
  if (results.some(file => typeof file.name !== 'string' || !paths.isAbsolute(file.name))) throw new Error('test report file inventory requires absolute names');
  const names = results.map((file) => paths.resolve(file.name));
  if (new Set(names).size !== files.length || names.some((name) => !expected.has(name))) {
    throw new Error('test report contains missing, duplicate, or unexpected files');
  }
  const cases = results.flatMap((file) => file.assertionResults || []);
  if (!cases.length || results.some((file) => file.status !== 'passed' || !file.assertionResults?.length)
    || cases.some((test) => test.status !== 'passed') || report.success !== true
    || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0
    || report.numPendingTests !== 0 || (report.numTodoTests || 0) !== 0
    || report.numTotalTests !== cases.length || report.numPassedTests !== cases.length) {
    throw new Error('reviewed release cases did not all execute and pass');
  }
  return { total: cases.length, passed: cases.length, failed: 0, skipped: 0 };
}

export function validateQualificationReceipt(report, { suite, platform, sourceSha }) {
  const plan = qualificationPlan(suite);
  const { receiptSha256, ...payload } = report || {};
  if (report?.schemaVersion !== 1 || report.kind !== 'ruvnet-brain-release-qualification'
    || report.suite !== suite || report.platform !== platform || report.status !== 'PASS'
    || digest(payload) !== receiptSha256 || report.contractSha256 !== plan.contractSha256
    || digest(report.files) !== digest(plan.files)
    || digest(report.requirements) !== digest(plan.requirements.map(row => row.id))) {
    throw new Error('qualification receipt identity, digest, or reviewed contract differs');
  }
  if (!/^[a-f0-9]{40}$/.test(String(sourceSha)) || report.source?.sha !== sourceSha
    || report.sourceAfter?.sha !== sourceSha || report.source.dirty !== false || report.sourceAfter.dirty !== false
    || !/^[a-f0-9]{64}$/.test(report.source.digest || '') || report.source.digest !== report.sourceAfter.digest
    || report.sourceStable !== true) throw new Error('qualification source is not clean and unchanged');
  if (!Array.isArray(report.results) || !report.results.length
    || report.results.some(row => row.status !== 'PASS' || row.exitCode !== 0)) {
    throw new Error('qualification command did not complete successfully');
  }
  if (typeof report.checkoutRoot !== 'string' || !report.checkoutRoot) throw new Error('qualification checkout root is missing');
  const tests = assessTestReport(report.testReport, plan.files, report.checkoutRoot, platform);
  if (digest(tests) !== digest(report.tests)) throw new Error('qualification test summary differs from executed cases');
  return tests;
}

export function runQualification({ suite = 'source', platform = PLATFORM, report: output, root = ROOT } = {}) {
  if (platform !== PLATFORM) throw new Error(`cannot produce ${platform} evidence on ${PLATFORM}`);
  if (!output || fs.existsSync(output)) throw new Error('a new --report path is required');
  const plan = qualificationPlan(suite);
  for (const file of plan.files) if (!fs.statSync(path.resolve(root, file)).isFile()) throw new Error(`missing test ${file}`);
  const source = sourceIdentity(root);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-qualification-'));
  const results = [];
  let testReport = null;
  let tests = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const execute = (name, args) => {
    const run = spawnSync(process.execPath, ['scripts/ci/step-watchdog.mjs', '--name', name,
      '--timeout-ms', '900000', '--receipt-dir', temp, '--', process.execPath, ...args],
    { cwd: root, env: { ...process.env, ...(suite === 'integration' ? { RUVNET_REQUIRE_CODEX_DISCOVERY: '1' } : {}) },
      stdio: 'inherit' });
    const ok = !run.error && run.status === 0;
    results.push({ name, status: ok ? 'PASS' : 'FAIL', exitCode: run.status });
    if (!ok) throw new Error(`${name} failed`);
  };
  let failure = null;
  try {
    if (suite === 'source') {
      execute('release-version', ['scripts/sync-version.mjs', '--check']);
      execute('release-source-identity', ['scripts/convergence-manifest.mjs']);
      execute('automatic-hook-retirement', ['scripts/hook-retirement-check.mjs']);
    }
    const testPath = path.join(temp, 'tests.json');
    execute(`release-${suite}-${platform}`, ['node_modules/vitest/vitest.mjs', 'run', ...plan.files,
      '--reporter=json', '--outputFile', testPath, '--maxWorkers=1']);
    testReport = JSON.parse(fs.readFileSync(testPath, 'utf8'));
    tests = assessTestReport(testReport, plan.files, root);
  } catch (error) {
    failure = error.message;
    const testPath = path.join(temp, 'tests.json');
    if (fs.existsSync(testPath)) {
      try {
        testReport = JSON.parse(fs.readFileSync(testPath, 'utf8'));
        tests = { total: testReport.numTotalTests || 0, passed: testReport.numPassedTests || 0,
          failed: testReport.numFailedTests || 0,
          skipped: (testReport.numPendingTests || 0) + (testReport.numTodoTests || 0) };
      } catch { /* failed report remains a failure */ }
    }
  }
  const sourceAfter = sourceIdentity(root);
  const sourceStable = source.digest === sourceAfter.digest;
  const receipt = { schemaVersion: 1, kind: 'ruvnet-brain-release-qualification', suite, platform, checkoutRoot: path.resolve(root),
    source, sourceAfter, sourceStable, status: !failure && sourceStable ? 'PASS' : 'FAIL',
    requirements: plan.requirements.map((entry) => entry.id), contractSha256: plan.contractSha256,
    files: plan.files, tests, testReport, results, failure, observedAt: new Date().toISOString() };
  receipt.receiptSha256 = digest(receipt);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.rmSync(temp, { recursive: true, force: true });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
  try {
    const receipt = runQualification({ suite: value('--suite', 'source'), platform: value('--platform', PLATFORM),
      report: value('--report') });
    console.log(JSON.stringify({ status: receipt.status, tests: receipt.tests, receiptSha256: receipt.receiptSha256 }));
    process.exitCode = receipt.status === 'PASS' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
