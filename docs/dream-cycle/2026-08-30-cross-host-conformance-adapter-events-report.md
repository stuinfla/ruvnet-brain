# Cross-Host-Conformance / Codex-Parity SOTA Report — 2026

**Dream Cycle 2026-08-30 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## TL;DR

`plugin/scripts/codex-hook-adapter.mjs` classifies every Codex hook event into two buckets:
events whose output schema can carry `hookSpecificOutput.additionalContext` (`CONTEXT_EVENTS`, 6
of them) and events that cannot (4 more, plus `Stop`, handled separately). `tests/unit/codex-claude-hook-parity.test.mjs`
exists specifically to prove, per event, that the adapter wraps or drops a body's output correctly —
but it could not import the adapter's real `CONTEXT_EVENTS` to drive that proof, because importing
the adapter executes its side-effecting top level (a synchronous `fs.readFileSync(0, 'utf8')` stdin
read) the moment the module loads — the same import-time hazard the 2026-08-26 `brain-stamp.mjs`
finding (PR #176) named. So the test carried its own hand-copied arrays instead, and they had already
drifted: 4 of the real 6 `CONTEXT_EVENTS` (missing `PermissionRequest`, `SubagentStart`) and 2 of the
real 4 no-context, non-Stop events (missing `PostCompact`, `SubagentStop`). The file's own "per event"
claim was never once checked for those four. Latent, not live — `codex-hooks.json` wires none of
those four events today (verified by reading the manifest directly; 7 of the 11 real Codex events are
wired).

The fix follows this repo's own established precedent for exactly this class of problem
(`brain-stamp-resolve.mjs`, PR #176): extract the pure data (`CONTEXT_EVENTS`, plus a new
`ALL_HOST_EVENTS` catalogue) into a new side-effect-free sibling, `plugin/scripts/codex-hook-events.mjs`,
imported by both the adapter and the test. The test's `it.each` lists are now derived from that shared
source instead of hand-copied, so a future event added to either constant is exercised the moment it
exists.

## What's new

Nothing external — a test-coverage gap inside a single repo's own cross-host conformance layer,
found by re-reading `codex-hook-adapter.mjs`'s classification logic against the array literals in its
own parity test and counting: the header comment says 6 context-carrying events, the test's array had
4.

## Competitors — how autonomous nightly/self-improvement harnesses treat two-host output-contract drift (grade C: general knowledge, single-source per row; informs framing only, does not justify the implementation — the implementation is justified by this repo's own measurement above)

| System | Relevant stance on a test's own fixture data drifting from the code it tests | Grade |
|---|---|---|
| Sakana AI Scientist | Single-target experiment loop; no second host/runtime contract to keep two copies of a classification in sync with. | C |
| OpenHands | Tool/action schemas are typically defined once and consumed directly by the agent loop; no documented pattern for a second, hand-copied test fixture of the same enum drifting from source. | C |
| DSPy/GEPA | Optimizes programs against a metric function; a fixture-vs-source drift in test data is a generic software-engineering risk the framework does not specifically address. | C |
| SWE-agent | Tests generally exercise the tool interface directly; no publicized convention for deriving multi-host per-event coverage lists from a single source of truth. | C |
| Cursor background agents | Single-host execution model; the two-host classification-drift problem this repo has (Claude Code vs. Codex) does not apply. | C |

None of the five have the shape of problem this repo does (one behavior, two host adapters, one of
which cannot be safely imported for its constants). This repo's own "derive, never hand-list" sweep
(`tests/unit/entrypoint-guard-safety.test.mjs`, added 2026-08-12 after this exact class broke four
places) is the more disciplined approach already; tonight's fix is applying that existing discipline
to a fixture the sweep's own scan does not reach (it only catches multi-`copyFileSync` fixtures, not
hand-copied array literals) — and, per the independent critic below, the sweep itself DID catch the
first draft of tonight's fix once the test fixture started copying two files.

## Hypothesis (frozen before implementation, unchanged since)

> Given `codex-hook-adapter.mjs`'s real `CONTEXT_EVENTS` classification (6 events) and the full Codex
> event catalogue (11 events, 7 wired in `codex-hooks.json` today), when `tests/unit/codex-claude-hook-parity.test.mjs`'s
> per-event proof is changed to import both from a new side-effect-free sibling module instead of
> carrying its own hand-copied 4-item/2-item arrays, then the previously-unexercised branches
> (`PermissionRequest`/`SubagentStart` wrap-in-envelope, `PostCompact`/`SubagentStop` drop) should be
> provably covered for the first time — subject to: the 6 already-tested event behaviors stay green
> (no regression), the new assertions are not vacuous (demonstrated by breaking the adapter's actual
> branch condition and watching them fail red), and no other fixture in the repo that isolates a copy
> of the adapter breaks from the new import.

## Benchmarks / Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate` blocked identically to every prior night since
2026-08-19 (`eval-brain: no brain at /root/.cache/ruvnet-brain/kb`), independent of this diff.
`LLM_EVAL=blocked` — no `OPENROUTER_API_KEY`/model-calling credentials in this container; candidate
selected to be testable without model calls (deterministic classification + subprocess behavior).
`npm run claims:verify`: 3 PASS / 4 SKIP, identical class to every prior night (skips are all
environmental — brain not installed).

**Guard proven to fail first (TEETH), two ways:**

1. **Coverage-gap proof.** `git stash` to the pre-candidate test file and ran
   `npx vitest run tests/unit/codex-claude-hook-parity.test.mjs --reporter=verbose`: 16 named test
   cases, none named for `PermissionRequest`, `SubagentStart`, `PostCompact`, or `SubagentStop`.
   Restored the candidate and re-ran: 20 named cases, the same 16 plus exactly those 4, all passing.
2. **Branch-logic proof.** With the candidate applied, temporarily short-circuited the adapter's
   wrap-in-envelope branch (`if (false && CONTEXT_EVENTS.has(event))`, `plugin/scripts/codex-hook-adapter.mjs:176`):
   7 tests went red, including the two new ones (`PermissionRequest`, `SubagentStart`) and the multi-file
   fan-out test that depends on the same branch. Restored the real condition: 20/20 green again. This
   proves the new assertions exercise real behavior, not vacuous self-consistency — see the Reward-Hack
   Check below for the one honest limit of that proof.

## Baseline vs Candidate

| | Baseline (main) | Candidate |
|---|---|---|
| `tests/unit/codex-claude-hook-parity.test.mjs` named cases | 16 (4 CONTEXT_EVENTS + 2 NO_CONTEXT_EVENTS `it.each`) | 20 (6 + 4) |
| `PermissionRequest`/`SubagentStart` wrap-in-envelope coverage | 0 | 2 new passing tests |
| `PostCompact`/`SubagentStop` drop-output coverage | 0 | 2 new passing tests |
| Adapter runtime behavior for any real, wired event | unchanged | unchanged (same branch, same classification data, only its storage location moved) |

## Regression Analysis

**Fixture blast radius, found and fixed in-session.** Two OTHER test files build isolated sandbox
copies of the adapter by hand-listing its sibling files (`tests/unit/codex-lifecycle-hooks.test.mjs`'s
`installGroundingGeneration()`/`installInterfaceGeneration()`, `tests/unit/flywheel-cadence.test.mjs`'s
`seedCodexGeneration()`); adding the adapter's first-ever internal import broke all three of their
fixtures (3 failing tests) until `codex-hook-events.mjs` was added to each hand-list. A fourth fixture
— this candidate's own `runAdapter()` helper in `codex-claude-hook-parity.test.mjs` — initially "fixed"
itself by adding a SECOND literal `copyFileSync`, which `tests/unit/entrypoint-guard-safety.test.mjs`'s
"no fixture hand-lists the imports of a script it isolates" sweep (added 2026-08-12 after this exact
class broke four places at once) correctly caught as a new violation. Reworked to derive the copy via
`serverDependencies(ADAPTER)` — the same generic import-walker `codex-lifecycle-hooks.test.mjs` already
uses — instead of hand-listing. All four fixture sites are now either derived or (for the two hand-list
sites that predate the sweep) minimally extended by one filename; none reverted to a second hand-copy.

- `npx vitest run tests/unit/codex-claude-hook-parity.test.mjs tests/unit/codex-lifecycle-hooks.test.mjs tests/unit/flywheel-cadence.test.mjs tests/unit/npm-tarball-codex.test.mjs tests/unit/entrypoint-guard-safety.test.mjs`: **5 files / 69 tests, all pass.**
- `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs`: **5/5 pass** (the stranger-project, both-hosts TEETH gate this DEEP/SCAN pairing exists for).
- `npm run test:integration`, baseline (`git stash`) vs candidate: **byte-identical — 9 failed / 240 passed / 313 total, both sides.** All 9 pre-existing/environmental (`sqlite3` binary missing, `@xenova/transformers` missing, headless-Chromium path missing), same class every prior Dream Cycle night has hit since 2026-08-19.
- Full `npx vitest run tests/unit` (277 files, ran to completion twice): candidate **4 failed / 259 passed files, 4 failed / 3407 passed tests** of 3596 — the 4 failures (`advocacy-ignored`, `advocacy-outcomes`, `hook-shim-fallback-once`, `user-settings`) are the same pre-existing `chmod`-based EACCES-under-root-user class PR #178's and PR #190's nights already diagnosed (this container runs as root, so `chmod`-simulated permission failures don't enforce); none touch a changed file. The intermediate run before the `entrypoint-guard-safety` fix (5 failed files) is the honest before/after of finding and fixing that regression in-session, not a hidden retry.
- `node scripts/sync-version.mjs --check`: `4.2.2-dev` agrees everywhere, unchanged.
- `node scripts/doc-currency.mjs --check --changed origin/main`: exit 0, no blocking violations. One informational warning on ADR-051 (`governs-untracked` for the new sibling file) that resolves once the file is committed and tracked.
- **Blast radius**, independently confirmed by the adversarial critic below: `bin/install.mjs`'s `wireCodexHost()`/`prepareCodexMarketplace()` and `scripts/learning-replay-fixture.mjs`'s `nightlyRefresh()` all copy the whole `plugin/` directory recursively rather than an explicit file list, so the new sibling ships automatically; `package.json`'s `files` field ships `plugin/` wholesale; no other hand-copied `CONTEXT_EVENTS`-shaped array exists anywhere else in the repo.

## Darwin Lineage

Not run — no continuous parameter to evolve for a data-extraction/test-derivation refactor.

## Evidence

OBSERVATION (the parity test's own hardcoded arrays counted 4-of-6 and 2-of-4 against the adapter's
real classification) → MEASUREMENT (verbose test-name diff before/after; branch-logic red/green proof;
byte-identical `test:integration`; full `test:unit` matching the known pre-existing failure class) →
DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No benchmark, gold answer, or threshold touched — confirmed by diff inspection (only additive `it.each`
expansion and one new pure data module) and by the independent critic below. New assertions are strict
(`toEqual`, `toBe('')`, exact envelope shape), not loosened.

**Independent critic** (separate general-purpose agent, given the diff and told to find reasons to
reject it, not to confirm it): verdict **CLEAR**. It independently re-verified the `governs:` claim by
reading ADR-051's frontmatter directly, independently re-derived "7 of 11 events wired, exactly the 4
named are unwired" by reading `codex-hooks.json` itself rather than trusting this report, ran the full
requested test suite itself (63/63 passed on its snapshot, before the `entrypoint-guard-safety` fixture
fix — see below), and searched the repo for any other blast-radius site this report might have missed
(none found). It flagged one honest, disclosed limit rather than a defect: because the test's two event
lists are now derived from the exact same source the adapter reads, this particular `it.each` sweep can
no longer catch a typo *inside* `CONTEXT_EVENTS` itself (it can only catch a bug in the wrap/drop BRANCH
LOGIC, which the branch-logic TEETH proof above demonstrates it still does). That is a correct, narrower
guarantee than the old — flawed — hand-copied version offered on paper, and it is the same tradeoff this
repo already accepted for `hookIds()`/`policiesFor()` derivation in the same test file's other two
`describe` blocks (see that file's own header: "SO THE ASSERTIONS BELOW ARE DERIVED, NEVER LISTED").

Separately, and NOT by the critic — found and fixed by this session before the critic ran: the first
draft of `runAdapter()`'s fixture fix added a second literal `copyFileSync`, which
`tests/unit/entrypoint-guard-safety.test.mjs`'s "no fixture hand-lists the imports of a script it
isolates" sweep correctly flagged as a new violation of a rule that exists for exactly this reason
(2026-08-12, four places broke the same way at once). Reworked to derive via `serverDependencies()`
before the critic's review; the critic's snapshot ran against the corrected version, and its "63/63
passed" number reflects the fixed state, not the flawed first draft.

## Security Review

No new attack surface: `codex-hook-events.mjs` has no imports, no filesystem or network I/O, and no
externally-influenced input at module load — it is two literal data structures. Moving `CONTEXT_EVENTS`
out of `codex-hook-adapter.mjs` does not change what the adapter reads, writes, or trusts; the same
values, same Set, same membership checks. No new dependency, credential, or trust boundary. The two
existing fixture files gained one more filename in an existing hand-list of files already trusted to be
copied verbatim from the real checkout — same trust level as every other file already in each list.

## ADR

Currency-log row added to **ADR-051** (`docs/adr/0051-codex-host-wiring.md`), which lists
`plugin/scripts/codex-hook-adapter.mjs` in its `governs:` frontmatter — the new sibling
`plugin/scripts/codex-hook-events.mjs` was added to that same `governs:` list, and `updated:` bumped to
2026-08-30, in this same change. No new ADR: this is a test-coverage/internal-refactor fix to an
existing decision's implementation, not a new architectural decision, new default, or cross-cutting
policy change.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available in this session (same limitation every prior
Dream Cycle night since at least 2026-08-29 has recorded). This file and the linked issue/PR carry the
full report; no evidence lost.

## Next steps

1. A human reviewer should decide whether `PermissionRequest`/`SubagentStart`/`PostCompact`/`SubagentStop`
   are worth wiring to real hooks on Codex at all, now that their handling is provably correct — that
   product decision is out of scope for tonight's candidate.
2. The `entrypoint-guard-safety.test.mjs` sweep only scans for multi-`copyFileSync` fixtures; a fixture
   that hand-copies exactly ONE extra sibling (as `codex-lifecycle-hooks.test.mjs`'s and
   `flywheel-cadence.test.mjs`'s pre-existing fixtures still do, now with two hand-listed files each)
   is not caught by that sweep's `copies.length >= 2` threshold applied per `copyFileSync` CALL SITE
   rather than per fixture — worth a future night's look, not fixed here to keep tonight's diff to one
   conceptual change.
3. The review backlog is still large: as of tonight, 17 open PRs exist on this repo, the large majority
   Dream Cycle drafts opened 2026-08-22 through 2026-08-29, still awaiting human review — flagged again
   here, independent of tonight's candidate, consistent with the 2026-08-26 and 2026-08-29 rows' own notes.

## Witness

```
SESSION_COMMIT = 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f
REPORT_HASH    = 2e110baace7453604be030c060bd1750634052cfe2cb008cb784957335481f64
WITNESS        = fceab963b1c95dace245ed356d677dac45841b447ba52e168ae588844ad2c03b
```

Note on `REPORT_HASH`: it is the sha256 of this report's content through the end of the "Next steps"
section, computed BEFORE this Witness section was written (STEP 16's own chicken-and-egg order: stamp,
then rewrite the Witness section with the stamp). It will therefore NOT match a fresh `sha256sum` of
this file as it now reads, since appending this section changed the bytes — expected by construction,
not evidence of tampering.

**Verifier procedure (anyone can reproduce):**
1. `git checkout 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f` then apply this PR's diff.
2. Take this file's content through the end of "Next steps" (everything before the `## Witness`
   heading) and `sha256sum` it → must equal `REPORT_HASH` above.
3. `printf '%s%s' <REPORT_HASH> 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f | sha256sum` → must equal `WITNESS` above.
4. `npx vitest run tests/unit/codex-claude-hook-parity.test.mjs tests/unit/codex-lifecycle-hooks.test.mjs tests/unit/flywheel-cadence.test.mjs tests/unit/npm-tarball-codex.test.mjs tests/unit/entrypoint-guard-safety.test.mjs` → 5 files / 69 tests pass.
5. `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` → 5/5 pass.
