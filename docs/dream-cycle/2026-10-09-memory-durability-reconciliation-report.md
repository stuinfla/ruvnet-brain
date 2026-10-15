# Dream Cycle 2026-10-09 — memory-durability reconciliation

## Rotation

```
DATE   = 2026-10-09
DAYINT = 20261009
SLOT   = 20261009 % 5 = 4  → DEEP=memory-durability
SCAN   = managed-boundary, round-trip-proof
BONUS  = none (20261009 % 25 = 9, % 75 = 59 — neither hits)
SESSION_COMMIT = 9cf8fe19a57671eb430ce7341b7b8bf123ccce75
```

`OPENROUTER_API_KEY` absent this container — `LLM_EVAL=blocked`. Irrelevant tonight: no
candidate needs a model call. `npm run eval:gate`: `no brain at /root/.cache/ruvnet-brain/kb`
(`stores 0 dark 0`, confirmed via `restore-local-ingests.mjs`/`store-root.mjs`) — same
never-materialized condition every night since 2026-08-19.

## Ledger check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31. Verified directly via GitHub
MCP, not assumed: the routine has fired every night since. The repo's history was squashed to a
single root commit on 2026-09-07 (per issue #274's own prior-night note), which orphaned every
pre-squash dream-cycle PR from GitHub's merge bookkeeping — but that does not explain the
post-squash record. Checked precisely tonight, independently of any PR title's self-report:

- `is:pr is:merged` (all-time): **123** merged pull requests, most recently `#417` on
  2026-10-07 — the regular engineering lane (`fix/*`, `feat/*`, `release/*`) is healthy and
  active.
- `is:pr is:open head:dream/`: **47** open draft PRs (49 before tonight's two closes), oldest
  `#269` (2026-09-08, 31 days old).
- None of the 123 merges is a `dream/*` branch. Historically, 4 dream-cycle PRs DID merge
  (`#143`, `#148`, `#150`, `#178`, `#215` — 2026-08-19 through 2026-08-31, all confirmed
  `merged:true` directly via `pull_request_read`), then **zero** since `#178` on 2026-08-26 (the
  last of that early batch) — **44 days** as of tonight.

**Sharper framing than prior nights' "0 ever merged" (that phrasing, in #419's own title, is
imprecise — 4 did merge, early on): the dream-cycle review lane was healthy for its first 8
days, then stopped completely, while the unrelated engineering lane never stopped.** This isn't
an inactive owner; `git log` shows direct owner commits as recently as 2026-10-05
(`88b27b13`, `fix(lessons): bind write verification to a fresh canonical receipt` — see below).
The dream-cycle PR lane specifically is the one channel that stopped being read.

## Learning signals applied (STEP 1.1)

Zero of the last 14+ candidate PRs merged → per this signal, tonight biases to reconciliation
(shrinking the open-PR count) over adding another unreviewed candidate. A tiny new candidate on
top of a 47-deep, 31-day-old unreviewed queue has near-zero marginal value until the queue itself
is addressed; closing stale/superseded items does not.

## Deep dive — memory-durability (reconciliation)

Checked every open memory-durability-surface issue/PR against current `main` before considering
new work, per the ISSUE DISPOSITION OVERRIDE.

**Issue #274** (2026-09-09, open 31 days): "`record-lesson.mjs`'s round-trip key is deterministic,
so a repeated identical invocation could alias a stale value." Its two candidate PRs, **#275**
and **#276**, both proposed a separate disposable-nonce-key probe to fix this.

**Found already resolved on `main`, via a different mechanism**, verified by reading current
source directly (not assumed):

```js
// scripts/record-lesson.mjs
const value = [ ... , `RECORDING: ${randomUUID()}` ].filter(Boolean).join(' ');
...
const back = ruflo(['memory', 'retrieve', '-k', key, '-n', ns, '--value-only', '--path', db]);
stored = String(back) === value;
```

Commit `88b27b13` (`fix(lessons): bind write verification to a fresh canonical receipt`,
authored directly by the repo owner, 2026-10-05) embeds a fresh `randomUUID()` into the
*canonical* value on every invocation, rather than #275/#276's separate probe key. Same
hypothesis satisfied by a different, already-shipped design: because the canonical value is now
unique per invocation, a second identical invocation whose store silently no-ops can no longer
alias a stale prior value.

**Verified tonight**, not inferred from the commit message: `npx vitest run
tests/unit/record-lesson.test.mjs` → **8/8 pass** on current `main`@`9cf8fe1`.

**Action taken**: closed issue #274 as completed, and closed PRs #275/#276 without merging
(superseded, not wrong) — each with the evidence above, per this repo's `closeIntegratedWork`
policy. `scripts/record-lesson.mjs` is not touched by this PR; nothing here duplicates work
already on `main`.

**Checked and still valid** (no action — genuinely unresolved, correctly still open):

- **#379** (2026-10-04): `plugin/scripts/lesson-promote.mjs`'s `applyPromotion()` still performs
  an in-place `fs.writeFileSync(file, next)` at line 230 of current `main` — confirmed by reading
  the file directly tonight. The non-atomic-write defect #379 describes is real and unfixed on
  `main`; #379's candidate fix (temp-file + `fs.renameSync`, mirroring `bin/install.mjs`'s
  `offerClaudeMd()`) remains applicable as written. Not revived or duplicated here — it is
  already an open, undisposed PR; re-implementing it would be exactly the kind of wasted,
  unreviewable duplication this reconciliation pass exists to avoid.
- **#345** (2026-09-29, outbox trailing-newline drop), **#323** (2026-09-24, WAL sidecar
  vivification), **#289** (2026-09-14, agentdb-fleet-doctor checkpoint round-trip): spot-checked
  titles/diffs against current `main`'s equivalent code paths; none show evidence of having
  landed by another route. Not exhaustively re-verified line-by-line tonight (budget, STEP 0.6) —
  flagged for a future reconciliation pass, not asserted as still-valid beyond this check.

No new, previously-unreported memory-durability defect is reported tonight. Per ADR-068, "a
rejected hypothesis with a clean measurement is a successful night" — a reconciliation night that
closes 3 stale GitHub items and leaves an honest map of what's still real is the same category of
success, and adds zero items to the open-PR count other than this report itself.

## Evaluation Receipt

No code candidate tonight — reconciliation only. The one quantitative claim (record-lesson fix
verified) is witnessed above with a direct test run, not inferred.

## Darwin Results

Not run — no candidate to evolve.

## Evidence

OBSERVATION (#274/#275/#276 open, propose a nonce-key fix) → OBSERVATION (current `main` already
contains a different fix for the same hypothesis, commit `88b27b13`) → MEASUREMENT
(`record-lesson.test.mjs` 8/8 pass on `main`) → DECISION (close #274/#275/#276, reconciled).
OBSERVATION (`lesson-promote.mjs` line 230 still in-place `writeFileSync`) → DECISION (#379
remains valid, no action).

## Reward-Hack Check

No benchmark, gold answer, or threshold touched. No code candidate exists to critique for
reward-hacking; the only claims made are about GitHub issue/PR state and test results, both
independently re-run or re-read tonight rather than taken from a prior PR's self-report.

## Security Review

No code change in this PR beyond a committed report and the ledger row. The three GitHub
state-changes (issue close, two PR closes) are read-then-close actions on items this same
automated lane created; no credential, dependency, or write path touched.

## Scan Findings

**managed-boundary**: no new finding tonight; #379 (still open) is the live managed-boundary gap
on this surface (`lesson-promote.mjs`'s write to the user's global `~/.claude/CLAUDE.md` bypasses
the atomic-rename convention `bin/install.mjs` already uses for the same file).

**round-trip-proof**: tonight's reconciliation (#274) is the finding for this scan — now resolved
on `main`, confirmed rather than assumed.

## Competitors

Not re-researched tonight — no new candidate to benchmark against. #274's own competitor table
(OpenHands, DSPy/GEPA, SWE-agent, Cursor background agents, Sakana AI Scientist) stands unchanged;
no competitor evidence bears on a reconciliation-only night.

## Gist

LOCAL — no `gh` CLI or gist-creation tool available this session (same limitation as every prior
night). This report is the full record, committed directly.

## Witness

```
SESSION_COMMIT = 9cf8fe19a57671eb430ce7341b7b8bf123ccce75
REPORT_HASH    = 7cd5fa28624d4b4aa19c86db2bc23cbbcb43c97294e5e3de17dfa6ba739b14e3
WITNESS        = fb7c7383b60cb4ba206d9140394a0251dd64a8bf82d84a53c503c62fd476a7a6
```

Verify: (1) checkout `9cf8fe19a57671eb430ce7341b7b8bf123ccce75`; (2) re-read this file's content
as committed in this PR; (3) `sha256sum` it, confirm `7cd5fa28...`; (4) `printf '%s%s'
<report-sha256> 9cf8fe19a57671eb430ce7341b7b8bf123ccce75 | sha256sum`, confirm `fb7c7383...`;
(5) `npx vitest run tests/unit/record-lesson.test.mjs` on `main`, confirm 8/8 pass (the fix this
report cites is already there, not introduced by this PR).

## Recommendation

`evaluated: n/a (reconciliation, no code candidate)`. **Human action recommended, repeated from
#378/#411/#419 because it has not yet been acted on**: the dream-cycle PR lane has 47 open drafts
across 31+ days with zero merges in the last 44, while the regular engineering lane merges
routinely (123 total, most recently 2 days ago). Three options stand, unchanged from #378: a
batch-review pass, a reduced rotation cadence (`dream.config.json`'s `cron`), or a deliberate
triage/close pass like tonight's, scaled up. Doing nothing means the queue keeps growing by one
PR per night indefinitely.

## Merge Policy

**Human review required.** This session never self-merges and never autonomously promotes
candidate state. Draft, by design — `autoMerge: false` is the decision, not a default.
