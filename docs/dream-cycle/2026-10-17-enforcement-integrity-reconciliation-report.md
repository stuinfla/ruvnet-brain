# Dream Cycle 2026-10-17 — enforcement-integrity reconciliation report

## Rotation

`20261017 % 5 == 2` → DEEP=`enforcement-integrity`, SCAN=`lesson-delivery,gate-teeth`. No bonus modulus (`%25`=17, `%75`=67). Session commit `b44f51c` on `main` (fresh checkout, `npm ci` clean).

## Ledger check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31 — expected, not new: ledger rows ship inside candidate PRs, and essentially nothing has merged since. Re-checked the backlog directly via GitHub, not assumed from any prior PR's own count:

- `head:dream is:open` → **60** (vs. 58 reported 2026-10-16 in PR #464, 51 on 2026-10-12 in PR #438 — still growing, roughly +2/night).
- `head:dream` all-time → **103**.
- `head:dream is:merged` → **5** total; the most recent is PR #215 (`fix(source-coverage): cardPresent resolves through repo-aliases.json...`), merged **2026-08-31**. That is **47 days** ago as of tonight. (Note: prior nights, e.g. #438, computed "47d" from PR #178's 2026-08-26 merge date rather than #215's later 2026-08-31 merge — the correct basis is the most recent merge, #215. Both arrive near "47" tonight only because 21 more days have since elapsed; this is not claimed as a new finding, just a correction to use the right anchor going forward.)
- `label:dream-cycle is:open` issues → only #410 remains open and scoped to the backlog itself; no open issue is specifically tagged `enforcement-integrity` right now (search returned 0).

## Surface-specific reconciliation

Checked the two still-open `enforcement-integrity` candidate PRs most central to tonight's SCAN (`lesson-delivery`, `gate-teeth`) against current `main` source, not against their own descriptions:

- **PR #416** (`lesson-ratify.mjs` unlocked concurrent ratify/demote race): `scripts/lesson-ratify.mjs` on current `main` still calls `loadLessons()` (line 35) and `saveLessons()` (lines 73, 94) directly, never `updateLessons()`. The race is still live and unfixed on `main`. PR #416 itself now reports `mergeable_state: "dirty"` (conflict-drifted since 2026-10-07).
- **PR #412** (entrypoint-guard ratchet, 129-file baseline): `scripts/entrypoint-guard-scan.mjs` still does not exist on `main`. The ratchet has not landed. PR #412 also now reports `mergeable_state: "dirty"`.

Both findings remain exactly as their authoring nights described — real, reproduced, unfixed-on-`main`, and now additionally degrading via conflict drift the longer they wait for review. This is the same drift #438 first flagged for these same two PRs on 2026-10-12; it has not reversed.

## Learning signal (STEP 1.1)

"Zero of the last 14 candidate PRs merged → bias to a tiny, one-parameter, easily-reviewable candidate" is unambiguously in effect — it has been for at least 7 consecutive `enforcement-integrity` nights (#412, #416, #294/#282/#281, #367, #317, #333, #295, #366, #438, and now tonight). The `enforcement-integrity`/`gate-teeth` surface already has open candidates covering: 7 distinct silent entrypoint-guard shapes (#295, #317, #333, #367, #412's ratchet), a lesson-ratify concurrency race (#416), a theme-demotion recovery (#294), a nudge-budget truncation (#366), and the SLA-acknowledgment gap (#460, filed under cross-host-conformance but touching `scripts/issue-watch.mjs`, enforcement-adjacent). A bounded search tonight did not surface a new, reproduced, currently-unfixed defect on this surface distinct from all of the above. Manufacturing an 8th variant of an already-covered class, or duplicating #416/#412, would violate `dream.config.json`'s `findingPolicy.skipIf: ["duplicate-open-issue", "existing-fix-pr", ...]`. Tonight is therefore a reconciliation-only night: no new code candidate.

## Evaluation receipt (run anyway, for the record)

- `npm run claims:verify` → 3 PASS / 4 SKIP — identical composition to every prior documented night.
- `npm run eval:gate` → `EVALUATED=blocked` (`no brain at /root/.cache/ruvnet-brain/kb`; pre-existing, not a credentials block).
- `node scripts/restore-local-ingests.mjs` → read-only pass, all recorded ingests correctly reported with real dates (no false-wipe alarm) — the #143 fix still holds.
- `npx -y dream-machine@0.1.1 compile dream.config.json --out /tmp/tonight.md` → succeeded cleanly (15029 bytes, 321 lines). #298's intermittent sandbox-denial did not reproduce tonight.

## Darwin Lineage

N/A — no code diff, no continuous parameter.

## Reward-Hack Check / Security Review

N/A for this reconciliation-only night — no candidate code, no benchmark/threshold/gold-data touched. Read-only GitHub inspection (issue/PR state, source greps) plus this commit and one comment on #410.

Carried forward, not independently re-verified tonight: PR #416's 2026-10-07 note that GitHub flagged a high-severity Dependabot alert (`security/dependabot/5`) on `main`, outside `enforcement-integrity` scope and not investigated by that night either. Flagging again for the owner since it is still unaddressed as far as this session can tell from PR text alone; this session has no Dependabot-alert-listing tool to confirm its current status directly.

## ADR

None — not an architectural decision.

## Gist

LOCAL — no `gh gist create` / gist-creation tool available to this session. This file is the full record.

## Issue

NONE — per the ISSUE DISPOSITION OVERRIDE, tonight's only finding (the backlog, and #416/#412's continuing conflict-drift) is already comprehensively tracked by #410 (2026-10-06, still open). Commented there with tonight's counts rather than filing a duplicate.

## Witness

```
SESSION_COMMIT = b44f51ccefe15432d0ba4c5bfffe39aa10bbf6d0
REPORT_HASH    = b71102c028e544f178ab140e741380a7ad8d9131a2d5d7683ee6128fa57a56e4
WITNESS        = 8127c01ec5bc25179bbd345072338fa07dd624529aea158d66eac07d8f1dee1d
```
REPORT_HASH is the sha256 of this file's content immediately before this Witness section was filled in (the pre-stamp text, matching the `dream-machine witness stamp` convention of hashing the report, then recording the hash — the circularity other nights note and accept, e.g. PR #412's "re-stamped ... first stamp superseded, not hidden"). Reproduce: `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` should equal WITNESS.

## Recommendation

`evaluated: accepted` (process finding, not a code candidate — no promotion gate applies). Unchanged from every reconciliation night since 2026-08-26: the single highest-leverage action available is a human triage pass over the growing `dream/*` backlog (60 open, 5 merged all-time, none in 47 days), which would also stop PRs like #416 and #412 from continuing to conflict-drift the longer they sit unreviewed.
