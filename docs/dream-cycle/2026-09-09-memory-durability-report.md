# Memory-Durability SOTA Report — 2026

## TL;DR

Tonight's rotation drew SLOT 4 (`20260909 % 5 == 4`) — `memory-durability` — the same DEEP surface as
2026-08-19 (night 1) and 2026-09-04. Per this repo's own ISSUE DISPOSITION OVERRIDE, the first duty
this session owes is reconciliation, not fresh research: check whether findings this surface already
named are still real before manufacturing new work. They were not.

Both open memory-durability issues predating tonight — **#243** (`session-snapshot-contract.mjs`'s
`legacy()` scanner discarding a healthy sibling root) and **#245** (`health-repair.mjs --distill-fleet`
never verifying its own backup landed) — are **already integrated on `main`**, verified directly by
reading current source and running their own tests, not assumed from the ledger. Both PRs (#244, #246)
were closed unmerged in the 2026-09-07 ~18:48 UTC batch-close of 24 `dream/*` PRs (confirmed pattern:
PR #269, 2026-09-08, found the identical shape for two `grounding-quality` issues). Reconciled and
closed both issues tonight with the evidence below.

That reconciliation freed the night for a genuine, previously-**named-and-deferred** gap: the 2026-08-29
memory-durability report's own five-candidates table scored `record-lesson.mjs`'s round-trip key nonce
gap a real finding (candidate #2, fit 5) and explicitly deferred it because PR #167 — the round-trip fix
itself — was still open. #167 is now also closed-but-integrated (same 2026-09-07 batch; verified
`resolveRuflo()` + exact-key round trip are live on `main`), which is precisely the trigger that report's
own "Next steps #2" named: *"Once PR #167 merges, re-examine whether its deterministic round-trip key
still needs the nonce fast-follow its own Reward-Hack Check flagged."* It does. Fixed tonight.

## What's new

Nothing external. This is this repo's own prior-night evidence, re-examined on schedule exactly as that
evidence's own "Next steps" instructed, plus one internal defect (the nonce gap) that report itself
already diagnosed and scored 20 nights ago.

## Reconciliation — #243 and #245

**#243** (`plugin/scripts/session-snapshot-contract.mjs`'s `legacy()`): current source (line 75) reads
`if (!stat.isDirectory() || stat.isSymbolicLink()) { malformed = true; continue; }`, with a comment
documenting the exact fix PR #244 proposed (`return` → `continue`, so a malformed first root no longer
discards a healthy second root's evidence). `npx vitest run tests/unit/session-snapshot-health.test.mjs`:
**9/9 pass** on current `main`.

**#245** (`scripts/health-repair.mjs --distill-fleet`): `scripts/snapshot-freshness.mjs` exists on
`main` exactly as PR #246 proposed (`newestSnapshot()`/`MTIME_GRACE_MS` extracted so both
`distill-project.mjs` and `health-repair.mjs` share one tested freshness check); `distillFleet()`
(line 287) calls `newestSnapshot(dir, backupStartedAt, MTIME_GRACE_MS, priorSnapshots)` and refuses the
store when nothing fresh landed. `npx vitest run tests/integration/health-repair.test.mjs`: **10/10
pass** (sqlite3 CLI installed this session specifically to run this file for real — see Environment
note below).

Neither PR's exact integrating commit is recoverable from this container: the checkout is a **shallow
clone, 50 commits, truncated at `4df9f3e`** (2026-09-07 11:46 EDT) — the same commit `git blame` credits
for both fixed regions, meaning the true history predates this clone's window. Disclosed rather than
guessed at.

Both issues closed tonight (`state_reason: completed`, comment linking this report and the test runs
above) — per `findingPolicy.closeIntegratedWork` / OPERATING-POLICY.md: "Integrated work is reconciled
against current source; its historical finding is not a reason to reopen it."

## The hypothesis (frozen before implementation)

> Given `scripts/record-lesson.mjs`'s round-trip proof, whose `key` (`lesson-${slug}`) and `value`
> (joined from `--task`/`--tried`/`--worked`/`--critique`/`--outcome`) are both fully deterministic
> from the CLI args, when a SECOND invocation with identical args has its `ruflo memory store` call
> silently no-op (claims success, persists nothing — the 2026-08-13 incident shape, applied to a
> repeat call rather than the first) while a FIRST invocation's write is still present under the same
> key, then the current `back.includes(value)` check cannot tell the stale first-run value apart from
> what this run intended to write, and wrongly reports success; appending a per-invocation nonce
> (`crypto.randomUUID()`) to the persisted value and checking the retrieved text for THAT nonce instead
> of the deterministic `value` should make the second run's round trip correctly fail — subject to: a
> genuinely fresh write (with its own new nonce) is still reported success, and a first-ever write to a
> fresh key is unaffected.

Unchanged since freeze.

## Competitors — memory/state write-verification stance (as documented; none used to justify the fix)

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Agent SDK) | Names durable state management as a foundation requirement; no documented per-call nonce/idempotency-token discipline for a write-verification round trip specifically. | A (general framing) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts — sidesteps this exact failure mode structurally (each mutation is a new version, not a same-key overwrite whose staleness must be inferred). | A (official repo) |
| SWE-agent | No public write-verification/nonce claims surfaced tonight. | C |
| Cursor background agents | No public documentation on write-verification mechanics surfaced tonight. | C |
| Sakana AI Scientist | No public documentation of a per-call freshness/nonce discipline on its own state writes. | C |

No competitor claim justifies the implementation — justification is entirely this repo's own precedent:
`degradation-watch.mjs`'s `proveMemoryDurable()` already uses a fresh per-run key+value pair for exactly
this reason (`durability-probe-${pid}-${Date.now()}` / `probe-${key}`); tonight applies the same
discipline to `record-lesson.mjs`'s real-content round trip, which cannot use a throwaway key (the
proof must be about the ACTUAL lesson content, not a disposable probe).

## Candidate

`scripts/record-lesson.mjs`: +21/-4 lines. One conceptual change — a per-invocation `nonce =
randomUUID()` is appended to the value before `store` (`storedValue = value + "\nRUN: " + nonce`), and
the round-trip check now looks for `nonce` in the retrieved text instead of the deterministic `value`.
`key`, `value`, the store/distill/search call sequence, and every other behavior are unchanged.

`tests/unit/record-lesson.test.mjs`: +95/-17 lines. Added a STATEFUL fake `ruflo` (a real Node script,
mirroring the file's existing win32 fixture pattern rather than a fragile POSIX-`sh` arg scan) whose
`store` writes `--value` to a state file (unless `RL_SILENT_NOOP=1`, simulating a no-op success) and
whose `retrieve` echoes that file back — the canned single-string fixtures already in this file cannot
express "what a stale prior write looks like." Two new cases; the pre-existing "genuinely round-trips"
case now uses the stateful fixture too (its old canned string could not contain a nonce it doesn't know
in advance, so it would have false-failed after this fix otherwise). The other three pre-existing cases
are untouched and still pass.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate`: `no brain at /root/.cache/ruvnet-brain/kb`,
store root never materialized (`stores 0 dark 0`, confirmed via the standard control-plane probe), the
same condition every Dream Cycle night has hit since 2026-08-19 — not a credentials block.

**TEETH, proven to fail first.** `git stash push -- scripts/record-lesson.mjs` (isolating the candidate,
keeping the new tests), ran `npx vitest run tests/unit/record-lesson.test.mjs` against unmodified
`main`:

```
✗ TEETH: a second identical invocation whose store silently no-ops must not be proven by a
  stale-but-textually-identical retrieve
  AssertionError: expected +0 to be 1
  (5 other cases pass)
```

`git stash pop`, re-ran: **6/6 pass.**

## Regression Analysis

- `npx vitest run tests/unit/record-lesson.test.mjs`: 6/6 (standalone).
- `npx vitest run tests/unit` (full suite, 381 files, ran to completion, sqlite3 installed this
  session — see Environment note): **14 failed files / 18 failed tests / 4392 passed / 42 skipped / 150
  todo of 4602.** None of the 18 failing tests are in `record-lesson.test.mjs`, `snapshot-freshness`,
  `session-snapshot-health`, or any file this candidate touches (`wired-baseline-classification.test.mjs`
  and `workflow-env-references-resolve.test.mjs` were the two directly inspected; both are pre-existing,
  environmental/CI-workflow-drift classes, confirmed unrelated by name and by content — neither
  references `record-lesson.mjs`).
- `npx vitest run tests/integration` (43 files): 8 failed files / 14 failed tests / 295 passed / 12
  skipped / 53 todo of 374 — same pre-existing class (`sqlite3` CLI absence for some fixtures despite
  this session's install, `@xenova/transformers`, headless-Chromium, the `unprompted-speech-registry`
  hooks-shape drift already tracked separately). `tests/integration/health-repair.test.mjs` (this
  night's reconciled #245 surface): **10/10 pass.**
- `npm run wired:check`: exit 1 — confirmed **byte-identical output** baseline (`git stash`) vs
  candidate via direct diff; pre-existing, unrelated to this diff (four unwired scripts, one duplicate
  exemption, none touching `record-lesson.mjs`).
- Blast radius: `grep -rn "record-lesson\.mjs"` repo-wide (excluding `node_modules`, this candidate's
  own test file) — exactly one hit, a prose comment in `scripts/wired-check.mjs`'s STANDALONE
  classification. No file imports this script's exports (CLI entrypoint only, unchanged).
- `node scripts/sync-version.mjs --check`: `4.3.16` agrees on every surface.
- `node scripts/doc-currency.mjs --check --changed HEAD`: no blocking currency violations for the
  scoped diff. No ADR's `governs:` frontmatter lists `scripts/record-lesson.mjs`.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical class to every prior night (brain-not-installed).
- `npm run convergence:write`: regenerated for the two changed source surfaces; committed.

## Environment note

This container's `sqlite3` CLI was not present at session start; `apt-get install -y sqlite3` failed
once (`security.ubuntu.com` 404 on a stale package list), then succeeded after `apt-get update`. Used
this session specifically so `tests/integration/health-repair.test.mjs` (this night's #245
reconciliation) could run for real rather than only be reasoned about — same precedent PR #245/#246 and
PR #167 both record.

## Reward-Hack Check

No benchmark, gold answer, or threshold touched — none exist for this surface. The fix cannot make the
round-trip check MORE lenient: the nonce is strictly additional evidence required, never a substitute
that accepts less. New tests confirmed failing red against unmodified `main` before the fix landed, not
adjusted post-hoc to match a passing run. No hidden cost, no new dependency (`node:crypto` is a Node
builtin already used elsewhere in this repo). The persisted lesson value now carries one extra `RUN:
<uuid>` line — a deliberate, disclosed content change (see Security Review), not a side effect hidden
from review.

## Security Review

Touches exactly one production file, confirmed **human-run, never invoked by the model**
(`wired-check.mjs`'s own STANDALONE classification for `record-lesson`, unchanged by this diff). No
hook, gate, or enforcement file touched. `randomUUID()` is a Node builtin, no new dependency or network
call. The one behavior change with a real (small) blast radius: every future stored lesson's persisted
value gains a trailing `RUN: <uuid>` line, which downstream `distill`/`search` steps (best-effort NLP
over free text) will see as noise rather than semantic content — reviewed against every other repo-wide
reader of `lessons`-namespace content (`grep -rn "record-lesson\|lesson-\${slug}\|'lessons'"`): the only
other readers are `lesson-store.mjs`'s ratified-lesson lifecycle (a wholly separate, JSON-file-backed
system unrelated to this raw AgentDB capture path) and prose/UI labels — none parse this exact value
string, so no downstream contract breaks.

## ADR

None. Bug fix to a diagnostic CLI's write-verification logic, not an architectural decision — no new
component, default, or cross-cutting policy. No ADR's `governs:` frontmatter lists
`scripts/record-lesson.mjs`.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation as every Dream
Cycle night since 2026-08-19). Full report is this file, committed in the candidate PR.

## Witness

```
SESSION_COMMIT = 7cfd9e1770a8583bda9cdc26c614b2de3a77f129
REPORT_HASH    = 6064b3c4f7b3628dfe8be5521d175bfebe70bbc2b59e7b14d9b61ceb6263e7c7
WITNESS        = ff47ca1a665b2fa6be3f7c174627a776ba13cf1369f31ff6434384d1c1db1ee3
```

5-step verifier: (1) `git log --follow -p -- docs/dream-cycle/2026-09-09-memory-durability-report.md`,
take this file's first commit (the placeholder-Witness version); (2) `sha256sum` that version, compare
to `REPORT_HASH`; (3) `git log` confirms `SESSION_COMMIT` was `main`'s HEAD at session start; (4)
concatenate `REPORT_HASH` + `SESSION_COMMIT`, `sha256sum` again, compare to `WITNESS`; (5) reproduce the
TEETH proof: `git stash push -- scripts/record-lesson.mjs && npx vitest run
tests/unit/record-lesson.test.mjs` (the new TEETH case fails red, 5/6 pass), `git stash pop && npx
vitest run tests/unit/record-lesson.test.mjs` (6/6 pass).

## Next steps

1. The review backlog itself: 24 `dream/*` PRs were closed unmerged on 2026-09-07, and the release-
   reconciliation path (fixes landing on `main` independent of any specific draft PR merging) is now
   confirmed, twice (#161/#163 via PR #269; #243/#245/#167 tonight), as the actual mechanism by which
   Dream Cycle work reaches `main`. Worth the owner's attention as a pattern, not a per-night finding.
2. `scripts/wired-check.mjs`'s exit 1 (four scripts flagged unwired, one duplicate `gate` exemption) is
   pre-existing and unrelated to this diff (confirmed byte-identical baseline vs candidate) — a
   standing gap, not chased tonight to keep this candidate to one conceptual change.
3. `tests/integration/unprompted-speech-registry.test.mjs`'s two failures (`bad.hooks.UserPromptSubmit`
   undefined) look like a hooks.json shape drift independent of tonight's surface — flagged for whichever
   rotation next lands on `cross-host-conformance` or `enforcement-integrity` to triage, not
   investigated further here (out of tonight's DEEP).
