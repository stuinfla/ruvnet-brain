# Memory-Durability SOTA Report — 2026

## TL;DR

`plugin/scripts/decision-recall-gate.mjs` published its `decision-recall-acks.json` ledger (the
ADR-105 §8 / ADR-106 "refuse an ADR write without an AgentDB consult at most once per path per
session" memory) with a direct `fs.writeFileSync(file, ...)` on the real path. `writeFileSync`
truncates the destination before writing the new bytes; a process killed between those two steps
(the harness's own per-hook kill, `ENOSPC`, `EIO`) leaves the ledger **empty**, silently discarding
every acknowledgment ever recorded, not just the one being added. The sibling record right next to
it in the same module family (`decision-record.mjs`'s `writeConsultReceipt`) already uses temp-file
+ fsync + rename; this ledger was never migrated to that pattern. Fixed by adding
`writeAcksAtomic()`, mirroring the established house idiom (`user-settings.mjs`'s `writeAtomic`,
`decision-record.mjs`'s `writeConsultReceipt`, and this surface's own recent precedents — PR #422's
`md-stamp.mjs`, PR #379's `lesson-promote.mjs`).

## What's new

Same defect *class* this surface has now found and fixed six times (`md-stamp.mjs`, `stamp-sweep.mjs`,
`lesson-promote.mjs`, `project-progression-reader.mjs`, `project-progression-outbox.mjs`,
`agentdb-fleet-doctor.mjs`), in a seventh, previously-untested file: `decision-recall-gate.mjs`'s
`evaluate()` — the newest hook in the codebase (ADR-105/106, landed 2026-10-10/11) — shipped with
zero test coverage on its own write path and the exact unsafe write idiom every sibling in this
family has already been corrected away from.

## Competitors (how durability/crash-safety is treated elsewhere)

| Project | Approach to local durable state | Grade |
|---|---|---|
| Sakana AI Scientist | Experiment logs/checkpoints via plain file writes in its run harness; no documented atomic-write discipline for its own bookkeeping state (not the research artifacts it evaluates) | C (single-source: public repo inspection, not an official durability claim) |
| OpenHands (All-Hands-AI) | Session/event store backed by a pluggable file store; local file backend writes are not uniformly rename-atomic across backends per its own docs | B (official docs + source, cross-checked, not independently benchmarked here) |
| DSPy / GEPA | Checkpointing is explicit and user-provided (save/load of optimized programs); no built-in crash-mid-write guard documented for the default JSON/pickle dump | B (official docs) |
| SWE-agent | Trajectory logs written incrementally to disk; no documented atomic-rename guard in the trajectory writer | C (source inspection only) |
| Cursor background agents | Proprietary; no public implementation detail on local state durability | — (no public source, not graded) |

No competitor's documented practice is stronger than the pattern this repo already established and
is now extending consistently (temp file, same directory, `fsync`, `renameSync`). This is a narrow,
internal-consistency finding, not a claim that this repo is ahead of the field generally — C/B-grade
evidence only, per this routine's own grading discipline; it informs, it does not alone justify
anything beyond what the local TEETH tests already prove.

## Hypothesis (frozen before implementation — see PR body for full text)

> Given the ack ledger already holds one acknowledgment, when `evaluate()` is called again for a
> different decision/session and the write to the real ledger path is interrupted after truncation,
> then the pre-existing acknowledgment is destroyed, even though the gate must still never
> throw/block a turn over its own ledger I/O.

## Benchmarks / Evaluation

- `npm run eval:gate`: **EVALUATED=blocked** — `no brain at /root/.cache/ruvnet-brain/kb` (container
  never materializes a corpus; identical condition on every documented night since 2026-08-19).
  `OPENROUTER_API_KEY` is present tonight but irrelevant — no stage here needs a model call.
- TEETH (new `tests/unit/decision-recall-ack-durability.test.mjs`): reproduced red on unmodified
  `main` (1/2 fail, exact predicted failure), green on candidate (2/2 pass) — independently
  reproduced by this orchestrating session via `git stash`, not merely the candidate author's claim.
- Blast radius (`grep -rl decision-recall-gate`): `decision-gate.mjs` (composes it as a spawned CLI,
  signature unchanged), `decision-record.test.mjs` (imports only the untouched pure helper),
  `decision-recall-ack-durability.test.mjs` (new). Targeted batch: 34 passed / 3 pre-existing failed
  / 5 skipped (the 3 failures are a PID-retirement timing artifact in `decision-gate.test.mjs`,
  independently reproduced byte-identical on unmodified `main`).
- `npx vitest run tests/integration` (full suite, baseline vs candidate via `git stash`, JSON
  reporter diffed programmatically): **byte-identical**, 420 total / 335 passed / 22 failed / 18
  pending both sides, same 9 failing files both sides (all pre-existing environmental gaps —
  `sqlite3`/`@xenova/transformers`/missing `ruflo` binary class — none referencing the changed file).
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition to every prior night.
- `node scripts/sync-version.mjs --check`: all surfaces agree on 4.7.2.
- `node scripts/doc-currency.mjs --check --changed HEAD`: 0 blocking (no ADR's `governs:` names
  either changed file — checked ADR-103/105/106 directly, the three that reference this hook family).
- `npm run wired:check`: exit 0; `plugin/scripts/decision-recall-gate.mjs` explicitly listed `✓`.
- `npm run convergence:write` / `convergence:check`: regenerated after the production-file change,
  reverified green (`{"ok":true}`).

## Witness

```
SESSION_COMMIT = d2982ac28ebb72216145e122133403de6102ec03
REPORT_HASH    = 6ee3d0d376aa279d56a8f526f79b0649c74cc183adadc5efd639597a689ca7b1
WITNESS        = 0c92fa52f0dcdf4a3764f5ef16cffcb96e9db7abb087f33cd2f47195cd3294b6
```

5-step verifier (anyone can reproduce):
1. `git checkout d2982ac28ebb72216145e122133403de6102ec03` in `stuinfla/ruvnet-brain`.
2. Confirm this committed report file's own bytes hash to `REPORT_HASH` above
   (`sha256sum docs/dream-cycle/2026-10-14-memory-durability-report.md`).
3. Recompute `WITNESS = sha256(REPORT_HASH + SESSION_COMMIT)` and confirm it matches.
4. `git stash push -- plugin/scripts/decision-recall-gate.mjs && npx vitest run tests/unit/decision-recall-ack-durability.test.mjs` — confirm 1 of 2 tests fails on the unmodified file; `git stash pop` to restore the candidate, confirm 2/2 pass.
5. `npx vitest run tests/integration` on both the stashed (baseline) and restored (candidate) tree — confirm the failing-file set is identical (9 files, both pre-existing/environmental).

## Next steps (concrete)

1. The repo owner's highest-leverage action remains the dream-cycle review backlog (issue #410,
   restated nightly since 2026-10-06) — not this candidate's to resolve, flagged again here.
2. A future night could migrate `decision-recall-gate.mjs`'s ledger to a real round-trip read-back
   (not just atomic rename), matching `lesson-promote.mjs`'s stricter PR #379 precedent, if the
   lost-update race under concurrent writers (noted as a residual risk, not fixed tonight) turns out
   to matter in practice.
3. Consider a repo-wide lint/grep rule that flags a new `fs.writeFileSync` call into a path under
   `RUVNET_BRAIN_HOME`/`~/.claude` without going through the shared atomic-write helper, so this
   defect class stops needing a dedicated nightly research pass to find each new instance.
