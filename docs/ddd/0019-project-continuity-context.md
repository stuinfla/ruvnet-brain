Updated: 2026-08-22 11:21:00 EDT | Version 0.1.0
Created: 2026-08-22 11:21:00 EDT

# DDD-0019 — Project continuity context

Status: Accepted; implementation remains proof-gated

Governs: ADR-073 and the continuity boundary used by HostConvergence, RefreshLifecycle, and
ProductIntegrityCase.

## Purpose and boundary

Project continuity owns the durable representation and automatic restoration of observable project
progression. It does not own source code, host transcripts, orchestration, or semantic retrieval.
AgentDB is the structured authority; the JSONL outbox is only crash-recovery transport.

This is a cross-cutting supporting context, not a ninth ADR-072 delivery process. Its acceptance
obligation is owned by `ProductIntegrityCase`; `HostConvergence` proves real host wiring and
`RefreshLifecycle` contributes crash/replay behavior.

## Aggregate root: ProjectProgression

```text
ProjectProgression
  projectIdentity
  canonicalAgentDbPath
  journalHeads[]
  currentGoal
  acceptanceContract
  plan[]
  activeProcess
  activeStep
  completed[]
  inProgress[]
  blockers[]
  decisions[]
  sideEffects[]
  evidence[]
  untested[]
  nextAction
  sourceIdentity
  resumeConflicts[]
  redactions[]
```

Invariants:

1. Every state field derives from exact-key-verified progression snapshots.
2. Each snapshot names every causal parent and carries its own payload digest.
3. No writer overwrites a journal snapshot.
4. Divergent concurrent heads survive until an explicit merge consumes both.
5. Foreign project/store identities are never injected.
6. Semantic search cannot establish presence, absence, recency, or authority.

## Entity: ProgressionSnapshot

```text
ProgressionSnapshot
  schemaVersion
  eventKey
  dedupId
  projectIdentity
  hostIdentity
  sessionIdentity
  sequence
  occurredAt
  trigger
  parentEventKeys[]
  completeProjectState
  sourceIdentity
  redactions[]
  payloadDigest
```

Every immutable snapshot contains full resumable state. A new host never needs to semantically
reconstruct a plan from partial deltas.

## Value objects

| Name | Meaning |
|---|---|
| `ProjectIdentity` | Repository identity and canonical AgentDB path; linked worktrees share it but retain checkout identity. |
| `SourceIdentity` | HEAD plus deterministic tracked/untracked digest; HEAD alone is insufficient when dirty. |
| `HostIdentity` | Host and adapter version proven by the packed registry. |
| `JournalHead` | Maximal unconsumed snapshot key and digest for a causal branch. |
| `ResumeState` | Complete materialized state injected at SessionStart. |
| `AgentDbReceipt` | Exact key, canonical path, readback digest, and completion time. |
| `OutboxRecord` | Fsynced snapshot or commit marker used only for replay. |
| `Redaction` | Secret class and structural location with no secret value. |

## Commands and domain events

Commands: `ObserveHostBoundary` · `AppendProgressionSnapshot` · `VerifyAgentDbAppend` ·
`ReplayUncommittedOutbox` · `RestoreLatestProjectState` · `MergeConcurrentProgression` ·
`CompactVerifiedProgression`.

Events: `ProgressionObserved` · `OutboxFsynced` · `AgentDbAppendVerified` ·
`ConcurrentHeadsDetected` · `ProgressionMerged` · `ProjectStateRestored` · `RestoreRejected` ·
`ProgressionCompacted`.

## State transitions

```text
OBSERVED -> OUTBOX_SYNCED -> AGENTDB_STORED -> EXACT_KEY_VERIFIED
              |                    |                  |
              +------ REPLAY_REQUIRED <--------------+

SNAPSHOT_CANDIDATES -> VALIDATED -> MERGED_IF_NEEDED -> RESTORED
                              |
                           REJECTED
```

Only `EXACT_KEY_VERIFIED` state is authoritative. `OUTBOX_SYNCED` is durable recovery work but must
be replayed. Rejected candidates make restoration red, not silently empty.

## Ports

### ProgressionStore

- `appendExact(snapshot): AgentDbReceipt`
- `retrieveExact(key): ProgressionSnapshot`
- `listSnapshots(projectIdentity, cursor): SnapshotHeaderPage`

The production adapter invokes managed `ruflo memory store`, `retrieve --value-only`, and
`list --format json` with an explicit absolute `--path`. It never opens AgentDB directly. Listing
must paginate until complete; the default result limit is not a continuity boundary.

### CrashOutbox

- `appendAndSync(record)`
- `listUncommitted()`
- `markCommitted(eventKey, receiptDigest)`
- `compactCommitted(verifiedSnapshot)`

### HostProgressionAdapter

- `normalize(boundaryPayload): ProgressionObservation[]`
- `inject(resumeState)`

Codex and Claude Code adapters reduce to this port. Grok Build joins only after a real lifecycle
adapter is sealed; xAI model routing is not host persistence.

## Policies

### Brain activation adopts continuity

RuvNet Brain activation in a writable project is explicit adoption of project continuity. If the
canonical `.swarm` store is absent, SessionStart initializes it through managed Ruflo memory before
work begins. Read-only or non-project contexts emit visible `continuity-unavailable`; silent no-op is
prohibited.

### Capture before acknowledgement

The bridge returns success only after the outbox is fsynced. AgentDB storage and exact readback must
finish inside the boundary when possible; otherwise the boundary is `REPLAY_REQUIRED`. The next
consequential PreToolUse and every SessionStart block until replay is verified.

### Exact restoration

Restoration structurally lists the complete progression namespace, validates project identity and
payload digests, exact-retrieves maximal heads, and reduces them. Semantic similarity is never part
of the algorithm.

### Concurrent writers

Each session owns only immutable sequence entries. The reducer computes maximal causal heads and
merges monotonic completions, evidence, and decisions. Conflicting step state, artifact digest, goal,
or next action remains explicit in `resumeConflicts[]`; neither branch is discarded.

### Privacy and fidelity

The bridge preserves complete operational meaning while removing credential values and bounded
binary/tool noise. Every removal has a redaction marker. Compaction may summarize verified closed
history but retains all open state and receipt identities.

## Acceptance scenarios

1. Codex advances an eight-step dirty-worktree repair and is killed before SessionEnd; Claude Code
   receives the exact active step, completed work, blocker, source identity, and next action.
2. Claude Code advances it; Codex restores the result from the same AgentDB.
3. Semantic search returns zero while structural enumeration plus exact retrieval still succeeds.
4. Two hosts write concurrently; both causal heads survive and conflicts are explicit.
5. A write is killed after outbox fsync; the next hook replays exactly once.
6. A corrupt, stale, or foreign snapshot is rejected without shadowing valid state.
7. A secret-bearing result is redacted without losing its operational outcome.
8. More entries than the default list limit remain fully discoverable.
9. A linked worktree and primary checkout resolve one canonical store.
10. Compaction removes minutiae only after independent restore proves equivalent state.

## Failure semantics and acceptance

Missing boundary wiring makes a host unsupported. Store/readback mismatch is `REPLAY_REQUIRED`.
Verified journal data with no valid resume state is `RESTORE_REJECTED`. Outbox-only state is durable
but degraded until replay succeeds.

ADR-073 and S-11 are satisfied only by packed, real-host, crash-injected, cross-host evidence on one
canonical AgentDB path. Unit tests cannot close this context.
