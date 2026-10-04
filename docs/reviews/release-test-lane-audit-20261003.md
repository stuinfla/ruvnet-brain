Updated: 2026-10-03 13:58:55 EDT | Version 1.0.0
Created: 2026-10-03 13:58:55 EDT

# Test lane audit — integration e01c96dc

Updated: 2026-10-03 EDT. Read-only audit, actual executor GPT-6.1 Sol; Ruflo ledger registration agent1791049684804-jm9ro2 is coordination only. Checkout: /Users/stuartkerr/Code/ruvnet-brain-worktrees/adr102-integration. No source edits and no broad test execution. Counts below were computed from current files, root Vitest includes, and RELEASE_REQUIREMENTS. No published/native proof inferred.

## Immediate result

The current producer contract is 26 reviewed source files plus 4 reviewed integration files. It omits the newly changed turn privacy/canonical recall, lifecycle-retention and causal-learning validators. Running every historical test repeatedly does not repair that requirement-inventory omission. Add narrowly reviewed acceptance to the authoritative inventory, preserve its no-skip/source-identity checks, remove literal duplicate invocations, and retain every distinct sealed-candidate/public/OS/host producer.

Live census: 645 *.test.[cm]js files; 641 root-included; 4 explicitly excluded. Directories: unit556, integration57, acceptance11, QE9, mutation4, regression3, mesh1, diagnostics3, experience1. No current files under root stress/failure globs. Separate G-001/G-002/G-014 *.probe.mjs files are not discovered as tests by Vitest or full-suite-gate.

## Exact duplication and mismatched claims

| Finding | Source evidence | Smallest preserving fix |
|---|---|---|
| Same integration producer runs Codex discovery and owned uninstall twice | integration-linux.yml:70-72 invokes reviewed integration suite; release-qualification-contract.mjs:83-94 includes these two files; integration-linux.yml:78-81 repeats them | Remove only explicit codex-skill-discovery/uninstall-footprint paths from second command; retain stale-install-trap and both node experience commands. Typed integration receipt still covers the two retained files. |
| CONTRIBUTING invites broad suite twice | CONTRIBUTING.md:42 invokes unqualified root Vitest; :336-337 lists root Vitest then full-suite-gate. full-suite-gate.mjs:139-145 itself starts root Vitest unless --from-report | One broad producer per source state. Use full-suite-gate alone if required, or evaluate an existing exact-source report via --from-report with correct --root; do not run root Vitest then invoke the producer again. A receipt judged from old source is not candidate proof. |
| qa:release is not qa-runner --release | package.json:19 qa:pr=qa-runner; :21 qa:release=version+authority+dedicated QE config. docs/qa-execution-contract.md:45 says both retain qa-lanes reports | Correct docs to actual entry points; do not silently replace one with the other. qa-runner --release is broad developer diagnostics and runtime claims require explicit candidate bindings. |
| Broad local/root suite overlaps every reviewed source/integration file and release QE files | vitest.config.mjs:24-45 includes unit/integration/QE/acceptance; qa-lanes.mjs:28-36 runs many of same partitions; separate qualification/QE runs enforce different identities/contracts | Do not call multiple wrappers expecting new independent proof. Keep authoritative producer runs once. Broad diagnostics can be one retained run when policy demands it. Different artifact/platform receipts are not duplicates merely because file names overlap. |
| Release PR canonical job reruns full suite unconditionally while reviewed producer is consumed | canonical-qa.yml:20 skips only qualify-development for release PRs; full-suite at42 has no guard; needs at74 includes it; lines94-99 consume exact preflight receipt | Current machine rule still requires full suite on release PR. Any removal/reclassification is a reviewed workflow-policy change, not a local optimization. Update corresponding test/authority/docs together. Do not fake success or ignore its reds. |
| Producer runs again after fast-forward main | canonical-qa.yml:6-7 main push and qualify-development condition; integration-linux.yml:4-5 main push with consumer false | Potential second source/integration run on same SHA after promotion. Receipt reuse needs trusted exact-SHA, exact-contract and source clean identity checks; existing release-only consumer path is not enabled for main push. Avoid changing this hurriedly without protected DAG review. |

## Missing declared coverage and stale assertions

- qa-lanes.mjs:28-38 selects unit coverage, mesh, plugin, mutation, regression, integration, and only cross-host-project-resume from acceptance. It misses the other10 acceptance files, all9 QE files, and node:test experience/report. It does not represent the full root suite. --release is a diagnostic inventory, not a North Star or complete test claim.
- Vitest root includes only *.test.mjs; tests/e2e/closure/*.probe.mjs are intentionally undiscovered. Their source-driven subprocess assertions are not phase/authenticated sealed candidate or public closure receipts. They need explicit execution; never claim G closure from declaration or unit tests.
- full-suite-gate.mjs:24-29 census discovers *.test.[cm]js, not *.probe.mjs or install-smoke.mjs/require-brain-lane.mjs. Canonical workflow separately runs node:test experience at69; integration workflow explicitly runs installer/Brain node scripts at76-77. Keep these explicit non-Vitest cases.
- tests/known-red.json:5-21 explicitly excludes3 diagnostics + experience/report. No hidden root *.test gap found by census. Exclusion is deliberate and source-linked, not evidence those tests passed.
- tests/unit/qualify-once-workflow.test.mjs:45-50 explicitly asserts unconditional full-suite job, exact needs[qualify-development, full-suite] and FULL_SUITE_RESULT consumption. This must change only with reviewed policy change. Other tests assert same-candidate receipt consumption, no continue-on-error and three OS source acceptances at10-23/52-61.
- tests/unit/qa-contract.test.mjs:10-17 only scans --lane text in CI/canonical workflows. Those workflows currently don't invoke qa-runner lane selections, so the test is weak/vacuous for current reviewed test inventory; it does NOT guarantee current repairs are included.
- release-qualification.test.mjs:32/41-48 derives inventory dynamically; no hardcoded 26-file assertion. The 26 count is comments in full-suite-gate:4 and canonical-qa:35 and should become historical or dynamic after contract additions.
- tests/unit/qa-contract.test.mjs:25-28 calls qa-lanes continuity 'release acceptance' while qa-execution-contract correctly distinguishes packed diagnostic from native/public proof. Rename narrow test description if touching; assertion can remain its diagnostic path contract.
- scripts/qe/ux-suite.mjs:14-15 claims old SessionStart probe separately callable only; :330-341 actually executes runSessionStartGate as a HARD gate. This is a stale comment, not grounds to delete the measured gate. qa contract already corrected automatic host hooks versus retired broad legacy interceptors.
- bin/install.mjs:129 and :5980 still say zero automatic registrations; actual automaticHookRetirementStatus at2369-2467 allows registered continuity policy callbacks, hook-retirement-check.mjs:20-23 describes continuity-only plane. Current tests distinguish disallowed legacy callbacks from allowed continuity. Do not reinterpret their empty `registrations` error-list as an empty manifest.

## Minimal new reviewed qualification inventory

Source contract should add requirement groups for changed implemented boundaries, not full owner R closure. Existing receipts are authentic only for the contract digest they ran; any contract edit invalidates old candidate qualification and needs new exact-source receipts.

Uniform3OS candidate files with no explicit skip/todo found on targeted read:

1. tests/unit/turn-outcome-capture.test.mjs — canonical consent/redaction, metadata-only breadcrumb, exact receipts versus false success, retry/dedupe, host Stop registration. Child fixtures are isolated; does not prove native host delivery.
2. tests/unit/project-store-resolver.test.mjs — canonical linked-worktree/store identity, real isolated Git.
3. tests/unit/lifecycle-evidence-retention.test.mjs — lossless phase token compaction, protection/unsafe roots/inodes. Parent measured retention+rehearsal44/44 in7.25s; this audit did not reproduce timing.
4. tests/unit/update-storage-transaction.test.mjs — recovery/inventory/retention consumer safety, fixtures.
5. tests/unit/learning-replay-proof.test.mjs — current source fixture, fake causal transcript/receipt integrity and mutant anti-forgery validation. tests/helpers/learning-replay-source.mjs:8-27 snapshots source scripts/plugin/package into isolated git repo. It is verifier tests, not real model inference.

Platform/prerequisite limits that prohibit blind uniform3OS inclusion:

| File | Exact blocker | Preserving handling |
|---|---|---|
| agentdb-recall.test.mjs | it.skipIf(win32) at129,142,155,178 (quiet-path shell, stalled git executable fixture, registered launcher, shell dedupe) | Separate explicitly declared POSIX acceptance with exact inventory and zero skips, or split portable core versus POSIX shell tests into distinct files. No silent platform skip in current source qualifier. |
| learning-replay-verdict.test.mjs | it.skipIf(win32) at264 POSIX daemon census | Separate POSIX-only case from portable verdict/forgery tests, or implement actual supported Windows no-op assertion after source review; do not pretend daemon census ran. |
| learning-replay.test.mjs | dynamic live cases choose it.skip at673 if global Ruflo absent/exact roundtrip fails; prereq probe at655-658; hardcoded global local binary resolution | Current source CI jobs only npm ci (ci.yml:126,158,181), no Ruflo install. Keep explicitly prerequisite-bound diagnostic or split portable behavior tests; don't weaken no-skips qualification. |
| session-start-core-parity.test.mjs | describe.skipIf(win32) at245 | Explicit POSIX path only; keep neutral core assertions separate if uniform contract inclusion wanted. |
| tests/integration/continuity-journal.test.mjs | `(ruflo ? it : it.skip)` at341 | Install/verify required global Ruflo in integration producer and fail absent prerequisites, or separate fixture-only tests from real-Ruflo acceptance. Existing integration installs Codex, not Ruflo. |

Source producer rejects ALL skipped/pending/TODO cases at release-qualification.mjs:35-41, checks exact files at27-33, same-source clean receipts at46-67 and preserves source identity at113-119. Respect these controls. qualificationPlan currently takes suite only (14-20), so a platform-dependent plan is a contract/receipt validation change, not merely CLI filtering.

Minimum proof-preserving local candidate list:

- Exact changed-source reviewed tests above plus explicitly POSIX recall/verdict runs and existing release-qualification/qualify-once-workflow/qa-contract/full-suite-gate contract tests if editing the runner/workflow policy.
- G-001/G-002/G-014 process probes explicitly once; report source-only, no closed/MET claims.
- version:check, convergence check AFTER final commit, single-source:check, hooks:check, wired:check and applicable release:authority.
- authoritative source qualifier on final clean candidate after inventory corrections; local macOS receipt is not Linux/Windows proof.
- Exact sealed package QE when preparing candidate artifact; local broad diagnostic adds regression information but cannot substitute for source receipt or packed/public execution.
- Current recorded causal-learning portfolio/negative-control proof is a separately source-bound artifact; receipt validators passing cannot replace actual treated/control runs. Existing data evidence should be verified for the final source identity rather than rerun inference after documentation-only edits when its own freshness contract says valid.

## Mandatory remote boundaries to preserve

1. release-candidate-preflight.yml:18-31 CI/integration/UX source producers; :33-60 stranger + early-public OS paths; :62-106 exact Mac installed candidate search; aggregate :118-119 requires every leaf.
2. CI source suite per Linux/macOS/Windows atci.yml:128/160/183; release-qe exact npm pack once at210-218, exact KB bundle capability battery294-309, staged census341-369, candidate-host evidence379-391, exact-artifact release QE392-399 and sealed receipt400-407.
3. UX three OS hard budgets ux-qe.yml:18-23/54-57. Same file under other runners is distinct OS evidence. Maintain browser prerequisite and render/state-action assertions.
4. early-public installs packed smoke/host convergence, not full terminal public matrix. It overlaps two release QE files (agentic-qe-4.3.mjs:37-41) but serves other OS and earlier source boundary. Removing Linux overlap would require receipt schema/content review; not the first safe cut.
5. protected-release authentication consumes exact preflight artifact, verifies/seals payload, sole publication then public-verification matrix at420, aggregate/finalizer519-577 to install-verified. These are different trust/artifact phases; never eliminate as duplicated tests.
6. Current canonical-qa full-suite is a required workflow check on main PRs. Removing/reclassifying it requires reviewed synchronized policy/test/doc change; rejected ADR079 is not authority. ADR053 Accepted requires real literal installed commands/experience journeys; ADR058 Proposed stabilization notes150-154 explicitly support removal of duplicate execution while maintaining SHA/digest/security/OS/host/public guarantees. Its >=95 program remains separate and incomplete.

## Timing and savings honestly bounded

Known evidence: canonical-qa.yml:39-41 records historical M3 Max35min wall/29.5min summed file time under load~100, and says hosted timing not measured. Root maxWorkers1 (vitest.config:9-15) is deliberate:5 then2 workers broke subprocess/latency contracts. Do NOT increase global parallelism on guesswork. qa-contract.mjs:37-54 serializes same resource and awaits each batch; total lane time is approximately sum(test lanes) plus overlaps with static lanes. Each broad restart also pays per-file import/fixture/process setup and possibly coverage instrumentation.

Guaranteed execution reduction, not invented wall savings:

- Remove duplicate integration paths ->2 fewer file executions per integration producer (half of its4 reviewed integration files were replayed).
- Replace root Vitest + full-suite producer with one judged run ->641 fewer file executions on that unchanged source state (one full pass saved). Historical35min is a baseline estimate only; today's wall saving unknown.
- Repeated qa-runner --release plus root suite replay overlaps unit556+integration57+mesh1+mutation4+regression3+acceptance1 =622 root-discovered files; eliminate wrapper stacking rather than omit assertions. Coverage run additionally instruments code and cannot casually be substituted with uninstrumented report when claims depend on coverage.
- Avoid local repeated broad loops after only reviewed doc/contract correction once targeted gates are sufficient and required remote check remains. Changing mandatory full-suite policy itself is a separate approved code/receipt topology change.

Not tested: no broad suite, no hosted timing, no Windows execution, no real native host delivery, no public installation, no promotion, no full owner-requirement proof. The audit is current source/read-only evidence; inferred performance savings are execution-count reductions and historical timing comparisons only.

## Follow-up review of root dirty implementation against e01c96dc

Read actual diff and untracked changed-memory-process-probes wrapper; no edits or heavy test runs. The core plan correctly adds six uniformly portable source test files in four new requirement groups and five POSIX integration files, updates topology assertion away from obsolete unconditional broad-suite requirement, removes only the two duplicate integration paths, retains installed stale/Brain/install-smoke checks, and leaves CI/preflight/UX/protected/public receipts untouched. Three actionable correctness gaps plus one doc duplication were reported immediately:

1. New changed-memory-process-probes.test.mjs inherits process.env while root Vitest forcibly sets RUVNET_TURN_CAPTURE=off. tests/helpers/turn-capture-process.mjs:env also inherits process.env and doesn't override flag; captureTurnOutcome returns skipped immediately. Wrapper must force capture only in its isolated disposable fixture child. No broad global test-env weakening.
2. RUVNET_REQUIRE_LEARNING_REPLAY added to qualifier is inert: no current test/code reads it. Existing qualifier's zero-skips rejects missing tests, so it still fails closed eventually, but doc claim of explicit strict precondition is not implemented. Learning binary default scripts/learning-replay-execution.mjs:23-24 is ~/.npm-global/bin/ruflo; workflow currently npm install -g without matching prefix and does not export RUVNET_RUFLO_BIN. Install canonical prefix or export live command -v path; implement explicit required precondition if claiming it. Do not bypass zero-skips.
3. Removing full-suite job removed the ONLY explicit node:test experience/report.test.mjs automatic caller. This is ADR053 scenario-list/ADR058 D2 mutation proof, distinct from Vitest. Preserve it once in integration experience step.
4. ADR058 currency log has two near-identical newly appended 2026-10-03 rows. Keep one reviewed record.

Existing 30/30 targeted topology/qualifier results are parent-reported, not independently rerun here. They do not exercise the new real-process wrapper or missing global-binary path. All six new portable source files have no explicit case/group skip/todo by precise token inspection; assertion values `.skipped` in capture tests are product outcomes, not test skips. POSIX platform limitations stay outside three-OS source contract. Independent artifact/public receipt guarantees are retained by unchanged producer/consumer files; no native or published proof claimed.
