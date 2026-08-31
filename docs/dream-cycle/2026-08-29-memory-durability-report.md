# Memory-Durability SOTA Report — 2026

## TL;DR

`scripts/distill-project.mjs` is this repo's one "genuinely offerable, genuinely reversible"
capability (see its own header — ADR-047's origin sin). Its safety rests entirely on one claim: a
WAL-safe snapshot exists and is locatable before any mutation runs. That claim is currently proven
by `newestSnapshot()` — "the file with the newest mtime in the backups directory" — with no check
that the file it returns was created *by the backup call that just ran*, rather than left over from
a previous one. If `ruflo memory backup` reports exit 0 without writing a new file into `BACKUP_DIR`
(process killed after commit but before the file lands, a target-dir misconfiguration, a `ruflo`
regression), and a prior run's snapshot is still sitting in that directory, the wrapper cannot tell
the difference from a genuine fresh backup — it silently proceeds to distill using a false, stale
undo point. The existing test suite already covers "backup succeeds, directory is completely empty"
(refuses correctly) but never covers "backup succeeds, directory already has an OLD file in it"
(the actual production shape of the risk, since the whole point of this script is that it runs
repeatedly against the same project). Fix: `newestSnapshot()` now takes a `sinceMs` floor —
tightened to "the run currently in progress" at the one call site that verifies a fresh backup, left
at its default (no floor) at the `--restore` call site, which legitimately wants the newest snapshot
ever, not the newest since some run.

## What's new

Nothing external — this is an internal control-flow gap in this repo's own wrapper, found by reading
the file end to end against the discipline its own header describes (`status BEFORE` → `snapshot,
no snapshot no run` → `receipt fail-closed` → `distill` → `status AFTER + delta`). The gap is that
step 2's "no snapshot, no run" check verifies *a* snapshot exists, not *this run's* snapshot.

## The hypothesis (frozen before implementation)

> Given `scripts/distill-project.mjs`'s pre-distill snapshot step, when `ruflo memory backup`
> reports success (exit 0) while a snapshot file from a PRIOR run already exists in `BACKUP_DIR`,
> then `newestSnapshot()`'s directory-scan-by-mtime currently accepts that stale file as proof of
> a fresh backup (it is unconditionally "the newest file present"), letting the script proceed to
> distill on a false undo guarantee; changing `newestSnapshot()` to require the candidate file's
> mtime be no older than the moment the backup call started (minus a small grace window for
> filesystem mtime-truncation) should make the script REFUSE in that scenario instead — subject to:
> a genuinely fresh backup (mtime at/after the call started) is still accepted; a completely empty
> backups directory is still refused with the same existing message; and the `--restore` code
> path's own use of `newestSnapshot()` (picking the most recent snapshot ever, not tied to a
> specific run) is unchanged.

Unchanged since freeze.

## Competitors — memory/state write-verification stance (as documented; none used to justify the fix)

| System | Stance on verifying a "success" claim from a subprocess/backend before trusting it | Grade |
|---|---|---|
| OpenHands (Agent SDK) | 2026 SDK docs name durable state management as a foundation requirement; do not document a specific backup-freshness check. | A (arXiv 2511.03690, general framing only) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts (closer to append-only); a stale-artifact-mistaken-for-fresh failure mode is structurally different there — versioning makes "which one is new" explicit rather than mtime-inferred. | A (official repo) |
| SWE-agent | No public backup/snapshot-freshness claims surfaced. | C (not deeply searched tonight) |
| Cursor background agents | No public documentation on write-verification mechanics surfaced tonight. | C (general framing only) |
| Sakana AI Scientist | No public documentation describing an explicit freshness check on its own checkpoint/state artifacts. | C (not deeply searched tonight) |

This repo's own precedent (`degradation-watch.mjs`'s `proveMemoryDurable()`, ADR-063/#140,
PR #143/#167) is the actual justification: a claimed success must be independently verified against
the specific operation, not inferred from ambient state. Tonight applies that same discipline to a
file it had not yet reached.

## Five candidates considered

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `distill-project.mjs` stale-snapshot misattribution (chosen) | 5 | 4 | 5 | 5 | 4 | 5 | Untouched file, narrow fix, existing test file to extend, TEETH-provable |
| 2 | `record-lesson.mjs` round-trip key nonce gap | 5 | 2 | 4 | 4 | 3 | 4 | Real gap (flagged in PR #167's own Reward-Hack Check), but PR #167 is still open/unmerged on `main` — main still has the ORIGINAL wording-based bug, not the nonce gap. Fixing tonight would either duplicate #167 or build on an unmerged branch. Deferred — not this repo's candidate to re-litigate while #167 awaits review. |
| 3 | `health-repair.mjs`'s fleet `writeReceipt()` silently swallows its own write failure and distills anyway | 4 | 3 | 3 | 3 | 4 | 2 | Real (confirmed at `health-repair.mjs:261-277`, already named in `distill-project.mjs`'s own header as the anti-pattern it was built to avoid). Larger blast radius (`--distill-fleet`, multi-store loop) and would need careful sequencing to match `distill-project.mjs`'s fail-closed shape without changing fleet-repair's existing partial-progress semantics. Out of scope for a <300-line, one-conceptual-change candidate tonight — recorded as a fast-follow. |
| 4 | `learning-replay-fixture.mjs`'s `retrieveExact()` | 2 | 1 | 3 | 3 | 2 | 3 | Read in full; already correct — retrieves by exact key and compares the returned value, same discipline this report is applying elsewhere. No defect found. |
| 5 | `lesson-store.mjs` atomic write path | 1 | 1 | 2 | 2 | 2 | 2 | Read in full; already has an exclusive lock, atomic rename, and rotating backups, with detailed commit history showing this exact class of bug (lost writes) was already found and fixed twice. No defect found. |

## Evaluation

Not a retrieval-quality candidate — `npm run eval:gate` is independently blocked in this container
(`no brain at /root/.cache/ruvnet-brain/kb`, store root never materialized, `stores 0 dark 0`, same
condition as every prior Dream Cycle night since 2026-08-19). `LLM_EVAL` is NOT blocked tonight
(`OPENROUTER_API_KEY` present) but no model-graded stage applies to a deterministic
filesystem-timing guard.

**TEETH, proven to fail first.** Reverted only `scripts/distill-project.mjs` (kept the new test),
ran `npx vitest run tests/unit/distill-project.test.mjs`: the new stale-snapshot case fails —
`AssertionError: expected +0 to be 1` (the wrapper accepted an hour-old file as proof of a backup
that never actually landed one). Restored the fix: 9/9 pass, including the pre-existing `--restore`
snapshot test, proving `--restore`'s own (unfiltered) use of `newestSnapshot()` is unaffected.

**Regression analysis.**
- `npm run test:integration`: baseline (`git stash`) vs candidate — byte-identical, 5 failed files /
  9 failed tests / 240 passed / 11 skipped / 53 todo of 313 both sides. All 9 pre-existing/
  environmental (`sqlite3` binary missing, `@xenova/transformers` missing, headless-Chromium path
  missing) — identical class to every prior Dream Cycle night.
- `npx vitest run tests/unit` (full suite, 277 files, ran to completion): 4 failed files / 3404
  passed / 24 skipped / 161 todo of 3593. All 4 failures are pre-existing, `chmod`-based
  unwritable/unreadable fixtures that don't enforce under this container's root user — the identical
  class PR #178's own night already diagnosed. None touch `distill-project.mjs` or its test.
- Blast radius: `grep -rn newestSnapshot` — exactly two call sites, both inside
  `scripts/distill-project.mjs` (the backup-verification site, now filtered; `--restore`, unfiltered,
  unchanged). No other file imports this script (CLI entrypoint only).
- `node scripts/sync-version.mjs --check`: `4.2.2-dev` agrees everywhere.
- `node scripts/doc-currency.mjs --check`: pre-existing violations only, none against
  `scripts/distill-project.mjs` — no ADR's `governs:` frontmatter lists this file.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical class to every prior night (skips all
  environmental — brain not installed).

**Independent critic (fresh general-purpose agent, not this candidate's author).** Verdict: **CLEAR**.
Reproduced the TEETH proof itself (reverted the fix, watched the new test fail red, restored it,
watched all 9 pass). Confirmed the diff to the test file is purely additive — no existing assertion,
threshold, or gold value touched. Confirmed the blast-radius claim directly via its own grep. One
non-blocking, pre-existing gap flagged, not introduced by this diff: `newestSnapshot()`'s
directory-scan-by-mtime still has no cross-process lock, so two concurrent `distill-project.mjs`
invocations against the *same* `BACKUP_DIR` within the 1.5s grace window could in principle still
misattribute a snapshot — old code had zero time-based discrimination at all, so this is strictly
narrower than before, not a new risk this diff creates. Recorded as a fast-follow, not fixed tonight
(single-conceptual-change scope).

## Security Review

No new attack surface: the diff only changes an in-process time comparison over files the script
already had `readdirSync`/`statSync` access to. No new external input, no path traversal, no new
trust boundary, no new dependency, no new network call or credential. The concurrency gap the critic
flagged is pre-existing (no lockfile existed before this diff either) and is narrowed, not widened.

## Witness

```
SESSION_COMMIT = 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f
REPORT_HASH    = 1d37440f762e4648d53fd2d5f6301fb0098cd8a129f8cd3971438898c77dd8fd
WITNESS        = 812b2f966cc3b9317d69112d84fe87e3f0e86acd2a96cf2f7fb3b57bbc89e3d4
```

(`REPORT_HASH` is the sha256 of this file as it stood immediately before this Witness section was
filled in — i.e. ending at the placeholder line "See PR body — stamped after this file's final byte,
per STEP 16." Reproducing it requires reconstructing that exact prior state, which is preserved in
this file's git history as the first commit that adds it.)

5-step verifier: (1) `git log --follow -p -- docs/dream-cycle/2026-08-29-memory-durability-report.md`
and take the version of this file at its first commit (the placeholder-Witness version); (2)
`sha256sum` that version — compare to `REPORT_HASH`; (3) `git show 486a144:.` is `main`'s HEAD at
session start — confirm via `git log`; (4) concatenate `REPORT_HASH` + `SESSION_COMMIT` and
`sha256sum` again — compare to `WITNESS`; (5) independently reproduce the TEETH proof: `git stash
push -u -- scripts/distill-project.mjs && npx vitest run tests/unit/distill-project.test.mjs` (new
stale-snapshot case fails), `git stash pop && npx vitest run tests/unit/distill-project.test.mjs`
(9/9 pass).

## Next steps

1. Apply the same "verify freshness against THIS operation, not directory state" discipline to
   `health-repair.mjs`'s fleet receipt path (candidate #3 above) — deferred tonight, real gap.
2. Once PR #167 (record-lesson.mjs) merges, re-examine whether its deterministic round-trip key
   (candidate #2) still needs the nonce fast-follow its own Reward-Hack Check flagged.
3. Consider whether `newestSnapshot()`'s mtime-grace constant should be configurable for
   network-filesystem deployments with coarser mtime resolution than the 1.5s assumed here.
