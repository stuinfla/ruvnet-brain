# Cross-Host-Conformance SOTA Report — 2026

**Dream Cycle 2026-08-30 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## TL;DR

Issue #134's fix pinned the learn-queue writer (`plugin/scripts/learn-capture.sh`) and its two readers
(`plugin/scripts/learn-flush.mjs`, `scripts/health-repair.mjs`) to a shared rule —
`RUVNET_BRAIN_PROJECT_DIR || cwd` — so a shell that drifted below the project root mid-session (any tool
call that `cd`'s) would not orphan captured events. `RUVNET_BRAIN_PROJECT_DIR` is, in production, never set
by either host's real hook dispatcher: `plugin/scripts/hook-shim.mjs` (Claude Code) forwards
`process.env` to the hook body unmodified, and `plugin/scripts/codex-hook-adapter.mjs` (Codex) builds its
own env block and never includes it. A repo-wide grep confirms the only non-test writer is
`health-repair.mjs`'s own self-referential passthrough to a child it spawns. So the fix silently degraded
back to the pre-#134 pattern — the writer's and each reader's OWN per-invocation `cwd`, which can differ
across two hook events in the same session — in every real installation on both hosts, while the repo's own
`tests/unit/learn-capture-project-root.test.mjs` kept reporting green because it manually injects the
never-actually-set variable. `CLAUDE_PROJECT_DIR` is the project-root signal both hosts genuinely provide
on every invocation (native on Claude Code; explicitly derived from `input.cwd` by
`codex-hook-adapter.mjs:98`), and this repo already has a purpose-built, tested function for consuming it
safely — `projectDirectory()` in `plugin/scripts/project-identity.mjs`, born from bugs #85/#107, which
trusts `CLAUDE_PROJECT_DIR` only when the current directory actually lies inside it. The fix reuses that
function in the two Node readers, and applies the identical containment discipline (string-prefix, to
honour `learn-capture.sh`'s own documented no-process-spawn contract) in the bash writer.

## What's new

Nothing external — a sibling-defect closure inside this repo's own cross-host hook-dispatch layer,
discovered by tracing which environment variables each real dispatcher (`hook-shim.mjs`,
`codex-hook-adapter.mjs`) actually sets versus which ones the three project-root readers consult.

## Competitors — how other autonomous coding/nightly-evolution harnesses handle host-parity claims proven only inside their own test doubles (grade C: general knowledge, single-source per row; informs framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | No multi-host installation surface to reconcile; not directly comparable. | C |
| OpenHands | Runs in a single sandboxed runtime per session; no cross-host env-variable-parity concept. | C |
| DSPy/GEPA | Optimizes a program against a metric; a test that injects the variable it's supposed to prove is set is the same class of degenerate-signal problem GEPA's designers warn about for reward functions, not something the framework itself checks for. | C |
| SWE-agent | Tool-call failures surface as raw observations; no first-class "does the fix actually run in production dispatch" check beyond the test suite itself. | C |
| Cursor background agents | Single-host (its own remote environment); no analogous host-parity claim to falsify. | C |

The recurring pattern: a test injecting the very signal it exists to prove is present is a general blind
spot, not specific to this repo. This repo's own ADR-068 STEP 10 ("did it exploit the evaluator... rely on
an undocumented [test-only] setup") is the discipline that would have caught this by design — applied
retroactively here to a test written before that discipline existed.

## Hypothesis (frozen before implementation, unchanged since)

> Given a PostToolUse/SessionEnd learn-queue hook invocation on either host where the shell's cwd has
> drifted below the project root, when `RUVNET_BRAIN_PROJECT_DIR` is unset (true on every real production
> hook dispatch on both hosts) and `CLAUDE_PROJECT_DIR` is consulted via `projectDirectory()`'s
> containment-checked resolution ahead of raw `cwd`, then the writer and readers should agree on the
> project root and stop orphaning captured events, relative to baseline (direct fallback to `cwd`), subject
> to: no behavior change when `RUVNET_BRAIN_PROJECT_DIR` IS explicitly set; no behavior change when
> `CLAUDE_PROJECT_DIR` is also absent; and an unrelated `CLAUDE_PROJECT_DIR` that does not contain `cwd`
> must never overrule it.

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate` not run (this surface has no model-graded stage;
LLM_EVAL not blocked, `OPENROUTER_API_KEY` present, simply not applicable to deterministic path
resolution). `npm run claims:verify` not run (no advertised claim touches this surface).

**Guard proven to fail first (TEETH).** Added the residual-gap test case to
`tests/unit/learn-capture-project-root.test.mjs` BEFORE writing the fix and ran it against unmodified
`main`:

```
AssertionError: CLAUDE_PROJECT_DIR must anchor the queue when the shell has drifted: expected [] to not deeply equal []
```

i.e. on current code, with the real-production env shape (`RUVNET_BRAIN_PROJECT_DIR` unset,
`CLAUDE_PROJECT_DIR` set, cwd drifted), the queue is silently orphaned — reproducing #134/#104 live.

**Restored the fix** (`plugin/scripts/learn-capture.sh`, `plugin/scripts/learn-flush.mjs`,
`scripts/health-repair.mjs` — reusing `project-identity.mjs`'s `projectDirectory()` in the two Node files
rather than a hand-rolled fallback chain, plus a containment-checked bash equivalent in the writer) and
re-ran: **4/4 in the target file, including a new containment-negative case** (an unrelated
`CLAUDE_PROJECT_DIR` that does not contain `cwd` must not overrule it — guards against reopening #85/#107's
class of bug). Updated `tests/unit/learner-scope-agreement.test.mjs`'s exact-source-pin assertion to match
the new (still-agreeing) resolution line — the semantic checks above it (HOME never trusted, PROJECT
literally used) are unchanged.

**Full targeted regression sweep** (13 unit files touching the changed code — hook dispatch, codex wiring,
health-repair, learn-capture/flush, hook registry, ruflo resolution): **204 passed, 6 skipped, 1
pre-existing failure** (`hook-shim-fallback-once.test.mjs`'s chmod-based EACCES fixture, confirmed
pre-existing by running it against a `git stash`-clean `main` — fails identically, unrelated to this
candidate: this container runs as root, where `chmod 0o000` does not restrict root's own access).

**`npx vitest run tests/integration`**, baseline (clean `main`) vs candidate, run independently (not
diffed via stash, to avoid any stash-related state leakage): **byte-identical — 5 failed files / 9 failed
tests / 240 passed / 11 skipped / 53 todo of 313, on both.** All 9 failures pre-existing/environmental
(`sqlite3` binary missing, `@xenova/transformers` package missing — this container has neither), none touch
the three changed files.

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete containment-check fix.

## Evidence

OBSERVATION (grep: zero production producers of `RUVNET_BRAIN_PROJECT_DIR` outside a self-referential
passthrough) → MEASUREMENT (new TEETH case red pre-fix with the real-production env shape, green post-fix;
regression sweep and integration byte-identical to baseline) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

No gold data or benchmark corpus touched. The one existing assertion changed
(`learner-scope-agreement.test.mjs`'s exact-source-pin regex) was widened to match the new, still-correct
resolution line — the semantic guarantees above it (HOME never trusted for a project-scoped remedy, PROJECT
used literally) are untouched, and this is the same class of update the repo's own 08-19/08-26 ledger rows
already treat as legitimate source-pin maintenance, not weakening. The new tests were shown RED before the
fix. An adversarial self-check caught and corrected an initial, weaker version of this candidate mid-session
(see Security Review) rather than shipping it. CLEAR.

## Security Review

**On the candidate itself.** The first draft of this fix trusted `CLAUDE_PROJECT_DIR` unconditionally
(`RUVNET_BRAIN_PROJECT_DIR || CLAUDE_PROJECT_DIR || cwd`, no containment check) — re-reading
`project-identity.mjs`'s own header (bugs #85/#107: "an unrelated declared root must never overrule a cwd
it does not actually contain") surfaced that this would reopen exactly that class of bug: a stale or
unrelated `CLAUDE_PROJECT_DIR` silently redirecting where project-scoped learning data is written. Revised
to reuse `projectDirectory()` (the existing, tested containment-checked resolver) in the two Node files,
and to apply the identical string-prefix containment check in the bash writer — closing the gap rather than
shipping a narrower, less-safe fix. New containment-negative test proves this holds. No new dependency,
network call, or credential; the change only affects which local, already-writable directory a purely
local, already-existing write lands in.

**Unrelated to the candidate, from this session's own operation.** While probing this container for
`OPENROUTER_API_KEY` presence (STEP 0.5's credentials reality check), a bash quoting mistake
(`${VAR:+yes}${VAR:-no}` collapsed to the value, not a yes/no) printed the live key into this session's own
tool-output transcript. Reported to the repo owner directly and immediately (before this candidate was
implemented), with a rotation recommendation. **This is the SECOND time this exact mistake has happened in
a Dream Machine session** — the 2026-08-26 report (`docs/dream-cycle/2026-08-26-brain-currency-report.md`)
records the identical leak, also self-reported, also with a rotation recommendation. Whether that key was
actually rotated after 08-26 is not verifiable from this repo. Recommend the pipeline itself gain a standing
rule against ever interpolating a credential-bearing variable's VALUE into a shell command for a
presence check (masked/length-only checks only, e.g. `[ -n "$VAR" ]` alone, never `${VAR:-...}` chained
after `${VAR:+...}`) — this is now a repeating operational defect in the routine's own STEP 0.5, not a
one-off, and is flagged in the ledger row and issue below rather than only in this report.

## Scan findings

**codex-parity.** The core finding above IS the codex-parity gap: `codex-hook-adapter.mjs` derives
`CLAUDE_PROJECT_DIR` from `input.cwd` and never sets `RUVNET_BRAIN_PROJECT_DIR`, so Codex and Claude Code
were BOTH silently relying on per-invocation `cwd` for the learn-queue's project-root resolution — the bug
is symmetric across hosts (both broken identically), not a divergence between them, which is itself worth
recording: cross-host-conformance findings are not always "host A differs from host B."

**stranger-project-behaviour.** This is exactly the surface a fresh install in someone else's project would
hit: any tool call that `cd`'s during a session (a build, a test run inside a subdirectory) orphans that
session's learning-queue entries in a project that has never adopted `RUVNET_BRAIN_PROJECT_DIR` (nothing
sets it anywhere), silently, with no error — the queue simply accumulates in the wrong place and
`learn-flush.mjs` never sees those entries at `SessionEnd`.

## Governance note (not this candidate's problem, flagged for the human owner)

As of tonight, **14 dream-cycle-labelled PRs are open and draft** (#157, #159, #162, #164, #167, #168,
#172, #174, #176, #182, #184, #186, #188, #190), and **zero dream-cycle PRs have merged since #150/#148 on
2026-08-20** — ten calendar days, roughly one new candidate per slot per night with no merges keeping pace.
Per STEP 1.1's own learning signal ("zero of the last 14 candidate PRs merged → bias to a tiny,
easily-reviewable candidate"), tonight's candidate was deliberately kept small (three one-line-equivalent
production changes plus tests, 74 insertions / 8 deletions) in response. The backlog itself is not a code
defect this candidate can fix; it is a review-capacity signal worth the owner's direct attention,
independent of tonight's finding.

## Next steps

1. Apply the same `projectDirectory()`-reuse idiom to any *other* future "which project is this" resolution
   this repo introduces, rather than a fresh hand-rolled `env-var || cwd` each time.
2. Consider whether `codex-hook-adapter.mjs` should also set `RUVNET_BRAIN_PROJECT_DIR` explicitly (not
   just `CLAUDE_PROJECT_DIR`) so the two hosts' env shape converges further — deferred tonight to keep the
   diff to one conceptual change.
3. The credential-echo mistake in STEP 0.5 has now recurred once (08-26 → 08-30); worth a standing
   guard in the compiled routine itself (`dream.config.json` / the upstream `dream-machine` engine), not
   just a per-night self-report, since a self-report that recurs is not yet a fix.
4. Governance: the 14-PR review backlog (see above) — not actionable by this candidate, flagged for the
   owner.

## Witness

```
SESSION_COMMIT = 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f
REPORT_HASH    = e0691b91a9ae723aba255a1a585b7f788b4ff1ab4f4dfa9fd47634f9a99f87f7
WITNESS        = 9d5ae42dc17cef1f2d5d6c12956aeb2a23d45d8160c490ff0d7c76d261560938
```

`REPORT_HASH` is the sha256 of this report's content as it stood through "Next steps", computed BEFORE
this Witness section was written (STEP 16's own chicken-and-egg order: stamp, then rewrite the Witness
section with the stamp). It will therefore NOT match a fresh `sha256sum` of this file as it now reads —
appending this section changed the bytes. That is expected by construction, not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout 486a144dbc9bd5fa3b8b715e0c13935d1add0f1f` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. Revert only `plugin/scripts/learn-capture.sh`, `plugin/scripts/learn-flush.mjs`,
   `scripts/health-repair.mjs` (keep the test file changes), re-run
   `tests/unit/learn-capture-project-root.test.mjs` — the "ISSUE #134 RESIDUAL" case must fail with
   `expected [] to not deeply equal []`.
5. Restore the fix, re-run the same file (4/4 green) plus the 13-file targeted regression sweep listed
   above, then `npx vitest run tests/integration` and confirm the same 5-failed-file/9-failed-test/
   240-passed/11-skipped/53-todo split reported above.
