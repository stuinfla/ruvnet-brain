# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-09-27** — DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth` (slot 2 of 5, `20260927 % 5 == 2`). No bonus deep dive (`% 25` = 2, `% 75` = 52).

`SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab`. `OPENROUTER_API_KEY` absent — `LLM_EVAL=blocked`. Not relevant to tonight's candidate: no stage needs a model call (a deterministic CLI entry-point guard).

## TL;DR

`scripts/no-silent-substitution.mjs` — the repo's own "gate that would have caught me" (its own header
comment), the CI lane enforcing `extraDisciplines: never-hand-roll-what-ruv-already-ships` — used the
OLD, previously-retired CLI entry-point guard idiom (`path.resolve(process.argv[1])` compared against
`fileURLToPath(import.meta.url)`, no realpath resolution). Reproduced live tonight: a symlinked
invocation prints **zero bytes** and exits 0; a direct invocation prints the real audit result. This is
the SAME defect class fixed in commit `43bf391` (13 files, 2026-07-27), then found as a 4th unmatched
instance in `scripts/dream-issue-gate.mjs` (PR #295, 2026-09-17, still unmerged) and a 5th in
`scripts/development-push-check.mjs` (PR #317, 2026-09-22, still unmerged). Tonight is a 6th instance, in
a file neither prior sweep covered — and it is, by its own name and its own incident writeup, the gate
that exists specifically to stop a silent failure mode exactly like this one.

## What's new

Nothing architecturally new — the established `isDirectInvocation()` remediation (`fs.realpathSync` both
sides, wrapped in try/catch, fail-closed) applied to a 6th file. What's new is the finding: a broad sweep
of every `.mjs` file carrying this guard idiom (~45 files still use the unresolved `path.resolve`
comparison; ~14 already use `isDirectInvocation()`/`realpathSync`) turned up this file as the highest-value
remaining target — a named, documented CI gate, not a report or benchmark script.

## Hypothesis (frozen before implementation)

> Given `scripts/no-silent-substitution.mjs`'s CLI entry-point guard, when the script is invoked via
> `process.argv[1]` pointing at a symlink to the real file (a real invocation path: a symlinked working
> directory/worktree, a symlinked home dir, or `os.tmpdir()` on macOS — all previously documented in this
> repo), then the OLD guard (`import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href`)
> fails to match and the substitution audit silently never runs (exit 0, zero output) — replacing it with
> this repo's own established `isDirectInvocation()` pattern (`fs.realpathSync` on both sides, try/catch)
> should make the symlinked invocation run the audit identically to a direct invocation, subject to: the
> guard must fail CLOSED on any resolution error (never accidentally run on an error), and the audit body
> itself must remain read-only (no new write/network surface).

Unchanged since freeze; not modified after evaluation began.

## Candidate

One production file (`scripts/no-silent-substitution.mjs`, guard swap, `pathToFileURL` import removed
since it becomes unused), one test file (`tests/unit/entrypoint-symlink.test.mjs`, added
`'no-silent-substitution.mjs'` to the existing `PIPELINE_ENTRY_POINTS` array — the repo's own
regression-pinning mechanism for this exact defect class). Target: a single conceptual change, small diff.

## Evaluation Receipt

- **TEETH, reproduced twice** — once manually (raw symlink + `node`, before touching the test suite:
  post-fix symlinked invocation prints the real audit result; pre-fix prints nothing, exit 0 both
  times) and once via the regression suite: `git stash push -- scripts/no-silent-substitution.mjs`
  (keeping the new test) → RED, `expected 0 to be greater than 0` (exit 0, zero output through the
  symlink) — reverting only the production fix reproduces the exact predicted defect. `git stash pop`
  → GREEN, 9/9 in `tests/unit/entrypoint-symlink.test.mjs`.
- `tests/unit/no-silent-substitution.test.mjs` (the pure-function `audit()`/`packageIsReallyUsed()`
  suite, untouched by this diff): 8/8 pass, unaffected.
- `tests/integration/hook-conformance-both-hosts.test.mjs`: 10/10 pass, unaffected.
- **Independent critic** (fresh general-purpose agent, no shared context with this session)
  re-verified end to end: reproduced the pre-fix silent exit-0 itself from `git show HEAD~2` before
  any of this session's fix existed; confirmed `isDirectInvocation()` fails closed (any
  `realpathSync` error → `false`, never runs); grepped every caller/importer of
  `no-silent-substitution.mjs` repo-wide (only CLI spawners in `scripts/falsify.mjs`/
  `scripts/qa-lanes.mjs`/`package.json`, and the module-import test, none depending on the old
  guard's silent-skip behavior); confirmed the diff touches only the CLI dispatch block —
  `audit()`/`CAPABILITIES`/`walk()`/`EXEMPT`/`DISCLOSURE` byte-identical; independently ran both
  test files; read both ADRs' existing Currency-log convention and judged the two new rows
  consistent and non-overreaching. **Verdict: CLEAR.**
- `node scripts/wired-check.mjs --check`: PASS, unaffected.
- `node scripts/no-silent-substitution.mjs` (direct `substitution:check` CLI invocation): PASS
  (`✅ none`), unaffected — confirms the audit's own output is unchanged, only its dispatch guard.
- `node scripts/sync-version.mjs --check`: PASS (4.3.28), unaffected.
- `node scripts/product-integrity-contract.mjs --check-source`: PASS (69 checked, 0 invalid/missing),
  unaffected.
- `node scripts/execution-policy.mjs`: `ALLOW`, unaffected.
- `node scripts/verify-model-catalog.mjs`: PASS, unaffected.
- `npm run test:integration` (51 files/407 tests): 9 failed files/23 failed tests/323 passed/16
  skipped/45 todo — grep-confirmed none of the 9 failing files reference
  `no-silent-substitution.mjs` or `entrypoint-symlink.test.mjs`; failure signature
  (`sqlite3`/`@xenova/transformers`/native-module/ruflo-global container gaps) matches PR #317's
  documented baseline from 5 days ago byte-for-byte (same 9 files/23 tests).
- `npx vitest run tests/unit` (5796 tests): first two runs, taken while this branch's own
  `data/convergence-manifest.json` was stale (see CI correction below), showed 17 failed
  files/52 failed tests/5559 passed, `convergence-manifest.test.mjs` among them — **self-caused,
  not pre-existing**: this branch's own diff (the ADR-0057/0058 edits + the new report file) changed
  tracked source without regenerating the committed manifest. CI (`qualify-development` /
  `release-source-identity`) failed on this exact defect and was the actual catch, not this session's
  own local check — reproduced independently on a clean checkout of this branch's tip, confirmed
  `origin/main` itself unaffected, fixed via `npm run convergence:write` (a separate commit on this
  PR), and re-run to completion a third time post-fix: **16 failed files/51 failed tests/5560
  passed/47 skipped/138 todo** — `convergence-manifest.test.mjs` now passes, everything else
  unchanged, exactly matching PR #317's documented 5-day-old baseline byte-for-byte. Full failed-file
  list from the corrected run: `adr-format` (2 failures, both in ADR-0089/0090 — files this diff never
  touches), `advocacy-ignored`, `advocacy-outcomes`, `advocacy-route`, `agentic-qe-early-public`,
  `candidate-retrieval-matrix`, `console-memory-canonical-store` (4), `corpus-accuracy-gate`,
  `corpus-customer-promotion`, `corpus-seed-release-authority`, `doc-currency` (fails on ADR-0013's
  pre-existing lag, not ADR-0057/0058), `hook-shim-fallback-once`, `no-restated-truth`,
  `rehearse-corpus-pipeline`, `retrieval-canary`, `user-settings`. Grep-confirmed: zero of these 16
  reference `no-silent-substitution.mjs` or `entrypoint-symlink.test.mjs`; all are pre-existing
  container/repo-state conditions dated to the 2026-09-19 recovery commit (missing native deps, stale
  unrelated ADRs), independently verified against a clean `origin/main` checkout, not merely asserted.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition to every prior documented night.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (this
  container never materializes a corpus; confirmed independently, `stores 0 dark 0`).
  `OPENROUTER_API_KEY` absent — `LLM_EVAL=blocked` too. Not applicable regardless — deterministic
  CLI-guard mechanism, not a retrieval surface.
- `node scripts/doc-currency.mjs --check`: baseline (pre-candidate) 78 blocking violations, all
  pre-existing and dated to the 2026-09-19 recovery commit, unrelated to tonight's touch. After this
  diff (guard fix + 2 ADR Currency-log rows + the resulting `stamp-lags-doc` fix on both ADRs'
  `updated:` frontmatter, via scoped `--fix`): 77 blocking, neither `ADR-0057` nor `ADR-0058` present
  in the list — confirmed clean of blocking findings for the files this diff touches, with no
  unrelated file regressed. (`--fix` run unscoped touches 67 other pre-existing-stale docs
  repo-wide; those were reverted to keep this diff to its one conceptual change — not tonight's job.)

## Darwin Lineage

Not applicable — no continuous parameter to evolve for a boolean entrypoint-detection mechanism swap
(same precedent as PR #295 and PR #317, the 4th and 5th instances of this exact defect class).

## Reward-Hack Check

Independent critic verdict: CLEAR (see Evaluation Receipt). No benchmark, gold answer, or threshold
touched — `audit()`, `CAPABILITIES`, `packageIsReallyUsed()`, `walk()`, `EXEMPT`, and `DISCLOSURE` are
byte-identical before/after (confirmed by both this session and the independent critic reading the
diff directly). `tests/unit/no-silent-substitution.test.mjs` (the pre-existing suite) is untouched.
The new `PIPELINE_ENTRY_POINTS` entry uses the same "must say something, non-empty output" assertion
as every sibling entry — not a new, weaker bar; the module has zero top-level side effects outside
`main()`, so non-empty output is only reachable if `main()` actually ran.

## Security Review

`isDirectInvocation()`'s `try/catch` fails CLOSED: any resolution error (a non-existent path, a
permission error) returns `false`, meaning the CLI body simply does not run — it can never cause the
guard to run when it previously correctly did not. The fixed guard makes the script MORE likely to
run its (read-only: `fs.readdirSync`/`fs.readFileSync`, `console.log`/`console.error`) body in exactly
the cases the old guard silently skipped — no new write path, network call, or credential surface is
introduced. Same remediation direction as PR #295/#317 and the general Node.js symlink-resolution
guidance those reports cite; the implementation itself is this repo's own, already-six-times-applied
`isDirectInvocation()` pattern.

**Self-caught process note, not hidden**: this session's first evaluation pass mischaracterized the
`convergence-manifest.test.mjs` unit-test failure (and the underlying `data/convergence-manifest.json`
staleness) as pre-existing container state. It was not — it was this branch's own diff going stale
against its own committed manifest. CI (`qualify-development`) caught it, not this session's own local
check, which had been run against an already-dirty working tree. Fixed via a separate, clearly-labeled
commit (`npm run convergence:write`) once CI surfaced it; this report and the ledger row were corrected
afterward to match. Recorded here rather than silently editing the earlier claim away.

## Scan Findings

**gate-teeth** (tonight's Deep Dive finding IS the gate-teeth finding): a guard whose own path comparison
could silently never fire is exactly "a guard that cannot fail is not a guard" (this repo's own
`extraDisciplines` line) — here on the gate that itself enforces the sibling discipline
`never-hand-roll-what-ruv-already-ships`. Fixed, verified tonight (pending evaluation below).

**lesson-delivery**: reconciled, not duplicated. Issue #264 (opted-in BLOCK lesson silently dropped by
cross-trigger nudge-budget truncation in `plugin/scripts/lesson-presentation.mjs`) remains open on
current `main`. Its fix, PR #281, is open/draft, `mergeable_state: clean`, and based on the current
`main` tip (`e89ea1ba`) as of tonight — already reconciled and brought current by a prior night
(2026-09-22 update). Not re-fixed, not re-issued, not touched tonight, per `findingPolicy.skipIf:
["existing-fix-pr"]` and the ISSUE DISPOSITION OVERRIDE.

## Competitors

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Software Agent SDK / CLI) | 2026 guidance for agent-adjacent tooling treats a cloned repo as untrusted input specifically because of symlink-based attacks; documented remediation is "resolve every path to its canonical location before trusting it" — same direction as tonight's fix. | B (Snyk vendor security research, cross-checked against Node.js symlink-resolution semantics this repo's own prior fixes already established) |
| DSPy / GEPA | No public claims on CLI entry-point/symlink handling surfaced tonight. | C |
| SWE-agent | No public claims on CLI entry-point/symlink handling surfaced tonight. | C |
| Cursor background agents | No public documentation on this specific mechanism surfaced tonight. | C |
| Sakana AI Scientist | No public documentation on this specific mechanism surfaced tonight. | C |

No competitor claim justifies the implementation — the implementation is this repo's own,
already-five-times-independently-applied `isDirectInvocation()` pattern, extended to a 6th file.

## Gist

LOCAL — gist writes return `403 Gist writes are not permitted through this proxy` from this session's
outbound proxy (confirmed by direct probe against `api.github.com/gists`, both without and with an
explicit `Content-Type: application/json` header; not assumed, not fabricated — same condition PR
#317 documented 5 days ago). Full report committed at
`docs/dream-cycle/2026-09-27-enforcement-integrity-report.md`.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
REPORT_HASH    = afecc32a58b1adfa4af5eba9d7b94aa2e23d58522d03edddd5dd75e77f4eabc2
WITNESS        = 2424b620b6bd48cc96cc6c4164228da7c6b7082d6f5e3de863e5cdfb6d078398
```

5-step verifier procedure, reproducible by anyone with this repo checked out at `e89ea1ba`:

1. Check out commit `e89ea1ba167d9252ec99910304f534c8da5ca0ab`.
2. Retrieve this report as committed at `docs/dream-cycle/2026-09-27-enforcement-integrity-report.md`
   (byte-identical to this gist except this Witness section, which is filled in after the hash is
   computed, per STEP 16). This report was re-stamped once, after an earlier draft's Evaluation
   Receipt mischaracterized a self-caused CI failure as pre-existing (see the Security Review note);
   the commit that carries this exact pre-stamp text is this PR's re-stamp commit.
3. `sha256sum` the report file *as it existed before this Witness section was filled in* (i.e. with
   the placeholder text) — reproduces `REPORT_HASH` above. The PR's re-stamp commit carries the
   pre-stamp version for this purpose.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` — reproduces `WITNESS` above.
5. Confirm `SESSION_COMMIT` is reachable from `origin/main` (or is `origin/main`'s own tip at the
   time this ran): `git merge-base --is-ancestor e89ea1ba167d9252ec99910304f534c8da5ca0ab origin/main`
   (or equal).

## Recommendation

`evaluated: accepted`. Human review of the draft PR requested — this session never self-merges or
self-promotes. Separately, worth the owner's attention (not a new issue; the standing observation
repeated across ~10+ prior nights since 2026-08-26, most recently PR #321 on 2026-09-23, "backlog now
28 days"): as of tonight, `docs/dream-cycle/LEDGER.md` on `main` is still stamped at its last real row,
2026-08-31 — not because the routine stopped (it has run every night since, PRs #293 through #328
confirmed via GitHub MCP), but because ledger rows are appended inside each candidate PR and land on
`main` only when that PR merges, and dream-cycle PRs have almost entirely stopped merging since
2026-08-20/21. This is the exact backlog PR #294/#295/#317/#321 already flagged, not a new finding —
repeated here because it is the single highest-leverage action still available and directly explains
why LEDGER.md itself looks stale despite nightly execution.
