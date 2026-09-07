#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qaLanes, selectLanes } from './qa-lanes.mjs';
import { runLanes, verdictOf, sourceIdentity } from './qa-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const argument = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const requested = process.argv.flatMap((value, index) => value === '--lane' ? [process.argv[index + 1]] : []);
const runtimeCensusArgs = ['--candidate-kb', '--candidate-sha', '--candidate-version', '--candidate-root',
  '--payload-manifest', '--payload-signature', '--payload-id', '--qualification-mode'].flatMap((name) => {
  if (!process.argv.includes(name)) return [];
  const value = argument(name);
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return [name, value];
});
const lanes = selectLanes(qaLanes({ release, runtimeCensusArgs, base: argument('--base') || process.env.QA_BASE_SHA }), requested);
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(lanes, null, 2));
} else {
  const timeoutMs = Number(process.env.QA_TIMEOUT_MS || (release ? 15 * 60_000 : 8 * 60_000));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid QA timeout');
  const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-qa-'));
  const started = new Date().toISOString();
  const source = sourceIdentity(root);
  const run = (lane) => new Promise((resolve) => {
    const begin = Date.now();
    const evidenceFile = lane.report ? path.join(receiptDir, lane.name + '-evidence.json') : null;
    const args = evidenceFile ? [...lane.args, '--report', evidenceFile] : lane.args;
    const child = spawn(lane.command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, spawnError = null, escalation = null;
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); process.stderr.write(chunk); });
    child.on('error', (error) => { spawnError = error.message; });
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') spawnError = error.message; }
    };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 2000); escalation.unref(); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({ name: lane.name, command: [lane.command, ...args], evidenceFile, status: timedOut ? 'TIMEOUT' : spawnError ? 'FAIL' : code === 0 ? 'PASS' : code === 4 ? 'UNKNOWN' : 'FAIL', exitCode: code, signal, spawnError, elapsedMs: Date.now() - begin, stdoutTail: stdout, stderrTail: stderr });
    });
  });
  const results = await runLanes(lanes, run, 2);
  const after = sourceIdentity(root);
  const stable = after.digest === source.digest;
  const status = stable ? verdictOf(results) : 'UNKNOWN';
  const receipt = { schema: 'ruvnet-brain.qa.aggregate', contract: release ? 'release' : 'pr', selection: requested.length ? 'partial' : 'complete', source, sourceAfter: after, sourceStable: stable, started, ended: new Date().toISOString(), status, requiredLanes: lanes.map(({ name }) => name), results };
  for (const result of results) fs.writeFileSync(path.join(receiptDir, result.name + '.json'), JSON.stringify({ schema: 'ruvnet-brain.qa.lane', source, ...result }, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(receiptDir, 'aggregate.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status, receiptDir, source, sourceStable: stable, lanes: results.map(({ name, status }) => ({ name, status })) }));
  process.exitCode = status === 'PASS' ? 0 : status === 'UNKNOWN' ? 4 : 1;
}
