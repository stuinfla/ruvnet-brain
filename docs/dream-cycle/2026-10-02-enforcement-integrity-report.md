# Dream Cycle 2026-10-02 — Enforcement Integrity SOTA Report

## TL;DR

`scripts/eval-brain.mjs` — the "gate of record" this repo names as *the only evaluator that can
falsify a claim about retrieval quality* — carried the pre-`isDirectInvocation()` CLI entry-point
guard: `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`. Through a symlinked
invocation (npm bin shims, wrapper scripts, any `os.tmpdir()`-rooted path on macOS, a symlinked
worktree) the two sides disagree, `main()` never runs, and the process exits 0 having done
nothing: no table, no `--gate` verdict, no `--record` write, no error. This is the 7th known
instance of a defect class this repo has fixed 3 times before (commit `43bf391`, 13 files;
PR #295 `dream-issue-gate.mjs`; PR #317 `development-push-check.mjs`; PR #333
`no-silent-substitution.mjs`) — but the first instance found *on the evaluator itself* rather than
on a surrounding gate. Fixed with the same realpath-on-both-sides `isDirectInvocation()` helper
already used by `scripts/doc-currency.mjs` and the three prior fixes.

## What's new

Nothing novel in mechanism — this is the established fix, applied to a file the prior 3 sweeps
never covered. What's new is the target: not a peripheral CI gate, but the eval harness whose
fail-closed `--gate` promotion check (`npm run eval:gate`) every retrieval-quality claim in this
repo is supposed to run through. A silent no-op here does not just skip a lint; it would make a
regressed candidate look like it was never checked, rather than like it failed.

## Competitors (grade B/C — framing only, not implementation)

| Project | Claim | Grade | Relevance |
|---|---|---|---|
| OpenHands (2026 guidance) | Treat a cloned repo as untrusted input; resolve every path to its canonical form before trusting it (symlink-based attack surface) | B, cross-checked against Node's own symlink semantics | Same remediation shape as this fix; cited by PR #333 for the same reason |
| Sakana AI Scientist | No public claim on CLI entry-point / symlink guard correctness | C | Not applicable |
| DSPy/GEPA | No public claim on this mechanism | C | Not applicable |
| SWE-agent | No public claim on this mechanism | C | Not applicable |
| Cursor background agents | No public claim on this mechanism | C | Not applicable |

## Hypothesis (frozen before implementation)

> Given `scripts/eval-brain.mjs` invoked through a path where `process.argv[1]` is a symlink to the
> real file (npm bin shims, wrapper scripts, any `os.tmpdir()`-rooted path on macOS, a symlinked
> worktree), when the entry-point guard is changed from `path.resolve(process.argv[1]) ===
> fileURLToPath(import.meta.url)` to a realpath-on-both-sides `isDirectInvocation()` (matching
> `scripts/doc-currency.mjs`'s own helper), then the symlinked invocation should run `main()` and
> produce byte-identical stdout/stderr/exit-code to a direct invocation, subject to: (a) a direct
> (non-symlinked) invocation remains byte-identical to pre-fix behavior, and (b) the guard fails
> CLOSED (does not run `main()`) on any path-resolution error.

Not modified after evaluation began.

## Candidate

One production file (`scripts/eval-brain.mjs`, guard swap, ~14 added lines, 2 removed), one test
file (`tests/unit/entrypoint-symlink.test.mjs`, added `'eval-brain.mjs'` to `PIPELINE_ENTRY_POINTS`
— verified fast and non-mutating with no corpus present, this container's real state: prints
`no brain at ...` and exits in well under a second), one ADR currency-log row (`ADR-0088`, which
`governs: scripts/eval-brain.mjs`).

## Baseline

Unmodified `main` @ `5692a04b85391834430dd5b1d94cb2a4f81a93da`.

## Evaluation Receipt

- **TEETH, reproduced three ways**: (1) manual symlink repro pre-fix — 0 bytes stdout+stderr,
  exit 0; (2) manual symlink repro post-fix — identical bytes and exit code (2, the real
  `die()` path) to a direct invocation; (3) `git stash` isolating only the production fix —
  `tests/unit/entrypoint-symlink.test.mjs` goes from 9/9 green to 1 failed (`expected 0 to be
  greater than 0`) on the exact new assertion, 8/8 unaffected tests still green; restoring the fix
  returns 9/9 green.
- `npx vitest run tests/unit/entrypoint-symlink.test.mjs tests/unit/eval-brain-gate.test.mjs`:
  28/28 pass.
- `npm run version:check` / `substitution:check` / `wired:check`: all PASS, unaffected.
- `npm run convergence:check`: stale after the diff (expected — this diff changes tracked-file
  hashes, same mechanical staling PR #359 documented); fixed via `npm run convergence:write`,
  reverified `{"ok":true}`.
- `npm run test:integration`: 12 failed files / 27 failed tests / 365 passed / 21 skipped / 45
  todo of 458, **byte-identical file-and-test-name failure set to an unmodified `main` baseline
  run via `git stash`** (diffed directly, not assumed) — all pre-existing/environmental
  (sqlite3/MCP-stdio/CE-model-cache/health-repair-fleet fixtures; grep-confirmed none reference
  the changed files).
- `npm run eval:gate`: `EVALUATED=blocked`, `no brain at /root/.cache/ruvnet-brain/kb` (this
  container never materializes a corpus, same condition every night since 2026-08-19). Identical
  behavior pre- and post-fix on a direct invocation — the fix only changes what happens through a
  *symlinked* one. `LLM_EVAL=blocked` too (no `OPENROUTER_API_KEY` in this environment).
- `npm run claims:verify`: 3 PASS / 4 SKIP, standard composition, unaffected.
- `node scripts/doc-currency.mjs --check`: total blocking findings repo-wide **143 → 142**
  (verified via `git stash`, not assumed) — this diff's ADR-0088 currency-log row and `updated:`
  bump *resolved* a pre-existing, unrelated `stamp-lags-doc` BLOCK on that file (last real commit
  2026-09-29 vs. stale `updated: 2026-09-27`) as a side effect of being required to touch it
  anyway; introduced zero new BLOCKs (the `review-unsubstantiated` finding this diff's
  `reviewed_digest` leaves unresolved is `WARN`-level only, same as the repo's existing convention
  for a disclosure-only currency touch).

## Baseline vs Candidate (direct comparison)

| | Direct invocation | Symlinked invocation |
|---|---|---|
| Pre-fix | prints message, exit 2 | **0 bytes, exit 0** |
| Post-fix | prints message, exit 2 | prints message, exit 2 (identical to direct) |

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean entry-point-detection mechanism swap,
same precedent as PRs #295/#317/#333.

## Evidence

OBSERVATION: `scripts/eval-brain.mjs:282` used `path.resolve(process.argv[1]) ===
fileURLToPath(import.meta.url)`, the exact idiom `tests/unit/entrypoint-symlink.test.mjs`'s header
names as the pre-fix defect (`path.resolve` does not follow symlinks; `import.meta.url` does).
MEASUREMENT: symlinked invocation pre-fix produced 0 bytes / exit 0 (reproduced manually and via
`git stash`-isolated TEETH). MEASUREMENT: symlinked invocation post-fix produced output and exit
code byte-identical to a direct invocation. MEASUREMENT: `test:integration` failure set is
byte-identical baseline vs. candidate (27/27 same test names). INFERENCE (not independently
re-verified against a real installed/symlinked bundle on this container, which never materializes
one): this is live on any host where `scripts/eval-brain.mjs` is reached through a symlinked path —
named in the test file's own header as npm bin shims, wrapper scripts, and every `os.tmpdir()` path
on macOS. DECISION: ACCEPT — verified, integrated-pending fix; human review of the draft PR still
required.

## Reward-Hack Check

No benchmark, gold-answer, held-out question, or gate threshold touched — `evals/held-out.json`,
`evals/baseline.json`, and every exported scoring function (`heldOutHash`, `wilson`, `gateAgainst`,
etc.) are byte-identical; only the unconditional-vs-guarded *invocation* of `main()` changed. The
new test asserts the same non-vacuous "must say something" shape every sibling
`PIPELINE_ENTRY_POINTS` entry uses. The fix can only make the gate run in strictly more cases than
before (it never suppresses a run that used to happen) — it cannot be a one-directional score
inflator, and cannot by itself make `--gate` pass something it would otherwise fail, since the
`--gate` scoring logic inside `main()` is completely unchanged.

## Security Review

`isDirectInvocation()` fails CLOSED on any resolution error (try/catch around both
`fs.realpathSync` calls, returns `false`) — it can only ever make `main()` run in a case where it
previously silently did not; it never newly skips a run that previously happened. No new write
path, network call, or credential surface — the diff touches only a boolean guard. `path` import
remains used elsewhere in the file (`ROOT`, `KB`, `HELD_OUT`, `BASELINE`, and 4 more call sites) —
confirmed, nothing orphaned.

## Regression Analysis

Blast radius: the entry-point guard is evaluated exactly once, at module load, and gates exactly
one call (`await main()`). No other file imports or depends on this guard's prior behavior — grep
confirmed zero other references to this line. `test:integration` and `test:unit`-scoped
(`entrypoint-symlink.test.mjs`, `eval-brain-gate.test.mjs`) failure sets are byte-identical baseline
vs. candidate.

## ADR

`docs/adr/0088-operational-evaluation-integrity.md` governs `scripts/eval-brain.mjs` (`governs:`
frontmatter, confirmed directly). Added a Currency-log row disclosing the touch and bumped
`updated:` to today, following this repo's established convention for every edit to a governed
file. No architectural decision changed — the evaluation model, five strata, and Wilson-bound
gating threshold are all byte-identical; this is a mechanical CLI-guard fix to already-decided
architecture (same precedent PR #333 used for ADR-0057/0058), not a new ADR.

## Scan Findings

**gate-teeth**: tonight's Deep Dive finding *is* the gate-teeth finding — a guard on the repo's own
gate-of-record that could silently never fire is exactly "a guard that cannot fail is not a guard,"
and this is the first instance of the defect class found on the evaluator itself rather than on a
surrounding CI gate.

**lesson-delivery**: checked for duplication, found none new. `scripts/lesson-gate.mjs` /
`plugin/scripts/lesson-gate.mjs` already use the canonical two-file compatibility-launcher pattern
(confirmed by diff: the `scripts/` copy is a one-line re-export, not a drifted duplicate). Issue
#264 (opted-in BLOCK lesson silently dropped by cross-trigger nudge-budget truncation) was already
reconciled in PR #333's own Scan Findings — not re-opened, not re-fixed tonight.

## Backlog note (not a new finding — carried forward, now independently re-checked)

Confirmed via GitHub MCP tonight (2026-10-02): **43 `dream/*` branches / PRs exist** (through
`dream/2026-10-01-brain-currency-reconciliation`), the most recent of which (#358, #359, both
2026-10-01) independently corrected and re-verified the standing numbers: 5 of 77 `dream/*` PRs
ever merged, 0 merged in the last 14 days, 36 open+draft at that time, a genuine conflict (PR #292)
and a genuine duplicate pair (#280/#328) both already flagged and still unresolved. This is the
single highest-leverage item for the owner's attention, repeated across many consecutive nights —
not restated in full here to avoid duplicating #358/#359's own corrected numbers; see those PRs'
"Process finding" / "Recommendation" sections for the authoritative count.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session; not fabricated.

## Witness

```
SESSION_COMMIT = 5692a04b85391834430dd5b1d94cb2a4f81a93da
REPORT_HASH    = 024741bab71d1089a030c8c022bbaa7b3f5f2cd418ec0807599df3c2a6c9c0fb
WITNESS        = 50432032ca4937e41735397e90a07232def2861930f22869156dd737a299cada
```

Verify: (1) checkout `5692a04b85391834430dd5b1d94cb2a4f81a93da`; (2) obtain this report from the
PR at `docs/dream-cycle/2026-10-02-enforcement-integrity-report.md`; (3) blank the three Witness
lines above back to their placeholder form and `sha256sum` the file, confirm it matches
`REPORT_HASH`; (4) `printf '%s%s' <REPORT_HASH> 5692a04b85391834430dd5b1d94cb2a4f81a93da | sha256sum`,
confirm it matches `WITNESS`; (5) `git stash` this PR's diff to `scripts/eval-brain.mjs` only,
confirm `tests/unit/entrypoint-symlink.test.mjs`'s `eval-brain.mjs` case fails, `git stash pop`,
confirm it passes again.

## Recommendation

1. Human review of this draft PR (tiny, one conceptual change, ~16 net production lines).
2. Same standing recommendation as PRs #358/#359: triage the `dream/*` backlog — duplicate #280 vs
   #328, resolve PR #292's real merge conflict, bulk-triage the remaining open drafts. Review
   throughput, not research output, remains the bottleneck.
3. If this fix is accepted, consider a repo-wide one-time audit of the ~26 remaining files still
   carrying the pre-`isDirectInvocation()` idiom (found via `grep -rl
   "pathToFileURL(process.argv\[1\])"`), prioritized by which are actually wired into an enforcement
   gate vs. a manual diagnostic script — tonight picked the single highest-value instance
   (the eval gate of record) rather than attempting the full sweep in one candidate.

## Merge Policy

Human review required. This session never self-merges, never enables auto-merge, never
autonomously promotes candidate state. `autoMerge: false` is the decision, not a default.
