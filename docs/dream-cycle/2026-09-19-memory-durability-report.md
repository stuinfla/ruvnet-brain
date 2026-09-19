# Memory-Durability SOTA Report — 2026

**Dream Cycle 2026-09-19 · DEEP=memory-durability · SCAN=managed-boundary,round-trip-proof · SLOT=4**
**Repo:** `stuinfla/ruvnet-brain` · **Session commit (base):** `7d512b9f7ae572e305c1bbb930e304eb2f663890`
**Candidate branch base:** `dream/2026-09-18-memory-durability` @ `b6f0178` (PR #296, unmerged — see Rotation/Reconciliation)

## TL;DR

Last night's memory-durability run (PR #296, still open/draft) fixed `scripts/onboarding-console.mjs`'s
`sessionHookExists()` so it no longer scores ANY `~/.claude/hooks` directory as proof of the recall
hook — only the specific `agentdb-ensure.sh` file counts. Its own independent critic flagged, but
deliberately did not chase, an adjacent gap: even the fixed check recognizes only that one LEGACY
global hook and never the mechanism this repository itself ships and documents as the *current,
automatic* one — `plugin/hooks/hooks.json`'s own `SessionStart` entry, wired through
`session-start-core.mjs` to `project-progression-session-start.mjs`, which runs for every session on
any machine that has the `ruvnet-brain` plugin enabled at all, independent of whether that legacy
shell hook was ever separately installed. A machine that installed this repo the current, documented
way (Claude Code's marketplace plugin flow) and never additionally placed `agentdb-ensure.sh` scores
`sessionSurfacing: warn — no SessionStart recall hook found`, a false negative, even though project
continuity IS being restored automatically. Tonight's candidate credits that second, real mechanism,
using the exact same `ruvnet-brain@<marketplace>` enabled-plugin detection this codebase already uses
elsewhere (`capability-registry.mjs`'s `wiredForRoute()`) for the identical question, rather than
inventing a new way to ask it.

## What's new

Nothing external — this is a second layer of the same internal diagnostic-accuracy gap PR #296
started fixing last night, found by following up on that PR's own independent critic's disclosed
"scope question for a future night."

- `scripts/onboarding-console.mjs`: `sessionHookExists()` now returns which mechanism (if any)
  actually accounts for SessionStart recall — `'agentdb-ensure'`, `'ruvnet-brain-plugin'`, or `null`
  — instead of a bare boolean. A new `pluginEnabled()` helper (4 lines, mirrors
  `capability-registry.mjs:266-267`'s existing pattern verbatim) checks `~/.claude/settings.json`'s
  `enabledPlugins` for a `ruvnet-brain@*` key set `true`. `probeMemory()`'s `sessionSurfacing` probe
  reports `ok` for either mechanism, with an accurate per-mechanism `detail` string and a new `via`
  field so a reader (or a future test) can tell which one fired. 1 production file, +16/-3 lines on
  top of PR #296's base.
- `tests/unit/console-session-surfacing-hook-check.test.mjs`: extended PR #296's 3-case file with 5
  new cases (8 total) — plugin enabled with no legacy hook (now `ok`), a different plugin enabled
  (still not `ok`), `ruvnet-brain` present but `false` (still not `ok`), no settings file at all
  (still not `ok`, unchanged baseline behavior), and both mechanisms present at once (legacy hook
  wins the `via` label, both still `ok`).

## Five candidates considered (this session's own architecture review)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod-value | Reviewability |
|---|---|---|---|---|---|---|---|
| **1 (selected)** | `sessionHookExists()` never credits the plugin's own wired `SessionStart` → `project-progression-session-start.mjs` continuity path — only the legacy standalone hook file, producing a false `warn` for the now-primary install path | 5 | 4 | 5 | 5 | 4 | 5 |
| 2 | ADR-0087 (citation-rank hijacking, grounding-quality) — re-raised 3 nights running per the 2026-09-18 ledger row with no new evidence; STEP 1.1's rotation rule explicitly moves off a surface repeated ≥3 nights, and it is off tonight's DEEP anyway (rotation landed on memory-durability again via SLOT=4) | 2 | 1 | 3 | 3 | 3 | 3 |
| 3 | `restore-local-ingests.mjs` exit 2 on this container (125 recorded ingests never materialized here) — already correctly self-diagnosed by PR #143 (2026-08-19) as "NOT evidence of a wipe" for exactly this fresh-checkout shape; not a defect, a correct report, re-confirmed tonight in STEP 0.5 | 3 | 1 | 2 | 2 | 1 | 3 |
| 4 | 19-night-old, 20+-PR-deep unmerged dream-cycle backlog (first flagged 2026-08-26, still growing per PR #296) — real, but outside this session's authority (`autoMerge: false`, ADR-068); a finding, not a candidate for a diff | 3 | 1 | 1 | 2 | 1 | 1 |
| 5 | `console-memory-canonical-store.test.mjs`'s 4/6 `sqlite3`-CLI-absent failures on this container — confirmed pre-existing/environmental across every night since 2026-08-19 (see Evaluation Receipt); not a code defect, an unavailable dependency in this sandbox | 2 | 1 | 1 | 1 | 1 | 2 |

**Selection: #1.** Directly on tonight's SCAN surface (`managed-boundary`: is the probe checking the
*actual* managed recall boundary, or a stale proxy for it?), a genuinely new, non-duplicate finding
relative to PR #296 (which fixed a different specific defect in the same 2-line function), bounded,
and immediately testable with a red→green TEETH proof. #2–#5 are real, previously logged conditions,
correctly not rediscovered as new findings tonight (ISSUE DISPOSITION OVERRIDE: reconciled against
current source and existing PRs/ledger rows before selecting).

## Rotation / Reconciliation note

`dream.config.json`'s slot map put tonight back on `DEEP=memory-durability` (`DAYINT % 5 == 4`) —
the same surface as last night (2026-09-18, PR #296) and as 2026-09-14/2026-09-09. PR #296 is open,
draft, unmerged as of this run. Its fix to the same function is real and independently verified (not
merely re-read): this session reproduced its own TEETH claim on the unmodified pre-#296 code via
`git stash`. Rather than branch from `main` (which still carries the pre-#296 defect) and produce a
diff that would either silently re-fix or conflict with #296's own lines, this candidate branches
from `dream/2026-09-18-memory-durability` @ `b6f0178` directly — the established pattern for this
exact situation (see the 2026-08-28 ledger row: "rebased onto #186's tip"). Baseline for tonight's
own TEETH proof and regression diffing is therefore PR #296's tip, not raw `origin/main`; that
distinction is carried through every evaluation number below.

## Hypothesis (frozen before implementation)

> Given `scripts/onboarding-console.mjs`'s `sessionHookExists()` (post-PR-#296: checks only
> `~/.claude/hooks/agentdb-ensure.sh`), when a machine has the `ruvnet-brain` plugin enabled in
> `~/.claude/settings.json`'s `enabledPlugins` (a `ruvnet-brain@<marketplace>` key set `true`) — which
> per `plugin/hooks/hooks.json`'s own `SessionStart` registration wires an automatic
> `project-progression-session-start.mjs` continuity restoration for every session — but lacks the
> legacy `agentdb-ensure.sh` file, then `sessionSurfacing` currently reports `warn: no SessionStart
> recall hook found`, a false negative; crediting an enabled `ruvnet-brain` plugin as a second valid
> mechanism (via the same `k.startsWith('ruvnet-brain@') && v === true` pattern already used in
> `capability-registry.mjs`) should make `sessionSurfacing` correctly report `ok` in that scenario,
> subject to: the already-correct legacy-hook case is unaffected; a different, unrelated plugin being
> enabled does not trigger a false `ok`; and no settings file at all still correctly warns.

Unchanged since freeze.

## Competitors — "is a capability probe checking the real mechanism or a stale proxy for it" (as documented; none used to justify the fix)

| System | Stance on capability/health probes tracking the CURRENT wiring rather than a legacy proxy | Grade |
|---|---|---|
| OpenHands (Agent SDK) | 2026 docs describe a runtime capability registry queried live at session/tool-call time; does not document a documented historical case of a stale-proxy health check specifically. | B (official docs, general framing only) |
| Sakana AI Scientist | Publishes reproducibility/experiment-tracking claims tied to run manifests generated at execution time, not to static installation markers — structurally avoids this exact failure mode by construction, not by a fix. | B (official repo/paper, general framing) |
| DSPy / GEPA | Module/program state is introspected live via the compiled program graph; no separate "is this feature installed" proxy layer exists to go stale. | B (official docs) |
| Cursor background agents | 2026 changelog documents background-agent status surfaced from live orchestrator state, not from a local installation-marker file. | C (vendor changelog, single-source) |

None of these are architecturally comparable enough to justify the fix on their own; they are noted
per STEP 3's discipline, not relied upon. This is an internal control-flow/diagnostic-accuracy defect
found by reading this repo's own code and its own prior night's critic note, not derived from any of
the above.

## Testability gate

Testable tonight: yes. A concrete candidate diff exists (see What's new); the committed benchmark
corpus is not applicable (this is a diagnostic-probe fix, not a retrieval-quality change) — see
Benchmarks/Evaluation below for why `npm run eval:gate` is out of scope, not merely blocked.

## Benchmarks / Evaluation

Not a retrieval-quality candidate. `npm run eval:gate`: **not applicable** (out of scope by kind — a
console diagnostic fix, same classification PR #296 used for the same reason) and independently
**blocked** anyway in this container: `eval-brain: no brain at /root/.cache/ruvnet-brain/kb` (store
root never materialized here, every night since 2026-08-19, confirmed again tonight via
`restore-local-ingests.mjs` exit 2 / `brain-score.mjs` coverage UNMEASURED / `store-root.mjs` `stores
0 dark 0` — none of this is evidence of a wipe, per PR #143's own established discipline, reconfirmed
tonight, not rediscovered). `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY`/model-provider credential
present in this container tonight; no model-graded stage was attempted or needed for a deterministic
scripting fix.

**Guard proven to fail first (TEETH).** `tests/unit/console-session-surfacing-hook-check.test.mjs`,
run against PR #296's unmodified tip (`b6f0178`, via `git stash push -- scripts/onboarding-console.mjs`):
3/8 fail — `pluginEnabled` scenario returns `warn` where `ok` is expected (false negative reproduced
exactly as hypothesized), and the `.via` field is `undefined` (the pre-candidate function still
returns a bare boolean). After the fix: 8/8 pass. Independently reproduced by a fresh adversarial
critic agent (see Reward-Hack Check) via the identical stash/run/pop sequence, not merely re-run of
this session's own claim.

- `npm run version:check`: `[version] all surfaces agree on 4.3.26` ✓
- `npm run wired:check`: exit 0, all TEETH/wiring checks pass, unaffected (this function is outside
  the hook-dispatch table — it reads hook presence for a health card, never registers or invokes one).
- `node scripts/doc-currency.mjs --check --changed HEAD`: 0 documents in scope, 0 blocking violations.
  (`docs/adr/0032-capability-surface.md` quotes this function's ORIGINAL pre-#296 code as a historical
  case study — "a green light wired to a wall" — illustrating the diagnosis that led to both PR #296's
  fix and, structurally, tonight's: ADR-0032 already called for "the strength of the derivation must
  be visible," which the new `via` field now provides. That ADR is a decision record about the past
  finding, not a live spec `doc-currency` requires updating for a further fix to the same function —
  confirmed by the tool itself reporting 0 governing documents, not asserted.)
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior night since
  2026-08-19.
- `npx vitest run tests/unit/console-wiring-plugins.test.mjs tests/unit/console-honest-cards.test.mjs
  tests/unit/console-honesty-regressions.test.mjs tests/unit/console-gates-registered.test.mjs
  scripts/console-engine.test.mjs tests/unit/console-memory-canonical-store.test.mjs`: 39 passed / 2
  skipped / 4 failed. All 4 failures are `console-memory-canonical-store.test.mjs`'s pre-existing
  `sqlite3`-CLI-absence cases (`which sqlite3` exits 1 in this container) — unrelated to the changed
  function, confirmed by that test file never importing `sessionHookExists`/`sessionSurfacing`, and
  matching the exact 4/6-fail shape PR #296 itself documented for the identical, pre-existing cause.
- `npx vitest run tests/integration`: **9 failed files / 23 failed tests / 309 passed / 15 skipped /
  53 todo of 400, byte-identical baseline vs candidate** (diffed the full sorted `FAIL` line list;
  `diff` reports 0 lines of difference). Baseline = PR #296's tip, re-run fresh tonight rather than
  assumed from last night's report, since this container's failure count (9/23) is larger than the
  5/9 prior nights documented — worth flagging honestly rather than silently reusing a stale number.
  Root causes, spot-checked: `ruflo` global binary absent (`project-progression-*` suite — "global
  Ruflo is required; this integration must not vacuously skip"), `@xenova/transformers` cross-encoder
  model requiring a network fetch this container's proxy does not permit for that host
  (`reader-deadlock-regression`), and several `health-repair`/`anticipate`/`console-apply-timings`
  cases with the same environmental shape. None reference `sessionHookExists`, `sessionSurfacing`, or
  `onboarding-console.mjs`'s memory-health probes at all (grep-confirmed against the full failing-test
  list). This is a genuinely larger environmental gap than prior nights' containers had, not a
  regression from tonight's 19-line diff — recorded here rather than smoothed over.
- `npm run qa:pr`: aggregate `FAIL` — `{"lanes":[{"version":"PASS"},{"convergence":"PASS"},
  {"execution-policy":"PASS"},{"architecture":"PASS"},{"docs":"FAIL"},{"wiring":"FAIL"},
  {"substitution":"PASS"},{"catalog":"FAIL"},{"coverage":"TIMEOUT"},{"claims-source":"BLOCKED"},
  {"mesh":"PASS"},{"plugin":"PASS"}]}`. `convergence` was made to PASS tonight by running
  `npm run convergence:write` after adding the report/test files (the same fast-follow PR #296
  needed for the identical reason — a new file changes tracked source identity). Every remaining
  `FAIL`/`TIMEOUT`/`BLOCKED` lane was independently verified pre-existing and unrelated to this
  diff, not assumed:
  - `wiring` (`wired-check.mjs --check`, exit 1): both failing lines
    (`scripts/oracle/source-tree.mjs`, `scripts/oracle/unit-inventory.mjs` — "built, and invoked by
    nothing") reproduce byte-identically on PR #296's unmodified tip, checked in an isolated
    `git worktree` (not merely re-read) rather than assumed from last night's green wired:check
    receipt. Neither file is in the changed set.
  - `docs` (`doc-currency.mjs --check --warn-drift`, the whole-repo drift scan qa:pr runs — a
    different invocation than the `--changed HEAD` one in this report's own gate list above):
    dozens of `stamp-lags-doc` findings, every one dated to commit `1728a339` (2026-09-14) editing
    many ADRs in bulk without updating their `updated:` stamps — a standing condition the
    2026-08-31 ledger row already documented ("docs lane's 52 violations reproduced identically on
    baseline (pre-existing)"), not introduced tonight and not touching any file this candidate
    changed.
  - `catalog` (`verify-model-catalog.mjs`): `STALE: source pulled 2026-09-04T11:03:44.205Z (14.9d
    old > 14d)` — a time-based external-data freshness check that degrades daily regardless of any
    candidate; requires a live model-catalog refresh, out of scope for a memory-durability
    diagnostic fix.
  - `coverage` (`vitest run tests/unit --coverage`): TIMEOUT under qa-runner's per-lane budget in
    this container (the same full-suite run this report's targeted-suite section above completed
    in 15s covers the changed files directly; the full-repo coverage instrumentation pass is
    markedly slower and did not finish inside qa-runner's window).
  - `claims-source`: `BLOCKED`, `dependsOn: ['coverage']` in `scripts/qa-lanes.mjs` — a structural
    consequence of the coverage timeout above, not an independent failure.

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete "which mechanism, if any, satisfies this
probe" check; same precedent as every prior memory-durability night (record-lesson round-trip,
sessionHookExists itself in PR #296).

## Evidence

OBSERVATION (`sessionHookExists()` post-#296 still recognizes only the legacy global hook file) →
MEASUREMENT (repo-wide grep + direct read confirms `plugin/hooks/hooks.json` → `hook-shim.mjs` →
`session-start-core.mjs` → `project-progression-session-start.mjs` is a real, wired, always-on
mechanism for any machine with the plugin enabled, independently verified by the adversarial critic)
→ DECISION (credit an enabled `ruvnet-brain` plugin as a second valid `sessionSurfacing: ok` path,
reusing the codebase's own existing `ruvnet-brain@*` detection pattern rather than inventing one) →
MEASUREMENT (new TEETH test 3/8 red on PR #296's tip, 8/8 green post-candidate, independently
reproduced by the critic; `test:integration` byte-identical baseline vs candidate; targeted console
suites unaffected save pre-existing `sqlite3`-absence failures).

## Reward-Hack Check

No benchmark, gold answer, scoring weight, or threshold touched — confirmed via `git status
--porcelain`: only `scripts/onboarding-console.mjs` and the one test file changed. The fix strictly
ADDS a second, independently-real path to `ok`; it does not weaken, remove, or narrow the existing
`agentdb-ensure.sh` check (still tested, still wins the `via` label when both are present) or the
`warn` case (still correctly `warn` for a different plugin enabled, `ruvnet-brain` present-but-false,
or no settings file at all — all 4 of those negative cases are explicitly tested).

**Independent adversarial critic** (fresh `general-purpose` agent, not this candidate's author) —
verdict **CLEAR**. Independently verified, by direct file reads (not by trusting this session's
claims): (1) the full hooks.json → hook-shim → session-start-core → project-progression-session-start
dispatch chain is real, quoting exact file:line evidence; (2) the `ruvnet-brain@` prefix pattern is
not invented ad hoc — verbatim-matches `capability-registry.mjs:266-267`'s existing use for the
identical question, and the key shape matches this codebase's own existing test fixture
(`console-wiring-plugins.test.mjs`'s `'ruvnet-brain@ruvnet-brain': true`); (3) flagged a real but
bounded and already-disclosed false-positive risk — `pluginEnabled()` proves settings-file intent, not
that Claude Code actually loaded the plugin or that the hook fired, explicitly the same evidentiary
tier as the pre-existing `agentdb-ensure.sh` file-existence check (also only proves a file exists, not
that it runs), consistent with this whole probe family's documented "inferred, proxy could be wrong"
design (ADR-0032); (4) confirmed no benchmark/gold/threshold file touched; (5) confirmed exactly one
call site for `sessionHookExists()` repo-wide; (6) confirmed no new file/network/env access — same
`readJSON()` helper, same local trust boundary already used elsewhere in this file; (7) independently
reproduced the TEETH red→green cycle itself via `git stash`/pop, not merely re-running this session's
own claim; (8) confirmed no reward-hacking, cherry-picking, or narrowing of any existing passing
check. Non-blocking observation carried forward: a stronger future probe could check Claude Code's
actual loaded-plugin runtime state rather than settings.json intent, if false positives from a failed
plugin load ever become a real-world issue — same accepted caveat ADR-0032 already applies to the
legacy check, not a regression introduced tonight.

## Security Review

No new attack surface. `pluginEnabled()` performs one additional read of `~/.claude/settings.json` —
a local, non-attacker-controlled file already read by this same file's `wiringSurvey()` (line 431) for
an equivalent trust boundary — via the existing `readJSON()` helper, which fails closed to `null` on
any parse error (verified: the "no settings file at all" test passes cleanly, no crash). No new
network access, no new write path, no new external input. `sessionHookExists()` remains outside the
actual hook-dispatch table (`npm run wired:check` confirms); it reports on hook presence for a
diagnostic health card, it does not register or invoke anything.

## Regression Analysis

Blast radius (repo-wide grep): `sessionHookExists()` has exactly one call site,
`scripts/onboarding-console.mjs`'s `probeMemory()`. See Evaluation Receipt for the full
pre-existing-failure classification on `test:integration` (byte-identical baseline vs candidate) and
the targeted console-suite run (4 pre-existing `sqlite3`-absence failures, unrelated to the changed
function).

## ADR

None — a diagnostic probe's false-negative fix, not an architectural decision. Same classification as
PR #296's fix to the same function the night before.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation every Dream
Cycle night since 2026-08-19). Full report committed at
`docs/dream-cycle/2026-09-19-memory-durability-report.md`.

## Issue

NONE — new finding, reproduced, fixed and TEETH-proven within this session, independently critiqued.
Per this repo's ISSUE DISPOSITION OVERRIDE, a verified integrated fix (candidate committed, tested,
pushed, draft PR opened) is a work record, not a tracking issue.

## Witness

```
SESSION_COMMIT = 7d512b9f7ae572e305c1bbb930e304eb2f663890
REPORT_HASH    = bcca7ffd3e0f077beba156ba0cb2184b99013e2c9cfa53e4d3c8c449bd3e45de
WITNESS        = 9159efe734891e321c5eef7e930b7a973771b6b136f3f0b8cf41d633a0af31eb
```

(`REPORT_HASH` is the sha256 of this report as it stood immediately before this Witness section was
filled in — the same one-step-removed self-reference every prior Dream Cycle report in this ledger
uses, since a file's hash cannot include its own final bytes. Step 2 of the verifier procedure above
reproduces it against the pre-witness content, not the file as currently committed.)

**5-step verifier procedure (anyone can reproduce):**
1. `git clone` the repo, `git fetch origin dream/2026-09-19-memory-durability`, checkout that branch.
2. `sha256sum docs/dream-cycle/2026-09-19-memory-durability-report.md` — must equal `REPORT_HASH`
   above.
3. `printf '%s%s' <REPORT_HASH> <SESSION_COMMIT> | sha256sum` — must equal `WITNESS` above.
4. `git stash push -- scripts/onboarding-console.mjs && npx vitest run
   tests/unit/console-session-surfacing-hook-check.test.mjs` — expect 3 failures. `git stash pop` and
   re-run — expect 8/8 pass.
5. `npx vitest run tests/integration` and diff the sorted `FAIL` lines against
   `/tmp/baseline-failures.txt`/`/tmp/candidate-failures.txt` referenced in this report's Evaluation
   Receipt — expect zero differences.

## Backlog note (not this PR's finding, carried forward for the owner)

At least 19 `dream/*` draft PRs remain open and unmerged spanning 2026-09-08 through 2026-09-18
(#269, #270, #275, #276, #278, #280, #281, #282, #287, #288, #289, #291, #292, #293, #294, #295, #296,
plus older ones flagged since 2026-08-26), on top of the standing backlog first flagged 2026-08-26 and
reconfirmed by PR #296 last night. `ADR-0087` (citation-rank hijacking, grounding-quality surface)
remains `Proposed` per the 2026-09-18 ledger row. Outside this session's authority to resolve
(`autoMerge: false` is deliberate, ADR-068) — flagged again for the owner's review queue, not chased.

## Merge Policy

**Human review required.** This session never self-merges and never autonomously promotes candidate
state. Draft, by design.
