Updated: 2026-10-03 18:30:00 EDT | Version 0.3.0
Created: 2026-10-03 13:30:00 EDT

# DDD-0022 — Closure governance context

Status: Proposed (with ADR-102, revision 3)

Governs: ADR-102. It consumes four contexts and owns none of their data:

- ReleaseTransaction (DDD-0015)
- ReleaseConvergence (DDD-0017)
- ProductIntegrityCase (DDD-0018)
- ProjectContinuity (DDD-0019)

## Purpose and boundary

Closure governance answers one question with a machine, not a person: **is every known gap closed, and
is every owner requirement due at this phase met, on the bytes customers actually install?**

It owns:

- the list of known gaps;
- the owner's requirements;
- the link from each GitHub issue to a gap;
- the rules for when a release is blocked.

It reads proof receipts and verifies them. It never writes them.

Out of scope:

- deciding what to build (the owner and the ADRs decide);
- quality scores (a score is an input, never a closure);
- running the release (DDD-0015).

Operating rules reach contributors only through CONTRIBUTING.md (ADR-102 §i).

## Ubiquitous language

| Term | Meaning |
|---|---|
| Gap | Something the product should do and provably does not, or a false claim. One row, one immutable ID `G-NNN`. |
| Requirement | One owner requirement in the owner's words, `R1`…`R17`, with a measurable statement where the words alone are not testable. |
| Phase | `S1a` (privacy, consent and the gate) < `S1b` (truthful failures and integrity) < `S2` (reliability) < `P1` (product) < `P2` (hygiene). A version's phase comes only from the monotonic `phaseAuthority.versionToPhase`, which is filled by a verified D0 decision. |
| blockingFrom / stages | A row is first due at `blockingFrom`. `stages[]` carry obligations due at later phases. Applicability is cumulative, and a dependency may point only to the same or an earlier phase (stage-qualified, e.g. `G-008@S1a`). |
| Verified decision | `docs/decisions/<id>.json`, scoped to rows or requirements, with old and new contract hashes, a disposition and an expiry, signed with the owner decision key (public half committed). Created by the owner running `npm run decide` with a passphrase or hardware touch. |
| Trust registry | `docs/closure-trust.json`: digests of the verifier, probes, oracles, product-side mutant patches, fixtures, the approved console inventory and the public keys. A change needs a verified decision. |
| blockingFrom | The first phase at which a row or requirement blocks a release. |
| Acceptance test | A probe that runs the installed package as a real process in an isolated home, with assertions fixed in the ledger and an executable mutant. |
| Receipt | The authenticated record of one probe run (fields below). |
| State | Requirement state, which is separate from blocking: NOT-PROVEN, candidate-proven, published-proven, daily-proven (= MET), regressed, decision-pending. |
| Decision | An owner decision that was actually made, recorded as a verified decision file (owner words, scope, contract hashes, disposition, expiry, signature). "Pending" is not a decision, and a bare key is never accepted. |
| Disposition | duplicate-of, not-a-defect, withdrawn or closed-by-reporter, each with a verified decision. |

## Aggregate root: ClosureLedger (`docs/closure-ledger.json`, schema 2)

```text
GapRow
  id, registeredAt                         immutable
  severity                                 SECURITY | PRIVACY | DATA-LOSS | FALSE-GREEN | DOES-NOT-FIRE | CUSTOMER-VISIBLE | HYGIENE (rise-only)
  gap, evidence, findingEvidenceClass      EXECUTED | STATIC
  issues[], requirement[]
  acceptanceTest { probe, realProcess, evidenceClass: EXECUTED, asserts[] (append-only) }
  release, blockingFrom                    phase; gate reads blockingFrom and stages[] only; later only with a verified decision
  status                                   open | in-progress | closed | closed-by-reporter | disposed (claim; derived)
  owner { accountable, responsible }
  dependsOn[], decision { id, state, decisionFile }   decisionFile = docs/decisions/<id>.json (verified)
```

**Invariants.** All are enforced by `scripts/closure-gate.mjs --check` in CI, which is authoritative.
The `--local` variant is advisory.

1. **Closed is derived.** `closed` requires an authenticated published receipt of class EXECUTED.
   Any mismatch between the claimed and the derived status fails the gate.
2. **Every open issue has a row.** If the reporter closes an issue while its row is open, the row moves
   to `closed-by-reporter` and needs a disposition. That is not a gate failure. An issue shared by
   several rows closes only when all of them are closed.
3. **Every requirement R1–R17 has at least one probe.**
4. **Severity order.** No phase may close a HYGIENE or CUSTOMER-VISIBLE row while a SECURITY or PRIVACY
   row of the same or an earlier phase is open.
5. **Tamper rules.** Compared against the ledger at the last release tag:
   - immutable fields are unchanged;
   - severity has not been lowered;
   - assertions have only been appended;
   - no row or requirement disappeared without a disposition;
   - no `blockingFrom` moved later, and no assertion, stage, requirement statement or probe changed, without a verified decision bound to the old and new hashes;
   - no dependency on a later phase;
   - no trust-registry digest changed without a verified decision.
6. **History.** Every status change is mirrored append-only to AgentDB, namespace `closure-ledger`,
   key `ledger-<id>-<epochms>`, and read back by exact key.
7. **Ledger edits are source changes.** Editing the ledger on `next` or `release/*` repeats preflight.

## Aggregate root: RequirementsLedger (`docs/requirements-ledger.json`, schema 2)

`Requirement { id, ownerWords, measurableStatement?, source, gaps[], probes[], schedule, blockingFrom,
state, registeredAt }`

**State and blocking are independent:**

- State is computed daily. Each result is applicable-pass, applicable-fail (pages), not-yet-applicable (recorded, never pages) or regression (pages).
- `--release <phase>` blocks on the requirements whose `blockingFrom ≤ phase`, and on nothing else.
- A blocking requirement is never report-only.

## Receipt lifecycle (four steps, none waits on its own conclusion)

1. **Producer** (preflight `requirements` job, or the owner-seat command) runs the probes and writes
   unsigned receipts.
2. **Upload:** the producer uploads them, and the job ends.
3. **Attestation:** a separate job runs the verifier from the previous release tag and holds the
   Production signing key. It checks the producer **job** conclusion, run, attempt and artifact, then
   signs an attestation.
4. **Consumer:** `--release` verifies attestations only.

Owner-seat receipts replace the run fields with a machine-id hash, key id, monotonic sequence and
previous-receipt hash.

**Mutants patch product files** inside the package manifest. Oracle-only or flag-based mutants are
rejected.

**Components** are matched per role: npm-package, knowledge-bundle-exec, runtime, ruflo, deps. They are
recorded throughout the run through a loader hook and PATH shims.

A closure receipt stays valid while its `rowContractSha256` is unchanged.

## Entity: ProofReceipt

Written only by `scripts/requirement-probe.mjs`. In addition to the fields below, it binds
`rowContractSha256` and the generation's source-coverage receipt digest. Fields:

- `ledgerRevision`
- `probeId`, `probeSha256`, `assertionsSha256`
- `mutant { executed, red, failedAssertion, sameRun }`
- `package { version, integrity }`
- `components[] { role, path, sha256 }`, recorded before and after
- `from` and `to` identities, for upgrade probes
- `corpusGeneration`
- `host { name, version }`, `configDigest`, `os`, `node`
- `producer { kind: ci | owner-seat, runId, runAttempt, artifactId, workflow, headSha }`
- `startedAt`, `finishedAt`
- `signature`

**Freshness:**

- candidate: produced by this run;
- published: bound to that version's integrity;
- daily: no older than 36 h;
- dated more than 5 min in the future: rejected.

## Domain events

| Event | Produced by |
|---|---|
| GapRegistered | Reviewer, or triage on `next` |
| IssueLinked | Daily `issue-ledger-check` (read-only) when an issue gets its row |
| ProofRecorded | Probe runner |
| RowClosed | Derived by the gate. It triggers an idempotent closure comment from `protected-release` after `install-verified`, naming the version, the receipt and the reporter. |
| RegressionDetected | Daily `--published` run. Reopens the row, comments on the issue, pages. |
| DecisionRecorded | Owner, via `npm run decide`: a signed decision file is the authority, mirrored to AgentDB. Every D1–D10 has an encoded outcome for each choice. |
| ClosedByReporter | Issue closed while its row is open. Needs a disposition. |

## Policies

- **Recall before review.** Reviews and scores under `docs/reviews/` or `docs/audits/` carry an
  `agentdbRecall` manifest. Each manifest must match the hook-written per-session recall receipts
  (from G-022's S1 stage). Until those exist, the match is advisory.
- **Customer bytes only.** Probes run the installed package. Candidate probes use a local registry that
  serves the candidate as `latest`. Components outside the tarball manifest fail the receipt.
- **Owner hooks are never modified silently.** Migration of the owner's global capture hook needs
  decision D8.
- **Flaky is a row.** A probe that flakes becomes a gap row. It is never skipped. UNKNOWN is never PASS.

## Acceptance scenarios

1. A row hand-edited to `closed` without a receipt fails, naming the row.
2. A receipt from the source checkout (components not in the tarball manifest) does not close the row.
3. A candidate probe that ran the previous public package through `@latest` fails on component identity.
4. A row whose blockingFrom is moved later without a verified decision fails. So does a lowered severity, or an
   assertion that was reworded.
5. A new external issue with no row for 24 h fails `issue-ledger-check` and pages.
6. A reporter closes an issue: the row becomes `closed-by-reporter`, and the gate stays green until a
   disposition is due.
7. A requirement probe red on the published package: the state becomes `regressed`, the run pages, and
   the next release whose phase ≥ that requirement's `blockingFrom` is refused.
8. The rejection suite (ADR-102 §c): every case fails with its own reason code, and the valid control
   passes in the same file.
