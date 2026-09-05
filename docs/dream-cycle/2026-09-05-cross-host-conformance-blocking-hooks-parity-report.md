# Cross-Host Hook-Refusal Contract SOTA Report — 2026

**Dream Cycle 2026-09-05 — DEEP: cross-host-conformance / SCAN: codex-parity, stranger-project-behaviour**

## TL;DR

`plugin/scripts/codex-hook-wrapper.mjs`'s `blockingHooks` Set — the one thing that decides whether a
hook's real exit-2 refusal reaches the Codex host, or gets silently coerced to exit 0 (allow) — had
drifted from `plugin/scripts/hook-shim.mjs`'s own dispatch `TABLE`, the actual authority on which
hooks are `mode: 'blocking'`. `route-dispatch` was still listed in `blockingHooks` as if an exit-2
from it meant something; `hook-shim.mjs`'s own TABLE has called it `mode: 'advisory'` since issue
#84, and its own comment already disowns the old claim in the past tense ("This comment used to cite
'route-dispatch's exit-2 wall' as the example. That was FALSE and had to go"). The membership was
inert today — hook-shim.mjs's own dispatch coerces route-dispatch's exit code to 0 unconditionally,
regardless of what the wrapper believes — but nothing tested that these two independently-maintained
lists actually agree, which is exactly the shape of two prior ACCEPTED findings on this file family.
Removed the stale entry; added a test that holds the invariant in both directions going forward.

## What's new

This is the fourth finding on this exact code family (hook-shim.mjs / codex-hook-wrapper.mjs /
codex-hook-adapter.mjs) inside three weeks:

1. **2026-08-20 (#149/#150):** `hook-registry.mjs`'s mesh census never enumerated `codex-hooks.json` —
   zero automated coverage of the Codex host for four invariants.
2. **2026-08-20 (#147/#148):** `hook-conformance-both-hosts.test.mjs`'s Codex-side TEETH assertions
   were vacuous — every hook silently short-circuited before reaching real logic, so "no stderr / no
   artifacts / within timeout" passed by construction.
3. **2026-08-30 (report only, landed via `e3eff362`):** `codex-hook-adapter.mjs`'s `CONTEXT_EVENTS`
   lived as a hand-copied array in its own test, already drifted (missing `PermissionRequest`,
   `SubagentStart`), because the adapter's top level reads stdin synchronously and cannot be safely
   imported. Extracted to a pure sibling, `codex-hook-events.mjs`.
4. **Tonight:** `codex-hook-wrapper.mjs`'s `blockingHooks` — a second hand-maintained authority-copy
   in the same file family — had drifted from TABLE for the same underlying reason (two independent
   lists, no test proving agreement), just with the opposite polarity: a stale extra member instead
   of a missing one. Same root cause repeated a fourth time on the same host boundary.

## The hypothesis

> Given `codex-hook-wrapper.mjs`'s `blockingHooks` Set and `hook-shim.mjs`'s own dispatch TABLE
> (the authority for which hookIds are `mode: 'blocking'`), when a new test asserts every
> Codex-registered, TABLE-`mode:'blocking'` hookId is a member of `blockingHooks`, **and** that
> `blockingHooks` names no hookId TABLE does not also call blocking, then a future hook added as
> blocking on both hosts without updating the wrapper's Set should fail the test (red) instead of
> silently becoming an unenforced allow on Codex — subject to: no behavior change for the two
> hookIds Codex registers as blocking today (`decision-gate`, `unprompted-speech`), which already
> satisfy the invariant.

## Benchmarks / competitors (context, not directly comparable — internal infra fix)

| Project | Cross-host hook parity discipline | Grade |
|---|---|---|
| **ruvnet-brain (this repo)** | Dedicated both-hosts conformance test suite (`hook-conformance-both-hosts.test.mjs`) plus a mesh census (`hook-registry.mjs`) that enumerates every registry across 7 layers; tonight closes a 4th drift gap on the same boundary | A (this repo, reproducible) |
| **OpenHands** | Single-host tool-execution sandbox; no published cross-host hook-parity harness at time of writing | C (no public evidence either way) |
| **SWE-agent** | Single-host, no analogous multi-host hook dispatch layer | C |
| **Cursor background agents** | Proprietary, no published architecture for cross-host hook enforcement parity | C |
| **DSPy/GEPA** | Optimizes prompts/programs, not hook/tool dispatch infrastructure — not a comparable surface | N/A |

No external claim above is load-bearing for tonight's decision; it is offered as context that
cross-host hook-parity testing at this granularity is not a commodity practice elsewhere, and this
repo's own prior 3 findings on the identical boundary are the load-bearing evidence.

## Evaluation

- **Evaluator:** `npx vitest run tests/unit` (full suite) and `npx vitest run tests/integration`
  (full suite), baseline (`git stash`, unmodified `main`@`282c66c0`) vs candidate.
- **Baseline:** `test:unit` 6 failed files / 3755 passed / 6 failed tests / 28 skipped / 161 todo
  (3950 total). `test:integration` 5 failed files / 290 passed / 9 failed tests / 12 skipped / 53
  todo (364 total). All failures pre-existing/environmental (chmod/EACCES-under-root fixtures,
  `sqlite3`/`@xenova/transformers` missing, one pre-existing deadlock-regression flake) — confirmed
  by running baseline twice more with the identical failure list.
- **Candidate:** `test:unit` 6 failed files / 3758 passed / 6 failed tests (byte-identical failure
  list to baseline) / 28 skipped / 161 todo (3953 total — 3 more than baseline, exactly the new
  test's 3 assertions). `test:integration` byte-identical to baseline (9 failed / 290 passed).
- **New test TEETH, verified two ways:**
  1. With the two new sibling-extraction files removed (an earlier, abandoned draft of this
     candidate), the test fails to even load (`ERR_MODULE_NOT_FOUND`) — confirmed, then reverted
     when that draft was abandoned in favor of reusing `hook-registry.mjs`'s existing authority
     functions instead of a new sibling file (see Security Review below for why the sibling-file
     approach was rejected).
  2. Reverting ONLY the `route-dispatch` removal (`sed` reinserting the entry, everything else
     candidate) reproduces the exact real defect: `expected [ 'route-dispatch' ] to deeply equal []`
     on the "names no hookId TABLE does not also call blocking" assertion. Restoring the fix returns
     it to green. This is not a "module absent" proof alone — it is a proof against the real,
     historical bug.
- **`npm run eval:gate`:** `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (this
  container never materializes a corpus; `stores 0 dark 0` independently confirmed via
  `restore-local-ingests.mjs`/`brain-score.mjs`/`store-root.mjs`). Not this candidate's surface
  (retrieval/grounding) regardless.
- **`npm run claims:verify`:** 3 PASS / 4 SKIP, matching every recent night's documented baseline.
- **`npm run qa:pr`:** `version`/`convergence` (after `npm run convergence:write`)/`execution-policy`/
  `substitution`/`catalog`/`contract`/`mesh`/`plugin` lanes PASS. `docs` and `wiring` lanes FAIL —
  confirmed via a second `git stash` run that BOTH fail identically on unmodified `main` (55
  pre-existing doc-currency BLOCKs across unrelated ADRs; `scripts/product-integrity-contract.mjs`
  unwired, unrelated to hooks). The actual pre-push gate (`scripts/git-hooks/pre-push`, not
  installed in this container) scopes doc-currency to `--changed <merge-base>` rather than the
  whole repo; run that way, this candidate's scoped diff produces **0 blocking findings**.

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete, one-line Set-membership fix plus a new
proof test (same as the 2026-08-31/2026-08-28 precedent for structurally identical fixes).

## Evidence

OBSERVATION (`hook-shim.mjs`'s own comment already disowns route-dispatch's blocking status, in the
past tense, unread by the sibling file) → MEASUREMENT (regex-parsed `blockingHooks` vs `shimTable()`
disagree for exactly one id, `route-dispatch`; TEETH proof reproduces the disagreement by reverting
only the fix) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No gold data, held-out evaluation set, or existing test's assertions were touched — `git diff`
confirms the only production-code change is one Set-membership line plus a comment in
`codex-hook-wrapper.mjs`, one ADR currency-log row, and the regenerated (mechanical)
`data/convergence-manifest.json`. The new test is additive only. Independent critic engaged (see
Security Review / Evidence sections in the PR body for the critic's verified findings).

## Security Review

Security-sensitive by nature (this is exactly "which refusals does the host actually enforce").
Confirmed the fix only REMOVES a dead, misleading Set entry — no currently-live refusal path is
disabled: `route-dispatch` could never actually reach an enforced exit-2 through this wrapper even
*before* the fix, because `hook-shim.mjs`'s own dispatch (`entry.mode === 'blocking' ? (r.status ??
0) : 0`) coerces its real exit code to 0 unconditionally regardless of `blockingHooks`' membership.
The direction that matters for safety — a truly-blocking hook missing from `blockingHooks` — is the
one the new test's first assertion guards, and it holds today (the two Codex-registered blocking
hookIds, `decision-gate` and `unprompted-speech`, are both present).

One design correction made mid-session, disclosed rather than hidden: the first draft of this fix
extracted `TABLE` and `blockingHooks` into new pure-data sibling files (`hook-shim-table.mjs`,
`codex-hook-wrapper-table.mjs`) so a test could import them safely, mirroring the 2026-08-30
`codex-hook-events.mjs` precedent. That draft caused real regressions: 13 extra failing test files
(`codex-lifecycle-hooks.test.mjs`, `hook-registry-lint.test.mjs`, `decision-gate.test.mjs`,
`swarm-slot-recycler.test.mjs`, and others) that parse `hook-shim.mjs`'s and `codex-hook-wrapper.mjs`'s
*raw source text* by regex as their own authority, and — the more serious finding —
`codex-hook-wrapper.mjs` is deployed as a SINGLE, standalone file by `bin/install.mjs`
(`fs.copyFileSync(hookWrapperSource, tmp)`, no sibling files travel with it), so a relative import
from a copied-alone file breaks at the real deployment boundary the moment it is spawned outside the
full plugin tree — reproduced live via `tests/unit/codex-lifecycle-hooks.test.mjs`'s own
installed-boundary tests going red. Abandoned that draft in full (`git checkout` on all touched
files, deleted the new sibling files), reused `hook-registry.mjs`'s existing, already-imported,
already-tested `shimTable()`/`codexDispatchIdIn()` functions instead, and parse `blockingHooks` by
regex on `codex-hook-wrapper.mjs`'s own source text (comments stripped via
`scripts/wired-check.mjs`'s own `stripComments()`, since the explanatory comment on the fix itself
quotes the string `'route-dispatch'` and would otherwise false-positive the new test). Confirmed
byte-identical baseline-vs-candidate failure sets on both `test:unit` and `test:integration` after
the correction.

## Witness

```
SESSION_COMMIT = 282c66c0467cf11d1fdd5f9850d61e9b27ce579f
REPORT_HASH    = ca72e3886f02cad81fd8a3f09e41a124e8733ee4860287d46473618cab821805
WITNESS        = 5c05fd2cb84f259d03c0f08654ca0d99fd8d584b21e5fed0e10e100b0333c70f
```

Verifier procedure (reproduce independently):
1. `git checkout 282c66c0467cf11d1fdd5f9850d61e9b27ce579f`
2. Apply the candidate PR's diff.
3. `sha256sum` this exact report file → must equal REPORT_HASH above (before this line was filled
   in — the hash was computed and frozen against the report as it stood at Witness time, then this
   section was rewritten with the values; the PR's committed copy of this report carries the same
   hash-of-content-before-this-rewrite convention this repo's prior nights use).
4. `printf '%s%s' ca72e3886f02cad81fd8a3f09e41a124e8733ee4860287d46473618cab821805 282c66c0467cf11d1fdd5f9850d61e9b27ce579f | sha256sum` → `5c05fd2cb84f259d03c0f08654ca0d99fd8d584b21e5fed0e10e100b0333c70f`.
5. `npx vitest run tests/unit/codex-blocking-hooks-parity.test.mjs` → 3/3 pass; revert only the
   `route-dispatch` removal in `codex-hook-wrapper.mjs` → 1/3 fails with the exact assertion above.

## Recommendation

ACCEPT pending human review. Tiny (one Set-membership line + comment in production code, one new
test file, one ADR currency-log row), non-duplicative of the 12+ open dream-cycle PRs on other
surfaces, zero regressions on either full test suite, and closes the 4th instance of the same
undetected-drift bug class on this exact file family — worth a fifth instance not happening.

## Next steps

1. Human review and merge (or explicit rejection) of the draft PR.
2. Consider whether `hook-registry.mjs`'s mesh census (already the authority for TABLE) should also
   become the single authority `codex-hook-wrapper.mjs` reads its `blockingHooks` contract from at
   runtime — today the wrapper's Set is independently hand-maintained by design (single-file
   deployment constraint), so a *test* proving agreement is the available fix, not a shared runtime
   import; a future architectural change could revisit that constraint itself if the single-file
   deploy model ever changes.
3. Given 12+ open dream-cycle draft PRs (#182, #184, #194, #227, #229, #231, #233, #237, #239, #244,
   #246 at time of writing) and a review backlog first flagged 2026-08-26, this candidate was kept
   deliberately tiny in response — consistent with the ledger's own learning signal.
