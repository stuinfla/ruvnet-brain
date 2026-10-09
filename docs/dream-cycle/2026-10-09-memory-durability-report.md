# Memory-Durability SOTA Report — 2026

**Dream Cycle 2026-10-09 — DEEP=memory-durability, SCAN=managed-boundary,round-trip-proof (slot 4, `20261009 % 5 == 4`). No bonus deep dive (`% 25 = 9`, `% 75 = 59`).**

## TL;DR

`plugin/scripts/md-stamp.mjs`'s `writeStampIfUnchanged()` is a live, shipped `PostToolUse` hook that
refreshes a timestamp line inside ANY `.md` file touched by `Write`/`Edit`/`MultiEdit` in ANY host
project — a file this plugin's own header comment says it does not own. It committed that refresh with a
bare, in-place `fs.writeFileSync(file, stamped)`. An interrupted write (the harness's own per-hook kill,
`ENOSPC`, `EIO` from a slow/network-mounted project dir) could truncate the host's own document with no
backup and no recovery path, and `main()`'s advisory `catch { /* advisory */ }` swallowed the failure with
zero diagnostic — the user would never learn their doc was wiped. The identical unsafe pattern existed in
`scripts/stamp-sweep.mjs`'s `--apply` path (a manual dev-only sweep, lower severity, but the same hazard
against this repo's own docs).

Fixed by routing both through a new shared `atomicWriteSync(file, content)`: write to a sibling temp file,
`fsync`, then `renameSync` over the real path — the same idiom already used by `kb/refresh-run.mjs` and
`scripts/loop-checkpoint.mjs`. An independent adversarial critic then found the first version of that fix
introduced two of its own real regressions — detailed below — both reproduced as failing tests and fixed
in a second commit before this PR was opened.

## What's new

Nothing external — a reachable defect inside this repo's own durable-write layer, found by a dedicated
Explore-agent research pass tasked with ruling out duplication against the two other open
memory-durability PRs on this exact surface (`#345`, `#379`) before implementation.

## Competitors — how other autonomous coding/nightly-evolution harnesses treat in-place writes to files they do not own (grade C: general knowledge, informs framing only, never alone justifies the fix)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | Operates on its own generated artifacts inside a sandbox; no analogous "write into a host project's pre-existing file" surface. | C |
| OpenHands | Edits files inside its own sandboxed workspace via an action/observation loop; crash-safety of a single file write is delegated to the underlying OS/editor tool, not a first-class harness concern. | C |
| DSPy/GEPA | Program-optimization framework; no filesystem-write-durability concept at all. | C |
| SWE-agent | Patches are applied via diff/apply tooling against a git-tracked repo, so a torn write is recoverable via `git checkout` — a different safety property (recoverability via VCS) than what this hook needs (the host file is often untracked or mid-edit). | C |
| Cursor background agents | Runs in the user's own environment; general editor-safety (atomic saves) is the host editor's job, not the agent's — this repo's hook is unusual in acting as its own "editor" for a side-channel metadata update. | C |

The recurring theme: most comparable systems either sandbox their own writes or delegate durability to a
host editor. This repo's hook is unusual in writing directly into arbitrary host files from a side-channel
process, which is exactly why ADR-063's "never touch what we do not own" boundary applies with extra force
here — a bug here cannot be undone with "re-run the agent."

## Hypothesis (frozen before implementation, unchanged since)

> Given `writeStampIfUnchanged()`'s write of a refreshed stamp into a host project's own `.md` file, when
> the process is interrupted between opening the destination for write and the write completing (kill,
> `ENOSPC`, `EIO`), the current in-place `fs.writeFileSync(file, stamped)` can leave a truncated or
> zero-length host file on disk — the ACTUAL file is already damaged by the time any exception could fire,
> because the destructive write targets the real path directly. Routing the write through a temp sibling
> + `fsync` + `renameSync` (POSIX-atomic within one directory), so `file` is always either fully the old
> content or fully the new content, should close this gap — subject to: a successful refresh is
> byte-identical to today's output; the existing concurrent-modification guard is unchanged; the file's
> permission bits are preserved; and a symlinked `.md` file (which the hook already follows to read/stat)
> is stamped through to its real target rather than having the symlink itself detached.

The permission-bits and symlink clauses were added to the frozen hypothesis's "subject to" list only after
the adversarial critic's pass below — not after evaluation began on the ORIGINAL claim (atomicity), which
is the part STEP 3.3 actually froze. Both additional invariants were identified, reproduced as failing
tests, and fixed before this PR was opened; no invariant was weakened or removed at any point.

## Candidate

`plugin/scripts/md-stamp.mjs`: new exported `atomicWriteSync(file, content)` — resolves `file` via
`fs.realpathSync` (so a symlink is followed to its real target, matching how the hook already reads/stats
through it, rather than having `renameSync` silently detach the link), reads the destination's existing
mode, opens a `${basename}.ruvnet-md-stamp-tmp-${pid}` sibling in the same directory with that mode,
`fchmodSync`s it to the exact bits (closing the umask gap), writes, `fsync`s, closes, then `renameSync`s
over the resolved target; a rename failure unlinks the temp file and rethrows, leaving the original
untouched. `writeStampIfUnchanged()` now calls this instead of `fs.writeFileSync`. `scripts/stamp-sweep.mjs`'s
`--apply` path reuses the same exported helper instead of its own bare `fs.writeFileSync`.

2 production files (+35/-9 net across both commits), 1 test file (+37 lines, 4 new TEETH cases: atomic/no
direct `writeFileSync`, round-trip survival under an injected `renameSync` failure, permission-mode
preservation, symlink-identity preservation).

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate`: `EVALUATED=blocked` (`no brain at
/root/.cache/ruvnet-brain/kb`, never materialized on this host — confirmed via
`scripts/restore-local-ingests.mjs` exit 2, `kb/store-root.mjs` `stores 0 dark 0`, unchanged since every
prior night since 2026-08-19). `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY` in this container tonight;
irrelevant regardless, no stage here needs a model call.

**TEETH, proven to fail first on each of two commits in turn:**
- Commit `8c4cbc44` (atomicity only): the two tests added with it (`is ATOMIC`, `ROUND-TRIP PROOF`) were
  first run against the pre-candidate baseline via `git stash` — the `not.toHaveBeenCalled()` assertion
  initially passed *vacuously* on baseline too (a real bug in the test itself: asserting AFTER
  `mockRestore()`, which clears Vitest's spy call history) — caught and fixed before trusting the result,
  then reconfirmed: 2/2 fail on baseline, 17/17 pass on candidate.
- An independent adversarial critic agent (not this session's author) then found two real regressions in
  `8c4cbc44` — a symlinked `.md` file gets its link detached and its real target left un-stamped while the
  hook still reports success; the new temp file's mode silently replaces the host file's original
  permission bits — both independently reproduced directly (`node -e` repro scripts) before any test was
  written. Commit `ca90ff88` fixes both; two more tests prove it: reverting to `8c4cbc44`'s version of
  `atomicWriteSync` (saved aside, diffed back in) reproduces both failures (2/19 fail), restoring the final
  version gives 19/19 pass.
- A second, independent review pass (separate agent) re-audited `ca90ff88` itself adversarially (TOCTOU on
  `realpathSync`, cross-device rename, Windows compatibility, the new tests' own validity) — verdict
  **CLEAR**, with one disclosed non-blocking residual: `fchmodSync` restores permission bits but not
  uid/gid/setuid/setgid/sticky bits (the renamed file is a new inode owned by the hook's own process) —
  low practical severity (requires a host `.md` file owned by a different user/group than the hook
  process), out of this commit's stated scope, carried here rather than hidden.
- Blast radius: repo-wide grep for every caller of `md-stamp.mjs`'s exports and of `atomicWriteSync` —
  exactly `plugin/scripts/hook-shim.mjs` (the hook dispatcher), `scripts/stamp-sweep.mjs` (the other
  caller, intentionally migrated), and the test files. Targeted batch (`md-stamp.test.mjs`,
  `md-stamp-managed.test.mjs`, `wired-check.test.mjs`, `convergence-manifest.test.mjs`): 88/88 pass.
  `hook-shim-fallback-once.test.mjs`'s one failure (`fs.chmodSync(HOME_DIR, 0o755)`-based) reproduced
  byte-identically on unmodified `main` — the well-documented pre-existing chmod/EACCES-under-root
  container artifact (root bypasses permission checks here), unrelated to either changed file.
- `npx vitest run tests/integration` (full suite, both a true `git stash`-baseline run and a candidate run
  with a matching JSON reporter for exact file-level diffing): baseline 19 failed files/44 failed tests,
  candidate 20 failed files/45 failed tests — the apparent +1 is
  `tests/integration/learning-recovery-377.test.mjs` (an 8-second worker-deadline timing test, no
  reference to either changed file by grep), independently reproduced failing in ISOLATION on BOTH the
  unmodified baseline and the candidate, identically — a pre-existing, timing-sensitive test whose result
  depends on concurrent resource contention at suite-run time, not on this diff. Once isolated, baseline
  and candidate integration failures are an exact match.
- `npm run claims:verify`: 3 PASS/4 SKIP, identical composition to every documented night since 2026-08-19.
- `node scripts/sync-version.mjs --check`: all surfaces agree on 4.5.17.
- `node scripts/doc-currency.mjs --check --changed HEAD`: 0 documents matched — no ADR's `governs:` field
  declares either changed production file (confirmed directly, matching PR #379's own finding for its
  sibling file) — no Currency-log row required for those two files. This PR's own ledger-row addition
  below DOES require one, since `docs/dream-cycle/LEDGER.md` is governed by ADR-068.
- `npm run convergence:write` / `:check`: manifest regenerated after each of the two production-file
  commits, reverified green both times (`tests/unit/convergence-manifest.test.mjs` 2/2 pass).
- `npx vitest run tests/unit` (full suite, ~3,600+ tests): started with a JSON reporter for structured
  comparison but exceeded this container's background execution window (30 minutes) before completing,
  twice. Not restarted a third time — disproportionate to a 2-file, ~35-line diff whose full blast radius
  is already confirmed narrow and green above, per STEP 0.6's budget discipline. Flagged honestly rather
  than claimed.

## Baseline

Baseline = unmodified `origin/main`@`9cf8fe19a57671eb430ce7341b7b8bf123ccce75` (tonight's actual tip).

## Darwin Lineage

Not run — a deterministic structural fix (temp-file + fsync + atomic rename + mode/symlink preservation)
with one correct implementation and real red→green TEETH receipts at each of two commits; no continuous
parameter to evolve. Same precedent as every prior memory-durability night (#345, #379).

## Evidence

OBSERVATION (`md-stamp.mjs`'s shipped hook does an in-place write into a file it does not own; identical
pattern in `stamp-sweep.mjs`) → MEASUREMENT (TEETH red→green for the atomicity fix) → OBSERVATION
(independent critic reproduces two NEW regressions in that fix, directly, before writing any test) →
MEASUREMENT (TEETH red→green for the mode/symlink fix) → MEASUREMENT (second independent review pass,
re-audits the fix itself, verdict CLEAR) → MEASUREMENT (blast-radius batch + full `test:integration`,
baseline vs candidate, isolated-rerun-confirmed byte-identical) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No benchmark, gold-answer, or threshold file touched (`git show --stat` across both commits: only
`plugin/scripts/md-stamp.mjs`, `scripts/stamp-sweep.mjs`, `tests/unit/md-stamp-managed.test.mjs`,
`data/convergence-manifest.json` — the last a derived hash regeneration, not a goalpost). Not vacuous: the
very first version of the atomicity test WAS accidentally vacuous (asserting after `mockRestore()`) and
was caught and fixed by this session before being trusted, not after an external critic found it — see
Evaluation Receipt. The fix can only make a write stricter (refuse to leave a torn file, preserve more of
the original file's identity), never more lenient toward actual corruption.

**Independent adversarial critic** (fresh `general-purpose` agent, not this candidate's author) — first
pass verdict **BLOCKED** (found the symlink-detach and mode-clobber regressions, both independently
reproduced); after the fix, a second fresh agent's re-audit verdict **CLEAR**, with the uid/gid/special-bits
limitation above disclosed as non-blocking. This two-round critique is itself the main reward-hack defense
here: the first version of this candidate would have shipped a REAL regression (silently destroying
symlinked `.md` files) under the banner of a "durability fix" had the critic pass been skipped.

## Security Review

Reviewed `atomicWriteSync`'s `realpathSync`/`fchmodSync` additions for: prompt-injection surface (none —
no model calls anywhere in this path); filesystem scope (the write still lands only on the same path the
hook already reads/stats through, including through a symlink it could already follow before this diff;
containment to the project root is enforced earlier in `main()` via `contains(root, filePath)` against the
resolved real path, unaffected by this change); credential exposure (none, no secrets touched); and
attacker-controlled input into the temp filename or mode (the temp suffix is a fixed string plus
`process.pid`, not attacker-supplied; the mode is read from the existing file's own `stat`, not supplied by
the hook-event payload). This is strictly a bug fix restoring parity with the pre-atomic write's effective
behavior — it grants the hook no new capability to touch or change a file it could not already reach; it
only stops two ways the atomic rewrite itself could silently corrupt or detach a file it was already
allowed to write.

## Regression Analysis

See Evaluation Receipt: targeted + blast-radius batch 88/88 green; `test:integration` baseline vs candidate
byte-identical once the one timing-sensitive flaky file is isolated and reproduced identically on both
sides; `convergence:check` and `version:check` both clean. Zero regressions attributable to this change
beyond the two the independent critic found and this PR already fixes in its own second commit.

## ADR

None — a durability/correctness bug fix reusing an already-established repo idiom (temp file + fsync +
rename), not an architectural decision. Confirmed via `doc-currency.mjs`: no ADR's `governs:` field names
either changed production file.

## Gist

**LOCAL** — no `gh` CLI and no gist-creation MCP tool available this session, consistent with every
documented Dream Cycle night since 2026-08-19. Full report committed at this path.

## Issue

**NONE** — a new, reproduced, actionable defect with a verified local fix integrated in this same PR (two
commits: the fix, then the critic-driven correction) is a work record, not a tracking issue, per this
repo's ISSUE DISPOSITION OVERRIDE.

## Backlog note (not this PR's finding, carried forward for the owner)

Per issue `#410` (filed 2026-10-06, still open, one automated-bot comment, no human triage in the 3 days
since) and PR `#419` (2026-10-08): **90 `dream/*` PRs opened all-time, 49 open as of tonight (freshly
counted via GitHub MCP `search_pull_requests`), exactly 5 ever merged — the last on 2026-08-31 (`#215`).**
That is 40 days with zero `dream-cycle` PRs merged while 20+ `release/*`/`fix/*` PRs merged routinely in
the same window, so this is specific to the dream-cycle review lane, not a general review freeze. This is
now the seventh-plus consecutive night this exact condition has been named (ledger rows 08-26/08-28/08-31;
PR bodies for `#322`, `#345`, `#358`, `#371`, `#378`, `#379`, `#410`, `#419`) — restating it again did not
change the outcome, so this session is not opening a duplicate issue. Also independently verified tonight:
PR `#345`'s own fix (the outbox torn-tail defect) is **already present on current `main`** via some other
integration path — `plugin/scripts/project-progression-outbox.mjs` already has the streaming `readJsonl`
reader, torn-tail detection, and quarantine/`markRecovered` machinery `#345` proposed — so `#345` itself
appears safe for the owner to close as superseded (not done by this session; closing someone else's PR is
outside this session's bounded authority per `docs/dream-cycle/OPERATING-POLICY.md`'s "existing backlog
reconciliation belongs to the integration owner").

## Witness

```
SESSION_COMMIT = 9cf8fe19a57671eb430ce7341b7b8bf123ccce75
REPORT_HASH    = 0113840c233ba0b7253a5ff8cf614e1abf64f3d95c315731d160bc86d32e2f6c
WITNESS        = a2c9380d87ccfb5087a1a85c94de0306fa4479909d5654ae898fdb9a179e12a1
```

`REPORT_HASH` is the sha256 of this report's content as it stood through "Backlog note" (everything above
this section), computed BEFORE this Witness section was written — STEP 16's own chicken-and-egg order:
stamp, then rewrite the Witness section with the stamp. It will therefore NOT match a fresh `sha256sum` of
this file as it now reads; appending this section changed the bytes. That is expected by construction, not
evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 9cf8fe19a57671eb430ce7341b7b8bf123ccce75` (tonight's base commit on `main`).
2. Apply this PR's diff (commits `8c4cbc44`, `ca90ff88`, plus this report/ledger/ADR commit).
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. Revert only `plugin/scripts/md-stamp.mjs` and `scripts/stamp-sweep.mjs` (keep the test file changes),
   re-run `tests/unit/md-stamp-managed.test.mjs` — the 4 new TEETH cases (`is ATOMIC`, `ROUND-TRIP PROOF`,
   both `MANAGED-BOUNDARY` cases) must fail.
5. Restore the fix, re-run the same file (19/19 green) plus the blast-radius batch
   (`md-stamp.test.mjs`, `wired-check.test.mjs`, `convergence-manifest.test.mjs`: 88/88 combined, excluding
   the documented pre-existing `hook-shim-fallback-once.test.mjs` chmod/EACCES-under-root failure), then
   `npx vitest run tests/integration` and confirm the same baseline-vs-candidate parity reported above
   once `learning-recovery-377.test.mjs` is isolated and reproduced identically on both sides.

## Merge Policy

**Human review required.** This session never self-merges and never autonomously promotes candidate
state. Draft, by design.
