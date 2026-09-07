// tests/helpers/reap-detached.mjs — tear down a temp HOME that a DETACHED maintenance job is still
// writing into.
//
// WHY THIS IS NEEDED AT ALL. plugin/scripts/session-start.sh launches its spine seed through
// plugin/scripts/detach.mjs, deliberately outside the hook's process group: the hook returns in
// ~200ms and the seed copies a whole payload tree, so a job that died with the hook would mean the
// spine is never seeded (that file's header carries the full reasoning). Measured: at 24ms after
// the hook returned, `detach.mjs` and `update-apply.mjs --seed` are both alive and about to write
// into HOME. A test that deletes HOME at that moment is racing a live writer, and it loses —
// `ENOTEMPTY: rmdir .../.cache/ruvnet-brain` on roughly one run in three, and no amount of
// `rmSync` retrying wins, because retrying against a process that keeps re-creating directories is
// a livelock, not a wait (measured: 192s of retries, then the same failure).
//
// The race PREDATES the detach — the seed was always backgrounded — it was simply narrow enough to
// hide until an extra process hop widened it. So this is not a workaround for a new defect; it is
// the teardown the suite always needed.
//
// WHAT IT DOES, and why it is honest. `detach.mjs` writes every job's pid to
// `<home>/.cache/ruvnet-brain/detached-jobs.jsonl` precisely so a detached job is findable and
// killable rather than a mystery in `ps`. This reads that receipt and kills what it names. The
// teardown therefore EXERCISES the product's own visibility mechanism instead of routing around
// it: if the receipt were decorative, this helper could not work.
//
// It changes no assertion. Cleanup is not contract.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Kill every detached job this HOME's receipt records, then wait briefly for them to go.
 * Never throws: a missing/partial receipt just means there is nothing to reap.
 */
export function reapDetached(home) {
  const receipt = path.join(home, '.cache', 'ruvnet-brain', 'detached-jobs.jsonl');
  let pids = [];
  try {
    pids = fs.readFileSync(receipt, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.state === 'started' && Number.isInteger(r.pid))
      .map((r) => r.pid);
  } catch { return; } // no receipt → nothing was detached from this HOME
  for (const pid of new Set(pids)) {
    // Negative pid: detach.mjs gives each job its OWN process group, so this reaches its children
    // (the tree copy) too. Both forms are tried because only one of them is the group leader.
    for (const target of [-pid, pid]) {
      try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  // Give the OS a moment to reap before the caller starts deleting. Synchronous on purpose:
  // vitest's afterEach must not return while a killed process is still unlinking.
  const until = Date.now() + 500;
  while (Date.now() < until) {
    if (![...new Set(pids)].some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } })) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/**
 * Reap jobs that race receipt creation, then remove the disposable home.
 * A detached SessionStart can create its receipt after the first reap observes
 * the directory, so one-shot teardown is inherently racy. Keep the retry
 * bounded and tied to the product's own receipt rather than sleeping blindly.
 */
export function rmAfterReap(home, ...others) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    reapDetached(home);
    try {
      for (const p of [home, ...others]) {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (lastError) throw lastError;
}

/** reapDetached + a retrying rmSync. The whole teardown, in one call. */
export function rmHome(home, ...others) {
  reapDetached(home);
  for (const p of [home, ...others]) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch { /* best effort */ }
  }
}
