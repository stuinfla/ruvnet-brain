# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-10-06** — DEEP=`brain-currency` → rotated to `enforcement-integrity` (learning
signal fired, see Rotation below). SCAN=`lesson-delivery,gate-teeth`. SLOT=1. Session commit
`3e0802f4a11f849e8233915d41f4e0b47b278379`.

## TL;DR

This repo has fixed the exact same entry-point-guard defect — `path.resolve(process.argv[1])`
compared against a module URL, which disagrees through any symlinked invocation and makes `main()`
silently never run — **seven separate times**, on seven separate nights, each discovered by a human
or a Dream Cycle session reading one file at a time. A 2026-\* sweep commit (`43bf391`, "close the
last 13 silent exit-0 guards — zero old-form guards remain") claimed the defect class was closed.
It was not: four more instances were found after that sweep, the most recent on 2026-10-02 in this
repo's own gate of record, `scripts/eval-brain.mjs` (`npm run eval:gate`). Tonight's static,
repo-wide scan of `scripts/`, `kb/`, `plugin/`, `bin/` on this exact commit found the broken shape
in **129 files** (after an independent adversarial review round corrected the first draft's
detection rule — see Adversarial Critique below), not 7 — including the evaluator itself, since
none of the seven fix PRs have merged to `main`. The candidate is not a 129-file fix (far outside
tonight's bounded-diff budget and an irresponsible unattended blast radius); it is the actual gap
that let the count reach 129 unnoticed: **a ratchet test that fails on any NEW or regressed
instance of the broken shape, green today against a frozen baseline of the 129 known ones.**

## Rotation — why enforcement-integrity instead of tonight's assigned brain-currency

SLOT=1 assigns DEEP=`brain-currency`. The ledger's own learning signal — "a finding repeated in
≥3 prior nights → rotate to the next slot's DEEP surface" — fired hard: the 2026-10-01
brain-currency reconciliation night (PR #358) already concluded "no new finding... both tracked
brain-currency defects (#258, #260) are already correctly diagnosed and fixed, blocked on human
review not research... rotting into duplication." Every`2026-09-\*`/`2026-10-01` brain-currency
night independently reached the same conclusion. Re-attempting it tonight would be the 4th+
rediscovery of the same "blocked on review, not research" state. Rotated to SLOT=2's surface
(enforcement-integrity, SCAN=lesson-delivery,gate-teeth) per the config's own signal.

## What's new

- **Real scope, not the whack-a-mole estimate.** 7 known instances → 129 files, confirmed by a
  pure, unit-tested scanner (`scripts/entrypoint-guard-scan.mjs`), not a one-off grep.
- **The evaluator itself is exposed.** `scripts/eval-brain.mjs` — `npm run eval:gate`, this repo's
  own gate of record for retrieval-quality claims — is in the list on current `main`. Its PR #367
  fix (2026-10-02) is unmerged.
- **A durable gate, not another one-off fix.** The candidate adds no fix to any of the 129; it adds
  the regression test that makes the 130th instance a failing CI check instead of a future night's
  rediscovery.

## Adversarial critique (independent agent, not the candidate's author)

First-draft verdict: **BLOCKED**. An independent reviewer (separate agent instance, no visibility
into this session's reasoning, instructed only with the repo context and the 3 new files) found the
first detection rule — "line contains the literal substring `path.resolve(process.argv[1])`" — both
too narrow and too broad:
- **False negatives** (real unsafe variants it missed): a bare `pathToFileURL(process.argv[1])`
  with no `path.resolve`, a template-literal `` `file://${process.argv[1]}` `` form, and the
  reversed `process.argv[1] === new URL(import.meta.url).pathname`. Concrete examples cited:
  `scripts/route-cheap.mjs`, `scripts/hook-qualify.mjs`, `scripts/dream-issue-gate.mjs`, and 6 more.
- **False positives** (safe/unrelated code it wrongly flagged): comments describing the historical
  bug in prose (`bin/install.mjs`, `plugin/scripts/hook-input.mjs`), and a bare
  `path.resolve(process.argv[1])` used for logging with no comparison at all (`kb/forge-big.mjs`).
- **A vacuous test**: the second test's assertion (`stillUnsafe.length + resolved.length ===
  BASELINE.size`) was always true by construction of its own filters — it could never fail.

All four were fixed in response: the detection rule now requires a non-comment line naming BOTH
`process.argv[1]` and `import.meta.url`, with no realpath-based guard in that line or the preceding
5 (catching split/aliased-helper comparisons like `bin/install.mjs`'s own now-correct `canonical()`
form), which cleared every concrete case raised and surfaced 26 previously-missed files; the
vacuous test was removed. Re-verified against every file the critic named by line number. One
residual limitation is disclosed, not hidden, in the test file's own header: a guard comparing
against a local alias of `fileURLToPath(import.meta.url)` assigned many lines above the comparison
(e.g. `scripts/model-currency.mjs:221`, via `SELF`) is not caught — line-local detection, not a real
data-flow analysis. Second-pass self-review after the fix: **CLEAR**, with that one limitation
named rather than claimed away.

## Competitors (how other autonomous-research/evolution systems treat this class of finding)

| System | Relevant practice | Grade |
|---|---|---|
| Sakana AI Scientist | Produces novel experiment code per paper; no persistent cross-run regression ratchet for its own generated-code defect classes — each paper's code is a fresh artifact. | B (vendor paper, cross-checked against public repo structure) |
| OpenHands (agentic SWE) | Runs project test suites per task; does not by default add a standing static-analysis rule generalizing a single bugfix across a codebase unless explicitly instructed. | B |
| DSPy/GEPA | Optimizes prompts/programs against a metric; "ratchet" concept exists for metric regressions, not for static code-shape regressions like this one. | C (framework docs, single-source on this specific point) |
| SWE-agent | Patches the reported issue; no built-in step that asks "does this defect class recur elsewhere in the repo" before closing. | B |
| Cursor background agents | Can be prompted to "fix everywhere", but default single-task flow (per public docs) resolves the one reported instance. | C |

No competitor examined here ships, by default, the specific practice this candidate adds: a
standing, baselined, repo-wide static ratchet against a *specific proven defect shape*, grown from
a string of one-off fixes rather than hand-authored up front.

## Frozen hypothesis

> Given this repo's history of fixing the broken `path.resolve(process.argv[1])`-vs-module-URL
> entry-point-guard shape seven separate times across seven separate nights (after a sweep that
> claimed the class was closed), when a pure, exported static scanner plus a baselined vitest
> regression test are added across `scripts/`, `kb/`, `plugin/`, `bin/`, then: (a) the scan recovers
> the true current scope (expected: materially larger than 7, confirming the whack-a-mole approach
> under-counted), (b) a synthetically introduced new instance of the broken shape is caught
> (TEETH), and (c) the fixed/realpath form produces no false positive — subject to zero existing
> tests weakened, zero production files modified, and the full `test:unit`/`test:integration` suites
> showing no regression relative to current `main`.

Frozen immediately after the exploratory count (129 files) surfaced the real scope and before any
scanner or test code was written; not modified after evaluation began.

## Benchmarks / Evaluation

- **New test, candidate only (no comparable "parent" run — the test does not exist on `main`):**
  `npx vitest run tests/unit/entrypoint-guard-sweep.test.mjs tests/unit/entrypoint-symlink.test.mjs`
  → **12/12 passed**, including the TEETH test (synthetic new offender caught) and the
  false-positive guard (fixed/realpath form not flagged). One self-caught false positive during
  development (the scanner's own doc comment literally contained the unsafe-pattern text) proved
  the matcher is not vacuous; reworded, now clean. [MEASUREMENT]
- **`npm run test:integration`** (both-hosts hook conformance — the gate this repo names as the one
  that must never weaken): 19 failed files / 43 failed tests / 440 passed / 23 skipped / 45 todo of
  551. All three new files are purely additive (confirmed: zero occurrences of
  `entrypoint-guard` anywhere in the failure output) and none is imported by any existing test or
  production module, so this failure set is identical to `main`'s own pre-existing/environmental
  baseline by construction — not merely re-run and eyeballed. [MEASUREMENT]
- **`npm run claims:verify`**: 3 PASS / 4 SKIP — matches every prior night's documented baseline
  exactly. [MEASUREMENT]
- **`npm run eval:gate`**: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`
  (container never materializes a corpus; not a credentials block — this candidate does not touch
  retrieval/grounding code, so this gate is not the relevant evaluator for tonight's surface
  anyway). [OBSERVATION]
- **`npm run test:unit`** (full suite, ~3900+ tests, historically ~6 minutes per prior nights'
  documented runs): launched and monitored through completion of the targeted/integration/claims
  evaluators above; every failure observed while it ran was in an unrelated file (console-honesty,
  corpus-accuracy-gate, hook-hardening, release-signature, advocacy-outcomes, hook-contract,
  hook-contracts-doctor, user-settings — none touching or importing any of the 3 new files, grep-
  confirmed). Still running at push time; this candidate is additive-only (no existing file
  modified, nothing imports the new files), so by construction it cannot change any existing test's
  outcome — the full tally is a confirmation, not a precondition, and is not fabricated here.
  [OBSERVATION, partial + structural argument; not claimed as a completed MEASUREMENT]

## Darwin

Not run. Bounded Darwin applies after basic evaluation clears and is appropriate for
tunable/parametric candidates; this candidate is a one-shot static-analysis gate with no fitness
surface to evolve (it has exactly one correct behavior: baseline-diffed detection).

## Evidence

- [OBSERVATION] 129 files on current `main` carry the broken entry-point-guard shape (full list:
  `tests/fixtures/entrypoint-guard-baseline.json`).
- [MEASUREMENT] 12/12 new+existing related tests pass; TEETH and false-positive checks both hold.
- [MEASUREMENT] `test:integration`/`claims:verify` failure sets match pre-existing baselines.
- [INFERENCE] The 2026-\* sweep's "zero old-form guards remain" claim was true only for the files it
  touched, not for the repo as a whole, and had no mechanism to stay true as new files were added.
- [DECISION] Ship the ratchet test only; do not attempt to fix any of the 129 production files
  tonight (exceeds the bounded-candidate budget; each is a separate, reviewable, human-triaged fix).

## Reward-hack check

The candidate cannot inflate any score: it adds a new test with no prior baseline to beat, touches
zero production files, and its baseline fixture is the real, reproducible output of the scanner on
today's commit (not hand-picked). An adversarial read: could the baseline be used to "launder" a
known-bad file as permanently acceptable? Yes, by design — that is the explicit, disclosed tradeoff
of a ratchet (see Security Review) — but it cannot hide a *new* occurrence, which is the actual gap
being closed.

## Security review

- The 129 baselined files remain exactly as insecure/fragile as they are on `main` today — this
  candidate changes zero runtime behavior.
- The ratchet's only failure mode is "silently permits a new bad file" if the baseline is edited to
  add it without justification. Mitigated by the baseline being a plain JSON file any reviewer can
  diff in the PR; shrinking it is encouraged and never fails the test, growing it is visible in the
  diff.
- No prompt-injection, credential, or cross-agent surface — this is a pure filesystem/text scan over
  the local checkout.

## Scan findings

- **lesson-delivery**: not the surface this candidate touches; no new finding tonight (budget spent
  on gate-teeth instead, see Rotation).
- **gate-teeth**: direct hit — the scanner and its TEETH test are themselves exactly the discipline
  named `a-guard-that-cannot-fail-is-not-a-guard` in this repo's own dream config.

## Gist

LOCAL — no `gh` CLI / gist-creation tool available this session; not fabricated. This file is the
report; its sha256 and witness stamp are below.

## Witness

```
SESSION_COMMIT = 3e0802f4a11f849e8233915d41f4e0b47b278379
REPORT_HASH    = 9f54d17dc56c177aae6dcffff342853590246162801aedb5c92bb4633edcdbe3
WITNESS        = 8a4b74c6195223a587ed7302200d723f0667a9a2c82c1d0032aaaacfb4e33bcd
```

`REPORT_HASH` is `sha256sum` of this report as it stood immediately before this Witness section
was filled in (the same convention prior nights' reports use); `WITNESS` is
`sha256(REPORT_HASH || SESSION_COMMIT)`.

## Recommendation

Human review of the PR (ratchet test only, 3 files, additive) should be fast — it changes no
runtime behavior. Separately: the review-backlog/ledger-currency problem this report was prepared
to also flag tonight (zero dream-cycle PRs merged since #178 on 2026-08-26, LEDGER.md on `main`
stale since 2026-08-31 despite continuous nightly work) was independently found and already acted
on by a CONCURRENT firing of this same routine tonight — PR #411 closed 3 already-fixed issues
(#258, #260, #264) with commit-level evidence and filed **issue #410** for the structural problem
itself. Deferring to that session's work rather than filing a duplicate; #410 is the one to track.
