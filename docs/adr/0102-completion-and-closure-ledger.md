---
id: ADR-102
title: Completion and the closure ledger — release-scoped proof, persistent North Star debt, and published closure
status: Proposed
date: 2026-10-03
updated: 2026-10-03
version: 0.1.1
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [governance, release, requirements, issues, agentdb, privacy, closure]
supersedes: []
relates: [ADR-072, ADR-084, ADR-085, ADR-098, ADR-100, ADR-101]
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

**Date**: 2026-10-03 · **Baseline**: `origin/main` 3ddeb1fd = published 4.5.2 · **DDD**: [0022](../ddd/0022-closure-governance-context.md)

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

The answer to the second question is a mechanism, not a promise. This ADR defines it, and lists the
work it is intended to force. **Implementation state: NOT ENFORCING.** The gate, probe runner and
planned probes described here do not exist at this baseline. This amendment implements no release
gate, qualifies no candidate, closes no gap or issue, and marks no requirement MET. CONTRIBUTING.md
remains the operating rulebook; the contracts below are proposed additions, not current enforcement.

## How this review was done

AgentDB first (R15). The following is the original review's historical recall record; this
amendment requires canonical-only authoritative recall, as specified in (d). Recalled before any finding:

- **Project store** `.swarm/memory.db` (ns `default`): `plan-4.4-4.5-20260930`, `plan-4.4-4.5-20260930-v2`,
  `north-star-audit-2026-10-02-1790957160000`, `north-star-reconciliation-2026-10-02-1790961540000`,
  `release-4-5-known-limits-1790948703000`, `release-4-5-lessons-1790948703000`,
  `release-4-5-enhancements-1790957060000`, `release-4-5-repo-state-1790948703000`,
  `project-state-current-1790965011000` (newest), `decision-4.5-ships-today-20261001`,
  `decision-agentdb-first-r15-20261002`, `decision-retrieval-4.5-e2-off-20261001`,
  `decision-release-canary-integrity-vs-quality-20260930`,
  `lesson-agentdb-first-before-any-score-status-or-plan`, `lesson-automation-cannot-ack-itself`,
  `scorecard-2026-07-10-evening`, `scorecard-gpt56-27aae9e-20260728-1254`.
- **MCP store (noncanonical diagnostic history)** `.swarm/agentdb-memory.db`: semantic search on the 4.5 auto-update and nightly topics
  (hits were `turns` records and two older `project-state-current` rows; nothing contradicting the above).
- **Global store** `~/.claude/global-memory/.swarm/memory.db` (ns `global`):
  `lesson-audit-the-answer-not-the-wiring`, `lesson-capture-and-enforcement-must-share-a-store`,
  `lesson-review-before-push`.
- Owner memory files: `VISION.md`, `HANDOFF-2026-10-02.md`, the `feedback_*` index.

Then three parallel read-only reviews probed the published 4.5.2 package and the hooks in isolated
homes (`HOME`, `RUVNET_BRAIN_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` inside a scratch directory; the
real `~/.claude`, `~/.codex` and `~/.cache/ruvnet-brain` were never touched). All 22 open issues were
read with comments and each was checked against current code, not against its own text.

## Context — why reviews kept being partial

Features kept turning out not to work end to end. The 4.5 knowledge auto-update shipped and did not
fire on the owner's Mac. The AgentDB-first requirement was missed. Scores were computed from the wrong
sources. Six structural causes, each measured:

1. **Every ledger this project built was a document or a laptop script, never a release gate.**
   `docs/WORK-REGISTER.md` ("the ONE status source") carries a 2026-09-26 header. `PROGRESS.md` stopped
   on 2026-09-15. ADR-084's three invariants stayed Proposed. `claims:verify`, `doc:currency`,
   `substitution:check`, `test:cov`, `wired:check` and `single-source:check` run in no workflow, while
   README:528 and CONTRIBUTING say they fail CI (G-011). A ledger that cannot stop a publish is a diary.
2. **"Qualified" means unit tests passed on the source checkout.** `scripts/release-qualification-contract.mjs`
   lists unit test files. Preflight's early-public lane installs the packed tarball but never runs the
   doctor or host matrix (G-008). That is exactly the check that failed on all three OSes for 4.5.0,
   after publication. The scheduled `published-surface-probe` runs `npx ruvnet-brain@latest --help` and
   nothing else. So "shipped but doesn't fire" could not be caught by anything that runs.
3. **Reviews were scoped to diffs, not to requirements.** An adversarial review of a diff finds defects
   in the diff. It cannot find a requirement nobody wrote down. The owner's requirements (R1–R15) existed
   only inside one audit prompt and scattered AgentDB records. No machine-readable list existed for a
   gate to check against.
4. **Issues were disconnected from work.** No issue has been closed since 2026-09-13
   (`gh issue list --state closed --search "closed:>2026-09-13"` is empty), yet five are fixed on main:
   #316 (5b28d8ca), #329 (d1f87ad6), #331 (4750f287), #232 (40166baf) and #198. Every open issue carries
   an automated "maintainer has been paged and this is being worked" comment. `issue-watch`'s schedule
   has been paused since 2026-09-18, after failing. The acknowledgement satisfied itself; that is
   `lesson-automation-cannot-ack-itself` recurring (G-010).
5. **The rules made fixes unmergeable.** Fix PRs were opened against `main`, which moves only by
   fast-forwarding a release branch (CONTRIBUTING.md:15). Four fix PRs are now CONFLICTING and one is
   mergeable but unmerged. There are 41 open dream-cycle PRs and none were merged in 30 days (G-029).
6. **Alarms either cried wolf or were tuned green.** `learning-replay` has paged every night since
   2026-09-21. The corpus watchdog's WARNING exits 0, and its promoted-age is read from `releases/latest`,
   which a code release restamps. So the 48h07m corpus outage (2026-10-01 08:35Z → 2026-10-03 08:42Z)
   showed "1.4h old" (G-012, G-021).

What R3 actually did, end to end (fork B, published 4.5.2, isolated home): a real SessionStart
self-heal **did** fetch and apply the newer corpus `corpus-sha256-832bae…`. The mechanism works. It
did not fire on the owner's Mac for three reasons:

- The Mac never ran 4.5.2 code: runtime 4.5.0, Claude plugin 4.5.1. This review session's own
  PreToolUse hook executed from plugin cache `4.3.37` while `installed_plugins.json` named 4.5.2.
  Long-lived sessions keep the code they booted with.
- No newer corpus existed between v4.5.2 and 2026-10-03 08:42Z, because the nightly kill switch was
  left off after the release window.
- Nothing proves the behaviour on published bytes after release.

All three are structural. All three remain obligations for the proposed mechanism below; this document does not close them.

## Decision

A release candidate qualifies only when every gap due for that release has an executed passing
candidate receipt against the exact sealed package, and the candidate passes the established
requirement regression probes. Future-target gaps and unproven requirements remain visible as open
North Star debt; they neither become MET nor disappear when a patch qualifies. Publication does not
itself close a gap. Closure requires passing public verification against the same package integrity
after the release reaches install-verified. The full North Star is achieved only when every owner
requirement has current complete published proof. The proposed mechanism has seven parts.

### (a) The closure ledger and its gate

- `docs/closure-ledger.json` holds one row per gap, in the shape defined in DDD-0022: `{id, gap,
  severity, issues[], requirement[], evidence, acceptanceTest{probe, realProcess, evidenceClass, asserts[]},
  proofArtifact, release, status, tier, effort}`. The draft committed with this ADR holds 52 rows
  (G-001…G-052) and a disposition for each of the 22 open issues.
- Proposed `scripts/closure-gate.mjs` modes (deterministic; none needs a model):
  - `--check` validates the complete ledger: unique immutable IDs; valid severity and target version;
    issue-to-gap links; requirement-to-gap and requirement-to-probe declarations; provenance for
    target or disposition changes; and consistency between stored claims and derived evidence.
    A planned future probe may be absent, but remains explicitly PLANNED and cannot produce
    qualification or closure. A claimed executable or complete probe must exist. This mode never
    claims a release qualified.
  - `--release X.Y.Z --phase candidate` computes the due set from all unresolved rows with target
    `release <= X.Y.Z`, plus complete requirement probes explicitly due at this version. It also
    selects previously closed rows whose regression probes are required by the current contract,
    and all previously MET requirement probes. Each selected probe must exist, have a valid
    negative-control/mutant result, and produce a fresh EXECUTED receipt in this qualification run
    against the sealed candidate's sha512 integrity. Missing, failed, skipped, stale or UNKNOWN
    evidence blocks qualification. Future-target rows remain OPEN, NOT-PROVEN or DECISION-PENDING,
    never PASS. Passing gap-level evidence does not make a whole requirement MET.
  - `--release X.Y.Z --phase published` runs the same frozen due and regression sets against the
    public installation, requires npm `dist.integrity` to equal the candidate sha512 integrity,
    and binds results to the release transaction and authenticated install-verified aggregate.
    Only then can due rows derive CLOSED and linked issues become eligible for closure. A failed
    public probe retains historical candidate evidence, derives public verification FAILED and
    enters the existing recovery rail; candidate evidence never becomes published proof by relabeling.
  - `--published` schedules probes implemented and published for the current version. Declared,
    not-yet-due probes remain PLANNED / NOT-PROVEN in the complete report. Missing or failed due
    probes and regressions page; future planned work remains visible debt, not a fabricated pass
    or a nightly failure without a runnable probe.
  - `--status` reports due, futureDebt, regressions, decisionsPending, candidateEvidence and
    publishedEvidence separately. The proposed generated/retired status surfaces are G-047 work.

The due set is frozen in the candidate receipt using the ledger digest and target version. A change
to target version, requirement scope or probe selection requires a new candidate and review. The
release process cannot defer a row automatically or mutate the ledger to turn a failure green.
Security and privacy items due now cannot be deferred merely to admit lower-severity work. Unresolved
decision rows remain open obligations unless an actual owner decision retrieved from the canonical
AgentDB path changes their scope.

**States are phase-specific.** OPEN describes unresolved debt; CANDIDATE-PROVEN describes passing
exact-candidate execution; CLOSED describes passing exact-public execution after install-verified.
Candidate proof never authorizes an issue-closure comment. Historical published closure remains
traceable; a current regression is REGRESSED and cannot be hidden by an older receipt. Only
receipt-authenticated derived states are displayed as proof; editable ledger status remains a claim.
Receipts are proposed signed release assets alongside `public-verification-aggregate.json`.

### (b) The requirements ledger — "shipped but doesn't fire" cannot recur

`docs/requirements-ledger.json` lists R1–R17 in the owner's words, each with its source AgentDB key,
its gaps and its complete probe contract under `tests/e2e/requirements/`. R1–R17 remain the complete
owner contract. A requirement is **MET** only when every assertion in its complete acceptance contract
has current passing published proof (daily: younger than 36h; release: current public identity).
Passing G-001 and G-002 supplies evidence toward R11 and R6 but does not make either requirement MET.
A patch can qualify with future requirements NOT-PROVEN when its complete due set and regression
obligations pass. Existing MET requirements cannot regress. Requirements without a full implemented
probe remain NOT-PROVEN; narrower gap probes cannot be relabeled as the full requirement probe.
R16 is READ-ALWAYS / WRITE-ALWAYS AgentDB; R17 is the enforcement mechanism itself.

Probe contract (`scripts/requirement-probe.mjs`):

- Install the package the way a stranger does: `npx ruvnet-brain@<v>`, or the packed tarball through
  the same public-lane path.
- Use an isolated home.
- Drive real hook payloads through the installed `hook-shim.mjs`, or the host CLI where CI has one
  (preflight already installs host CLIs). Drive the real MCP server and the real updater.
- Write immutable receipts with: schemaVersion, phase (`candidate | published`), releaseVersion,
  sourceIdentity, ledgerDigest, requirementContractDigest, probeId, probeDigest, command, exitCode,
  artifactIntegrity, installationSource, os, node, host, startedAt, finishedAt, outputDigest,
  assertions, qualificationRunId and negativeControlEvidence. Candidate artifactIntegrity is sha512
  of the exact packed/sealed tarball installed by the probe. Published artifactIntegrity is registry
  `dist.integrity` and must equal the candidate integrity. Published receipts additionally bind
  releaseTransactionId and the authenticated install-verified aggregate identity. A candidate receipt
  never needs a nonexistent future npm release.

**Baseline** is the separately identified currently published package and its known debt, not a
passing candidate. Baseline and candidate receipts carry distinct identities. Baseline failures
cannot satisfy candidate obligations; baseline successes cannot be replayed as current candidate
proof. A promised fix must expose its defect on the baseline or defined mutant and satisfy every
acceptance assertion on the candidate.

A probe that imports from the source checkout is a unit test and cannot close anything.

The R3 probe is the one that would have caught 4.5:

1. Pin the KB to corpus N−1, with corpus N published.
2. Run one SessionStart, and leave an MCP server up past its interval.
3. Assert the KB reaches N and the next SessionStart prints UPDATED.
4. Repeat with plugin cache ≠ runtime, and on Windows.

### (c) Preflight runs the public-lane install path before anything is published

`release-candidate-preflight.yml` gains a `requirements` job, needed by the aggregate, on all three OSes:

- install the packed candidate through the public-lane path;
- run `--doctor --hooks` in the claudeOnly, codexOnly and dual modes (the 4.5.0 failure);
- run the frozen due gap probes, complete requirement probes explicitly due at this version, and
  all established requirement regression probes against the packed candidate;
- run `closure-gate --release X.Y.Z --phase candidate`; public verification repeats the same
  obligations with `--phase published`, showing every remaining requirement and gap as persistent debt.

Re-introducing the 4.5.0 defect must turn preflight red. That is this job's own mutant. A pending
release transaction is checked first, so a run fails in about a minute instead of after the build (G-046).

### (d) AgentDB first — applied to every review, every score, and to the product (R15, R16)

- **Reviews and scores.** Every review, score or audit committed under `docs/reviews/` or `docs/audits/`
  after this ADR carries `agentdbRecall: {stores: [...], keys: [...]}` naming the canonical `<project>/.swarm/memory.db` and exact keys retrieved through global Ruflo, and
  the proposed `closure-gate --check` would reject one without it. Reviewer and auditor prompts use the recalled
  records as input. The secondary MCP store is diagnostic history only; it cannot override canonical
  decisions or satisfy authoritative recall. The historical review above records what was read, not
  a requirement to consult both stores. Source: [CONTRIBUTING hook boundaries](../../CONTRIBUTING.md#hooks-what-runs-automatically);
  exact-path store/read-back pattern: [continuity journal](../../plugin/scripts/continuity-journal.mjs).
- **Ledger mirror.** Every ledger state change is mirrored append-only to AgentDB, namespace
  `closure-ledger`, key `ledger-<id>-<epochms>`, with `ruflo memory store --no-upsert --path
  <project>/.swarm/memory.db` and an exact-key read-back. The owner's 2026-10-03 requirement is stored
  as `decision-agentdb-read-write-always-20261003`.
- **The product (G-022, G-023, G-024, G-006, G-018).** ADR-101's branch (`fix-agentdb-gate` @adbcd75f,
  unpublished) is the base, widened from keyword-triggered recall (10.9% of 266 real prompts in fork A's
  replay) to:
  - **READ-ALWAYS:** on every non-trivial prompt (acks skipped), a relevance-thresholded block from the explicit canonical
    `<project>/.swarm/memory.db` through global Ruflo, ≤600 B, ≤2 s, silent on failure, deduped per session by content hash, never displacing a
    safety block. SessionStart surfaces `plan-*`, `decision-*` and `scorecard-*`. PreToolUse(Bash) recall
    runs before `gh workflow run`, `npm publish`, `rm -rf` and `git push`. Spawn-time injection of the
    recalled keys goes into subagent prompts.
  - **WRITE-ALWAYS:** an owner-instruction detector that captures requirement and correction statements
    with their full sentence, not only "from now on/always/never" phrasing. It missed 3 of 4 real ones,
    including the 2026-10-03 statement. Add milestone checkpoints at post-commit and post-release-step
    boundaries with no model action. Journal commits from every linked worktree: four commits made in
    sibling worktrees on 2026-10-02 are missing from the real store today. Record SubagentStop outcomes.
  - **Metrics:** doctor `--json` and `closure-gate --status` report recall-fire %, median
    journal-to-commit write lag, and instructions captured vs stated in a transcript replay.
- **Privacy first.** G-001 and G-002 ship before or with READ/WRITE-ALWAYS, because writing more
  without redaction multiplies a privacy defect. Turn capture today stores a planted token verbatim in
  both `memory.db` and a plaintext jsonl, and sends worktree turns to the machine-wide global store.

### (e) Issue-handling policy

- **Link within 24h.** The daily job (read-only `issues: read`) fails and pages when an open issue has
  no ledger row on the newest `release/*` branch. Ledger edits land on the open release branch, because
  `main` moves only by release. The job reads the newest release branch head.
- **Acknowledgement is a row, never a comment.** The automated "being worked" comment is retired. The
  first reply names the row ID, its severity, its target release and the acceptance test. Per
  `lesson-automation-cannot-ack-itself`, the gate's "acknowledged" predicate is the row, never any
  comment by any login.
- **Closure is posted by `protected-release`, only after `install-verified`.** It names:
  - the version;
  - the receipt;
  - the acceptance test;
  - the reporter by handle, with thanks. External reporters today are @HF-teamdev (#370, #369, #341,
    #320, #319, #301), @pacphi (#335, #331, #330, #329), @adambkovacs (#326) and @sparkling (#316).
  - for the already-fixed issues (#316, #329, #331, #232, #198), the fixing commit as well. They close
    with the first release that carries this mechanism, once their probes pass on the published package.
- **SLA:**
  - SECURITY/PRIVACY: target the next release, ≤72h to a candidate.
  - FALSE-GREEN/DOES-NOT-FIRE/DATA-LOSS: within two releases or 14 days.
  - Everything else: 30 days or a recorded owner decision.
  - A breach pages.
- **Fix PRs target the open `release/*` branch.** The daily job retargets or closes, with a pointer, any
  fix PR opened against `main`. Each dream-cycle PR is merged, closed with a reason, or linked to a row
  within 7 days, and the backlog stays ≤5.

### (f) Order of work — four releases

Order is severity: SECURITY/PRIVACY first, then DATA-LOSS, FALSE-GREEN and DOES-NOT-FIRE, then the rest.
Every row's acceptance test is in the ledger. Release targets:

| Release | Theme | Rows |
|---|---|---|
| **4.5.3** | Privacy, truthful gates, the mechanism itself | G-001, G-002, G-003 (owner decision on the default), G-004, G-005, G-008, G-009, G-010, G-011, G-012, G-013 (owner seat), G-014, G-016 (PR #342), G-021, G-022 (R15 branch, widened), G-029 policy, G-031 (PR #351), G-040 (PR #327), G-046. Closes #316, #329, #331, #232, #198 on published proof |
| **4.5.4** | Does-not-fire | G-006, G-015, G-017, G-018, G-019, G-020, G-023, G-024, G-028, G-030, G-034, G-036 (PR #353), G-041, G-042, G-043, G-049 |
| **4.6.0** | The product the owner asked for | G-007, G-025 (owner decision on advocacy default), G-026, G-027 (or owner no-go), G-032, G-033, G-035, G-037, G-038, G-039, G-048 (decision) |
| **4.6.1** | Hygiene and currency | G-029 backlog triage, G-044, G-045, G-047, G-050, G-051, G-052 |

The existing targets remain unchanged: 19 rows are due at 4.5.3. This amendment does not narrow that
release to privacy alone or silently defer any row. If the next patch is narrowed, amend the target
table and ledger together before qualification, record each deferral and reason, and freeze the
smaller due set. The integration owner must state the actual bounded patch target set. Candidate and
published gates must enforce that due set from the first release claiming this mechanism. A
schema-only ledger may ship as scaffolding labeled **NOT ENFORCING**; it cannot claim R17, issue
closure or release qualification. No generic report-only waiver turns a due privacy/security failure
green. Future full North Star goals do not block an otherwise qualified patch, but remain debt.

The ledgers retain every existing acceptance assertion. Broad phrases such as “every requirement
probe” mean all selected due complete probes and established regressions in the phase-specific
contract above, never nonexistent future probes or permission to omit a due gap assertion.

### (g) What the independent adversarial reviewers check next

Fable 5.1 and GPT-5.6-Sol (via codex), each given this ADR, both ledgers and the recalled AgentDB keys
above as input:

1. **Completeness.** Any process, open issue, or owner requirement missing from the ledgers, especially
   anything in AgentDB `plan-*`/`decision-*` that no row cites.
2. **Forgery.** Try to close a row without the behaviour: hand-edit `status`, reuse a receipt from
   another version, produce a receipt from the source checkout, satisfy a probe with a stub host, let a
   comment act as acknowledgement.
3. **Probe teeth.** For each probe, break the guarded behaviour and confirm the probe goes red. Check
   that assertions bound magnitude, not just direction. Check that determinism crosses a process
   boundary.
4. **Privacy.** After G-001 and G-002, plant secrets in user text, assistant text, tool output and file
   paths, then search every byte the Brain writes (stores, jsonl, receipts, argv, logs) for them.
5. **R3 on real bytes.** Re-run the N−1→N probe themselves against the published package, including
   plugin cache ≠ runtime.
6. **Severity calls.** Challenge every row ranked below SECURITY/PRIVACY that touches secrets, consent,
   or another user's data.
7. **Trade-offs below.** Attack whether they are acceptable.

## Consequences

- **Gains.** "Done" becomes a property of the published package that a clock re-checks daily. Issues
  cannot sit unanswered behind a bot comment. Fixes have a branch they can land on. Owner requirements
  are a checked list, not prose. The 4.5 failure mode needs a red probe to recur, and a red probe pages.
- **Costs and trade-offs.**
  - Preflight and public verification get slower by the requirement-probe runtime (not measured yet).
  - CI cannot read AgentDB (`.swarm/` is local and gitignored). So decision keys and recall manifests are
    verified in the release agent's local `closure-gate --check --local`, and CI would check only that they
    are present. A reviewer could cite a key that does not exist and CI would not catch it; the local run
    would.
  - Hook probes in CI drive the installed `hook-shim.mjs` and the host CLIs that are present. Live model
    sessions (`claude -p`, `codex exec`, `grok -p`) need credentials CI does not hold, so the subagent and
    Grok probes (G-023, G-027) run on the owner seat and record a receipt there. That receipt is the one
    proof class not produced by CI, and the ledger marks it.
  - The gate adds friction to every release, by design.
- **What would make this ADR wrong.** If probes become flaky, they will be disabled, which is exactly
  what happened to `issue-watch` and `learning-replay`. Mitigation: a probe that flakes is a G-row
  itself, fixed rather than skipped. UNKNOWN is never PASS (the `published-surface-probe` discipline).

## What this review could not verify

- Live host sessions on Claude, Codex or Grok. Hooks were driven through `hook-shim.mjs` with real
  payloads, not through a running host.
- Windows and Linux behaviour of the auto-update, which was code-read only (G-020).
- A real upgrade from 4.3 or 4.4. An older version can no longer be freshly installed (G-033), and a
  copied 4.5.0 home was confounded by absolute-path plugin registration.
- The owner's Mac.
- Delivery of ntfy pages. Only the workflow runs were seen.
- Whether a pending release transaction exists now (inferred none).
- Newcomer retrieval (R2) and whole-corpus recall numbers. These are quoted from AgentDB records and
  were not re-measured (G-038, G-039).
- The `ps` exposure of the turn-capture value, which is inferred from code.
- Whether the 0644 mode on the real turns jsonl comes from the product or from the owner's user-level
  hook.
- The R15 branch, which was replayed for its trigger only, not run end to end.

## Gap summary

52 rows: SECURITY 3, PRIVACY 2, DATA-LOSS 2, FALSE-GREEN 11, DOES-NOT-FIRE 11, CUSTOMER-VISIBLE 10,
HYGIENE 13. Full rows, evidence and acceptance tests are in `docs/closure-ledger.json`.

| Issue | Disposition (verified against 3ddeb1fd) |
|---|---|
| #370 | STILL OPEN → G-001, G-002, G-014 |
| #369 | STILL OPEN → G-030 |
| #341 | STILL OPEN → G-016 (reproduced: 7 of 10 tools fail on published 4.5.2) |
| #335 | PARTLY FIXED (ADR-098 `--clean`, hand-made backups kept) → G-028 |
| #331 | ALREADY FIXED 4750f287 (v4.3.38), unit-proven; residual G-042 |
| #330 | STILL OPEN → G-031 |
| #329 | ALREADY FIXED d1f87ad6 (v4.4.0); probe shows no `.swarm/.swarm` |
| #326 | STILL OPEN (latent) → G-040 |
| #320 | STILL OPEN (feature) → G-032 |
| #319 | STILL OPEN → G-036, G-003, G-033 |
| #316 | ALREADY FIXED 5b28d8ca (v4.3.29); probe: banner, card and Codex card pass, no-search blocks |
| #301 | STILL OPEN → G-027 |
| #298 | STILL OPEN, needs owner → G-052 |
| #286 | NOT-A-DEFECT as a gate (`decision-release-canary-integrity-vs-quality-20260930`); quality residual → G-039 |
| #274 | STILL OPEN → G-049 |
| #264 | STILL OPEN → G-017 |
| #260 | STILL OPEN → G-050 |
| #258 | STILL OPEN (write side) → G-051 |
| #249 | DUPLICATE → G-047 |
| #236 | STILL OPEN → G-004 |
| #232 | ALREADY FIXED by removal, 40166baf |
| #198 | ALREADY FIXED (the four named tests pass on 3ddeb1fd; fixing commit not identified) |
