#!/usr/bin/env node
// learn-flush.mjs — SessionEnd. Reads this session's learning queue (the workflow you just performed)
// and feeds the distinct steps into the GLOBAL per-user SONA learner — ruflo hooks run with cwd=$HOME
// so learnings accumulate in ONE store (~/.claude-flow), shared across ALL your projects. Project FACTS
// never come here (the queue holds command verbs + file basenames, no content). Each installed RuvNet
// Brain does this for its own user → everyone's brain gets recursively smarter about how THEY work. ADR-0017.
//
// Non-blocking, best-effort. Bounded (distinct actions, short timeouts). `--sync` waits (for tests);
// the hook default backgrounds so SessionEnd never stalls.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdinBounded } from './hook-input.mjs';
import { learningScope, loadRuntimePreferences } from './runtime-preferences.mjs';
import { resolveRuflo, RUFLO_MISSING } from './ruflo-bin.mjs';
import { projectDirectory } from './project-identity.mjs';

// ONE BOUNDED LINE ON STDERR. stderr because a SessionEnd hook's stdout is not surfaced, and bounded
// because a hook that prints a stack trace on every `/clear` gets muted — and a muted diagnostic is
// no diagnostic at all (the same lesson as the session-start line that reported its own defect every
// session for eight days and went unread).
const warn = (msg) => { try { process.stderr.write(`learn-flush: ${msg}\n`); } catch { /* stderr gone */ } };

const HOME = os.homedir();
// RESIDUAL of #134/#104: RUVNET_BRAIN_PROJECT_DIR is never set by real hook dispatch on either host,
// so it degraded back to raw cwd() in production. `projectDirectory()` (project-identity.mjs) is the
// SAME CLAUDE_PROJECT_DIR-with-containment rule #85/#107 already fixed for the receipt/Console
// agreement — reused here rather than trusting the variable unconditionally, which would reopen the
// class of bug #107 was: an unrelated declared root overruling a cwd it does not actually contain.
const PROJECT = process.env.RUVNET_BRAIN_PROJECT_DIR || projectDirectory();
// ISSUE #139 — this WRITER resolved scope correctly while two READERS hardcoded it, so they agreed
// only by coincidence. The resolution moved into runtime-preferences.mjs and all three now call it;
// a future scope is one edit, not three. Behaviour here is unchanged by design.
const LEARNING_SCOPE = learningScope({ cwd: PROJECT });
if (LEARNING_SCOPE === 'off') process.exit(0);

// THE SESSION ID COMES OFF THE PAYLOAD, exactly as it does in learn-capture.sh (fixed 2026-07-27).
//
// This used to be `process.env.CLAUDE_SESSION_ID || 'default'`. Claude Code does not set that
// variable, so every session on the machine read and rewrote ONE shared session-default.jsonl —
// measured live at 147 lines, appended by several concurrent sessions. Both halves of this pipeline
// have to agree about which file they mean, so both now read `session_id` from the payload the hook
// is already handed, sanitise it the same way, and fall back the same way.
//
// The read is bounded: SessionEnd hands us a small JSON object and closes, but an unbounded
// readFileSync(0) on a stdin that never closes is a hang with no upper bound. A payload we cannot
// read in time simply yields no id, which lands on the same fallback as no payload at all.
async function payloadSessionId() {
  if (process.stdin.isTTY) return '';
  try {
    const raw = (await readStdinBounded()).toString('utf8');
    const v = JSON.parse(raw)?.session_id;
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}
// A filename COMPONENT, never a path — the payload is untrusted input.
const SID = ((await payloadSessionId()) || process.env.CLAUDE_SESSION_ID || '').replace(/[^A-Za-z0-9_-]/g, '') || 'default';
const QUEUE_ROOT = LEARNING_SCOPE === 'user'
  ? path.join(HOME, '.cache', 'ruvnet-brain', 'learn')
  : path.join(PROJECT, '.swarm', 'ruvnet-brain-learn');
const QUEUE = process.env.LEARN_QUEUE || path.join(QUEUE_ROOT, `session-${SID}.jsonl`);
// Issue #105: this was a hardcoded `path.join(HOME, '.npm-global/bin/ruflo')` — the owner's npm
// prefix. On any other prefix (Homebrew, nvm, Volta, plain `npm -g`) the path simply did not exist,
// every feed below threw ENOENT, and every throw landed in a `catch {}` that said nothing. One
// resolver, shared with distill-project.mjs and health-repair.mjs's original — see ruflo-bin.mjs.
const RUFLO = resolveRuflo();
const RUFLO_ENV = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' };
const MAX_ACTIONS = 8; // bound the work so SessionEnd stays fast

// THE DEADLINE. SessionEnd's registered timeout is 30s (plugin/hooks/hooks.json) and this hook fires
// on EVERY session end — including every `/clear`. Measured on the owner's machine 2026-07-27, in all
// four stdin regimes: 48–50s wall, killed at the cap every single time.
//
// The arithmetic was never survivable. MAX_ACTIONS is 8 and a real `ruflo hooks` call measured 3.83s,
// so the feed queued ~31s of work into a 30s budget and was killed part-way through it. Worse, the
// kill lands BEFORE the write-back that preserves the remainder, so the queue never shrinks and never
// drains — a cap that guarantees the work it defers can never be done.
//
// A work limit has to be expressed in the currency the budget is denominated in. MAX_ACTIONS bounds
// COUNT; this bounds TIME, and the two together mean the hook stops cleanly, keeps what it did not
// feed, and exits well inside the cap. 20s leaves a full third of the budget for the write-back, the
// process teardown, and a slow machine. Measured with a 4s-per-call stub and a 147-entry queue: 22.5s
// wall at a 20s deadline (execFileSync's own kill handling costs a couple of seconds on top of the
// budget), so the number is set at 18s to keep the real worst case around 20s — a third of the cap in
// hand. The budget is the thing being bounded; the constant is chosen from the measurement, not from
// how round it looks.
const DEADLINE_MS = Number(process.env.LEARN_FLUSH_DEADLINE_MS) || 18_000;
const DEADLINE = Date.now() + DEADLINE_MS;

let lines = [];
try { lines = fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean); } catch { process.exit(0); }
if (!lines.length) process.exit(0);

// Distinct workflow actions this session (dedupe → a session has only a handful of real patterns).
//
// COLLECT ALL, FEED SOME, KEEP THE REST (fixed 2026-07-22). This used to `break` at MAX_ACTIONS and
// then delete the ENTIRE queue, so a session with 30 distinct actions fed 8 and destroyed 22 —
// permanently, silently, while reporting success. Measured on the owner's machine the same day: the
// queue stood at 491 raw captures, every one of which would have been discarded after feeding 8.
//
// The cap exists for a good reason (SessionEnd must stay fast) but a work LIMIT is not a licence to
// destroy the work you didn't do. Now the remainder is written back and drains on the next flush,
// so a deep queue converges instead of being truncated.
const allDistinct = [];
const seen = new Set();
for (const line of lines) {
  let s; try { s = JSON.parse(line); } catch { continue; }
  const key = `${s.tool}|${(s.action || '').slice(0, 60)}`;
  if (!s.action || seen.has(key)) continue;
  seen.add(key);
  allDistinct.push(s);
}
const actions = allDistinct.slice(0, MAX_ACTIONS);
const deferred = allDistinct.slice(MAX_ACTIONS);

// ruflo is genuinely not on this machine. SAY SO — once — and keep the queue. Exiting 0 keeps the
// best-effort contract (an absent optional learner must never break SessionEnd); saying nothing at
// all is what turned #105 into eight invisible ENOENTs and a queue that never drained.
if (!RUFLO && actions.length) {
  warn(`0/${actions.length} fed — ${RUFLO_MISSING}. The queue is KEPT for retry.`);
  process.exit(0);
}

let fed = 0;
const failures = [];              // WHY each feed failed — the thing `catch {}` used to destroy
let stoppedAt = actions.length;   // how far the feed actually got before the deadline
for (let i = 0; i < actions.length; i++) {
  const remaining = DEADLINE - Date.now();
  // STOP CLEANLY, and stop BEFORE starting work that cannot finish inside the budget. A call begun
  // at 19.9s with a 6s timeout would run to 25.9s, which is the whole failure in miniature — the
  // budget has to bound the call, not just the decision to make it.
  if (remaining <= 0) { stoppedAt = i; break; }
  const s = actions[i];
  const args = s.tool === 'Bash'
    ? ['hooks', 'post-command', '-c', s.action, '-s', 'true']
    : ['hooks', 'post-edit', '-f', s.action, '-s', 'true', '-o', 'session edit'];
  try {
    // One command, two real Ruflo scopes: project cwd keeps patterns local; HOME retains the
    // cross-project SONA learner for users who explicitly chose `user`.
    execFileSync(RUFLO, args, {
      cwd: LEARNING_SCOPE === 'user' ? HOME : PROJECT,
      env: RUFLO_ENV,
      stdio: 'ignore',
      timeout: Math.min(6000, remaining),
    });
    fed++;
  } catch (e) {
    // BEST-EFFORT, NOT SILENT. The old `catch { /* best-effort */ }` swallowed the reason, so a
    // machine where every call failed looked exactly like one where every call worked: exit 0,
    // no output, and the only trace a queue that never shrank. "Reports success while doing
    // nothing" is the defect class this project treats as the worst thing it can ship. Keep going
    // (one bad record must not stall session end), but keep the reason.
    failures.push(String(e?.message || e).split('\n')[0].slice(0, 120));
  }
}
// SURFACE IT. Distinct reasons only, at most two: eight copies of the same ENOENT is noise, and the
// second distinct reason is usually where the real information is.
if (failures.length) {
  const distinct = [...new Set(failures)];
  warn(`${failures.length}/${actions.length} feed call(s) FAILED via ${RUFLO}`
    + ` — ${distinct.slice(0, 2).join(' | ')}${distinct.length > 2 ? ` (+${distinct.length - 2} more kind(s))` : ''}`
    + (fed === 0 ? '. Nothing was learned; the queue is KEPT for retry.' : `. ${fed} succeeded.`));
}
// Whatever the deadline cut off is WORK, not waste: it goes back on the front of the queue so the
// next flush continues from there. Dropping it would turn a time limit into the same silent data
// loss the count limit used to cause.
if (stoppedAt < actions.length) deferred.unshift(...actions.slice(stoppedAt));

// DERIVED, not asserted (F14, 2026-07-18): the queue is EVIDENCE, and it may only be destroyed when
// its contents were actually fed. The old line deleted it unconditionally — a session where every
// `ruflo hooks` call failed (fed=0) silently discarded the whole learning queue with nothing learned
// and no trace. Now: nothing fed + something to feed ⇒ the queue survives for the next session-end
// to retry. An empty queue (nothing to feed) is safe to remove.
if (fed > 0 || allDistinct.length === 0) {
  if (deferred.length) {
    // Work remains. Write back ONLY what was not fed, so the next flush continues where this one
    // stopped. Deleting here is what turned a rate limit into data loss.
    try {
      fs.writeFileSync(QUEUE, deferred.map((s) => JSON.stringify(s)).join('\n') + '\n');
    } catch { /* if we cannot rewrite it, leaving the full queue is strictly safer than removing it */ }
  } else {
    try { fs.rmSync(QUEUE); } catch { /* leave it if we can't remove */ }
  }
} else if (process.argv.includes('--sync')) {
  console.log(`learn-flush: 0/${actions.length} fed (ruflo hooks failing?) — queue KEPT for retry next session-end`);
}
if (process.argv.includes('--sync')) {
  console.log(`learn-flush: fed ${fed}/${actions.length} distinct actions to the ${LEARNING_SCOPE} learner`
    // Say the deadline out loud when it fires. A budget that silently truncates reads as "that was
    // all there was", which is the same lie as the count cap that preceded it.
    + (stoppedAt < actions.length ? `; STOPPED at ${stoppedAt}/${actions.length} on the ${DEADLINE_MS}ms deadline` : '')
    + (deferred.length ? `; ${deferred.length} distinct action(s) deferred to the next flush (queue kept, nothing discarded)` : ''));
}
process.exit(0);
