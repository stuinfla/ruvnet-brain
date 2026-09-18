# Memory-Durability SOTA Report — 2026

Dream Cycle 2026-09-18 — rotated DEEP=`memory-durability`, SCAN=`managed-boundary`,`round-trip-proof`
(slot 4 of 5). No bonus modulus tonight (`20260918 % 25` = 18, `% 75` = 43, both non-zero).

## Rotation note (STEP 1.1 learning signal)

`20260918 % 5 == 3` maps to `grounding-quality`. That surface's live, reproducible finding —
citation-rank hijacking in `kb/verify-citation.mjs`'s `parseCitations()` — has now been raised on
**three** separate nights without a shipped fix: 2026-08-28 (security review, residual risk named),
2026-09-03 (`ADR-0076`, direction-forcing ADR opened, Proposed), 2026-09-13 (`ADR-0087`, same content
recovered from a lost PR, still Proposed, no Option A/B decision made). Per this repo's own STEP 1.1
rule ("a finding repeated in ≥3 prior nights → rotate to the next slot's DEEP surface"), tonight
rotates to slot 4's `memory-durability` instead of re-treading `grounding-quality` a fourth time with
no new evidence to add. `ADR-0087` remains open and unresolved; it is not this report's finding, but
it is flagged again below as still awaiting an owner decision.

## TL;DR

`scripts/onboarding-console.mjs`'s `sessionHookExists()` — the check behind the Memory-quality
card's `sessionSurfacing` dimension — accepted **any** `~/.claude/hooks` directory as proof that
"the global SessionStart hook surfaces project state at launch," not just the presence of the
specific recall hook (`agentdb-ensure.sh`) that claim depends on. A machine whose hooks directory
holds only an unrelated script (a different plugin, a stale leftover from an uninstalled tool) would
score `sessionSurfacing: ok` — the exact "scored from an assumption, not a measurement" shape this
file's own house rule (DDD context 6, `console-engine.mjs`) exists to forbid, and the same failure
family as the cross-host hook-wiring gaps ADR-068 itself cites as this repo's motivating incidents.
Zero test coverage existed for this function before tonight.

## What's new

Fixed by removing the directory-existence fallback; `sessionHookExists()` now checks only for the
specific hook script. 1 production file touched (comment + one-line condition change), 1 new test
file (3 cases). No format, schema, or benchmark touched.

## Competitors (how peer systems verify a "wired" hook/plugin claim)

| System | Grade | How it verifies "installed" claims |
|---|---|---|
| OpenHands | B | Registers tool/skill availability via an explicit manifest lookup, not directory presence, before advertising a capability as active. |
| SWE-agent | B | Tool availability is derived from its own registered-command table, not filesystem globbing of a plugin directory. |
| Cursor background agents | C | Vendor docs describe capability gating by explicit feature flags rather than inferring from installed-file presence; not independently re-verified beyond the framing. |
| DSPy/GEPA | C | Module availability checked by successful import/registration, not by a loosely-related directory existing. |
| Sakana AI Scientist | C | Pipeline stage availability gated on the specific artifact the stage consumes existing, not a sibling directory. |

Grade key: A = reproducible/official, B = vendor cross-checked, C = single-source/general framing.
No C-grade row alone justified tonight's fix — it is a self-contained, internally reproduced defect.

## Hypothesis

> Given `scripts/onboarding-console.mjs`'s `sessionHookExists()`, whose OR-clause treats the mere
> existence of `~/.claude/hooks` (any contents) as equivalent to the specific recall hook
> `~/.claude/hooks/agentdb-ensure.sh` being installed, when a machine has a hooks directory holding
> only an unrelated script and lacks `agentdb-ensure.sh`, then the `sessionSurfacing` memory-health
> dimension currently reports `status: ok` (a false positive) even though the specific claim it
> renders — "the global SessionStart hook surfaces project state at launch" — is false for that
> machine; removing the directory-existence fallback so only the specific hook file is checked
> should make `sessionSurfacing` correctly report non-`ok` in that scenario, subject to: the
> already-correct case (the real hook file present) is unaffected, and no other `MEMORY_DIMENSIONS`
> probe or its scoring changes.

Frozen before implementation; unchanged since.

## Evaluation Receipt

**TEETH, proven to fail first.** New file `tests/unit/console-session-surfacing-hook-check.test.mjs`
(3 cases), run against unmodified `main` (`3996f50`): 1/3 fails — a `.claude/hooks` directory holding
only `some-other-hook.sh` (no `agentdb-ensure.sh`) scores `sessionSurfacing: ok`. The other 2 cases
(no hooks directory at all; the real hook file present) already passed on baseline. After the fix:
3/3 pass.

- `npm run version:check`: `4.3.26` agrees on every surface.
- `npm run wired:check`: exit 0, unaffected (this file is not a hook body).
- `node scripts/doc-currency.mjs --check --changed HEAD`: 0 blocking violations; no ADR governs this
  file.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior night since
  2026-08-19 (brain-not-installed class SKIPs; this candidate does not touch any claimed metric).
- `npm run eval:gate`: not applicable — `no brain at /root/.cache/ruvnet-brain/kb` (store root never
  materialized on this container, same condition every night since 2026-08-19); this is a
  memory-durability diagnostic fix, not a retrieval-quality change, so the held-out set could not and
  should not grade it regardless.
- `npx vitest run tests/integration`: 9 files / 23 tests fail, all pre-existing and environmental
  (`sqlite3` CLI absent — confirmed via `apt-get install sqlite3` failing with a 404 from the
  container's package mirror; `@xenova/transformers` cross-encoder cache requires a real network
  fetch this container's proxy does not permit for that host). Re-ran the identical suite against
  unmodified `main` before touching any file: same 9 files / 23 tests failed, byte-identical test
  names. None reference `onboarding-console.mjs`, `sessionHookExists`, or `sessionSurfacing` —
  confirmed by `grep -rl sessionHookExists\|sessionSurfacing` across the repo, which returns exactly
  `scripts/console-engine.mjs` (the scoring consumer, unaffected — it only reads a `status` string),
  `scripts/onboarding-console.mjs` (the candidate), `scripts/console-engine.test.mjs` (synthetic
  probe fixtures, unaffected), and this PR's new test file.
- Targeted regression run: `console-session-surfacing-hook-check` (new, 3/3), `console-honest-cards`
  (13/13), `console-honesty-regressions`, `console-gates-registered`, `scripts/console-engine.test.mjs`
  all green. `console-memory-canonical-store.test.mjs`: 4/6 fail, identical on baseline and candidate
  (same `sqlite3` CLI absence as above — confirmed by `git stash` and re-running against unmodified
  `main`).

## Baseline

Baseline = unmodified `origin/main` at `3996f502b18157fdc84e325fbe87c2a05351d58c` (this session's
starting commit, re-confirmed via `git fetch`/`git pull` before any file was touched — the container's
initial checkout was one commit behind origin when the session started).

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean existence check; same precedent as every
prior memory-durability night (2026-08-19, 2026-08-24, 2026-09-09, 2026-09-14).

## Evidence

OBSERVATION (`sessionHookExists()`'s OR-clause accepts any `.claude/hooks` directory) → MEASUREMENT
(new TEETH test reproduces the false positive against unmodified `main`: 1/3 red) → DECISION (remove
the directory-existence fallback; keep the specific-file check unchanged) → MEASUREMENT (3/3 green
post-fix; identical baseline/candidate results on `test:integration`, `claims:verify`, `version:check`,
`wired:check`, `doc-currency`).

## Reward-Hack Check

No benchmark, gold answer, or threshold touched — this is a diagnostic probe used only for a
human-facing health score, not an evaluator input. The fix strictly narrows what counts as `ok`
(removes a false-positive path); it cannot introduce a false negative in the correctly-wired case,
which the third test case (`the real recall hook script present IS reported ok`) already covered and
still passes.

**Independent adversarial critic** (fresh `general-purpose` agent, not this candidate's author) —
verdict **CLEAR**. Independently reproduced the TEETH red→green cycle by swapping in `main`'s own
version of `sessionHookExists()` against the new test (1/3 red, matching the claim exactly) then
restoring the candidate (3/3 green) — not merely re-running the candidate's own claim. Confirmed
`sessionHookExists` has exactly one caller repo-wide (`probeMemory`) and no other definition.
Checked for a legitimate reason a bare `.claude/hooks` directory should count (a renamed/legacy hook
file this fix might have missed): found one adjacent mechanism, the plugin's own
`project-progression-session-start.mjs` (wired via `plugin/hooks/hooks.json`, a separate dispatch
path from the global `~/.claude/hooks/` directory this probe checks) — neither the old nor the new
code ever checked for it, so this fix does not newly ignore it; it is a pre-existing scope question
for a future night, not a regression introduced tonight. Confirmed the positive-path `fs.existsSync`
call is byte-identical to before (same path, same symlink/executable-bit/empty-file semantics) — only
the extraneous OR branch was removed, so no new false negative is possible for the correctly-wired
case. Confirmed no reward-hacking shape (`sessionSurfacing` feeds only the display-only health card,
weight 15/100, never `eval:gate` or any promotion criterion) and no new attack surface (still one
read-only `fs.existsSync` on a fixed, non-attacker-controlled path). No unresolved signal.

## Security Review

No new attack surface. `sessionHookExists()` remains a read-only `fs.existsSync` check on a
fixed, non-attacker-controlled path (`~/.claude/hooks/agentdb-ensure.sh`); the change only removes a
weaker, broader existence check, never adds a new filesystem read or a new trust boundary. No
credentials, network calls, or mutation involved. `npm run wired:check` confirms `onboarding-console.mjs`'s
hook-adjacent logic remains outside the actual hook-dispatch table (this function only *reports on*
hook presence for the health card; it does not register, invoke, or gate any hook itself).

## Scan Findings

**`managed-boundary`**: no new finding beyond the candidate — `resolveMemoryDb()`/`memoryStores()`
(the actual store-selection logic within the managed AgentDB boundary) were re-read and are
unaffected by this change; both remain scoped to `.swarm/memory.db` / `.swarm/agentdb-memory.db`
under the resolved project root, consistent with PR #127/#186's established boundary rules.

**`round-trip-proof`**: this candidate IS the round-trip-proof finding — `sessionSurfacing`'s
rationale (`console-engine.mjs`'s `MEMORY_DIMENSIONS`) claims the SessionStart hook "surfaces project
state," a behavioral claim, while the probe itself checked only file *presence*, never that the hook
actually runs or feeds anything at session start. Tonight's fix closes the specific false-positive
this candidate could prove (a look-alike directory); it does **not** make `sessionSurfacing` a true
end-to-end round-trip probe (that would require actually invoking a SessionStart hook path and
observing its output, a larger change out of scope for a tiny nightly candidate — flagged as a next
step below, mirroring `recallQuality`'s own honest `notTested` precedent in the same file).

## Competitors

See table above.

## Backlog observation (not tonight's finding, carried forward for the owner)

Re-checked via GitHub MCP rather than assumed: as of tonight, at least 16 `dream/*` draft PRs are
open and unmerged spanning 2026-09-08 through 2026-09-17 (#269, #270, #275, #276, #278, #280, #281,
#282, #287, #288, #289, #291, #292, #293, #294, #295), on top of the longer-running backlog this
ledger has flagged in every row since 2026-08-26. `ADR-0087` (citation-rank hijacking,
grounding-quality) remains `Proposed` with no Option A/B decision after three nights. This is the
single largest lever available to this system right now — verified, TEETH-proven fixes are
accumulating faster than they are reviewed — and is outside this session's authority to resolve
(`autoMerge: false` is deliberate; ADR-068).

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation every Dream
Cycle night since 2026-08-19). Full report committed at
`docs/dream-cycle/2026-09-18-memory-durability-report.md`.

## Next steps

1. Promote `sessionSurfacing` from a presence check to a real round-trip probe (mirroring
   `recallQuality`'s honest `notTested` default) — actually exercise the SessionStart hook path in a
   sandboxed session and confirm output, rather than checking for a file.
2. An owner decision on `ADR-0087` (Option A: per-query unguessable token, or Option B: structured
   JSON citation transport) would let a future grounding-quality night finally ship a fix instead of
   re-flagging the same residual risk a fourth time.
3. The `dream/*` PR review backlog (16+ open drafts, oldest from 2026-09-08) is now large enough that
   a dedicated reconciliation pass — distinct from any single night's new-finding work — would likely
   recover more verified value than another night's new candidate.
4. Independent critic (see Reward-Hack Check) surfaced a scope question worth a future night's
   attention: `plugin/scripts/project-progression-session-start.mjs` is a second, separate
   SessionStart dispatch path (wired via `plugin/hooks/hooks.json`) that `sessionSurfacing` never
   checks at all — this fix does not regress that (neither old nor new code checked it), but a
   machine relying solely on that path would score `sessionSurfacing` as absent even though a
   different, real recall mechanism is active.

## Witness

```
SESSION_COMMIT = 3996f502b18157fdc84e325fbe87c2a05351d58c
REPORT_HASH    = 9d7fb6beae3747c50252d538ff3f4e5f554908877c81fa9b86d0a976974d9dd5
WITNESS        = a97569c2c990f9ad6fb7c0609ffdd889bc30e311dd80095ca0531a2008b294db
```

Note: `REPORT_HASH` above is the sha256 of this file's content up to (not including) this Witness
section's final values — i.e. computed once on the draft, then written back in, per this repo's own
established convention (every prior night's report does the same: the hash cannot include the hash).

Verifier procedure: (1) checkout `SESSION_COMMIT`; (2) `git stash push -u -- scripts/onboarding-console.mjs`;
(3) run `npx vitest run tests/unit/console-session-surfacing-hook-check.test.mjs` and confirm exactly
1 of 3 cases fails; (4) `git stash pop`; (5) re-run and confirm 3/3 pass, then
`sha256sum docs/dream-cycle/2026-09-18-memory-durability-report.md` and compare to `REPORT_HASH`
above, and `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` to compare to `WITNESS`.
