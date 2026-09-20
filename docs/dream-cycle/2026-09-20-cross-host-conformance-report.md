# Cross-Host Conformance SOTA Report — 2026

## TL;DR

`release-candidate-preflight.yml`'s `stranger` job (the matrix that specifically catches
cross-host/foreign-install parity defects) `needs: ci`. GitHub Actions' default job condition is
`success()`, so whenever `ci` is red, `stranger` is **skipped**, not failed — and `aggregate`, which
`needs` `stranger` among others with no `if:` override, cascades into a skip too. The whole release
gate then shows a page of grey "skipped" checks instead of one red one. This already happened for a
real month (commit `965ee55c`, 2026-09-15, discovered only because a human went looking) and nothing
in the workflow graph prevents it recurring the next time `ci` goes red for any reason. Tonight's
candidate makes `aggregate` run unconditionally (`if: always()`) and fail loudly — a real non-zero
exit, not a log line — whenever any required lane's result isn't `success`.

## What's new

Nothing upstream changed; this is an audit of the repo's own CI graph, prompted by re-reading commit
`965ee55c`'s own account of how the previous incident was found (not by any automated signal — by a
human noticing the stranger matrix's `last run` date was three weeks stale).

## Competitor comparison (how similar systems keep a fan-out safety gate honest)

| System | Mechanism | Grade |
|---|---|---|
| GitHub Actions (this repo, pre-candidate) | `needs: ci` on `stranger`; default `if: success()` on `aggregate` — a skip cascades silently | — (the defect) |
| GitLab CI `needs` + `rules: when: always` | explicit `when: always` reachable per-job; widely documented pattern for "always run the summary job" | A (official docs) |
| Sakana AI Scientist / SWE-agent nightly harnesses | typically single-process, no multi-lane CI fan-out to compare | C (not directly comparable) |
| CNCF/`tektoncd` pipelines | `finally:` tasks always execute regardless of upstream task result, specifically to prevent silent pipeline-wide skips | A (official docs) |
| This repo, post-candidate | `aggregate: if: always()` + explicit `needs.*.result` guard step, `exit 1` on non-success | A (self, verified below) |

## Hypothesis (frozen before verification)

> Given the current `release-candidate-preflight.yml` job graph, when `ci` (or any lane `stranger`/
> `early-public-*` transitively depends on) fails, then `aggregate` — the job responsible for
> validating and persisting the release-candidate evidence bundle — is silently SKIPPED rather than
> FAILED, subject to: the fix must not weaken `stranger`'s existing fail-fast-on-`ci` behavior (it
> still should not spend runner time on a doomed `ci` sha), it must only make the *reporting* of that
> outcome loud instead of silent.

## Candidate

`.github/workflows/release-candidate-preflight.yml` (14 lines changed) + one new test,
`tests/unit/release-preflight-aggregate-teeth.test.mjs` (46 lines). `aggregate` gets `if: always()`
and a new first step that fails (`exit 1`) whenever `contains(needs.*.result, 'failure')`, `'skipped'`,
or `'cancelled')` is true. No other job's `needs`/`if` changed — `stranger` still skips (not runs) when
`ci` fails, preserving the cost-saving fail-fast this repo's own `stranger-matrix.yml` comment
documents; only `aggregate`'s reaction to that skip changes, from silent to loud.

## Evaluation Receipt

- New test `tests/unit/release-preflight-aggregate-teeth.test.mjs`: **3/3 RED** on baseline
  (`git stash` the workflow change, keep the test) — `if: always()` absent, no `needs.*.result` guard,
  guard-before-download ordering unmet by construction. **3/3 GREEN** on candidate. Reproduced twice.
- Blast radius: every other test file referencing `release-candidate-preflight.yml` by name
  (`release-evidence-dag`, `protected-release-workflow`, `protected-artifact-provenance`,
  `qualify-once-workflow`, `agentic-qe-early-public`, `qualified-candidate-check` — 59 tests total):
  **59/59 pass unchanged.**
- `npm run test:unit` (full, 451 files / 5629 tests): candidate and true baseline (`git stash` +
  test file moved aside) produce the **identical 40-test / 13-file failure set** — see Reward-Hack
  Check for the file-by-file diff. All pre-existing/environmental (chmod/EACCES-under-root, missing
  corpus/oracle materialization, disposable-git-repo fixtures needing real network) per this
  container's own documented history since 2026-08-26.
- `npm run test:integration` (49 files/400 tests): **9 failed files / 23 failed tests / 309 passed /
  15 skipped / 53 todo** — byte-identical to the exact numbers this surface's own 2026-09-15 ledger
  row (PR #291) documented, all pre-existing/environmental (missing native `sqlite3` under this
  container's root user, `@xenova/transformers` network download, a disposable-checkout regression
  test needing real network). None reference the changed workflow file.
- `npm run claims:verify`: 3 PASS / 4 SKIP (brain-not-installed class), consistent with every prior
  night.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`, `stores 0
  dark 0` (container never materializes a corpus; `OPENROUTER_API_KEY` present, not a credentials
  block — consistent with every prior night).
- `npm run wired:check`: exit 1 both on candidate and on baseline (`git stash` confirmed) — two
  `scripts/oracle/*.mjs` files "built, and invoked by nothing," an unrelated pre-existing gap in a
  different subsystem (the 2026-09-15 oracle-inventory work), not caused by tonight's candidate.
- YAML validity: `python3 -c "import yaml; yaml.safe_load(open(...))"` — parses clean.
- Independent adversarial critique (fresh-context agent, not this session): found the fix logically
  sound and `needs.*.result` syntactically valid, but flagged two real test-quality gaps (the
  job-vs-step indentation check was too loose; the step-splitting regex silently degraded to a
  whole-block check) and one security nit (`${{ toJSON(needs) }}` interpolated raw into a shell
  `echo` — the injection anti-pattern this repo's own `release-evidence-dag.test.mjs` already bans
  for the same pattern elsewhere). All three fixed: the indentation assertion now requires exactly
  4-space job-level placement, the step-splitting regex matches the real 6-space step indent, and the
  guard step now passes the JSON through `env: NEEDS_JSON` and references `$NEEDS_JSON` in the shell
  script instead of raw interpolation. Re-verified red→green after each fix.

## Witness

```
SESSION_COMMIT = 231c565640110e6cfe2a06892a4475a95fc742d5
REPORT_HASH    = 6bb2a72799b821aca58b8655ac713eb9ab9854d6ffce98efc8c2171c76fdd3c8
WITNESS        = ba25c04661f3072e8c71fdcbed5a3fdd315e4c9cb7136913efafc98a4ae8fe5b
```

5-step verifier: (1) checkout commit `231c5656`; (2) apply this PR's diff; (3) `sha256sum` this gist
file, confirm it matches `REPORT_HASH` above; (4) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`,
confirm it matches `WITNESS`; (5) re-run `npx vitest run tests/unit/release-preflight-aggregate-teeth.test.mjs`
against the pre-candidate workflow file (`git stash` it) and confirm 3/3 RED, then restore and confirm
3/3 GREEN.

## Next steps

1. The same silent-skip-cascade shape may exist in other reusable-workflow graphs in this repo
   (`protected-release.yml`, `release-aggregate.yml`) — not audited tonight; scoped to
   `release-candidate-preflight.yml` because that is the one `stranger-project-behaviour`'s own
   incident (`965ee55c`) named.
2. `plugin/scripts/hook-registry.mjs`'s header comment (lines ~38-40) still cites `route-dispatch`,
   `learn-capture` as ids `codex-hooks.json` currently uses; it does not (verified against the live
   file tonight) — flagged in PR #278 (2026-09-10) for "whichever rotation next touches this file's
   header," never picked up. Comment-only, no runtime effect; left for a future night given tonight's
   candidate already exists and the review backlog (below) argues against stacking a second PR.
3. **Standing finding, not this row's to fix:** as of tonight, essentially zero dream-cycle PRs have
   merged since 2026-08-31 (#215) — dozens of open draft PRs spanning every DEEP surface, most
   self-certified ACCEPT with clean receipts. `autoMerge: false` is working exactly as designed; the
   review step, not the research, is now the bottleneck. Flagged in nearly every night's ledger row
   since 2026-08-26 and worth the owner's direct attention independent of this PR's content.
