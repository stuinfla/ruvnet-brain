# Brain-Currency SOTA Report — 2026

## TL;DR
`scripts/ingest-repo.mjs`, the on-demand "load a new rUv repo into the brain" CLI, reported a store DARK (unreachable by description) whenever it was reachable only through a `repo-aliases.json` alias card — the exact false-positive class `kb/store-root.mjs`'s `darkStores()` was fixed for weeks ago, never migrated to this sibling. Fixed by importing the same resolver, `repositoryNames()`.

## What's new
- **CONCURRENT NIGHT**: a separate firing of this same routine (same DATE, same SLOT=1/DEEP=brain-currency) landed first as PR #312 (`kb/corpus-freshness.mjs`'s `versionIntent()` package-boundary regex fix), on the un-suffixed `dream/2026-09-21-brain-currency` branch. This report/PR is this session's independent, non-overlapping finding — different file, different mechanism — pushed to a suffixed branch to avoid colliding with it.
- Confirmed the bug is live on tonight's `main` (`metaharness` → aliased to `## agent-harness-generator`, would report DARK).
- This exact false-positive class previously caused real damage per `kb/store-root.mjs`'s own account: a duplicate, routing-breaking `## metaharness` card was hand-added in response to it.
- Reconciled against the two other currently-open `brain-currency` PRs (#280: `forge-currency.mjs`'s `brainKnownSet()` SOURCE.json path; #292/#293: `panelStrict` `generatedAt` write-side) — distinct file, distinct mechanism, no overlap.

## Competitors (C-grade, context only)
| System | Distinguishes "the router's real answer" from "a CLI's own reimplementation of the same check"? |
|---|---|
| Sakana AI Scientist | No published discipline for this class |
| OpenHands | No published discipline for this class |
| DSPy/GEPA | No published discipline for this class |
| SWE-agent | No published discipline for this class |
| Cursor background agents | No published discipline for this class |

## Hypothesis (frozen before evaluation)
> Given `scripts/ingest-repo.mjs`'s `carded` check on today's `main`, when a store is ingested under a name reachable only through a `kb/repo-aliases.json` alias card (not a direct heading match), the raw-name regex will report it DARK even though the router's own `repositoryNames()`-based resolution (already used by `darkStores()`) would find it — replacing the raw regex with an alias-aware lookup via the same resolver should make the CLI's own routability claim agree with the router's, with zero behavior change for the direct-match case.

## Evaluation
- TEETH: reverting only the production fix reproduces the exact predicted failure (`DARK: no '## metaharness' section`); restoring returns 15/15 green.
- `test:unit` full suite: candidate 51 failed/5556 passed vs. baseline 50 failed/5556 (delta = `convergence-manifest.test.mjs`, the expected mechanical consequence of any diff; fixed by `npm run convergence:write`, confirmed green after).
- `test:integration`: baseline vs. candidate byte-identical failure set (23 failed files/tests both sides, all pre-existing/environmental: chmod/EACCES-under-root, sqlite3/cross-encoder model cache, gh-interception fixtures).
- `claims:verify`: 3 PASS/4 SKIP, matching the documented no-brain-installed baseline.
- `qa:pr`: version/convergence/execution-policy/architecture/wiring/substitution/catalog/mesh/plugin all PASS. `docs` FAIL (pre-existing ADR-currency backlog, confirmed unrelated — no ADR governs `scripts/ingest-repo.mjs`), `coverage` TIMEOUT, `claims-source` BLOCKED — both pre-existing/environmental.
- `eval:gate`: EVALUATED=blocked, `no brain at /root/.cache/ruvnet-brain/kb` (this container never materializes a corpus). Not the relevant evaluator regardless — no retrieval/grounding surface touched.
- Blast radius: exactly one call site (`carded` inside `ingest-repo.mjs` itself). Verified (not assumed) that both downstream callers, `scripts/restore-local-ingests.mjs` and `scripts/ingest-new-repos.mjs`, check only the child process exit code (`execFileSync`/`spawnSync` with `stdio:'inherit'`), never parse this CLI's DARK/routable stdout text, so neither can be affected by the wording change.
- Independent critic (separate subagent, fresh context, not this candidate's author): **CLEAR**. Verified the TEETH proof by re-running it, confirmed case-insensitivity preserved and slightly strengthened, confirmed the blast-radius claim by reading both call sites directly, confirmed `data/convergence-manifest.json`'s regeneration was mechanical/benign. Flagged two non-blocking observations: (1) `repositoryNames()` throws on a handful of JS-prototype-shaped `--name` values (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) because `loadRepoAliases`'s returned object is checked with a truthy-property lookup rather than `Object.hasOwn` — pre-existing in the shared resolver (also reachable via `darkStores()`/`storesAt()`), not introduced by this diff, and not fixed here (out of scope: fixing it belongs in `kb/card-lane.mjs`, would need its own TEETH test, and touches the shared resolver every other alias-aware caller depends on); (2) `loadRepoAliases` is first-file-wins, so a stale installed `repo-aliases.json` would still yield a false DARK — this fix is bounded to "agrees with the router," not "immune to the router's own staleness."

## Witness
```
SESSION_COMMIT = 6c0c8d4abb09577f655f9e8a61b2733d95a62f18
REPORT_HASH    = f56409cee3e4ac89892936eeae38d873a25e805991676ffb8b717dcd636fef36
WITNESS        = 9dc917d455169bc78d892bcc5087fcaacdae2543cb0e94d9f13de59dd7d9914c
```

Verifier (anyone can reproduce): 1) checkout SESSION_COMMIT; 2) recompute this file's sha256, compare to REPORT_HASH; 3) recompute sha256(REPORT_HASH ++ SESSION_COMMIT), compare to WITNESS; 4) re-run the TEETH proof in tests/integration/ingest-repo.test.mjs (revert scripts/ingest-repo.mjs only, confirm the alias test fails with the DARK message, restore, confirm 15/15 pass); 5) re-run npm run claims:verify / npm run qa:pr and compare lane statuses to those listed above.

## Next steps
1. A human reviews and merges (this session never self-merges).
2. Consider a follow-up fixing `kb/card-lane.mjs`'s `loadRepoAliases`/`repositoryNames` to use `Object.hasOwn` instead of a truthy property check, closing the prototype-key crash the critic found (shared by every alias-aware caller, not just this one).
3. Standing: the `dream/*` review backlog (22 open, unmerged PRs as of tonight, oldest 13 days, essentially frozen since 2026-08-26) is now the dominant constraint on this system's value — review throughput, not more nightly research, is what's blocking realized fixes.
