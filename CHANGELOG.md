Updated: 2026-10-08 11:23:54 EDT | Version 1.0.1
Created: 2026-09-11 08:46:59 EDT

# Changelog

All notable changes to RuvNet Brain are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Entries below "Unreleased" are facts about
what shipped in a given release; the "Unreleased" section tracks work in progress across the
current campaign and is finalized by the lead session before the next release cut.

## 4.5.18 candidate — 2026-10-08

- Tightens managed task dependency cancellation, acceptance evidence and explicit
  scope handling (`scripts/model-routing-controller.mjs`,
  `scripts/model-managed-workflow-service.mjs`).
- Preserves canonical project memory selection, consent and durable checkpoint
  evidence (`plugin/scripts/project-store-resolver.mjs`,
  `plugin/scripts/project-progression-producer.mjs`).
- Corrects bounded grounding, lesson ownership, QA evidence and corpus integrity
  consumers, with focused regression coverage.
- The rule campaign records 31 scoped candidate qualifications and 69 unresolved
  rules, including suspended P032. These counts are historical review scope;
  current exact source qualification, protected publication and installed
  verification are required before this entry can describe shipped behavior.
- No universal host routing, hook enforcement or all-100-rule conformance claim.

## Unreleased

4.5.17 hook-harness candidate:

- Adds a source-bound catalog of 100 practical rules and bounded relevant guidance
  at existing managed planning, implementation and review boundaries. Guidance
  does not replace the independent permission, acceptance or release gates.
- Binds grounding to Claude's native prompt ID or Codex's native turn ID, with
  host/session/project/nonce isolation and conservative missing-ID handling.
- Rejects failed, cancelled, interrupted and truncated retrieval evidence;
  prevents hashes from falsely certifying a semantic source review.
- Keeps foreign capture registrations as collision candidates rather than
  suppressing Brain capture without proof of the current turn.
- Bounds typed routine advisory output without dropping mandatory refusals;
  critical, unknown, foreign and repeated-event output is outside that cap.
- Current candidate needs exact-artifact native qualification and protected
  publication. This is not a claim that all 100 rules are hard-enforced.

4.5.7 customer repair candidate:

- Managed continuity commands dispatch through the active installed generation instead of
  stale copied handlers. Help acceptance is bound to that generation.
- Historical progression outbox payloads are loaded lazily. An explicit, reversible owner
  suspension pauses automatic progression while preserving memory and explicit checkpoints.
  The permanent bounded-history frontier remains a proposal, not a shipped fix.
- Brain OFF silences capacity advice. Owners can disable new promise capture with
  `RUVNET_PROMISE_CAPTURE=off` while existing-item closure and integrity checks continue.
- Footprint classification recognizes public legacy `.big` sidecars while retaining private,
  divergent and unknown files. Broader reclaim and reconciliation remain unresolved.
- The updater captures transaction-owned archive digests once per required algorithm while
  retaining signature verification and candidate/live per-store integrity checks.
- Pending continuity notices are deduplicated per session without suppressing capture,
  retries, degraded-state warnings or integrity checks. Concurrent deduplication is best effort.
- Refresh failures name the first required failed stage instead of optional failures or
  cleanup skips. Historical receipts and overall failure classification remain unchanged.
- Transcript capture rejects directories on Windows and rechecks the opened file, preserving
  unknown handling instead of misreading a directory as an empty completed turn.

4.5.6 native terminal routing and continuity (released, installation-verified):

- Persistent per-user Codex and Claude terminal launchers preserve native subscription
  authentication and user permission choices. Managed updates refresh their closed runtime.
- Codex routes accepted turns within the same native session through the official
  app-server proxy, including resumed conversations; startup starts the native daemon
  idempotently and refuses unsupported inference paths rather than bypassing routing.
- Claude's native mod selects model and effort at the inference boundary while preserving
  conversation context. The launcher checks activation at startup; vendor hook crashes or
  subsequent hook disabling remain a limitation, not a guarantee of continual enforcement.
- Native transport, policy overrides, source identity, disconnects and failure boundaries
  receive explicit release qualification. Unsupported or unauthenticated clients refuse
  the routed path without paid API fallback.
- Native terminal launchers support macOS and Linux. Platform qualification keeps portable
  routing checks active on Windows and verifies safe refusal of its unsupported Unix launch path.
- Customer continuity repairs validate duplicate history, preserve terminal failures and
  cancellation signals, parse JSONL incrementally, and bound observation conflict handling.

4.5.5 routing and hook reliability changes (released):

- Native subscription routing persists per user through the installed gateways. Managed
  updates preserve explicit user overrides and refresh launcher dependencies together.
- Weekly model discovery retains the approved policy when no new model appears. A new
  release triggers source-bound analysis and bounded independent qualification before adoption.
  Interrupted qualification resumes its proposal; expired research refreshes once.
- Qualification verifies native configured model and effort, completed turns, fixed acceptance
  cases, independent review and an unchanged policy before atomic promotion. Backend identity
  and exact subscription savings are not claimed. Incompatible clients retain the working policy.
- Codex hook output compatibility and trust reconciliation preserve disabled owner hooks.


Operational recovery candidate 4.3.27 (2026-09-19), published to npm and GitHub but still awaiting
public installation verification:

- Doctor distinguishes package, search-engine and validator versions, checks installed runtime
  bytes against the archive manifest, and rejects thin evidence in its answerable smoke test.
- Automatic hooks tolerate missing optional session identifiers, bound continuity work, and avoid
  repeating advisory interruptions. Explicit opt-in enforcement retains its contract.
- Public gist capture uses verified Git snapshots, checks complete observed inventories and source
  revisions, and fails before expensive corpus work when capture cannot be verified. Nightly
  completion follows the uniquely identified child workflow instead of treating dispatch as success.
- Retrieval qualification checks source support and process success. Historical routing/citation
  scores are not described as answer accuracy. A frozen operational oracle records corpus gaps.

4.3.28 was published to npm and GitHub but did not complete public installation verification.
Its Mac Claude-only lane reported seven trailing retrieval cases as unknown; it remains
`PUBLISHED_NOT_VERIFIED` until explicitly closed and is not being represented as a successful release.

Current 4.3.29 repair candidate (not yet published):

- Natural-language repository scope is a hard retrieval boundary, preventing identifier discovery
  from widening a named repository search. The public 30-second search limit now applies to every
  acceptance canary, not only the initial smoke query.
- The retrieval oracle remains bound to the exact 182-store public seed. The separate upstream
  inventory contains 194 eligible repositories, but 12 corresponding vector stores are not present
  in the pinned release seed. This release does not claim those stores were published; they require
  a separately qualified corpus-seed publication.

4.3.28 candidate changes retained below:

- Inline cross-encoder inference uses a two-thread ONNX budget by default, with
  `CE_INTRA_OP_THREADS` as an operator override. The model, candidate set and ranking policy are
  unchanged. Candidate qualification now rejects any host's first cited search above the same
  30-second limit used by public verification, and exercises the exact sealed artifact on macOS
  across all three host modes after installing the current host CLIs. Candidate host searches run
  sequentially so concurrent test fixtures do not compete for the runner's inference resources as a
  single real Brain user. Model warm-up is bounded to the Brain's own store; only the subsequent
  grounded host searches determine candidate acceptance.
- UX qualification now retries failed hard UI acceptance checks within its existing bounded
  attempts, keeps every acceptance budget unchanged, and remains red if no complete attempt passes.
- An explicit `repo:<name>` query now remains inside that source boundary; exact-identifier
  discovery no longer widens the requested release search into unrelated repositories.

Campaign context: a dual North-Star review (Fable 5.1 + GPT-6 Astra) measured this project at
31/100 against commit `2eef2024` (see `PROGRESS.md`'s 2026-09-11 entry for the full per-pillar
breakdown and provenance). The following lanes are running in parallel worktrees to close the
accepted six recommendations; bullets below are facts about what each lane has done so far, not
a claim that any lane's work is complete or released.

- **docs (this lane)** — in progress. Reviewed all 17 non-reserved `presumed-stale` ADRs against
  exact governed-code drift at `2eef2024`, recording a dated, digest-bound Currency-log row on
  each; found and corrected two real drift defects (ADR-013's duplicated unbuilt `governs:` claim
  naming files that never existed in git history; ADR-072's stale reference to a workflow file
  deleted 2026-09-04). Corrected README's version stamp (4.3.10 → 4.3.21) and coverage badge
  (41% → 42%, re-derived) via `scripts/version.mjs` / `npm run claims:fix`. Added the 2026-09-11
  PROGRESS.md campaign entry. Six ADRs (0058, 0063, 0067, 0073, 0074, 0075) remain reserved for
  the lead to finalize post-integration.
- **continuity** — in progress. Scope per the dual review: build a verified AgentDB continuity
  lifecycle; current measured state is capture (4.4s) and restore (5.1s) both working in
  isolation, but SessionStart's 2.5s deadline against ~3s per `ruflo` CLI call leaves continuity
  structurally UNKNOWN at the point it is meant to fire.
- **advocacy** — in progress. Scope per the dual review: proactive-activation scoping and outcome
  recording; current measured state is Claude mean 2.17/3 vs Codex mean 1.33/3 on a 6-positive/
  2-negative real-host cross-vendor graded test, with Codex never calling `search_ruvnet`.
- **grounding** — in progress. Scope per the dual review: retrieval hang/recall/freshness/
  duplicate fixes; current measured state is strict 41.7 / real-use 55.1 on an 18/25 GPT-6 Astra
  graded sample, 0/8 CLI-repo-KB freshness at `2eef2024`, and an unbounded hang on a
  `@claude-flow/…`-scoped query (>15 min, no timeout).
- **ops** — in progress. Scope per the dual review: corpus maintenance and progress monitoring;
  current measured state includes a 6-hour nightly gists-embed hang (32/394, all 8 shards) that
  the watchdog reported as OK, an unregistered `brain-update` refresh job, and the `ruflo`
  3.40.0 → 3.41.2 upgrade (export path fixed; import still writes `agentdb-memory.db`, tracked
  upstream as Ruflo #3196, open).
- **session-start** — in progress. Scope per the dual review: credential containment and
  source-bound QA/release/diagnostic verdicts at the session-start boundary.

Design drafts ADR-076 and DDD-0021 were written during this campaign and dual-reviewed; the
verdict on both was **changes requested** (Fable 57/100, Astra 46/100). They are being revised
and are not an accepted decision — no lane should treat either as settled.
