
Updated: 2026-09-26 08:39:57 EDT | Version 1.1.0
Created: 2026-06-29 00:00:00 EDT
> **Before writing or reviewing any ADR, read [`../PRINCIPLES.md`](../PRINCIPLES.md).**
> An ADR that contradicts a principle is wrong, and the contradiction is the finding.

# RuvNet Brain — Architecture Decision Records

Each ADR records a decision the 3-way red-team forced, so it can't be quietly regressed.

| ADR | Decision | Kills |
|---|---|---|
| [0001](0001-verified-bundle-not-single-file.md) | Ship a verified **zip bundle**, not a single embedded `.rvf` (single-container = deferred spike) | F9 "one magic file" fiction |
| [0002](0002-ground-truth-multivendor-gate.md) | Quality gate of record = **ground-truth-against-source + multi-vendor panel**, not a captured LLM grader | F5/F8 asserted-not-proven |
| [0003](0003-point-deeper-retrieval.md) | **Point deeper**: KB resolves to exact `file:line` + neighbors + whole-doc; agent never chooses to dig | F1 the 15-month skim-and-quit |
| [0004](0004-effectiveness-first.md) | **Effectiveness first**; size is a later pass; f32/multi-vector over SQ8 for v1 | shallow-for-the-sake-of-small |
| [0005](0005-behavioral-grounding-not-lock.md) | **Retrieve-and-inject** grounding (⚠ *reconciled 2026-07-06 — hard-deny/Stop/SLO NOT shipped; see the ADR banner + ADR-0009*) | F4 drift; enforcement theater |
| [0006](0006-segment-per-repo.md) | **Segment-per-repo** + cross-segment normalization, not one merged HNSW | merge-confusion / false "cheap incremental" |
| [0007](0007-tiered-scope.md) | **Tiered scope** (T0–T3) by ingest depth; union selection rule | F7 unbounded-scope death |
| [0008](0008-autonomous-engineering-loop.md) | **Autonomous build loop**: Ruflo *decides* · Claude Code *acts* · brain *grounds*; SPARC + score-to-≥98 + ADR-0005 hooks + one-command install | the "brain alone is the product" / drift-on-action |
| [0009](0009-mirror-discipline-self-audit-and-qa.md) | **Mirror Discipline**: the brain passes its own bar — single version SoT, smoke-gated publish, eval flywheel, ADR-QA/DDD-QA/doc-currency as capabilities, ADR-0005/DDD reconciled to reality | self-drift; the "grounded product that lies about its own version" |
| [0010](0010-security-hardening-sec-0010.md) | **Security hardening (SEC-0010)**: Dragan's QE review — fail-closed fences, single version SoT, CVSS-9.8 dep cleared, injection-guard recall, unsigned-updater RCE vector closed (signing tracked), CI, secret-leak scrub — each finding's root cause + exact fix + verification | fence-fails-open; unsigned-RCE; CVSS-9.8; secret-leak; the drift class |
| [0088](0088-operational-evaluation-integrity.md) | **Operational evaluation integrity**: source-supported retrieval, explicit abstention, immutable independent fixtures, raw receipts | false passes from path-only grading and keyword-only usefulness scores |

## Complete index

The table above calls out the decisions the red-team forced; every other ADR is listed here so
none goes unindexed (single-source-check.mjs B11). Title is the file's own H1 (or its frontmatter
`title` when the file has no H1); Status is read from frontmatter (or the body's `**Status**:`
line), first clause only — see each ADR for the full, dated status history.

| ADR | Title | Status |
|---|---|---|
| [0011](0011-verified-quality-program.md) | The Verified Quality Program — gates that can fail, before scores that can be believed | Accepted |
| [0012](0012-grounding-gate-write-path.md) | Grounding gate on the write path — brain consultation is enforced, not advisory | Accepted |
| [0013](0013-onboarding-console.md) | The Onboarding Console | Accepted |
| [0014](0014-one-ruflo-reconciliation.md) | The One-Ruflo Reconciliation | Proposed |
| [0015](0015-self-optimizing-router-profiles.md) | Per-user self-optimizing model + reasoning-effort router profiles (development & production), configurator-driven | Superseded |
| [0016](0016-model-catalog-live-verification.md) | Model-catalog live-verification wall — model/version facts cannot ship from memory | Accepted |
| [0017](0017-recursive-per-user-learning-loop.md) | Recursive per-user learning loop — capture how you work, share learnings across projects, isolate facts | Accepted |
| [0018](0018-brain-activity-panel.md) | Brain Activity panel — the harness, visible, inside the configure console | Implemented |
| [0019](0019-rulake-download-and-defer.md) | RuLake — downloaded and kept current, integration deferred (format mismatch + no current payoff) | Accepted |
| [0020](0020-anti-fabrication-gates.md) | Anti-fabrication gates — every user-facing number RE-DERIVES, no gate may string-match the thing it guards | Accepted |
| [0021](0021-shared-hook-input-parser.md) | One shared hook-input parser — a PreToolUse gate is a parser; write and test the parser ONCE | Accepted |
| [0022](0022-architecture-review-followups.md) | Architecture-review follow-ups — what was fixed now, and what is deliberately deferred (with reasons) | Accepted |
| [0023](0023-intelligent-updating-stable-spine.md) | Intelligent Updating: the Stable Spine | Accepted |
| [0024](0024-derived-status-never-asserted.md) | Derived status, never asserted — faking is structurally impossible, enforced by a self-proving gate | Accepted |
| [0025](0025-hybrid-retrieval-and-self-retrieval-gate.md) | Meeting-recall fix — unique-path chunking + transcript-scoped BM25 candidates (global hybrid reverted; scoped hybrid shipped) | Accepted |
| [0026](0026-meta-proxy-passthrough-trial.md) | Meta LLM Proxy passthrough trial — make MetaHarness genuinely automatic, per-session and reversible | Proposed |
| [0027](0027-capability-advocacy-and-active-signals.md) | The brain advocates, it does not wait — capability advocacy + the death of passive signals | Proposed |
| [0028](0028-what-proactive-means.md) | What "proactive" means — the maturity ladder, and why a page you must visit is not proactivity | Proposed |
| [0029](0029-cross-project-lesson-promotion.md) | Cross-project lesson promotion — a lesson learned twice is a lesson that should be global | Proposed |
| [0030](0030-how-promoted-knowledge-changes-behavior.md) | Latent knowledge is not knowledge — few gates, many lessons, retrieved at the decision point | Proposed |
| [0031](0031-the-compounding-brain.md) | The compounding brain — rUv's corpus + the user's working knowledge + accumulated experience, made operative | Proposed |
| [0032](0032-capability-surface.md) | The capability surface — on, off, and the third answer we keep refusing to give: unknown | Proposed |
| [0033](0033-lesson-extraction.md) | Where a lesson comes from — extracting corrections from what the user actually said, at high precision or not at all | Proposed |
| [0034](0034-document-currency.md) | A document's status is a claim about code — derive it, stamp it with something you cannot type from memory | Proposed |
| [0035](0035-consent-and-legibility.md) | Consent and legibility — the nudge is the product, the block is the exception, and the pieces must be nameable | Proposed |
| [0036](0036-knowing-who-uses-this.md) | Knowing who uses this — counting installs and versions without becoming a tracker | Proposed |
| [0037](0037-provable-wiring.md) | The wiring gate cannot fail — fixing the predicate, not the allowlist | Proposed |
| [0038](0038-corporate-safe-posture-sec-0038.md) | Corporate-safe posture — verification cannot be downgraded, and captured data cannot carry secrets | Accepted |
| [0039](0039-scoped-secret-delivery-direnv.md) | Scoped secret delivery — keep the SOPS single source, stop exporting 66 credentials into every process | Accepted |
| [0040](0040-unprompted-speech-dial-scope.md) | What the advocacy dial actually governs — chokepoint, or honest per-channel controls | Accepted |
| [0041](0041-ground-truth-fixture-machine.md) | The ground-truth fixture machine — making recall and false-alarm rate falsifiable in-fence | Accepted |
| [0042](0042-four-oh-versioning-dev-until-verified.md) | 4.0 stays X.Y.Z-dev until it is verified — the version number is not a marketing lever | Superseded |
| [0043](0043-continuation-gate-must-force-not-whisper.md) | The continuation gate re-engages every stop, not once per session — the guard that killed "don't stop" | Proposed |
| [0044](0044-self-impl-benchmark-is-ruvs-graded-gate.md) | The Self-implementation benchmark is rUv's graded gate (evolve --bench), never a hand-rolled one | Proposed |
| [0045](0045-state-based-advocacy-the-explained-offer.md) | State-based advocacy — the explained offer, not the goal-matched guess | Rejected |
| [0046](0046-freshness-contract-and-atomic-user-actions.md) | Every rendered claim carries its as-of, and every user action is one transaction | Rejected |
| [0047](0047-in-session-dormancy-voice.md) | In-session dormancy voice — session-start delivery, a stable ceiling, and no offer without a verified undo | Rejected |
| [0048](0048-measuring-and-claiming-the-offer.md) | Measuring latency-to-surface, and claiming the right to speak | Accepted |
| [0049](0049-console-rebuild-explainers-scope-checkboxes.md) | The console rebuild | Accepted |
| [0050](0050-issue-pipeline-cannot-silence-itself.md) | The issue pipeline may never manufacture its own acknowledgment | Accepted |
| [0051](0051-codex-host-wiring.md) | Codex host wiring | Accepted |
| [0052](0052-4.0-is-proactivity-you-control.md) | 4.0 is the proactivity-you-control release — proven correct and user-dialed, not proven-better-by-field-outcomes | Accepted |
| [0053](0053-experience-level-qa-architecture.md) | Experience-level QA | Accepted |
| [0054](0054-brain-on-off-and-scope.md) | Brain on/off and per-part scope | Accepted |
| [0055](0055-proactivity-that-meshes.md) | Proactivity that meshes | Accepted |
| [0056](0056-currency-at-a-chokepoint.md) | Pay the debt, then wire the gate | Proposed |
| [0057](0057-ninety-five-on-both-graders.md) | 95 on both graders | Proposed |
| [0058](0058-the-95-contract.md) | The 95 contract | Proposed |
| [0059](0059-cross-encoder-pool-cap.md) | Bounding the cross-encoder pool | Superseded |
| [0060](0060-cross-encoder-cascade.md) | The two-stage cross-encoder cascade | Accepted |
| [0061](0061-subscription-only-dual-host-deliberation.md) | Subscription-only dual-host deliberation | Proposed |
| [0062](0062-remote-durable-release-transaction.md) | Remote-durable staged release transaction | Accepted |
| [0063](0063-managed-memory-boundary-is-enforceable.md) | The managed-memory boundary is enforceable, opt-in, and default-off | Accepted |
| [0064](0064-corpus-qa-proves-machinery-not-ranking.md) | The corpus-QA round trip proves the machinery, not the ranking | Accepted |
| [0065](0065-the-payload-boundary-is-the-shipping-invariant.md) | The payload boundary is the shipping invariant, and it is now a gate | Accepted |
| [0066](0066-the-lesson-bridge-one-wire-not-another-gate.md) | The lesson bridge | Accepted |
| [0067](0067-one-decision-one-reason-and-a-ledger-that-can-say-no.md) | One decision, one reason | Accepted |
| [0068](0068-dream-machine-nightly-evolution.md) | The Dream Machine runs this repo's nights | Accepted |
| [0069](0069-artifact-bound-source-coverage.md) | Source coverage is artifact-bound, complete, and release-blocking | Accepted |
| [0070](0070-release-generation-convergence.md) | One release generation across corpus, package, hosts, and retained state | Accepted |
| [0071](0071-facts-are-generated-behaviours-are-tested.md) | Facts are generated, behaviours are tested | Proposed |
| [0072](0072-whole-product-integrity-conformance.md) | Whole-product integrity is one executable contract | Accepted |
| [0073](0073-agentdb-perennial-project-continuity.md) | AgentDB is the complete perennial project continuity record | Accepted |
| [0074](0074-ruvnet-capability-claim-integrity.md) | RuvNet capability claims require live evidence | Accepted |
| [0075](0075-knowledge-to-execution-enforcement.md) | Knowledge-to-execution enforcement is a mandatory policy boundary | Accepted |
| [0076](0076-memory-full-integration.md) | Memory full integration: session recall and decision ledger | Rejected |
| [0077](0077-continuity-gates.md) | Continuity gates: ADR-as-code automation and decision tracking | Rejected |
| [0078](0078-release-automation.md) | Release automation: one-command ship with tag-driven deploys | Rejected |
| [0079](0079-testing-gates-and-public-ci.md) | Testing gates and public CI: pre-commit enforcement and visible discipline | Rejected |
| [0080](0080-model-routing-north-star-campaign.md) | Hybrid Model Routing Strategy for 95/100 North Star Campaign (W2–W6) | Rejected |
| [0081](0081-adr-as-code-automation.md) | ADR-as-Code Automation — Pre-Commit Enforcement of Architecture Decisions | Rejected |
| [0082](0082-north-star-unlock-path.md) | North Star 95/100+ Unlock Path — Four ADRs | Rejected |
| [0083](0083-model-routing-north-star-95.md) | High-Assurance Model Routing for North Star 95/100 | Rejected |
| [0084](0084-the-three-user-invariants.md) | The three user invariants | Proposed |
| [0085](0085-nightly-corpus-release-channel.md) | The nightly corpus release channel | Accepted |
| [0086](0086-corpus-seed-pipeline-consolidation.md) | The corpus-seed pipeline consolidation | Accepted |
| [0089](0089-installed-search-identity-health.md) | Installed search identity health | Accepted |
| [0090](0090-source-backed-capability-discovery.md) | Additive source-verified capability discovery | Accepted |
| [0092](0092-knowledge-is-data-only.md) | ADR-092 — Knowledge is data only — build each store once, ship only what changed, never through a code release | Proposed |
| [0093](0093-proactive-package-recommender.md) | ADR-093 — The proactive package recommender — "what would rUv do" from package cards, behind a flag | Proposed |
| [0098](0098-footprint-and-currency-guarantee.md) | The footprint and currency guarantee — one knowledge base, current, in use, nothing building up | Accepted |
| [0099](0099-self-learning-retrieval.md) | Self-learning newcomer retrieval with rUv's own learning tools | Proposed |
| [0100](0100-guaranteed-agentdb-continuity.md) | Guaranteed AgentDB continuity — material events, durable outbox, come-up-to-speed brief, one writer | Proposed |
| [0102](0102-completion-and-closure-ledger.md) | ADR-102 — Completion and the closure ledger | Proposed |
