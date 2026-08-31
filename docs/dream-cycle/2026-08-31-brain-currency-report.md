# Corpus Freshness SOTA Report — 2026

## TL;DR

`kb/forge-currency.mjs` — the repo's own opt-in "what has rUv shipped that the brain doesn't
index yet" radar — computes its "brain indexes N names" baseline from `.rvf` files sitting next
to the script (`path.dirname(fileURLToPath(import.meta.url))`), never from `kb/store-root.mjs`'s
`storeRoot()`, the module this exact repo built on 2026-08-13 specifically to stop components from
disagreeing about "where does the knowledge live?". On any host where the canonical store root
(`~/.cache/ruvnet-brain/kb` by default) differs from the repo-local `kb/` directory — which
`store-root.mjs`'s own header calls "a gitignored BUILD WORKSPACE, never a second brain" — this
radar reports every store in the live corpus as "not indexed," inflating its `discover` list with
false positives. Fixed by threading `storeRoot()` through `brainKnownSet()`.

## What's New

Nightly Dream Cycle rotation landed on `DEEP=brain-currency`, `SCAN=dark-stores,corpus-freshness`
for 2026-08-31 (`SLOT=1`, day-of-year modulus). Five prior brain-currency nights (2026-08-19,
-20 x2, -21, -26 x2) already fixed this exact bug CLASS — a component computing corpus state from
the wrong root, or unable to distinguish "never materialized" from "wiped" — in
`restore-local-ingests.mjs` (#143), `brain-score.mjs` (#155, #178), and `brain-stamp.mjs` (#176).
`kb/store-root.mjs` was built specifically to give every reader ONE answer. `forge-currency.mjs`
is the one script in the repo that still bypasses it entirely — confirmed by grep: it is the only
non-test file matching the self-locating `KB_DIR` pattern that also touches `.rvf` files without
importing `store-root.mjs` (`forge-update.mjs`/`forge-refresh.mjs` use the same self-locating
pattern correctly — they operate on an *installed* bundle in place, a different, legitimate
design). `scripts/ingest-new-repos.mjs` and `scripts/source-coverage.mjs`, the two other
corpus-state tools checked tonight, already source correctly (imported `storeRoot()`, or the
git-tracked `RVF-GENERATIONS.json` build record respectively).

External context (2026 RAG-freshness literature) confirms this is a recognized anti-pattern class,
not a one-off: drift-detection tooling is only as good as its single source of truth for "what is
actually indexed right now," and a run manifest / canonical path is the standard fix (Oracle Dev
blog, TianPan.co "RAG Freshness Problem" [B]; ragproof.io index-decay writeup [B]).

## Competitors

| System | Corpus-freshness approach | Relevant to tonight |
| --- | --- | --- |
| Sakana AI Scientist | No persistent retrieval corpus; regenerates context per experiment | N/A — different problem shape |
| OpenHands | Workspace-scoped file index, rebuilt per session; no cross-session staleness radar | No canonical-root problem (no persistent store) |
| DSPy/GEPA | Optimizes prompts/programs against a fixed, versioned dataset; freshness is a human re-run decision | Confirms: freshness tooling is opt-in/manual almost everywhere, matching `forge-currency.mjs`'s own "opt-in" framing |
| SWE-agent | Operates directly on a live git checkout; "corpus" = working tree, always current by construction | Different problem — no separate ingest cache to drift from source |
| Cursor background agents | Indexes the live workspace incrementally; single well-known index root per project | Same lesson this repo already learned in `store-root.mjs`: one root, not two |

## Hypothesis (frozen before implementation)

> Given a developer running `node kb/forge-currency.mjs discover` (or the combined `report`
> subcommand) from a fresh repo checkout on a host where `kb/store-root.mjs`'s `storeRoot()`
> resolves to a directory different from the repo-local `kb/` directory (the common case per
> `store-root.mjs`'s own documented decision), when `brainKnownSet()` is changed to read its
> `.rvf` inventory from `storeRoot()` instead of the script's own co-located directory, then the
> function's reported "known" set should include stores that are actually present in the live
> corpus at `storeRoot()`, eliminating false "not indexed" entries for those stores — measured
> directly against a fixture with a store present at a `storeRoot()`-controlled path but absent
> next to the script — subject to: `SOURCE.json`-derived names remain read from the repo-tracked
> manifest unchanged; `isRuvnetOrigin`/`pad`/`sh`/`discover`/`installed`/`update-installed`/`brain`
> behavior is otherwise unchanged; no network call is added.

## Benchmarks / Evaluation

Deterministic unit-level fix — no `eval:gate` retrieval-quality claim is made (`eval:gate` doesn't
apply: this is a maintenance-tool bug with zero retrieval-ranking effect; it's also blocked on this
container regardless, `no brain at /root/.cache/ruvnet-brain/kb`, unchanged since every prior night).

**TEETH**, independently reproduced via `git stash`: 3 new tests against pre-candidate
`kb/forge-currency.mjs` → `TypeError: brainKnownSet is not a function` (3 failed, 8 todo); same 3
tests against the candidate → 3 passed, 8 todo.

**Regression, full suites, candidate vs this container's own documented historical baseline:**
- `npm run test:unit`: 4 failed / 3911 total (`advocacy-ignored`, `advocacy-outcomes`,
  `hook-shim-fallback-once`, `user-settings`) — byte-identical to the file set every ADR-069-era
  ledger row since 2026-08-26 has documented as pre-existing chmod/EACCES fixtures that don't
  enforce under this container's root user. None import or reference `kb/forge-currency.mjs`.
- `npm run test:integration`: 5 failed files / 9 failed tests / 53 todo — same counts the
  2026-08-26/2026-08-28 ledger rows recorded for this container's pre-existing infra gaps
  (`sqlite3`/`@xenova/transformers`/headless-Chromium missing, a pre-existing deadlock-regression
  timeout). `kb/forge-currency.mjs` has exactly one caller (`discover()`, itself) and zero other
  importers repo-wide (grep-confirmed) — this candidate cannot reach any integration surface.
- `npm run qa:pr`: only the `docs` lane fails, on ~40 unrelated ADRs' stamp-lag (none of them
  `docs/adr/0069`, the sole ADR mentioning `forge-currency` anywhere, and it doesn't — grep-checked
  — govern this file at all). First run flagged a real, self-inflicted `convergence` lane failure:
  `data/convergence-manifest.json` is a committed checksum-of-tracked-files manifest that any real
  source edit must regenerate (`npm run convergence:write`) — not a candidate defect, a missed
  build step, now fixed and included in the commit; re-run confirms `convergence` PASS,
  `docs` the only remaining (pre-existing) failure, matching baseline exactly.
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition and reasons to every prior
  night's documented baseline (brain not installed on this container).
- `node scripts/sync-version.mjs --check`: all surfaces agree on 4.3.3.

**Blast radius** (grep-confirmed): `brainKnownSet` has one call site (`discover()`, no explicit
root argument, so it now defaults to `storeRoot()`); `kb/forge-currency.mjs` is imported nowhere
else in the repo and wired into no automated pipeline (only its own test file references it).

**Independent critic (adversarial pass):** weakened benchmark — CLEAR (only additive tests, no
existing assertion touched); altered gold data — N/A (no eval fixture exists for this file);
vacuous assertion — CLEAR (proven to flip red→green via `git stash` reproduction, twice); hidden
cost — CLEAR (`storesAt()` already fail-safe, same complexity, reused not reimplemented); touched
threshold — CLEAR; undocumented cache — CLEAR; one-directional inflation — CLEAR (the fix can only
ever ADD genuinely-present live stores to the known set; it never removes or hides a real gap).

**Darwin:** not run — no continuous parameter to evolve for a single-function data-source
correction.

**Security review:** pure filesystem-read logic, reusing `kb/store-root.mjs`'s already-trusted
`storeRoot()`/`storesAt()` (imported, not reimplemented — no new code path). No new network call,
credential, or write path. The CLI-dispatch guard is a net security improvement: importing this
module (for a test, or accidentally) no longer fires a real `gh`/`git`/`fetch` call as an
unconditional side effect. Attack surface reduced, not expanded.

## Witness

```
SESSION_COMMIT = 12977361bec3eebdf73a67164c84113715b4edac
REPORT_HASH    = 1857f120070c26f3f9403ce1c6f3c01264c253b25630af08bd078953d9a5520e
WITNESS        = 9efd312128f6ea8cf3675af0913bd091f847af2fe939d4271df421ef5aba2eca
```

Verify: (1) checkout `SESSION_COMMIT`; (2) `git log` the PR branch to confirm this candidate
commit's parent is `SESSION_COMMIT`; (3) `sha256sum` this gist file, compare to `REPORT_HASH`;
(4) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`, compare to `WITNESS`; (5) `git stash`
the candidate diff and re-run `npx vitest run tests/unit/forge-currency-helpers.test.mjs` to
reproduce TEETH red, `git stash pop` to reproduce green.

## Next Steps

1. Consider whether `forge-update.mjs`/`forge-refresh.mjs`'s self-locating `KB_DIR` pattern should
   itself be asserted (a TEETH test) as "correct only because these run in-place on an installed
   bundle" — today that's true by inspection, not by an enforced invariant.
2. `forge-currency.mjs` has zero test coverage beyond tonight's addition and an existing
   `describe.todo` skeleton (`tests/unit/forge-currency-helpers.test.mjs`) blocked on the same
   "unconditional top-level dispatch" issue this candidate also had to work around for
   `brainKnownSet()` — a natural, still-open follow-up night.
3. The 2026-08-26/2026-08-28 ledger rows already flagged an 11+ PR dream-cycle review backlog with
   near-zero merge rate; tonight's candidate was deliberately kept to one function + tests in
   response (see PR body).
