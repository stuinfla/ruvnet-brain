// reader-deadlock-regression.test.mjs — issue #29 regression guard.
//
// Contributed by Jan Lafko (@lafinak): a corrupted (truncated) local CE model cache must never
// deadlock the reader on a repeat load. Before the self-heal fix, call #1 threw and call #2 wedged
// 27/28 threads in futex_wait_queue, freezing the whole MCP server on the SECOND query.
//
// WHY A CHILD PROCESS + spawnSync timeout (Jan's load-bearing insight): the deadlock freezes Node's
// ENTIRE event loop, so no in-process timer can fire — not Promise.race, not setTimeout, and NOT
// vitest's own per-test timeout (also a same-thread JS timer). Only an external, OS-level kill works.
// spawnSync's `timeout` is enforced in libuv/C++, not JS, so it kills a frozen child even while the
// parent blocks in spawnSync — making it the one guard that actually terminates the hang. The fixture
// runs as a SEPARATE process (tests/regression/reader-deadlock-pr0p.mjs); prime and test are split so a
// warm in-memory `_ce` from a successful prime can't mask the corruption.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'tests', 'regression', 'reader-deadlock-pr0p.mjs');
const KB = path.join(ROOT, 'kb');

const run = (mode, timeoutMs) =>
  spawnSync('node', [SCRIPT, mode, '--dir', KB], {
    timeout: timeoutMs,        // OS-level (libuv) — fires even if the child's event loop is frozen
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    env: { ...process.env },
  });

describe('issue #29 — a corrupted CE cache must never deadlock a repeat load (Jan Lafko / @lafinak)', () => {
  it('primes, then survives a truncated cache across two calls in a fresh process', () => {
    // Prime may download the CE model on a cold cache; allow generous time. Offline → SKIP LOUDLY.
    const prime = run('prime', 180_000);
    if (prime.status !== 0) {
      console.warn(
        `[reader-deadlock #29] SKIP — could not prime the CE model (offline / model unavailable): ` +
        `${(prime.stderr || prime.stdout || '').slice(-200)}`,
      );
      return; // loud skip, never a silent pass
    }
    const res = run('test', 120_000);
    if (res.status === 2) {
      console.warn(
        `[reader-deadlock #29] SKIP — the CE model was not available after priming; ` +
        `this environment cannot exercise the corruption path: ${(res.stderr || res.stdout || '').slice(-200)}`,
      );
      return;
    }
    // status 0  → both calls completed: the self-heal worked, no deadlock.
    // status null → spawnSync's OS timeout SIGKILLed a frozen child: the #29 deadlock is back.
    expect(
      res.status,
      `#29 deadlock regression — child did not exit 0 (status=${res.status}, signal=${res.signal}):\n` +
      `${(res.stdout || '')}\n${(res.stderr || '')}`,
    ).toBe(0);
  }, 300_000); // outer vitest budget only; the real guard is spawnSync's timeout above
});
