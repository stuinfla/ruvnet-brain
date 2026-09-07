#!/usr/bin/env node
// Run one CI operation with an explicit wall-clock budget and visible progress.
// GitHub Actions has job timeouts, but no per-step timeout. This wrapper makes a
// stalled operation fail locally at its named boundary and leaves a receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const separator = argv.indexOf('--');
const command = separator >= 0 ? argv.slice(separator + 1) : [];
const name = value('--name', command[0] || 'ci-step');
const timeoutMs = Number(value('--timeout-ms', '600000'));
const heartbeatMs = Number(value('--heartbeat-ms', '30000'));
const receiptDir = value('--receipt-dir', process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'step-receipts') : path.join(os.tmpdir(), 'ruvnet-brain-step-receipts'));

if (!command.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
  console.error('usage: node step-watchdog.mjs --name <name> --timeout-ms <ms> [--heartbeat-ms <ms>] [--receipt-dir <dir>] -- <command> [args...]');
  process.exit(2);
}

fs.mkdirSync(receiptDir, { recursive: true });
const startedAt = new Date().toISOString();
const started = Date.now();
const receiptPath = path.join(receiptDir, `${name}.json`);
const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  shell: false,
  detached: process.platform !== 'win32',
});
let timedOut = false;
let heartbeat;
const writeReceipt = (status, exitCode = null, signal = null) => {
  const receipt = {
    schema: 'ruvnet-brain.ci.step-receipt',
    name,
    command,
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    timeoutMs,
    status,
    exitCode,
    signal,
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
};

console.log(`[watchdog] START ${name} budget=${timeoutMs}ms command=${command.join(' ')}`);
heartbeat = setInterval(() => {
  console.log(`[watchdog] HEARTBEAT ${name} elapsed=${Date.now() - started}ms budget=${timeoutMs}ms`);
}, heartbeatMs);
const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`[watchdog] TIMEOUT ${name} after ${timeoutMs}ms; terminating process`);
  if (process.platform === 'win32') child.kill('SIGTERM');
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => {
    if (!child.killed) {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }, 2000).unref();
}, timeoutMs);

child.on('error', (error) => {
  clearTimeout(timeout); clearInterval(heartbeat);
  writeReceipt('ERROR', null, error.code || error.name);
  console.error(`[watchdog] ERROR ${name}: ${error.message}`);
  process.exit(1);
});
child.on('close', (code, signal) => {
  clearTimeout(timeout); clearInterval(heartbeat);
  const status = timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL';
  const receipt = writeReceipt(status, code, signal);
  console.log(`[watchdog] ${status} ${name} elapsed=${receipt.elapsedMs}ms receipt=${receiptPath}`);
  process.exit(status === 'PASS' ? 0 : 1);
});
