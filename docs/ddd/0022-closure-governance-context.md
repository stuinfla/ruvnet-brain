Updated: 2026-10-03 13:19:51 EDT | Version 0.1.1
Created: 2026-10-03 13:30:00 EDT

# DDD-0022 — Closure governance context

Status: Proposed (with ADR-102)

Governs: ADR-102. Consumes ReleaseTransaction (DDD-0015), ReleaseConvergence (DDD-0017),
ProductIntegrityCase (DDD-0018) and ProjectContinuity (DDD-0019). It owns none of their data.

## Purpose and boundary

Closure governance proposes two queries: **CanQualify(releaseVersion, candidateIdentity)** and
**IsNorthStarMet(currentPublishedIdentity)**. Qualification can pass while the full North Star remains
false. It owns gap and requirement contracts, issue links and authenticated proof receipts; it
consumes installed-process outputs without owning hooks, tests, installation or release execution.

**Implementation state: NOT ENFORCING.** The proposed gate and probe runner are absent at this
baseline. These are design invariants, not implemented release gates; no candidate qualifies and no
row closes from this amendment. CONTRIBUTING.md remains the operating rulebook.

Out of scope: deciding what to build (that is the owner and the ADRs), grading quality on a 0–100 scale
(scores are inputs to rows, never a closure), and running the release (DDD-0015).

## Ubiquitous language

| Term | Meaning |
|---|---|
| Gap | Something the product should do and provably does not, or a claim it makes that is false. One row, one ID (`G-NNN`). |
| Requirement | One owner requirement, quoted from the owner's own words, with an ID (`R1`…`R17`). Never paraphrased into something weaker. |
| Acceptance test | The command that proves a gap closed or a requirement met **as a real process** (installed package, real hook host or hook-shim payload, isolated customer home). A unit assertion alone is never an acceptance test. |
| Proof receipt | Immutable authenticated phase-specific execution evidence bound to the artifact, source, ledger, probe contract, environment and qualification run. |
| DueSet | Frozen unresolved gap rows with target release <= candidate version, plus complete requirement contracts explicitly due; bound to ledger digest and version. |
| RegressionSet | Contract-required previously CLOSED gap probes and all previously MET complete requirement probes; selected from established published acceptance, never author convenience. |
| CandidateProof | Fresh EXECUTED proof against the exact sealed candidate tarball sha512. It qualifies selected obligations but cannot close an issue or mark a full requirement MET. |
| PublishedProof | EXECUTED proof against public bytes whose npm dist.integrity equals candidate sha512, bound to release transaction and authenticated install-verified aggregate. Only this phase closes a row. |
| BaselineProof | Separately identified published baseline behavior and known debt; never reusable as candidate proof. |
| NorthStarDebt | Every future-target gap and incomplete owner requirement, retained visibly until complete published proof exists. |
| Disposition | What happened to an issue: `fixed` (row closed with a published proof), `duplicate` (of a row), `not-a-defect` (reason recorded), `decision-pending` (unresolved obligation; an actual canonical owner decision is needed to change scope). |

## Aggregate root: ClosureLedger

```text
ClosureLedger                       (docs/closure-ledger.json)
  schemaVersion
  qualificationContract   frozen due/regression selection, phase and debt rules
  rows[]: GapRow
    id                G-NNN, immutable
    gap               one sentence, customer-visible effect first
    severity          SECURITY | PRIVACY | DATA-LOSS | FALSE-GREEN | DOES-NOT-FIRE | CUSTOMER-VISIBLE | HYGIENE
    issues[]          GitHub issue numbers this row answers
    requirement[]     R-IDs this row serves
    acceptanceTest    { probe: path, asserts: [..], realProcess: true }
    proofArtifact     receipt path pattern the probe writes
    release           target X.Y.Z
    status            declared planning claim: open | in-progress | closed | decision
    probeState        planned | implemented
    targetHistory     reviewed provenance only when a target changes
    decisionKey       canonical owner decision key when an actual decision changes scope
```

Proposed invariants (to be enforced by `scripts/closure-gate.mjs`; no enforcement exists yet):

1. **Phase-specific derived state.** CANDIDATE-PROVEN requires passing exact-candidate execution with
   no future npm lookup. CLOSED requires published phase, exact version/artifact integrity and the
   authenticated install-verified aggregate. Hand-editing closed cannot satisfy proof. Historical
   closure is retained; failed current acceptance derives REGRESSED. Partial gap proof never makes
   a complete requirement MET.
2. **Every open issue has a row.** Every open GitHub issue must link to a gap. No closure comment or
   issue transition is authorized by candidate proof; only exact public proof after install-verified.
3. **Complete requirement contracts.** Every R1–R17 declares a complete acceptance probe contract.
   Missing future implementation remains PLANNED / NOT-PROVEN. Missing due or regression probes block
   qualification. MET separately requires every complete acceptance assertion to have current passing
   published proof; null fullRequirementTarget never excuses due linked gap obligations.
4. **Due-set severity order.** A release cannot admit lower-severity work by deferring a due
   SECURITY/PRIVACY failure. Freeze targets and probe selection at candidate seal; changes require
   explicit reviewed provenance and a new candidate. No automatic deferral can turn failure green.
5. **No silent decision.** Existing `status: decision` means DECISION-PENDING, not an accepted
   disposition. Obligations change only with an actual owner decision retrieved by exact key through
   global Ruflo from `<project>/.swarm/memory.db`; diagnostic secondary-store history is insufficient.
6. **Append-only history.** Mirror each state change to the canonical AgentDB path, namespace
   `closure-ledger`, key `ledger-<id>-<epochms>`, with exact canonical read-back; never update in place.

## Aggregate root: RequirementsLedger

```text
RequirementsLedger                  (docs/requirements-ledger.json)
  rows[]: Requirement
    id               R1..R17
    ownerWords       verbatim quote + AgentDB key it came from
    probes[]         complete-scope probe declarations, distinct from partial gap probes
    probeState       planned | implemented
    fullRequirementTarget   X.Y.Z | null (complete scope unassigned)
    state            declared NOT-PROVEN; proof derives MET only for complete scope
    schedule         daily | release | both
    lastPublishedProof   receipt path (written by the probe run, never by hand)
```

Invariant: MET requires every assertion in the complete requirement contract to have authenticated
current passing published proof (daily: 36h; release: current published identity). A red or stale
complete proof is NOT-PROVEN / REGRESSED. A patch can qualify while future R1–R17 debt remains open.
Once a complete contract is due it blocks qualification, and once MET it remains regression-blocking.

## Entity: ProofReceipt

Proposed fields: schemaVersion, phase (`candidate | published`), releaseVersion, sourceIdentity,
ledgerDigest, requirementContractDigest, probeId, probeDigest, command, exitCode, artifactIntegrity,
installationSource, os, node, host, startedAt, finishedAt, outputDigest, assertions,
qualificationRunId and negativeControlEvidence. Published receipts also require releaseTransactionId
and authenticated install-verified aggregate identity. Candidate artifactIntegrity is exact sealed
packed-tarball sha512; public registry dist.integrity must equal it. Baseline proof carries a distinct
artifact/source identity and cannot satisfy candidate obligations.

Receipts are immutable. The newest authenticated receipt for the same artifact, probe contract and
environment tuple decides; an unrelated newer fixture cannot supersede real proof. Failed public
verification retains historical candidate proof, records FAILED and uses the existing recovery rail.
Candidate reports separate due, futureDebt, regressions, decisionsPending, candidateEvidence and
publishedEvidence. Report proven counts and remaining debt without creating a second North Star score.

## Commands and domain events

| Command | Event | Who |
|---|---|---|
| RegisterGap | GapRegistered | reviewer, issue triage |
| LinkIssue | IssueLinked | triage (daily job reports unlinked issues) |
| RecordProof | ProofRecorded | probe runner only |
| CloseRow | RowClosed | closure gate, derived from ProofRecorded |
| DetectRegression | RegressionDetected | daily published-probe run; pages through ntfy |
| RecordDecision | DecisionRecorded | owner (AgentDB key) |

The proposed `RowClosed` event emits the closure comment on each linked issue (release workflow, after
`install-verified`), naming the version, the receipt, and thanking the reporter by handle.

## Policies

- **Recall before review.** Any review, score, or audit added under `docs/reviews/` or `docs/audits/`
  after ADR-102 carries a recall manifest (`agentdbRecall: { stores: [..], keys: [..] }`) naming the explicit canonical `<project>/.swarm/memory.db` and exact keys verified through
  global Ruflo. The secondary MCP store is noncanonical diagnostic history; it cannot override owner
  decisions or satisfy authoritative recall. The proposed gate would reject missing canonical recall.
- **Customer bytes, not checkout.** Probes install the package the way a stranger does (`npx
  ruvnet-brain@<v>` or the `npm pack` tarball through the same public-lane path) into an isolated
  home. A probe that imports from the source checkout is a unit test and cannot close a row.
- **Break it once.** Each probe ships with a recorded mutant run (the guarded behaviour removed, the
  probe red). Planned probe declarations may remain in the ledger; without a valid negative control they cannot
  provide qualification or closure evidence.

Canonical-path policy source: [ADR-102 canonical recall contract](../adr/0102-completion-and-closure-ledger.md#d-agentdb-first--applied-to-every-review-every-score-and-to-the-product-r15-r16). The existing
[continuity journal](../../plugin/scripts/continuity-journal.mjs) supplies the explicit-path
store and exact-key read-back pattern; this reference does not claim every capture path is fixed.

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
6. A 4.5.3 candidate passes every due and regression probe while future R2/R4/R6 debt remains
   NOT-PROVEN → CanQualify is true; IsNorthStarMet is false.
7. A candidate receipt claims published without matching registry integrity and authenticated
   install-verified → reject closure.
8. An older baseline PASS replaces the candidate run, a target changes after seal, or G-001 proof
   is used for all of R11 → reject qualification/whole-requirement proof respectively.
9. The baseline exposes a defect and the candidate fixes every assertion, but public bytes differ
   → reject published closure; retain candidate-only evidence.

All scenarios are proposed acceptance obligations; none was executed by this documentation amendment.
