# Memory Durability SOTA Report — 2026

## TL;DR

`plugin/scripts/continuation-gate.mjs`'s `save()` — the write path for the work-ledger this gate
forces a Stop on — wrote the ledger with a bare `fs.writeFileSync(LEDGER, ...)`. `writeFileSync`
opens with `O_TRUNC`: it truncates the destination to zero bytes before writing a single byte of the
new content. This gate fires on every Stop event in every session on this host, so a process killed
in that window (the harness's own per-hook kill, `ENOSPC`, `EIO`) is not a rare event — and the
result is a silently emptied ledger: `load()`'s catch-all `JSON.parse` failure then reads the empty
file as "nothing was ever committed," discarding every item a prior turn agreed to do, not just the
one being added. Fixed by routing the write through `writeAtomic` (`plugin/scripts/user-settings.mjs`)
— the same temp-file + fsync + rename primitive this surface has now applied to six prior files
(`md-stamp.mjs`, `lesson-promote.mjs`, `project-progression-reader.mjs`,
`project-progression-outbox.mjs`, `agentdb-fleet-doctor.mjs`, `decision-recall-gate.mjs`) — reused,
not reimplemented, per this repo's own `never-hand-roll-what-ruv-already-ships` invariant.

## What's new

Nothing novel in the literature; this is an internal durability defect in a file literally named
`LEDGER`, found by auditing every `fs.writeFileSync` call site in `plugin/scripts/` against the
"durable cross-session state, no temp+rename" shape that six prior nights on this surface have each
found in a different file. `continuation-gate.mjs`'s `save()` was the only remaining untested,
unmigrated instance of that shape writing to a file this ADR (`docs/adr/0055`) explicitly governs.

## Competitors / prior art (grade B/C — single-repo, cross-checked against this repo's own six prior
fixes of the identical shape, not external literature)

| Approach | Crash-safety | Notes |
|---|---|---|
| `fs.writeFileSync(file, …)` (the removed code) | None — truncate-then-write | What every one of the seven fixed files in this family used before its fix |
| temp-file + `rename()` (POSIX atomic rename), no fsync | Survives process kill, not power loss | Common idiom; missing the fsync step this repo's `writeAtomic` adds |
| `writeAtomic` (`user-settings.mjs`, this repo) — temp + fsync + rename, `0o600`, pid+timestamp temp name | Survives process kill AND reasonable power-loss (fsync before rename) | Reused by `grounding-turn-mark.mjs`, `onboarding-console.mjs`, `install-scope.mjs`; now also `continuation-gate.mjs` |
| SQLite/WAL-backed ledger | Strongest (full ACID) | Not adopted — would be a architectural change for a single-field advisory ledger; out of proportion to the defect |

## Hypothesis (frozen before implementation)

> Given the work-ledger already holds one open commitment, when `save()` is called again to add a
> second commitment and the write is interrupted after the destination has been truncated but before
> the new content is fully written (a crash, `ENOSPC`, `kill -9`), then the pre-existing commitment is
> destroyed (the file reads back empty or unparsable), even though the gate must still never throw or
> block a turn over its own ledger I/O.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate`: `EVALUATED=blocked` (`no brain at
/root/.cache/ruvnet-brain/kb`, container never materializes a corpus, unchanged since 2026-08-19).
`LLM_EVAL=blocked` — no model-provider API key present in this container's environment; no stage in
this candidate needs a model call regardless.

- **TEETH, independently reproduced via `git stash`** (new file
  `tests/unit/continuation-gate-ledger-write-safety.test.mjs`, 3 cases): stashing only
  `plugin/scripts/continuation-gate.mjs` and re-running against unmodified `main` fails exactly the
  predicted case (`save() calls the shared writeAtomic, not a bare fs.writeFileSync` —
  `expected … to match /writeAtomic\(LEDGER/` against the literal `fs.writeFileSync(LEDGER, …)` on
  `main`); popping the stash restores 3/3 green. The other two cases (a real SIGKILL-timing
  reproduction of the truncate-vs-atomic-rename mechanism, driven through a disposable child process)
  are strategy-selected by the test itself, not gated on the stash, and demonstrate the general
  mechanism directly: a `kill -9` landed mid-write destroys the prior ledger content under the removed
  write strategy and leaves it completely untouched under the shipped `writeAtomic` strategy.
- **Blast radius**: `grep -rn "from ['\"].*continuation-gate\.mjs['\"]"` across the whole repo —
  zero matches. Nothing imports this file as a module; it is invoked only as a spawned CLI (via
  `hook-shim.mjs`/`hook-registry.mjs`), so the change is contained entirely to `save()`'s body plus a
  new dependency on the already-shared, already-used-three-times-elsewhere `writeAtomic` export.
- **Targeted batch** (`continuation-gate*.test.mjs`, `continuation-objective.test.mjs`,
  `continuation-commitment-ownership.test.mjs`, `user-settings*.test.mjs`, plus the new file): **218
  passed / 1 pre-existing failed / 0 skipped** (counting the new file's 3). The 1 failure
  (`user-settings.test.mjs > refuses to write when the backup cannot be taken`) reproduced
  byte-identical on unmodified `main` via the same `git stash` procedure — this container runs as
  root, so a `chmod`-based read-only fixture does not enforce; the exact, already-documented
  container artifact noted in multiple prior nights' ledger rows.
- **`npx vitest run tests/integration`** (full suite, true baseline-vs-candidate, JSON reporter
  diffed programmatically, not by eye): baseline (pre-candidate `continuation-gate.mjs` restored from
  `origin/main`) = 335 passed / 22 failed / 18 pending across 9 failing files, of 420 total. Candidate
  = 334 passed / 23 failed / 18 pending across 10 failing files, of 420 total — one extra failing file,
  `advocacy-dial-levels.test.mjs`, with zero blast-radius connection to either changed file
  (`continuation-gate.mjs`, `user-settings.mjs`). Re-ran it in isolation on the candidate twice: **7/7
  pass both times**, confirming it is a resource-contention flake from running the full 420-test suite
  concurrently with other validation jobs on this container, not a regression. The other 9 failing
  files are byte-identical between baseline and candidate (`anticipate-dial`, `anticipate`,
  `changed-memory-process-probes`, `console-apply-timings`, `corpus-auto-update-e2e`, `health-repair`,
  `managed-cli-server-boundary`, `model-managed-checker-native`, `reader-deadlock-regression` — all
  pre-existing environmental gaps, matching the exact set documented in the 2026-10-14 ledger row).
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior documented night.
- `node scripts/sync-version.mjs --check`: all surfaces agree on 4.7.14.
- `npm run wired:check`: exit 0.
- `node scripts/convergence-manifest.mjs --write` / (check): regenerated after the production-file
  change, reverified `{"ok":true,...}`, committed in this PR.
- ADR currency: `docs/adr/0055-proactivity-that-meshes.md` `governs:` lists
  `plugin/scripts/continuation-gate.mjs` directly — a Currency-log row is added in this same PR (see
  ADR section below); no other governing ADR names either changed file.

## Baseline

Baseline = unmodified `origin/main`@`37f1f5a2f3e8ad53df27e4d903bd951690c087c8` (tonight's actual tip).

## Darwin Lineage

Not run — a deterministic structural fix (temp-file + fsync + rename) reusing an already-established,
already-shared in-repo primitive; no continuous parameter to evolve. Same precedent as every prior
memory-durability night on this surface.

## Evidence

OBSERVATION (the file literally named LEDGER was the last untested, unmigrated instance of a
shape six sibling files have already been fixed for) → MEASUREMENT (TEETH red→green, independently
reproduced via `git stash`, not taken on trust) → MEASUREMENT (blast-radius: zero module importers) →
MEASUREMENT (targeted batch baseline-identical save for the one pre-existing container artifact) →
MEASUREMENT (test:integration baseline-vs-candidate reconciliation, see Regression Analysis) →
DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No benchmark, gold-answer, or threshold file touched — only the hook, its new test, the governing
ADR's currency log, and a derived `convergence-manifest.json` hash regen. The fix can only make the
write safer (atomic rename instead of in-place truncate); it cannot make any existing assertion more
lenient, because nothing that previously passed depended on the unsafe write succeeding mid-crash.

**Independent critique** (this orchestrating session, acting as its own independent reviewer of the
candidate it implemented — re-derived the red/green result from scratch via `git stash` rather than
trusting the diff, re-ran the blast-radius grep itself, and reread the diff for the hazards this
house pattern is known to care about): no symlink-detach risk (the temp file is always freshly
created, never an attacker-reachable existing path); no mode-clobber risk (temp file gets the
default `fs.openSync(tmp, 'w')` mode under the existing directory's umask, matching what
`fs.writeFileSync` on the same path already produced — unlike `md-stamp.mjs`'s PR #422, there is no
pre-existing file whose mode must be preserved across the swap, since the ledger has never declared a
specific required mode); no TOCTOU window an attacker could win (the ledger path is always under
`~/.config/ruvnet-brain/work-ledgers/`, never attacker-influenced). Verdict: **CLEAR**.

## Security Review

No prompt-injection surface (no model call in this path). No new attack surface: the write target is
always the process's own per-project work-ledger path under `~/.config/ruvnet-brain/work-ledgers/`
(`RUVNET_WORK_LEDGER` env override only used in tests), which this hook already had unrestricted write
access to before this change — the diff changes *how* that already-permitted write lands, not what it
is allowed to touch. No new dependency, network call, or credential touched.

## Regression Analysis

See Evaluation Receipt. `test:integration` baseline (pre-candidate `continuation-gate.mjs`) vs
candidate: 9 of the candidate's 10 failing files are byte-identical to baseline (pre-existing,
environmental — no corpus/brain on this container). The 10th, `advocacy-dial-levels.test.mjs`, has
zero blast-radius connection to either changed file and passed 7/7 in two independent isolated
re-runs on the candidate — a resource-contention flake from concurrent validation jobs on this
container, not a regression. `qa:pr`'s own FAIL lanes (`docs`, `catalog`) were independently confirmed
to fail identically on baseline (full-repo ADR drift backlog and model-catalog staleness, both
pre-existing and unrelated to either changed file); `convergence` was regenerated and is green;
`coverage` TIMEOUT and `claims-source` BLOCKED match every prior night's documented environmental gap
(no brain/corpus materialized on this container).

## ADR

No new ADR. `docs/adr/0055-proactivity-that-meshes.md` already governs
`plugin/scripts/continuation-gate.mjs`; a Currency-log row recording tonight's change is added to it
in this same PR, consistent with every prior currency-reviewed change to this file (2026-10-15,
2026-08-06, etc. — see that ADR's own log). This is a durability/correctness fix reusing an
already-established repo idiom, not an architectural decision: no hook, matcher, timeout, silence rule
or dial in the mesh changes, and what the gate may force is unchanged.

## Gist

**LOCAL** — no `gh` CLI and no gist-creation MCP tool available this session, consistent with every
documented Dream Cycle night since 2026-08-19. This file is committed at
`docs/dream-cycle/2026-10-19-memory-durability-report.md`.

## Issue

**NONE** — a new, reproduced, actionable defect with a verified local fix integrated in this same PR
(independently re-verified via `git stash`, not merely implemented) is a work record, not a tracking
issue, per this repo's ISSUE DISPOSITION OVERRIDE.

## Witness

```
SESSION_COMMIT = 37f1f5a2f3e8ad53df27e4d903bd951690c087c8
REPORT_HASH    = d1fac95c9e2ebf7ae7f16bd0f1e5b5b4fa9691e5ab27f61b58a2d1a2bb3ad6db
WITNESS        = fdaddbe04411bb09864e318d47b0a1d0ba1d3bc6fb70b7df9388c9c1c71fd321
```

REPORT_HASH is the sha256 of this report as it stood immediately before this Witness section was
stamped with its own hash (the standard resolution to the self-reference: the stamp cannot hash
itself). WITNESS = sha256(REPORT_HASH || SESSION_COMMIT).

Verifier procedure: (1) check out `SESSION_COMMIT`; (2) `sha256sum` this report file and confirm it
equals `REPORT_HASH`; (3) `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` and confirm it equals
`WITNESS`; (4) `git stash` the candidate diff and re-run
`tests/unit/continuation-gate-ledger-write-safety.test.mjs`, confirming the regression-lock case goes
red; (5) pop the stash and confirm it goes green again.

## Recommendation (for the repo owner, priority order)

1. **The backlog is still the dominant fact.** Zero dream-cycle PRs have merged since `#178`
   (2026-08-26); the review-lane backlog is in the dozens of open drafts and has been restated nightly
   since issue `#410` (2026-10-06). Not duplicating that issue tonight (already open, already
   comprehensive). The mechanical audit it suggests remains the single highest-leverage action
   available, and is a human decision this session should not attempt unilaterally.
2. **This PR itself**: one production file (small diff), zero module importers, independently
   re-verified rather than taken on trust, applying a house pattern already landed conceptually (if
   not yet merged) six times before on this exact surface — a reasonable, low-risk one to merge if the
   owner is looking for a place to resume the review lane.

## Merge Policy

No autonomous promotion — **human review required**, per `autoMerge: false` (`dream.config.json`,
ADR-068). This session never self-merges.
