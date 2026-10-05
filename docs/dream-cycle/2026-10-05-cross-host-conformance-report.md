# Cross-Host-Conformance SOTA Report — 2026

**Dream Cycle 2026-10-05 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## TL;DR

`tests/integration/hook-conformance-both-hosts.test.mjs` is this repo's own name for "the both-hosts
hook conformance gate" (ADR-055's 2026-08-14 currency-log entry: "fires every command in both
manifests inside a stranger project and asserts RESTRAINT... None of the audit's cross-project
findings was catchable before, because every existing test ran the hooks INSIDE this repo, on this
machine, on one host"). On 2026-09-07, commit `00526b12` ("retire automatic hooks") replaced the
entire real-firing suite with schema/policy-only checks and dropped every `spawnSync` call — the
file never fires a single hook, on either host, anywhere, since that commit. `npm run test:integration`
stayed green throughout, because nothing in the replacement file can go red for a runtime defect.

The hooks themselves were never actually retired to nothing: ADR-055's own 2026-09-11 currency row
documents `ground-ruvnet`, `decision-gate write` and `grounding-stamp` being RESTORED to both
manifests days later, plus `grounding-turn-mark`/`grounding-turn-gate` and `capacity-aware-parallel-work`
added since — the manifests today register a 7-event, multi-hook automatic plane on both hosts, the
same shape of surface that produced the owner's original 2026-08-13 complaint ("a ton of hook errors
in another project"). The currency reviewer tracked that the hooks came back; nothing tracked that the
test proving they are SAFE in a stranger project did not come back with them. That is this repo's own
"a guard that cannot fail is not a guard" — found on the surface built specifically to prevent it.

## What's new

Nothing external — a test-coverage regression inside this repo's own cross-host hook-dispatch gate,
found by tracing `hook-conformance-both-hosts.test.mjs`'s git history (`git log --follow`, full
unshallowed clone) against the two hook manifests' current registered commands.

## Competitors — how other autonomous coding/nightly-evolution harnesses treat "the gate stayed green while its coverage silently emptied out" (grade C: general knowledge, single-source per row; informs framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No cross-host hook-dispatch surface to reconcile; not directly comparable. | C |
| OpenHands | Single sandboxed runtime per session; no analogous "does the same guard still fire for real after a refactor" concern. | C |
| DSPy/GEPA | Optimizes against a metric function; a metric that degenerates to always-pass after a refactor is the same reward-degeneration class GEPA's own designers warn about, not something the framework audits for you. | C |
| SWE-agent | Surfaces tool-call failures as raw observations; no first-class check that a test file's own coverage didn't silently shrink to zero. | C |
| Cursor background agents | Single-host remote environment; no cross-host conformance claim to falsify. | C |

The recurring pattern: nothing in any of these frameworks independently re-verifies that a named gate
still measures what its own history says it measures, after an unrelated-looking refactor touches the
same file. This repo's own ADR-068 STEP 10 ("did it exploit the evaluator... rely on an undocumented
[no-op] setup") is the discipline that would have caught `00526b12` at review time — applied here,
retroactively, by the Dream Machine itself.

## Hypothesis (frozen before implementation, unchanged since)

> Given the both-hosts hook-conformance integration suite, when the real-firing "every registered hook
> behaves in a project this plugin does not own" describe block is restored (`fire()` spawning each
> manifest-registered command, on both Claude Code and Codex, inside a genuine stranger temp-dir
> project, asserting no stderr, no stray files, and completion within the manifest's own declared
> timeout), then `npm run test:integration` should newly measure real cross-host hook safety that it
> currently proves nothing about, relative to baseline (current `main`, where this file spawns zero
> hook subprocesses), subject to: zero regression to the continuity-plane schema checks already in the
> file; no weakening of any existing assertion anywhere in the repo; and the new assertions must be
> demonstrably non-vacuous (shown to flag a deliberately broken hook, not merely pass by construction).

## Evaluation Receipt

Candidate: `tests/integration/hook-conformance-both-hosts.test.mjs`, +163/−0 lines, one file, purely
additive (nothing removed or modified). Fixtures (`strangerProject`, `installCodexSpine`,
`hookCommands`, `fire`, `cleanupStranger`) are reused byte-for-byte from the last known-good version,
recovered via `git show 00526b12^:tests/integration/hook-conformance-both-hosts.test.mjs` (full
unshallowed history, 2363 commits) — restored, not reinvented.

- Targeted run: `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` →
  **14/14 passed** (10 pre-existing + 4 new), real wall-clock 28s of actual subprocess spawns (not a
  mocked instant pass) — every currently-registered hook on both Claude Code and Codex manifests
  (SessionStart, UserPromptSubmit ×5, PreToolUse ×2, PostToolUse ×2, Stop ×3, plus Claude-only
  PreCompact/SessionEnd/SubagentStop/PostToolUseFailure) genuinely fires clean in a stranger project
  today: no stderr, no stray files, comfortably inside its declared timeout.
- Full suite, baseline vs candidate (`git stash` / `git stash pop`), `npx vitest run tests/integration`:
  baseline 16 failed files / 46 failed tests / 404 passed / 23 skipped / 45 todo (518 total); candidate
  **byte-identical 16 failed files / 46 failed tests**, **408 passed** (+4), same 23 skipped / 45 todo.
  The pre-existing 46 failures are environmental (missing global `ruflo`, an unrelated PreToolUse-length
  assertion drifted by the same decision-gate growth ADR-055 already logged) — confirmed unchanged
  between baseline and candidate, none touching the changed file.
- TEETH, demonstrated non-vacuous: a throwaway harness (same `fire()`-shaped spawn, deliberately run
  outside the real suite, deleted before finishing) confirmed the detection logic actually flags both
  failure classes the 2026-08-13 incident exhibited — a command that writes to stderr and exits
  non-zero, and a command that plants a stray file in the stranger project — both correctly caught.
  `npm run claims:verify`: 3 PASS / 4 SKIP (unchanged from prior nights' documented baseline — all SKIPs
  are the pre-existing "brain not installed on this container" condition). `npm run eval:gate`:
  EVALUATED=blocked, `no brain at /root/.cache/ruvnet-brain/kb` (not a credentials block — this surface
  has no retrieval-quality claim anyway). `node scripts/doc-currency.mjs`: ADR-055/ADR-058's existing
  `presumed-stale`/BLOCK findings are byte-identical before and after this diff (pre-existing, confirmed
  unrelated — the changed file is not in either ADR's `governs:` list).

## Darwin Results

Not run. `npx @metaharness/darwin` (0.9.2, installed) requires a frozen fitness function over a
benchmark corpus; this candidate is a test-coverage restoration with a binary pass/fail property (fires
clean or it doesn't), not a tunable parameter — no fitness landscape to search tonight.

## Evidence

OBSERVATION: current `main`'s `hook-conformance-both-hosts.test.mjs` contains zero `spawnSync`/`spawn(`
calls (grep-confirmed) and ships 10 schema/policy tests, none of which invokes a real hook process.
MEASUREMENT: `git log --follow` (full history) shows the real-firing block existed from `8cf5d61d`
(2026-08-19) through `00526b12`'s parent (2026-09-07), then vanished; ADR-055's 2026-09-11 currency row
independently corroborates the manifests regrew their automatic hooks after that same commit.
MEASUREMENT: restored block passes 14/14 against real current hook code; full-suite baseline/candidate
diff is byte-identical except +4 new passing tests. INFERENCE: the gap was a silent regression, not a
deliberate retirement — the currency reviewer's own words describe the hooks "restored," never the test.
DECISION: restore the real-firing block only (not the ADR-063 managed-memory-boundary block or the
"two hosts don't diverge" block that followed it in the pre-00526b12 file) to keep tonight's diff small
and independently reviewable; those remain a disclosed follow-up, not silently dropped.

## Reward-Hack Check

Independent critic review requested (separate agent invocation, not this candidate's author) — see
Witness/PR for its verdict. Self-check: no benchmark, threshold, or gold data touched anywhere in the
repo; no existing assertion weakened (diff is +163/−0); the new assertions were shown, outside the real
suite, to actually flag broken-hook-shaped behavior rather than passing by construction; no undocumented
cache (each `fire()` call builds a fresh Stable Spine fixture per stranger-project temp dir, matching
every other call in the file).

## Security Review

All new code runs exclusively inside `os.tmpdir()`-rooted temporary directories (`strangerProject()`,
`installCodexSpine()`'s `brainHome`); `RUVNET_BRAIN_HOME`/`RUVNET_CONFIG_ROOT` are pointed at those temp
paths specifically so the real installed ledgers/spine are never touched. The spawned commands are the
repo's own already-shipped hook commands (read from `plugin/hooks/*.json` at HEAD), not
attacker-controlled input. No credentials are introduced, read, or logged. Test-only file; nothing here
is imported by shipped code.

## Scan Findings

- **codex-parity**: `plugin/scripts/continuity-hook-policy.mjs` correctly scopes `PreCompact` and
  `PostToolUseFailure` to `['claude']` only — Codex's installed binary never observed those events in
  the 2026-09-11 probe. Confirmed deliberate and documented, not a parity gap.
- **stranger-project-behaviour**: today's real manifests fire clean in a stranger project on both hosts
  (restored suite, 14/14) — a genuinely reassuring result this repo had no way to state with evidence
  before tonight, despite running `test:integration` green every night since 2026-09-07.

## Gist

LOCAL — `gh` CLI token invalid in this container (`gh auth status`: "token in GH_TOKEN is invalid");
GitHub MCP tools remain available for the PR/ledger below, but no gist-creation tool is available this
session. Not fabricated.

## Witness

See PR body / ledger row for the final stamp (computed after this report's content was frozen).

## Recommendation

Merge after human review — this restores a safety-relevant regression test; it does not change product
behavior. Separately (not part of this candidate): the dream-cycle PR review backlog is now acute —
**47 open `dream/*` branches**, essentially one per night back to 2026-08-19/20, with explicit
reconciliation rows noting "backlog now 39 days / 41 open PRs" as of 2026-10-04 and zero merges since
PR #178 (2026-08-26). That is outside tonight's candidate's authority to fix and is flagged to the owner
separately.
