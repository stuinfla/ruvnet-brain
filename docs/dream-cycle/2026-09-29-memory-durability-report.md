# Dream Cycle 2026-09-29 — memory-durability

## Rotation

```text
DATE   = 2026-09-29
DAYINT = 20260929
SLOT   = 4  (20260929 % 5)
DEEP   = memory-durability
SCAN   = managed-boundary, round-trip-proof
BONUS  = none (20260929 % 25 = 4, % 75 = 54 — neither hits)
SESSION_COMMIT = 107a1d44fc578dc67cea0425f1f01954e3e8d06b
```

`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` both absent tonight — `LLM_EVAL=blocked`. Irrelevant
to this candidate: it is a deterministic filesystem/parsing correctness fix, no stage needs a
model call.

## A note on tonight's ledger check: the real finding is the backlog, not a gap

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31. This is **not** nine-plus
missed nights — the routine has fired every night since (confirmed via `mcp__github__` PR
listings: `dream/*` branches exist for every night from 2026-09-06 through tonight). Because
`autoMerge: false` is deliberate (ADR-068) and every dream-cycle PR is opened as a **draft**,
the ledger row only lands on `main` when a human merges the PR — and per PR #322's own
"Backlog note" (2026-09-24, independently re-confirmed here via `list_pull_requests`):
**~28 `dream/*` draft PRs were already open and unmerged as of 5 nights ago, zero merged
since #178 (2026-08-26)**. Tonight that backlog has grown further — open dream-cycle PRs now
span 2026-09-12 through today (#282, #287, #288, #289, #291, #292, #293, #294, #295, #297,
#299, #304, #305, #312, #313, #317, #321, #322, #323, #324, #325, #328, #332, #333, #340, plus
this one), spanning more than a month with **zero merges since 2026-08-26**. Non-dream-cycle
PRs (release fixes, dependency bumps) ARE merging in the same window, so this is specific to
the dream-cycle review lane, not a general freeze. This is the single highest-value fact
tonight, independent of any code candidate, and is flagged again here as prior nights already
have — not a new discovery, a worsening one.

Also reconciled: issue #274 (2026-09-09, this exact DEEP/SCAN surface) already has an open,
unmerged, still-valid fix at PR #275 (`record-lesson.mjs` disposable-probe fix) — GitHub
reports its `mergeable_state` as `dirty` against current `main` (needs a rebase, not a code
problem) and one CI leg (`Vercel – explainer`) failing on an unrelated preview-deploy route
issue, orthogonal to the fix itself. Not this session's PR to rebase or merge — flagged for the
owner's queue, not re-litigated.

## Deep Dive — memory-durability / round-trip-proof

An Explore-agent research pass was run first, specifically to check whether tonight's DEEP
surface has any genuinely NEW, testable finding distinct from the 5 already-open
memory-durability PRs (#275/#274, #322, #323, #289, #288) before spending the cycle. It found
one, in a file none of those five touch.

`plugin/scripts/project-progression-outbox.mjs`'s `records()` method:

```js
records() {
  if (!fs.existsSync(this.path)) return [];
  const content = fs.readFileSync(this.path, 'utf8');
  const lines = content.split('\n');
  if (lines.at(-1) !== '') lines.pop();
  else lines.pop();                      // <-- both branches pop; the `if` is dead code
  return lines.filter(Boolean).map(...);
}
```

Every append writes `${JSON.stringify(record)}\n`, so on a normally-closed file
`content.split('\n')` ends with an empty string, and popping it is correct — the intended
behavior for the `else` branch. But because BOTH branches call `.pop()` unconditionally, a file
whose last append did **not** end in `\n` — a torn write (crash between `fsync` and the final
newline byte landing, or a read that races an in-flight append) — has its **last line popped
regardless of whether that line is valid JSON**. If the record itself is complete and only the
trailing `\n` was lost, `records()` silently discards a real, durably-written record with no
error. This directly violates `ProjectProgressionStore.capture()`'s own documented contract for
this outbox: "nothing is dropped, only deferred."

Reproduced live (not inferred): appended one snapshot via the real
`ProgressionOutbox.appendSnapshot()`, then truncated only the final `\n` byte of the file —
`pendingSnapshots()` returned `[]` instead of the snapshot.

This is exactly the round-trip-proof class this rotation targets — a write reports success
(`appendSnapshot()` returns, `fsync` succeeds) but the read-back path silently fails to recover
it after an adjacent, unrelated byte loss.

**Why it's not already covered**: #323 fixes a *different* file
(`project-progression-reader.mjs`, the `node:sqlite` read-only reader's WAL-sidecar
vivification — a distinct mechanism, vivifying sidecars, not truncation-swallowing). #275/#288
are `record-lesson.mjs`. #322 is `onboarding-console.mjs`. #289 is `agentdb-fleet-doctor.mjs`.
Grepped `docs/dream-cycle/*.md` and `tests/unit/project-progression-outbox.test.mjs`: zero
prior mentions of this function or scenario.

**A design constraint the fix had to respect**: an existing test (added when this file was
first written) already locks in "ignore only a crash-truncated final line while retaining
complete snapshots" — i.e. a genuinely partial/invalid last line (mid-JSON crash truncation)
is *intentionally* silently dropped, not a hard error, unlike mid-file corruption which throws
`'malformed outbox record'`. The fix must not regress that intentional leniency for genuine
truncation while still recovering a complete-but-unterminated record.

## Hypothesis (frozen before implementation)

> Given `ProgressionOutbox.records()` on a `.jsonl` outbox file whose last append is a
> complete, valid JSON record missing only its trailing `\n` terminator (a torn write after
> `fsync` but before the newline byte lands, or any partial read of the file mid-append), the
> current code unconditionally discards that last split fragment regardless of validity —
> silently losing a durable, successfully-committed record with no error. Distinguishing a
> complete-but-unterminated last line (recover it) from a genuinely truncated one (still
> silently drop it, preserving existing crash-truncation behavior) should close this gap,
> subject to: the existing "ignores only a crash-truncated final line" test still passes,
> mid-file corruption still throws loudly, and a normal well-terminated file is unaffected.

Unchanged since freeze; implementation matched it on the first pass (no correction needed).

## Candidate

`plugin/scripts/project-progression-outbox.mjs`: `records()` now pops exactly the last split
fragment once. If that fragment is non-empty (file did not end in `\n`), it is tried through
`JSON.parse`: a successful parse means the record is complete and merely lost its terminator —
push it back for normal processing (recovered); a parse failure means a genuinely truncated
write — drop it silently, identical to today's behavior. 1 production file (+7/-2 net), 1 test
file (+11 lines, 1 new TEETH case). Total ~20 changed lines.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate` independently blocked
(`no brain at /root/.cache/ruvnet-brain/kb`, the same never-materialized condition on this
container every night since 2026-08-19, confirmed via `brain-score.mjs` /
`restore-local-ingests.mjs` / `store-root.mjs`, all `stores 0 dark 0` — `restore-local-ingests`
explicitly labels this "NOT evidence of a wipe" for an ephemeral container, so not treated as
one).

**TEETH, proven to fail first, not inferred from logs:**

- `git stash push -u -- plugin/scripts/project-progression-outbox.mjs` (test file kept), then
  `npx vitest run tests/unit/project-progression-outbox.test.mjs` against pre-candidate code:
  the new test fails — `AssertionError: expected [] to deeply equal [ {…} ]` (the torn-newline
  snapshot vanished). 4/5 pass (the pre-existing 4 unaffected). `git stash pop`: 5/5 pass.
- Blast radius (grep-confirmed, independently re-checked by the adversarial critic below):
  `ProgressionOutbox`/`pendingSnapshots()`/`records()` have exactly one production caller,
  `plugin/scripts/project-progression-store.mjs`, plus test files
  (`tests/unit/project-progression-outbox.test.mjs`,
  `tests/integration/project-progression-restore-semantics.test.mjs`,
  `tests/integration/project-progression-store.test.mjs`,
  `tests/acceptance/cross-host-project-resume.test.mjs`).
- Targeted blast-radius run (`project-progression-outbox`, `-restore-semantics`, `-store`,
  `cross-host-project-resume`): 4 failed / 16 passed candidate vs. 4 failed / 15 passed
  baseline — the +1 is exactly the new test; the 4 failures are byte-identical
  (`global Ruflo is required; this integration must not vacuously skip`), a pre-existing gap
  documented on this container since at least 2026-09-24 (no global `ruflo` binary installed
  here).
- `npm run test:integration`: candidate 25 failed / 335 passed / 17 skipped / 45 todo of 422
  (10 failed files of 54). Diffed the full sorted `FAIL` line list, baseline
  (`git stash`) vs. candidate: **byte-identical**, all 25 the same pre-existing environmental
  gaps (`ruflo` binary absent, cross-encoder model cache/network absent, `sqlite3` CLI absent —
  none reference `project-progression-outbox.mjs`).
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical composition to every night since
  2026-08-19.
- `node scripts/sync-version.mjs --check`: all surfaces agree on 4.3.35.
- `node scripts/doc-currency.mjs --check --changed HEAD`: no blocking violations; no ADR
  governs either changed file (confirmed by grep of `docs/adrs/`), so no Currency-log row is
  required.
- Full `npx vitest run tests/unit` (candidate): see Regression Analysis.

## Baseline

Baseline = unmodified `origin/main` @ `107a1d44fc578dc67cea0425f1f01954e3e8d06b` (this
session's start-of-run tip).

## Darwin Lineage

Not run — a deterministic structural fix (remove dead-code duplicate branch, add a
parse-then-decide check) with a real red→green unit receipt; no continuous parameter to evolve.
Same precedent as every prior memory-durability night.

## Evidence

OBSERVATION (dead-code `if`/`else` both call `.pop()`, live-reproduced data loss on a
torn-newline file) → MEASUREMENT (TEETH red→green, isolated blast-radius suite, full
`test:integration` byte-identical baseline/candidate diff) → DECISION (recover a
complete-but-unterminated last record via `JSON.parse`-then-decide, preserving the existing
intentional silent-drop behavior for genuinely truncated records) → MEASUREMENT (independent
adversarial critic pass, see below).

## Reward-Hack Check

No benchmark, gold answer, eval-gate corpus, or threshold touched — confirmed by `git diff
main...HEAD --stat` naming exactly the two files above plus this report and the ledger row.
The fix cannot make `records()` more lenient toward *actual* corruption: `JSON.parse` either
succeeds on syntactically complete, valid JSON or throws; there is no reachable byte sequence
that is simultaneously "a genuinely truncated/corrupted record" and "valid JSON" by definition
of what truncation does to a JSON document (removing bytes from a complete object produces an
incomplete parse, not a different-but-valid one, absent an adversarially-crafted file — see
Security Review). The change is strictly a recovery of a false negative, not a new false
positive.

**Independent adversarial critic** (a fresh, uninvolved agent, working only from `git diff` and
the live repo, not this candidate's author's claims) — verdict **CLEAR**, no blocking issues.
Specifically checked and confirmed independently: no benchmark/eval file touched; the
"torn-write JSON confusion" hazard (a truncated fragment parsing as a different, wrong-but-valid
JSON value) cannot occur here, because `appendRecord()` writes one `JSON.stringify(record)+'\n'`
per call and a single top-level JSON document has no earlier "complete" point before its true
end — any proper prefix of a torn write either IS the complete record (recovered, correct) or
has unbalanced brackets/quotes and throws (dropped, unchanged); blast radius independently
re-grepped, confirmed exactly one production caller; re-ran the pre-existing "ignores only a
crash-truncated final line" test itself (5/5 green) and traced it by hand; traced edge cases by
hand (empty file, whitespace-only content, single-line file with no trailing newline, an
embedded blank line before non-JSON garbage) — all resolve correctly, none newly broken.

## Security Review

No new external input: `records()` already read attacker-reachable content (this file's own
project-local `.swarm/*.jsonl`) before this change; the fix does not change what a hostile file
could do beyond what `JSON.parse` on untrusted text already implies (this file already calls
`JSON.parse` per line on every other line, unchanged). No `__proto__`/prototype-pollution
concern is introduced beyond what already existed (`JSON.parse` output flows into a `Map` and
plain equality/property reads, not into `Object.assign` or spread onto a shared prototype).
No new dependency, network call, or credential. No new write path — this method is read-only.
Independently confirmed by the adversarial critic: parsed records flow only into plain-property
reads and `Map` keys/values, never `Object.assign`/spread onto a shared object, so no new
prototype-pollution vector is introduced beyond what already existed.

## Regression Analysis

Byte-identical `test:integration` failure set (25/25 match, see Evaluation Receipt).

Full `npx vitest run tests/unit` (candidate, 787.9s): 44 failed / 5753 passed / 47 skipped /
138 todo of 5982 (16 failed files of 477). One of those 44 — `convergence-manifest.test.mjs`'s
"proves the committed source surfaces converge" — is the expected, by-design staleness this
repo's manifest check raises whenever tracked source changes; fixed via
`npm run convergence:write`, reverified clean (`{"ok":true,...}`) and committed alongside.

The remaining 43 failures (15 files) were independently re-run in isolation against unmodified
`origin/main` (`git stash` on the 3 changed/generated files): **byte-identical**, 43 failed /
289 passed on baseline too. None reference `project-progression-outbox.mjs`, `records()`,
`pendingSnapshots()`, or `ProgressionOutbox` — they span pre-existing, previously-documented
environmental gaps on this container: chmod/EACCES-under-root fixtures (`advocacy-*`,
`hook-shim-fallback-once`, `user-settings`), `gh`/network-interception seams
(`corpus-customer-promotion`, `corpus-seed-release-authority`, `corpus-accuracy-gate`,
`rehearse-corpus-pipeline`), and a `git merge-base` check against this container's squashed
history (`retrieval-canary`) — none newly introduced by this candidate.

Net result: **zero regressions attributable to this change**, one expected/fixed manifest
staleness, 43 pre-existing/environmental failures reproduced identically on baseline.

## ADR

None. A dead-code/correctness bug fix in an existing module, not an architectural decision. No
ADR's `governs:` frontmatter names `project-progression-outbox.mjs` (confirmed via
`doc-currency.mjs`).

## Gist

**LOCAL** — no `gh` CLI binary and no gist-creation MCP tool available this session (GitHub
issue/PR access IS available via `mcp__github__*`; same limitation as every Dream Cycle night
since 2026-08-19). Full report committed here.

## Issue

**NONE** — a new, reproduced, actionable defect with a verified local fix integrated in this
same PR is a work record, not a tracking issue, per this repo's ISSUE DISPOSITION OVERRIDE.

## Witness

```
SESSION_COMMIT = 107a1d44fc578dc67cea0425f1f01954e3e8d06b
REPORT_HASH    = 264a2e356c8f42164afaef677995541a6ad1bb8dcd60be0ae1bf953f19d101bb
WITNESS        = b2b704b7515eb5b1f7268e3f6207a2c4ffc62a50effd7f7a5ff9313bcdb27431
```

`REPORT_HASH` is the sha256 of this report file as it stood immediately before this Witness
section was appended (the same convention every prior Dream Cycle report in this repo uses,
since a hash of a file cannot include its own value). `WITNESS = sha256(REPORT_HASH +
SESSION_COMMIT)`.

**5-step verifier procedure**, reproducible by anyone:

1. `git checkout 107a1d44fc578dc67cea0425f1f01954e3e8d06b -- .` (or fetch that commit) to
   confirm `SESSION_COMMIT` is this run's real starting tip.
2. Reconstruct the report's pre-witness content (everything above this `## Witness` heading in
   the committed file) and run `sha256sum` on it — it must equal `REPORT_HASH` above.
3. Compute `sha256(REPORT_HASH + SESSION_COMMIT)` (string concatenation, not file concatenation)
   and confirm it equals `WITNESS` above.
4. Reproduce the TEETH claim: `git stash push -u -- plugin/scripts/project-progression-outbox.mjs`,
   run `npx vitest run tests/unit/project-progression-outbox.test.mjs` (expect 1 of 5 failing —
   the new torn-newline-recovery test), then `git stash pop` and rerun (expect 5/5 passing).
5. Reproduce the integration parity claim: `npm run test:integration` on the candidate vs. on
   `git stash`-ed baseline; diff the sorted `FAIL` lines — expect zero difference (25/25 match).

## Recommendation

`evaluated: accepted`. Human review of the linked draft PR requested. Separately, and with more
urgency: the dream-cycle review backlog (now >30 open draft PRs, zero merged in over a month)
is the highest-value fact from tonight's run and needs the owner's attention independent of any
individual candidate's merits.

**Merge policy**: this session never merges and never self-promotes. Evaluation is not
promotion.
