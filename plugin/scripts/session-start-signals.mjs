#!/usr/bin/env node
// session-start-signals.mjs — surfaces external CI-signal transitions (red/green/unverifiable)
// recorded by scripts/signal-watch.mjs's polled half. Extracted 2026-09-11 out of
// session-start-core.mjs to keep that file under 500 lines, AND fixed at the same time:
//
// THE MEASURED SLOW PART (2026-09-11 latency profiling): this repo's own checkout has
// scripts/signal-watch.mjs (a dev-only tool — a downloader's machine has none), so
// `exists(poller)` was true and the OLD code ran it with a blocking `spawnSync` whenever
// pending.jsonl was non-empty and ci-status.json was stale — a real `gh run list` network call,
// internally bounded at 3000ms by that file's own GH_TIMEOUT_MS, dominating every cold/warm firing
// measured in this repo. That 3000ms budget was sized for the OLD "SessionStart owns the whole 5s
// hooks.json timeout" assumption; the derived-sum contract (session-start-budget.mjs) no longer
// allows any one stage that much room.
//
// THE FIX: dispatch the poll the same way session-start-core.mjs already dispatches every other
// maintenance job (stableSpine's seed, heartbeat's update-check) — DETACHED, via detach.mjs, which
// returns in ~40ms having handed the real work to a background process with its own TTL. The signal
// surfaced THIS session-start is therefore always the PREVIOUS poll's result (same "eventually
// consistent, never blocking" contract issue-watch.mjs's hourly cache already uses for open issues);
// a push's CI-red transition surfaces on the NEXT session-start rather than the current one, which is
// still well inside the "surface this soon, not never" intent and no longer risks a multi-second hang.
import path from 'node:path';
import { json, exists, mtimeMs, write, dispatchDetached } from './session-start-fsutil.mjs';

export function surfaceSignals({ env, cwd, stateDir, hookDir, emit, now, pollTtlSec = 30 }) {
  const signalDir = env.RUVNET_SIGNAL_DIR || path.join(stateDir, 'external-signals');
  const pending = path.join(signalDir, 'pending.jsonl');
  const statusFile = path.join(signalDir, 'ci-status.json');
  const surfacedFile = path.join(signalDir, 'surfaced.json');
  if (!exists(pending)) return;

  const poller = path.join(env.CLAUDE_PROJECT_DIR || cwd, 'scripts', 'signal-watch.mjs');
  if (exists(poller) && now - mtimeMs(statusFile) > 600_000) {
    dispatchDetached(hookDir, pollTtlSec, path.join(stateDir, '.last-signal-poll.log'), process.execPath, [poller], env);
  }
  const status = json(statusFile);
  if (!status || typeof status !== 'object') return;
  const onDisk = json(surfacedFile, {});
  const surfaced = {
    debts: onDisk?.debts && typeof onDisk.debts === 'object' ? onDisk.debts : {},
    redRepo: onDisk?.redRepo && typeof onDisk.redRepo === 'object' ? onDisk.redRepo : {},
  };
  let changed = false;
  const entries = Object.entries(status).sort((a, b) =>
    new Date(a[1]?.checkedAt || 0) - new Date(b[1]?.checkedAt || 0));
  for (const [key, debt] of entries) {
    const shortSha = String(debt?.ref || '').slice(0, 7);
    if (debt?.state === 'resolved' && debt.conclusion !== 'success') {
      if (surfaced.debts[key] === 'red') continue;
      emit(`[RuvNet Brain — EXTERNAL SIGNAL: CI is RED for ${debt.repo}@${shortSha} — surface this to the user now, near the top, with ZERO prompting]`);
      emit(`Workflow ${debt.workflowName || 'ci'} concluded ${debt.conclusion} on ${debt.repo}@${shortSha}; inspect with gh run list --repo ${debt.repo} --commit ${debt.ref}.`);
      surfaced.debts[key] = 'red';
      surfaced.redRepo[debt.repo] = key;
      changed = true;
      continue;
    }
    if (debt?.state === 'resolved' && debt.conclusion === 'success') {
      if (surfaced.redRepo[debt.repo]) {
        emit(`[RuvNet Brain — external signal: CI is GREEN again for ${debt.repo}@${shortSha} — one line, then move on]`);
        delete surfaced.redRepo[debt.repo];
        changed = true;
      }
      if (surfaced.debts[key] !== 'green') { surfaced.debts[key] = 'green'; changed = true; }
      continue;
    }
    if (debt?.state === 'unverifiable' && surfaced.debts[key] !== 'unverifiable') {
      emit(`[RuvNet Brain — external signal: CI status could not be checked for ${debt.repo}@${shortSha}: ${debt.reason || 'unknown reason'}]`);
      surfaced.debts[key] = 'unverifiable';
      changed = true;
    }
  }
  if (changed) write(surfacedFile, JSON.stringify(surfaced, null, 2));
}
