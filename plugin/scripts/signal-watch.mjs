#!/usr/bin/env node
// plugin/scripts/signal-watch.mjs — PostToolUse (matcher ^Bash$, anchored — ADR-058 §D3). The
// OBSERVED half ("W1") of the external-signal watch plane (DDD-0013 Context 2, aggregate SignalDebt).
//
// THE FAILURE THIS CLOSES: on 2026-07-27 GitHub CI was failing and the OWNER had to tell the model.
// A product that pitches "proactive" and needs a human to report a red pipeline has failed. This
// hook is the free half: the model already runs gh/vercel/netlify/npm publish/git push, so this
// classifies the command it already ran (no new polling, no new cost, no new tokens) and:
//   - a SUCCESSFUL `git push` opens a pending CI-verdict debt keyed (repo, sha) — appended to
//     pending.jsonl. scripts/signal-watch.mjs (the W2 poller — a SEPARATE process, SEPARATE file,
//     SEPARATE cadence) resolves it later via `gh run list`; plugin/scripts/session-start.sh
//     surfaces the transition. This is 2026-07-27 replayed with the human removed.
//   - a FAILING gh/vercel/netlify/npm-publish invocation also appends a debt and prints one
//     advisory line (additionalContext — never blocking; PostToolUse cannot block anyway).
//
// CLASSIFICATION IS STRUCTURAL, NEVER A GREP (ADR-058; hook-input.mjs's own header; issues
// #12/#13/#41/#44): findInvocations() below is hook-input.mjs's shared classifier, reused rather
// than reimplemented — it works in EXECUTABLE POSITION only, so the word "vercel" inside a commit
// message or a heredoc body can never fire this (the #12 lesson, generalized).
//
// ── VERIFY-FIRST CLAUSE (mandatory, ADR-058 §D3) — read before touching tool_response parsing ────
//
// The real Bash PostToolUse tool_response shape was captured from THREE live envelopes on
// 2026-07-28, BEFORE this parsing code was written (see
// tests/fixtures/signal-watch/bash-posttooluse-envelopes.json for the captures, their session IDs,
// and full provenance). Confirmed real shape: `{ stdout, stderr, interrupted, isImage,
// noOutputExpected }`. No exit-code field was ever observed in any of the three captures.
//
// That same investigation surfaced a SECOND, more consequential fact, reproduced FIVE separate
// times (a plain `false`, `false` run mid-sequence between two successful calls, a compound
// stderr+exit-1 command, and `ls` on a nonexistent path — twice, the second time with an
// invocation marker written to disk BEFORE the hook process even attempted to read stdin): a Bash
// tool call that itself exits non-zero never invoked this hook's process AT ALL, when driven via
// `claude -p` (the sdk-cli entrypoint), Claude Code v2.1.220. A parallel PreToolUse debug hook fired
// reliably on the byte-identical failing command in the same run, which isolates the gap to
// PostToolUse-after-a-Bash-error specifically, rather than a general hook-loading problem. This is
// reported as a MEASUREMENT (Rule 22/23), not a verdict: it may be an sdk-cli/print-mode-specific
// behavior rather than true interactive-session behavior, and is not asserted to hold universally.
//
// CONSEQUENCE FOR THIS DESIGN: the git-push SUCCESS path this entire feature depends on is
// unaffected — every one of the three real captures was a zero-exit Bash call, and every one fired
// this hook reliably. The "detect a failing gh/vercel/netlify/npm-publish command directly" behavior
// below is therefore built defensively (cliOutcome() below never assumes a field that was not
// actually observed) and stays ADVISORY ONLY, matching the ADR's own framing ("advisory, never
// blocking — malfunction is never a decision"). The AUTHORITATIVE verdict for any CI-shaped question
// always comes from scripts/signal-watch.mjs's poller (a real `gh run list`, resolved independently
// of whether this hook fired at all) — never from this observer's best-effort guess.
//
// SINGLE WRITER (DDD-0013 Context 2 invariant 3): this file is the ONLY writer of pending.jsonl.
// scripts/signal-watch.mjs (the poller) only ever reads it.
//
// CONTRACT (matches every other node hook body in this dir — md-stamp.mjs):
// dispatched via hook-shim.mjs (mode: advisory). ALWAYS exits 0; never throws to the caller; a
// parse/IO failure degrades to silence, never a crash the harness has to survive (DDD invariant 4:
// "observation never blocks and never manufactures a refusal").

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHookEvent, toolName, commandOf, findInvocations, rawToolResponse, readStdinBounded } from './hook-input.mjs';

const MANAGED_TOOLS = ['gh', 'vercel', 'netlify', 'npm', 'git'];

/**
 * Every managed invocation in `command`, structurally classified. Reuses hook-input.mjs's
 * findInvocations() so npx/bunx/pnpx wrapping and executable-position rules are shared with every
 * other gate in this repo instead of re-derived here (the ADR's explicit "do not reimplement").
 */
export function detectManagedInvocations(command) {
  const hits = [];
  for (const inv of findInvocations(command, MANAGED_TOOLS)) {
    if (inv.tool === 'npm') { if (inv.args[0] === 'publish') hits.push({ tool: 'npm-publish', args: inv.args }); }
    else if (inv.tool === 'git') { if (inv.args[0] === 'push') hits.push({ tool: 'git-push', args: inv.args }); }
    else hits.push({ tool: inv.tool, args: inv.args });
  }
  return hits;
}

/**
 * Raw Bash tool_response -> a small typed CliOutcome (DDD-0013 anti-corruption boundary: "the
 * domain holds CliOutcome {exitClass, firstActionableLine}, never raw host JSON"). Defensive by
 * construction per the VERIFY-FIRST note above: honors an explicit numeric exit code if a future
 * Claude Code version ever adds one; otherwise falls back to "stderr is non-empty" as the best
 * available signal from the shape actually observed.
 */
export function cliOutcome(raw) {
  if (!raw || typeof raw !== 'object') return { failed: false, firstActionableLine: '' };
  const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode
    : typeof raw.exit_code === 'number' ? raw.exit_code : null;
  const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';
  const stdout = typeof raw.stdout === 'string' ? raw.stdout : '';
  const failed = exitCode !== null ? exitCode !== 0 : stderr.trim().length > 0;
  const firstActionableLine = (stderr.trim().split('\n')[0] || stdout.trim().split('\n')[0] || '').slice(0, 200);
  return { failed, firstActionableLine };
}

function parseRepoSlug(remoteUrl) {
  const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(\.git)?$/.exec(String(remoteUrl || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The (repo, sha) a push/observation belongs to, from plain READ-ONLY git plumbing — never `gh`.
 * The observer needs no auth; only the poller (scripts/signal-watch.mjs) talks to GitHub's API. */
function resolveGitContext(cwd) {
  let sha = null;
  let repo = null;
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2000 });
    if (r.status === 0) sha = r.stdout.trim();
  } catch { /* not a git repo, or git missing */ }
  try {
    const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', timeout: 2000 });
    if (r.status === 0) repo = parseRepoSlug(r.stdout);
  } catch { /* no remote configured */ }
  return { sha, repo };
}

function signalDir() {
  return process.env.RUVNET_SIGNAL_DIR
    || path.join(process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain'), 'external-signals');
}

export function pendingPath() { return process.env.SIGNAL_WATCH_PENDING || path.join(signalDir(), 'pending.jsonl'); }

/** Append ONE SignalDebt-open event. SINGLE WRITER of pending.jsonl (DDD-0013 §Context 2 inv. 3). */
export function appendDebt(event, file = pendingPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
  } catch { /* observation never blocks, never throws (DDD invariant 4) */ }
}

/**
 * The pure decision: given a parsed hook event, what debts (if any) does it open, and what advisory
 * lines (if any) does it print? Exported so a test can drive it directly with a constructed event,
 * in addition to the subprocess-level tests that feed real envelope JSON on stdin.
 */
export function evaluate(ev, { cwd = process.cwd(), file = pendingPath() } = {}) {
  const result = { debts: [], lines: [] };
  if (toolName(ev) !== 'Bash') return result;
  const command = commandOf(ev);
  const hits = detectManagedInvocations(command);
  if (!hits.length) return result;

  const outcome = cliOutcome(rawToolResponse(ev));
  for (const hit of hits) {
    if (hit.tool === 'git-push') {
      if (outcome.failed) continue; // nothing landed on origin — there is no SHA to poll a verdict for
      const { sha, repo } = resolveGitContext(cwd);
      if (!sha || !repo) continue; // can't key a debt without both halves of (repo, ref)
      const debt = {
        ts: new Date().toISOString(), kind: 'git-push', repo, ref: sha,
        toolUseId: ev.tool_use_id || null, sessionId: ev.session_id || null,
      };
      appendDebt(debt, file);
      result.debts.push(debt);
    } else if (outcome.failed) {
      const debt = {
        ts: new Date().toISOString(), kind: 'cli-exit-nonzero', tool: hit.tool,
        firstActionableLine: outcome.firstActionableLine,
        toolUseId: ev.tool_use_id || null, sessionId: ev.session_id || null,
      };
      appendDebt(debt, file);
      result.debts.push(debt);
      result.lines.push(`[RuvNet Brain — external signal] ${hit.tool} command failed: ${outcome.firstActionableLine || '(no output captured)'}`);
    }
  }
  return result;
}

async function readHookInput() {
  if (process.stdin.isTTY) return null; // never block on a TTY with nothing to give
  try { return parseHookEvent((await readStdinBounded()).toString('utf8')); } catch { return null; }
}

async function main() {
  const ev = await readHookInput();
  if (!ev) return;
  const { lines } = evaluate(ev);
  for (const l of lines) console.log(l);
}

function isMain() {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMain()) {
  try { await main(); } catch { /* fail open, always — see CONTRACT above */ }
  process.exit(0);
}
