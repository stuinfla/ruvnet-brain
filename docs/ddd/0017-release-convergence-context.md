# DDD-0017 — Release convergence bounded context

Updated: 2026-08-21 04:19:00 EDT | Version 0.1.0
Created: 2026-08-21 04:19:00 EDT
Governs: ADR-070 (One release generation across corpus, package, hosts, and retained state)
Status: Accepted after Fable 5 and GPT-5.6-Sol adversarial convergence

## Purpose

Release convergence turns separately built code, corpus, host registrations, and public artifacts
into one user-observable Brain generation. It owns the transition from a proven candidate to a
publicly installed generation; it does not own source ingestion, vector search, or host process
lifecycle.

## Bounded contexts and relationships

| Context | Responsibility | Relationship to Release convergence |
|---|---|---|
| Corpus ingestion | Clone/fetch public sources and build canonical RVF stores | Upstream supplier; publishes an immutable `CorpusSeed` |
| Release convergence | Bind source, package, bundle, receipts, public channels, and install proof | Core context and sole promotion authority |
| Updating (DDD-0003) | Stage, gate, activate, roll back, and lease Brain runtime generations | Downstream conformist; activates only a converged generation |
| Host wiring (DDD-0010) | Register Claude Code/Codex entrypoints | Downstream conformist; never decides release identity |
| Grounding | Answer queries from the active installed KB | Downstream consumer; supplies effectiveness probes |
| Documentation coverage | Render repository, capability, gist, and quality inventories | Read model generated from sealed release facts |

## Ubiquitous language

| Term | Exact meaning |
|---|---|
| **Corpus root** | The one canonical RVF asset directory selected by `store-root.mjs`; repo `kb/` is source/runtime tooling, not an alternate corpus authority. |
| **Corpus seed** | Immutable, privacy-fenced archive of canonical RVF artifacts plus a digest-bound inventory. |
| **Generation ledger** | `RVF-GENERATIONS.json`, with exactly one byte-bound record for every canonical store in the selected corpus root. |
| **Release generation** | One aggregate version shared by source snapshot, npm package, GitHub bundle, plugin manifests, receipts, and installed projections. |
| **Candidate** | Fully assembled but not yet public `ReleaseGeneration`; it has no right to claim `latest`. |
| **Promotion** | Compare-and-swap transition that makes the candidate visible through npm and GitHub, then proves installation from public bytes. |
| **Convergence** | Every required public and installed projection identifies the same release generation. |
| **Compatibility shell** | Minimal retired Claude plugin directory that preserves frozen hook entrypoints but exposes no stale discoverable capabilities. |
| **Rollback snapshot** | One transaction-scoped copy of the KB made before replacement and reclaimed once the live KB is proven intact. |
| **Recovery evidence** | A retained snapshot or candidate directory named by a receipt because automated reclamation could not prove it redundant. |

## Aggregates

### ReleaseGeneration (aggregate root)

```text
ReleaseGeneration
  identity: { version, tag, sourceSnapshot }
  corpusSeed: { tag, asset, sha256, storeCount, sourceReceipt }
  generationLedger: { sha256, storeCount }
  packageArtifact: { sha256, bytes, fileCount }
  bundleArtifact: { sha256, signature, bytes, storeCount }
  policyDecision: { authorized, safetyEnvelope, fencingEpoch }
  releaseReceipt: { transactionId, prior, candidate, state }
  publicationProof: { npm, github, cleanInstall, hosts, query, disk }
```

Invariants:

1. All version-bearing members normalize to one identity.
2. Corpus-seed and bundle digests are immutable under their tags.
3. Public store count equals generation-ledger count equals bundle store count after privacy fences.
4. A candidate cannot become `latest` until both public channels are ready to converge.
5. A partial public transition remains the same transaction; it does not create another candidate.
6. `verified` means proof from public bytes, never source-tree tests alone.

### CorpusSeed

The `CorpusSeed` is created from the canonical corpus root. It owns the public/private visibility
decision, source provenance, RVF byte digests, and exact inventory. It is replaced only by publishing
a new immutable seed and committing a descriptor that pins its tag and digest.

Invariants:

1. No private or unverifiable store appears in the public inventory.
2. Every listed RVF exists, is a regular contained file, and matches its generation record.
3. A store not in the seed cannot appear through CI by inheriting an unpinned latest bundle.
4. Rebuilding from the same seed and source snapshot is deterministic at the bundle boundary.

### HostGenerationRetirement

```text
HostGenerationRetirement
  outgoingInstallPath
  incomingInstallPath
  manifest
  stableEntryPoints[]
  discoverablePayloadRemoved[]
  receipt
```

Invariants:

1. The outgoing path never disappears while a live process may hold it.
2. Retirement is atomic from usable full payload to usable compatibility shell.
3. A failed retirement preserves the full outgoing payload.
4. A compatibility shell cannot be discovered as a second active plugin generation.

### UpdateStorageTransaction

```text
UpdateStorageTransaction
  id
  liveKbBefore
  rollbackSnapshot?       // at most one
  stagedCandidate?
  terminalVerdict         // applied | noop | damaged | interrupted
  retainedEvidence[]
  reclaimedBytes
```

Invariants:

1. At most one full rollback snapshot is created per transaction.
2. Success/no-op reclaims the snapshot before reporting completion.
3. Damage retains recovery evidence and names it.
4. Preflight reclaims old snapshots only after proving the active KB contains every governed store.
5. A second no-op run has zero full-corpus disk growth.

## Domain events

- `CorpusSeedSealed`
- `ReleaseCandidateAssembled`
- `GenerationLedgerValidated`
- `ReleasePromotionStarted`
- `NpmProjectionPromoted`
- `GitHubProjectionPromoted`
- `PublicGenerationConverged`
- `HostGenerationRetired`
- `FreshInstallVerified`
- `RollbackSnapshotReclaimed`
- `ReleaseTransactionFailed`

Each event carries `transactionId`, `releaseGeneration`, exact source/artifact digests, timestamp,
and evidence location. Events are append-only; a later event corrects state rather than rewriting
history.

## State machines

### Release

```text
draft -> assembled -> gated -> staged -> partially-public -> converged -> install-verified
                     |          |              |
                     +-------> failed <--------+
```

- `partially-public` is red and resumable.
- `converged` is still not `install-verified`.
- Only `install-verified` may close the nightly failure marker or user-facing release issue.

### Host retirement

```text
full-outgoing -> retirement-staged -> compatibility-shell
       |                 |
       +---- failure ----+----> full-outgoing
```

### Rollback storage

```text
absent -> snapshot-created -> swap-attempted
                              | success/noop -> reclaimed
                              | damage       -> retained-and-receipted
```

## Commands and policies

| Command | Preconditions | Result |
|---|---|---|
| `SealCorpusSeed` | canonical root healthy; privacy/source/generation checks pass | immutable seed + descriptor candidate |
| `AssembleReleaseCandidate` | descriptor digest verified; source snapshot fixed | package, bundle, receipts with one identity |
| `PromoteReleaseGeneration` | exact candidate gates green; policy authorizes publication | resumable public transaction |
| `RetireHostGeneration` | incoming host generation verified and registry advanced | outgoing compatibility shell |
| `VerifyFreshInstall` | npm/GitHub converge | public-byte install and real host/query receipts |
| `ReclaimRollbackStorage` | active KB proves backup redundant | bytes removed and receipt emitted |

## Read models

- `ReleaseStatus`: surface, observed version, expected version, shipped, tested, evidence.
- `CoverageReport`: public repositories, synthetic stores, private exclusions, pending sources,
  capability-card coverage, gist inventory, download/unpacked/disk sizes, evaluation metrics.
- `StorageStatus`: active KB bytes, Brain code generations, compatibility shells, rollback snapshots,
  candidates, reclaimable bytes, retained reason.

These are generated from receipts and manifests. Hand-edited counts are not authoritative.

## Failure semantics

- Missing/mismatched corpus input: stop before candidate assembly.
- Missing generation record: fail closed; never synthesize from an unrelated root.
- One public channel advances: resume the same transaction until convergence or explicitly roll
  forward; never report release success.
- Host retirement fails: keep the full outgoing directory and report degraded cleanup, not update
  failure if the incoming generation is otherwise healthy.
- Cleanup cannot prove redundancy: retain and name the evidence; do not silently delete.
- Fresh install or query proof fails: public generation is `PUBLISHED, NOT VERIFIED`.

## Intended-experience QE contract

Agentic-QE must test the user's intended experience, not merely count passing unit tests:

1. A new window sees the same latest generation as GitHub and npm.
2. A window kept open across an update continues running UserPromptSubmit and SessionEnd hooks.
3. A newly ingested public repository is present and queryable in the next release.
4. Repeating update/check operations does not grow disk use by another corpus copy.
5. An interrupted promotion resumes without producing a split or duplicate release.
6. The coverage document matches the exact installed public bundle.



