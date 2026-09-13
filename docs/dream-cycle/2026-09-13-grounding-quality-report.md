# Dream Cycle 2026-09-13 — grounding-quality report

## Rotation

DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5,
`20260913 % 5 == 3`). No bonus modulus tonight (`% 25` = 13, `% 75` = 38, both non-zero).

## Ledger Check

Read `docs/dream-cycle/LEDGER.md` (ends at the 2026-08-31 row on `main` — every dream-cycle PR
opened since has closed unmerged or remains open/draft, per this repo's own "ledger row ships in
the candidate PR" convention). Re-checked recent fates via GitHub MCP rather than assuming:

- `#142/#143`, `#147/#148`, `#149/#150`, `#178`, `#215` — confirmed **MERGED** (unchanged from
  prior nights' re-checks).
- 24 `dream/*` PRs (#157 through #265) were closed unmerged in one batch on 2026-09-07 (~18:48
  UTC) — an intentional triage sweep, not individual review.
- As of tonight, `list_pull_requests` shows 6 open `dream/*` drafts (#269, #270, #276, #278, #279,
  #281, #282 — several recent nights have shifted to "reconciliation" PRs that close stale issues
  rather than opening new code candidates) and 19 open `dream-cycle`-labeled issues.
- **Concurrent-run note.** PR #270 (`dream/2026-09-08-grounding-quality-routed-path`, this exact
  SLOT's most recent code candidate) received two new commits at 2026-09-13T08:35:52Z and
  08:36:12Z — a `main`-merge and a convergence-manifest regeneration — six minutes before this
  session began investigating (2026-09-13T08:42Z), and matching tonight's own cron fire time
  (`30 8 * * *` UTC). This session did not author those commits. Per this repo's established
  "CONCURRENT NIGHT" protocol (used 2026-08-20, 08-26, 08-28, 08-31, 09-08), this session leaves
  PR #270's branch untouched and works a disjoint angle.
- Separately and directly relevant: issue **#286** ("retrieval-canary gate red since 2026-09-10")
  is open and actively being worked by the repo owner directly on `main` today (commit `aca4303`,
  authored `sikerr@gmail.com`, co-authored Claude Sonnet 5, `git log` timestamp 2026-09-12
  19:56:04-0400). Its own text says "Do not attempt root causes 2 and 3 under release
  time-pressure" — respected; not touched tonight (see Candidates Considered).

## Deep Dive

Read `docs/dream-cycle/2026-09-03-grounding-quality-report.md` and issue #236 (the most recent
un-superseded open finding on this exact surface). Issue #236 recommends a human pick a direction
on "`ADR-0076` (Proposed)". Checked `docs/adr/0076-memory-full-integration.md` directly: it is an
unrelated proposal ("Memory full integration — session recall and decision ledger", authors Stuart
Kerr + Codex, filed 2026-09-11, Accepted then **Rejected the same day** on measurement) — not the
citation-rank-hijack content issue #236 describes.

`git log --all --grep="rank-hijack" -i` and `git log --all --grep="citation.*rank" -i` both return
zero commits reachable from any ref: the original ADR-0076 draft was never merged. Traced it to PR
#237 (`Dream Cycle 2026-09-03: citation rank-hijack needs a structural fix (ADR-0076) +
reconciliation`), one of the 24 PRs closed unmerged in the 2026-09-07 sweep — including the ADR
file, the two evidence repro scripts, and the report itself. Pulled the full diff via
`pull_request_read(get_files)` and confirmed the content is complete and self-contained (130-line
ADR, 2 standalone repro scripts, 223-line report, 1 ledger row).

## Hypothesis

> Given issue #236's recommendation to consult "ADR-0076 (Proposed)" for the citation-rank-hijack
> direction decision, when `docs/adr/0076-*.md` is read on current `main`, then it will NOT be the
> citation-rank-hijack document (a different, since-Rejected ADR occupies that number) — AND the
> two repro scripts originally committed in the same closed PR, when re-run byte-for-byte against
> current `main`'s `kb/verify-citation.mjs`, will still reproduce the original `VULNERABLE` result
> — subject to: no new analysis is invented (the recovered ADR is the original content, renumbered,
> with a currency-log entry documenting the recovery), and no code or gold-answer file is touched.

Frozen before re-running the repros or touching any file. Not modified since.

## Evaluation Receipt

- **Reference check**: confirmed by direct file read — `docs/adr/0076-memory-full-integration.md`
  is Status `Rejected (2026-09-11)`, unrelated topic.
- **Repro re-verification**, run from repo root against unmodified `main` (`b8d6802`) before any
  file in this candidate was written:
  ```
  $ node /tmp/dream-repro-a.mjs   # byte-identical copy of the recovered repro-a.mjs
  VULNERABLE: rank #2 was hijacked by the embedded look-alike; the real rank-2 citation
  (repo=good) never appears in the parsed output at all.                          (exit 1)
  ```
  Then re-run in-tree, from the actual recovered files, after committing them to this branch:
  ```
  $ node docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-a.mjs
  VULNERABLE: ...                                                                  (exit 1)
  $ node docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-b.mjs
  verifyGrounding result: {"grounded": true, ... "receipt": {"repo": "evil", ...}}
  VULNERABLE: rank #2 was hijacked and resolves on disk to attacker-controlled content; the
  real rank-2 citation (repo=good) never appears in the parsed output.            (exit 1)
  ```
  Both byte-identical to the original 2026-09-03 report's claims. `kb/verify-citation.mjs`'s
  `parseCitations()` docstring (read directly, unchanged) still says: "not airtight against a
  document engineered to predict and spoof the exact next rank (tracked as an open item, not
  solved here)". Re-run a third time after the Branch-Base Correction (below), on the real
  `origin/main` tip `f95a1a5`: both still `VULNERABLE`, exit 1, byte-identical.
- `npm run version:check`: `4.3.25` agrees on every surface (the real `origin/main` tip at the time
  this branch was rebuilt; an earlier check against the stale local base incorrectly read `4.3.14`
  — see Branch-Base Correction).
- `npm run convergence:check` (after `npm run convergence:write` to add the new ADR to the
  tracked-file list, required whenever an ADR is added — same requirement PR #237's own diff
  shows), re-run fresh as the last step before pushing, against the real `origin/main` base:
  `{"ok":true,"version":"4.3.25","trackedFileCount":1489,"adrCount":87}`. (Two earlier, superseded
  checks exist in this candidate's own history: `1301` against an incomplete tree, then `1302`
  against the stale local base — both corrected in turn, first by an independent critic agent
  catching the first staleness, then by this session catching the stale-branch-base issue itself.)
- `npm run doc:currency`: exits 1, but with the same pre-existing violation set every night since
  2026-08-26 has documented (dozens of ADRs stamp-lagging/presumed-stale from the unrelated
  2026-09-04 `e6774a3` and 2026-09-07 batch-release commits — none touching this candidate's
  files). The new `ADR-0086` itself surfaces only expected warnings for an uncommitted-at-check-time
  file (`no-git-history`, `stamp-unverifiable-dirty`) plus `no-governs` (this ADR makes no
  machine-checkable claim about code — it is Proposed, not yet implemented, same as the original
  2026-09-03 draft) — none of these are new problems introduced by the recovery.
- `npm run eval:gate`: not applicable — a documentation-integrity repair and a parser-logic
  security question, neither of which the frozen 120-question held-out set can grade (same
  reasoning the original 2026-09-03 report and every prior grounding-quality night reached for
  this exact finding). Confirmed via control-plane probe this container still has no materialized
  corpus (`stores 0 dark 0`); not a credentials block, `OPENROUTER_API_KEY` is present.

## Darwin Lineage

Not run — no continuous parameter to evolve for a documentation-recovery fix.

## Evidence

OBSERVATION (issue #236 points at "ADR-0076 (Proposed)"; `docs/adr/0076-*.md` on `main` is a
different, Rejected proposal) → MEASUREMENT (`git log --all --grep` confirms the original draft
was never merged, traced to closed PR #237's diff; both recovered repro scripts re-run
byte-identical `VULNERABLE` against current `main`) → DECISION (recover the content under a free
number, `ADR-0086`; repoint issue #236; no new analysis, no code change).

## Reward-Hack Check

N/A — no benchmark, threshold, or gold answer touched; no candidate production code shipped. The
two evidence scripts are unmodified reproductions (diffed byte-for-byte against PR #237's own
patch text before committing), not new claims.

## Branch-Base Correction

This session's local checkout carried a stale, orphaned local `main` branch ref (`80c5322`, from
an unrelated, much older snapshot, diverged rather than an ancestor of the actual working
commit `b8d6802`) left over from container setup — a local artifact, not a repository defect. The
candidate branch was first built on that stale ref by mistake and, when pushed, collided (HTTP 403
"fetch first") with the **already-existing** remote branch `dream/2026-09-13-grounding-quality`
from tonight's genuinely concurrent firing (see Ledger Check). Fetching `origin/main` for real
revealed the correct current tip, `f95a1a5` (one commit past this session's original `b8d6802`
starting point — `fix(corpus-seed): missing GH_TOKEN broke org-wide repo discovery`, unrelated).
Rebuilt this candidate on the real `origin/main` via `git checkout -b
dream/2026-09-13-grounding-quality-adr-recovery origin/main` + cherry-pick (one trivial conflict,
in the generated `data/convergence-manifest.json`, resolved by regenerating it fresh — not by hand)
and renamed the branch with an `-adr-recovery` suffix to avoid colliding with the concurrent
session's branch, per this repo's established protocol. Re-verified everything below fresh against
the corrected base before finalizing. `ADR-0086` remained the correct next free number on the real
`origin/main` too (confirmed: `0085` is the highest pre-existing file, `0076`–`0085` all already
occupied by unrelated ADRs, `0086` still free).

## Adversarial Critique

An independent critic (fresh `general-purpose` agent, not this candidate's author, given the diff
and full context, explicitly instructed to find fabrication/reward-hacking/security issues)
reviewed the staged change before it was pushed. Verdict: **1 blocking finding, rest CLEAR.**

- Recovery fidelity: CLEAR — the recovered ADR and both evidence scripts match PR #237's original
  diff, no new claims added.
- Vulnerability reproduction: CLEAR — the critic independently re-ran both evidence scripts and
  confirmed `VULNERABLE`/exit 1 on both, byte-identical to this report's own claim.
- Reward-hacking / framing: CLEAR — no overclaiming found in the Recommendation section.
- Security exposure from committing exploit scripts: non-blocking — PR #237's content (including
  the same scripts) has been publicly readable via the GitHub API since 2026-09-03; recommitting it
  adds no new exposure.
- **Blocking**: the Evaluation Receipt's `convergence:check` output was stale — quoted from an
  intermediate check taken before this report file existed (`trackedFileCount:1301`), not from a
  fresh check against the final tree (`1302`). The committed `data/convergence-manifest.json` was
  never actually wrong (a fresh `convergence:write` at the time of the critique produced a
  byte-identical file to what was already staged) — only this report's prose cited a stale
  intermediate number instead of re-verifying as the last step. **Fixed** by rerunning
  `convergence:write`/`convergence:check` fresh (confirmed `git diff HEAD -- data/convergence-
  manifest.json` empty, i.e. no actual manifest change was needed) and correcting the number above.
- `governs: []` precedent: non-blocking — other Proposed ADRs in this repo are inconsistent on this
  field (some omit it, some leave it empty, some populate it); an honest empty list is a defensible
  variant.
- Collision with PR #270: non-blocking — the only file both touch is `data/convergence-manifest.json`
  (expected for any change to the tracked-file list; whichever PR merges second will need a trivial
  regeneration, same as always).

## Security Review

This recovers, rather than introduces, a security finding: `kb/verify-citation.mjs`'s
`parseCitations()` is confirmed still vulnerable to the relative-offset citation-rank-hijack
described in `ADR-0086` (re-verified live tonight, not merely asserted from memory). No production
behavior changes as a result of this PR — the vulnerability's status (present, unfixed, tracked)
is unchanged; only its documentation trail is repaired. The severity/scope framing from the
original report stands: exploitable by any actor who can get content indexed into a store this
repo's retriever searches; the live `search_ruvnet` MCP path's actual JSON envelope is a separate,
narrower question not re-litigated tonight (out of scope for this recovery).

## Regression Analysis

No production code touched — `kb/verify-citation.mjs` and every other `.mjs` source file are
byte-identical to `main`. Changed files: 1 new ADR, 2 recovered evidence scripts (unmodified from
PR #237), 1 new report (this file), 1 ledger row, `data/convergence-manifest.json` (regenerated,
required whenever the tracked ADR list changes). `npm run version:check` and
`npm run convergence:check` both green; `doc:currency`'s pre-existing violation count is unchanged
by this diff (verified by grepping the full output for any of this PR's changed paths — none
appear among the `presumed-stale`/`stamp-lags-doc` rows, which all predate 2026-09-07).

## ADR

`docs/adr/0086-citation-header-spoofing-needs-a-structural-fix.md` — recovered, not newly
authored; Status remains `Proposed` (unchanged; this session cannot make the Option A/B decision).
Added its filename to the `data/convergence-manifest.json` tracked ADR list via
`npm run convergence:write`. `docs/adr/README.md`'s index table was already known stale before
ADR-0011 (flagged 2026-09-03) — not touched again tonight, same reasoning as before (adding one row
would misrepresent the table as current when it covers only 10 of 86 ADRs).

## Gist

LOCAL — no `gh` CLI or gist-creation tool available this session (same limitation every prior
Dream Cycle night in this repo has hit). Full report is this committed file.

## Issue

Per this repo's ISSUE DISPOSITION OVERRIDE (`dream.config.json`): issue #236 already exists,
already describes this exact finding, and remains open — no new issue opened. Instead, issue #236
received a comment tonight pointing at the recovered `ADR-0086` and this report, so the human
decision it is waiting on is reachable again.

## Witness

```
SESSION_COMMIT = f95a1a56034656ced96d535cad911c5cd72bae2b
REPORT_HASH    = 40d4998506fe6d11d65c7cede0c12d565ae060dfb9da598c1e3ac5c6cad1d9d5
WITNESS        = b1f854b601edbfbce019bb7ec1672afad0924da96fb5563f1223eac401aa566a
```

`SESSION_COMMIT` is `origin/main`'s real tip at the time this branch was rebuilt (see Branch-Base
Correction) — not this session's original `b8d6802` starting point, which turned out to sit under a
stale local branch ref rather than the true base this PR merges against. `REPORT_HASH` is the
sha256 of this file's own content, everything above this `## Witness` heading, as finalized (after
both the independent critic's correction and the branch-base correction were applied — earlier
hashes taken before either correction are superseded, documented rather than erased in this
report's own Adversarial Critique and Branch-Base Correction sections). `WITNESS =
sha256(REPORT_HASH + SESSION_COMMIT)`, no separator.

**Verifier procedure** (5 steps, reproducible by anyone):
1. Check out this PR's branch and take this file's own content, everything above this `## Witness`
   heading, exactly as committed.
2. `sha256sum` that content → should reproduce `REPORT_HASH`.
3. `printf '%s%s' "$REPORT_HASH" "f95a1a56034656ced96d535cad911c5cd72bae2b" | sha256sum` → should
   reproduce `WITNESS`.
4. A match proves this report's content is bound to `main`'s exact commit at the time this session
   started.
5. Independently re-run both evidence scripts
   (`docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-{a,b}.mjs`) against `main` to
   reproduce the underlying finding directly, rather than trusting this report's own claim.

## Recommendation

`evaluated: yes` (documentation-integrity check, not a benchmark-graded evaluation) /
`verdict: ACCEPT` — the repair is bounded, verified (both repros re-run, byte-identical), and
low-risk (docs-only, zero production code changed). A human decision is still needed on
`ADR-0086`'s Option A vs Option B; recovering the document only makes that decision reachable
again, it does not make it. Separately: the `dream/*` open-PR backlog (6+ open drafts, 19 open
`dream-cycle` issues) remains worth the owner's attention, restated because it is still true.
