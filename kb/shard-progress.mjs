// shard-progress.mjs — per-shard progress evidence + stall detection for kb/forge-big.mjs.
//
// Split out of forge-big.mjs on purpose: that file runs its MODE dispatch unconditionally at
// import time (a pre-existing gap tests/unit/forge-big-sharding.test.mjs already flagged), so
// importing it in a test would fire `process.exit(2)` via its own argv validation. These functions
// have no top-level side effects and no dependency on the embedder/RVF stack, so they can be
// exercised directly — including with a fixture that behaves like "a mock embedder that stops
// advancing" (write a progress file once, then never touch it again) without loading a real model.
//
// WHY THIS EXISTS (2026-09-11): an 8-shard gists embed sat at 0% CPU for six hours overnight while
// its job-heartbeat.sh receipt still said "running" — a live wrapper pid proves the WRAPPER
// survived, it says nothing about whether the WORK inside it is still moving. Progress here is tied
// to COMPLETED BATCHES, not log/output activity or CPU%, either of which can lag behind (or
// misleadingly survive) a real stall.
import fs from 'node:fs';
import path from 'node:path';

export function progressPath(dir, name, shardIdx, nShards) {
  return path.join(dir, `${name}.big.progress.${shardIdx}-${nShards}.json`);
}

/** Atomic write (tmp + rename) so a reader never observes a half-written progress file. */
export function writeShardProgress(dir, name, shardIdx, nShards, completed, total, { now = () => new Date() } = {}) {
  const p = progressPath(dir, name, shardIdx, nShards);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ shard: shardIdx, of: nShards, completed, total, updatedAt: now().toISOString() }));
  fs.renameSync(tmp, p);
}

export function readShardProgress(dir, name, shardIdx, nShards) {
  try { return JSON.parse(fs.readFileSync(progressPath(dir, name, shardIdx, nShards), 'utf8')); } catch { return null; }
}

export function clearShardProgress(dir, name, shardIdx, nShards) {
  try { fs.unlinkSync(progressPath(dir, name, shardIdx, nShards)); } catch { /* never existed — fine */ }
}

/**
 * Poll N shards' progress files for a stall: a shard whose `completed` count has not increased in
 * `stallMs`. Pure and clock-injectable (`now`) so a test can drive time deterministically via
 * repeated `poll()` calls instead of real sleeps — the same fixture-file technique step-watchdog's
 * own tests use, applied to per-shard completed-work evidence instead of a single process's exit.
 *
 * `onStall(shardIdx, info)` fires AT MOST ONCE per shard. A shard already reporting
 * `completed >= total` can never be flagged — it finished; it is not the thing that hung.
 */
export function createStallWatcher({ dir, name, of, stallMs, pollMs = 15_000, now = () => Date.now(), onStall }) {
  const lastCompleted = new Array(of).fill(0);
  const lastAdvanceAt = new Array(of).fill(now());
  const stalled = new Set();
  function poll() {
    const t = now();
    for (let i = 0; i < of; i++) {
      if (stalled.has(i)) continue;
      const rec = readShardProgress(dir, name, i, of);
      const completed = typeof rec?.completed === 'number' ? rec.completed : 0;
      if (completed > lastCompleted[i]) {
        lastCompleted[i] = completed;
        lastAdvanceAt[i] = t;
        continue;
      }
      if (rec && typeof rec.total === 'number' && rec.completed >= rec.total) continue; // shard finished
      if (t - lastAdvanceAt[i] > stallMs) {
        stalled.add(i);
        onStall(i, { lastCompleted: lastCompleted[i], staleMs: t - lastAdvanceAt[i] });
      }
    }
  }
  const timer = pollMs > 0 ? setInterval(poll, pollMs) : null;
  return { poll, stop: () => { if (timer) clearInterval(timer); }, stalled };
}

/**
 * Evidence for scripts/nightly-watchdog.mjs: across every progress file matching a job's declared
 * glob, find the OLDEST still-incomplete shard's `updatedAt`. Returns null when no shard has
 * started yet (the job hasn't reached embedding, or hasn't run) or every shard is already done —
 * neither is evidence of a stall.
 */
export function oldestIncompleteProgress(dir, filenamePattern) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => filenamePattern.test(f)); } catch { return null; }
  let oldest = null;
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (typeof rec.completed !== 'number' || typeof rec.total !== 'number' || rec.completed >= rec.total) continue;
    const updatedAt = new Date(rec.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) continue;
    if (!oldest || updatedAt < oldest.updatedAt) {
      oldest = { updatedAt, shard: rec.shard, of: rec.of, completed: rec.completed, total: rec.total,
        detail: `shard ${rec.shard}/${rec.of} (${rec.completed}/${rec.total} passages)` };
    }
  }
  return oldest;
}
