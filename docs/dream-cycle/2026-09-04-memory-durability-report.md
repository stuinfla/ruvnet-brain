# Memory-Durability SOTA Report — 2026

**Dream Cycle 2026-09-04 — DEEP=memory-durability, SCAN=managed-boundary,round-trip-proof (slot 4)**

## TL;DR

`scripts/health-repair.mjs --distill-fleet` snapshots every store it is about to distill by calling
`ruflo memory backup --db <db> --dir <dir>`, then trusts a zero exit code alone as proof a fresh
snapshot exists before recording it in the undo receipt and proceeding to mutate the store. It never
checks that a NEW file actually landed in `<dir>`. This is the exact defect
`scripts/distill-project.mjs` was fixed for in PR #192 (2026-08-29 Dream Cycle night) — a stale
snapshot left over from a PRIOR fleet run, or a `ruflo memory backup` call that reports success
without writing anything (process killed post-commit, a misconfigured `--dir`, a `ruflo` regression),
is otherwise indistinguishable from a genuine fresh backup. `distillFleet()` never received that
fix; it is a second, independent caller of the same subcommand that was never updated. The
2026-08-29 report's own "Next steps #1" named this exact gap and deferred it. Tonight closes it.

Fix: extracted `newestSnapshot()` (the sinceMs-floored freshness check) out of
`distill-project.mjs` into a new shared, pure module `scripts/snapshot-freshness.mjs`, so the two
independent callers share one tested implementation instead of a second hand-rolled copy — the
`never-hand-roll-what-ruv-already-ships` discipline applied to this repo's own internal helper, not
just rUv's tools. `health-repair.mjs`'s fleet loop now refuses to record a store's backup or proceed
to distill it unless a snapshot with mtime at/after this run's backup call actually appears in the
directory.

## What's new

Nothing external — an internal control-flow gap in this repo's own second caller of a discipline it
had already proven necessary once. Found by reading the 2026-08-29 memory-durability report's own
recorded "Next steps" before starting fresh research (STEP 2, load accumulated evidence), and
confirming via `git log --oneline -- scripts/health-repair.mjs` that no commit since 2026-08-29 had
touched the flagged code path.

## Candidate selection

Given the ledger's own learning signal — of the ~20 most recent Dream Cycle PRs (#157 through #239),
**zero have merged since #178 (2026-08-26)**, all still open/draft — tonight deliberately biased to
the smallest, most reviewable candidate available rather than opening fresh research (STEP 1.1's own
"zero of the last 14 candidate PRs merged → bias to a tiny, one-parameter, easily-reviewable
candidate"). The 2026-08-29 report already named, scored, and deferred exactly this gap as its
highest-value fast-follow (fit 4, novelty 3, testability 3, measurability 3, prod value 4,
reviewability 2 — the only candidate that night rated 4 for production value and was not chosen only
because it exceeded that night's single-conceptual-change budget). Verified before committing to it:
not fixed by any commit since; not superseded by any open PR (grepped all 20 open PR titles/branches
— none touch `health-repair.mjs` or `distill-project.mjs`); no rotation trigger applies (this deep
surface has not repeated 3+ nights unresolved — 08-19 MERGED, 08-24 and 08-29 open but distinct
findings). This is a documented, deliberate override of STEP 3's default 5-fresh-candidates fan-out,
recorded rather than silently skipped.

## Competitors — memory/state write-verification stance (informs framing only, not chosen for this)

| System | Stance on verifying a "success" claim from a subprocess/backend before trusting it | Grade |
|---|---|---|
| OpenHands (Agent SDK) | Names durable state management as a foundation requirement; no documented backup-freshness check specific to this failure mode. | A (general framing only) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts — a stale-file-mistaken-for-fresh failure is structurally avoided by versioning rather than mtime inference. | A (official repo) |
| SWE-agent | No public backup/snapshot-freshness claims surfaced. | C |
| Cursor background agents | No public documentation on write-verification mechanics surfaced. | C |
| Sakana AI Scientist | No public documentation of an explicit freshness check on its own checkpoint artifacts. | C |

This repo's own precedent (`distill-project.mjs`'s `newestSnapshot()`, PR #192) is the actual
justification — tonight applies it to a second call site that had not yet received it.

## Hypothesis (frozen before implementation)

> Given `health-repair.mjs --distill-fleet`'s per-store backup step, when `ruflo memory backup`
> reports success (exit 0) while either (a) a stale snapshot from a PRIOR fleet run already sits in
> that store's backups directory, or (b) this call lands no new file at all, then the current code
> unconditionally records the directory in the undo receipt and proceeds to distill; changing it to
> require a snapshot file with mtime at/after this call's start (minus a small mtime-truncation grace
> window, shared with `distill-project.mjs`'s existing constant) should make it REFUSE that store
> instead — subject to: a genuinely fresh backup is still accepted and distillation proceeds
> normally; a store with no prior backups directory is treated identically to one with only stale
> files; and `distill-project.mjs`'s own two call sites (the backup-verification site and the
> unfiltered `--restore` site) are behaviorally unchanged after the extraction.

Unchanged since freeze.

## Testability gate → Candidate → Baseline → Evaluation

Testable tonight without model calls (deterministic filesystem-timing guard) — proceeded past the
testability gate. `OPENROUTER_API_KEY` absent → `LLM_EVAL=blocked`, consistent with the container's
own note above; irrelevant here since no stage needs a model call.

**Candidate** (4 files, ~115 net lines): new `scripts/snapshot-freshness.mjs` (pure, extracted);
`scripts/distill-project.mjs` (import instead of local copy, behavior-preserving refactor);
`scripts/health-repair.mjs` (+9 lines, the actual fix); `tests/integration/health-repair.test.mjs`
(fixture correction + 2 new tests, detailed below); `tests/unit/snapshot-freshness.test.mjs` (new,
9 cases).

## Evaluation Receipt

Not a retrieval-quality candidate: `npm run eval:gate` independently blocked in this container —
`stores 0 dark 0`, store root never materialized (confirmed via `restore-local-ingests.mjs` and
`kb/store-root.mjs`, same pre-existing condition as every Dream Cycle night since 2026-08-19), not a
credentials block.

**TEETH, proven to fail first — twice, at two levels.**

*Pure logic level* (`tests/unit/snapshot-freshness.test.mjs`, 9 cases): stashed the entire candidate,
ran the new test file against unmodified `main` — fails immediately with `Cannot find module
'../../scripts/snapshot-freshness.mjs'` (the module does not exist on `main`). Restored the
candidate: **9/9 pass**, covering the empty-directory case, no-floor "newest ever" mode (the
`--restore` path's own semantics), the stale-snapshot-rejected case (the actual bug), a
genuinely-fresh-snapshot-accepted case, mtime-truncation grace tolerance, and multiple-candidates
newest-wins.

*End-to-end level* (`tests/integration/health-repair.test.mjs`, new `--distill-fleet snapshot
freshness` describe block, 2 cases, run against a real `sqlite3`-backed fixture and a fake `ruflo`
subprocess): reverted ONLY the fix in `health-repair.mjs` (kept the new tests) — both fail red,
`distilled 1 store — ~/source/hm/a: +1 patterns` where the test expects a refusal (`expected +0 to
be 1`), i.e. current `main` genuinely distills a store whose backup silently landed nothing.
Restored the fix: **all 8 tests in the file pass** (6 pre-existing + 2 new).

**A real second bug caught mid-session, disclosed rather than hidden.** The pre-existing fixture's
fake `ruflo`'s `memory backup` branch always exited 0 WITHOUT ever writing a file to `--dir` — i.e.
the existing "discovery" tests (`uses the shared no-argument fleet policy…`, `keeps --root genuinely
scoped…`) were themselves exercising exactly the unsafe shape this candidate now refuses. Applying
the fix as originally written would have broken those two passing tests the moment `sqlite3` became
available to run them (it is absent in this container by default — see Environment note). Fixed the
fixture itself (`fakeRuflo()` gained an opt-in `writeBackupFile` parameter, default `true`, that
writes a genuinely fresh, uniquely-named file under `--dir` — modeling real `ruflo memory backup`
behavior) rather than loosening the new check to accommodate a fixture that was silently wrong. Ran
the two pre-existing discovery tests before and after this fixture change: pass both times, so the
new coverage this diff adds is: does the real fix's precondition actually get exercised at all.

**Regression analysis.**
- `npx vitest run tests/integration/health-repair.test.mjs`: baseline (unmodified `main`, `sqlite3`
  now installed in this container) — 6/8 pass, 2 fail (the pre-existing discovery tests fail on
  baseline too once `sqlite3` is available, because the OLD fixture never wrote a backup file and
  `distillFleet()`'s ORIGINAL code path still called `diagnose()` on a store `ruflo`'s fake distill
  branch never touched — see Environment note for why this had never surfaced before). Candidate:
  8/8 pass. This is a genuine fix uncovering a fixture bug, not a regression the candidate introduces.
- `npx vitest run tests/integration` (full 42 files): baseline (with `sqlite3` present) — 4 failed
  files / 4 failed tests / 295 passed / 12 skipped / 53 todo of 364. Candidate — same 4 failed files
  / same 4 failed tests (`anticipate-dial.test.mjs`, `anticipate.test.mjs`,
  `console-apply-timings.test.mjs`, `reader-deadlock-regression.test.mjs` — chmod/EACCES-under-root,
  headless-Chromium, and a pre-existing CE-cache case, none touching this candidate's files) / 297
  passed (the 2 new tests) / 12 skipped / 53 todo of 366. Byte-identical failure SET, confirmed by
  name.
- `npx vitest run tests/unit` (full 314 files): candidate — 6 failed files / 7 failed tests / 3737
  passed / 20 skipped / 161 todo of 3925 (before fixing `convergence-manifest.test.mjs`'s staleness,
  see below); after regenerating the manifest, re-ran the 5 remaining failing files
  (`advocacy-ignored.test.mjs`, `advocacy-outcomes.test.mjs`, `hook-shim-fallback-once.test.mjs`,
  `session-snapshot-health.test.mjs`, `user-settings.test.mjs`) against baseline directly — 5 failed
  files / 6 failed tests, byte-identical to candidate. All 6 are the same documented chmod/EACCES
  root-user class this repo's ledger has recorded on every night since 2026-08-26.
- `node scripts/convergence-manifest.mjs`: this candidate adds/modifies tracked source files, so
  `data/convergence-manifest.json` was regenerated via `npm run convergence:write` and committed in
  the same change — the same discipline the 2026-08-31 ledger row already established for this gate.
- Blast radius: `grep -rn "newestSnapshot\|MTIME_GRACE_MS"` repo-wide — exactly the two intended
  callers (`distill-project.mjs`, `health-repair.mjs`) plus the new module and its own test. The
  fleet receipt's `backupDir` field (consumed by `onboarding-console.mjs`'s `restore-store-backups`
  undo handler, which re-scans that directory itself rather than trusting a specific filename) is
  UNCHANGED by this diff — deliberately: broadening the receipt shape was out of scope for a
  single-conceptual-change candidate.
- `node scripts/sync-version.mjs --check`: `4.3.8-dev` agrees everywhere.
- `node scripts/doc-currency.mjs --check`: violation count byte-identical baseline vs candidate (567
  lines both sides, all pre-existing, none against the changed files); confirmed no ADR's `governs:`
  frontmatter lists `scripts/distill-project.mjs`, `scripts/health-repair.mjs`, or
  `scripts/snapshot-freshness.mjs` — no Currency-log row required.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical class to every prior night (brain-not-installed
  skips; unrelated to this surface).

**Environment note.** This container ships without `sqlite3` on the CLI PATH by default — every
Dream Cycle ledger row since 2026-08-19 has documented this as a pre-existing condition, and
`tests/integration/health-repair.test.mjs`'s tests were entirely unexecuted here as a result until
tonight. `apt-get install -y sqlite3` succeeded this session (package present in the container's
configured apt mirror; no other tooling was modified), which is how the end-to-end regression tests
above were actually run and verified rather than only statically reasoned about — the strongest
evidence basis of any Dream Cycle night on this surface so far. This is a per-container, per-session
installation, not a repo or CI change; it does not persist and nothing in this candidate depends on
it being present (the pure-module unit tests need no database at all, and the integration tests
already carry `sqlite3` usage identical to `tests/integration/health-repair.test.mjs`'s pre-existing
tests, which is the repo's own established pattern for this class of test).

## Independent Critic (fresh general-purpose agent, not this candidate's author)

**Verdict: ACCEPT / CLEAR.** Read the full diff cold, cross-checked the live repo, and independently
re-ran the TEETH proof itself (reverted only the fix, watched the 2 new integration tests fail red,
restored it, watched 8/8 pass; also ran `distill-project.test.mjs`, `remedy-registry.test.mjs`, and
`ruflo-bin-resolution.test.mjs` — 28/28 pass, confirming the refactor didn't regress the original
caller or the receipt-consumer contract). Confirmed: no weakened assertion; no evaluator exploitation
or hidden threshold; `fakeRuflo()`'s two modes are a faithful model of real `ruflo memory backup`
behavior (verified against the regex `newestSnapshot()` actually filters on); blast radius clean
repo-wide; the `backupDir` receipt field and its `onboarding-console.mjs` consumer are untouched; no
new attack surface (the directory path is derived from an already-trusted `t.db`, unchanged from
before). One non-blocking observation: the working tree also carried an unstaged
`data/convergence-manifest.json` change outside the reviewed diff bundle — flagged as worth
explaining rather than a defect; addressed above (Regression analysis) and in the PR body.

## Security Review

No new attack surface. The diff only changes an in-process time comparison over files the two
callers already had `readdirSync`/`statSync`/`execFileSync` access to; `dir` in `health-repair.mjs`
is derived from `t.db`, itself sourced from `findStores()`'s enumeration of paths this executor
already trusted before tonight. No new external input, no path traversal (no user-controlled string
reaches a new filesystem operation), no new dependency, no new network call or credential, no change
to what gets executed or with what privileges. `MTIME_GRACE_MS` (1500ms) is unchanged from its
original value — no threshold silently loosened. The concurrency gap `distill-project.mjs`'s own
adversarial critique already flagged and deferred (2026-08-29: "two concurrent invocations against
the SAME `BACKUP_DIR` within the grace window could in principle still misattribute a snapshot") is
unchanged by tonight's extraction — carried forward as a pre-existing, documented, non-blocking
limitation, not introduced here.

## Reward-Hack Check

Did not weaken any benchmark or gold answer (none touched — this surface has no benchmark corpus).
Did not cherry-pick: the fix is applied uniformly to every store the fleet loop processes, not
conditionally. Did not exploit the evaluator: the new tests were written to fail on `main` BEFORE the
fix was confirmed working, not adjusted after the fact to match an already-passing run. Did not hide
cost: no new dependency, no new network/API surface, `--budget-usd 0` behavior untouched. Did not
rely on an undocumented cache or test-only shortcut: `fakeRuflo()`'s `writeBackupFile:true` mode
models genuine subprocess/filesystem behavior a real `ruflo memory backup` would produce, not a
mocked return value the product itself never sees.

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete freshness-check fix; `MTIME_GRACE_MS` is
a shared constant already tuned by the 2026-08-29 night's own precedent, not reopened tonight.

## Scan findings (secondary, not evaluated further tonight)

- **managed-boundary**: the review backlog itself is now the dominant managed-boundary risk on this
  repo — 20 open Dream Cycle draft PRs (#157 through #239), **zero merged since #178 (2026-08-26)**,
  a gap the ledger has flagged on every night since 2026-08-26 and which has only grown. Not this
  candidate's to fix (out of scope for an evaluation session), but repeated here because it is the
  single most actionable fact in tonight's run for the repo owner.
- **round-trip-proof**: `record-lesson.mjs`'s nonce gap (2026-08-29 report, candidate #2, deferred
  pending PR #167) remains deferred — PR #167 is still open/unmerged as of tonight, so re-examining
  it stays blocked on the same precondition as last time.

## Evidence

- OBSERVATION: `health-repair.mjs`'s `distillFleet()` recorded `backupDir` and proceeded to distill
  unconditionally after `ruflo memory backup` exited 0, with no freshness check, confirmed by reading
  `scripts/health-repair.mjs` lines ~273-281 (pre-candidate).
- MEASUREMENT: `tests/unit/snapshot-freshness.test.mjs` 9/9 pass on candidate, 0/9 collectable on
  baseline (module absent).
- MEASUREMENT: `tests/integration/health-repair.test.mjs` 8/8 pass on candidate; 6/8 pass on baseline
  (2 new tests fail red, reproducing the exact defect).
- MEASUREMENT: `tests/integration` full suite byte-identical failure set baseline vs candidate (4
  files / 4 tests both sides, named above).
- MEASUREMENT: `tests/unit` full suite byte-identical failure set for the 5 unrelated files, baseline
  vs candidate (6 tests both sides).
- INFERENCE: the fixture bug this candidate also fixed (`fakeRuflo`'s silent no-file backup) was
  most likely never caught before because this container has lacked `sqlite3` since 2026-07's CI
  hardening, so these specific tests have essentially never executed in a Dream Cycle session until
  tonight — this is an inference from absence of contrary evidence, not a measurement.
- DECISION: ACCEPT — recommend human review and merge.

## Witness

```
SESSION_COMMIT = cbca83bc7a72a8ee4552d50530e391694200b670
REPORT_HASH    = ecfbe4a443e6018e6d9cbef176107cf2764cf6358bada4e47838cda9b84d18a5
WITNESS        = a6f8aa22137694b9b4632f592d4b2d903d2e6d939616a7be6e83dfba46dfa4cc
```

(`REPORT_HASH` is the sha256 of this file as it stood immediately before this Witness section was
filled in — i.e. ending at the placeholder line "See the Witness section below (stamped last, after
this file's content was final)." Reproducing it requires reconstructing that exact prior state,
preserved in this file's git history as the first commit that adds it, alongside the copy committed
to `docs/dream-cycle/2026-09-04-memory-durability-report.md`.)

5-step verifier: (1) `git log --follow -p -- docs/dream-cycle/2026-09-04-memory-durability-report.md`
and take the version of this file at its first commit (the placeholder-Witness version); (2)
`sha256sum` that version — compare to `REPORT_HASH`; (3) `git show cbca83b:.` is `main`'s HEAD at
session start — confirm via `git log`; (4) concatenate `REPORT_HASH` + `SESSION_COMMIT` and
`sha256sum` again — compare to `WITNESS`; (5) independently reproduce the TEETH proof: `git stash
push -u -- scripts/health-repair.mjs && npx vitest run tests/integration/health-repair.test.mjs`
(the 2 new "snapshot freshness" cases fail red), `git stash pop && npx vitest run
tests/integration/health-repair.test.mjs` (8/8 pass).

## Next steps

1. `record-lesson.mjs`'s nonce gap (2026-08-29 report, candidate #2) remains deferred behind PR #167
   — re-examine once that PR merges.
2. `newestSnapshot()`'s known, pre-existing, non-blocking gap — no cross-process lock, so two
   concurrent invocations against the same backups directory within the grace window could in
   principle still misattribute a snapshot — is unchanged by tonight's extraction; still a candidate
   fast-follow, not urgent (strictly narrower risk than before this fix existed at all).
3. The review backlog (20 open Dream Cycle draft PRs, zero merged since 2026-08-26) is the most
   consequential finding available to this routine right now and is outside any single night's
   candidate scope — flagged here and in the accompanying issue for the repo owner's attention.
