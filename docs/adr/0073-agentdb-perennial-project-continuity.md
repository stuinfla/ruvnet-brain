---
id: ADR-073
title: AgentDB is the complete perennial project continuity record
status: Accepted
date: 2026-08-22
updated: 2026-09-17
version: 1.0.4
reviewed_digest: e37a5e907135
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

At this ADR’s adoption, RuvNet Brain promised perennial project memory but did not satisfy that
promise. Lifecycle hooks wrote metadata-only snapshots to a recovery transport, while meaningful
implementation progression depended on a model remembering to call `ruflo memory store`. Session
startup read only an older append-only `project-state-current-*` checkpoint. A Codex session could
therefore contain the exact work in its private transcript while another supported host could not
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

- `SessionStart`: read the outbox, report pending or unreadable transport, structurally enumerate
  snapshots, exact-retrieve the newest coherent state, and inject it before work begins;
- `UserPromptSubmit`: persist new intent and acceptance changes before execution;
- `PreToolUse`: persist the intended consequential mutation before it may run;
- `PostToolUse`: persist each consequential command, edit, external mutation, and substantive result;
- `Stop`, `SubagentStop`, `PreCompact`, and `SessionEnd`: persist reconciled state and the open next
  action before control leaves the session.

The current observed host wiring is asymmetric: Claude Code automatic capture covers `Stop`,
`PreCompact`, and `SessionEnd`; Codex automatic capture has been observed at `SessionEnd`. The
remaining event list is the contract target, not evidence that every host currently fires every
boundary. The explicit checkpoint command remains available when a host boundary is absent.

The bridge owns normalization, redaction, ordering, storage, exact readback, and restoration.
Model-authored summaries may enrich the record but are never required for durability.

The current SessionStart restore path is read-only for pending transport: it reports the count of
pending snapshots, or reports that the outbox is unreadable, and restores committed state without
replaying. Replay is reserved for the next capture boundary (`Stop`, `PreCompact`, or
`SessionEnd`) and the explicit `/checkpoint` command, which settle pending transport before a new
capture.

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

Timestamp alone never resolves concurrency. SessionStart may inject a deterministic merged view with
explicit `resumeConflicts[]`; automatic capture remains fail-closed while multiple heads exist.
Only an explicit reconciliation review may publish a descendant, and it must name the exact reviewed
head set. A reconciliation may explicitly select, replace, or clear a selectable field; clearing
`currentGoal` or `nextAction` remains cleared against carried notes, while a newer ledger value may
override the reviewed value and is disclosed in the receipt's `supersededByLedger` list. Malformed,
foreign-project, unverifiable, or causally stale entries remain rejected evidence and are never
injected as current state. If structural listing cannot enumerate the complete namespace, that
managed capability must be extended; semantic search and ad hoc SQL must not substitute for complete
validated enumeration. The schema-checked in-process reader described above remains the supported
read path; all writes still use managed Ruflo.

### 5. Crash safety and outbox

Before invoking AgentDB, the bridge publishes the canonical snapshot to a permission-restricted
project-local per-record spool at `.swarm/project-progression-outbox.d/<32hex>.rec`. Each record is
written to an exclusive `.tmp`, checked for complete writes, fsynced, closed, and then published;
on POSIX every publisher syncs the ancestor directories even when they already exist, then syncs
the spool after publication;
temporary files are ignored and are never reclaimed by age. The legacy
`.swarm/project-progression-outbox.jsonl` remains a read-only compatibility import: complete lines
are parsed with physical line numbers, malformed complete lines fail closed, and an unterminated
tail is preserved. After exact-key readback, the bridge publishes a committed marker in the same
spool. The outbox is recovery transport, not alternate memory authority, and has no garbage
collector yet. A crash may delay acknowledgement; it may not silently discard a transition.

The POSIX process-crash path is covered by the implementation tests. Windows directory-entry
durability and power-loss recovery are untested; mixed-version processes that still append to the
legacy JSONL are unsupported during upgrade.

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
- Concurrent heads: inject the deterministic merged view and all unresolved conflicts; automatic
  capture skips until an explicit reconciliation publishes a reviewed descendant.
- Secret detection: redact values, retain type/location and surrounding outcome, and mark the event.

### Observation identity compatibility

New snapshots include `observationDigest`, computed at the shared snapshot boundary over the complete
redacted body and its redaction markers. Event identity includes that digest, so different timestamps,
parents, checkpoint fields, or tool outcomes cannot claim the same event key. Exact replay reuses the
stored snapshot unchanged. New capture requires the digest; historical rows and pending records without
it retain their original validation algorithm and keys when read or replayed.

Both hosts must receive this runtime together: an older reader cannot validate the new identity.
Concurrent observations may become separate heads, preserving both states and requiring explicit
reconciliation before automatic capture resumes. This prevents new identity collisions; it does not
rewrite or automatically settle a pre-existing legacy outbox collision. Existing poisoned records must
remain preserved until an explicit recovery protocol can account for both originals.

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
| 2026-09-17 | Clarified explicit reconciliation, selectable clear semantics, ledger precedence, and retry boundaries. | Restore-time merging is read-only context; automatic capture remains fail-closed, and only exact reviewed heads may be collapsed by explicit reconciliation. |
| 2026-09-17 | Updated the transport description to the per-record `.d` spool with read-only legacy JSONL import, explicit SessionStart pending/error reporting, capture-boundary replay, and current Claude/Codex event observations. | The recovery transport now publishes immutable records; temporary files are ignored, complete malformed lines fail closed, there is no GC, mixed legacy writers are unsupported, and Windows directory-entry/power-loss durability remains untested. This documentation change does not claim the cross-host acceptance or full-QA contract is complete. |
| 2026-09-17 | Reviewed continuity obligations and governed capture/restore paths at integration HEAD; recovery evidence remains distinct from continuous cross-host proof. | `plugin/scripts/project-progression-contract.mjs`; reviewed_digest e37a5e907135. |
| 2026-09-11 | Currency review at commit 7296c984: decision unchanged and reinforced; one incident recorded. §3's capture boundaries were removed from `plugin/hooks/hooks.json` at `76632b15` (`session-snapshot` at Stop, PreCompact and SessionEnd dropped) and restored at `9c45d408` (the 85f584b2 plane); `7b8e6e73` added three grounding gates beside them; `codex-hooks.json` likewise. `plugin/scripts/project-progression-contract.mjs` and `-hook.mjs`: `1a548936` (pre-session — the snapshot §2 requires is now built at the boundaries) and `6a6ba72f` (2026-09-07); `tests/acceptance/cross-host-project-resume.test.mjs` `c54e33a1`. Incident: `.swarm/memory.db`, §1's sole canonical record, was deleted ten times at 14:37 by a session script (`scripts/performance-baseline.mjs` via `npm run bench`, commit `fe3f3458`) and restored at 15:41 from `ruflo memory backup`'s 13:58 snapshot plus the six post-wipe rows (2,155 → 6 → 2,161; `pragma quick_check` ok; store → exact-key retrieve → SQLite probe passed). The script and its tests were deleted (`a26d3c05`), and `tests/unit/no-real-store-path-in-tests.test.mjs` (`72def28e`) now fails any test that names the real store path. §1 clause 4 held: restoration used the product's own backup, not a transcript. | Reviewed `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `plugin/scripts/project-progression-contract.mjs`, `plugin/scripts/project-progression-hook.mjs`. reviewed_digest ab0caaff7c62. |
| 2026-08-31 | Added an explicit `runHeartbeat` seam to the shared SessionStart caller and disabled detached update checks in the deterministic continuity integration test. | Background updater children were racing fixture cleanup and causing `ENOTEMPTY`; continuity behavior and background-worker behavior now have separate, deterministic test boundaries. |
| 2026-08-22 | The shared host bridge now records bounded structured tool outcomes (action, result status, exit code, and substantive output) into each full snapshot, including failure evidence, without persisting the host prompt. | Lifecycle payloads previously depended entirely on a model-authored state extension and therefore could omit the observable result of a completed tool boundary. The bridge now captures that boundary evidence before exact AgentDB readback; cross-host crash acceptance remains unproven. |
| 2026-08-22 | Upstream Ruflo pagination commit `a0262e84` plus isolated export-path fix `55fe5603` were built and proven: structural pages traverse correctly and a fresh two-database export/import round trip restores both rows when the explicit path is honored. | S11 remains blocked for release acceptance because the fix is not installed in global Ruflo `3.38.19`; the strict cross-host contract is unchanged. Evidence: `docs/reviews/adr-072-s11-upstream-pagination.md` and `docs/reviews/adr-072-s11-upstream-export-path.md`. |
| 2026-08-22 | Re-read the complete source-side continuity path from capture through managed AgentDB store/outbox replay to both-host SessionStart restoration. | `916db4a`, `34d5aba`, `f364eef`, `1b30bab`, `b63c763`, and `adeba05` supply the validated snapshot, project-store resolver, durable outbox, bridge, restore core, and host lifecycle wiring. The focused SessionStart/version gate passes, and the production CLI now uses the canonical `.swarm` cwd. The named killed-process cross-host acceptance file remains absent and global Ruflo pagination fix `a0262e84` is not installed/released, so the ADR remains source-built but not acceptance-proven. |
| 2026-08-22 | Established the binary, host-neutral AgentDB continuity contract and fail-closed acceptance test. | Claude Code could not recover the active eight-process repair because current progression was absent from the automatically restored checkpoint stream. |
| 2026-08-22 | Recorded the pure progression snapshot, redaction, validation, and deterministic restoration core in `916db4a`, with canonical adapter-version fixtures in `faf458a` (16 focused tests; 51 with version/restated-truth gates). Host hooks, managed AgentDB transport, outbox replay, and cross-host crash acceptance remain unbuilt and unproven. | The domain contract moved after this ADR. This row binds the implemented slice without overstating the lifecycle behavior required for acceptance. |
