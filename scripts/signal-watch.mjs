#!/usr/bin/env node
// scripts/signal-watch.mjs — the W2 POLLED half of the external-signal watch plane (ADR-058 §D3;
// DDD-0013 Context 2, aggregate SignalDebt). A maintainer-only dev tool, same class as
// scripts/ci-verdict.mjs and scripts/issue-watch.mjs — it is NOT part of the shipped plugin, so it
// only ever runs in this checkout (this repo's own session-start.sh looks for it by repo-relative
// path and simply finds nothing on a downloader's machine — see plugin/scripts/session-start.sh).
//
// THE FAILURE THIS CLOSES: 2026-07-27, GitHub CI was failing and the OWNER had to tell the model.
// plugin/scripts/signal-watch.mjs (the PostToolUse observer, the OTHER half — "W1 OBSERVED") opens a
// pending debt the moment a `git push` succeeds, keyed (repo, sha), appended to pending.jsonl. THIS
// file resolves that debt via `gh run list` — READ-ONLY VERBS ONLY, never a mutating `gh` command —
// and writes the result so plugin/scripts/session-start.sh can surface a transition with zero user
// input. This is 2026-07-27 replayed with the human removed (ADR-058 §D3, mutant M-W1).
//
// REUSE, NOT REIMPLEMENTATION (explicit ADR-058 instruction, enforced by this repo's own
// substitution:check gate): the success/refuse mapping is scripts/ci-verdict.mjs's assessCiGate —
// the SAME "unknown is red" law the remote-CI ship gate already uses. This file does not carry a
// second copy of that decision.
//
// SINGLE WRITER (DDD-0013 Context 2 invariant 3): this file is the ONLY writer of ci-status.json.
// plugin/scripts/signal-watch.mjs (the observer) only ever APPENDS to pending.jsonl and never
// touches ci-status.json — two files, two writers, on purpose (ADR-050's one-poisoned-predicate
// lesson: channels that share a write path fail together).
//
// DEGRADATION LADDER (DDD-0013 Context 2 invariant 1, "UNKNOWN STAYS OPEN"):
//   no `gh` binary          -> state 'unverifiable', reason names the fix. A typed CAPABILITY state,
//                              never an error.
//   `gh` unauthenticated    -> state 'unverifiable', reason names the fix. Same class as above.
//   API error / rate-limit  -> state stays 'pending' — a transient hiccup, retried next poll. NEVER
//                              invented as a green resolution (ci-verdict.mjs's law, reused, not
//                              reimplemented: `assessCiGate(null)` refuses).
//   no run found yet        -> state stays 'pending' (CI hasn't started; not a failure).
// Never fakes green, never silently disables (DDD invariant 6) — every non-resolved state is a
// distinct, named reason, not silence.
//
// FIXTURE INJECTION (ADR-058 §D3, mandatory): SIGNAL_WATCH_GH_FIXTURE points at a JSON file standing
// in for a real `gh run list` call, so CI needs no network and no auth. See
// tests/fixtures/signal-watch/gh-fixtures/*.json for the shapes:
//   [ { "conclusion": "success" } ]   — a real `gh run list --json ...` array (first element used)
//   { "apiError": true }              — simulates a rate-limit / network failure (state stays pending)
//   { "unauthenticated": true }       — simulates `gh auth login required`
//   { "notInstalled": true }          — simulates a missing `gh` binary

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assessCiGate } from './ci-verdict.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const SIGNAL_DIR = process.env.RUVNET_SIGNAL_DIR || path.join(BRAIN_HOME, 'external-signals');
const GH_BIN = process.env.GH_BIN || 'gh';
const GH_TIMEOUT_MS = 3000; // bounded — this poller may run synchronously inside session-start.sh's 5s hook budget

export function pendingPath() { return process.env.SIGNAL_WATCH_PENDING || path.join(SIGNAL_DIR, 'pending.jsonl'); }
export function statusPath() { return process.env.SIGNAL_WATCH_STATUS || path.join(SIGNAL_DIR, 'ci-status.json'); }

export function debtKey(source, repo, ref) { return `${source}:${repo}:${ref}`; }

/**
 * Parse pending.jsonl (append-only event log, written ONLY by the PostToolUse observer) into the
 * list of open git-push CI-verdict debts. Dedup keeps the LATEST event per (repo, ref) — a debt's
 * resolution STATE lives entirely in ci-status.json, never here; this only answers "what exists to
 * check". One malformed line is skipped, never crashes the poller (matches issue-watch.mjs's own
 * defensiveness against a corrupt state file).
 */
export function readPushDebts(path_ = pendingPath()) {
  let raw;
  try { raw = fs.readFileSync(path_, 'utf8'); } catch { return []; }
  const byKey = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev && ev.kind === 'git-push' && ev.repo && ev.ref) {
      byKey.set(debtKey('gh-ci', ev.repo, ev.ref), ev);
    }
  }
  return [...byKey.entries()].map(([key, ev]) => ({ key, repo: ev.repo, ref: ev.ref, ts: ev.ts }));
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

/**
 * Resolve ONE debt's CI verdict. READ-ONLY `gh` verbs only (`--version`, `run list`) — a
 * state-changing verb here is the exact boundary violation DDD-0013's anti-corruption section names
 * ("adapters carry a read-only verb whitelist; a state-changing verb ... is a boundary violation the
 * mesh lint fails"). Returns { state: 'resolved'|'unverifiable'|'pending', conclusion?, reason?, workflowName? }.
 */
export function resolveVerdict({ repo, ref }, { ghBin = GH_BIN, fixturePath = process.env.SIGNAL_WATCH_GH_FIXTURE } = {}) {
  let runs = null;
  let capability = null;

  if (fixturePath) {
    let fixture;
    try { fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); }
    catch (e) { return { state: 'pending', reason: `unreadable SIGNAL_WATCH_GH_FIXTURE: ${e.message}` }; }
    if (fixture && fixture.notInstalled) capability = 'not-installed';
    else if (fixture && fixture.unauthenticated) capability = 'unauthenticated';
    else if (fixture && fixture.apiError) runs = null;
    else runs = Array.isArray(fixture) ? fixture : (fixture.runs || []);
  } else {
    let probe;
    try { probe = spawnSync(ghBin, ['--version'], { encoding: 'utf8', timeout: GH_TIMEOUT_MS }); }
    catch { probe = { error: { code: 'ENOENT' } }; }
    if (probe.error && probe.error.code === 'ENOENT') {
      capability = 'not-installed';
    } else {
      // READ-ONLY VERB: `gh run list`. Never anything that mutates (no `gh run rerun`, no `gh pr merge`, etc).
      const r = spawnSync(ghBin, ['run', 'list', '--commit', ref, '--repo', repo, '--json', 'status,conclusion,workflowName'],
        { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
      if (r.status === 0) {
        try { runs = JSON.parse(r.stdout || '[]'); } catch { runs = null; }
      } else {
        const err = String(r.stderr || r.stdout || '');
        if (/auth login|not logged in|authentication|401|unauthorized/i.test(err)) capability = 'unauthenticated';
        else runs = null; // API error, rate-limit, offline — stays UNKNOWN, never invented as green
      }
    }
  }

  if (capability === 'not-installed') return { state: 'unverifiable', reason: 'gh not installed — install: brew install gh (or see https://cli.github.com)' };
  if (capability === 'unauthenticated') return { state: 'unverifiable', reason: 'gh auth login required' };
  if (!Array.isArray(runs)) return { state: 'pending', reason: 'gh API error or unreachable — verdict UNKNOWN, debt stays open' };
  if (!runs.length) return { state: 'pending', reason: 'no CI run found yet for this SHA' };

  const run = runs[0];
  // The SAME unknown-is-red law the remote-CI ship gate uses, reused rather than reimplemented.
  const gate = assessCiGate(run.conclusion ?? null);
  if (gate === 'ship') return { state: 'resolved', conclusion: 'success', workflowName: run.workflowName };
  return { state: 'resolved', conclusion: run.conclusion || 'unknown', workflowName: run.workflowName };
}

/**
 * Poll every open, not-yet-resolved debt once and persist the result. Append-only in spirit
 * (DDD-0013 Context 1 invariant 3, applied here): a debt already 'resolved' is never re-resolved —
 * closing state is a SurfacingLedger-layer transition (session-start.sh), not a poller re-check.
 */
export function pollOnce({ pendingFile = pendingPath(), statusFile = statusPath(), ghBin = GH_BIN, fixturePath = process.env.SIGNAL_WATCH_GH_FIXTURE } = {}) {
  const debts = readPushDebts(pendingFile);
  const status = loadJson(statusFile);
  for (const debt of debts) {
    const prior = status[debt.key];
    if (prior && prior.state === 'resolved') continue;
    const verdict = resolveVerdict({ repo: debt.repo, ref: debt.ref }, { ghBin, fixturePath });
    status[debt.key] = { ...verdict, repo: debt.repo, ref: debt.ref, checkedAt: new Date().toISOString() };
  }
  saveJson(statusFile, status);
  return status;
}

function main() {
  const status = pollOnce({});
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
}

function isMain() {
  try { return isDirectInvocation(import.meta.url); }
  catch { return false; }
}

if (isMain()) main();
