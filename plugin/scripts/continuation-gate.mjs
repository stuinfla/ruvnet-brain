#!/usr/bin/env node
/**
 * continuation-gate.mjs — the gate that fires on STOPPING, because nothing else can.
 *
 * THE HOLE THIS CLOSES, and it is a real architectural gap in ADR-030, not a missing feature.
 *
 * Every gate in this project fires on an ACTION: a Write, an Edit, a push, a claim, a status
 * report. That is what makes them enforceable — there is a tool call to intercept.
 *
 * **Stopping is the absence of an action.** When the model finishes a unit of work, writes a
 * summary, and waits — no tool fires, no text is classified, nothing is intercepted. The single
 * most costly failure of 2026-07-22 had NO TRIGGER, which is why a system explicitly built to
 * prevent it did not prevent it.
 *
 * The owner, 05:45, and it is the correct indictment: *"This was exactly the stuff that RuvNet-Brain
 * was designed to stop, so the fact that you didn't is yet another failure... you agree you are
 * going to finish something and you stop because you have some excuse, and then you don't start
 * yourself up again."*
 *
 * L13 was recorded and ratified an hour earlier and did not help, because it fires on
 * `report-status` — it can only catch a stop that ANNOUNCES itself. A silent stop is invisible to
 * every gate in the system.
 *
 * HOW THIS WORKS. A `Stop` hook runs when a turn ends. It reads the work ledger — a plain list of
 * committed-to items with a done state — and if authorized work remains unfinished, it says so, in
 * the last place the model looks before going quiet.
 *
 * CURRENT AUTHORITY: only explicitly scoped nonauthoritative continuation preferences request
 * objective work. Historical incident notes below describe the former backlog-forcing behavior;
 * repository observations are now stderr advisories, never permission to act. Answer-integrity
 * correction remains independent, but cancellation/interruption and the host loop guard win.
 *
 * This file emits a Stop request envelope. Unit/subprocess tests prove that output, NOT native host
 * continuation. No daemon, automatic preference writer, completion authority, or re-engagement
 * bridge exists here. The existing stop_hook_active guard remains unchanged.
 *
 * FAILS OPEN ALWAYS. Exit 0 unconditionally. A gate that breaks a turn's completion because it
 * could not read a JSON file would be disabled within a day, and a disabled gate protects nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readStopHookInput } from './hook-input.mjs';
import {
  auditCapabilityClaims,
  buildCapabilityInventoryReceipt,
} from './capability-inventory-receipt.mjs';
import { auditCurrentCapabilityEvidence } from './capability-claim-evidence.mjs';
import { continuationProjectIdentity, authorizedContinuationObjective, authorizedPromiseItems, assistantCommitmentOwned, setAssistantCommitmentState } from './continuation-objective.mjs';
import {
  auditCompletionClaims, readClaudeTurn, extractCommitments, claimClosesPromise,
  PROMISE_KIND, PROMISE_CAP_OPEN,
} from './completion-claim-evidence.mjs';

const HOME = os.homedir();

// Always exit zero. Any host continuation request is expressed in the envelope, not exit status.
const EXIT_ALLOW = 0;
/**
 * PROJECT-SCOPED, because this runs machine-wide.
 *
 * The owner runs three projects simultaneously. A single global ledger would mix their commitments
 * and fire "you did not finish X" in a repo that never heard of X — which is a false alarm, and
 * ADR-028 fixes the false-alarm rate at ZERO. So the ledger is keyed by the git repo root (falling
 * back to cwd), stored centrally under ~/.config so it survives `--update`, but partitioned per
 * project so the three never see each other's work.
 */
function projectKey() {
  return continuationProjectIdentity(process.cwd())?.projectId.replace(':', '-') || 'unknown-project';
}

let LEDGER = process.env.RUVNET_WORK_LEDGER
  || path.join(HOME, '.config', 'ruvnet-brain', 'work-ledgers', `${projectKey()}.json`);

/**
 * THE SAME PARTITION, APPLIED TO THE DERIVED SOURCES — added 2026-08-14 after this file was caught
 * doing exactly what projectKey() above exists to prevent, one layer down.
 *
 * The ledger has been partitioned per project since day one, for the reason stated above: a
 * commitment made in one repo must never fire in another. Every artifact-derived source added later
 * (issues, red CI, open PRs, security alerts) read a MACHINE-GLOBAL file under ~/.cache/ruvnet-brain
 * with no such partition. So the explicit half was scoped and the derived half was not, and the
 * derived half is the half that is always populated.
 *
 * MEASURED, not supposed. Firing Stop in a fresh git repo whose remote is
 * `someone-else/totally-unrelated`, with an EMPTY ledger:
 *   {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"You have unfinished work you
 *    committed to. … ☐ PR #137 on stuinfla/ruvnet-brain is RED …"}}
 * `additionalContext` at Stop CONTINUES THE TURN, so a stranger's every turn-end was being forced
 * with orders to go fix another repository's pull requests. The forensic trail was already on this
 * machine before anyone looked: ~/.config/ruvnet-brain/work-ledgers/AppealArmor.json holds ZERO
 * items, yet AppealArmor.json.cooldown exists — and that lock is written ONLY on the path that
 * forces. The gate forced a continuation in AppealArmor on 2026-08-13T21:39Z with nothing of
 * AppealArmor's to say. Same for Ruv-Explainer, T, verify-prod and notgit.
 *
 * THE RULE: a derived item may only ever speak about a repository THIS working tree points at.
 * Ownership is read from the git remotes, which is the only durable statement of "which repo is
 * this" available at a Stop boundary — no network, no `gh`, no spawn.
 *
 * FAIL CLOSED ON SCOPE, FAIL OPEN ON BEHAVIOUR. Not a git repo, no remotes, unreadable config →
 * we cannot confirm ownership, so the derived sources contribute NOTHING and the gate exits 0 in
 * silence. It never blocks, never errors, never speaks about a repo it cannot prove is ours. The
 * work LEDGER is untouched by all of this: a real commitment recorded in this project still forces
 * exactly as before, which is the one behaviour that must never be weakened.
 */
function gitConfigPath(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const dot = path.join(dir, '.git');
    try {
      const st = fs.statSync(dot);
      if (st.isDirectory()) return path.join(dot, 'config');
      if (st.isFile()) {
        // A linked worktree / submodule: `.git` is a file naming the real gitdir. The remotes live
        // in the COMMON dir (…/.git), not in …/.git/worktrees/<name>, so follow `commondir` when
        // it is present. Getting this wrong would silently return "owns nothing" in a worktree.
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
        if (!m) return null;
        const gitdir = path.resolve(dir, m[1].trim());
        try {
          const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
          return path.join(path.resolve(gitdir, common), 'config');
        } catch { return path.join(gitdir, 'config'); }
      }
    } catch { /* no .git here — keep walking up */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** `https://github.com/Owner/Name.git`, `git@github.com:Owner/Name`, `Owner/Name` → `owner/name`. */
function slugOf(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!s) return null;
  const tail = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '')   // scheme://host/
    .replace(/^[^/@]+@[^:/]+:/, '');                  // user@host:
  const parts = tail.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/').toLowerCase() : null;
}

function ownedRepoSlugs() {
  const owned = new Set();
  try {
    const cfg = gitConfigPath(process.cwd());
    if (!cfg) return owned;                            // no git → owns nothing → derived sources mute
    const text = fs.readFileSync(cfg, 'utf8');
    // Every remote, not just origin: a fork legitimately owns both its origin and its upstream, and
    // the artifacts name the upstream slug.
    for (const m of text.matchAll(/^\s*url\s*=\s*(.+)$/gm)) {
      const slug = slugOf(m[1]);
      if (slug) owned.add(slug);
    }
  } catch { /* unreadable config → owns nothing */ }
  return owned;
}
const OWNED_REPOS = ownedRepoSlugs();
/** True only when `repo` names a repository THIS working tree actually points at. */
const ownsRepo = (repo) => {
  const slug = slugOf(repo);
  return Boolean(slug) && OWNED_REPOS.has(slug);
};

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (f) => argv.includes(f);

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return Array.isArray(j.items) ? j : { items: [] };
  } catch { return { items: [] }; }
}
function save(led) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ ...led, updated: new Date().toISOString() }, null, 2) + '\n');
    return true;
  } catch { return false; /* the ledger is advisory — never break a turn over it */ }
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────────
if (has('--commit-to')) {
  // Record work the model AGREED to do. The agreement is the thing that makes stopping a defect —
  // without it, ending a turn is simply finishing, and this gate must stay silent.
  const led = load();
  const text = arg('--commit-to');
  const at = new Date().toISOString();
  if (text && !led.items.some((i) => i.text === text && !i.done)) {
    led.items.push({ text, done: false, at });
  }
  /**
   * THE BUG THIS CLOSES (found live 2026-09-12, in production use, not in a test). Until now
   * `--commit-to` only ever appended to `led.items` and NEVER wrote `led.objective` — the ONLY field
   * the Stop hook's forcing logic actually reads (`authorizedContinuationObjective`, above). Every
   * test that ever proved forcing worked hand-constructed a valid objective directly into a fixture
   * ledger; no real invocation took that path. Result: real `--commit-to` calls sat in a real ledger
   * with zero effect for hours. Fixed at the source: `--commit-to` now writes a real, valid objective
   * matching every field `authorizedContinuationObjective` requires, using the ONE session wildcard
   * that function accepts (`sessionIds: ['*']`) — because this is a bare terminal invocation with no
   * access to the session_id a future Stop event will carry; only a live Stop hook ever sees that.
   * `worktreeIds`/`projectId` ARE knowable here (from cwd), so those are never wildcarded.
   */
  const identity = continuationProjectIdentity(process.cwd());
  if (text && identity) {
    led.objective = {
      schemaVersion: 1, kind: 'continuation-preferences', authoritative: false,
      id: crypto.randomUUID(), text, at, state: 'active',
      projectId: identity.projectId, worktreeIds: [identity.worktreeId], sessionIds: ['*'],
      authorization: { kind: 'user', reference: 'commit-to-cli' },
    };
  }
  save(led);
  console.log(`committed: ${text}`);
  process.exit(0);
}

if (has('--set-commitment-state')) {
  try {
    const sessionId = arg('--session-id');
    const nativeSession = process.env.RUVNET_BRAIN_SESSION_ID || process.env.RUVNET_HOOK_SESSION_ID;
    if (nativeSession && nativeSession !== sessionId) throw new Error('supplied session id differs from native session context');
    const led = load();
    setAssistantCommitmentState(led, { itemText: arg('--item'), state: arg('--set-commitment-state'),
      sessionId, reason: arg('--reason'), replacementReference: arg('--replacement'),
      identity: continuationProjectIdentity(process.cwd()) });
    if (!save(led)) throw new Error('assistant commitment state could not be recorded');
    console.log('assistant commitment state recorded; user objective unchanged'); process.exit(0);
  } catch (error) { console.error(`refused: ${error.message}`); process.exit(2); }
}

if (has('--done')) {
  const led = load();
  const needle = arg('--done');
  // EXACT text match only (GPT-5.6-Sol review). The earlier "unambiguous substring" fallback could still
  // clear a SINGLETON open item via a fragment — a fake-completion valve under a gate that now applies real
  // continuation pressure. Marking done requires the item's exact text (copy it from the ledger line).
  // A captured PROMISE never closes by being declared done — only a later answer whose completion
  // claim passed the post-change verification rule closes it (see promiseBookkeeping below).
  if (led.items.some((i) => !i.done && i.text === needle && i.kind === PROMISE_KIND)) {
    console.error('refused: a captured promise closes only with verification evidence at Stop (a completion claim with a check run after the last change), never by --done');
    process.exit(2);
  }
  const targets = led.items.filter((i) => !i.done && i.text === needle);
  for (const i of targets) { i.done = true; i.doneAt = new Date().toISOString(); }
  save(led);
  console.log(`marked done: ${targets.length}`);
  process.exit(0);
}

/**
 * H4: the continuation objective could never be closed. `--commit-to` writes `led.objective` with
 * `state: 'active'` (above), and the Stop-side allow-list at ~275 already checks for
 * `['cancelled', 'completed', 'blocked'].includes(led.objective?.state)` — but until now NOTHING
 * ever wrote one of those three states, so an objective, once opened, forced every Stop for the rest
 * of the project's life (short of `--clear`, which also wipes every unrelated ledger ITEM — a
 * blunt instrument for closing one objective). These two verbs are the missing other half of
 * `--commit-to`: they touch ONLY `led.objective`, leaving `led.items` untouched, and each REQUIRES
 * its evidence/reason text — an empty completion would be exactly the "marked done without doing
 * it" fabrication this whole gate exists to refuse (see the "THE HONEST EXIT" note below on why a
 * genuinely dead item must be closed with a recorded reason, never silently). Nothing here runs
 * automatically; both are explicit, human/model-invoked CLI verbs only.
 */
if (has('--complete-objective')) {
  const evidence = arg('--complete-objective');
  if (!evidence || !evidence.trim()) {
    console.error('--complete-objective requires evidence: --complete-objective "<what proves it is done>"');
    process.exit(2);
  }
  const led = load();
  if (led.objective) {
    // Prose is a request, never verified completion or authority to suppress truth audits.
    led.objective.completionRequestedAt = new Date().toISOString();
    led.objective.completionRequest = evidence.trim();
    save(led);
    console.error('completion unverified: prose cannot complete this objective; retain unfinished work');
    process.exit(2);
  }
  save(led);
  console.log(led.objective ? `objective completed: ${evidence}` : 'no objective to complete');
  process.exit(0);
}

if (has('--cancel-objective')) {
  const reason = arg('--cancel-objective');
  if (!reason || !reason.trim()) {
    console.error('--cancel-objective requires a reason: --cancel-objective "<why this objective no longer applies>"');
    process.exit(2);
  }
  const led = load();
  if (led.objective) {
    led.objective.state = 'cancelled';
    led.objective.cancelledAt = new Date().toISOString();
    led.objective.cancellationReason = reason;
  }
  save(led);
  console.log(led.objective ? `objective cancelled: ${reason}` : 'no objective to cancel');
  process.exit(0);
}

if (has('--help') || has('-h')) {
  console.log([
    'usage: continuation-gate.mjs <verb> [args]  (no verb + JSON on stdin = the Stop hook itself)',
    '',
    '  --commit-to "<text>"               record work the model agreed to do; opens/reopens the',
    '                                      objective as state: active',
    '  --done "<exact item text>"         mark a plain ledger item done (exact text match only)',
    '  --set-commitment-state <blocked|deferred|superseded|disputed> --item "<exact text>"',
    '    --session-id "<capturing session>" --reason "<why>" [--replacement "<reference>"]',
    '                                      retain a noncompleted assistant item; user work unchanged',
    '  --complete-objective "<evidence>"  request closure; prose alone never marks completed',
    '                                      unverified requests retain the unfinished objective;',
    '                                      untouched',
    '  --cancel-objective "<reason>"      close the current objective as state: cancelled, with the',
    '                                      reason recorded — leaves other ledger items untouched',
    '  --clear                            wipe the ENTIRE ledger: every item AND the objective',
  ].join('\n'));
  process.exit(0);
}

if (has('--clear')) { save({ items: [] }); console.log('ledger cleared'); process.exit(0); }

// ── the Stop hook itself (default action) ────────────────────────────────────────────────────────
/**
 * READ THE PAYLOAD. Every Stop hook receives a JSON object on stdin, and until 2026-07-22 this file
 * ignored it completely — which made the loop guard below not merely absent but UNREACHABLE.
 *
 * Never block waiting for stdin: the CLI paths (--commit-to / --done) are invoked from a terminal
 * with no piped input, and a gate that hangs is worse than a gate that is silent.
 */
const hookInput = await readStopHookInput(); // shared with grounding-turn-gate: hook-input.mjs (ADR-043)

// LOOP-SAFETY 1 (ADR-043 / Fable #1) — only an affirmatively-parsed hook payload may force. A 'tty' or
// 'unreadable' source cannot be confirmed a fresh stop, so it never forces.
if (hookInput.__source !== 'stdin') process.exit(EXIT_ALLOW);

/**
 * LOOP-SAFETY 2 — the documented guard. `stop_hook_active` is true once Claude Code is already
 * continuing because of a stop hook (verified against code.claude.com/docs/en/hooks.md, ADR-043).
 * Honouring it caps each natural-stop episode at EXACTLY ONE forced continuation. Truthy, not
 * `=== true`, so a future string/number drift ("true", 1) cannot slip past into a loop.
 * (The check itself now sits just after promise bookkeeping, below — still before any request.)
 */
if (hookInput.hook_event_name !== 'Stop' || hookInput.interrupted || hookInput.cancelled) process.exit(EXIT_ALLOW);
const projectIdentity = continuationProjectIdentity(hookInput.cwd);
if (!projectIdentity) process.exit(EXIT_ALLOW);
LEDGER = process.env.RUVNET_WORK_LEDGER
  || path.join(HOME, '.config', 'ruvnet-brain', 'work-ledgers', `${projectIdentity.projectId.replace(':', '-')}.json`);
const led = load();
const nowMs = Date.now();
const HOST = process.env.RUVNET_HOOK_HOST === 'codex' ? 'codex' : 'claude';

/**
 * COMPLETION CLAIMS (ADR-074 class `completion`, owner 2026-09-30: "You can never ever tell me
 * something is done and implemented without having tested it end to end"). Audited ONCE per Stop:
 * the verdict both requests a correction (below, under every loop guard) and is the only evidence
 * that may close a captured promise. Claude transcripts are parsed; Codex's rollout format is not
 * parsed anywhere in this repo, so on Codex only the answer-side half is enforced and the transcript
 * half is reported UNKNOWN (completion-claim-evidence.mjs header). Fails open: a throw is NONE.
 */
const completion = (() => {
  const message = String(hookInput.last_assistant_message || '');
  if (!message || !hookInput.session_id) return { verdict: 'NONE', claims: [] };
  try {
    const turn = HOST === 'claude' ? readClaudeTurn(hookInput.transcript_path) : null;
    // Claude always sends a JSONL transcript; one we cannot read is OUR failure, and a Stop hook
    // fails open on its own machinery (ADR-074 failure semantics) — never a correction request.
    // Missing native evidence stays UNKNOWN; it cannot silently validate a completion claim.
    return auditCompletionClaims(message, { turn, host: HOST });
  } catch { return { verdict: 'NONE', claims: [] }; }
})();

/**
 * PROMISES ("I'll do X next") become ledger items, and a promise closes ONLY on evidence. This is
 * BOOKKEEPING, not forcing, so it runs before the stop_hook_active exit: the turn's real final
 * answer usually arrives on a continued stop, and a promise made there must not be lost. Claude
 * only — closing needs the transcript receipt, which Codex does not have here, and an item that
 * can never close must never be written. Per-turn and total caps; dedupe against open items by
 * normalized text; project + worktree scoped exactly like --commit-to's objective. Fails open.
 */
function promiseBookkeeping() {
  if (HOST !== 'claude' || !hookInput.session_id || hookInput.session_id === '*') return;
  try {
    const pid = projectIdentity.projectId;
    const at = new Date(nowMs).toISOString();
    let changed = false;
    if (completion.verdict === 'PASS') {
      for (const item of led.items) {
        if (!assistantCommitmentOwned(item, hookInput.session_id, projectIdentity)) continue;
        const claim = completion.claims.find((c) => claimClosesPromise(c.text, item.text));
        if (!claim) continue;
        Object.assign(item, { done: true, state: 'completed', doneAt: at, completionEvidence: { claim: claim.text,
          checks: completion.verification.checks.slice(-5).map((c) => c.what),
          transcript: String(hookInput.transcript_path || ''), sessionId: hookInput.session_id } });
        changed = true;
      }
    }
    const owned = led.items.filter((i) => assistantCommitmentOwned(i, hookInput.session_id, projectIdentity));
    const openKeys = new Set(owned.map((i) => i.key));
    let activeCount = owned.filter((i) => i.state === undefined || i.state === 'active').length;
    // Owner preference suppresses only new capture; verified closure above and integrity audits stay active.
    const newPromises = process.env.RUVNET_PROMISE_CAPTURE === 'off' ? [] : extractCommitments(hookInput.last_assistant_message);
    for (const promise of newPromises) {
      if (openKeys.has(promise.key) || activeCount >= PROMISE_CAP_OPEN) continue;
      openKeys.add(promise.key);
      activeCount += 1;
      led.items.push({ schemaVersion: 1, kind: PROMISE_KIND, text: promise.text, key: promise.key, done: false, state: 'active', at,
        projectId: pid, worktreeIds: [projectIdentity.worktreeId], sessionIds: [hookInput.session_id],
        capturedFrom: { sessionId: hookInput.session_id },
        authorization: { kind: 'owner-mandate', reference: 'i-will-is-a-contract-2026-09-15' } });
      changed = true;
    }
    if (changed) save(led);
  } catch { /* the ledger is advisory — never break a turn over it */ }
}
promiseBookkeeping();

/**
 * LOOP-SAFETY 2 (moved below the bookkeeping above, unchanged in effect): no request is ever
 * emitted on a stop that is already a continuation.
 */
if (hookInput.stop_hook_active) process.exit(EXIT_ALLOW);
// A terminal preference suppresses only its own nudge, never independent truth audits.
const objective = authorizedContinuationObjective(led.objective, hookInput, projectIdentity);

// LOOP-SAFETY 1b (GPT-5.6-Sol review) — an empty-but-parseable `{}` is NOT a real Stop payload; a genuine
// one carries `session_id` (a documented Stop input). Without it we cannot confirm a real stop, so we never
// force. This closes the empty-stdin hole that LOOP-SAFETY 1's `__source` check does not cover.
if (!hookInput.session_id) process.exit(EXIT_ALLOW);

/**
 * FINAL-ANSWER CAPABILITY TRUTH — the Stop boundary is the only place that can inspect the answer
 * the user is about to receive. The concrete failure this closes was an assistant saying
 * "Ruflo ADR Verify is not installed" while `ruflo-adr:adr-verify` was present in that host's own
 * installed skill inventory. A rule in the prompt did not prevent it; a byte-bound inventory does.
 *
 * This first receipt class is intentionally narrow: installed/registered/present claims about
 * RuvNet skills. It does not pretend to prove arbitrary natural-language capability claims. A
 * present source byte disproves an absence claim. A COMPLETE enumeration can disprove a presence
 * claim. An incomplete enumeration can prove neither, so the only allowed verdict is UNKNOWN.
 */
function capabilityClaimWork() {
  const message = String(hookInput.last_assistant_message || '');
  if (!message) return [];
  try {
    const receipt = buildCapabilityInventoryReceipt();
    const audit = auditCapabilityClaims(message, receipt);
    const evidenceAudit = auditCurrentCapabilityEvidence(message, { now: new Date(nowMs).toISOString() });
    const evidenceWork = [...evidenceAudit.contradictions, ...evidenceAudit.unresolved].map((finding) => ({
      text: evidenceAudit.contradictions.includes(finding)
        ? `RuvNet ${finding.class} claim "${finding.text}" contradicts fresh typed evidence: ${finding.reason || 'claim mismatch'}`
        : `RuvNet ${finding.class} claim "${finding.text}" is UNKNOWN: ${finding.reason}; verify the exact live/source surface before asserting it`,
      done: false,
      at: new Date(nowMs).toISOString(),
      derived: true,
      kind: 'capability-claim-integrity',
    }));
    if (audit.verdict === 'PASS') return evidenceWork;
    if (audit.verdict === 'FAIL') {
      return [...audit.contradictions.map((finding) => ({
        text: finding.matchedRef
          ? `RuvNet capability claim "${finding.text}" contradicts the sealed ${audit.host} inventory: ${finding.matchedRef} is present at ${finding.sourcePath}`
          : `RuvNet capability claim "${finding.text}" contradicts the complete sealed ${audit.host} inventory: no matching installed capability exists`,
        done: false,
        at: new Date(nowMs).toISOString(),
        derived: true,
        kind: 'capability-claim-integrity',
      })), ...evidenceWork];
    }
    return [...audit.unresolved.map((finding) => ({
      text: `RuvNet capability claim "${finding.text}" is UNKNOWN because the ${audit.host} inventory is incomplete; verify the live host before asserting absence`,
      done: false,
      at: new Date(nowMs).toISOString(),
      derived: true,
      kind: 'capability-claim-integrity',
    })), ...evidenceWork];
  } catch {
    // The Stop hook remains fail-open on machinery failure. The receipt builder represents
    // ordinary incomplete enumeration as UNKNOWN; reaching this catch means the gate itself broke.
    return [];
  }
}

/**
 * ARTIFACT-DERIVED OPEN WORK — the half that cannot be forgotten.
 *
 * WHY THIS EXISTS, measured rather than supposed. On 2026-08-04 the owner asked why the model had
 * gone back to stopping early, and the ledger answered: 25 items, ZERO open, last written 2026-07-25.
 * The gate had been structurally silent for ten days. Not broken — starved.
 *
 * The cause is the design, not the drift. Until now the ONLY source of "is work outstanding" was
 * `--commit-to`, i.e. the model noticing its own commitment and recording it. So the guard against
 * the model stopping early depended on the model remembering to arm it, and the failure mode is
 * silent in exactly the sessions where it matters most. That is this project's oldest rule broken
 * inside the mechanism meant to enforce it: status must be DERIVED FROM A VERIFIABLE ARTIFACT,
 * never asserted.
 *
 * So the gate now also reads work that exists whether or not anyone remembered to write it down.
 * `open-issues.json` is produced by the issue-watch pipeline against the real repo; an issue past
 * its response SLA is outstanding work by definition, and no amount of forgetting can erase it.
 *
 * Deliberately narrow: ONLY SLA breaches, never the full backlog — a permanently non-empty backlog
 * would make this fire forever, which is nagging, not enforcement. And only a FRESH observation
 * (<6h, the same window session-start-core uses), because a stale file is not evidence of anything.
 */
function artifactOpenWork() {
  try {
    const file = process.env.RUVNET_OPEN_ISSUES_FILE
      || path.join(HOME, '.cache', 'ruvnet-brain', 'open-issues.json');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ownsRepo(status?.repo)) return [];   // another repo's backlog is not this project's work
    const observedAt = Date.parse(status?.at || '');
    if (!Number.isFinite(observedAt) || nowMs - observedAt > 6 * 3600_000) return [];
    return (Array.isArray(status.issues) ? status.issues : [])
      .filter((issue) => issue?.breach)
      .map((issue) => ({
        text: `issue #${issue.number} on ${status.repo} is ${issue.ageHours}h past its response SLA — ${String(issue.title || '').slice(0, 80)}`,
        done: false,
        at: new Date(observedAt).toISOString(),
        derived: true,
      }));
  } catch { return []; }
}

/**
 * RED CI IS OUTSTANDING WORK. Added 2026-08-06, after the owner asked "is it working? I'm still
 * getting GitHub errors" while `ci` was red on main and this gate said nothing.
 *
 * The SLA source above only knows about ISSUES. A broken build on the branch users install from is
 * the most urgent kind of unfinished work there is, and it was the one kind the gate could not see —
 * so the model could finish a turn, report progress, and leave main red, which is exactly the
 * "stopping in the middle of the work" the owner is describing.
 *
 * Read from scripts/signal-watch.mjs's ci-status.json, whose header names it the SINGLE WRITER of
 * that file. Same discipline as the issues source: only a FRESH observation counts, and only a
 * RESOLVED-and-failed verdict — a run still in flight is not yet evidence of anything, and treating
 * it as such would nag through every normal build.
 */
function redCiOpenWork() {
  try {
    const file = process.env.RUVNET_CI_STATUS_FILE
      || path.join(HOME, '.cache', 'ruvnet-brain', 'external-signals', 'ci-status.json');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    return Object.values(status || {})
      // Per ENTRY, not per file: this artifact genuinely mixes repositories (measured on this
      // machine — stuinfla/ruvnet-brain and stuinfla/AppealArmor rows sit side by side in it).
      .filter((d) => ownsRepo(d?.repo))
      .filter((d) => d?.state === 'resolved' && d.conclusion && d.conclusion !== 'success')
      .filter((d) => {
        const at = Date.parse(d.checkedAt || '');
        return Number.isFinite(at) && nowMs - at <= 6 * 3600_000;
      })
      // one item per workflow, not per run — the same red build observed twice is one job to do
      .filter((d) => (seen.has(d.workflowName) ? false : seen.add(d.workflowName)))
      .map((d) => ({
        text: `CI is RED on ${d.repo}: ${d.workflowName} concluded ${d.conclusion} at ${String(d.ref || '').slice(0, 7)}`,
        done: false,
        at: d.checkedAt,
        derived: true,
      }));
  } catch { return []; }
}

/**
 * AN OPEN PR IS UNFINISHED WORK — the third source, added 2026-08-06.
 *
 * WHY, precisely. The two sources above cover an issue past its SLA and a red build. Neither covers
 * the most common shape of half-finished work there is: a pull request sitting open and green, one
 * `gh pr merge` from done. Measured that day — #117, #118 and #119 were opened, every required check
 * passed, and this gate stayed silent at the Stop boundary. It was not malfunctioning: `open` was
 * genuinely empty, because a PR is neither an issue nor a CI failure and nothing had been written to
 * the ledger. The owner asked "why the hell have you stopped?" and the honest answer was that the
 * gate could not see the work. A rule in a memory file cannot fix that; a source can.
 *
 * Read from open-issues.json's `prs` array, produced by scripts/issue-watch.mjs — the same file, the
 * same single producer, the same freshness window as the issues source. No `gh` call happens here:
 * a Stop hook must not depend on the network, and an artifact that cannot be read is not evidence.
 *
 * NARROW ON PURPOSE, so this can never become a permanent nag:
 *   - `passing` → actionable: merge it. `failing` → actionable: fix it.
 *   - `pending` → NOT actionable, and deliberately silent. A run in flight is not yet evidence,
 *     exactly as redCiOpenWork treats an unresolved run. Waiting for CI is not stopping early.
 *   - `none` (no checks at all) → treated as actionable, because nothing will ever arrive to
 *     resolve it; leaving it open is a decision someone has to make, not a wait.
 *   - drafts are already excluded by the producer.
 * The item self-clears the moment the PR merges or closes, so unlike a ledger entry there is nothing
 * to remember to mark done — which is the failure that produced this gap in the first place.
 */
function openPrWork() {
  try {
    const file = process.env.RUVNET_OPEN_ISSUES_FILE
      || path.join(HOME, '.cache', 'ruvnet-brain', 'open-issues.json');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ownsRepo(status?.repo)) return [];   // never send a stranger to merge our pull requests
    const observedAt = Date.parse(status?.at || '');
    if (!Number.isFinite(observedAt) || nowMs - observedAt > 6 * 3600_000) return [];
    return (Array.isArray(status.prs) ? status.prs : [])
      .filter((pr) => pr && pr.checksState !== 'pending')
      .map((pr) => ({
        text: pr.checksState === 'failing'
          ? `PR #${pr.number} on ${status.repo} is RED (${pr.failing} failing check(s)) — fix it, do not leave it open: ${pr.title}`
          : `PR #${pr.number} on ${status.repo} is open and its checks are ${pr.checksState === 'none' ? 'not configured' : 'GREEN'} — merge it or say why not: ${pr.title}`,
        done: false,
        at: new Date(observedAt).toISOString(),
        derived: true,
      }));
  } catch { return []; }
}

/**
 * WHAT GITHUB EMAILS THE OWNER, HE SHOULD NOT HAVE TO RELAY. Fourth source, 2026-08-06.
 *
 * GitHub PUSHES Dependabot, secret-scanning and code-scanning findings to his inbox. Nothing pulled
 * them into the session, so the only path from "GitHub found a vulnerability" to "the agent knows"
 * was the owner reading an email and typing it out. His words: "that stuff that keeps coming to me
 * as an email that I seem to have to tell you and you don't know."
 *
 * A published npm package and a signed bundle make this the highest-consequence blind spot of the
 * four — an unpatched advisory ships to every user of the plugin.
 *
 * NARROW, so it stays a signal rather than a backlog:
 *   - only HIGH and CRITICAL. A permanently non-empty low-severity list is a nag, and this gate is
 *     worthless the moment it is ignored. Lower severities still reach the Console and the inbox.
 *   - secret-scanning is ALWAYS included regardless of severity: a live credential in a public repo
 *     is never "medium", and it is the one finding where minutes matter.
 *   - collapsed to ONE item per kind, with a count. Twelve advisories is one job — "patch the
 *     advisories" — not twelve reasons to refuse to stop.
 */
function securityAlertWork() {
  try {
    const file = process.env.RUVNET_OPEN_ISSUES_FILE
      || path.join(HOME, '.cache', 'ruvnet-brain', 'open-issues.json');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ownsRepo(status?.repo)) return [];   // GitHub emailed the OWNER of that repo, not this one
    const observedAt = Date.parse(status?.at || '');
    if (!Number.isFinite(observedAt) || nowMs - observedAt > 6 * 3600_000) return [];
    const alerts = (Array.isArray(status.securityAlerts) ? status.securityAlerts : [])
      .filter((a) => a && (a.kind === 'secret-scanning' || a.severity === 'high' || a.severity === 'critical'));
    if (!alerts.length) return [];
    const byKind = new Map();
    for (const a of alerts) {
      if (!byKind.has(a.kind)) byKind.set(a.kind, []);
      byKind.get(a.kind).push(a);
    }
    return [...byKind.entries()].map(([kind, list]) => ({
      text: `${list.length} open ${kind} alert(s) on ${status.repo} — GitHub has already emailed these; highest: ${list[0].title}`,
      done: false,
      at: new Date(observedAt).toISOString(),
      derived: true,
    }));
  } catch { return []; }
}

const observations = [...artifactOpenWork(), ...redCiOpenWork(), ...openPrWork(), ...securityAlertWork()];
if (observations.length) console.error(JSON.stringify({ kind: 'continuation-advisory',
  authority: false, items: observations.map(({ text, at }) => ({ text, at })) }));
// ONE correction per turn: a single item however many claims the answer made; the stop_hook_active
// exit and the cooldown lock below bound it to one request per stop episode.
const completionWork = ['FAIL', 'UNKNOWN'].includes(completion.verdict) ? [{
  text: `You claimed "${completion.claims[0].text.slice(0, 160)}" is done; ${completion.problems.join('; ')}. Run the real consumer path, or restate it as UNVERIFIED.`,
  at: new Date(nowMs).toISOString(), derived: true, kind: 'completion-claim-integrity',
}] : [];
const promiseWork = HOST === 'claude'
  ? authorizedPromiseItems(led.items, hookInput, projectIdentity)
    .map((i) => ({ text: `you said you would: ${i.text}`, at: i.at, kind: PROMISE_KIND }))
  : [];
const open = [...capabilityClaimWork(), ...completionWork,
  ...(objective ? [{ text: objective.text, at: objective.at }] : []), ...promiseWork];
if (!open.length) process.exit(EXIT_ALLOW);   // nothing outstanding: silence is correct

/**
 * FRESHNESS (ADR-043 / Fable #3, tightened by GPT-5.6-Sol) — only FORCE for work with a VALID, recent
 * timestamp. A missing or unparseable `at` is treated as STALE and NOT forced: a real item always carries
 * an `at` (set by --commit-to), so only a malformed/legacy row lacks one, and forcing forever on an item of
 * UNKNOWN age is exactly the fabrication-pressure this guard exists to stop.
 */
// CORRECTED 2026-07-24, SAME DAY IT WAS INTRODUCED — and it had already broken the gate for ~30 hours.
//
// The guard above was written to stop "forcing forever on an item of UNKNOWN age." That intent is
// right and is preserved: a row with a missing or unparseable `at` is still refused, because an item
// of unknown age can nag forever with no evidence it is real.
//
// What shipped was different and wrong: `(nowMs - t) < 24h` ALSO discarded items with a perfectly
// VALID timestamp that were merely old. Measured on this machine: four genuinely-open commitments
// aged 53-56h, `forceable` came back empty, and the gate exited EXIT_ALLOW in silence. The owner's
// single most emphatic standing rule — "do not stop until it is done" — was enforced by a mechanism
// that had quietly switched itself off, and the only symptom was nothing happening.
//
// The inversion is the lesson: OLD OPEN WORK IS THE CASE THAT MOST NEEDS THE NUDGE. Work finished in
// an hour never reaches this gate. Work still open after two days is exactly what gets forgotten, and
// treating age as a reason for silence hands the failure mode a timer. It is the same shape as every
// other defect found today — silence standing in for a measurement — committed inside the guard whose
// whole job is to prevent stopping early.
//
// So: age no longer gates DELIVERY, it decorates it. An old item is still forced, and the nudge SAYS
// how old it is, which is information the reader needs rather than a reason to withhold. If a ledger
// is genuinely abandoned, the honest fix is to mark its items done — not to let a clock silently
// decide the commitment expired.
const forceable = open.filter((i) => Number.isFinite(Date.parse(i.at)));
if (!forceable.length) process.exit(EXIT_ALLOW);

/**
 * Age, only ever used to LABEL an item — never to suppress one. See the note above.
 *
 * The VERB is part of the honesty, not decoration. A ledger row was `committed` to — the model
 * agreed to it, and that agreement is what makes stopping a defect. A derived row was `observed`:
 * its `at` is when the watcher last looked at GitHub, and nobody promised anything. Printing
 * "committed 2h ago" against a Dependabot PR states an agreement that was never made.
 */
const ageLabel = (i) => {
  const h = (nowMs - Date.parse(i.at)) / 3_600_000;
  if (h < 1) return '';
  const verb = i.derived ? 'observed' : 'committed';
  if (h < 24) return ` (${verb} ${Math.round(h)}h ago)`;
  return ` (${verb} ${Math.round(h / 24)}d ago — still open)`;
};

/**
 * LOOP-SAFETY 3 (belt-and-braces this file OWNS — Fable #1, made fail-closed + race-safe by the GPT-5.6-Sol
 * review). Claim the force ATOMICALLY via an exclusive-create lock that doubles as the cooldown marker:
 *   - a fresh lock (another force within COOLDOWN_MS, incl. a concurrent second Stop hook) → do NOT force;
 *   - the claim cannot be persisted → do NOT force (fail CLOSED — never a force we could not record);
 *   - exclusive create (`wx`) serialises two racing hooks so they can never both win.
 * This replaces a read-lastForcedAt-then-write that failed OPEN on a write error and let two hooks race.
 */
const COOLDOWN_MS = Number(process.env.RUVNET_CONTINUATION_COOLDOWN_MS ?? 20000);
const episode = crypto.createHash('sha256').update(JSON.stringify([projectIdentity.projectId, projectIdentity.worktreeId,
  hookInput.session_id, led.objective?.id ?? null, hookInput.turn_id ?? String(hookInput.last_assistant_message || '')])).digest('hex');
const LOCK = LEDGER + '.cooldown.' + episode;
function claimCooldown(now, windowMs) {
  try {
    const prev = Date.parse(fs.readFileSync(LOCK, 'utf8'));
    if (Number.isFinite(prev) && (now - prev) < windowMs) return false; // fresh lock: someone forced recently
    fs.unlinkSync(LOCK);                                                 // stale: clear it so we can re-claim
  } catch { /* no lock yet */ }
  try { fs.writeFileSync(LOCK, new Date(now).toISOString(), { flag: 'wx' }); return true; }
  catch { return false; }                                               // lost the race / cannot persist → fail closed
}
if (!claimCooldown(nowMs, COOLDOWN_MS)) process.exit(EXIT_ALLOW);

/**
 * DELIVERY. `additionalContext` in a Stop envelope forces the continuation (same protection as
 * decision:block). Directive copy — continue, do not look for an exit.
 */
/**
 * SAY WHAT THESE ACTUALLY ARE (2026-08-14). One header served both halves and it said "You have
 * unfinished work you committed to" — true of a ledger row, FALSE of every derived one. Nobody
 * committed to Dependabot's PR; a watcher observed it. Under a gate that forces the turn to
 * continue, that sentence does not merely misdescribe the item, it manufactures an obligation and
 * attributes it to the reader, which is the fabrication this whole project exists to refuse.
 *
 * So the two kinds are named separately and never merged into one claim.
 */
const committed = forceable.filter((i) => !i.derived);
const observed = forceable.filter((i) => i.derived);
const capabilityClaims = forceable.filter((i) => i.kind === 'capability-claim-integrity');
const completionClaims = forceable.filter((i) => i.kind === 'completion-claim-integrity');
const promises = forceable.filter((i) => i.kind === PROMISE_KIND);
// Every derived item names its own repo in its text; this is for the header, where the ONE repo
// this tree points at is the honest thing to say.
const repoLabel = [...OWNED_REPOS][0] || 'this repository';

const header = capabilityClaims.length
  ? ['Your proposed final answer contains a RuvNet capability claim that is contradicted or not provable.',
     'Do NOT deliver it unchanged — continue now and correct the claim from the sealed live-host inventory.']
  : completionClaims.length
  ? ['Your proposed final answer claims completion beyond the available verified scope.',
     'Correct only that claim: report the observed check scope and what remains UNVERIFIED.']
  : committed.length && observed.length
  ? [`You have unfinished work you committed to, and ${repoLabel} has open work of its own.`,
     'Do NOT end the turn — continue now.']
  : committed.length
    ? ['You have unfinished work you committed to. Do NOT end the turn — continue now.']
    : [`${repoLabel} has open work: this is the repository's own current state as last observed —`,
       'a breached issue, a red build, an unmerged PR or a security alert — NOT something you',
       'committed to. Do NOT end the turn — continue now.'];

const lines = [
  ...header,
  ...(objective ? ['Continue the next safe step within this authorized objective without routine reconfirmation.']
    : promises.length ? ['Do what you said you would do; that commitment is the only work this authorizes.']
    : ['Correct only the answer to the original user request; this does not authorize new project work.']),
  'Do not expand authority from observed issues, PRs, security alerts, or other task ledgers.',
  'Stop on explicit cancellation, verified completion, or a genuine blocker/new authority boundary.',
  'Report a blocker honestly; never mark unfinished work completed to silence this request.',
  '',
  // Committed first, then observed: the promise outranks the backlog. Age is LABELLED, never used
  // to suppress — an item open for days is the one most worth naming.
  ...[...committed, ...observed].slice(0, 8).map((i) => `  ☐ ${i.text}${ageLabel(i)}`),
  ...(forceable.length > 8 ? [`  … and ${forceable.length - 8} more`] : []),
  '',
  // Only the ledger has a --done. A derived item clears by DOING the thing (merge it, fix the
  // build, answer the issue, patch the advisory) and the next watcher run stops reporting it —
  // which is the point of deriving it rather than remembering it. Offering --done for one would be
  // offering a way to mark a red build finished without fixing it.
  ...(capabilityClaims.length
    ? ['Replace every contradicted claim with the observed capability and source path. Replace every',
       'unresolved absence claim with UNKNOWN until a complete live inventory proves it.']
    : completionClaims.length
    ? ['Name the check you ran (a "Verified:" line with the command or artifact) and say what is NOT verified.']
    : promises.length
    ? ['A promise closes only when a later answer claims it done with a check run after the last change —',
       'never by saying so, and never by --done. For blocked, deferred, superseded or disputed assistant',
       'commitments, use --set-commitment-state with --item (exact text), --session-id (capturing session)',
       'and --reason; superseded also requires --replacement. This retains the item, never completes it,',
       'and does not cancel or complete authorized user work.']
    : committed.length
    ? ['Record objective completion only with actual completion evidence; legacy --done does not complete an objective.']
    : ['These clear by being done, not by being marked: merge or fix the PR, get the build green,',
       'answer the issue, patch the advisory. The next observation stops listing them.']),
  // THE HONEST EXIT, and it is what makes forcing old items safe.
  //
  // Fable's red-team #3 was right that a stale item pressuring every turn "breeds
  // mark-done-without-doing". The first answer to that was a 24h TTL — which silently disabled the
  // gate on genuine multi-day work (measured 2026-07-24: four real commitments, 53-56h old, gate mute
  // for ~30 hours). Both failure modes are real, and they are not opposites: the pressure to fake a
  // completion comes from being nagged with NO LEGITIMATE WAY OUT.
  //
  // So the resolution is neither silence nor endless nagging: keep forcing, and name the honest
  // disposal out loud. An item that is genuinely dead gets cleared — a deliberate, recorded act —
  // instead of expiring on a timer nobody sees, or being falsely marked done to stop the noise.
  // COMMITTED items only. A derived item is at most 6h old by construction (the freshness window),
  // and "clear it, that is a legitimate answer" is advice about a promise — you cannot clear a red
  // build by declaring it no longer real.
  ...(committed.some((i) => i.kind !== PROMISE_KIND && (nowMs - Date.parse(i.at)) > 24 * 3_600_000)
    ? ['', 'Some of these are days old. If one is genuinely no longer real, say so and CLEAR it —',
       'that is a legitimate answer and the right one. What is never acceptable is marking it done',
       'without doing it, or letting it age quietly out of view.']
    : []),
];

process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
