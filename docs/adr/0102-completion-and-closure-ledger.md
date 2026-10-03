---
id: ADR-102
title: Completion and the closure ledger — every gap and every owner requirement proven on the published package, or the release does not ship
status: Proposed
date: 2026-10-03
updated: 2026-10-03
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [governance, release, requirements, issues, agentdb, privacy, closure]
supersedes: []
relates: [ADR-072, ADR-084, ADR-085, ADR-092, ADR-098, ADR-100, ADR-101]
governs:
  - docs/closure-ledger.json
  - docs/requirements-ledger.json
  - scripts/closure-gate.mjs
  - scripts/requirement-probe.mjs
  - .github/workflows/release-candidate-preflight.yml
  - .github/workflows/requirements-probe.yml
  - docs/ddd/0022-closure-governance-context.md
---

# ADR-102 — Completion and the closure ledger

**Status**: Proposed

**Date**: 2026-10-03 (revision 3, after two adversarial review rounds) · **Baseline**: `origin/main` 3ddeb1fd =
published 4.5.2 · **DDD**: [0022](../ddd/0022-closure-governance-context.md) · **Ledgers**:
`docs/closure-ledger.json` (70 rows, schema 2 rev 3), `docs/requirements-ledger.json` (R1–R17, rev 3)

## The owner's order, verbatim

> "go back and check ALL the processes involved with this application to make sure they're working
> correctly. Audit everything and figure out what else needs to be there to complete it, to have it
> work properly. Also fix any open issues in the GitHub repo. … come up with a SINGLE ADR to fix them all."
>
> "What does it take to give a careful intelligent review that you know covers all the open issues and
> then FORCES you to solve them each one by one until they're resolved and shipped?"
>
> (2026-10-03) "Are you using AgentDB? You should be writing to it ALL THE TIME and reading from it ALL
> THE TIME, so that whatever you're doing always understands the context of the prior work you've done
> on the project."

The answer to the second question is a mechanism: a gate in the publishing path whose evidence cannot
be written by hand, plus a clock that re-checks the published product every day.

## How this review was done

**AgentDB first (R15), both project stores and the global store, before any finding.**

- **Project store** `.swarm/memory.db` (ns `default`):
  - plans: `plan-4.4-4.5-20260930`, `plan-4.4-4.5-20260930-v2`
  - audits: `north-star-audit-2026-10-02-1790957160000`, `north-star-reconciliation-2026-10-02-1790961540000`
  - 4.5 release records: `release-4-5-{known-limits,lessons,repo-state}-1790948703000`, `release-4-5-enhancements-1790957060000`
  - state: `project-state-current-1790965011000`
  - decisions: `decision-{4.5-ships-today-20261001, agentdb-first-r15-20261002, retrieval-4.5-e2-off-20261001, release-canary-integrity-vs-quality-20260930}`
  - lessons: `lesson-agentdb-first-before-any-score-status-or-plan`, `lesson-automation-cannot-ack-itself`
  - scorecards: `scorecard-2026-07-10-evening`, `scorecard-gpt56-27aae9e-20260728-1254`
  - for revision 2: `completion-review-adr102-20261003`
- **MCP store** `.swarm/agentdb-memory.db`: smart searches on the auto-update, nightly, ledger and
  privacy topics. Nothing contradicted the records above.
- **Global store** (ns `global`): `lesson-audit-the-answer-not-the-wiring`,
  `lesson-capture-and-enforcement-must-share-a-store`, `lesson-review-before-push`.

**Probes.** Three parallel read-only reviews probed the published 4.5.2 package and the hooks in
isolated homes. Every one of the 22 open issues was read with comments and checked against code.

**Adversarial review.** Two independent reviews followed:

- Fable 5.1: APPROVE WITH CHANGES.
- GPT-6.1-Sol, via codex: REJECT until the ADR changes.

A GPT-6.1-Sol confirm round on revision 2 still rejected it, on narrower grounds: contradictions and
loopholes. Revision 3 is scoped to that round's minimal changes. Every finding is answered in the
[Adversarial review log](#adversarial-review-log).

## Context — why reviews kept being partial

The 4.5 knowledge auto-update shipped and did not fire on the owner's Mac. The AgentDB-first
requirement was missed. Scores were computed from the wrong sources. Six structural causes, each
measured:

1. **Every ledger was a document or a laptop script, never a release gate.**
   - `docs/WORK-REGISTER.md` ("the ONE status source") carries a 2026-09-26 header.
   - `PROGRESS.md` stopped on 2026-09-15.
   - ADR-084's invariants stayed Proposed.
   - `claims:verify`, `doc:currency`, `substitution:check`, `test:cov`, `wired:check` and
     `single-source:check` run in no workflow, although README:528 and CONTRIBUTING say they fail CI (G-011).
2. **"Qualified" meant unit tests on the source checkout.**
   - `scripts/release-qualification-contract.mjs` lists unit test files.
   - Preflight installs the packed tarball but never runs the doctor or host matrix (G-008). That matrix
     is exactly what failed on all three OSes for 4.5.0, after publication.
   - The scheduled `published-surface-probe` runs `--help` only.
3. **Reviews were scoped to diffs, not requirements.** No machine-readable list of the owner's
   requirements existed, so a gate had nothing to check against.
4. **Issues were disconnected from work.**
   - No issue has been closed since 2026-09-13; the `closed:>2026-09-13` search returns nothing.
   - Every open issue carries an automated "being worked" comment.
   - `issue-watch`'s schedule has been paused since 2026-09-18.
   - The acknowledgement satisfied itself (`lesson-automation-cannot-ack-itself`, G-010).
5. **The rules made fixes unmergeable.**
   - Fix PRs target `main`, which moves only by release fast-forward, and no branch exists to collect
     fixes between releases. #303, #327, #351 and #353 conflict; #342 is unmerged.
   - Probes of published 4.5.2 show the #327, #342, #351 and #353 changes are not in the product.
   - 41 dream-cycle PRs are open and none were merged in 30 days (G-029).
6. **Alarms cried wolf or were tuned green.**
   - `learning-replay` has paged every night since 2026-09-21.
   - The corpus watchdog's WARNING exits 0, and its promoted-age is read from a `releases/latest` that
     code releases restamp. The 48h07m corpus gap (2026-10-01 08:35Z → 2026-10-03 08:42Z) showed as
     "1.4h old" (G-012, G-021).
   - The ntfy step exits 0 when its topic is missing and swallows curl failures (G-058).

**What R3 actually did.** On published 4.5.2, in an isolated home, a real SessionStart self-heal applied
the newer corpus: the mechanism works. It did not fire on the owner's Mac for three reasons:

- **The Mac never ran 4.5.2.** Its runtime was 4.5.0 and its plugin 4.5.1. This review session's own
  PreToolUse hook executed from plugin cache `4.3.37` while `installed_plugins.json` named 4.5.2.
  Sessions keep the code they booted with.
- **No newer corpus existed until 2026-10-03 08:42Z.** The kill switch had no re-arm.
- **Nothing proved the behaviour on published bytes after release.**

## Decision

**A release ships only when every gap obligation applicable at its phase is closed, and every
requirement applicable at its phase is met.** Proof is an authenticated, executed probe of the bytes
customers install. Phase, decisions, probes and the verifier are all protected from the candidate they
judge.

### (a) The ledger, one phase authority, staged obligations

**Rows.** `docs/closure-ledger.json` (schema 2, revision 3) holds one row per gap: `{id, gap, severity,
issues[], requirement[], evidence, findingEvidenceClass, acceptanceTest{probe, realProcess,
evidenceClass, asserts[]}, stages[]?, blockingFrom, release, status, owner{accountable, responsible},
dependsOn[], decision{id, state, decisionFile}, registeredAt}`.

- `release` is informational: the phase of the row's last stage.
- The gate reads only `blockingFrom` and `stages`.
- `stages[]` lets one row carry obligations that become due in different phases. For example, G-008
  has an S1a stage (producer for applicable probes), an S1b stage (doctor matrix) and an S2 stage
  (daily published probes).

**Phase authority — `phaseAuthority` in the ledger.**

- Phase order is `S1a < S1b < S2 < P1 < P2`.
- `versionToPhase` is the only source of a version's phase. It is filled at D0 by a verified owner
  decision. While it is empty, no release can claim a phase.
- The map is monotonic. `--release` refuses a version whose phase is lower than the phase of the last
  published version (no phase rollback).

**Applicability is cumulative.** At phase p the gate blocks on:

- every row stage with phase ≤ p;
- every requirement probe of a requirement with `blockingFrom` ≤ p;
- the probes of every gap of any requirement, once that gap's `blockingFrom` ≤ p.

A requirement can therefore block early on its own early gaps without demanding work scheduled later.

**Dependencies are validated.** A row or stage may depend only on rows or stages of the same or an
earlier phase. Dependencies are stage-qualified (`G-008@S1a`), and `--check` enforces the rule. The
revision-3 ledger passes it with 0 violations, checked by the generator.

**Tamper rules.** They take effect from the first release tag that carries the ledger. Until then the
ledger is revised only by review, as in the two rounds below. Against the last release tag:

- `id` and `registeredAt` are immutable;
- `severity` may only rise;
- assertions, stage contracts, requirement statements and probe lists may change only through a
  verified owner decision bound to their old and new hashes;
- `blockingFrom` may move later only through such a decision;
- a row, a requirement or an issue link may disappear only with a disposition carrying a verified
  decision.

A ledger edit on `next` or `release/*` is a source change, so preflight repeats on the new SHA
(CONTRIBUTING.md:46).

### (b) Verifiable owner decisions

A `decisionKey` is no longer accepted on presence alone. Every decision that defers, disposes, changes
a contract or fills `versionToPhase` is a file `docs/decisions/<decisionId>.json`. It holds:

- `{decisionId, scope: {rowIds[], requirementIds[]}, choice, oldContractSha256, newContractSha256,
  disposition, ownerWords, decidedAt, expiresAt}`;
- a detached signature, made with the **owner decision key**.

The owner creates it by running one local command per decision, `npm run decide -- <id> <choice>`. The
command:

1. prints the scoped change;
2. asks for the key's passphrase, or a touch on a hardware key, on the terminal;
3. writes the signed file.

This respects "owner never clicks GitHub": nothing is clicked on GitHub, and the agent commits the file.

The public half (`keys/owner-decisions.allowed_signers`) is committed and listed in the trust registry.
The gate verifies four things: the signature, that the scope matches the rows being changed, that the
hashes match the actual old and new contracts, and that `expiresAt` has not passed.

AgentDB keeps a mirror (`decision-*`) for recall. The file is the authority.

**Residual risk, recorded as G-068.** A signature proves possession of the owner decision key, not the
owner's personal intent. If that key had no passphrase, an agent on the same machine could sign. The
keygen command refuses an unprotected key, but protection on the owner's machine cannot be verified
remotely. D10 records it as an accepted risk.

### (c) Receipt lifecycle and component provenance

The lifecycle has four separate steps, so no step needs its own final conclusion.

1. **Producer execution.** The preflight `requirements` job, or the owner-seat command, runs the probes
   and writes unsigned receipts.
2. **Artifact upload.** The producer uploads them, and the job ends.
3. **Trusted attestation.** A separate job that `needs` the producer runs the trusted verifier (d) and
   holds the signing key in the Production environment. It:
   - downloads the artifact through the API;
   - checks the **producer job's** conclusion (final by then), its run, attempt, head SHA and workflow
     path;
   - checks every receipt;
   - signs an attestation over the receipt digests.
4. **Consumer verification.** `closure-gate --release` in the aggregate job, and later in
   `protected-release`, verifies attestations only.

**Owner-seat receipts.** These replace the CI run, attempt and artifact fields with: `{producer:
owner-seat, machineIdSha256, keyId, command, sequence, prevReceiptSha256}`. The sequence is monotonic
and the receipts form a hash chain, which defeats replay. They are signed with the **owner-seat
key**, a machine key distinct from the owner decision key, and uploaded to the dedicated
`owner-seat-receipts` release.

**Receipt contents.**

- **Bindings:** `rowContractSha256` (the row's acceptance contract, with probe, oracle and mutant
  digests), `ledgerRevision` (recorded, not used for invalidation), package `{version, integrity}`.
- **Corpus:** the corpus generation **and the digest of that generation's ADR-069 source-coverage
  receipt**. The gate verifies the source-coverage receipt, so a generation identity alone does not
  prove complete inputs.
- **Environment:** host `{name, version}`, a config digest, OS and Node.
- **Execution record:** `loaded[]` and `spawned[]`, both described below.
- **Timing:** start and finish times.

**Historical vs current.** A closure receipt stays valid while its `rowContractSha256` is unchanged.
Editing another row does not invalidate it. Regression evidence is a separate stream: daily receipts.

**Component provenance is checked per role**, each against its own trusted manifest:

| Role | Trusted manifest |
|---|---|
| `npm-package` | the tarball file list and digests |
| `knowledge-bundle-exec` | the signed bundle's executable manifest |
| `runtime` | the Node version and binary sha256 |
| `ruflo` | the global binary version and package integrity |
| `deps` | the lockfile integrity of installed `node_modules` |

The probe records identities throughout the run, not just before and after:

- **`loaded[]`:** a Node `--import` loader hook logs every module loaded, with its path and sha256.
- **`spawned[]`:** PATH shims log every `node`, `npx`, `npm` and `ruflo` execution.

Any identity outside its role's manifest fails the receipt.

**Candidate update-test authority vs production trust.**

- **Fetch paths.** Candidate probes run with an empty npm cache, `npm_config_registry` pointed at a
  local registry that serves the candidate as `latest`, and (on Linux) network limited to that
  service. A post-run scan proves the npx cache holds only the declared identities.
- **Test trust root.** Positive update tests use an isolated TEST trust root: a test-only signing key
  and test aggregate served by the local registry. The production trust root must reject the test key,
  and this is asserted (G-062).
- **Published evidence.** Provenance is a published-proven obligation (G-059 under D6), never a
  candidate obligation.
- **Residual gaps (G-069).** Tracing does not reach native addons or non-Node children, and macOS and
  Windows runners have no container network isolation.

### (d) Trusted verifier, probe, oracle and mutant boundary

**Trust registry (`docs/closure-trust.json`).** It records the digests of:

- `closure-gate.mjs` and `requirement-probe.mjs`;
- every probe, oracle and mutant patch;
- the frozen fixture sets;
- the approved console inventory (G-060);
- the three committed public keys: release, owner-seat, owner decision.

Any change needs a verified owner decision bound to the old and new digests. A probe whose digest is
re-recorded without such a decision fails `--check`.

**Mutants alter guarded product behaviour.** A mutant is a patch to product files. It is applied to the
installed copy of the package, and its `mutates[]` paths must lie inside the package manifest. A mutant
that touches only probe or oracle files, or that sets a flag the oracle reads, is rejected. The mutant
run must fail on a named assertion of the row. A module-load error does not count.

**The verifier runs from the trusted base, not the candidate.** Preflight and `protected-release` check
out `closure-gate.mjs`, the probe runner and the trust registry from the **previous release tag**. They
take only the candidate's ledger and receipts as input. The signing keys live only in the Production
environment of the attestation job, which runs that same base verifier. A change to the verifier takes
effect only after it has itself been released.

**Bootstrap (G-070).** The first gate-carrying release has no earlier verifier. Its verifier digest is
registered through D10, after review by two independent adversarial reviewers.

### (e) Gate modes and the rejection suite

- **`--check`** runs in CI on every PR to `next` or `release/*` and in `canonical-qa`, and is
  **authoritative**. It verifies:
  - the schema;
  - tamper rules, decision files, trust-registry digests and dependency validation;
  - issue linkage, with the `closed-by-reporter` state;
  - that every requirement has a probe;
  - that every closed row has an attested published receipt;
  - severity order;
  - SLA age from `registeredAt`.

  A GitHub API failure is UNKNOWN, which fails the run.
- **`--check --local`** additionally reads the AgentDB mirrors. It is **advisory** only.
- **`--release <version>`** resolves the phase through `phaseAuthority`, then requires attested
  candidate-proven receipts for everything applicable. Before `install-verified` it requires attested
  published-proven receipts.
- **`--published`** (daily, S2 stage of G-008) classifies each result:
  - applicable-pass: daily-proven;
  - applicable-fail: pages;
  - not-yet-applicable: recorded as an observation, never pages;
  - regression (previously daily-proven, now red): pages.

  Future obligations therefore cannot recreate alarm noise.
- **`--status`** is the only status surface.

**Rejection suite** (`tests/closure-gate/rejection/*.test.mjs`). Each case asserts its own reason
code, and a valid control passes in the same file. It covers:

- **Receipt forgery:** forged signature; tampered receipt field; receipt from another attempt;
  artifact not owned by the run.
- **Wrong subject:** wrong package integrity; wrong probe, oracle or mutant digest; wrong corpus
  generation; missing or mismatched source-coverage receipt; executing component outside its role
  manifest; substituted `latest`; npx cache holding an undeclared identity.
- **Freshness:** stale receipt; future-dated receipt; replayed owner-seat sequence.
- **Ledger tampering:** removed row; weakened assertion or requirement contract; lowered severity;
  deferral without a verified decision; fabricated or unsigned decision file; decision scoped to
  another row, or expired; missing requirement; dependency on a later phase.
- **Probe tampering:** altered probe with a re-recorded digest but no decision; a mutant that only
  touches the oracle; an empty or vacuous probe run (zero assertions executed, or an empty fixture
  set).
- **Phase:** phase rollback; version absent from `versionToPhase`.
- **Environment:** GitHub API failure; issue-close race; skipped job; missing OS × host matrix cell.
- **Workflow bypasses**, each checked by workflow-structure assertions on the base verifier:
  - gate invocation removed;
  - `if: false` on the gate step or job;
  - `continue-on-error: true`;
  - exit code masked (`|| true`, `; exit 0`);
  - aggregate job no longer `needs` the attestation job.

### (f) Preflight runs the public-lane install before anything is published

The `requirements` producer job, the attestation job and the consumer are described in (c). By stage:

- **S1a:** probes of every applicable row, on ubuntu, macOS and Windows, against the packed candidate
  installed through the public-lane path.
- **S1b:** adds `--doctor --hooks` in the claudeOnly, codexOnly and dual modes. Re-introducing the
  4.5.0 defect turns it red.
- **S2:** adds the daily published run.

The pending-transaction check (G-046) runs first.

### (g) The historical misses, walked one by one

| Miss | Probes that go red | Separate evidence |
|---|---|---|
| **4.5 auto-update did not fire** | G-019, eight separate probes listed below. R3-a and R3-b are separate, so neither trigger masks the other. | Publication of corpus N (G-012, G-021, with the source-coverage receipt bound). Activation (R3-a…h). Delivered alert (G-058 nonce). Owner machine: D9 "yes" gives a signed daily receipt; D9 "no" shows "owner-seat: declined", and clean-home receipts are never presented as owner-machine proof. |
| **AgentDB-first was missed** | G-022 S1b stage, below | Review recall manifests must match those recall receipts. Before G-022's S1b stage ships, that match is advisory, and the ADR says so. |
| **Plaintext capture by default** | G-001, G-057, G-065, with the postconditions decided in D8 | — |

The eight auto-update probes:

- **R3-a SessionStart only:** the KB reaches N within 75 min.
- **R3-b MCP timer only:** with an old boot snapshot, the KB reaches N within 20 min.
- **R3-c host delivery:** after a restart, the loaded plugin equals the runtime.
- **R3-d kit ownership:** a proof ≤36 h old makes the Brain defer; an older one does not.
- **R3-e consent:** the states decided in D1.
- **R3-f OFF:** with the off switch set, nothing spawns.
- **R3-g offline:** the update recovers within 90 min of the network returning.
- **R3-h searched corpus:** after activation, answers carry generation N.

The G-022 S1b stage, which is enforceable at S1b:

- a frozen fixture of ≥20 score, status and plan prompts gets a recall block on 100% of them;
- the recall receipt is timestamped before the first tool call and the final answer;
- with ruflo unavailable, the gate says "AgentDB recall not performed" and blocks once;
- PreToolUse **refuses** a `gh workflow run protected-release` that violates a seeded recorded rule.

### (h) AgentDB — read always, write always, measured (R15, R16)

The full G-022, G-024 and G-018 targets are in the ledger and block from P1:

- recall on ≥95% of non-trivial prompts, with a hook p95 ≤500 ms (p99 ≤1000 ms);
- ≤600 B per prompt and ≤12 KB per session;
- irrelevant records on ≤10% of a labelled 50-prompt sample;
- owner-instruction capture ≥90% at ≤5% false captures;
- metrics in doctor, where UNKNOWN is never 0.

The 500 ms budget is set because two sequential CLI searches already exceed it. Measured, n=1 each:
0.60 s on `memory.db` and 0.78 s on `agentdb-memory.db`. Privacy rows G-001, G-002, G-053, G-057 and
G-065 ship first, in S1a.

### (i) Privacy and the owner's own hook

The owner's registered hook `~/.claude/hooks/agentdb-turn-capture.mjs` writes plaintext independently
of the product: into the stores, into `agentdb-turns.jsonl` (0644 observed) and into its dedupe state.
The product never modifies it silently.

**What D8's options remove, stated exactly:**

- **Redaction on write** removes credential-shaped strings. It does not remove names, health details
  or client matters.
- **Retention** deletes whole rows older than the decided period.
- **`--erase-turns`** deletes all turn rows.
- **`--scrub-turns`** (one-time, with a receipt) removes credential-shaped strings from every historical
  location. It does **not** remove other private text from rows it keeps, and its receipt says so.

**If the owner refuses the hook migration:**

- the product writer is fixed anyway;
- the owner hook keeps writing unredacted text, and doctor reports this on every run;
- G-057's active-writer postcondition is disposed as an owner-accepted risk;
- G-001 closes on the product writer only.

**"Project root" for containment (G-053)** is the canonical adopted root. Linked worktrees of that root
are allowed and write to its store.

### (j) Issues and the branch fixes land on

- **Integration branch.** `next` is the standing integration branch. Fix PRs target `next`, never
  `release/*`. `release/X.Y.Z` = `origin/main` + `next`.
- **Authority split.** `issue-ledger-check` (read-only) pages on an open issue that has had no row for
  24 h. A separate `pr-retarget` job (`pull-requests: write`) only moves fix PRs from `main` to `next`.
- **Acknowledgement** is a row, never a comment.
- **Closure comment.** It is idempotent and posted by `protected-release` after `install-verified`. It
  names the version, the receipt, the acceptance test and the reporter, with thanks: @HF-teamdev,
  @pacphi, @adambkovacs, @sparkling. A failed comment is reconciled by the next daily run.
- **Shared rows.** Where one row answers several issues, an issue closes only when all of its rows are
  closed.
- **Regression** reopens the row and comments on the issue.
- **SLA, from `registeredAt`:**
  - SECURITY/PRIVACY: a shipped mitigation or a verified owner decision within 72 h. Full closure in
    the next safety phase.
  - DATA-LOSS, FALSE-GREEN and DOES-NOT-FIRE: the next two phases, or 14 days.
  - Everything else: 30 days, or a decision.

### (k) How this becomes operating policy

CONTRIBUTING.md is the only operating rulebook. The change that implements `closure-gate.mjs` adds a
"Closure ledger" section to CONTRIBUTING.md stating the rules in (a)–(j). `single-source:check` then
forbids restating them anywhere else. Until that change lands, this ADR is a proposal.

## Order of work

Phases are mapped to versions only by `phaseAuthority.versionToPhase`, at D0.

| Phase | Content | Rows first due (blockingFrom) |
|---|---|---|
| **D0 — before implementation** (no release) | Freeze thresholds, fixture sets and owners. Build a prototype benchmark of three probes (G-001, G-008@S1a, G-019 R3-a); the rest of the matrix is labelled *estimated*. Get decisions D1–D10. Fill `versionToPhase`. | — |
| **S1a — privacy, consent, the gate** | Privacy and containment, historical-data policy, consent, truthful security text, the self-update trust check, the gate with its producer, attestation, verifier, trust registry and rejection suite | G-001, G-002, G-003, G-008@S1a, G-009@S1a, G-053, G-057, G-061, G-062, G-065, G-068, G-070 (12) |
| **S1b — truthful failures and integrity** | Citation integrity, CI secret scan and honesty gates, truthful failures, router tools, `next` branch, Node policy, paging delivery, provenance and credential isolation, footprint disclosure, #198 probe, AgentDB-first S1b stage, doctor matrix | G-004, G-005, G-010, G-011, G-014, G-016, G-022@S1b, G-029@S1b, G-037, G-046, G-056, G-058, G-059, G-063, G-064 (15), plus G-008@S1b, G-009@S1b |
| **S2 — reliability** | Both update triggers and host delivery, Windows/Linux, upgrades, durable replay, daily published probes, uninstall, the bundle split, tracing coverage | 22 rows, including G-045, G-066 and G-069, plus G-008@S2 |
| **P1 — product completion** | Always-read and always-write in full, subagents, retrieval, advocacy, console inventory, local time, Grok, routing | 16 rows, including G-022 in full and G-067 |
| **P2 — hygiene** | Remaining text, docs and ADR currency, dream-cycle outcome | 5 rows, plus G-029@P2 |

## Owner decisions (D0)

Each decision has both outcomes encoded in `decisions` in the ledger. Choosing "no" yields an explicit
disposition or contract, never an unmet row that sits silent. A choice becomes effective only as a
signed decision file (b).

| ID | Decision in plain words | Recommended | What each choice does to the ledger |
|---|---|---|---|
| D0 | Freeze the numbers, fixture sets, owners and version-to-phase map | approve | **Approve:** they enter the trust registry. **Amend:** the ledger is revised and D0 repeats. |
| D1 | Updating knowledge today also replaces program files and the updater. What may run without asking until that bundle is split (G-066, S2)? | A — automatic, but only to install-verified versions, stated truthfully | **A:** with no preference recorded, the updater runs only to an install-verified version, and SECURITY.md says knowledge updates replace program files. **B:** nothing runs without consent, and R3 is revised to "after consent". |
| D2 | Volunteer "rUv already ships X" by default? | On | **On:** G-025's targets block from P1. **Off:** R1 is revised by decision and shows NOT-MET, never MET. |
| D3 | Cost routing | Wire it to `@metaharness/router` | **Wire:** G-067 must route a frozen 30-query set. **Defer:** the status line is removed (G-048) and R12 is revised; G-067 stays NOT-MET. |
| D4 | Grok hooks | No for now | **Yes:** a live `grok -p` owner-seat receipt is required from P1. **No:** R4 is revised to Claude and Codex, G-027 is disposed, and #301 closes with the decision. |
| D5 | Dream cycle | Pause | **Pause:** the workflow is disabled, and it resumes only when its findings create ledger rows. **Continue:** fix the compile, and the backlog stays ≤5. **Retire:** remove it and close its PRs. |
| D6 | npm trusted publishing (one setting on npmjs.com) | Yes | **Yes:** provenance is asserted on published versions. **No:** an authorized risk disposition — a scoped token rotated at least every 90 days, usable only in the publish job — and provenance is not asserted. |
| D7 | Node 18 support | Drop | **Drop 18:** engines ≥20, matrix 20/22/24, R13 range 20–24. **Keep 18:** engines ≥18, matrix 18/20/22/24, R13 range 18–24. Either way the change lands in S1b. |
| D8 | Turn capture: scope, retention, the owner's hook, history | Recommended set in (i) | **Recommended:** removes credential-shaped strings everywhere and whole rows past retention; does not remove other private text in kept rows. **Refuse migration:** the owner hook stays unredacted and is reported. **Off everywhere:** R6 is revised to exclude turn records. |
| D9 | Daily signed health receipt from the owner's Mac (LaunchAgent) | Yes | **Yes:** owner-machine proof. **No:** owner-machine proof is explicitly unavailable, a manual `--doctor --json --sign` run stays possible, and clean-home proof is never shown as owner proof. |
| D10 | Trust bootstrap: accept the first verifier digest and the owner-key residual risk | Accept | **Accept:** the gate can ship. **Reject:** the gate does not ship until another trust root is decided. |

## Consequences

**Gains.**

- "Done" is a property of the published package, re-checked daily, and future obligations are kept
  out of the paging stream.
- Decisions, probes, phases and the verifier cannot be changed by the candidate they judge.

**Costs.**

- The S1a release must carry the gate, its producer, attestation, verifier and rejection suite, plus
  the privacy rows. It is not small.
- There are three keys (release, owner-seat, owner decision), a local registry in CI, and a trust
  registry.
- Each ledger edit repeats preflight.

**Residual risks are rows, not prose:**

- G-068: owner intent behind a signature;
- G-069: tracing and egress coverage;
- G-070: verifier bootstrap;
- G-066: the bundle carries executables.

**Limits.**

- CI cannot read AgentDB, so the AgentDB mirrors are advisory. The signed decision files are the
  authority.
- Live model sessions are owner-seat receipts.
- **What would make this ADR wrong:** flaky probes get disabled. A flaking probe is a row, and UNKNOWN
  is never PASS.

## Adversarial review log

Fable 5.1 (F) and GPT-6.1-Sol (G). "Verified" means I checked the code or ran a probe myself.

### Round 1 — reviews of revision 1

Section letters in round 1 refer to revision 2.

| # | Finding (source) | Verdict | Evidence / change |
|---|---|---|---|
| 1 | The gate cannot pass the first release, because it requires every requirement probe (F, G) | **Accepted** | Requirement state is decoupled from blocking; added `blockingFrom`, the phases, and the states (b). |
| 2 | Release target is a free field, so a row can be deferred forever; no `registeredAt` (F, G) | **Accepted** | Tamper rules (a); `registeredAt` on all rows; SLA computed from it. |
| 3 | A recorded mutant file is not teeth; import-error mutants (F, G) | **Accepted** | Executable mutant in this run, failing on a named assertion (b); rejection suite (c). |
| 4 | A probe can run repo code, not tarball code (F) | **Accepted** | Before/after component identity matched against the tarball manifest (b). |
| 5 | `@latest` substitution during preflight (G) | **Accepted, verified** | `host-update.mjs:121` spawns `npx --yes ruvnet-brain@latest`. Local candidate registry plus identity bindings (b). |
| 6 | Owner-seat receipts are an unsigned channel; recall manifests are checked for presence only (F, G) | **Accepted** | Second committed public key; recall receipts from G-022 S1; the remaining limit is stated in Consequences. |
| 7 | Reporter-closed issue blocks every release (F) | **Accepted** | `closed-by-reporter` state (c). |
| 8 | Ledger edit on a release branch repeats preflight (F) | **Accepted** | Stated in (a). |
| 9 | `--check --local` is not authoritative (G) | **Accepted** | Marked advisory; CI `--check` is authoritative (c). |
| 10 | AgentDB-first would not have been caught (F, G) | **Accepted** | Before/reached/respected probe; failure is not silent on gated prompts (e). |
| 11 | R3 needs SessionStart and MCP timer tested separately, plus host delivery, ownership, consent, OFF, offline, searched corpus, publication and alert delivery; owner-Mac receipt (F, G) | **Accepted** | R3-a…h in G-019; separate publication and alert evidence; D9 owner-seat receipt (e). |
| 12 | Privacy excludes the owner's registered global hook and historical copies (G, F N4) | **Accepted, verified** | Read-only read of `~/.claude/hooks/agentdb-turn-capture.mjs:112-138`: plaintext into the store, the jsonl and the dedupe state; registered at `~/.claude/settings.json:127`; real global jsonl mode 0644. Added G-057 and (g); never modified silently. |
| 13 | Token redaction does not protect arbitrary private text; R6 "every project" conflicts with G-002 (G) | **Accepted** | Stated in (g); R6 restated as adopted projects only. |
| 14 | Undefined thresholds; no named owner; R8 has no inventory (G, F) | **Accepted** | Numbers in G-022/024/025/038/018/048/019; `owner{accountable, responsible}` on every row; G-060 console inventory. |
| 15 | SECURITY.md states the opposite of shipped behaviour (F N1) | **Accepted, verified** | SECURITY.md:104-108 says knowledge updates are "detect-and-notify only; --apply is never run automatically", while `host-update.mjs:121` runs the updater unattended. Added G-061. |
| 16 | Self-update runs `latest` without an install-verified check (F N2) | **Accepted** | G-062. |
| 17 | NPM_TOKEN, no provenance, mutable action tags, key lifecycle (F N3, G G-059) | **Accepted** as a control gap, not a demonstrated compromise | G-059 plus D6. |
| 18 | First Stop creates undisclosed files (F N5) | **Accepted, verified** | Real `~/.claude/global-memory/.swarm/ruvector.db` and `~/.claude-flow/update-state.json` exist; G-063. |
| 19 | No standing integration branch (F N7) | **Accepted** | `next` in G-029 and (h). |
| 20 | #198 must not be called fixed on unit tests (F, G) | **Accepted, verified** | The issue names 7 suites (`gh issue view 198`) and 4 were run. Reopened as G-064. |
| 21 | #331 contradicts G-042 (F, G) | **Accepted** | #331 stays open until G-042. |
| 22 | #329 only partly fixed: turn capture still uses the database directory as its cwd (G) | **Rejected as stated** | The cwd choice is deliberate containment (`turn-outcome-capture.mjs:276-283`). No `.swarm/.swarm` exists in the real project store or the real global store (`ls`, 2026-10-03), and fork A's Stop probes from a worktree and the main checkout created none. What it does leave is `ruvector.db` beside the store: an undisclosed-footprint defect, now G-063, which #329 is linked to. #329 closes only on G-063's published probe covering both writers. |
| 23 | Node 18 EOL; raise engines (F N9) | **Accepted as decision D7**, recommended for S1 | — |
| 24 | Turn rows accumulate forever (F N10) | **Accepted** | G-065, PRIVACY, in S1 (moved out of hygiene). |
| 25 | READ-ALWAYS latency (F N11) | **Accepted, verified** | Measured 0.60 s and 0.78 s per store, n=1 each. p95 ≤500 ms budget (f). |
| 26 | Symlink containment bypass in the turn writer (G G-053) | **Accepted** (code read) | G-053, SECURITY, S1. |
| 27 | Unterminated progression record discarded (G G-054) | **Accepted, verified by read** | `project-progression-outbox.mjs:60-62` pops a final line that has no newline. G-054. |
| 28 | Compaction drops uncommitted events (G G-055) | **Accepted, verified by read** | `continuity-journal.mjs:224-226` `pendingDrop`. G-055. |
| 29 | Fast-lane citation path differs from CARD identity (G G-056) | **Accepted** (code read) | `kb/card-lane.mjs:753` vs `scripts/corpus-aggregates.mjs:120`. G-056. |
| 30 | Paging can succeed silently (G G-058) | **Accepted, verified** | `ntfy-alerts.yml:68` `[ -z "$TOPIC" ] && exit 0`; `:89` `curl … || true`. G-058. |
| 31 | G-003 framed wrong: the bundle is executable (F, G) | **Accepted** | Reframed; D1. |
| 32 | Four version labels are not an evidence-based schedule; 72 h SLA unrealistic (F, G) | **Accepted** | Phases plus the D0 benchmark; the SLA is now mitigation-or-decision in 72 h. |
| 33 | Document contradictions: DDD R1..R16 vs R17; CONTRIBUTING sole rulebook; "or current latest" freshness (G, F) | **Accepted** | DDD updated; (i); freshness made explicit per state (b). |
| 34 | G-033 acceptance must prove exact-version pinning; G-035 "zero bytes" must exclude user data; one job cannot be both a read-only check and a PR writer; shared-row and regression handling (G) | **Accepted** | Asserts rewritten; authority split, shared rows and regression handling in (h). |
| 35 | "Unmerged does not prove the changes never reached a release" (G) | **Accepted as a caveat, verified for 4 of 5** | Probes of published 4.5.2 show the #327, #342, #351 and #353 changes are absent; #303 is not verified. |
| 36 | Corpus proofs must bind input completeness and the exact generation (G) | **Accepted** | Receipts bind the corpus generation (b); G-021 covers publication. Input completeness stays with ADR-069 source coverage (not re-verified here). |

### Round 2 — GPT-6.1-Sol confirm review of revision 2 (REJECT, narrowed)

| # | Finding | Verdict | Change in revision 3 |
|---|---|---|---|
| 37 | G-009 (S1) depends on G-008 (S2); R17 blocks at S1 but includes G-008; G-008 demands every requirement probe | **Accepted** | G-008 and G-009 are staged (S1a, S1b, S2). Applicability is cumulative and per gap (a). G-008 runs only applicable probes. 0 dependency violations. |
| 38 | R10 blocks at S2 while G-045 is P2 | **Accepted** | G-045 moved to S2. |
| 39 | G-010 needs delivered paging in S1 but G-058 is S2 | **Accepted** | G-058 moved to S1b; G-010 depends on it. |
| 40 | G-029 needs dream cleanup in S1 but D5 is P2 | **Accepted** | G-029 staged: S1b covers `next` and fix PRs; P2 covers the dream backlog, which depends on G-052/D5. |
| 41 | S1a omitted G-053 | **Accepted** | G-053 is in S1a. |
| 42 | G-037 (S2) vs the D7 promise in S1 vs R13 "Node 18–24" | **Accepted** | G-037 is S1b. R13's range is whatever D7 decides. |
| 43 | G-022's S1 subset had no enforceable acceptance | **Accepted** | G-022 S1b stage, with four executable assertions, including refusing a violating dispatch. |
| 44 | S1a/S1b absent from the DDD | **Accepted** | DDD phase vocabulary updated. |
| 45 | Fix PRs target both `release/*` and `next` | **Accepted** | G-029 asserts `next` only. |
| 46 | D1 contract contradicts its recommendation | **Accepted** | G-003's acceptance is per outcome; the bundle split is registered as G-066 (S2). |
| 47 | D6 "No" contradicts mandatory provenance | **Accepted** | Authorized risk disposition for "No"; provenance is a published-only obligation. |
| 48 | D5 pause vs compile-or-retire | **Accepted** | Three outcomes, each with an observable state. |
| 49 | D4 circular | **Accepted** | "Yes" requires a live third-host receipt; "No" revises R4. |
| 50 | D3: removing a status line satisfies G-048, not R12 | **Accepted** | Functioning routing split out as G-067. |
| 51 | D8 "plaintext removed" is only true for tokens; what does refusal permit | **Accepted** | (i) states exactly what each option removes and what refusal permits. |
| 52 | D9 refusal has no gate outcome | **Accepted** | "No" makes owner-machine proof explicitly unavailable and forbids presenting clean-home proof as owner proof. |
| 53 | Phase selection not authoritative; phase rollback | **Accepted** | `phaseAuthority`, monotonic, filled at D0 (a). |
| 54 | Invented decision releases work | **Accepted** | Signed, scoped, hashed, expiring decision files (b). Residual G-068. |
| 55 | Candidate can redefine its own examiner | **Accepted** | Trust registry; mutants must patch product files; verifier from the previous release tag (d). Bootstrap G-070. |
| 56 | Receipt validation deadlocks its producer; no owner-seat alternative | **Accepted** | Four-step lifecycle checks the producer **job** conclusion; owner-seat sequence and hash chain (c). |
| 57 | Candidate and publication evidence conflated; ledger blob invalidates history | **Accepted** | TEST trust root for candidate update tests; receipts bind `rowContractSha256`, not the whole ledger (c). |
| 58 | Component binding incomplete and overbroad; npx cache and alternate fetch paths | **Accepted** | Role-specific manifests; `loaded[]` and `spawned[]` throughout the run; empty cache plus cache scan. Residual G-069. |
| 59 | Rejection suite misses conditional bypasses and other attacks | **Accepted** | Cases added (e). |
| 60 | Corpus completeness | **Accepted** | Receipt binds the generation's source-coverage receipt digest, and the gate verifies it (c). |
| 61 | Daily runs of future requirements recreate alarm noise | **Accepted** | not-yet-applicable observations never page (e). |
| 62 | D0 benchmarks probes that do not exist | **Accepted** | Prototype three probes; the rest is labelled estimated. |
| 63 | G-039 can pass by becoming an owner-decision row | **Accepted** | Only a verified decision bound to R2 can change the target. |
| 64 | G-053 project root; G-056 non-empty fixtures; G-057 postconditions; G-059 credential isolation and rotation; G-060 approved inventory; G-035 uninstall vs erase | **Accepted** | Asserts rewritten as specified. |
| 65 | Frozen sample identities not bound to receipts | **Accepted** | Fixture sets are in the trust registry, and receipts bind the contract digest that includes them. |
| 66 | #329: nesting inference withdrawn; cwd fact stands | **Agreed** | Disposition keeps the cwd fact (`turn-outcome-capture.mjs:281-283`) and G-063. Nesting is not established across versions or platforms. |

## What this review could not verify

- Live Claude, Codex or Grok sessions. Hooks were driven through `hook-shim.mjs` with real payloads.
- Windows and Linux auto-update; this is code-read only (G-020).
- A real upgrade from 4.3 or 4.4. Older versions no longer install fresh (G-033).
- The owner's Mac.
- ntfy delivery.
- Whether a release transaction is pending.
- R2 and recall numbers: these are quoted from AgentDB records, not re-measured.
- G-053 and G-056: code read only.
- The `ps` exposure of the turn-capture value: inferred from code.
- The R15 branch: replayed for its trigger only.
- **None of the revision-3 mechanisms has been prototyped:** the local registry, the loader-hook
  tracing, workflow-structure assertions, signed decision files and the base-verifier checkout are
  designs.
- Whether `ssh-keygen -Y sign`, or an equivalent, can enforce a passphrase on the owner's existing
  key. This is G-068.

## Gap summary

70 rows:

| Severity | Rows |
|---|---|
| SECURITY | 9 |
| PRIVACY | 4 |
| DATA-LOSS | 4 |
| FALSE-GREEN | 16 |
| DOES-NOT-FIRE | 13 |
| CUSTOMER-VISIBLE | 11 |
| HYGIENE | 13 |

First due, by phase: S1a 12, S1b 15, S2 22, P1 16, P2 5. Reviewer findings map to rows in
`reviewMapping`; the round-2 residuals are G-066 to G-070.

| Issue | Disposition (verified against 3ddeb1fd) |
|---|---|
| #370 | STILL OPEN → G-001, G-002, G-014, G-057, G-065 |
| #369 | STILL OPEN → G-030 |
| #341 | STILL OPEN → G-016 (reproduced: 7 of 10 tools fail on published 4.5.2) |
| #335 | PARTLY FIXED (ADR-098 `--clean`) → G-028 |
| #331 | STILL OPEN: the direct `--update` path was fixed in 4750f287; the automatic check still runs the installed updater → G-042 |
| #330 | STILL OPEN → G-031 |
| #329 | FIXED FOR ITS NAMED SYMPTOM (d1f87ad6). The turn writer's cwd is the store directory; nesting is not established. Closes on G-063's published probe. |
| #326 | STILL OPEN (latent) → G-040 |
| #320 | STILL OPEN (feature) → G-032 |
| #319 | STILL OPEN → G-036, G-003, G-033, G-062 |
| #316 | ALREADY FIXED 5b28d8ca; closes on a published probe |
| #301 | STILL OPEN → G-027 (D4) |
| #298 | STILL OPEN → G-052 (D5) |
| #286 | NOT-A-DEFECT as a gate; quality residual → G-039 |
| #274 | STILL OPEN → G-049 |
| #264 | STILL OPEN → G-017 |
| #260 | STILL OPEN → G-050 |
| #258 | STILL OPEN → G-051 |
| #249 | DUPLICATE → G-047 |
| #236 | STILL OPEN → G-004 |
| #232 | ALREADY FIXED by removal (40166baf); closes on a published probe |
| #198 | STILL OPEN until probed → G-064 |
