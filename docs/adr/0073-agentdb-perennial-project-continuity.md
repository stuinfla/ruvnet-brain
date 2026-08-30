---
id: ADR-073
title: AgentDB is the complete perennial project continuity record
status: Accepted
date: 2026-08-22
updated: 2026-08-22
authors: [Stuart Kerr, Codex]
tags: [architecture, agentdb, continuity, hosts, recovery, durability]
supersedes: []
relates: [ADR-051, ADR-070, ADR-072]
governs:
  - docs/ddd/0019-project-continuity-context.md
  - plugin/scripts/project-progression-contract.mjs
  - plugin/scripts/project-progression-hook.mjs
  - plugin/hooks/hooks.json
  - plugin/hooks/codex-hooks.json
  - tests/unit/project-progression-contract.test.mjs
  - tests/integration/project-progression-hook.test.mjs
  - tests/acceptance/cross-host-project-resume.test.mjs
---

# ADR-073 — AgentDB is the complete perennial project continuity record

**Status**: Accepted

Accepted by Stuart's 2026-08-22 direction. Implementation and cross-host proof are required before
this behavior may be described as working or shipped.

## Context

RuvNet Brain promises perennial project memory, but the current product does not satisfy that
promise. Lifecycle hooks write metadata-only snapshots to a JSONL fallback, while meaningful
implementation progression depends on a model remembering to call `ruflo memory store`. Session
startup reads only an older append-only `project-state-current-*` checkpoint. A Codex session can
therefore contain the exact work in its private transcript while another supported host cannot
reconstruct the current plan, completed work, failure boundary, or next action from the canonical
project AgentDB.

This is not an acceptable eventual-consistency tradeoff. A store that accepts manual writes but does
not durably capture and restore the latest project state at every observable transition is not
functioning as the product's perennial continuity system.

## Decision

### 1. Binary continuity contract

For every AgentDB-enabled project, `<project>/.swarm/memory.db` is the sole canonical structured
continuity record. A host is conformant only when all of the following are true:

1. Every observable project transition is persisted before the host acknowledges that boundary.
2. The append is read back by exact key from the same absolute AgentDB path.
3. A fresh supported host restores the newest coherent checkpoint automatically at `SessionStart`.
4. Restoration does not depend on semantic search, a private host transcript, a daemon, raw SQLite,
   model discretion, or a clean shutdown.
5. Concurrent sessions cannot overwrite or hide one another's progression.

If any clause fails, perennial project continuity is **not working**. A fallback file, a CLI success
line, or an unrelated successful AgentDB row does not make the product conformant.

### 2. Complete project progression

The durable record is an append-only journal of full aggregate snapshots. Each snapshot preserves:

- project identity, canonical AgentDB path, checkout/worktree, branch, exact source identity, and
  dirty-tree digest;
- host, session, trigger, deduplication identity, causal parents, monotonic sequence, timestamp, and
  payload digest;
- current user goal and acceptance contract;
- named plan/processes, current process and step, completed work, in-progress work, blockers,
  failures, decisions, changed files, commands and substantive outcomes, proof artifacts, untested
  scope, and the exact next action;
- references to originating transcripts or artifacts as evidence, never as the only resumable copy.

The journal captures observable inputs and outcomes available at hook boundaries. Credentials,
tokens, private keys, and recognized secrets are redacted before persistence; redaction is recorded
explicitly so it cannot be mistaken for complete evidence. Mid-token private model state is not
observable project progression and is outside the contract.

### 3. Mandatory capture boundaries

One product-owned progression bridge is called by every supported host adapter at:

- `SessionStart`: replay the outbox, structurally enumerate snapshots, exact-retrieve the newest
  coherent state, and inject it before work begins;
- `UserPromptSubmit`: persist new intent and acceptance changes before execution;
- `PreToolUse`: persist the intended consequential mutation before it may run;
- `PostToolUse`: persist each consequential command, edit, external mutation, and substantive result;
- `Stop`, `SubagentStop`, `PreCompact`, and `SessionEnd`: persist reconciled state and the open next
  action before control leaves the session.

The bridge owns normalization, redaction, ordering, storage, exact readback, and restoration.
Model-authored summaries may enrich the record but are never required for durability.

### 4. Append-only identity and deterministic restoration

Keys are globally collision-resistant and sortable:

`project-progress-v1-<project-id>-<host>-<session>-<sequence>-<dedup-digest>`

No state row is updated. The bridge uses managed Ruflo memory commands against one resolved absolute
path:

1. `ruflo memory store` strictly inserts a new immutable key in a dedicated project-progression
   namespace.
2. `ruflo memory retrieve --value-only` reads back that exact key and verifies its payload digest.
3. `ruflo memory list --format json` structurally enumerates snapshots at restore time.
4. The reducer validates schema, project identity, causal ancestry, and digests before selecting or
   merging maximal heads.

Timestamp alone never resolves concurrency. Independent heads are preserved and deterministically
merged. Conflicts remain explicit in `resumeConflicts[]`; no writer silently wins. Malformed,
foreign-project, unverifiable, or causally stale entries remain rejected evidence and are never
injected as current state. If structural listing cannot enumerate the complete namespace, that
managed capability must be extended; semantic search and raw SQL are prohibited fallbacks.

### 5. Crash safety and outbox

Before invoking AgentDB, the bridge appends the canonical snapshot to a permission-restricted
project-local JSONL outbox and fsyncs it. After exact-key readback, it appends a committed marker.
Every later hook, beginning with `SessionStart`, replays uncommitted snapshots idempotently.

The outbox is recovery transport, not alternate memory authority. It is compacted only after every
entry has an exact AgentDB receipt. A crash may delay acknowledgement; it may not silently discard a
transition.

### 6. Cross-host requirement

Codex and Claude Code must consume the same bridge and canonical database now. Grok Build must use
the same contract before it is advertised as a lifecycle host; model-provider routing alone is not a
host adapter. Host-private session stores remain diagnostic evidence only.

RuvNet Brain activation in a writable project is explicit adoption. If `.swarm/memory.db` is absent,
SessionStart initializes it through managed Ruflo memory before work begins. A read-only or
non-project context surfaces `continuity-unavailable`; silent no-op is prohibited.

### 7. Compaction and cleanup

Compaction appends a full snapshot citing the exact event range and digests it summarizes. Older
minutiae may be removed only after the replacement has exact AgentDB readback, an independent restore
reproduces the same state, and retention appends its own receipt. Cleanup may never remove the only
evidence for current state, unresolved decisions, failures, side effects, or next action.

## Failure semantics

- Store failure, exact-readback failure, or digest mismatch: fail closed and retain a replayable
  outbox snapshot; never report capture success.
- Restore miss with verified progression: continuity is red; surface rejected candidates instead of
  beginning with empty context.
- Missing host wiring: that host is unsupported for continuity.
- Concurrent heads: inject the deterministic merged view and all unresolved conflicts.
- Secret detection: redact values, retain type/location and surrounding outcome, and mark the event.

## Acceptance

An isolated packed-artifact test performs real work in one host, kills it without `SessionEnd`, then
starts each other supported host and proves automatic receipt of the exact goal, plan, completed
actions, failure boundary, dirty source identity, blockers, and next action from one AgentDB path.
It repeats with concurrent writers, a killed write, corrupt outbox tail, semantic search returning
zero, and unavailable private transcripts.

Agentic QE evaluates adherence to this intent, not test count. Any omitted transition, model
discretion, manual resume step, alternate store, or unverified readback is a release blocker.

## Consequences

- AgentDB grows faster; verified compaction controls storage without weakening recovery.
- Hook latency is measured, but durability remains mandatory.
- Existing metadata-only snapshots remain diagnostic and do not satisfy this ADR.
- ADR-072 gains a cross-cutting S-11 obligation without adding a ninth product process.

## Current implementation status

`Accepted, not yet proven.` The recovered checkpoint was written after the continuity failure. It is
recovery evidence, not proof of continuous capture or cross-host automatic restoration.

## Currency log

| Date | What changed | Why |
|---|---|---|
| 2026-08-22 | The shared host bridge now records bounded structured tool outcomes (action, result status, exit code, and substantive output) into each full snapshot, including failure evidence, without persisting the host prompt. | Lifecycle payloads previously depended entirely on a model-authored state extension and therefore could omit the observable result of a completed tool boundary. The bridge now captures that boundary evidence before exact AgentDB readback; cross-host crash acceptance remains unproven. |
| 2026-08-22 | Upstream Ruflo pagination commit `a0262e84` plus isolated export-path fix `55fe5603` were built and proven: structural pages traverse correctly and a fresh two-database export/import round trip restores both rows when the explicit path is honored. | S11 remains blocked for release acceptance because the fix is not installed in global Ruflo `3.38.19`; the strict cross-host contract is unchanged. Evidence: `docs/reviews/adr-072-s11-upstream-pagination.md` and `docs/reviews/adr-072-s11-upstream-export-path.md`. |
| 2026-08-22 | Re-read the complete source-side continuity path from capture through managed AgentDB store/outbox replay to both-host SessionStart restoration. | `916db4a`, `34d5aba`, `f364eef`, `1b30bab`, `b63c763`, and `adeba05` supply the validated snapshot, project-store resolver, durable outbox, bridge, restore core, and host lifecycle wiring. The focused SessionStart/version gate passes, and the production CLI now uses the canonical `.swarm` cwd. The named killed-process cross-host acceptance file remains absent and global Ruflo pagination fix `a0262e84` is not installed/released, so the ADR remains source-built but not acceptance-proven. |
| 2026-08-22 | Established the binary, host-neutral AgentDB continuity contract and fail-closed acceptance test. | Claude Code could not recover the active eight-process repair because current progression was absent from the automatically restored checkpoint stream. |
| 2026-08-22 | Recorded the pure progression snapshot, redaction, validation, and deterministic restoration core in `916db4a`, with canonical adapter-version fixtures in `faf458a` (16 focused tests; 51 with version/restated-truth gates). Host hooks, managed AgentDB transport, outbox replay, and cross-host crash acceptance remain unbuilt and unproven. | The domain contract moved after this ADR. This row binds the implemented slice without overstating the lifecycle behavior required for acceptance. |
