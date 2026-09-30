# Cross-Host-Conformance / Codex-Parity SOTA Report — 2026

**Dream Cycle 2026-09-30 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## TL;DR

`plugin/scripts/turn-outcome-capture.mjs` keys a Codex turn's identity on
`payload.session_id` FIRST (`sessionKey = payload.session_id || payload.transcript_path || ''`),
falling back to `transcript_path` only when `session_id` is absent — this is the field that lets a
Codex Stop event (added 2026-09-29 so every turn's outcome is recorded on both hosts, per the owner's
own requirement) be attributed to a real, deduplicatable session at all. The evidence cited for that
whole registration is "codex-cli 0.158.0's own `stop.command.input` schema, read from the installed
binary 2026-09-29." That exact citation was hand-copied into three places the same day it was written
— `turn-outcome-capture.mjs`'s own header, `continuity-hook-policy.mjs`'s Stop registration comment,
and `tests/unit/turn-outcome-capture.test.mjs`'s fixture comment — and the three copies **disagreed
with each other**: the test's comment named the full 9-field schema (including `session_id`), but
BOTH production-code comments named a narrower 2-field subset, and **neither production comment
mentioned `session_id`** — the one field the code actually depends on for identity. A reader trusting
either production comment would not know the Codex Stop capture path depends on `session_id` at all.

This is the exact "a hand-copied citation drifts from its own source the same day it is written" class
this repository already built machinery to catch for `CONTEXT_EVENTS`/`ALL_HOST_EVENTS`
(`codex-hook-events.mjs`, Dream Cycle 2026-08-30) — just recurring in prose evidence-citations rather
than in a test fixture's data array. Given this repo's "measured, not assumed" discipline is the
explicit stated reason `hook-contracts.json`'s `_codexCapture` record and `codex-hooks.json`'s own
description exist, a citation of the measurement that quietly drops the load-bearing field undermines
the exact property those files exist to protect.

## What's new

Nothing external — a same-day (2026-09-29) internal evidence-citation drift inside this repo's own
Codex Stop turn-capture feature, found by cross-referencing the three places that cite the same
"codex-cli 0.158.0 `stop.command.input` schema, read from the installed binary" measurement and
diffing which fields each one names.

## Competitors — how other autonomous coding/nightly-evolution harnesses treat a single external
measurement hand-copied into multiple internal citations that then drift (grade C: general knowledge,
single-source per row; informs framing only, does not justify the implementation — the implementation
is justified by this repo's own measurement above)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | Single research-loop artifact per run; no standing multi-file "cite the same host measurement" convention to drift. | C |
| OpenHands | Tool/action schemas are typically defined once and consumed directly; no publicized pattern for a schema fact being hand-copied into prose comments across files. | C |
| DSPy/GEPA | Optimizes a program against a metric function; documentation-citation drift between prose comments is outside what the framework tracks. | C |
| SWE-agent | Raw tool-call observations, not a durable cross-file evidentiary citation of a third-party host's wire schema. | C |
| Cursor background agents | Single-host execution model; no second host's wire-schema citation to keep in sync with a first. | C |

None of the five have this repo's specific shape of problem (one external, unrepeatable measurement —
reading strings out of an installed third-party binary — cited by hand in several files). This repo's
own `codex-hook-events.mjs` precedent (2026-08-30: extract pure data once, import everywhere, never
hand-copy) is the more disciplined approach already; tonight applies that same discipline to a schema
**citation** (prose evidence, not a data array), which the 08-30 precedent did not itself cover.

## Ledger check / reconciliation

`docs/dream-cycle/LEDGER.md` on `main` is still dated 2026-08-31 (10 rows total) — not because nights
have not run, but because ledger rows ship inside candidate PRs and **zero `dream-cycle`-labelled PRs
have merged since #178 (2026-08-26), now 35 calendar days.** Checked via GitHub MCP tonight: **≈35 open
PRs** carry the `dream-cycle` label (oldest still open: #269, 2026-09-08; most recent: #345,
2026-09-29), essentially one new draft per slot per weeknight with no merges keeping pace — the same
backlog every cross-host-conformance night since 2026-08-26 has flagged, now roughly 5x the size it was
when first named. Separately, **release PRs on this repo (not `dream-cycle`-labelled) merge routinely**
— `main` is at v4.3.37 tonight, having shipped v4.3.28 through v4.3.37 since 2026-09-08 — so the
backlog is specific to Dream Cycle review capacity, not a frozen repo.

Reconciled against the 5 currently-open `dream-cycle` issues (#298, #274, #264, #260, #258): none target
this surface. Reconciled against every currently-open `cross-host-conformance` PR (#291, #304, #305,
#325): read #325 in full (2026-09-25, still open, still accurate — confirmed `scripts/ci/stranger-scenario.mjs`
on current `main` still never mentions Codex, matching its finding) and the titles/scope of #291/#304/#305;
none touch `turn-outcome-capture.mjs`, `continuity-hook-policy.mjs`, or the Codex Stop schema citation —
this is this session's independent, non-overlapping finding. No duplicate.

## Hypothesis (frozen before implementation, unchanged since)

> Given the three in-repo comments that each cite "codex-cli 0.158.0's `stop.command.input` schema,
> read from the installed binary 2026-09-29" as the evidence for `continuity-hook-policy.mjs`'s Codex
> Stop `session-snapshot` registration, when a new deterministic test reads each citation's surrounding
> text and checks it names `session_id` — the field `turn-outcome-capture.mjs`'s `captureTurnOutcome`
> actually reads FIRST to key a Codex turn's identity — then the test should FAIL on current source
> (two of the three citations omit it) and PASS once the two incomplete production-code citations are
> reconciled against the fuller citation already recorded in the test file, subject to: zero behavior
> change to `captureTurnOutcome`, `continuity-hook-policy.mjs`'s registration table, or any Codex
> dispatch path (documentation/citation and one new additive test only); no existing test anywhere in
> the repo regresses.

## Candidate

- `plugin/scripts/codex-hook-events.mjs`: new export `CODEX_STOP_SCHEMA_FIELDS` (frozen array, the
  9-field canonical citation) with a header explaining why it now lives here — the same
  "extract once, both consumers import it" precedent this file already set for `CONTEXT_EVENTS`/
  `ALL_HOST_EVENTS` (2026-08-30). Pure data, no I/O, no behavior change to anything that already
  imports this file.
- `plugin/scripts/turn-outcome-capture.mjs`: header comment rewritten to point at
  `CODEX_STOP_SCHEMA_FIELDS` and to explicitly name `session_id` as the field the function reads
  first for identity. Comment-only; the function body is untouched.
- `plugin/scripts/continuity-hook-policy.mjs`: the Stop-registration comment for `session-snapshot`
  rewritten to name `session_id` and point at the same constant. Comment-only; `registration(...)`
  calls (the actual event-wiring data) are byte-unchanged.
- `tests/unit/codex-stop-schema-citation.test.mjs` (new): the TEETH test — asserts the canonical
  constant itself names `session_id`, then asserts each of the three citing files' `stop.command.input`
  mention is followed within a 500-character window by `session_id`.

One conceptual change (an evidence citation drifted from its own source; reconcile and guard it),
4 files touched, **+42 insertions / −4 deletions** in production files, +45 lines in the new test file.
No behavior-affecting line changed in any file the runtime actually executes on a live hook dispatch.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate` not run: `EVALUATED=blocked` (`no brain at
/root/.cache/ruvnet-brain/kb`, this container never materializes a corpus, identical to every prior
Dream Cycle night since 2026-08-19) AND not applicable regardless (this surface is a documentation/
cross-host-evidence-integrity fix, not a retrieval change). `LLM_EVAL=blocked` — no model-provider API
key in this environment (`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` both absent); candidate was selected
specifically to be testable without model calls (deterministic string/citation consistency).

**Guard proven to fail first (TEETH).** Isolated the two production-comment fixes with
`git stash push -- plugin/scripts/continuity-hook-policy.mjs plugin/scripts/turn-outcome-capture.mjs`
(keeping the new `CODEX_STOP_SCHEMA_FIELDS` export and the new test in place, so the import itself
still resolves) and ran the new test file:

```
FAIL  tests/unit/codex-stop-schema-citation.test.mjs > ... > plugin/scripts/continuity-hook-policy.mjs's schema citation names session_id
AssertionError: expected 'stop.command.input schema (last_assis…' to contain 'session_id'
FAIL  tests/unit/codex-stop-schema-citation.test.mjs > ... > plugin/scripts/turn-outcome-capture.mjs's schema citation names session_id
AssertionError: ...
Test Files  1 failed (1)
     Tests  2 failed | 2 passed (4)
```

Exactly the two production citations failed (the canonical-constant check and the test file's own
citation check passed) — reproducing the finding live, not merely asserted. Restored with
`git stash pop`: **4/4 pass.**

**Full targeted regression sweep** (every file that imports `codex-hook-events.mjs`, plus the both-hosts
integration gate, plus the two other hook-policy/hook-contract test files):

- `tests/unit/turn-outcome-capture.test.mjs`, `tests/unit/codex-stop-schema-citation.test.mjs`: **13/13
  pass** (includes the Codex-shaped-payload test that already exercised `session_id` end-to-end).
- `tests/unit/codex-claude-hook-parity.test.mjs`, `tests/unit/codex-lifecycle-hooks.test.mjs`,
  `tests/unit/flywheel-cadence.test.mjs`, `tests/unit/entrypoint-guard-safety.test.mjs`: **61 passed, 15
  skipped (76)**, all 4 files green.
- `tests/unit/hook-contracts-doctor.test.mjs`, `tests/unit/hook-registry-lint.test.mjs`,
  `tests/unit/codex-blocking-hooks-parity.test.mjs`, `tests/unit/decision-gate.test.mjs`: **54 passed, 6
  skipped (60)**, all 4 files green.
- `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` (the both-hosts hook
  conformance gate this DEEP/SCAN pairing exists for): **10/10 pass.**
- `node scripts/sync-version.mjs --check`: `4.3.37` agrees everywhere, unchanged.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical class to every prior night (SKIPs are all
  environmental: brain not installed, coverage run not produced, learning-replay artifact predates this
  branch).
- `node scripts/doc-currency.mjs --check --changed origin/main`: 0 blocking findings. Confirmed
  independently (grepped every ADR's `governs:` frontmatter for the three changed `.mjs` files): none of
  `docs/adr/0040`, `0051`, `0055`, `0067`, `0084` (the ADRs that mention these files in prose) actually
  `governs:` any of `turn-outcome-capture.mjs`, `continuity-hook-policy.mjs`, or `codex-hook-events.mjs`
  — no ADR Currency-log row required.
- `npm run test:integration` (full 54-file suite), baseline (`git stash` of the 3 changed production
  files) vs candidate, run independently end-to-end (not diffed via stash-and-rerun-same-process, to
  avoid any state leakage): **byte-identical — 10 failed files / 25 failed tests / 335 passed / 17
  skipped / 45 todo of 422, on both.** All 25 failures are in files this candidate never touches
  (`health-repair.test.mjs`, `project-progression-{checkpoint,concurrent-sessions,reader-identity,
  restore-semantics}.test.mjs`, `managed-cli-server-boundary.test.mjs`, `reader-deadlock-regression.test.mjs`,
  `anticipate.test.mjs`, `anticipate-dial.test.mjs`, `console-apply-timings.test.mjs`) — none reference
  `turn-outcome-capture.mjs`, `continuity-hook-policy.mjs`, or `codex-hook-events.mjs` (grep-confirmed).

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete documentation-consistency guard.

## Evidence

OBSERVATION (three same-day citations of one measurement, three different field lists, two omitting
the load-bearing field) → MEASUREMENT (new TEETH test red on current source via isolated `git stash`,
green after the fix; full targeted regression sweep + both-hosts integration gate green; full
`test:integration` byte-identical baseline vs candidate) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

CLEAR. No benchmark, gold-answer, or threshold touched — confirmed by diff inspection (comment text in
2 files, one new frozen data export, one new additive test file). The new test's assertions are strict
(`toContain`, `toBeGreaterThanOrEqual`), not loosened, and were shown RED on unmodified production
comments before the fix via an isolated `git stash`, not merely claimed. No hidden cost (pure string
reads of already-committed source files). No threshold, no cache, no evaluator code touched.

## Security Review

No new attack surface: `CODEX_STOP_SCHEMA_FIELDS` is a `Object.freeze`d array literal with no I/O; the
new test only reads already-committed source files from disk (`fs.readFileSync`) and does string
matching, no execution of untrusted content, no network call. No credential, dependency, or trust
boundary touched. The two comment edits do not change what `continuity-hook-policy.mjs`'s
`registration(...)` calls wire, what `codex-hook-adapter.mjs` dispatches, or what
`turn-outcome-capture.mjs`'s `captureTurnOutcome` reads or writes — verified by diff (only comment text
changed in both files; every executable line is byte-identical to before).

## ADR

None. `docs/adr/0051-codex-host-wiring.md` governs `bin/install.mjs` only (verified via its `governs:`
frontmatter) and none of tonight's three changed files are governed by any existing ADR (checked all
five ADRs that mention them in prose — none list them under `governs:`). This is a documentation/
evidence-citation consistency fix to an existing feature's internal comments, not a new architectural
decision, default, or cross-cutting policy change — `node scripts/doc-currency.mjs` independently
confirms 0 blocking findings for this diff.

## Gist

`GIST: LOCAL` — attempted a real `POST https://api.github.com/gists` with `GITHUB_TOKEN` (no `gh` CLI
in this environment). The outbound proxy refused it explicitly: `HTTP 403
{"message":"Gist writes are not permitted through this proxy."}`. Not fabricated — this is the actual
denial response. This report is committed in full at
`docs/dream-cycle/2026-09-30-cross-host-conformance-report.md`; no evidence lost.

## Governance note (not this candidate's problem, flagged for the human owner — recurring)

As of tonight, **≈35 PRs carry the `dream-cycle` label and are open**, spanning every DEEP surface back
to 2026-09-08 (and further, if older ones are still open), and **zero have merged since #178 on
2026-08-26 — 35 calendar days.** This has been named in cross-host-conformance PR bodies on 2026-08-26,
2026-08-30, 2026-09-20, and 2026-09-25 with no visible change in review throughput; PR #325
(2026-09-25) separately documented a concrete cost of the backlog: issue #262 was closed `completed`
by the owner while its real fix (PR #263) sat unreviewed and was lost when its branch was deleted.
Per STEP 1.1's own learning signal ("zero of the last 14 candidate PRs merged → bias to a tiny,
easily-reviewable candidate"), tonight's candidate was kept deliberately small (comment fixes + one
additive test, +42/−4 in production files) in response. The backlog itself is not a code defect this
candidate can fix — it is a review-capacity signal that has now compounded for over a month and
deserves the owner's direct attention independent of tonight's finding.

## Next steps

1. A human reviewer should decide whether to extend the `entrypoint-guard-safety.test.mjs` "derive,
   never hand-list" sweep's spirit to prose evidence-citations generally (not just data-array
   fixtures) — tonight's guard is narrowly scoped to this one schema citation, not a general-purpose
   citation linter, to keep the diff to one conceptual change.
2. When a real `codex` CLI binary becomes available to a future Dream Cycle session, live-observe an
   actual Codex Stop event and confirm `session_id` is genuinely present on the wire (this candidate
   verifies the repo's own citations agree with EACH OTHER; it cannot verify them against the real
   binary in this sandboxed, `codex`-less container — flagged explicitly, not silently assumed).
3. Governance: the 35-day, ≈35-PR `dream-cycle` review backlog (see above) — not actionable by this
   candidate, flagged again for the owner.

## Witness

```
SESSION_COMMIT = 6e0f9623b44183ee899aa64a0123cdb9f37e5451
REPORT_HASH    = a915708ec5e2b363705470cbaa28743cd5ed8f93d125ce4e79bbdf6776e3762c
WITNESS        = 59f4955ce7693ee9ff5a4c03c4e3458fb6663ff982df1d4e97ba4eedef35dd3f
```

`REPORT_HASH` is the sha256 of this report's content through the end of the "Next steps" section,
computed BEFORE this Witness section was written (STEP 16's own chicken-and-egg order: stamp, then
rewrite the Witness section with the stamp). It will therefore NOT match a fresh `sha256sum` of this
file as it now reads — appending this section changed the bytes. That is expected by construction,
not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 6e0f9623b44183ee899aa64a0123cdb9f37e5451` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. `git stash push -- plugin/scripts/continuity-hook-policy.mjs plugin/scripts/turn-outcome-capture.mjs`,
   then `npx vitest run tests/unit/codex-stop-schema-citation.test.mjs` — 2 of 4 cases must fail with
   `expected ... to contain 'session_id'`.
5. `git stash pop`, re-run the same file (4/4 green), then
   `npx vitest run tests/unit/codex-claude-hook-parity.test.mjs tests/unit/codex-lifecycle-hooks.test.mjs tests/unit/flywheel-cadence.test.mjs tests/unit/entrypoint-guard-safety.test.mjs tests/unit/hook-contracts-doctor.test.mjs tests/unit/hook-registry-lint.test.mjs tests/unit/codex-blocking-hooks-parity.test.mjs tests/unit/decision-gate.test.mjs tests/integration/hook-conformance-both-hosts.test.mjs`
   and confirm the same pass counts reported above.

---

## Addendum: post-push CI failure, found and fixed (added after PR #347 was opened; does not affect
the Witness stamp above — this section is appended after it, outside the hashed region)

The first push (`8c7f261`) failed CI's `qualify-development` check: `release-source-identity`
(`node scripts/convergence-manifest.mjs`) reported `manifest is stale; run npm run convergence:write`
— this branch added/changed 4 tracked files without regenerating `data/convergence-manifest.json`.
`canonical-qa` failed as a downstream mirror of that same result. Fixed with the repo's own tooling
(`npm run convergence:write`, never hand-edited) and verified locally with
`node scripts/release-qualification.mjs --suite source`: all 4 watchdogs PASS (`release-version`,
`release-source-identity`, `automatic-hook-retirement`, `release-source-linux`). Pushed as a third
commit (`ae4433d`); confirmed via GitHub Actions that `qualify-development`, `canonical-qa`,
`integration`, and `Vercel Preview Comments` all report `success` on that commit.

Separately: this addendum's own existence is the reason `REPORT_HASH`/`WITNESS` above were
**recomputed once**, after the Gist section was updated with the real (403-denied) outcome — the
first hash was taken before that edit landed and would not have verified against the file's final
pre-Witness content. The values now in the Witness block above are the corrected, final ones; this
addendum records that correction rather than silently overwriting history.

Noted for the record: the local pre-push hook (`scripts/development-push-check.mjs`) only scans
unpublished commits for credential-shaped values by design — its own header states "release
qualification belongs to the single hosted producer, never a second checkout's Git hook" — so it does
not run `convergence-manifest.mjs` and could not have caught this locally before push. That is the
intended architecture, not a hook gap.
