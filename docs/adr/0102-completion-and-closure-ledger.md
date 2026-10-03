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

**Date**: 2026-10-03 (revision 2, after adversarial review) · **Baseline**: `origin/main` 3ddeb1fd =
published 4.5.2 · **DDD**: [0022](../ddd/0022-closure-governance-context.md) · **Ledgers**:
`docs/closure-ledger.json` (65 rows, schema 2), `docs/requirements-ledger.json` (R1–R17, schema 2)

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

Every finding is answered in the [Adversarial review log](#adversarial-review-log).

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

**A release ships only when every gap targeted at its phase is proven closed, and every requirement
blocking from its phase is proven met, by an authenticated, executed probe of the bytes customers
install.** The parts follow.

### (a) The closure ledger — tamper-resistant by construction

`docs/closure-ledger.json` (schema 2) holds one row per gap: `{id, gap, severity, issues[],
requirement[], evidence, findingEvidenceClass, acceptanceTest{probe, realProcess, evidenceClass,
asserts[]}, proofArtifact, release, blockingFrom, status, owner{accountable, responsible}, dependsOn[],
decision{id, state, decisionKey}, registeredAt, tier, effort}`.

Every row's accountable owner is `stuinfla`. The responsible party is the release agent, or the owner
for decisions and owner-seat runs.

The gate compares the ledger at HEAD with the ledger at the last release tag and fails when any of
these hold:

- an `id` or `registeredAt` changed;
- `severity` was lowered;
- an assertion was removed or reworded (assertions are append-only);
- a probe path changed without its digest being re-recorded;
- a row or requirement disappeared without a disposition `{kind: duplicate-of | not-a-defect |
  withdrawn, decisionKey}`;
- `release` or `blockingFrom` moved later without a `decisionKey`.

A decision key records an owner decision that was actually made, with the owner's verbatim words and
date. "Needs a decision" is `decision.state = pending-owner`, never a status that releases a row.

A ledger edit on a release branch is a source change: preflight repeats on the new SHA
(CONTRIBUTING.md:46). This is accepted; it is the price of the ledger being in the release.

### (b) Proof receipts — authenticated, bound, fresh

A probe (`scripts/requirement-probe.mjs`) writes one receipt per run. Every field below is checked by
the gate. A receipt missing any of them is rejected with a named reason code.

| Binding | What is recorded and checked |
|---|---|
| Ledger | `ledgerRevision` = git blob sha of `docs/closure-ledger.json` at the candidate |
| Probe | `probeSha256`, `assertionsSha256` (must equal the ledger row's assertions) |
| Teeth | a mutant run in **this** run (`PROBE_MUTANT=1` flips the guarded behaviour). It must fail on a named assertion of the row. A mutant that fails with a module-load error is rejected. The unmutated run must load the same module set. |
| Package under test | `version` plus `integrity`: sha512 of `npm pack` for the candidate, npm `dist.integrity` when published |
| Executing components | resolved path and sha256 of every executing component (installer, `hook-shim.mjs` and each dispatched hook, MCP server, updater, plugin cache), recorded **before and after** the probe. Each must match the tarball manifest of the declared package. Any component matching neither the declared `from` nor `to` identity fails the receipt. |
| World | corpus generation searched, host name and version, configuration digest (env allowlist, prefs files), OS, Node |
| Producer | GitHub run id, run attempt, artifact id, job name, workflow path and head SHA. The gate validates these independently against the GitHub API: the run exists, the workflow and event are as declared, the artifact belongs to that attempt, and the conclusion holds. |
| Signature | CI receipts are signed with the release signing key. Owner-seat receipts are signed with a second key whose public half is committed (`keys/owner-seat.pub.pem`). |
| Freshness | candidate: produced by this run. Published: bound to the integrity of the version being verified. Daily: ≤36 h old. A receipt dated more than 5 min in the future is rejected. |

**Package-under-test integrity.** The updater runs `npx --yes ruvnet-brain@latest`
(`host-update.mjs:121`). During preflight, `latest` is the previous public package, so a broken
candidate could be replaced by working public code and still produce green observations.

Candidate probes therefore run against a local registry, inside the job, that serves the candidate as
`latest`, with egress to registry.npmjs.org blocked. The before/after component identities make any
substitution a failure. An upgrade test declares `from` and `to` explicitly. A component left at
`from` when the probe asserts `to` fails the test, and so does any third identity.

**Evidence classes** follow rUv's agentic-qe quality gate, which "block[s] only on EXECUTED/STATIC"
(`agentic-qe/assets/agents/v3/qe-quality-gate.md`). Here only EXECUTED receipts close a row. STATIC
findings (code reads) can open a row but never close one.

**Requirement state is separate from release blocking.** State is NOT-PROVEN, candidate-proven,
published-proven, daily-proven (= MET), regressed, or decision-pending. It is computed daily, shown
by `closure-gate --status`, and pages when it regresses. Release blocking is separate:

- `closure-gate --release <phase>` blocks on every row with `release ≤ phase`.
- It blocks on every requirement with `blockingFrom ≤ phase`.
- Nothing else blocks, and nothing that blocks can be reported-only. A requirement whose gaps are
  scheduled later blocks from that later phase. Moving it earlier is free; moving it later needs a
  `decisionKey`.

### (c) The gate, its modes, and its own rejection tests

`scripts/closure-gate.mjs` is deterministic and model-free.

- **`--check`** runs on every PR to `next` or `release/*`, and in `canonical-qa`. **This is the
  authoritative check.** It verifies:
  - the schema;
  - the tamper rules in (a);
  - issue linkage: every open issue appears in some row's `issues[]`;
  - every requirement R1–R17 has at least one probe;
  - every closed row has a published receipt;
  - severity order (DDD-0022);
  - SLA age computed from `registeredAt`.

  An issue closed by its reporter while its row is open moves the row to `closed-by-reporter`, which
  needs a disposition. It does not fail the gate. A GitHub API failure is UNKNOWN, which fails the run;
  it is never a pass.
- **`--check --local`** additionally verifies decision keys and recall manifests against AgentDB with
  `ruflo memory retrieve`. It is **advisory**: CI cannot read the local `.swarm/` store.
- **`--release <phase>`** runs in preflight and in the `protected-release` identity job. It requires
  candidate-proven receipts in preflight, and published-proven receipts before `install-verified`.
- **`--published`** runs daily in `requirements-probe.yml`. It runs every requirement probe against npm
  `latest` on ubuntu, macOS and Windows. A red result fails the run, and the run is on ntfy's watched
  list (G-058).
- **`--status`** is the only status surface. `WORK-REGISTER.md` and PROGRESS status paragraphs become
  generated or retired (G-047).

**Rejection suite** (`tests/closure-gate/rejection/*.test.mjs`). Each case asserts the gate's specific
reason code, and the same file asserts that a valid control fixture passes. A rejection caused by an
import error therefore cannot count. Cases:

- forged signature; tampered field;
- wrong package integrity; wrong probe digest; wrong corpus generation; executing component outside
  the tarball manifest; substituted `latest`;
- stale receipt; future-dated receipt;
- receipt from another run attempt; artifact not owned by the run;
- removed row; weakened assertion; lowered severity; release moved later without a decision; missing
  requirement;
- GitHub API failure; issue-close race (issue closed between read and comment); skipped job; missing
  OS × host matrix cell;
- gate invocation removed from the workflow, detected by a workflow-structure assertion.

**Integrity of the gate itself is R17**, and R17 blocks from S1.

### (d) Preflight runs the public-lane install before anything is published

`release-candidate-preflight.yml` gains a `requirements` job on all three OSes. The aggregate needs it.
It:

1. runs the pending-transaction check first (G-046);
2. installs the packed candidate through the public-lane path;
3. runs `--doctor --hooks` in the claudeOnly, codexOnly and dual modes (the 4.5.0 failure);
4. runs the probes blocking at the candidate's phase, with their mutants;
5. runs `closure-gate --release`.

Re-introducing the 4.5.0 defect must turn it red.

### (e) The mechanism must catch the historical misses — walked one by one

| Miss | The probes that go red | Separate evidence required |
|---|---|---|
| **4.5 auto-update did not fire** | G-019 probes R3-a to R3-h, below | Publication of corpus N (watchdog dated from the newest `corpus-sha256-*` generation, kill-switch re-arm: G-012, G-021). Activation (R3-a…h). Alert delivery (nonce received: G-058). Owner-seat daily receipt (D9): `--doctor --json` on the owner's Mac asserts "knowledge current" (generation = published, ≤36 h) and "update plane fired ≤24 h", signed with the owner-seat key. |
| **AgentDB-first was missed** | The probe seeds a store with a constraint record (a recorded baseline and a recorded release rule), then asks for a score and a release dispatch. It asserts three things. (1) **Before:** the per-session recall receipt is timestamped before the first tool call and the final answer. (2) **Reached the model:** the injected block contains the seeded keys. (3) **Respected:** the Stop gate blocks a score that omits the recalled baseline, and PreToolUse on `gh workflow run protected-release` names the recorded rule. If recall fails on a score, status, plan, release or delete prompt, the gate says "AgentDB recall not performed" and blocks once. Silence on failure applies only to ordinary prompts. | A review's recall manifest is accepted only when it matches hook-written recall receipts for that session. That depends on G-022's S1 deliverable. Until it ships, recall verification of reviews is advisory, and this ADR says so. |
| **Plaintext capture by default** | G-001, G-057, G-065: planted token, a person's name and a medical phrase. Every byte the Brain and the owner's hook write is searched. | Owner decision D8 on scope and retention. |

The auto-update probes, R3-a to R3-h:

- **R3-a SessionStart only:** the KB moves from N−1 to N within 75 min, and the next SessionStart
  prints UPDATED.
- **R3-b MCP timer only:** no SessionStart after boot, and an old boot snapshot; the KB reaches N
  within 20 min.
- **R3-c host delivery:** after restart, the loaded plugin equals the runtime. A session booted on an
  older plugin is named by doctor.
- **R3-d agentic-kit ownership:** an ownership proof ≤36 h old makes the Brain defer; older than that,
  the Brain updates.
- **R3-e consent:** the states decided in D1.
- **R3-f OFF:** with the off switch set, nothing spawns.
- **R3-g offline recovery:** the update completes within 90 min of the network returning.
- **R3-h searched corpus:** after activation, answers carry generation N.

R3-a and R3-b are separate probes, so neither trigger can mask the other.

### (f) AgentDB — read always, write always, measured (R15, R16)

The base is ADR-101's branch (`fix-agentdb-gate` @adbcd75f, unpublished), which triggers on keywords:
it fires on 10.9% of 266 real prompts in a replay. It is widened to the bounded targets in G-022,
G-024 and G-018.

**Read (G-022):**

- **Coverage:** recall on ≥95% of non-trivial prompts. Non-trivial means ≥4 words and not an
  enumerated acknowledgement.
- **Latency:** hook p95 ≤500 ms (p99 ≤1000 ms), one process, both stores queried in parallel.
- **Size:** ≤600 B per block and ≤12 KB per session, deduplicated.
- **Relevance:** irrelevant records on ≤10% of a labelled 50-prompt sample.
- **Safety:** zero displaced safety blocks.
- **Before risky actions:** PreToolUse recall before `gh workflow run`, `npm publish`, `rm -rf` and
  `git push`.
- **Subagents:** spawn-time injection into subagent prompts (G-023).

The 500 ms budget exists because the current CLI path is too slow for every prompt. Measured on the
owner's M3 Max, one run per store: `ruflo memory search --smart` took 0.60 s on `memory.db` and 0.78 s
on `agentdb-memory.db` (Fable measured 0.69 s and 0.64 s). Two sequential stores per prompt would add
well over a second.

**Write (G-024, G-006, G-054, G-055):**

- **Owner instructions:** capture ≥90% of a labelled set of ≥40 real requirement and correction
  statements, with ≤5% false captures on 200 non-instructions, always as full sentences.
- **Checkpoints:** post-commit and post-release-step checkpoints with no model action.
- **Worktrees and subagents:** commits from every linked worktree; SubagentStop outcomes.
- **Durability:** unterminated complete records recovered; no uncommitted event dropped at the cap.

**Metrics (G-018):** recall-fire %, recall p95, median write lag and instructions captured vs stated.
These appear in `--doctor --json` and `closure-gate --status`; UNKNOWN is never 0.

**Privacy first.** Writing more without redaction multiplies a privacy defect, so G-001, G-002, G-053,
G-057 and G-065 ship before or with WRITE-ALWAYS.

### (g) Privacy and the owner's own hook

The owner's registered global hook `~/.claude/hooks/agentdb-turn-capture.mjs` writes plaintext
independently of the product:

- full final text into the stores;
- the same text into `agentdb-turns.jsonl`, created with default permissions (0644 observed);
- the same text into its dedupe state file.

The product defers Claude turns to that hook, which preserves the unsafe path. The product **never
modifies owner hooks silently**. Install and update detect the hook, report it, and offer the D8
migration: the product becomes the single redacted writer and the hook is deregistered. Until the
owner accepts, the doctor shows "turn capture: owner hook active, unredacted".

Token redaction does not protect arbitrary private text such as names, health details or client
matters. That limit is stated in CONTRIBUTING and SECURITY.md, and capture scope follows D8:

- **Scope:** only projects that adopted AgentDB.
- **Retention:** a default of 90 days.
- **Erase:** `--erase-turns`.
- **Historical copies:** a one-time `--scrub-turns`, run with a receipt, covering both project stores,
  the global store, WALs, jsonl files, ruflo scratch metadata, dedupe state and queued payloads (G-057).

### (h) Issue handling and the branch fixes land on

- **Integration branch `next` (G-029).** `next` is the standing integration branch. Fix PRs and ledger
  edits land there. `release/X.Y.Z` is cut as `origin/main` + `next`. The daily jobs read the ledger
  from `next`; branch selection is deterministic.
- **Authority split.**
  - `issue-ledger-check` (`issues: read`, `contents: read`) fails and pages when an open issue has had
    no row for 24 h.
  - A separate `pr-retarget` job (`pull-requests: write`) does only one thing: it moves a fix PR's base
    from `main` to `next`, with a pointer comment.
- **Acknowledgement is a row, never a comment.** The automated "being worked" comment is retired. The
  first reply names the row, its severity, its phase and its acceptance test.
- **Closure is posted by `protected-release` after `install-verified`.** The comment is idempotent,
  marked with the row id and version, and retried. A publication whose closure comment fails is
  reconciled by the next daily run. The comment names:
  - the version, the receipt and the acceptance test;
  - the reporter by handle, with thanks: @HF-teamdev (#370, #369, #341, #320, #319, #301), @pacphi
    (#335, #331, #330, #329), @adambkovacs (#326), @sparkling (#316).
- **Shared rows.** Where one row answers several issues, each issue is closed only when every row that
  issue maps to is closed.
- **Regression after closure.** A red daily probe reopens the row and comments on the issue.
- **SLA, from `registeredAt`:**
  - **SECURITY/PRIVACY:** a shipped mitigation (default changed, or the text corrected), or a recorded
    owner decision, within 72 h. Full closure in the next safety release. A full fix in 72 h is not
    realistic for multi-day rows such as G-001.
  - **DATA-LOSS, FALSE-GREEN and DOES-NOT-FIRE:** the next two phases, or 14 days.
  - **Everything else:** 30 days, or a decision.
  - Breaches page.

### (i) How this policy becomes operating policy

CONTRIBUTING.md is the only operating rulebook; ADRs record why. The change that implements
`closure-gate.mjs` also adds a "Closure ledger" section to CONTRIBUTING.md that states the rules in
(a)–(h). `single-source:check` then enforces that no other file restates them. Until that change
lands, this ADR is a proposal, not an operating rule.

## Order of work

Phase labels replace version numbers. Versions are assigned only after D0 measures the probe matrix
runtime.

| Phase | Content | Rows | Blocking requirements |
|---|---|---|---|
| **D0 — before implementation** (no release) | Freeze the measurable acceptance thresholds above, the owners and the dependencies. Benchmark the probe matrix on all 3 OSes. Get decisions D1–D9. Store each as a `decision-*` key and in the ledger. | — | — |
| **S1 — first safety release** | Privacy and containment with a historical-data policy; consent and truthful security text; truthful failures; citation integrity; the gate blocking at S1 with its rejection suite; the `next` branch; Node policy per D7 | G-001, G-002, G-003, G-004, G-005, G-009, G-010, G-011, G-014, G-016, G-029, G-046, G-053, G-056, G-057, G-059, G-061, G-062, G-063, G-064, G-065 (21) | R11, R17 |
| **S2 — reliability** | Both update triggers and host delivery; Windows/Linux and the Node matrix; old and private-overlay upgrades; durable replay; published daily probes and delivered alerts; uninstall | G-006, G-008, G-012, G-013, G-015, G-019, G-020, G-021, G-028, G-031, G-033, G-034, G-035, G-036, G-037, G-040, G-041, G-042, G-043, G-054, G-055, G-058 (22) | R3, R5, R9, R10, R13 |
| **P1 — product completion** | Always-read and always-write, subagents, owner-instruction capture, retrieval, advocacy, console inventory, local-time updates, optional hosts and routing per decisions | G-007, G-017, G-018, G-022, G-023, G-024, G-025, G-026, G-027, G-030, G-032, G-038, G-039, G-048, G-049, G-060 (16) | R1, R2, R4, R6, R7, R8, R12, R15, R16 |
| **P2 — hygiene and currency** | Text, docs and ADR currency, dream-cycle decision | G-044, G-045, G-047, G-050, G-051, G-052 (6) | R14 |

- **S1 is still large.** The reviewers' own estimates put the earlier 4.5.3 set at about 11
  engineer-days. If D0's benchmark shows S1 cannot ship within the SLA, split it into S1a (G-001,
  G-002, G-057, G-061, G-062, G-003 per D1, with the gate blocking on exactly those rows) and S1b. The
  gate never runs report-only.
- **G-022 ships in two stages.** Its S1 stage (ADR-101 reviewed, plus the per-session recall receipt)
  ships in S1 because the review-recall verification depends on it; its full assertions block from P1.

## Owner decisions (D0)

| ID | Decision | Recommended default | Consequence of each choice |
|---|---|---|---|
| D1 (G-003) | The signed knowledge bundle also replaces executable tool files and the updater itself, so "update knowledge automatically, ask before code" is impossible until the bundle is split into data-only and executable parts (ADR-092). What should run without asking until then? | Keep automatic updates, but only to versions with a signed install-verified receipt (G-062), and state it truthfully in SECURITY.md (G-061). Split the bundle in S2/P1. Then data updates automatically and code asks. | **Ask first:** safest, but knowledge goes stale on every machine whose owner never answers, which breaks R3. **Automatic (recommended interim):** R3 holds, and code changes without a per-machine yes; the release gate, not consent, is the control. **Split now:** right end state; costs a release cycle before R3 is honest. |
| D2 (G-025) | Should the Brain volunteer "rUv already ships X" by default? | On, at most one line per prompt, with zero lines on off-topic controls as a release criterion. | **On:** the product's purpose is delivered; risk of noise, bounded by the 0/30 control. **Off:** nothing changes for default users, and R1 stays unmet. |
| D3 (G-048) | What role does cost routing play? rUv ships `@metaharness/router`, a cost-optimal router (`metaharness/packages/router/src/index.ts`). | Remove the "routing available but not set up" line until routing is wired to that router behind a setting. | **Wire it:** real savings, plus a P1 task. **Remove:** honest now, routing deferred. **Leave as is:** advertises something undecided. |
| D4 (G-027) | Support Grok hooks? | Optional and best-effort, using the reporter's bridge. Not release-blocking until Grok loads plugin hooks in `grok -p`. | **Yes:** R4 met on a third host, plus maintenance cost. **No:** R4 narrows to Claude and Codex, and #301 closes as a decision. |
| D5 (G-052) | The dream cycle: 41 open PRs, none merged in 30 days. | Pause it until its findings feed ledger rows automatically, then resume. | **Pause:** less noise, and findings stop until resumed. **Fix compile and continue:** more findings that nothing acts on. |
| D6 (G-059) | npm trusted publishing (no long-lived token, provenance on). Needs a one-time setting on npmjs.com that only the owner's account can make. | Yes, one time. | **Yes:** removes the long-lived token and gives customers verifiable provenance. **No:** the token stays the single point of compromise; record it as accepted risk. |
| D7 (G-037) | Node 18 has been end-of-life since 2025-04-30, and CI never tests it. | Raise engines to ≥20 and add Node 24 to the matrix in S1. | **Drop 18:** honest support statement, plus a one-line change. **Keep 18:** add an 18 lane and fix whatever it finds. |
| D8 (G-001, G-057, G-065) | Turn capture: scope, retention, the owner's global hook, and historical data. | Redacted capture only in projects that adopted AgentDB; 90-day retention; `--erase-turns`; one `--scrub-turns`; migrate the global hook into the product's single writer (the owner approves the deregistration). | **Recommended:** continuity kept and plaintext removed. **Off everywhere:** the strongest privacy, and R6 continuity loses the turn record. **Keep as is:** the open privacy defect stays. |
| D9 (G-019) | Allow a daily owner-seat job on the owner's Mac (a LaunchAgent) that signs a doctor receipt. A LaunchAgent change needs explicit approval. | Yes. | **Yes:** the machine that complained becomes evidence. **No:** R3 stays proven only in clean homes, which is the situation that hid the 4.5 miss. |

D0 also freezes the numeric thresholds in G-022, G-024, G-025 and G-038. They are proposed here and
become binding only with the owner's sign-off.

## Consequences

- **Gains.**
  - "Done" is a property of the published package, re-checked daily.
  - Issues cannot sit behind a bot comment, and fixes have a branch to land on.
  - Owner requirements are a checked list.
  - Each historical miss needs a red probe to recur, and a red probe pages.
- **Costs.**
  - Preflight and public verification get slower by the probe-matrix runtime (unknown until D0).
  - A local registry runs inside CI.
  - A second signing key is held on the owner's machine.
  - Every ledger edit repeats preflight.
- **Limits stated plainly.**
  - **AgentDB in CI.** CI cannot read AgentDB, so decision keys and recall manifests are checked
    authoritatively only for presence. Their content is checked by the advisory local run and, after
    G-022's S1 stage, by matching hook-written recall receipts.
  - **Owner-seat signatures.** An owner-seat signature proves a receipt was produced on the owner's
    machine. It does not prove the owner said the words in a decision record. The decision file quotes
    the transcript turn it came from, and the reviewers may audit it.
  - **Live model sessions.** `claude -p`, `codex exec` and `grok -p` need credentials CI does not hold.
    Those probes (G-023, G-027, the owner-seat R3 receipt) are owner-seat receipts and are marked as
    such.
- **What would make this ADR wrong.** Flaky probes get disabled, as `issue-watch` and
  `learning-replay` were. Mitigations:
  - A flaking probe is itself a row.
  - UNKNOWN is never PASS.
  - Daily-only evidence such as G-013's seven green nights never blocks a release; the candidate check
    does.

## Adversarial review log

Fable 5.1 (F) and GPT-6.1-Sol (G). "Verified" means I checked the code or ran a probe in this revision.

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
- The local-registry approach in (b): designed, not yet prototyped.

## Gap summary

65 rows:

| Severity | Rows |
|---|---|
| SECURITY | 7 |
| PRIVACY | 4 |
| DATA-LOSS | 4 |
| FALSE-GREEN | 14 |
| DOES-NOT-FIRE | 12 |
| CUSTOMER-VISIBLE | 11 |
| HYGIENE | 13 |

Reviewer findings map to rows in `reviewMapping` inside the ledger.

| Issue | Disposition (verified against 3ddeb1fd) |
|---|---|
| #370 | STILL OPEN → G-001, G-002, G-014, G-057, G-065 |
| #369 | STILL OPEN → G-030 |
| #341 | STILL OPEN → G-016 (reproduced: 7 of 10 tools fail on published 4.5.2) |
| #335 | PARTLY FIXED (ADR-098 `--clean`) → G-028 |
| #331 | STILL OPEN: the direct `--update` path was fixed in 4750f287; the automatic check still runs the installed updater → G-042 |
| #330 | STILL OPEN → G-031 |
| #329 | FIXED FOR ITS NAMED SYMPTOM (d1f87ad6); closes on G-063's published probe |
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
