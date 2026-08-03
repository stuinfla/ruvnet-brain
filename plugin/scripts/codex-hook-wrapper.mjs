#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const brainHome = process.env.RUVNET_BRAIN_HOME
  || path.join(path.dirname(codexHome), '.cache', 'ruvnet-brain');
const versions = path.join(brainHome, 'versions');
const blockingHooks = new Set([
  'route-dispatch',
  'ground-before-write',
  'protect-state',
  'design-wall',
  'unprompted-speech',
]);

function timeoutFor(hookId) {
  const override = Number(process.env.RUVNET_CODEX_HOOK_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  if (hookId === 'learn-flush') return 2_250;
  if (hookId === 'ground-ruvnet' || hookId === 'unprompted-speech' || hookId === 'continuation-gate') {
    return 8_500;
  }
  return 4_000;
}

function activeRoot() {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(brainHome, 'active.json'), 'utf8'));
    if (!active || typeof active.codeRoot !== 'string') return null;
    const candidate = path.isAbsolute(active.codeRoot)
      ? active.codeRoot
      : path.join(brainHome, active.codeRoot);
    const real = fs.realpathSync(candidate);
    const versionsReal = fs.realpathSync(versions);
    return real.startsWith(`${versionsReal}${path.sep}`) ? real : null;
  } catch {
    return null;
  }
}

function readHookInput(limit = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let idle;
    let hardDeadline;

    const cleanup = () => {
      clearTimeout(idle);
      clearTimeout(hardDeadline);
      process.stdin.off('data', onData);
      process.stdin.off('readable', onReadable);
      process.stdin.off('end', finish);
      process.stdin.off('close', finish);
      process.stdin.off('error', finish);
      process.stdin.pause();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(finish, 100);
    };
    const onData = (chunk) => {
      if (bytes < limit) {
        const kept = chunk.subarray(0, limit - bytes);
        chunks.push(kept);
        bytes += kept.length;
      }
      if (bytes >= limit) return finish();
      try {
        JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return finish();
      } catch {
        armIdle();
      }
    };
    // Windows inherited pipes can expose the first value through the readable interface without
    // emitting a data event until the writer closes. Drain both interfaces; POSIX keeps the fast
    // data path and Windows gets the same complete-value contract without waiting for EOF.
    const onReadable = () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) onData(chunk);
    };

    process.stdin.on('data', onData);
    process.stdin.on('readable', onReadable);
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    process.stdin.once('error', finish);
    // Some Windows pipe handles can deliver repeated readable notifications while the writer
    // remains open, continually resetting an idle timer. The host contract is one JSON value, not
    // EOF; an absolute cap makes the wrapper deterministic under that regime without weakening
    // the normal complete-value fast path.
    hardDeadline = setTimeout(finish, 250);
    armIdle();
    process.stdin.resume();
  });
}

const input = await readHookInput();
const root = activeRoot();
const adapter = root && path.join(root, 'scripts', 'codex-hook-adapter.mjs');
if (!adapter || !fs.existsSync(adapter)) process.exit(0);

const hookId = process.argv[2] || '';
const result = spawnSync(process.execPath, [adapter, ...process.argv.slice(2)], {
  input,
  encoding: 'utf8',
  env: process.env,
  timeout: timeoutFor(hookId),
  killSignal: 'SIGKILL',
});

// A broken optional Brain hook must never degrade the host. The only non-zero status that carries
// product meaning is an intentional exit-2 refusal from a hook whose contract is blocking.
if (result.status === 2 && blockingHooks.has(hookId)) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(2);
}
if (result.status === 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
process.exit(0);
