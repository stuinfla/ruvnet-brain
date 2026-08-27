# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-08-27** · SLOT=2 · DEEP=`enforcement-integrity` · SCAN=`lesson-delivery`,`gate-teeth`

## TL;DR

`plugin/scripts/degradation-watch.mjs` (`DEPENDENT_COMMANDS`) and `plugin/scripts/lesson-hooks.sh`
each carry their own regex answering the same question — "is this command a `ship`?" — a duplication
this repo's own comments already call out as its recurring defect class (two audits on 2026-08-13
found them "shipped already disagreeing"; a test titled "the two ship definitions agree" was added to
guard it). Tonight: they still disagreed. The JS side (`\s+`) tolerates any whitespace between a verb
and its argument (`npm  publish`, a tab, a wrapped newline); the bash side (`grep -E` with a literal
space) did not. A real `npm  publish` (double space — plausible from templated/copy-pasted commands)
was correctly caught by `degradation-watch.mjs`'s safety refusal but silently failed to pull the ship
lesson through `lesson-hooks.sh`'s dispatcher. The existing "agree" test's 7 cases never included a
whitespace variant, so it passed today while blind to the exact defect class it was built for.

**The first cut of the fix reopened the same defect class in a new shape** — caught live by an
independent adversarial critic pass, not by this session's own review. Fixed before final witness.
See Reward-Hack Check.

## What's new

- Root-caused via direct inspection of `plugin/scripts/degradation-watch.mjs` and
  `plugin/scripts/lesson-hooks.sh`, not literature — same method this repo's prior enforcement-integrity
  nights (issues #156, #158) used.
- Reproduced live in this container with both engines side by side: JS `\b(?:npm|yarn|pnpm)\s+publish\b`
  matches `"npm  publish"`, `"npm\tpublish"`, `"yarn\npublish"`; bash `grep -E` with the literal-space
  pattern `\b(npm|yarn|pnpm) publish\b` matched none of them. Same divergence for
  `gh release create` vs `gh  release   create`.
- `tests/unit/lesson-gate.test.mjs`'s `describe('the two ship definitions agree', ...)` — the test
  this repo's own comments say exists specifically to prevent this class of drift — ran clean on
  unmodified `main` (`1 passed`) because none of its 7 cases carried irregular whitespace.
- A related but disjoint lesson-delivery gap was surveyed and deliberately NOT fixed tonight: an
  independent research pass found `scripts/record-lesson.mjs` never passes a `trigger:` tag when it
  shells to `ruflo memory store`, so `plugin/scripts/lesson-bridge.mjs`'s `if (!tags.trigger) return
  { skip: ... }` structurally guarantees every lesson it records is permanently skipped by the bridge
  — contrary to `docs/ARCHITECTURE-MAP.md`'s documented pipeline and the script's own claim of being
  "the durable 'capture a lesson the RIGHT way' habit." Not implemented tonight: it touches
  ADR-0066's already-disputed, unresolved 2026-08-13 provenance-vs-tags entry, and a same-night fix
  risks guessing the wrong side of a live disagreement rather than making one conceptual change. See
  Next Steps.

## Hypothesis (frozen before implementation)

> Given a real `git push`/`npm publish`/`yarn publish`/`pnpm publish`/`gh release create` shell command
> whose whitespace between the verb and its argument is anything other than a single ASCII space (a
> tab, a doubled space, or a wrapped newline — all plausible in templated or agent-generated commands),
> when `plugin/scripts/lesson-hooks.sh`'s ship-trigger `grep -E` pattern is widened from a literal
> single space to `[[:space:]]+` (matching `degradation-watch.mjs`'s existing `\s+`-tolerant JS
> pattern), then the two independent "is this a ship?" definitions should agree across a shared
> whitespace-variant test matrix — relative to the current baseline, where the bash side misses every
> such variant while the JS side (which the memory-degradation safety refusal already depends on)
> correctly recognizes them — subject to: zero change in classification for any single-space-delimited
> command already covered by the existing 7-case parity test, no change to `degradation-watch.mjs`
> itself, and no change to either side's exit codes or refusal authority.

Frozen before implementation; unchanged since. (The critic-caught correction below is a bug FIX to
the candidate's own implementation, made before evaluation was declared complete — not a change to
the frozen hypothesis, which the correction still satisfies.)

## Candidate

Two commits on `dream/2026-08-27-enforcement-integrity`:

1. `5ce96e5` — widened `plugin/scripts/lesson-hooks.sh`'s ship-trigger `grep -E` pattern from a
   literal space to `[[:space:]]+`, and piped `$CMD` through `tr '\n\t' '  '` (after `sed`'s
   quote-stripping) to collapse embedded newlines/tabs before matching. Extended
   `tests/unit/lesson-gate.test.mjs` with 4 whitespace-variant parity cases.
2. `0ee8b77` — **critic-driven correction**: reordered so `tr` runs BEFORE `sed`, not after (see
   Reward-Hack Check for why), and added a 5th TEETH test case for the regression the critic found.

Total diff: 3 files, 37 insertions / 10 deletions across both commits (the production diff in
`plugin/scripts/lesson-hooks.sh` is ~20 lines including comments).

## Evaluation Receipt

Not a retrieval-quality candidate — `eval:gate` out of scope (also independently blocked in this
container: store root never materialized, `stores 0 dark 0`, consistent with every prior ephemeral
run). `LLM_EVAL=blocked` tonight — no `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in this
container's env; no model-graded stage needed for a deterministic pattern-matching fix regardless.

**Guard proven to fail first.** `tests/unit/lesson-gate.test.mjs`'s `describe('the two ship
definitions agree', ...)`, reverted to unmodified `main`: `AssertionError: lesson-hooks.sh: npm
publish: expected false to be true`. Restored: 61/61 pass in the file, on the FINAL (post-critic-fix)
candidate.

**Baseline vs candidate, this container's real state:**

| Command | `degradation-watch.mjs` (JS, unchanged) | `lesson-hooks.sh` baseline | `lesson-hooks.sh` candidate |
|---|---|---|---|
| `npm  publish` (2 spaces) | ship | not-ship (false negative) | ship |
| `npm\tpublish` | ship | not-ship (false negative) | ship |
| `gh  release   create v1.0.0` | ship | not-ship (false negative) | ship |
| multi-line `git commit -m "...npm\npublish..."` | not-ship | not-ship | not-ship (correct, after critic fix) |

**Regression analysis**, baseline vs candidate on the real committed state (byte-identical both runs):
- `npx vitest run tests/integration` (38 files, 313 tests): **5 failed files / 9 failed tests / 240
  passed / 11 skipped / 53 todo**, identical before and after — every failure pre-existing/environmental
  (`@xenova/transformers` missing, `sqlite3` binary missing, headless-browser timing), matching every
  prior night's baseline since 2026-08-19. `hook-conformance-both-hosts.test.mjs` and
  `dual-host-install.test.mjs` (the both-hosts conformance gate): 6/6 pass.
- `npx vitest run tests/unit` (277 files, ran to completion, ~350s): **4 failed files / 3403 passed /
  24 skipped / 161 todo of 3592**, identical to PR #178's (2026-08-26) established baseline. All 4
  failures are the known pre-existing root-user/chmod-fixture class (`advocacy-ignored`,
  `advocacy-outcomes`, `hook-shim-fallback-once`, `user-settings`), none touching the changed files.
  (An earlier run against the UNCOMMITTED diff showed 3 additional failures in
  `learning-replay-{proof,verdict}.test.mjs` — confirmed to be a dirty-working-tree artifact, not a
  code regression: those files explicitly disqualify evidence when "load-bearing source has
  uncommitted changes," and all 3 passed clean once the candidate was committed.)
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical to baseline (skips environmental — brain not
  installed; the LEARNING-REPLAY invariant SKIPs because this candidate itself touched load-bearing
  files, the same reason any dream-cycle night touching this area would SKIP it).
- `node scripts/sync-version.mjs --check`: `4.2.2-dev` agrees on every surface.
- `node scripts/doc-currency.mjs --check --changed`: ADR-0055 (governs `lesson-hooks.sh`) shows
  `wired / current`, 0 BLOCK — resolved by this diff's own currency-log row. The only BLOCKs in the
  full-repo scan are 53 pre-existing, unrelated `stamp-lags-doc` violations from bulk commit
  `4945c2e3` (2026-08-19), present identically before this diff — same pre-existing debt class every
  recent dream-cycle PR has documented and not introduced.
- Blast radius: grepped repo-wide for callers of the changed grep pattern / `dependentEvent` /
  `CMD_EXEC` — only `plugin/scripts/lesson-hooks.sh` (definition), `degradation-watch.mjs` (the
  unmodified JS counterpart), and `tests/unit/lesson-gate.test.mjs` (the parity test) reference either
  side of this logic. Fully contained.

## Darwin Results

`@metaharness/darwin` IS available in this container (confirmed: `npx @metaharness/darwin` prints
real usage, not "not found") — not run because there is no continuous parameter to evolve for a
regex-tolerance/whitespace-normalization fix, same reasoning as every prior night's non-numeric
candidates (PRs #143, #148, #150, #155, #157, #159, #176, #178). Recorded as available-but-inapplicable
rather than silently assumed absent.

## Evidence

- OBSERVATION: `lesson-hooks.sh`'s own inline comments (2026-08-13) already document that its ship
  pattern is "the same patterns as `degradation-watch.mjs` `DEPENDENT_COMMANDS`, and a test asserts
  they agree" — a claim this session found to be false in a shape the test never covered.
- MEASUREMENT: `node -e` and the real dispatcher (`viaBash` harness) both reproduce the whitespace
  divergence live, independent of any test framework. TEETH test fails on unmodified `main`, passes
  on the final candidate, 61/61 in the file.
- MEASUREMENT (critic pass): the reordering regression was independently reproduced through the real
  dispatcher with an actual multi-line `$CMD` string, not inferred from reading the diff.
- INFERENCE: the two "ship" definitions have never been mechanically kept in sync since their creation
  on 2026-08-13; every fix to one side needs the same adversarial-whitespace scrutiny this fix received,
  because a per-line vs. whole-string text engine (`grep`/`sed` vs. a JS regex) is not a coincidental
  implementation detail — it is a structural source of exactly this defect class.
- DECISION: ship the reordered, critic-verified fix; do not attempt to unify the two engines into one
  shared source of truth tonight (see Next Steps — that is an architectural change, not a bug fix).

## Reward-Hack Check

**Independent adversarial critic** (fresh general-purpose agent, not this candidate's author, given
the diff and instructed to try to break it). First-pass verdict: **CONCERNS FOUND** — one real,
concrete false positive: running `tr` after `sed`'s quote-stripping let a multi-line quoted string
(e.g. a real multi-paragraph commit message mentioning "npm" and "publish") leak into `CMD_EXEC` as
unquoted text, because `sed` (line-oriented, no `-z`) never stripped a quote pair that spans an actual
newline. Live-reproduced through the real dispatcher, not asserted from reading the diff:
`git commit -m "release notes\nnpm\npublish is unaffected by this change"` false-positived as `ship`
on the first-cut candidate while `degradation-watch.mjs`'s unmodified `dependentEvent()` correctly
returned `null` — the exact "two ship definitions disagree" defect this diff exists to close, reopened
in a new shape and uncovered by the first cut's own 4 test cases (all single-line).

**Fixed before final witness**: reordered `tr` before `sed` (commit `0ee8b77`), added the critic's
exact reproduction as a 5th TEETH case, re-ran the full parity suite (61/61) plus the full regression
suite (byte-identical to baseline). Second critic-equivalent pass (this session, re-deriving the fix
independently): confirmed the reorder is sufficient — since `tr` now runs first, the command becomes
one logical line before `sed` ever sees it, so the existing `"[^"]*"` quote-stripping regex spans what
was previously a multi-line quote correctly, matching how it already handled single-line quotes.

No benchmark, gold data, frozen debt list, or existing assertion was weakened anywhere in either
commit (`git diff 486a144 HEAD -- tests/` shows only additive cases). No threshold moved. No new
dependency, cache, network call, or credential.

## Security Review

No new attack surface in either commit: the diff performs `tr`/`sed`/`grep` text transforms on
`$CMD`, a string already read via the pre-existing `HOOK_INPUT_JS` parse of stdin — no new file I/O,
network call, external dependency, or credential. `lesson-hooks.sh`'s ship-trigger dispatch is
advisory-only (it selects which ratified lesson text to print); it has no refusal authority and does
not gate `wired-check.mjs --check`'s exit code. `degradation-watch.mjs` (the component with actual
safety-refusal authority) is unchanged by this diff. The critic-caught false positive, had it shipped,
would at most have caused one extra advisory lesson print on an unrelated command — not a security
issue, but a real "guard reads a proxy, not the real shape" defect exactly matching tonight's
gate-teeth theme, which is why it was worth fixing before ACCEPT rather than noting as a known gap.

Separately: this session's own credential-probing commands (`env | grep -iE "OPENROUTER|ANTHROPIC|
OPENAI"`) returned no output — no key present in this container's env, so nothing to redact or report
this time (unlike PR #178's 2026-08-26 finding of a leaked `OPENROUTER_API_KEY`, already reported to
the owner that night).

## ADR

None new. Currency-log row added to existing ADR-0055 (governs `plugin/scripts/lesson-hooks.sh`) in
the same change — not an architectural decision: no new component, no new default, no cross-cutting
policy change, per `node scripts/doc-currency.mjs`'s own governance mapping.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation recorded on
every prior Dream Cycle night: PRs #143/#148/#150/#155/#157/#159/#176/#178). This report is also
committed at `docs/dream-cycle/2026-08-27-enforcement-integrity-report.md` in the candidate PR.

## Witness

```
SESSION_COMMIT = 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f   (origin/main HEAD at Step 0, before candidate)
REPORT_HASH    = e75485313f67ed5ee4c5d8b91b1f6fed40f897c720ba15fa07d6b3e852078352
WITNESS        = c36bd8206aeee4ff53ca0dcbca7a2a8b8dc0dfb6c9365a478497e4536a760321
```

**5-step verifier**: (1) `git fetch origin main && git checkout 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f`
— confirm this is the commit `dream/2026-08-27-enforcement-integrity` branched from. (2) `git log
486a144..0ee8b77 --oneline` — confirm the 2-commit candidate lineage (`5ce96e5`, `0ee8b77`). (3)
`git checkout 486a144 -- tests/unit/lesson-gate.test.mjs plugin/scripts/lesson-hooks.sh && npx vitest
run tests/unit/lesson-gate.test.mjs` — confirm the baseline fails with `AssertionError: lesson-hooks.sh:
npm  publish: expected false to be true`, then `git checkout 0ee8b77 -- tests/unit/lesson-gate.test.mjs
plugin/scripts/lesson-hooks.sh && npx vitest run tests/unit/lesson-gate.test.mjs` — confirm 61/61 pass.
(4) `sha256sum <this report file>` — confirm it equals `REPORT_HASH` below. (5)
`printf '%s%s' "$REPORT_HASH" "486a144dbc9bd5fa3b8b715e0c13935d1add0f1f" | sha256sum` — confirm it
equals `WITNESS` below.

## Recommendation

`evaluated: accepted` per this session's own gate — ALL of evaluation_complete, effect_positive,
significance_sufficient (deterministic pass/fail, not statistical), no_material_regression,
tests_green, reward_hack_clear (after the critic-driven correction), critic_clear (second pass, this
correction), witness_valid, receipt_reproducible are satisfied. Human review required before merge —
`autoMerge: false` per `dream.config.json`; this session never self-merges or self-promotes.

## 3 next steps

1. `scripts/record-lesson.mjs` never tags its `ruflo memory store` writes with a `trigger:` key, so
   `lesson-bridge.mjs` structurally skips every lesson it records — a real lesson-delivery gap, but one
   that intersects ADR-0066's already-disputed, unresolved provenance-vs-tags entry (2026-08-13).
   Worth a dedicated future night once that dispute has an owner decision, rather than guessing.
2. Consider collapsing the two independent "is this a ship?" regexes into one shared source of truth
   (e.g. `lesson-hooks.sh` shelling out to `node -e "...dependentEvent..."` instead of maintaining a
   parallel grep pattern) — deliberately not done tonight; it's an architectural change (a new
   process-spawn on a latency-sensitive hot path) that deserves its own ADR and measurement, not a
   same-night bundle with a bug fix. Tonight's critic-caught regression is itself evidence for why:
   a whole SECOND parity re-verification round was needed just to keep the duplicated implementations
   honest, which a single shared implementation would not need.
3. The dream-cycle draft-PR backlog keeps growing: 9 open/draft dream-cycle PRs as of tonight (#157,
   #159, #162, #164, #167, #168, #172, #174, #176 — confirmed open+draft via GitHub MCP tonight, `merged`
   field cross-checked per-PR since the list endpoint's `merged` flag is unreliable when a `fields`
   filter is applied), flagged by name in issues #175 and #177 already and reconfirmed here — worth the
   owner's attention independent of this finding. (#160 is open but not draft and not clearly
   dream-cycle-labeled; #169 is an unrelated dependabot PR — both excluded from this count.)
