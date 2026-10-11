---
id: ADR-100
title: Guaranteed AgentDB continuity — material events, durable outbox, come-up-to-speed brief, one writer
status: Superseded
superseded_by: ADR-105
date: 2026-10-01
updated: 2026-10-10 22:01:00 EDT
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [agentdb, continuity, hooks, durability, memory]
supersedes: []
relates: [ADR-073, ADR-076]
version: 1.2.0
---

# ADR-100 — Guaranteed AgentDB continuity

**Status**: Superseded (in part by ADR-105 on 2026-10-10)

Prior status: Accepted (requirements reaffirmed by the owner on 2026-10-03). Superseded in part by [ADR-105](0105-one-agentdb-integration-standard.md): the §2 write command (now `--no-upsert --require-native --append-only --path`) and §3 deferral to a user-level writer; material events, outbox, brief and positive confirmation remain in force.

Implementation acceptance remains incomplete.

## Owner requirement

"Make sure that AgentDB is automatically being used everywhere, that hooks are set up to make that a
guarantee, not a suggestion, that everything material is being recorded in AgentDB, including all the
changes, all the learnings … go back and look at AgentDB and know everything we've done and instantly come
up to speed with correct, complete, and intelligent context."

## What was measured (2026-10-01, this repo's real `.swarm/memory.db`, read-only via node:sqlite, last 5 days)

| Happened | Recorded |
|---|---|
| 367 commits on all refs (198 on `main`) | 54 SHAs appear anywhere in AgentDB; no commit record exists |
| 20 tags (v4.3.29 → v4.4.0 and corpus releases) | 9 named anywhere |
| Owner corrections / standing rules (many, see auto-memory `feedback_*` written 09-29/30) | 0 `lesson-*` / `lessons` rows |
| Decisions | 3 hand-written `decision-*` rows |
| Turns | 624 `turns` rows for 323 distinct outcomes: the plugin writer (host-tagged, 295) and the owner's user-level `agentdb-turn-capture.mjs` (329) both record every Claude turn |
| Progression | 41 snapshots, ONE distinct goal across all of them; the restored head named `main@e89ea1ba` four hours after 4.4.0 (`1363b416`) shipped |
| Progression outbox | 4 snapshots fsynced and never committed (3 since 2026-09-18). Root cause: one 2026-09-18 key collision made `ProgressionOutbox.pendingSnapshots()` throw on every call; every caller swallowed it, so replay was dead for 13 days and the SessionStart notice read 0 pending |

Turn-capture receipts were checked against the store: 295/295 plugin writes in the window landed (no
silent loss in that window), but the path has no retry: a refusal is a receipt line, not a retry.

Grounding (search_ruvnet): `ruflo memory store`/`retrieve` refuse with "active native WAL connection —
refusing an unsafe sql.js whole-image write" while native WAL sidecars exist, and `getEntry` is itself a
whole-image mutator (access_count bump) — `ruflo/v3/@claude-flow/cli/src/memory/memory-initializer.ts`
(#2735, #2878); verify memory by store → retrieve, no manual SQL — `ruflo/v3/docs/releases/v3.32.34.md`.

## Decision

1. **Material events, typed and deduplicated** (`plugin/scripts/continuity-events.mjs`): `commit`,
   `release` (git, by SHA/tag — authoritative), `gate` (a test/check/release command and its tool-result
   exit outcome), `finding` (Agent/Task result text, non-authoritative), `decision` and `lesson` (explicit
   = authoritative; detected from the turn = `authoritative: false`), `open-item` (explicit). Each is
   redacted, bounded to 400 chars, and keyed `cevt-<UTC stamp>-<kind>-<content id>` so the same commit or
   rule is recorded once however many boundaries see it. User text is stored only for a detected owner
   correction/standing rule, bounded and redacted (`RUVNET_CONTINUITY_LESSON_DETECT=off` disables it).
2. **Guaranteed, not suggested** (`plugin/scripts/continuity-journal.mjs`): captured at the boundaries
   already registered on both hosts (Claude Stop/PreCompact/SessionEnd, Codex Stop/SessionEnd) through
   `session-snapshot-hook.mjs` — no new registration, so the ADR-076 failure (registering on events that do
   not exist and displacing the real capture boundaries) cannot recur. Every event is fsynced to
   `.swarm/continuity-events-outbox.jsonl` first; a detached drainer stores it with
   `ruflo memory store --no-upsert --path` (the only writer of memory.db), reads it back by exact key
   (read-only node:sqlite, CLI fallback) and only then writes a commit line. Refusals are retried with
   backoff; what is left stays durable for the next boundary. A malformed line or a key collision is
   quarantined and reported and never blocks other events. Codex SessionEnd does only git reads, one
   fsync and a spawn (measured 207 ms for 50 commits against a 1900 ms handed-down budget).
3. **One writer**: where the owner's `~/.claude/hooks/agentdb-turn-capture.mjs` is registered in
   `~/.claude/settings.json`, the product defers Claude turn records to it (`RUVNET_TURN_CAPTURE=force`
   keeps both). The user-level hooks are read, never edited. Handoff, documented rather than deduplicated:
   `.swarm/agentdb-sessions.jsonl` gets the plugin's versioned metadata receipt (read by the Console's
   freshness check) and the owner's outcome summary — two record types in one file, not one record twice.
   The owner's `agentdb-autocapture.mjs` writes namespace `sessions`, which the product does not write.
4. **Come up to speed** (`plugin/scripts/continuity-brief.mjs`): SessionStart prints, FIRST and within 3 KB,
   `[RuvNet Brain — COME UP TO SPEED …]`: branch/HEAD/version/latest tag (git, live), commits and releases
   since the last brief, decisions, standing rules/lessons, open items with owner (work ledger + explicit),
   latest gate outcomes, agent findings — each with its key and time or SHA — then the recording line and
   the command for more (`/ruvnet-brain:rnb-brief`, `continuity-brief.mjs --full|--record`). Owner
   `lesson-*` keys and `project-state-current` are left to `agentdb-ensure.sh` when it is registered.
5. **Positive confirmation**: `AgentDB: recording ✓ (last write Ns ago, N event(s) today, outbox N pending)`
   in the brief and `--doctor`; `✗ …` with the reason when stuck (pending > 10 min, quarantined, corrupt,
   store not initialized), also shown at Claude Stop as a `systemMessage`. Codex Stop prints nothing: its
   Stop `reason` becomes a BLOCK (`codex-hook-adapter.mjs`).
6. **Progression outbox repair**: `ProgressionOutbox.pendingSnapshots()` quarantines a disagreeing key
   (still never replayed — fail-closed for that key) instead of throwing for the whole file;
   `quarantinedKeys()` reports it.

### Amendments after the independent review (2026-10-01)

- **S1a** The owner-correction detector keeps only sentences with durable-rule phrasing ("from now on",
  "going forward", "never again", "standing rule", a sentence opening with Always / Never (not "never
  mind") / Remember that|to); ordinary task imperatives yield nothing (negative corpus in
  `tests/unit/continuity-events.test.mjs`). Detected lessons carry `detail.status: 'detected-unconfirmed'`.
- **S1b** The brief is model context: repo-controlled text is rendered inside a `PROJECT RECORD` fence as
  untrusted data (control/bidi characters and fence tokens stripped, capped). Only lessons recorded with
  `--record` on this machine — key and digest in an ownership ledger under the brain home, outside the repo
  — appear as STANDING RULES.
- **S2** Event text is redacted whole (including unterminated key blocks) before it is bounded.
- **S3/S4** Two observations of one event (same key) are one event, not a quarantine; a stored row that is
  the same kind:id commits. No store or no ruflo is "n/a", never ✗, and launches no drainer. Quarantine,
  corrupt lines and cap drops are reported for 7 days or until `continuity-brief.mjs --clear`; the Claude
  Stop line shows once per session per condition. Failures are one record per event; `compact()` rewrites
  the outbox atomically (append lock plus a size re-check so a concurrent append is never lost), ages out
  committed events after 7 days. The 2000-event target is a soft limit when accepted events remain
  pending: pending events and their failure counts survive, capacity pressure is reported, and a
  prolonged outage can grow disk usage. Measured before the fix: 300 pending
  events with no ruflo grew to 1200 / 2100 / 3000 lines over three simulated days; after: constant.

## Alternatives considered

- **Model-written summaries / a "remember to store" instruction.** Rejected: that is the suggestion the
  owner ruled out; it produced 3 decision rows in 5 days.
- **Extend the progression snapshot with these fields.** Rejected: the snapshot is a full aggregate
  rewritten at every boundary (6 KB each, no-op detection by meaning digest); appending history to it
  grows every row and makes dedupe per item impossible. Events are append-only and small.
- **A new hook registration per event (SubagentStop, PostToolUse on Bash).** Rejected for now: Codex
  PostToolUse on `exec_command` is unmeasured (codex-hooks.json), and every new registration is a new
  failure surface (ADR-076). The transcript at Stop already holds the tool results.
- **Write directly with SQLite / the MCP `memory_store` tool.** Rejected: raw SQL writes are forbidden
  (v3.32.34 "no manual SQL"), and the MCP tools persist to a different file (`agentdb-memory.db`).
- **Edit the owner's user-level hooks to make the product the single writer.** Rejected: the product
  never modifies user-owned configuration; it detects and defers.

## Consequences and what this does NOT do

- Agent findings and gates are parsed from Claude JSONL only; Codex records commits, releases, and
  decisions/lessons from `last_assistant_message`.
- Detected decisions/lessons are pattern-matched and can miss or over-match; they are marked `detected`.
- The progression event-key collision (same session, sequence and dedup id at two boundaries) is now
  contained, not fixed at its source (`project-progression-contract.mjs` `eventKeyFor`).
- The outbox is compacted by the implemented journal; its measured recovery and retention scope still governs acceptance; at the measured rate (tens of events/day, ~1 KB each) that is months.
- Restore context (progression JSON, ≤ 8 KB) plus the brief (≤ 3 KB) can exceed a host's inline preview;
  the brief is first so it survives a cut.

## Implementation hardening (2026-10-03)

ADR status remains **Proposed**; this repair does not claim publication or complete continuity.
Turn capture now reuses the canonical project-store resolver and shared secret/private-key redaction,
with no implicit global store fallback. Persisted canonical-project/path consent is reread per boundary;
an absent store requires explicit opt-in. Turn breadcrumbs contain only key, digest, length and time.
The detached writer verifies exact key/content readback and preserves a redacted first stderr line on
failure; SessionStart and doctor expose recent turn failures separately from the material-event success
line. Historical raw records and owner-managed user-level capture hooks are not rewritten.

Evidence: `tests/e2e/closure/G-001.probe.mjs`, `G-002.probe.mjs`, and `G-014.probe.mjs` run the real
detached process boundary against the global Ruflo CLI in isolated homes (synthetic credentials only).
These local process results are not published closure receipts.

## Candidate durability correction (2026-10-03)

The bounded candidate stops deleting accepted pending events to satisfy the former cap and preserves complete final progression-outbox records without a newline. Torn-tail append fails explicitly without changing existing bytes; recovery remains manual. This supersedes the old cap claim and does not establish published all-host acceptance. Requirement acceptance is recorded separately above.

## 2026-10-03 automatic-memory amendment

The 4.5.4 candidate journals the redacted turn payload before spawning its writer, binds a stable
key to canonical project identity and consent, explicitly refuses upsert, and commits transport
only after exact key/content readback. Startup replays consent-eligible pending work before
restoring a checkpoint. Historical status-zero receipts without verification remain unverified;
they are not relabelled as explicit write failures or silently marked verified.

The four unsafe legacy Claude memory registrations were removed on the owner's machine under
explicit repair authorization, with the original configuration backed up and historical data and
hook bodies preserved. This is a machine repair, not an automatic product permission to edit
user-owned hooks elsewhere. The product's filename-based legacy-owner detection still does not
establish that an arbitrary external writer meets the canonical contract. Full ADR-073 conformity,
all-host native delivery and unrestricted semantic learning are not claimed by this amendment.


## 2026-10-10 perennial memory hardening

Material outcomes are recovered at Stop, SessionEnd and PreCompact, including bounded native Codex transcript records. Short strategic decisions are independently captured as unconfirmed observations. Continuity, turn and progression writes require native immutable insertion; generic refusals cannot be acknowledged from an older matching row. Only a verified strict duplicate may be replayed idempotently. Unreadable outbox is unavailable, never empty. The constructor never deletes existing AgentDB stores. Prompt recall includes relevant typed continuity decisions/lessons/open items, with provenance and current privacy exclusions.

Implementation acceptance is pending final source-bound and native-host verification.
