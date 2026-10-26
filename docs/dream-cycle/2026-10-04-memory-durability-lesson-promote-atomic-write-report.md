# Memory-Durability SOTA Report — 2026-10-04

## TL;DR

`plugin/scripts/lesson-promote.mjs`'s `applyPromotion()` — the function that writes the
cross-project lesson-promotion block into the user's global `~/.claude/CLAUDE.md`, described in
this very file's own header as "the highest blast-radius write this project performs" — commits
that write with a single in-place `fs.writeFileSync(file, next)`, with no temp-file+rename and no
independent read-back verification that the bytes written are the bytes intended. This is the
identical defect class already found and fixed, in this exact file, for this exact file-on-disk:
`bin/install.mjs`'s `offerClaudeMd()` (the OTHER writer of `~/.claude/CLAUDE.md`) was patched to
`tmp = ${p}.ruvnet-tmp; writeFileSync(tmp, next); renameSync(tmp, p)` specifically because "the old
code rewrote the whole file in place, so an interruption (disk full, power loss) could leave a
TRUNCATED CLAUDE.md. Fine 999 times out of 1000 and unforgivable the other time." That fix was
applied to one sibling writer of the file and never migrated to this one.

## What's new

Nothing external — an internal control-flow gap, the same class this repo's own
`degradation-watch.mjs` (`proveMemoryDurable()`, ADR-063) and `bin/install.mjs`'s `offerClaudeMd()`
already treat as settled house discipline, found by reading `lesson-promote.mjs` end to end and
comparing its write path against its own sibling.

## The hypothesis (frozen before implementation)

> Given `applyPromotion()`'s write of the fenced promotion block into the user's global
> `~/.claude/CLAUDE.md`, when the process is interrupted between opening the destination file for
> write and the write completing (disk full, SIGKILL, power loss), the current in-place
> `fs.writeFileSync(file, next)` can leave a truncated or zero-length `CLAUDE.md` on disk with no
> indication of failure beyond the thrown exception already being handled as `ok:false` — but the
> ACTUAL file is already damaged by the time that exception fires, because the destructive write
> targets the real path directly. Routing the write through a temp sibling
> (`${file}.ruvnet-tmp`) and committing via `fs.renameSync` (POSIX atomic within the same directory)
> so that `file` itself is either fully the old content or fully the new content, never a partial
> write, should close this gap — subject to: a successful promotion is byte-identical to today's
> output; the existing backup-first behavior is unchanged; the "write fails, backup still named in
> the log" contract is unchanged; and idempotent re-promotion (replacing only the fenced block)
> still works identically.

Unchanged since freeze.

## Five candidates considered

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `lesson-promote.mjs` `applyPromotion()` non-atomic write to global CLAUDE.md (chosen) | 5 | 4 | 5 | 5 | 5 | 5 | Untouched file this surface never reached before; mirrors an already-reviewed sibling fix (`offerClaudeMd()`); <20 production lines; highest blast-radius write in the repo by its own header |
| 2 | `scripts/reconcile-project.mjs` `reconcileSettings()`/`reconcileMcp()` re-parse-only verification, non-atomic | 3 | 3 | 4 | 3 | 3 | 4 | Real but lower-severity gap (re-parses JSON, catching gross truncation; file is recoverable `.claude/settings.json`/`.mcp.json`, not the global constitution). Deferred — not tonight's candidate, flagged as a fast-follow in Recommendation |
| 3 | `project-progression-reader.mjs` WAL-sidecar vivification | 1 | 1 | 2 | 2 | 1 | 2 | Read in full; already correct — opens `{readOnly:true}` which node:sqlite maps to `SQLITE_OPEN_READONLY`, falls back to `ProgressionReaderUnavailable` on any WAL image it cannot open cleanly. No defect found |
| 4 | `project-progression-store.mjs`/`-sources.mjs`/`continuity-journal.mjs` write paths | 1 | 1 | 2 | 2 | 1 | 2 | Read in full; all do genuine independent read-back + digest comparison after every store write, same discipline as `degradation-watch.mjs`. No defect found |
| 5 | `kb/update-storage-transaction.mjs` | 1 | 1 | 1 | 1 | 1 | 1 | Read in full; thorough digest-verified transactional rename pipeline already. No defect found |

## Evaluation

Not a retrieval-quality candidate — `npm run eval:gate` independently blocked (`no brain at
/root/.cache/ruvnet-brain/kb`, store root never materialized on this container, `stores 0 dark 0`,
unchanged since 2026-08-19). `OPENROUTER_API_KEY` absent tonight too (`LLM_EVAL=blocked`), but
irrelevant: no stage of this candidate needs a model call (a deterministic filesystem-durability
guard, same as every prior memory-durability night).

See Evaluation Receipt in the PR/ledger row for the full TEETH, blast-radius, and regression
results.

## Darwin Results

Not run — a deterministic structural fix (temp-file + atomic rename) with one correct
implementation and a real red→green unit receipt; no continuous parameter to evolve for a boolean
"was this write atomic" property. Same precedent as every prior memory-durability night.

## Competitors — durable-write verification stance (context only, never used to justify the fix)

| System | Stance on atomic/verified writes to a durable artifact | Grade |
|---|---|---|
| OpenHands (Agent SDK) | 2026 SDK docs name durable state management as a foundation requirement; do not document a specific atomic-rename discipline for config/instruction files. | A (arXiv 2511.03690, general framing only) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts — a torn-write class failure is structurally different there, since each version is a new, separately-named artifact rather than an in-place overwrite. | A (official repo) |
| SWE-agent | No public claims on atomic-write discipline for agent-written config/instruction files surfaced tonight. | C |
| Cursor background agents | No public documentation on write-atomicity mechanics surfaced tonight. | C |
| Sakana AI Scientist | No public documentation of an explicit atomic-write discipline for its own artifacts. | C |

No competitor claim justifies the implementation — justification is entirely this repo's own
`bin/install.mjs`'s `offerClaudeMd()` precedent, applied to a second, sibling writer of the exact
same file that had not yet received it.

## Evaluation Receipt (full)

**TEETH, proven to fail first, independently reproduced twice** (once by this session, once by a
fresh independent critic agent): `git stash push -- plugin/scripts/lesson-promote.mjs` (keeping the
3 new test cases), `npx vitest run tests/unit/lesson-promote.test.mjs` against unmodified `main` →
2/19 fail exactly as predicted (`is ATOMIC…` and `ROUND-TRIP PROOF…`; the third new test, "never
leaves a stray `.ruvnet-tmp`", passes vacuously pre-fix since old code never created one — it is a
non-regression check, not a discriminator, and is only meaningful combined with the other two).
`git stash pop` restores the fix: 19/19 pass.

- `npx vitest run tests/unit/lesson-promote.test.mjs`: 19/19 pass post-fix.
- Blast radius: `grep -rln "applyPromotion"` repo-wide → exactly `plugin/scripts/lesson-promote.mjs`
  (definition + its own CLI call site) and `tests/unit/lesson-promote.test.mjs`. The root
  `scripts/lesson-promote.mjs` is a pure re-export shim (`export * from '../plugin/scripts/lesson-promote.mjs'`),
  unaffected. No other caller exists; the return shape (`{ok, backup, promoted, log}`) is unchanged.
- `tests/integration/claude-md-append.test.mjs` (8 tests), `tests/unit/promoted-lessons-survive-update.test.mjs`,
  `tests/unit/promotion-terminates-in-behaviour.test.mjs`: all pass, independently re-run by the
  critic agent too.
- Combined 5-file blast-radius batch (`claude-md-append`, `promoted-lessons-survive-update`,
  `promotion-terminates-in-behaviour`, `console-honesty-regressions`, `capability-registry`): 2
  failed files / 62 passed / 2 skipped of 66 — both failures (`capability-registry.test.mjs`,
  `console-honesty-regressions.test.mjs`) reproduced byte-identically on unmodified `main`
  (`sqlite3` CLI absent in this container, `spawnSync sqlite3 ENOENT` — pre-existing/environmental,
  unrelated to either changed file, confirmed via `git stash`).
- `npx vitest run tests/integration` (full suite): candidate 16 failed files / 40 passed / 5 skipped
  (61 files), 44 failed / 381 passed / 21 skipped / 45 todo (491 tests) — **identical counts** to
  baseline `origin/main`@`085d50f` run cold, same categories (missing global `ruflo` binary, no
  CE-model network cache, pre-existing hook-registration-count assertions). No new failure
  attributable to this change.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every documented night since
  2026-08-19.
- `node scripts/sync-version.mjs --check`: all surfaces agree on 4.5.4.
- `node scripts/doc-currency.mjs --check`: no ADR's `governs:` frontmatter declares either changed
  file (checked every ADR's frontmatter directly, not inferred) — no Currency-log row required.
- `npm run eval:gate`: `EVALUATED=blocked` (`no brain at /root/.cache/ruvnet-brain/kb`, unchanged
  since 2026-08-19) — not this candidate's surface regardless (a filesystem-durability guard, not
  retrieval quality).

## Evidence

OBSERVATION (`bin/install.mjs`'s `offerClaudeMd()` already carries the atomic-rename fix for this
exact file; `lesson-promote.mjs`'s sibling writer does not) → MEASUREMENT (TEETH red→green,
independently reproduced by a second agent, not merely trusted from this session's own claim) →
MEASUREMENT (blast radius: one caller, repo-wide) → MEASUREMENT (`test:integration` byte-identical
baseline vs candidate) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No benchmark, gold-answer, or threshold file touched — `git diff main --stat` touches exactly one
production file and one test file. Not vacuous: both discriminating new tests independently
reproduced red pre-fix, green post-fix, by two separate agents. Blast radius closed (one caller).
The fix can only make a write stricter (refuse to report success on a bad read-back) — it cannot
manufacture a false ACCEPT, since `ok:true` now requires MORE conditions to hold than before, never
fewer.

**Independent adversarial critic** (fresh `general-purpose` agent, not this candidate's author,
working with no access to this session's internal reasoning) — verdict **CLEAR**. It independently
reran the TEETH reproduction itself rather than trusting this session's claim, confirmed the blast
radius via its own grep, and confirmed no benchmark/eval file is touched. It disclosed one honest,
non-blocking residual gap, carried here rather than hidden: if the process is killed in the narrow
window after `writeFileSync(tmp, …)` succeeds but before `renameSync` runs, a stray `.ruvnet-tmp`
sibling can survive — cosmetic (the real file is untouched, which is the actual defect being fixed)
and self-correcting (overwritten on the next run's `writeFileSync(tmp, …)`), not a "never leaves a
stray tmp" guarantee in the fully literal sense. It also noted no `fsync` precedes the rename, so
hardware-level power-loss durability is not absolute — an acknowledged limitation of this pattern
generally (shared with the identical, already-reviewed `offerClaudeMd()` precedent), not a
regression introduced by this candidate.

## Security Review

No new attack surface. `file` is always either the hardcoded `~/.claude/CLAUDE.md` default or a CLI
`--file` argument supplied by the same local user who already has unrestricted filesystem access to
that path — unchanged before and after this diff. The new `.ruvnet-tmp` sibling is written into the
same directory the user already owns. No path traversal, new dependency, network call, or
credential touched. `fs.renameSync` is same-directory (sibling file), so no cross-filesystem
atomicity concern applies.

## Regression Analysis

See Evaluation Receipt (full) above: `test:integration` byte-identical failure counts baseline vs
candidate; targeted blast-radius batch's 2 failures independently reproduced as pre-existing on
unmodified `main`; `lesson-promote.test.mjs` 19/19 pass with zero existing assertions altered (only
3 new `it()` blocks added).

## ADR

None. Confirmed by reading every ADR's frontmatter directly: no ADR's `governs:` field declares
`plugin/scripts/lesson-promote.mjs` or `scripts/lesson-promote.mjs` (ADR-0029, the ADR whose body
discusses this script's PURPOSE, has no `governs:` key at all — `doc-currency.mjs`'s own
`deriveImpl()`/`computeDigest()` treat an empty `governs:` as "nothing to verify against"). This is
a correctness/durability bug fix using an already-reviewed pattern from a sibling file in this same
codebase, not an architectural decision.

## Next steps

1. Port the identical `${file}.ruvnet-tmp` → `writeFileSync` → `renameSync` pattern to
   `scripts/reconcile-project.mjs`'s two JSON writers (deferred candidate #2 above) — same class,
   lower severity, smaller blast radius.
2. The dream-cycle review backlog (44 open draft PRs, zero merged since 2026-08-26, now 36+ days)
   remains the single highest-leverage action available on this repository, independent of any
   candidate quality — flagged again this night, as every night since 2026-08-26.
3. If `lesson-promote.mjs --apply` is ever invoked by two concurrent processes (a scheduled
   nightly promotion plus a manual run), the atomic rename in this fix prevents a torn file but
   does NOT prevent a last-write-wins clobber of one process's content by the other's — unlike
   `lesson-store.mjs`'s `saveLessons`, this file has no lock primitive. Not fixed tonight (would
   exceed a <300-line, one-conceptual-change candidate); named rather than hidden.

## Witness

```
SESSION_COMMIT = 085d50f3d7912414f9d16fe52702e35d65fd88bb
REPORT_HASH    = d35fa7e3eefe5ccf58b2be60d0f0a1ddb3916eba6b25cfeae63d351a00654ef0
WITNESS        = b7a0bf09a01f6b158ccca594c061ff6ce303af325ef326f6aea816a9b2e11441
```

**5-step verifier procedure, reproducible by anyone:**
1. Check out `stuinfla/ruvnet-brain` at commit `085d50f3d7912414f9d16fe52702e35d65fd88bb`.
2. Retrieve this exact report text (committed at `docs/dream-cycle/2026-10-04-memory-durability-report.md`
   on the candidate PR branch) and compute `sha256sum` over it — must equal `REPORT_HASH` above.
3. Concatenate `REPORT_HASH` immediately followed by `SESSION_COMMIT` (no separator) and compute
   `sha256sum` over that string — must equal `WITNESS` above.
4. `git stash push -- plugin/scripts/lesson-promote.mjs` on the candidate branch, then
   `npx vitest run tests/unit/lesson-promote.test.mjs` — must show exactly 2 failing tests
   (`is ATOMIC…`, `ROUND-TRIP PROOF…`); `git stash pop` restores 19/19 green.
5. `grep -rln "applyPromotion" --include="*.mjs" . --exclude-dir=node_modules` — must return exactly
   `plugin/scripts/lesson-promote.mjs` and `tests/unit/lesson-promote.test.mjs`, confirming the
   stated blast radius.
