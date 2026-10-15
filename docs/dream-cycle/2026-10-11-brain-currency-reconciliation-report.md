# Brain-Currency Reconciliation Report — 2026-10-11

**Dream Cycle 2026-10-11 — DEEP=brain-currency, SCAN=dark-stores,corpus-freshness (slot 1, `20261011 % 5 == 1`). No bonus modulus tonight (`%25`=11, `%75`=61).**

## TL;DR

No new, testable defect found on the `dark-stores`/`corpus-freshness` surface tonight.
`kb/store-root.mjs`'s `darkStores()` is already alias-aware (fixed under ADR-058);
`scripts/brain-score.mjs`'s `staleness()` threshold math (`ageDays > maxAgeDays`) is
correct by inspection and this container's own live run (`grounded`/`routed`/`abstained`
all correctly flagged `STALE` at 31.5d > 14d budget). The surface itself cannot be
exercised end-to-end here: this container's store root has never materialized
(`stores 0 dark 0`, confirmed via `kb/store-root.mjs`), the same pre-existing,
already-documented condition every prior brain-currency night has recorded. The
substantive finding tonight is operational, not a code defect, and it is **not new**:
issue #410 (filed 2026-10-06, same slot, same surface) already names it in full and
remains open and unaddressed five days later.

## Reconciliation (per `extraDisciplines` ISSUE DISPOSITION OVERRIDE)

Checked GitHub state before considering any new work:
- `search_pull_requests repo:stuinfla/ruvnet-brain head:dream is:merged` → **5 total**, most recent closed **2026-08-31** (#215). Zero dream-cycle PRs have merged in the **41 days** since.
- `search_pull_requests repo:stuinfla/ruvnet-brain head:dream is:open` → **50** open draft PRs (up from 48 three days ago, per PR #419's own count on 2026-10-08).
- `search_issues repo:stuinfla/ruvnet-brain label:dream-cycle is:open` → 2 open (#410, #298). #410 (2026-10-06) is this exact finding, already comprehensive; #298 (2026-09-19, intermittent sandbox denial of the `dream-machine` compile step) did not reproduce tonight — compile succeeded cleanly (`npx -y dream-machine@0.1.1 compile` → 15029 bytes, no denial).
- Per the ISSUE DISPOSITION OVERRIDE, a reconciled fingerprint already tracked by an open, unresolved issue is not re-filed. Added one comment to #410 with tonight's confirming counts (41 days / 50 open / 0 merged, up from #410's own 2026-10-06 baseline) rather than opening a duplicate.

## Surface work actually attempted tonight (dark-stores / corpus-freshness)

- Read `kb/store-root.mjs`'s `darkStores()` (alias-aware via `repositoryNames()`, per its own header comment documenting the ADR-058 fix) — no gap found against the router's own resolution logic.
- Read `scripts/brain-score.mjs`'s `staleness()` (`ms = now - Date.parse(at)`, `ageDays = round(ms/DAY, 1)`, `stale = ageDays > maxAgeDays`) — correct, and live-exercised by tonight's own `node scripts/brain-score.mjs` run (TL;DR above).
- `node scripts/restore-local-ingests.mjs`: exit 0, 125 recorded ingests correctly classified `NEVER-MATERIALIZED` (not `WIPED`) — the ADR-058/PR #143 fix holds.
- Could not test `darkStores()`'s alias path end-to-end (needs a live, non-empty store root; this container has none, same pre-existing condition as every prior night since 2026-08-19).

No candidate diff resulted. `EVALUATED=no / VERDICT=INCONCLUSIVE / reason=no new testable defect found; surface's live-data path untestable in this container (store root never materializes here, pre-existing)`.

## Candidate / Baseline / Darwin

Not applicable — no code candidate tonight.

## Evidence

OBSERVATION (store root never materialized, confirmed live) → OBSERVATION (darkStores/staleness logic read, no defect found) → OBSERVATION (GitHub state: 41d/50 open/0 merged, confirmed via GitHub MCP, not assumed) → DECISION (INCONCLUSIVE; no new issue, defer to #410).

## Reward-Hack Check

N/A — no benchmark, gold data, or threshold touched.

## Security Review

Read-only inspection (local source, GitHub MCP reads) plus one additive GitHub write (comment on #410) and this report/ledger commit, using this session's existing scoped credentials. No secrets, CI, or permissions touched. No credentials present in this container (`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` both absent) — `LLM_EVAL=blocked`, consistent with the long blocked-streak the ledger has recorded since night one.

## ADR

None — not an architectural decision.

## Gist

LOCAL — this file (no `gh` gist tool available this session, consistent with every prior night).

## Issue

NONE (per ISSUE DISPOSITION OVERRIDE — #410 already tracks this exact finding; commented there instead).

## Witness

```
SESSION_COMMIT = e26e15cf81a0a0e73ad127988380ae5901122f30
REPORT_HASH    = 565786f8830cf7f8a84e000383e706aad90e21e40af75379f2869ccbc29d6ca7
WITNESS        = 62932c7d43ad4c3e4623cf013bc784aeb8f1552e133a5feb3fa15e94228d0c22
```

## Recommendation

`evaluated: not attempted` for a code candidate (process/reconciliation finding only — no promotion gate applies). Human action recommended, restated from #410 because it has not been acted on in 5 days: triage the 50+ open `dream/*` draft PRs (merge, close as superseded, or explicitly reject); the nightly routine's entire value is blocked on this, not on finding more defects. This PR carries only the ledger row and this report (no production code), deliberately, so as not to compound the named backlog with a new code candidate on top of an unreviewed queue.
