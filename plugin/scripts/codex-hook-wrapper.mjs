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
  // decision-gate composes every refusal policy into ONE verdict and speaks the same exit-2 +
  // stderr contract Codex documents ("PreToolUse hook exited with code 2 but did not write a
  // blocking reason to stderr"). Absent from this set it would be wired and toothless: the exit 2
  // would be swallowed here and every refusal would silently become an allow.
  'decision-gate',
  'route-dispatch',
  'hijack-ruvnet',   // ADR-063: opt-in managed-memory refusal; exits 0 at the default
  'ground-before-write',
  'protect-state',
  'design-wall',
  'unprompted-speech',
]);

/**
 * THE BUDGET IS DERIVED FROM WHAT THE HOOK MEASURABLY COSTS, never from what looks tidy.
 *
 * A budget smaller than the work is not a limit, it is a silent deletion: this wrapper SIGKILLs the
 * child and exits 0 with `status === null`, so nothing is printed and nothing is logged. Measured
 * 2026-08-14 on this machine, that is exactly what `learn-flush` had been doing.
 */
function timeoutFor(hookId) {
  const override = Number(process.env.RUVNET_CODEX_HOOK_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  // learn-flush self-bounds at LEARN_FLUSH_DEADLINE_MS (18s) and then writes back what it did not
  // feed. MEASURED with a real 10-entry queue and the real `ruflo` on this machine: 18342 / 18347 /
  // 18384 ms — it saturates its own deadline every time. The old budget here was 2250ms, so the
  // process was killed at 12% of its work: measured through this exact wrapper, exit 0, 2760ms, ZERO
  // bytes of stdout, ZERO bytes of stderr, and a 10-line queue still 10 lines afterwards. Codex
  // lessons never flushed, and nothing anywhere said so. 22s leaves the write-back and teardown
  // inside the 30s host registration, matching what Claude Code already grants the same hook.
  if (hookId === 'learn-flush') return 22_000;
  // decision-gate's own internal budget is 4000ms (RUVNET_DECISION_BUDGET_MS) and it is allowed to
  // spend all of it: measured 986–4015ms across ten runs in a project this plugin does not own. A
  // budget at or below the gate's own would make the gate's slowest legitimate refusal indis-
  // tinguishable from a crash; 6000ms covers the gate's cap plus this chain's spawn overhead
  // (measured 773–1145ms end-to-end warm, so ~150–400ms of that is the wrapper/adapter/shim).
  if (hookId === 'decision-gate') return 6_000;
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
    let poll;

    const cleanup = () => {
      clearTimeout(idle);
      clearTimeout(hardDeadline);
      clearInterval(poll);
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
    // Some Windows inherited pipes do not emit a readable/data notification until the writer
    // closes. Poll the non-blocking stream read instead of using fs.readSync, which can block the
    // event loop before the first pipe chunk is surfaced.
    poll = setInterval(onReadable, 10);
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
const budgetMs = timeoutFor(hookId);
const result = spawnSync(process.execPath, [adapter, ...process.argv.slice(2)], {
  input,
  encoding: 'utf8',
  // The adapter may fan one multi-file patch out into several body runs, and only this process knows
  // when the axe falls. Hand the budget down so it can stop and fail open instead of being killed
  // mid-loop with nothing written — a SIGKILL here is invisible to the host and to the user.
  env: { ...process.env, RUVNET_CODEX_BUDGET_MS: String(budgetMs) },
  timeout: budgetMs,
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
