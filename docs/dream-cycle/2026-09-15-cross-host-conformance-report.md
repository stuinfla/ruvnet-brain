# Cross-Host-Conformance SOTA Report — 2026

**Dream Cycle 2026-09-15 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## TL;DR

PR #278 (2026-09-10) audited this surface and found no gap. Since then, three days of real,
substantive change landed directly on `main` (2026-09-11/12, human-authored): `decision-gate`'s
write route and `grounding-stamp` were extended to Codex (`ef2b8e12`), plus a new Stop-time
"answered without searching" gate (`grounding-turn-mark`/`grounding-turn-gate`). The author's own
commit messages are unusually rigorous — "MEASURED, not assumed" — and explicitly name one
remaining sub-gap they declined to close without live evidence: `decision-gate`'s bash route
(Codex `exec_command`) is still Claude-only. This container has no `codex` CLI, so that specific
evidence could not be extended tonight, and re-deriving the same conclusion the author already
reached would not be new work.

What tonight's research actually found: `docs/adr/0084-the-three-user-invariants.md` — the ADR
that `governs:` exactly the files that changed (`plugin/hooks/hooks.json`,
`plugin/hooks/codex-hooks.json`, `plugin/scripts/continuity-hook-policy.mjs`) — still stated the
Codex-parity gap as fully open, three days after `ef2b8e12` partially closed it. This repo's own
`node scripts/doc-currency.mjs --check` flags this as `presumed-stale` (a BLOCK-level finding) on
current `main`, independent of anything this session did. Reconciled the ADR's text with current
source and verified the finding clears.

## What's new

Nothing external. A doc-currency reconciliation inside this repo's own governance layer, found by
reading the diffs of every commit that touched this DEEP surface's files since PR #278's last
audit, then cross-checking the ADR that declares itself their governor.

## Competitors — how other autonomous coding/nightly-evolution harnesses handle a governing document drifting behind the code it governs (grade C: general knowledge, single-source per row; informs framing only)

| System | Relevant stance | Grade |
|---|---|---|
| Sakana AI Scientist | Produces a paper per idea; no persistent governing-document-vs-code currency concept across runs. | C |
| OpenHands | Session-scoped; no cross-session doc-governs-code contract to go stale. | C |
| DSPy/GEPA | Optimizes a program against a metric; no analogous "does the design doc still describe the code" check. | C |
| SWE-agent | Issue-scoped patches; no standing doc-currency gate comparable to `doc-currency.mjs`. | C |
| Cursor background agents | No published mechanism that measures governing-doc staleness against `git log` of the paths it names. | C |

## Hypothesis (frozen before verification)

> Given the 2026-09-11/12 hook changes that extended `decision-gate`'s write route and
> `grounding-stamp` to Codex and added the Stop-time grounding check, when the cross-host and
> stranger-project test families are re-run and the governing documentation for those files is
> checked against `main`'s own `doc-currency.mjs` evaluator, then a reproducible gap will be found,
> subject to: any gap found must be reproduced against current `main` source, not inferred from the
> diff alone.

## Testability gate

Testable tonight. `doc-currency.mjs --check` is a real, pre-existing evaluator (not invented for
this finding) that returns a structured BLOCK/WARN verdict per document, so the before/after state
is machine-checkable, not narrative.

## Candidate

`docs/adr/0084-the-three-user-invariants.md` only — no production code. Updated Invariant 2's
"Known gap" paragraph to match current source (dual-host `decision-gate` write route +
`grounding-stamp`, new Stop-time check; bash/`exec_command` route explicitly still open, matching
`ef2b8e12`'s own disclosure) and added a Currency log row naming the six commits reconciled and the
tests re-verified. Bumped `updated:`/`version:` in frontmatter. ~13 lines changed, one file.

## Baseline vs Candidate (real evaluator: `node scripts/doc-currency.mjs --check --changed main`)

- **Baseline** (pre-candidate, `main`@`35fbe03`): `adr/0084-the-three-user-invariants.md` →
  `presumed-stale · 1 BLOCK · 2 warn`. Reason: "governed code moved 3 commit(s) (2d) after the
  document's own last commit (2026-09-12)."
- **Candidate** (this session's commit `59e5315e`): `adr/0084-the-three-user-invariants.md` →
  `current · 2 warn`. The `presumed-stale` BLOCK is gone; the 2 remaining warns
  (`built-not-wired` on `docs/ddd/0021-corpus-supply-chain-context.md`, pre-existing) are
  unrelated to this change and untouched.
- Overall repo-wide `doc-currency.mjs --check` still exits 1 both before and after this candidate —
  the remaining findings are against unrelated `corpus-seed`/ADR-0086 documents (0058, 0060, 0062,
  0069, 0070, 0072, 0085), out of scope for tonight's DEEP surface and left untouched by design, not
  by oversight. Only ADR-084's specific finding is claimed fixed here, verified directly by name,
  not by a repo-wide count.

## Evaluation Receipt

- `npx vitest run tests/unit/codex-claude-hook-parity.test.mjs tests/unit/grounding-turn-gate.test.mjs tests/unit/ruvnet-gate1-pattern.test.mjs tests/unit/hook-contracts-doctor.test.mjs tests/unit/hook-registry-lint.test.mjs tests/integration/hook-conformance-both-hosts.test.mjs tests/unit/codex-lifecycle-hooks.test.mjs`: **7 files passed, 108 passed / 21 skipped, 0 failed.**
- `npx vitest run tests/integration` (full, 49 files): 9 failed files / 23 failed tests / 400 total.
  All 9 pre-existing/environmental, confirmed by direct inspection, none touching hooks/codex/
  conformance code: `health-repair.test.mjs` (9/10, native `sqlite3` under this container's root
  user), `project-progression-*.test.mjs` (10 failures, `global Ruflo is required` — Ruflo not
  installed globally in this container), `anticipate.test.mjs`/`anticipate-dial.test.mjs` (1 each),
  `console-apply-timings.test.mjs` (1) — same class the ledger has recorded every night since
  2026-08-26.
- `npm run claims:verify`: 4 PASS / 3 SKIP (brain-not-installed class — consistent with every prior
  ledger row).
- `npm run eval:gate`: `EVALUATED=blocked` — "no brain at /root/.cache/ruvnet-brain/kb"
  (`stores 0 dark 0`, confirmed via `restore-local-ingests.mjs`/`kb/store-root.mjs` — not a
  credentials block; `OPENROUTER_API_KEY` is present this session).
- `npm run wired:check`: exit 0, clean.
- `node scripts/sync-version.mjs --check`: all surfaces agree on `4.3.25`.

## Darwin

Not run. No numeric benchmark axis to evolve — this is a documentation-currency fix with a
binary BLOCK/clear evaluator, not a metric with a search space.

## Reward-Hack Check (self-critique, single session — not a separate agent; disclosed rather than overclaimed)

- Did it weaken a benchmark or alter gold data? No benchmark or gold data touched.
- Cherry-picked evidence? No — the still-open bash/`exec_command` sub-gap is stated explicitly
  rather than omitted, even though omitting it would have let the candidate claim full closure.
- Exploited the evaluator? No — `doc-currency.mjs`'s thresholds (`DRIFT_COMMITS_STALE`,
  `DRIFT_DAYS_STALE`) are untouched; the fix is the exact category of edit the evaluator asks for
  (a source-bound review recorded since the governed code moved).
- Hidden cost or a touched threshold? None; single markdown file, no config changed.
- Verdict: CLEAR, with the caveat above (single-session critique) recorded rather than hidden.

## Security Review

Out of scope — no code, no credentials, no MCP surface, no filesystem/network permission touched.
One markdown file under `docs/adr/`.

## Scan findings

- **codex-parity**: the 2026-09-11/12 dual-host hook extension itself is real, live-measured, and
  its own test coverage (`codex-claude-hook-parity.test.mjs`) is thorough and currently green — no
  new parity defect found beyond the governance-currency gap this row closes. The bash/
  `exec_command` route remains the one honestly-disclosed open item, unchanged by this session
  (this container lacks a `codex` CLI to extend that evidence).
- **stranger-project-behaviour**: read `plugin/scripts/ground-before-write.sh` and
  `plugin/scripts/decision-gate.mjs`'s applicability/budget logic directly — both already scope to
  RuvNet product-term content (not project path) and are timing-budgeted with stranger-project
  measurements on record (ADR-067, ~415ms against a 5000ms ceiling). No new stranger-project defect
  found in the newly-added Codex write/grounding-stamp/Stop-gate registrations.

## ADR

None created — this row amends an existing ADR (084) via its own Currency log convention; it is
not a new architectural decision.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation recorded on
every Dream Cycle night since 2026-08-19). This file is the full report.

## Witness

```
SESSION_COMMIT = 35fbe038afe657610d0c4924b335312aa351041c
REPORT_HASH    = dd77efc289b90f54d3de7eecf2064f2cd8103b1bed7177db4fadf2a5a42ee282
WITNESS        = b205a45a83eac4e2939a156e1aca23090ea51bafd7c46f56a5d0462c330a133f
```

5-step verifier, reproducible by anyone:
1. `git checkout 35fbe038afe657610d0c4924b335312aa351041c` (the session's starting commit, before
   tonight's candidate).
2. Confirm this report's content matches the version in the candidate PR/branch (this file did not
   exist at step 1's commit — it is added by the candidate commit).
3. `sha256sum docs/dream-cycle/2026-09-15-cross-host-conformance-report.md` → must equal
   `REPORT_HASH` above.
4. `printf '%s%s' "$REPORT_HASH" "35fbe038afe657610d0c4924b335312aa351041c" | sha256sum` → must
   equal `WITNESS` above.
5. Re-run `node scripts/doc-currency.mjs --check --changed main` at step 1's commit (RED:
   `adr/0084-the-three-user-invariants.md presumed-stale · 1 BLOCK`) and again on the candidate
   commit (GREEN: `current`).

## Recommendation

Merge is a human decision (`autoMerge: false`). No urgency beyond normal review — this is a
documentation-currency fix, not a defect in shipped behavior.

## Next steps

1. `decision-gate`'s bash/`exec_command` route on Codex remains genuinely unverified. Whoever next
   has a machine with `codex-cli` installed should run the same live-probe methodology `ef2b8e12`
   used (a real Bash-equivalent tool call) and either wire it or record a `DECLARED ABSENT`-style
   note with the host fact behind it.
2. **The Dream Cycle review backlog is now the dominant risk on this repository's automation, and
   is worth the owner's direct attention** (see standalone note below) — not this row's surface to
   fix, but too large to leave unstated here.
