---
id: ADR-087
title: One policy owner per responsibility and North Star acceptance
status: Accepted
date: 2026-09-16
updated: 2026-09-18
version: 1.3.3
authors: [Stuart Kerr, Codex]
tags: [consistency, continuity, recovery, grading, north-star, acceptance]
relates: [ADR-072, ADR-073, ADR-075, ADR-084, ADR-085, ADR-086]
governs:
  - data/consistency-acceptance.json
  - scripts/learning-replay-proof.mjs
  - scripts/sync-version.mjs
  - scripts/oracle/source-tree.mjs
  - scripts/oracle/*
  - plugin/scripts/coverage-integrity.mjs
  - scripts/corpus-reconcile.mjs
  - kb/fork-source.mjs
  - scripts/qa-runner.mjs
---

Updated: 2026-09-18 02:08:00 EDT | Version 1.3.3
Created: 2026-09-16 19:51:00 EDT

# ADR-087 — One policy owner per responsibility

**Status**: Accepted

Accepted is the repair decision authorized by Stuart on 2026-09-16. Implementation and customer acceptance remain open until the named evidence passes. The baseline is commit `3996f502b18157fdc84e325fbe87c2a05351d58c`. The two-vendor process is machine grading by two vendors, not a human approval.

## Principles

This decision serves P1 and P2 through customer-path evidence, P6 through explicit unknown states, P7 through real consumers, P8 through recovery and reversal, P10 through existing Brain/Ruflo owners, and P11 through causal learning proof. P3, P4 and P9 remain constraints: capture and recommendations cannot manufacture authorization or force unwanted action. P12 supplies standing authorization to finish this repair; incomplete results remain visible.

## Canonical obligations

`data/consistency-acceptance.json` is the machine-readable traceability projection of this ADR. Removing a required obligation or replacing a required journey with a smoke check does not satisfy the decision. Passing local unit tests does not confer installed, scheduled, public or North Star acceptance.

`source-tree.mjs` now owns immutable Git tree enumeration and `unit-inventory.mjs` owns completeness and per-file disposition in the production inventory path. Unresolved syntax, unsupported source modalities and pending semantic dispositions prevent a complete inventory. This wiring repair does not mean that the whole corpus has received semantic disposition or that the production oracle is complete.

## Current cleanup execution contract

The September 16 WP0–WP6 allocation is superseded by the whole-source reconciliation below.
Its historical machine-grading receipt remains evidence of that earlier plan only. The current
execution plan requires **source-bound Dual approval recorded in AgentDB**; this ADR does not claim
that implementation, installed behavior, certification or publication is complete.

The initial September 17 review covered 1,806 text files and 422,425 physical text lines, plus
23 separately inspected binary artifacts. The 2,949 candidate findings are review inputs, not
2,949 confirmed defects. Every candidate requires a reasoned accepted, duplicate, rejected or
historical disposition. Changed files require refreshed review; unchanged reviewed bytes do not
require another complete reading. The baseline and final count definitions must remain identical.

### One plan and one implementation owner

Use existing domain owners, migrate their callers, and delete only the proved superseded
implementation. Necessary independently distributed copies are generated and parity-checked;
compatibility facades retain no independent policy. Preserve historical receipt encodings through
explicit schema versions. Vector state belongs in RVF, operational state in the canonical project
AgentDB, and human-editable configuration remains in its existing format. JSON compatibility
projections cannot become a second writable operational authority.

J00 documentation reconciliation and J00B Dual admission repairs are preparation evidence. They
must be reviewed and included in the source brief **before** approval of J01–J12. The accepted
plan owns literal relative paths, dependency order, executable checks and exact test populations.
No file has two editing jobs. Each job completes its callers, tests and required generated copies
before its receipt is accepted. Later jobs consume the frozen interface and edit only their own
callers. A changed decision requires an explicit amendment and invalidation of affected evidence;
it cannot silently reopen a completed job while retaining its old receipt.

Ruflo records coordination and project decisions; native subscription hosts and Codex workers
perform execution. Root owns integration and shared manifests. Read-only preparation and review
run in parallel within actual session limits; writing sessions never share a checkout. Existing
side checkouts supply reviewed variants, not permission to maintain competing implementations.

| Job | Complete responsibility and selected owners |
|---|---|
| J01 | Source/package/process identity, repository identity and canonical store resolution. Preserve the approved source-digest recipe throughout execution; distribute required in-repository projections in this job. |
| J02 | Private-preserving storage/update transactions, installed-runtime identity consumers, refresh-run ownership/fencing, and the narrow KB atomic JSON helper. Complete applicable installer and caller migration together. |
| J03 | Project progression, durable capture/restore, lessons and learning evidence. Canonical field authority, exact AgentDB readback and crash/replay semantics govern every consumer. |
| J04 | Corpus/build consistency, RVF persistence and AgentDB-authoritative shard progress with a read-only JSON compatibility projection; migrate watchdog consumers together. |
| J05 | Retrieval, grounding, source evidence, MCP and hook boundaries. Consolidate result/budget semantics and retire dormant duplicate blocking scripts without resurrecting automatic interception. |
| J06 | Model facts, routing decisions/outcomes, consented learning and native availability. Consume the already reviewed Dual bootstrap unchanged. |
| J07 | Console mutation/undo behavior, shared feed styling and advocacy delivery/acceptance/effect semantics. Respect refusal, session identity and explicit user controls. |
| J08 | Scheduler, launcher, incident and spend observations. Consume the J02 refresh writer; keep nightly-gists transport and delete nightly-wrapper. |
| J09 | Qualification obligations, exact corpus-candidate selection, report populations and the stronger asynchronous host matrix. Retain producer lanes; delete the weaker aggregate and unused spike driver. |
| J10 | Complete generated npm/plugin/KB/console/TriSmart artifacts, source-independent execution, parity and packaging. TriSmart documentation is finalized before its ZIP is built. |
| J11 | Current documentation/public claims, obsolete surfaces and preserved-data reconciliation. Accept worktree retirement evidence before the final consolidation job. |
| J12 | Integrate the exact accepted candidate into main, remove reconciled redundant worktrees without force, execute final cleanup journeys, and report measured reductions and remaining certification gaps. |

The source-bound Dual plan supplies each row's exact owned paths, finding IDs, canonical survivor,
caller migrations, deletions and executable acceptance checks. It is retained in the canonical
project AgentDB with its native evidence; neither this table nor a model-written PASS replaces it.
The existing `scripts/dual-workflow-contract.mjs`, `scripts/dual-workflow.mjs` and
`scripts/dual-workflow-store.mjs` own admission, ordered verification and durable workflow history.
They bind complete semantic review evidence, both native hosts, correction dispositions and the
actual source state. Synthetic fixture approvals cannot admit the product plan.

### Preservation and consolidation

The primary checkout's `docs/RUV-GISTS.md`, `kb/ruv-gists.sources.json` and
`kb/.ruv-gists.capture-cache.json` are user-managed state outside cleanup write/delete ownership.
Observe their bytes immediately before and after consolidation. Inventory ignored/private files
in every retiring checkout; preserve unique data in a surviving location before retirement.
Do not copy a live SQLite database without its consistent transactional state. Dependencies and
reproducible caches need named disposable scopes, not blanket deletion by extension.

Retirement acceptance belongs to J11; J12 performs final consolidation in the declared existing
main checkout. Revalidate preservation source and destination at retirement, then recheck before
physical removal. Concurrent user updates stop removal. A retirement receipt is not an atomic
filesystem lock. No force removal, reset, stash or overwrite of unique user data is authorized by
a successful code test. The final state is one main checkout, with any preserved user changes
explicitly accounted for rather than concealed as a clean Git tree.

The separate x.ruv.io workstream uses existing Ruflo public-read capabilities, Ruflo source
acquisition and Brain capability guidance. It adds no competing server, adapter, schema or store.
Its research is not evidence that incorporation or retrieval already works.

### Cleanup acceptance and remaining North Star certification

Cleanup requires source-bound normal and failure checks, actual packed install/update/recovery,
console/browser behavior, complete caller migration, named deletions and identical before/after
counting rules. Missing, skipped, TODO, unknown or zero-test obligations are not passes. Reuse an
existing exact-source result only where the consuming contract accepts that same evidence.

Whole-product certification remains a separate required evidence phase. Preserve these exact
North Star populations and thresholds; do not lower them after measurement:

- Continuity: ten normal and ten interrupted resumes per supported directed host transition; complete required-state fidelity, exact-path readback, no secrets.
- Learning: ≥30 held-out pairs across three families, both hosts and post-update; ≥10-point uplift with paired 95% interval above zero; no critical safety regression. Insufficient power is inconclusive.
- Operations: all nine supported OS/install-mode lanes, upgrade/recovery/uninstall; three actual scheduled cycles on two machines per OS, online activation within 24 hours, offline catch-up next successful run, loaded generation/delta retrieval/no-op.
- QA: every mandatory obligation passes; all critical trust/identity/grading mutants rejected and ≥90% other declared non-equivalent mutants detected.
- Development loop: twenty outcome-only tasks across four families, ten repeated per host; ≥90% acceptance, truthful non-success, zero unauthorized effects.
- Recommendations: forty predefined opportunities; ≥90% precision, ≥80% recall, complete trade-off/cost evidence, respected refusal and tested claimed reversals.
- Grounding: three question types per promised store; curated recall@10 ≥0.98, held-out recall ≥0.95, correctness/abstention ≥0.95; every citation resolves. Report metrics separately.
- Documentation: every advertised command executes; installed guidance/console render across supported lanes; no false-green health or critical accessibility failure; ≥90% predefined novice-task completion.

Run the applicable source, integration, hook, wiring, documentation, status, substitution,
version and release-qualification checks against the same frozen candidate. Actual scheduled,
OS, native-host, browser and public-artifact evidence remains necessary where required; a local
fixture or advisory score cannot stand in for it. Report unavailable evidence as an open gap.

Publication follows only the existing protected transaction and recovery/supersession paths,
under standing authorization and exact source/artifact gates. Public-byte and clean-install proof
follows publication and must reach `install-verified`; cleanup acceptance alone is not shipment.
No self-assigned 95/100, model agreement or absolute bug-free statement completes this decision.

## Authorized deletion-first baseline — 2026-09-17

Stuart authorized an immediate reduced local baseline before the larger J01–J12 remediation.
This amendment records that narrower pass; it does not admit the full execution plan, certify the
North Star, consolidate checkouts, or publish a release. Both native hosts reviewed the deletion
candidates and cross-critiqued the bounded scope. Strict Dual admission did not complete: the
Fable proposal used a Markdown fence/string proposal and Astra's critique returned an empty
findings array with its explanation in the verdict. Their original transports are retained; no
synthetic successful workflow receipt replaces those rejected schema responses.

The agreed removals are:

- `kb/build-big-all.sh`; `plugin/scripts/kling-preflight.sh` and its dedicated unit test.
- `console/install-architecture.html` and `console/install-mockup.html`; the canonical console
  architecture page remains, and granular installer controls remain unimplemented.
- `explainer/metrics.html` and `explainer/api/metrics.mjs`; fabricated counters have no replacement
  authority. The unrelated admin-stats and ping endpoints remain.
- `explainer/assets/video/ruvnet-brain-explainer.mp4` and `explainer-poster.jpg`; the existing
  accessible hero picture replaces them and was inspected at desktop and mobile widths.
- `docs/CONSOLIDATION-PLAN.md`, `docs/NORTH-STAR-95-EXECUTION.md`, `docs/WORK-REGISTER.md`,
  and `MORNING-REPORT.md`; these are superseded coordination snapshots.
- The withdrawn synthetic metrics evidence: `.release-evidence/metrics-dashboard-proof.md`,
  `W5-B-PERFORMANCE-BASELINE-REPORT.md`, `metrics-snapshot.json`, and `live-metrics.jsonl`.

The eighteenth removal, `kb/test-guard-injection.mjs`, was conditional on porting its unique
assertions into the existing detector/passage suites. The retained guard suite ran 47 checks with
no failures or skips. Scratch mutations removing override case-insensitivity and widening the
sensitive-token gap each failed their intended assertion; scratch copies were removed. Historical
battery counts remain historical and are not presented as current results.

The unused synchronous `runHostMatrix`/`runHostMode` implementation and `spawnSync` import were
removed from `scripts/host-install-matrix.mjs`. The asynchronous owner, receipt spellings, installed
MCP checks and retrieval canaries remain. No repository caller referenced the removed symbols.

The nineteenth and twentieth removals are `plugin/scripts/verify-interface.sh` and its dedicated
unit test. The current shim retains only a silent retired-ID branch. Historical shell cases now
verify no dispatch in both Brain states, and structured MCP tests retain authorization coverage.

Six runtime candidates are retained: `version-bump-gate.sh` and its unit test
(version/push semantics and hardening coverage); `nightly-wrapper.sh` and
`nightly-release-authority.test.mjs` (documented manual interface and failure/authority callers);
`scripts/qe/aggregate-4.3.mjs` (active six-lane CI consumer); and `scripts/oracle/spike-run.mjs`
(documented experimental driver). The version gate, aggregate, and spike driver preserve unique behavior or active callers. The
nightly wrapper and its authority test require an installed-scheduler audit before retirement.
Retaining these is not a completed J05/J08/J09 or proof that all North Star gaps are closed.

The permanent metrics redirects use the absolute explainer landing URL, including the .html path,
while preserving the unrelated API exemption. This records intentional retirement of the metrics
surface. Routing is source-changed, **not verified live**; the next explainer deployment must prove
both Vercel and prefixed proxy paths. Local browser and unit evidence cannot prove deployed state.

The deletion pass preserves private data, installed stores, scheduler registrations, immutable
release receipts outside the explicitly withdrawn set, and the primary checkout's user changes.
All five side worktrees have since been reconciled into the primary `main` checkout; source
transfer and private-state preservation receipts were checked before their removal. Final
source-bound regression and packaging receipts determine acceptance of this local pass.

## Historical September 16 plan grading receipt

This receipt grades the superseded September 16 plan, not the current cleanup plan. Astra authored that plan through its authenticated native Codex subscription; Fable requested four concrete corrections and accepted revision 1 through its authenticated native Claude subscription. No metered API fallback was used. This grades the plan, not the implementation. Exact recorded artifact digests:

- `revise-1-codex.json`: SHA-256 `eaacd5057270e88e2f5231fe323d09a2cb22ee6310c4bc03210c7b12a383a0dc`.
- `reverify-1-claude-code.json`: SHA-256 `29a710c578d4e967b9a5117619fadbd9fb44bdcbbefca98af5e0d716db85ec78`.
- `brain-plan-grounding.json`: SHA-256 `ff769f73baa363b3baf20d1fa74b69057acc04c2043226a3a5962be2980d2e67`.


## Verification boundary amendments — 2026-09-16

Fork admission is owned by the installed `coverage-integrity.mjs` module. Acquisition, pruning, installed validation, packaging, oracle denominators and Console counts use the same predicate. An admitted fork requires the exact fork head, upstream head and unique merge base, plus hashed change inventory and passage bytes. A legacy full-tree generation cannot satisfy that contract. An upstream lookup failure remains an acquisition failure; it does not shrink the census.

C3 qualification is distinct from the diagnostic publication policy adopted in ADR-086. A diagnostic reader always returns `c3Eligible: false`. A qualified report needs verified source and native production evidence, an externally trusted measurement attestation, exact store and partition sets, and re-derived counters. Passing local fixture tests establishes these rejection rules; it does not supply the missing complete production oracle or demonstrate the C3 threshold.

Native release grading is available through `npm run grading:produce -- ...` and signed-pair intake through `npm run grading:dispatch -- ...`. These are explicit operator entry points because the native subscriptions run on the authenticated local host. The hosted workflow validates signatures; it does not execute native subscriptions. A GitHub dispatch ref must be a branch or tag at the candidate commit. Receipt consumption checks the complete normalized release identity, including optional artifact identities, rather than a caller-selected subset.

The September 18 transport repair uses one shared gzip/base64 codec for dispatch and intake.
The complete signed receipt pair for the current 200-store canary exceeds the plain dispatch
budget; compression preserves every original byte. Both ends enforce a 60,000-byte encoded
budget, and intake enforces an 8 MiB limit per document during decompression, one gzip member,
valid UTF-8 and JSON, followed by the unchanged signature and complete-identity validator.
Plain legacy inputs are rejected; this intake workflow had never successfully deployed.
Candidate SHA format is checked before checkout. Tests use synthetic judgments and ephemeral
fixture keys and do not establish product grades or reviewer trust.

Operator prerequisites remain the approved native-review signing keys and their trusted public
keys in the Production environment, an actual review pair over the sealed artifact and canonical
D1–D8 rubric, and the successful exact-SHA intake run/artifact IDs. The keys and IDs were absent
from the checked repository/environment configuration on September 18. The transport repair is
not an end-to-end intake receipt, a 95 score, or publication authority. Intake executes the
candidate's validator after approved promotion; it is not an independent boundary against a
malicious candidate replacing that validator.


### Native grading identity amendment

Both native hosts reviewed and accepted Policy C on 2026-09-16. Native release grading may attest a subscription-authenticated invocation with the requested model explicitly classified as `requested-only`. It cannot claim an observed executed model. Codex 0.154.0 exec events expose a thread and completion but no reliable per-turn executed-model identity; the app-server schema investigation reached the same boundary. A catalog row or configured thread model is not execution telemetry. Failed, aborted, incomplete and rerouted invocations are rejected. The signed receipt binds the requested model and identity class, and consumers share that validator.

The stricter source-oracle production contract still requires observed call-level model identity. That evidence remains unavailable from this Codex native transport, so production qualification remains unknown rather than fabricated. Reopen this boundary when an authenticated native executed-model field becomes available, or after an explicit contract decision; do not relabel requested identity as executed identity.

### Measurement integrity amendment

A diagnostic score below its threshold does not itself stop candidate preparation. Missing measurements, inconsistent counters, wrong archive/runtime identity, retrieval errors and timeouts still fail execution integrity. Repository availability remains blocking, while its ranking floor remains informational. Diagnostic reports preserve bounded coverage and always return `c3Eligible: false`. The measurement runner verifies the shipped first-party search dependency closure and locked installed dependency versions before invoking customer retrieval. C3 additionally requires authenticated complete source qualification and exact per-source census, including gist members.


## Measurement provenance amendment — 2026-09-16

The native Astra/Fable code review identified a distinction between validating a report's arithmetic
and authenticating its measured outcomes. Detached repository-recall reports now require an external
Ed25519 measurement key. `scripts/oracle/measurement-attestation.mjs` owns their signature contract;
`repo-recall.mjs` signs only its real archive-runner path and refuses signing injected search results.
The verifier selects its trust key externally through `RUVNET_MEASUREMENT_PUBLIC_KEY`; a report cannot
supply its own authority. The complete report includes the archive, frozen questions, measured rows,
canonical gate, and controlled runtime identity. The private key is passed only to the corpus
measurement step as `RUVNET_MEASUREMENT_SIGNING_KEY`, and is removed from native reviewer environments.
The local authority is stored encrypted with SOPS and age outside the repository. No private key is
part of a report, source tree, model prompt, or public artifact.

Both retrieval instruments load the archive's verified first-party dependency closure in a fresh
runtime populated by `npm ci --ignore-scripts`. Registry tarball integrity is required for every
locked package, including optional packages; imported dependency entry points must resolve inside
that installation. A runtime is reused only for the lifetime of its extracted archive. The temporary
installation is removed on failure or process exit. This replaces reliance on installed version
strings as proof of executable identity.

Native machine grades retain an immutable local transport sidecar with client version, requested
model class, host session/thread, timestamps, process completion and raw prompt/stdout/stderr. Its
canonical digest must match the signed receipt. Requested-only model provenance remains explicit;
it does not manufacture executed-model identity or production-oracle qualification. Verification-stage
corrections join the same correction ledger and require a changed artifact plus a reasoned disposition.

These repairs do not assert complete North Star evaluation, full semantic corpus production, public
publication, or a completed per-file review ledger. The diagnostic score policy is unchanged: bounded
scope remains explicit and retrieval errors remain failures, while an honest low diagnostic score is
not relabeled as an execution error or as strict C3 acceptance.

### Measurement closure, 2026-09-16

The archive census identifies each original repository and gist at its real source commit. Physical derived views are authenticated exclusions from the original-source denominator, with a closed reason and generation-ledger digest; every physical store must be classified exactly once. Derived-view retrieval participation remains explicitly NOT-MEASURED until source-attributed query evidence is recorded. Counts are taken from the authenticated generation, never hard-coded.

Both accuracy and recall execute the staged archive closure in a controlled dependency installation and a killable worker. Timeout completion waits for worker termination before the archive can be removed. Reports retain runtime identity; standalone diagnostic consumers require oracle and evaluator identities, and candidate validation reconciles diagnostic coverage to the actual archive. Signed recall bytes remain unchanged at readback; its recorded informational floor cannot drift with a verifier configuration change. These repairs do not establish C3 or whole-product North Star acceptance.
