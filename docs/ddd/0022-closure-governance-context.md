Updated: 2026-10-03 13:30:00 EDT | Version 0.1.0
Created: 2026-10-03 13:30:00 EDT

# DDD-0022 — Closure governance context

Status: Proposed (with ADR-102)

Governs: ADR-102. Consumes ReleaseTransaction (DDD-0015), ReleaseConvergence (DDD-0017),
ProductIntegrityCase (DDD-0018) and ProjectContinuity (DDD-0019). It owns none of their data.

## Purpose and boundary

Closure governance answers one question with a machine, not a person: **is every known gap and every
owner requirement proven closed on the bytes customers actually install?** It owns the list of known
gaps, the owner's requirements, the link from each open GitHub issue to a gap, and the proof receipts
that close them. It does not own tests, hooks, the installer, or the release pipeline; it reads their
outputs and refuses a release when the proof is missing.

Out of scope: deciding what to build (that is the owner and the ADRs), grading quality on a 0–100 scale
(scores are inputs to rows, never a closure), and running the release (DDD-0015).

## Ubiquitous language

| Term | Meaning |
|---|---|
| Gap | Something the product should do and provably does not, or a claim it makes that is false. One row, one ID (`G-NNN`). |
| Requirement | One owner requirement, quoted from the owner's own words, with an ID (`R1`…`R16`). Never paraphrased into something weaker. |
| Acceptance test | The command that proves a gap closed or a requirement met **as a real process** (installed package, real hook host or hook-shim payload, isolated customer home). A unit assertion alone is never an acceptance test. |
| Proof receipt | The JSON a probe writes when it runs: probe ID, command, exit code, the package version and its npm `dist.integrity`, OS, Node, time, and the digest of its output. |
| Published proof | A receipt whose `dist.integrity` equals the integrity npm serves for that version. Only published proofs close a row. |
| Disposition | What happened to an issue: `fixed` (row closed with a published proof), `duplicate` (of a row), `not-a-defect` (reason recorded), `decision` (owner decision key recorded in AgentDB). |

## Aggregate root: ClosureLedger

```text
ClosureLedger                       (docs/closure-ledger.json)
  schemaVersion
  rows[]: GapRow
    id                G-NNN, immutable
    gap               one sentence, customer-visible effect first
    severity          SECURITY | PRIVACY | DATA-LOSS | FALSE-GREEN | DOES-NOT-FIRE | CUSTOMER-VISIBLE | HYGIENE
    issues[]          GitHub issue numbers this row answers
    requirement[]     R-IDs this row serves
    acceptanceTest    { probe: path, asserts: [..], realProcess: true }
    proofArtifact     receipt path pattern the probe writes
    release           target X.Y.Z
    status            open | in-progress | closed | decision
    decisionKey       AgentDB key (only when status = decision)
```

Invariants (each enforced by `scripts/closure-gate.mjs`, never by review):

1. **Closed is derived, not written.** A row may carry `status: closed` only if a published proof
   receipt for its probe exists with exit 0, bound to a version ≥ `release`. Hand-editing `closed`
   without one fails the gate.
2. **Every open issue has a row.** Every open GitHub issue appears in some row's `issues[]`, or the
   gate fails. Issues closed while their row is still open fail the gate as well (no closing by
   comment).
3. **Every requirement has a probe.** Every `R` in the RequirementsLedger has at least one acceptance
   test that runs against the published package; a requirement with none fails the gate.
4. **Severity order.** A release may not carry a row closed at HYGIENE or CUSTOMER-VISIBLE while a
   SECURITY or PRIVACY row targeted at the same or an earlier release is still open.
5. **No silent decision.** `status: decision` needs an AgentDB key that `ruflo memory retrieve`
   returns, recording the owner's decision. "Won't fix" without one is not a state.
6. **Append-only history.** Each status change is also written to AgentDB (namespace
   `closure-ledger`, key `ledger-<id>-<epochms>`, never updated in place).

## Aggregate root: RequirementsLedger

```text
RequirementsLedger                  (docs/requirements-ledger.json)
  rows[]: Requirement
    id               R1..R16
    ownerWords       verbatim quote + AgentDB key it came from
    probes[]         acceptance-test paths (shared with GapRow.acceptanceTest)
    schedule         daily | release | both
    lastPublishedProof   receipt path (written by the probe run, never by hand)
```

Invariant: a requirement is MET only while its newest published proof is green and younger than its
schedule allows (daily probes: 36h). A red or stale proof is NOT MET, whatever any document says.

## Entity: ProofReceipt

Written only by `scripts/requirement-probe.mjs` (or a probe it runs). Fields above. Immutable once
written. Two receipts for the same probe and version are both kept; the newest decides.

## Commands and domain events

| Command | Event | Who |
|---|---|---|
| RegisterGap | GapRegistered | reviewer, issue triage |
| LinkIssue | IssueLinked | triage (daily job reports unlinked issues) |
| RecordProof | ProofRecorded | probe runner only |
| CloseRow | RowClosed | closure gate, derived from ProofRecorded |
| DetectRegression | RegressionDetected | daily published-probe run; pages through ntfy |
| RecordDecision | DecisionRecorded | owner (AgentDB key) |

`RowClosed` emits the closure comment on each linked issue (release workflow, after
`install-verified`), naming the version, the receipt, and thanking the reporter by handle.

## Policies

- **Recall before review.** Any review, score, or audit added under `docs/reviews/` or `docs/audits/`
  after ADR-102 carries a recall manifest (`agentdbRecall: { stores: [..], keys: [..] }`) naming both
  project stores. The gate rejects one without it (R15 applied to reviews, not only to chat turns).
- **Customer bytes, not checkout.** Probes install the package the way a stranger does (`npx
  ruvnet-brain@<v>` or the `npm pack` tarball through the same public-lane path) into an isolated
  home. A probe that imports from the source checkout is a unit test and cannot close a row.
- **Break it once.** Each probe ships with a recorded mutant run (the guarded behaviour removed, the
  probe red). A probe without one is not accepted into the ledger.

## Ports

- `GitHubIssues` (read: list open issues; write: closure comment, only from protected-release after
  `install-verified`).
- `NpmRegistry` (read: `dist.integrity` for a version).
- `AgentDbLedgerMirror` (`ruflo memory store --no-upsert --path <project>/.swarm/memory.db -n
  closure-ledger`; read back by exact key).
- `Pager` (ntfy-alerts workflow).

## Acceptance scenarios

1. A row hand-edited to `closed` with no receipt → gate exits non-zero naming the row.
2. A receipt produced from the source checkout (no `dist.integrity` match) → does not close the row.
3. A new external issue with no row → the daily job fails and pages within 24h.
4. A requirement probe red on the published package → daily job red and pages; the requirement shows
   NOT MET in `node scripts/closure-gate.mjs --status` and in the job's step summary.
5. A release candidate whose target rows are closed in source but whose public-lane install fails →
   preflight red before anything is published.
