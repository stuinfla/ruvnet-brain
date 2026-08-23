#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RECEIPT_VERSION = 1;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vitestBin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FORBIDDEN_SPEND_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];

const vitest = (files, timeoutMs = 180_000) => ({
  kind: 'vitest', command: process.execPath, args: [vitestBin, 'run', ...files], timeoutMs,
});

// Deterministic slices only. Agentic-QE's grounded quality-gate contract names correctness,
// safety, reliability, test adequacy, parity, performance, distribution, and release evidence.
// The fleet is intentionally not invoked here: it is an on-demand generator, never release proof.
const LANES = Object.freeze({
  // Fail design/provenance issues before any long behavioral or platform lane starts.
  preflight: [
    { kind: 'command', command: process.execPath, args: ['--check', 'scripts/qe/agentic-qe-4.3.mjs'], timeoutMs: 10_000 },
    { kind: 'command', command: process.execPath, args: ['--check', 'scripts/qe/aggregate-4.3.mjs'], timeoutMs: 10_000 },
    { kind: 'command', command: npm, args: ['run', 'version:check'], timeoutMs: 60_000 },
    vitest(['tests/qe/gpt56/critical-risk-map.test.mjs'], 60_000),
  ],
  check: [
    vitest([
      'tests/qe/gpt56/critical-risk-map.test.mjs',
      'tests/unit/npm-tarball-codex.test.mjs',
      'tests/unit/codex-lifecycle-hooks.test.mjs',
      'tests/unit/codex-console-invocation.test.mjs',
      'tests/unit/console-advocacy-dial.test.mjs',
      'tests/unit/console-advocacy-precision.test.mjs',
      'tests/unit/mcp-timeout-outage.test.mjs',
    ]),
  ],
  integration: [
    vitest(['tests/integration/hook-conformance-both-hosts.test.mjs'], 120_000),
    vitest(['tests/integration/managed-cli-mcp.test.mjs'], 180_000),
  ],
  release: [
    vitest([
      'tests/qe/release/packed-clean-install.test.mjs',
      'tests/qe/release/release-publish-contract.test.mjs',
      'tests/qe/release/stable-spine-recovery.test.mjs',
      'tests/qe/security/release-abuse-cases.test.mjs',
    ], 240_000),
  ],
  resources: [
    vitest([
      'tests/qe/gpt56/worker-concurrency-retirement.test.mjs',
      'tests/unit/mcp-timeout-outage.test.mjs',
    ], 180_000),
  ],
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};

function enforceZeroSpend() {
  const exposed = FORBIDDEN_SPEND_KEYS.filter((key) => process.env[key]);
  if (exposed.length || process.env.RUVNET_ALLOW_METERED_SPEND === '1') {
    throw new Error(`refusing QE: metered API credentials exposed (${exposed.join(', ') || 'override'})`);
  }
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function outputDir() {
  const dir = path.resolve(ROOT, process.env.QE_RECEIPT_DIR || '.qe/receipts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runStep(step, index, dir) {
  const startedAt = now();
  const report = path.join(dir, `vitest-${index}.json`);
  const args = step.kind === 'vitest'
    ? [...step.args, '--reporter=json', `--outputFile=${report}`]
    : step.args;
  const result = spawnSync(step.command, args, {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
    timeout: step.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const stepReceipt = {
    index,
    command: [step.command, ...args].join(' '),
    startedAt,
    endedAt: now(),
    exitCode: result.status,
    spawnError: result.error?.message || null,
    timedOut: Boolean(result.error?.code === 'ETIMEDOUT'),
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  if (step.kind === 'vitest') {
    try {
      const json = JSON.parse(fs.readFileSync(report, 'utf8'));
      stepReceipt.tests = {
        total: json.numTotalTests ?? 0,
        passed: json.numPassedTests ?? 0,
        failed: json.numFailedTests ?? 0,
        skipped: json.numPendingTests ?? 0,
        suitesFailed: json.numFailedTestSuites ?? 0,
      };
      stepReceipt.failedTests = (json.testResults || []).flatMap((suite) =>
        (suite.assertionResults || [])
          .filter((test) => test.status === 'failed')
          .map((test) => ({ file: suite.name, name: test.fullName })));
      stepReceipt.skippedTests = (json.testResults || []).flatMap((suite) =>
        (suite.assertionResults || [])
          .filter((test) => test.status === 'pending' || test.status === 'skipped')
          .map((test) => ({ file: suite.name, name: test.fullName })));
      stepReceipt.suiteErrors = (json.testResults || [])
        .filter((suite) => suite.status === 'failed' || suite.message)
        .map((suite) => ({ file: suite.name, message: suite.message || 'suite failed' }));
    } catch (error) { stepReceipt.reportError = error.message; }
  }
  stepReceipt.status = result.error || result.status !== 0 ? 'FAIL' : 'PASS';
  if (stepReceipt.tests && (stepReceipt.tests.total === 0 || stepReceipt.tests.skipped > 0)) {
    stepReceipt.status = 'UNKNOWN';
  }
  return stepReceipt;
}

function main() {
  enforceZeroSpend();
  const requestedLane = arg('--lane');
  const lane = requestedLane === 'windows-unit' ? 'check' : requestedLane;
  if (!requestedLane || !LANES[lane]) throw new Error(`unknown lane: ${requestedLane || '<missing>'}`);
  const dir = outputDir();
  fs.rmSync(path.join(dir, `${requestedLane}.json`), { force: true });
  const runDir = path.join(dir, `.run-${requestedLane}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const steps = LANES[lane].map((step, index) => runStep(step, index, runDir));
  const status = steps.every((step) => step.status === 'PASS') ? 'PASS' : 'FAIL';
  const receipt = {
    schema: 'ruvnet-brain.agentic-qe.receipt', receiptVersion: RECEIPT_VERSION,
    contract: 'agentic-qe-4.3', lane: requestedLane, sha: gitSha(),
    runId: process.env.GITHUB_RUN_ID || `local-${gitSha()}`, host: `${os.platform()}-${os.arch()}`,
    startedAt: steps[0]?.startedAt || now(), endedAt: steps.at(-1)?.endedAt || now(), status, steps,
  };
  const file = path.join(dir, `${requestedLane}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log(JSON.stringify({
    lane: requestedLane, status, receipt: file, sha: receipt.sha,
    failedTests: steps.flatMap((step) => step.failedTests || []),
  }));
  process.exitCode = status === 'PASS' ? 0 : 1;
}

try { main(); } catch (error) {
  console.error(`agentic-qe-4.3: ${error.message}`);
  process.exitCode = 2;
}
