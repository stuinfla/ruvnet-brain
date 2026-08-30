#!/usr/bin/env node
// Canonical bounded QA runner. Local and CI use the same lanes, command order, timeout policy,
// and machine-readable receipt; a human log is never the release verdict.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const timeoutMs = Number(process.env.QA_TIMEOUT_MS || (release ? 15 * 60_000 : 8 * 60_000));
const lanes = [
  ['version', 'npm', ['run', 'version:check']],
  ['substitution', 'npm', ['run', 'substitution:check']],
  ['catalog', 'npm', ['run', 'catalog:verify']],
  ['contract', 'npx', ['vitest', 'run',
    'tests/unit/brain-off.test.mjs',
    'tests/unit/hook-hardening.test.mjs',
    'tests/unit/hook-battery.test.mjs',
    'tests/unit/session-start-core-parity.test.mjs',
    'tests/unit/lesson-gate.test.mjs',
    'tests/unit/wired-check.test.mjs',
    'tests/unit/no-restated-truth.test.mjs',
    'tests/unit/verify-citation.test.mjs',
    'tests/unit/eval-brain-gate.test.mjs',
    'tests/unit/distill-project.test.mjs',
    'tests/unit/record-lesson.test.mjs',
    'tests/unit/learn-capture-project-root.test.mjs',
    'tests/unit/codex-claude-hook-parity.test.mjs',
    'tests/unit/brain-stamp-resolve-built-from-sha.test.mjs',
    '--reporter=dot']],
  ['mesh', 'npm', ['run', 'test:mesh']],
  ['plugin', 'npm', ['test']],
  ...(release ? [['mutation', 'npm', ['run', 'test:mutation']], ['claims', 'npm', ['run', 'claims:verify']], ['integration', 'npm', ['run', 'test:integration']]] : []),
];
const receiptDir = path.join(root, '.qa');
fs.mkdirSync(receiptDir, { recursive: true });
const started = new Date().toISOString();
const sha = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return null; }
})();
const run = ([name, command, args]) => new Promise((resolve) => {
  const begin = Date.now();
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); }, timeoutMs);
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ name, command: [command, ...args].join(' '), status: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL', exitCode: code, signal, elapsedMs: Date.now() - begin, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000) });
  });
});
const results = [];
for (const lane of lanes) {
  const result = await run(lane);
  results.push(result);
  fs.writeFileSync(path.join(receiptDir, `${result.name}.json`), `${JSON.stringify({ schema: 'ruvnet-brain.qa.lane', sha, ...result }, null, 2)}\n`);
  if (result.status !== 'PASS') break;
}
const receipt = { schema: 'ruvnet-brain.qa.aggregate', contract: release ? 'release' : 'pr', sha, started, ended: new Date().toISOString(), status: results.every((r) => r.status === 'PASS') && results.length === lanes.length ? 'PASS' : 'FAIL', requiredLanes: lanes.map(([name]) => name), results };
fs.writeFileSync(path.join(receiptDir, 'aggregate.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, sha, lanes: results.map(({ name, status, elapsedMs }) => ({ name, status, elapsedMs })) }));
process.exit(receipt.status === 'PASS' ? 0 : 1);
