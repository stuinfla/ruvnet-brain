# Dream Cycle 2026-10-22 — enforcement-integrity reconciliation report

## Rotation

`20261022 % 5 == 2` → DEEP=`enforcement-integrity`, SCAN=`lesson-delivery,gate-teeth`. No bonus modulus (`%25`=22, `%75`=72). Session commit `0020223` on `main` (fresh checkout, `npm ci` clean).

## Ledger check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31 — expected, not new: ledger rows ship inside candidate PRs, and essentially nothing has merged since. Re-checked the backlog directly via GitHub MCP, not assumed from any prior PR's own count:

- `head:dream` all-time → **111** opened (was 104 on 2026-10-18 per #471, 103 on 2026-10-17 per #466).
- `head:dream is:open` → **68** (was 66 on 2026-10-21 per #480's comment on #410, 60 on 2026-10-17 — the growth rate has not slowed).
- `head:dream is:merged` → **5** total, ever. Most recent still PR #215 (`fix(source-coverage): cardPresent resolves through repo-aliases.json...`), merged 2026-08-31. That is **52 days** ago as of tonight, with the routine having fired every single night in between.
- `label:dream-cycle is:open` issues → exactly two: #410 (the backlog itself, open since 2026-10-06, 16 days) and #298 (compile-blocked-by-sandbox recurrence, unrelated to tonight — did not reproduce tonight, see Evaluation Receipt). No issue is specifically tagged `enforcement-integrity` right now.

## Surface-specific reconciliation

Checked the two still-open `enforcement-integrity` candidate PRs most central to tonight's SCAN (`lesson-delivery`, `gate-teeth`) directly against current `main` source, not against their own descriptions:

- **PR #416** (`lesson-ratify.mjs` unlocked concurrent ratify/demote race, opened 2026-10-07): `scripts/lesson-ratify.mjs` on current `main` still calls `loadLessons()` (line 35) and `saveLessons()` (lines 73, 94) directly, never `updateLessons()`. The race is still live and unfixed on `main`, 15 days after it was found and fixed in a candidate. PR #416 still reports `mergeable_state: "dirty"`.
- **PR #412** (entry-point-guard ratchet, 129-file baseline, opened 2026-10-06): `scripts/entrypoint-guard-scan.mjs` still does not exist on `main`. The ratchet has not landed, 16 days after it was built and verified. PR #412 still reports `mergeable_state: "dirty"`.

Both findings remain exactly as their authoring nights described — real, reproduced, unfixed-on-`main` — and both candidate fixes are still sitting conflict-drifted, unreviewed, for a second and third week respectively. This is the same drift #438 first flagged for these same two PRs on 2026-10-12 (10 days ago); it has still not reversed, and no mechanical audit of the kind #410 recommends has visibly run in the interim.

A bounded search tonight (reading `lesson-presentation.mjs`, the lesson-delivery display path, and the gate-teeth entrypoint-guard class against current `main`) did not surface a new, reproduced, currently-unfixed defect on this surface distinct from #416, #412, or the backlog itself. Opening an 8th-or-later variant of an already-covered class, or a third copy of the backlog finding, would violate `dream.config.json`'s `findingPolicy.skipIf: ["duplicate-open-issue", "existing-fix-pr", ...]` and the `extraDisciplines` ISSUE DISPOSITION OVERRIDE. Tonight is therefore a reconciliation-only night: no new code candidate.

## Learning signal (STEP 1.1)

"Zero of the last 14 candidate PRs merged → bias to a tiny, one-parameter, easily-reviewable candidate" has now held for at least 8 consecutive `enforcement-integrity` nights in a row (#412, #416, #294/#282/#281, #367, #317, #333, #295, #366, #438, #460, #466, and now tonight). The signal's own premise — that a *smaller* candidate would get reviewed faster — has not been borne out: #412 and #416 are both small, both verified, both still unreviewed after 15-16 days. The backlog's cause is review throughput, not candidate size. Tonight does not add a 69th unreviewed PR on top of that queue with new production code; the only change this PR carries is the ledger row and this report.

## Evaluation receipt (run anyway, for the record)

- `npm run claims:verify` → `claims:verify scope=all UNKNOWN — 3 verified, 4 unmeasured; omitted=none` (3 PASS: baseline, held-out, version; 4 SKIP: cost-factor, coverage, chunk-count, LEARNING-REPLAY — all for pre-existing, documented reasons: brain not installed on this container, no coverage run, learning-replay artifact predates HEAD). Identical composition to every prior documented night.
- `npm run eval:gate` → `EVALUATED=blocked`: `no brain at /root/.cache/ruvnet-brain/kb` — pre-existing, not a credentials block (`OPENROUTER_API_KEY` is present in this container).
- `node scripts/restore-local-ingests.mjs` → read-only pass, all recorded ingests reported with real dates, no false-wipe alarm — the #143 fix still holds.
- `node scripts/brain-score.mjs` → all 4 quality dimensions STALE (42.5d > 14d budget) or unmeasured; both coverage dimensions UNMEASURED (`store root does not exist on this host`) — expected for a fresh container with no materialized corpus, not a new finding.
- `npx -y dream-machine@0.1.1 compile dream.config.json --out /tmp/tonight.md` → succeeded cleanly (15029 bytes, 321 lines). #298's intermittent sandbox-denial did not reproduce tonight.

## Baseline / Darwin Lineage

N/A — no code diff, no continuous parameter.

## Reward-Hack Check / Security Review

N/A for this reconciliation-only night — no candidate code, no benchmark/threshold/gold-data touched. Read-only GitHub inspection (issue/PR state, source greps against current `main`) plus this commit and one comment on #410.

## Regression Analysis

Docs-only diff (this report + one `LEDGER.md` row); nothing to regress.

## ADR

None — not an architectural decision.

## Gist

LOCAL — no `gh gist create` / gist-creation tool available to this session. This file is the full record.

## Issue

NONE — per the ISSUE DISPOSITION OVERRIDE, tonight's only finding (the backlog's continued, unreversed growth, and #416/#412's continuing conflict-drift) is already comprehensively tracked by #410, still open. Commented there with tonight's counts rather than filing a duplicate.

## Witness

```
SESSION_COMMIT = 00202230086c5ab85dd2476a8ba0ee064aade14f
REPORT_HASH    = bab54e78ed2841232bbf6a9fac269dff047058097f274d090e98dc2e97534f5b
WITNESS        = 96b28f12658029917cdbc934ba7854b28b0d62d75d565259d590788c49f41666
```
REPORT_HASH is the sha256 of this file's content immediately before this Witness section was filled in (the pre-stamp text), matching the convention prior nights (e.g. PR #412, #466) note and accept. Reproduce: `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` should equal WITNESS.

## Merge Policy

Human review required. This session never self-merges and never autonomously promotes candidate state. `autoMerge: false` per `dream.config.json` — that is the decision, not a default.

## Recommendation

`evaluated: accepted` (process finding, not a code candidate — no promotion gate applies). Unchanged from every reconciliation night since 2026-08-26, and now more urgent than any prior night's phrasing of it: the Dream Machine has fired every night for 52 consecutive nights since its last merge and produced zero additional integrated work in that span, while its own verified fixes (#416, #412) rot into merge conflicts. The single highest-leverage action available to the owner is a human triage pass over the `dream/*` backlog (68 open, 111 all-time, 5 merged, none in 52 days) — per #410's own suggested mechanical audit (check each open PR against current `main`, close what already landed via direct commit, merge or reject the rest). Absent that, every future night on this surface will keep reconfirming the same two findings while the system that is supposed to make "tomorrow's search space smaller" instead only makes tomorrow's backlog larger.
