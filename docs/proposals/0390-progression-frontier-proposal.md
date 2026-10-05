Updated: 2026-10-04 17:29:00 EDT | Version 1.0.0
Created: 2026-10-04 17:29:00 EDT

# ADR proposal: bounded progression with preserved historical evidence

Status: PROPOSED — critical review required; frontier/compaction implementation is not authorized.
Scope: issue #390. This document does not change ADR-073, authorize deletion, or claim backlog closure.

## Source-bound problem

At base `90ba8394d2c8a87cb8b8aa117aa141b988055ae8`, the adapted original portable reproduction
builds 100/200/400/800/1000 linked snapshots containing accumulated observations and commands.
Their serialized bytes are 3,005,596 / 11,641,796 / 45,834,196 / 181,898,996 / 283,771,400.
The 1000-snapshot build takes 6911 ms on one Node v24.18.0 darwin/arm64 run; native capture reaches
the persistence observer after 6909 ms with zero budget remaining. The observer performs no DB I/O.
This is a synthetic reproduction, not a customer dataset or universal performance measurement.
Source hashes and timings are retained in `/tmp/rnb-390-current-growth-assessment.json`.

The canonical owner project has 97 progression rows totaling 606,972 bytes (maximum row 10,364),
measured during assessment. That census cannot prove mature-project performance. The reporter's
1325-row source fixture was not available locally; the original portable reproduction was available
in the open issue. Preserve any later supplied fixture unchanged and record its provenance separately.

Relevant sources:

- `plugin/scripts/project-transition-hook.mjs`: `captureNormalizedTransition` reads the entire
  namespace; `buildRestoredTransitionProgression` appends to accumulated observations/commands.
- `plugin/scripts/project-progression-contract.mjs`: validates ancestry and merges heads/conflicts.
- `plugin/scripts/project-progression-store.mjs`: native/CLI exact reads, append-only capture,
  recovery of frozen conflicting event keys, `restoreLatest` full-history validation.
- `plugin/scripts/project-progression-outbox.mjs`: streaming records and digest/recovery quarantine.
- `plugin/scripts/project-capture-queue.mjs`: exclusive queue claims and replay fencing.
- `docs/adr/0073-agentdb-perennial-project-continuity.md` §7 requires exact range/digests,
  exact canonical readback, independent restore equivalence and a retention receipt before cleanup.

## Three approaches and their limits

| Approach | Benefit | Cost and boundary |
|---|---|---|
| A: compact in-memory outbox metadata | Avoid retaining full payloads for every unique committed entry; preserve every JSONL byte and current recovery/quarantine rules. | O(unique keys/recovery records) metadata and O(unresolved payload bytes) remain; a second scan is needed when debt exists. Does not fix full restore or quadratic snapshots. |
| B: explicit operator suspension | Stops automatic progression capture/replay/restore immediately at the next boundary/worker step. Keeps ordinary AgentDB, explicit checkpoints, turn/material events, search and update paths available. | Progression is explicitly unavailable until resumed; it is containment, not repair. Preserve pending queues and source evidence. A capture already committing may finish; the control does not revoke an issued write. |
| C: verified frontier plus separated evidence | Could bound routine capture/resume to live state, verified frontier and bounded subsequent deltas while retaining complete historical evidence. | Changes the contract and reader/writer architecture; equivalence, authoritative frontier selection, crash recovery and concurrency are unresolved review obligations. No implementation here. |

A candidate `068639490f01807c979848b3005f52037c543f17` passed a disposable 128 MiB/1024 unique
committed-payload journal under a 64 MiB JS heap. One source-bound comparison measured peak RSS
324352 → 82288 KiB and elapsed 431 → 792 ms, with identical pending/quarantine results and identical
file SHA-256 before/after. This is a memory/time tradeoff. `/tmp/rnb-390-a-benchmark.json` binds exact
module hashes and keeps the disposable mature journal. No customer evidence was removed.

## Operator containment contract (B)

The independent control is `project-progression-suspension.mjs --suspend | --resume | --status`.
It atomically writes operator configuration `brain-progression-suspension` under
`RUVNET_BRAIN_STATE_DIR`, otherwise `HOME/.config/ruvnet-brain`. `RUVNET_BRAIN_PROGRESSION_SUSPENDED=1`
is an explicit process control; resuming the file does not override that environment setting.
Neither mechanism changes capture consent or deletes a queue, snapshot, receipt, DB row or evidence file.

Only results branded inside the suspension module can identify intentional suspension at managed
execution. An unreadable control or unexpected capture error stays failure/UNKNOWN. Managed CLI
help, host identity, routing/fleet policy, literal argv validation and terminal outcome handling
remain enforced. Suspended captures produce no progression receipt and the tool result says so.
SessionStart says progression is unavailable and continues independent turn replay and the ordinary
material-event brief. Explicit checkpoint capture is still available and may deliberately replay
debt; automatic replay stays suspended. Workers check between steps and return unstarted claims.

## Proposed C design for review, not implementation

Simply appending a periodic full checkpoint and skipping earlier snapshots is insufficient:
accumulated observation/command arrays still grow in the checkpoint, and subsequent full snapshots
still repeat them. Reducing only the Map or adding a latest-N query cannot establish bounded recovery.

The candidate design to review separates append-only historical observation/command evidence from
live operational state. A frontier carries the complete live goal/action/acceptance state, all active
heads, unresolved conflicts/failures/side effects, and content-addressed historical evidence references.
New observed transitions append one exact evidence event and a state delta, rather than copying the
entire historical arrays at every boundary. Existing v1 rows remain unchanged and addressable.
Structured new records must use Ruflo with the explicit canonical AgentDB path; no second store or
direct-SQL writer. There are no vectors here and no need for embedding/model API calls.

The review must first define equivalence: a bounded reference view is not byte-identical to today's
fully materialized arrays. A proposed equivalence relation requires dereferencing the validated
frontier/event graph to reproduce exactly the prior state, ancestry, heads, conflicts and terminal
facts. Routine resume would use that bounded reference view; an explicit full-history operation could
materialize the old representation. This is a contract change requiring approval, not a presumed
optimization. If live mandatory state itself exceeds the bound, emit UNKNOWN rather than omit it.

Proposed publication sequence, subject to review:

1. Under existing replay fencing, inventory a stable exact canonical event set and every current head.
   Record event key/digest membership, range boundaries, source/build identity and expected equivalence.
2. Append a candidate frontier through managed Ruflo without upsert. Read the exact key back through
   Ruflo and independently through the native canonical reader; compare exact bytes/digests.
3. Independently restore the source set and the candidate plus post-range events. Compare the full
   equivalence relation, not only displayed goal/next action. Retain both results and discrepancy data.
4. Append a verified frontier publication receipt only if the fencing epoch and head coverage still
   hold. A new concurrent head must be included as a post-frontier event or invalidate publication.
   Managed Ruflo currently has no proven atomic frontier CAS; authority/cutover semantics must be
   designed and tested before this sequence can be implemented.
5. Readers accept only a fully verified frontier whose coverage and post-range ancestry reconcile.
   Partial/unknown/conflicting frontiers are retained as evidence and fail closed. A failed migration
   falls back only when full validation fits the deadline; otherwise report UNKNOWN or allow B.

No history cleanup is part of this proposal. Any later retention work must independently satisfy
ADR-073 §7, protect referenced/failure/active data, and receive separate review. Source evidence and
concurrent abandoned candidates remain append-only. Registration/route receipts do not prove execution.

## Required acceptance before C implementation or #390 closure

- Review approves the new equivalence relation and public contract. An independent oracle validates
  every field, dedup identity, complete evidence reference set, concurrent head/conflict and terminal
  error/signal/null-exit distinction across old and new histories, including redaction.
- Preserve byte digests of every legacy evidence file/row before and after migration. Missing,
  altered, duplicated, forged, malformed and unresolved references must not become successful restore.
- Kill processes after candidate append/fsync, exact readback, equivalence check and receipt append.
  Restart must select only a complete verified frontier; preserve debt and incomplete candidates.
- Exercise simultaneous capture, replay, frontier builders, promotion and suspension; lost fencing,
  lease expiry, stale readers and a head arriving across cutover must neither lose evidence nor publish
  an incorrect frontier. Unstarted claimed work returns to its original queue.
- Use read transactions/snapshot identity appropriate to the canonical native reader. Its current
  plain connection does not by itself establish a multi-query consistent frontier snapshot. SQLite
  read transactions and WAL reader snapshots are documented at `https://www.sqlite.org/isolation.html`
  and `https://www.sqlite.org/wal.html`; a managed CLI/native-WAL writer conflict remains a separate
  project constraint, not something to bypass with direct SQL.
- Repeat the original portable 1000-snapshot reproduction and mature 1325-row customer fixture if
  supplied, plus 10x/100x long unique-payload sequences and accumulated concurrent conflicts. Bind
  baseline/candidate source hashes, workload, heap/RSS, read/write bytes, wall-clock distribution,
  restored data and canonical readback receipts. Prove capture and native Claude/Codex restore within
  their actual declared deadlines; exclude neither construction nor persistence from the result.
- Prove suspension/resume, ordinary AgentDB store/retrieve/checkpoints, turn/material capture, search,
  grounding, update and managed CLI outcomes through their real supported host paths. Invalid controls
  and unrelated failures must never impersonate intentional suspension.
- Reject misleading claims: the 97-row owner census, A/B containment, a process running, a Ruflo
  registration, a successful command or a bounded displayed summary do not establish full acceptance.

## Decision pending

Root will arrange critical review after the routing release. Until then, C remains a proposal, A/B
remain separately qualified containment candidates, and #390 remains open with native mature-history
capture/restore limits unproven.
