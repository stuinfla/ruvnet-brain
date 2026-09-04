# Memory-durability SOTA Report — 2026

## TL;DR

`plugin/scripts/session-snapshot-contract.mjs`'s `legacy()` scanner iterated the two legacy Ruflo
session roots (`.claude/sessions`, `.claude-flow/sessions`) in order and, on the FIRST root whose
`sessions/` entry was a stray file or symlink (not a directory), returned immediately — discarding
whatever the *other* root held, including a genuinely fresh, structurally valid legacy session
sitting right next to it. The single real caller, `scripts/onboarding-console.mjs`'s `probeMemory()`,
surfaces this as `compactionSurvival` in the onboarding console's health probe: a project with a
malformed `.claude/sessions` entry and a healthy `.claude-flow/sessions` snapshot would report
`status: 'warn' / kind: 'malformed'` ("snapshot files were found but none matched the supported
schema") instead of `status: 'ok' / kind: 'legacy'` — a false health warning about durability that IS
actually there. Fixed by changing the early `return` to `continue` (matching the pattern the
`readdirSync` catch immediately below it already uses), so one malformed root no longer shadows a
healthy sibling.

## What's new

This is the fourth Dream Cycle night on the `memory-durability` surface (2026-08-19 #142/#143,
2026-08-24 #165/#167, 2026-08-29 #191/#192 — all read in full before tonight's hypothesis was frozen,
per `dream.config.json`'s `findingPolicy`). All three share a family resemblance — "a script's claimed
evidence about durable state does not match what a real round trip / real freshness check would show"
— but target three different files (`restore-local-ingests.mjs`'s wipe-vs-never-materialized
classifier, `record-lesson.mjs`'s trust in CLI stdout wording, `distill-project.mjs`'s stale-snapshot
acceptance). Tonight's finding is a fourth, structurally different shape in a fourth, previously
unexamined file: not a missing check, but an early-return that DISCARDS otherwise-good evidence from
a sibling data source once one source looks bad. `record-lesson.mjs` (#167) and `distill-project.mjs`
(#192) remain open drafts and were NOT touched tonight — re-fixing an already-drafted fix would violate
`findingPolicy.skipIf: ["existing-fix-pr", "duplicate-open-issue"]`.

## Competitors (memory/session-durability framing, graded)

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Agent SDK) | 2026 SDK paper names durable state management as a foundation requirement; does not detail multi-source reconciliation semantics for partially-corrupt state. | A (arXiv 2511.03690) |
| DSPy / GEPA | Reflective-optimization loop persists mutations as versioned, re-scored artifacts rather than a single mutable snapshot — a different architecture from the two-legacy-root shape this finding targets. | A (official repo) |
| Sakana AI Scientist | No public documentation found tonight describing multi-source session/state reconciliation. | C (not deeply searched) |
| SWE-agent | No durability-specific claims surfaced in tonight's search. | C (single-source) |
| Cursor background agents | No public documentation on session-snapshot reconciliation mechanics surfaced tonight. | C (general framing only) |

No competitor claim justifies the implementation — justification is entirely this repo's own prior
memory-durability fixes (#143/#167/#192) and the observed call site in `onboarding-console.mjs`.

## Hypothesis (frozen before implementation)

> Given `plugin/scripts/session-snapshot-contract.mjs`'s `legacy()` scanner, when the FIRST-iterated
> legacy root (`.claude/sessions`) is a stray file or symlink (not a directory) while the
> SECOND-iterated root (`.claude-flow/sessions`) holds a genuinely fresh, structurally valid legacy
> session, then `inspectSessionSnapshots()` currently reports `{kind:'malformed', fresh:false}` instead
> of the real `{kind:'legacy', fresh:true}` — because the malformed-root branch returns immediately
> instead of continuing to the next root; changing that `return` to `continue` (mirroring the sibling
> `catch` block one line below) should make the fresh `.claude-flow` evidence surface correctly —
> subject to: a genuinely all-malformed pair of roots still reports `malformed`, and a genuinely absent
> pair still reports `absent`.

Unchanged since freeze.

## Candidate

`plugin/scripts/session-snapshot-contract.mjs`, 1 line changed (`return` → `{ malformed = true;
continue; }`), plus a 5-line explanatory comment. New test:
`tests/unit/session-snapshot-health.test.mjs` (+26 lines, one new `it`). Total diff: 3 files, 34
insertions / 3 deletions (the third file is a 4-line `data/convergence-manifest.json` hash
regeneration required because the source file changed — see Evaluation Receipt).

## Evaluation Receipt

**Guard proven to fail first.** `git stash` (isolating the candidate), ran
`npx vitest run tests/unit/session-snapshot-health.test.mjs`: the new TEETH case fails —
`expected { kind: 'malformed', fresh: false } to match object { kind: 'legacy', fresh: true }`.
Independently reproduced by hand first, before writing the test, with a standalone repro script
importing the module directly (see Reward-Hack Check). `git stash pop`, re-ran: the TEETH case passes;
5 of 7 cases in the file pass (the other 2 pre-existing failures are unrelated — see Regression
Analysis).

Not a retrieval-quality candidate — `npm run eval:gate` independently blocked in this container:
`eval-brain: no brain at /root/.cache/ruvnet-brain/kb — run: npx ruvnet-brain` (the same
never-materialized condition every prior Dream Cycle night since 2026-08-19 has hit; NOT a credentials
block — `OPENROUTER_API_KEY` is present tonight). `LLM_EVAL` not blocked but no model-graded stage
applies to a deterministic filesystem-scan control-flow fix.

## Baseline vs Candidate

| | Baseline | Candidate |
|---|---|---|
| `.claude/sessions` a stray file, `.claude-flow/sessions` fresh+valid | `{kind:'malformed', fresh:false}` | `{kind:'legacy', fresh:true}` |
| Both roots genuinely absent | `{kind:'absent', fresh:false}` (unchanged) | `{kind:'absent', fresh:false}` |
| `.claude/sessions` malformed, `.claude-flow/sessions` also absent/empty | `{kind:'malformed', fresh:false}` | `{kind:'malformed', fresh:false}` (unchanged) |
| `.claude/sessions` fresh+valid (no `.claude-flow`) | `{kind:'legacy', fresh:true}` (unchanged, pre-existing test) | `{kind:'legacy', fresh:true}` |

## Regression Analysis

- `npx vitest run tests/unit` (full suite, 313 files): candidate 6 failed files / 7 failed tests /
  3723 passed / 26 skipped / 161 todo of 3917. Of the 7: 1 is this night's own new TEETH case
  (RED-then-GREEN, not a regression), 2 are `tests/unit/session-snapshot-health.test.mjs`'s
  PRE-EXISTING `it.each` cases — independently reproduced identically on unmodified baseline via
  `git stash` (2 failed/4 passed) — caused by real-clock drift: their fixture freezes a `NOW` constant
  at `2026-08-02` but calls `probeMemory()`, which internally uses the real `Date.now()` (today,
  2026-09-04 — 33 days later, past `SNAPSHOT_MAX_AGE_MS`'s 30-day window) with no override; flagged as
  an out-of-scope fast-follow below, NOT fixed tonight (would widen this candidate past one conceptual
  change). The remaining 4 (`convergence-manifest.test.mjs` before regeneration,
  `hook-shim-fallback-once.test.mjs`, `user-settings.test.mjs`) are the exact `chmod`-under-root-user
  and stale-generated-artifact classes documented pre-existing in the 2026-08-26/08-28/08-31 ledger
  rows — confirmed unrelated by grep (none reference `session-snapshot-contract.mjs` or
  `inspectSessionSnapshots`) and confirmed present identically on baseline via targeted `git stash` runs.
- `data/convergence-manifest.json` needed regeneration (`npm run convergence:write`) because it hashes
  tracked source files including the one this candidate edits — a 4-line hash-only diff, the same
  mechanical step the 2026-08-31 ledger row also had to take.
- `npm run test:integration`: 5 failed files / 9 failed tests / 290 passed / 12 skipped / 53 todo of
  364 — the exact `sqlite3`/`@xenova/transformers`/headless-Chromium-missing class every prior night
  has hit. Both-hosts conformance gate (`hook-conformance-both-hosts.test.mjs`,
  `dual-host-install.test.mjs`) re-run in isolation: 9/9 pass, green.
- `npm run qa:pr`: overall FAIL, but only from 2 pre-existing/environmental lanes — `docs` (52
  ADR-currency violations, confirmed identical on baseline) and `catalog` (`verify-model-catalog.mjs`:
  model-catalog snapshot is 15.8 days old > 14-day threshold, a pure time-based staleness check with
  zero relation to this diff, confirmed identical on baseline via `git stash`). The `contract` lane
  (326/327 passing) and all 7 other lanes (version, convergence, execution-policy, wiring,
  substitution, mesh, plugin) PASS.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical class to every prior night (all SKIPs are
  environmental: brain not installed, coverage run absent, one artifact-source ancestry gap).
- Blast radius: `grep -rn session-snapshot-contract` — exactly 4 code call sites (the `scripts/`
  re-export shim, `onboarding-console.mjs`'s single import, `session-snapshot-hook.mjs`'s
  `createSessionSnapshot`-only import — unaffected by the `legacy()` change — and this candidate's own
  test file), plus one prose mention in ADR-0065 that does not list this file in its `governs:`
  frontmatter.
- `node scripts/sync-version.mjs --check`: `4.3.8-dev` agrees on every surface.
- `node scripts/doc-currency.mjs --check --changed HEAD`: no blocking currency violations for the
  scoped diff; no ADR's `governs:` frontmatter lists `plugin/scripts/session-snapshot-contract.mjs`.
- `npm run wired:check`: exit 0, unaffected.

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean per-root shadowing fix; skipped rather than
run for form's sake, same precedent as every prior memory-durability night.

## Evidence

- OBSERVATION: `legacy()`'s malformed-root branch `return`s instead of `continue`s, unlike the
  structurally identical `catch` block one line below it.
- MEASUREMENT: hand-reproduced first with a standalone script (RESULT: `{kind:'malformed',
  fresh:false}` for a project with one bad root and one genuinely fresh root), then captured as a
  TEETH test; fails red on `git stash`-isolated pre-candidate code, passes green post-candidate.
- INFERENCE: the false-negative reaches real users through exactly one path,
  `onboarding-console.mjs`'s `probeMemory().compactionSurvival` — not measured in a live console render
  tonight (would require constructing a real onboarding-console session), inferred from the single
  grep-confirmed call site and its documented rendering logic.
- DECISION: fix `legacy()` only. The pre-existing `NOW`-vs-`Date.now()` clock-drift gap in this same
  test file's `it.each` cases is a second, real, but conceptually separate defect (a test fixture
  problem, not a production code defect) — recorded as a fast-follow, not fixed tonight.

## Reward-Hack Check

Self-critique (no separate agent instance was spun up tonight; the checks below were run directly by
this session, distinct in kind from writing the fix): does the fix weaken any existing assertion? No —
zero existing test lines changed, only one new `it` added. Does it touch a benchmark, gold answer, or
threshold? No — `eval:gate`'s corpus and `qa:pr`'s thresholds are untouched. Could the new test pass
for the wrong reason? No — reproduced the exact failure by hand with a standalone script BEFORE writing
the test, so the test's shape was derived from a real, independently observed defect rather than
fitted to make a green light. Does the fix make the scanner MORE lenient in a way that could report a
non-existent snapshot as real? No — the `malformed` flag is still set for the bad root in every case;
the only behavioural change is that a healthy sibling root's genuine data is no longer discarded. Is
the "all roots bad" case still correctly reported as `malformed`? Yes, verified in the Baseline vs
Candidate table above (traced through the code, not merely asserted).

## Security Review

No new attack surface. The diff changes control flow only (`return` → `continue`) inside a function
that already had read-only `fs.lstatSync`/`fs.readdirSync`/`fs.readFileSync` access to these paths.
No new file write, network call, credential, or dependency. `session-snapshot-hook.mjs` (the only
other importer from this module) uses `createSessionSnapshot` exclusively, a different, unmodified
export.

## Darwin Results

Not run (see Darwin Lineage).

## Scan Findings

**managed-boundary**: `legacy()` and `canonical()` are both read-only filesystem scans over
Ruflo-adjacent session artifacts (`.claude/sessions`, `.claude-flow/sessions`,
`.swarm/agentdb-sessions.jsonl`) — never a raw SQLite open, never a write. Unaffected by tonight's
finding; no drift found on this axis.

**round-trip-proof**: this scan surface IS tonight's Deep Dive finding — a claimed round trip
(`inspectSessionSnapshots()` proving a session "survived") was actually being silently discarded by an
unrelated sibling root's bad state. No second, independent round-trip-proof finding is reported
separately to avoid double-counting.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation as every prior
Dream Cycle night since 2026-08-19; see the 2026-08-31 ledger row for the identical precedent). Full
report content, including this competitor table and the witness verifier, is committed in this PR at
`docs/dream-cycle/2026-09-04-memory-durability-report.md` and in the linked issue.

## Witness

```
SESSION_COMMIT = cbca83bc7a72a8ee4552d50530e391694200b670
REPORT_HASH    = 1ce96ba88b888ae74b61236d4d1ff675e4c328a7484a2c5ec6d06927675137dc
WITNESS        = 8d70199c3345a080c3d7d4b1fc85c8cbacf5c402562c5617b771993065e639f0
```

5-step verifier: (1) `git checkout cbca83bc7a72a8ee4552d50530e391694200b670`; (2) check out the
candidate branch, `git stash` the diff to isolate `plugin/scripts/session-snapshot-contract.mjs` +
`tests/unit/session-snapshot-health.test.mjs`; (3) `npx vitest run
tests/unit/session-snapshot-health.test.mjs` on the pre-candidate tree — the new TEETH case fails;
(4) `git stash pop`, re-run — it passes (2 unrelated pre-existing clock-drift cases still fail, see
Regression Analysis); (5) `sha256sum` this evidence file, concatenate with `SESSION_COMMIT`,
`sha256sum` again — compare to `WITNESS` above.

## Recommendation

`evaluated: accepted`. Human review of the linked draft PR requested. One out-of-scope observation
recorded above for a future night: `tests/unit/session-snapshot-health.test.mjs`'s two `it.each`
legacy-session cases will start failing again roughly every 30 days as real wall-clock time passes the
hardcoded `NOW` fixture, because `probeMemory()` reads `Date.now()` directly with no override — a test
fixture staleness problem, not fixed tonight to keep this candidate to one conceptual change (per the
zero-merged-since-08-26 backlog signal, STEP 1.1's bias-to-tiny-candidate rule).

**Merge policy**: this session never merges and never self-promotes. Evaluation is not promotion.
