---
id: ADR-050
title: The issue pipeline may never manufacture its own acknowledgment — awareness, escalation, and a fixer that knows when to stop
status: Accepted
date: 2026-07-24
updated: 2026-08-30
# PINNED: this records the incident cutoff, not the last edit. Asserted by
# tests/unit/fix-workstream-guidance.test.mjs. Do not let a currency stamp move it.
updated_pinned: true
impl: wired
authors: [Stuart Kerr, Claude Code]
tags: [issues, automation, alerting, sla, security, circuit-breaker]
supersedes: []
relates: [ADR-049]
governs:
  - scripts/issue-watch.mjs
  - scripts/issue-fix.mjs
  - plugin/scripts/session-start-core.mjs
  - plugin/skills/ruvnet-brain/SKILL.md
  - plugin/skills/release-proof/SKILL.md
---

# ADR-050 — The issue pipeline may never manufacture its own acknowledgment

**Status**: Accepted (implemented)

## Context: the 2026-07-24 incident

Four real, high-quality user issues (#38, #39, #41, #42) sat open for up to 28 hours with
**zero pages to the maintainer**, who learned of them from a GitHub notification email. In the
same window, the auto-fixer posted **22 public failure comments on #38 alone** while a tested
patch from the reporter sat unread in that thread's first comment. Every alerting channel failed
at once, and the post-mortem found they all failed for ONE reason plus two amplifiers:

1. **The fixer silenced the watcher.** issue-fix.mjs posts comments through the owner's gh auth,
   so they arrive authored by `stuinfla`. issue-watch.mjs defined "owner responded" as any
   `stuinfla` comment. The moment the fixer touched an issue, an SLA breach — and therefore a
   phone page — became structurally impossible. The automation manufactured the exact signal
   that suppresses its own escalation.
2. **The anti-spam control destroyed its own state.** The fixer's attempt-start write replaced
   the issue's state record with a fresh `{attemptedAt, status}` object, erasing
   `failureCommentAt` — the field its once-per-24h comment dedup depended on. The dedup had
   never operated. A guard that cannot fail on broken code is not a guard; it had no test
   spanning two consecutive failed runs.
3. **Every channel judged by the one poisoned predicate.** The session-start banner (built
   2026-07-17 after a previous 29h-unseen incident) surfaced only `breach: true` issues —
   breach being computed by the same owner-comment check the bot satisfied. "Multiple channels"
   was one predicate wearing three hats.

Independent evaluations by Claude Fable 5 and GPT-5.6 (adversarial duel, verdict below)
converged on the same mechanisms from the same file:lines, and on the verdict that the loop was
**wrong by design, not mistuned** — a bigger timeout or model would not have fixed any of it.

## Decision — three invariants, enforced by regression tests that fail on the old code

**I1. Automation can never produce human acknowledgment.** Every comment the automation posts
begins with the exported `BOT_MARKER` prefix; `judgeIssue()` counts an owner comment only if it
does NOT carry the marker. Spoof-safety: the marker is only consulted on comments authored by
the owner login, so a stranger typing the marker changes nothing. (Durable form, recorded as a
follow-up: run automation under a dedicated GitHub App/bot identity so the separation is
enforced by GitHub itself rather than by a string convention. Requires an owner-side setup
action; the marker exclusion is the complete now-fix.)

**I2. Maintainer awareness is immediate and unconditional; escalation is the second page, not the first.**
The watcher pages ONCE the first time it sees any open issue (delivery-derived state, retried
until the push actually goes out), independent of SLA math. The 4h SLA breach page remains as
escalation. The session banner shows the open count only when an explicit, owner-only (`0600`),
repo-scoped local entitlement exists at `~/.config/ruvnet-brain/maintainer-issues.json`; a normal
installation is silent even if an `open-issues.json` file is present. The installer never creates
or copies this entitlement. POSIX requires a regular, non-symlink file owned by the current uid with
no group/world permissions; Windows fails closed because this dependency-free hook does not inspect
ACL ownership. Invalid, stale, or implausibly future-dated observations are silent. Breaches only
change urgency for the entitled maintainer. Awareness
latency remains bounded by the watcher cadence (≤1h), not by 4h-plus-never, without leaking the
maintainer's operational queue into an end user's terminal.

**I3. A failing fixer is silent in public and loud in private.** (Amended same day by the
owner's direct order, which also completed duel Phase 1 item 4 ahead of schedule: *"don't spew
something out there that says we looked at it, gave it 15 minutes, tough shit — that makes us
look like we don't care."*) The reporter-facing contract is now: **one warm acknowledgment at
first sighting** — "received and opened, being worked" — posted by the watcher with the bot
marker (so I1 still holds), then **nothing until there is substance**: a real fix branch, real
triage findings, or the maintainer in person. The scheduled fixer posts NO failure-progress
notes, ever; its failures page privately (ntfy + heartbeat). State writes spread-merge — they
preserve fields they don't own. A circuit breaker halts attempts after
`ISSUE_FIX_MAX_FAILED_ATTEMPTS` (default 1, tightened from 2 by the duel verdict) consecutive
failures until the issue itself changes, paging urgently once when it trips: NEEDS A HUMAN.
Outcome verification counts only provably-bot comments (owner login + marker,
`botCommentCount()`) — the duel caught that the prior any-comment-count check let a reporter
replying mid-run register as fixer success; unavailable verification leans failure, never
asserted success. The 27 failure notes the old design left on issues #38/#39/#41/#42 were
deleted 2026-07-24 as part of this amendment.

**Remaining accepted follow-up:** Phase 2 GitHub App identity (owner action required).

**Security posture (Stuart's sweep mandate, same date):** issue title/body/comments are
untrusted stranger input feeding an agent that holds git-push and gh-comment powers. The title
enters the fixer prompt JSON-escaped as declared data; the prompt instructs triage-and-stop on
any issue text that attempts to direct the agent or weaken a gate, hook, test, or security
control; reporter patches may be adopted only after the defect is independently verified and the
patch reduces no enforcement beyond what the fix requires. Additionally, issue bodies are
scanned with aidefence at review time; scanner hits are human-adjudicated (all four incident
issues scanned benign — three lexical false positives on `.gitignore` phrasing, regex character
classes, and TOML `[[args]]` syntax).

## The fixer's future (duel-informed)

The scheduled 15-minute headless sonnet fixer went 0/4 on real issues; the same four issues were
fixed the same night by session-supervised parallel agents with stable worktrees. Consequence:
the scheduled path is demoted to **awareness + triage + circuit-broken bounded attempts**; real
fixing belongs where a human can supervise, steer, and review. The duel verdict below carries
the full argument.

## Cross-model duel verdict (verbatim)

# Joint FINAL VERDICT

## Agreed root causes

The four issues share one systemic failure: ruvnet-brain verifies artifacts and happy-path structure in the maintainer’s macOS/Claude Code environment, then promotes that evidence into untested consumer-runtime claims across Windows, Codex, and unrelated working repositories. Blocking controls likewise shipped without adversarial semantic corpora. The incident automation repeated the same mistake at the control-loop level: individually sensible mechanisms—bounded runs, disposable worktrees, artifact-derived outcomes, SLA watching—were composed around an owner-comment predicate that automation itself could satisfy, while a state overwrite defeated deduplication. These are verification-boundary and honesty failures, not four unrelated bugs.

## Final score: 40/100

This is the score at the incident/audit cutoff, not a rescore of fixes subsequently merged. A higher score requires the real OS × host × consumer-path matrix to pass.

| Deduction | Points | Basis |
|---|---:|---|
| Supported-platform runtime contract and CI honesty | −12 | Windows-sensitive suites self-skip while both the “zero exclusions” audit note and workflow gap summary omit those skips—a double honesty failure. |
| Host wiring and doctor semantics | −12 | Codex capability was unwired while `--doctor` generalized KB presence into global product health. |
| Consumer filesystem containment and zero-files claim | −9 | The integrated runtime could create `ruvector.db` in consumer repositories while doctor promised “drops zero files.” |
| Blocking-gate semantic coverage | −7 | A session-blocking shell matcher shipped without a quote-aware adversarial corpus. |
| Incident-loop integrity | −13 | Owner-authenticated bot comments suppressed escalation; destructive state replacement defeated deduplication and produced public spam. |
| Unattended fixer effectiveness | −7 | The scheduled 15-minute fixer went 0/4 and failed to consume a tested reporter patch already present on #38. |
| **Total deductions** | **−60** | **Final: 40/100** |

This settles both earlier scores. **32 was too low** because it under-credited real strengths: fail-fast release orchestration, version and wiring gates, signed bundles with fail-closed verification, live distribution-channel checks, disposable worktrees, artifact-derived outcomes, and the Windows job’s six root-cause fixes on 2026-07-13. **58 was too high** because it missed two user-facing truth violations and treated the automation damage too lightly. The remaining 40 points represent genuine engineering controls; they simply protect artifact integrity more effectively than installed-product truth.

## Automation redesign

### Phase 1 — NOW: containment without owner setup

Marker exclusion is acceptable as an immediate mitigation, but it must not be described as an identity invariant.

1. Keep excluding owner-authored comments beginning with the automation marker. An external reporter cannot exploit this because the watcher also requires the owner identity.
2. Page once immediately on first sighting, independently of comment or SLA state. No later poisoned acknowledgment may erase that awareness event.
3. Set the circuit breaker to **one failed attempt**, not the current default of two. Re-arm only after new issue information or explicit human action.
4. Retire the scheduled job’s public write path. Scheduled automation becomes read-only triage: reproduce, classify, extract reporter patches, identify required tests, write a private incident record, and page the maintainer. It posts no progress or failure comments.
5. Surface every open issue in the session banner; breach state only changes urgency.
6. Preserve prior state fields on every transition and add an end-to-end regression proving one page, zero public spam, and a terminal `NEEDS_HUMAN` state.

The marker alone is not sound authentication. The successful-fixer comment is LLM-authored, and `verifyOutcome()` currently accepts any increase in comment count without validating the marker. An omitted marker therefore becomes indistinguishable from a human owner response. Immediate paging contains the observed harm; removing scheduled public writes closes the remaining NOW-path.

### Phase 2 — DURABLE: separate GitHub App identity

Create a repository-scoped GitHub App and authenticate automation with an **installation access token**, not an owner PAT or user-to-server token.

1. Grant only the permissions required for issues and, if later justified, narrowly scoped branch/PR creation.
2. Attribute every automated action to the App identity.
3. Define acknowledgment as an event by a configured human-maintainer allowlist. If a `human-triaged` label is used, validate the actor who applied it—not merely label presence.
4. Exclude the App identity structurally from acknowledgment calculations.
5. Add an end-to-end test in which repeated App comments can never suppress the single human page.

GitHub documents that installation-token activity is attributed to the App and is the appropriate mode for automation independent of a user; it also recommends GitHub Apps over personal access tokens for long-lived integrations. [GitHub App authentication modes](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app), [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

## The fixer’s future

Retire the **scheduled headless auto-FIXER**; do not give it a larger budget. Preserve its useful machinery—stable worktrees, scoped branches, artifact verification, and bounded execution—as an **on-demand, session-supervised fixing harness**.

The correct placement is:

- Scheduled, unattended: fast read-only triage, immediate paging, patch extraction, reproduction guidance, and state recording.
- Session-supervised: parallel Sonnet agents for bounded implementation, Opus/frontier review for architecture or security judgment, one stable worktree per issue, targeted tests, and human-controlled integration.
- Autonomous public action: only after the GitHub App boundary exists and only for narrowly classified, high-confidence changes.

The four parallel agents working tonight support this distinction. They show that autonomous implementation belongs inside a supervised session with adequate context, parallel worktrees, and visible correction—not inside a recurring 15-minute process operating against public reporters. Their work is evidence for the execution model, but it counts as successful remediation only when branches, tests, and merges are verified.

**Dissent register:** None. Fable’s marker proposal is accepted for immediate containment; GPT’s identity objection governs the durable invariant.

## Consequences

- The watcher/fixer state file gains fields (`firstSeenAt`, `newAlertAt`, `failCount`); old
  records remain readable (spread-merges tolerate missing fields).
- Reporters see at most one automation comment per issue, ever.
- The maintainer's phone learns about every new issue within one watcher cycle; a fixer
  giving up is a distinct urgent page.
- tests/unit/issue-automation.test.mjs pins all three incident mechanisms as known-bad
  regressions (8 of 12 assertions fail on the pre-fix code, proven by stash-mutation).

## Currency log
| 2026-08-30 | SessionStart issue surfacing remains enabled while response-script prose is filtered from host context. | `plugin/scripts/session-start-core.mjs` preserves the issue count and maintainer alarm required by this ADR while removing non-factual instructions. |

| date | why |
|---|---|
| 2026-08-30 | Rechecked plugin/scripts/session-start-core.mjs in 05cabf0: SessionStart output is now opt-in diagnostics, so unsolicited issue/workflow prose cannot enter a host session. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-22 | Re-read every governed issue-pipeline and host-start surface at convergence tip `ddae606`; the issue watcher still derives awareness from external issue state, and the fixer still cannot manufacture acknowledgment or bypass its stop conditions. | `adeba05` extends `plugin/scripts/session-start-core.mjs` with fail-closed project-progression restoration; it does not write issue acknowledgments or change `scripts/issue-watch.mjs` / `scripts/issue-fix.mjs`. The two governed skills continue to require evidence-backed issue handling. This currency review records compatibility only; it does not claim the intentionally held paid auto-fixer is scheduled. |
| 2026-08-19 | **Issue #140 resolved through the pipeline as designed — reported, verified line-by-line, swept, fixed, tested, closed.** | @sparkling reported that the Brain's own playbook and skill instructed agents to inspect a Ruflo-managed store with raw SQLite and to trust a DB mtime. Both citations confirmed verbatim; the mtime line additionally contradicted this project's own standing lesson. The sweep found a THIRD surface the report did not name — `ground-ruvnet.sh`'s per-turn MEMORY DIAGNOSIS prompt — which is the highest-traffic instruction surface in the product. The pipeline's value here was not the fix but the refusal to stop at the two cited files. |
| 2026-08-10 | **Re-read after the #130/#131 update-rail fixes and the new census writer; no contract change.** | `kb/forge-update.mjs` (per-run rollback snapshot, per-caller symlink policy) and the public surfaces moved. This ADR decides that the issue pipeline may never manufacture its own acknowledgment — untouched by how backups are inventoried or how corpus counts reach a README. |
| 2026-08-07 | **The continuation gate gained two real SOURCES — open PRs and GitHub security alerts — and issue-watch grew the matching reporting path.** No change to this ADR's contract. | PR #121 (`f5e8995`) adds 93 lines to `plugin/scripts/continuation-gate.mjs` and 108 to `scripts/issue-watch.mjs`. This ADR's rule is that the issue pipeline cannot silence itself; adding SOURCES the gate can see strengthens that rule rather than altering it — the 2026-07-24 incident was one poisoned predicate treating every channel as satisfied, so more independent evidence channels is the direction this decision already points. The owner-only, repo-scoped entitlement for the SessionStart banner (row below) is untouched; no default or wrong-repo install gains a new signal. Re-read the diff rather than the file list before writing this row. |
| 2026-08-06 | **Re-read against the governed code; NO change required.** | Flagged `presumed-stale` by the 4.0.19→4.0.20-dev version move. The only governed path touched is the plugin manifest's `version` field, rewritten by `scripts/sync-version.mjs` on every bump; no issue-watch, issue-fix, SessionStart banner, or entitlement code moved. This ADR's subject — that the issue pipeline cannot silence itself — is untouched by a version string. Same structural false positive recorded today against ADR-051: several ADRs `govern:` files that `sync-version.mjs` rewrites on EVERY release, so every bump marks them stale regardless of whether anything they decide changed. A gate that fires on every bump is how blanket date-stamping starts, which this repo has already done once across 61 ADRs. The durable fix is narrowing `governs:` to exclude version-only fields. Commits `3c064c6`, `c5cef3c`. |
| 2026-08-02 | Restricted the SessionStart open-issue banner to an explicit owner-only, repo-scoped local entitlement; default and wrong-repo installations emit zero issue-count bytes. Hardened that boundary to reject symlinks, foreign uid/mode, malformed or future observations, and all Windows visibility until ACL ownership can be verified. | The prior unconditional `surfaceIssues()` call fulfilled maintainer awareness but could expose the maintainer repository's operational queue to any installation carrying a fresh status file. `plugin/scripts/session-start-core.mjs` now fails silent without the local entitlement, and parity tests prove normal-user silence plus Stuart-only visibility. |
| 2026-08-01 | Re-read the issue-pipeline boundary after the publication-receipt skill changed; the accepted supervised fixer, human acknowledgment, escalation, and no-autopublish decisions remain unchanged. | `plugin/skills/release-proof/SKILL.md` now requires a post-publication receipt produced from exact public npm/GitHub bytes and installed-host probes. It does not call `scripts/issue-fix.mjs`, post issue comments, or weaken ADR-050's prohibition on automated public mutations. Issue closure remains downstream of a verified release. |
| 2026-08-01 | Reconciled the executable fixer boundary with the accepted supervised-worktree decision: scheduled `unattended` mode is now read-only triage, while explicit `supervised` mode may prepare a tested local candidate but cannot push, comment, merge, commit, or promote. Removed the test-only observer from `governs:` so implementation status is derived from production surfaces rather than whether a unit test has a runtime caller. | `scripts/issue-fix.mjs` exposes `executionPolicy()`, defaults to `unattended`, removes git/gh from the worker allowlist, preserves dirty candidate worktrees as recovery evidence, and reports local candidate state to the integration owner. `tests/unit/fix-workstream-guidance.test.mjs` verifies the Brain guidance but is intentionally not a production caller; governing it caused `doc-currency` to downgrade an otherwise wired decision to `built` for the wrong reason. Public automation remains prohibited pending the GitHub App identity follow-up. |
| 2026-08-01 | Connected the accepted session-supervised worktree decision to the Brain's always-on fix behavior and the existing fail-closed release authority. Every non-trivial writing lane now receives one isolated worktree; focused evidence hands off to one clean integration owner; dirty lanes are retained for recovery; immutable candidate and publication seals govern promotion language. | The decision already required stable worktrees and human-controlled integration, while `plugin/skills/release-proof/SKILL.md` already rejected dirty/unbound release candidates. The missing seam was `plugin/skills/ruvnet-brain/SKILL.md`: it orchestrated fixes without requiring that delivery rail. `tests/unit/fix-workstream-guidance.test.mjs` now makes the connection executable and prevents a future guidance edit from removing it silently. |
| 2026-07-31 | Re-read the issue surfacer after first-session seed and update maintenance were serialized into one detached worker; I1-I3 are unchanged. | Commit `0f68737` changes only the Stable-Spine seed/heartbeat block in `plugin/scripts/session-start.sh` and adds `plugin/scripts/first-session-worker.mjs`. The open-issue count, human-acknowledgment predicate, SLA escalation, and fixer circuit breaker are untouched. |
| 2026-07-30 | Removed the default-off project-preference Node launch from SessionStart without changing the issue surfacer. | `plugin/scripts/session-start.sh` now calls the authoritative seed helper only when the settings file explicitly opts into new-project defaults. Issue counting, acknowledgment, escalation, and repair logic are untouched. |
| 2026-07-30 | Re-read the issue pipeline after project-default seeding and host-convergence messaging landed in SessionStart; I1–I3 are unchanged. | `plugin/scripts/session-start.sh` adds one-time nonsecret preference seeding and restart guidance. The open-count, acknowledgment, escalation, and fixer circuit-breaker logic in `scripts/issue-watch.mjs` and `scripts/issue-fix.mjs` is unchanged; GitHub App follow-up remains open. |
| 2026-07-29 | Re-read the issue surfacer after opt-in cold-start tracing was added around unrelated spine, heartbeat, and metering stages. The issue block and its acknowledgment/escalation semantics are unchanged. | Commit `66589f4`; governed path `plugin/scripts/session-start.sh`; PR #58 Windows job `90484507774`. |
| 2026-07-29 | Re-read the issue watcher, fixer, and SessionStart issue surfacer after PR #57. The later hook edits change manifest parsing, Windows path resolution, latency measurement, and lifecycle transport; they do not change the issue acknowledgment predicate, escalation state, or banner semantics. | Exact reviewed source head `989e19a`; governed paths `scripts/issue-watch.mjs`, `scripts/issue-fix.mjs`, and `plugin/scripts/session-start.sh`. GitHub PR #57 merged as `802886a`. |
| 2026-07-27 | **Re-read against the governed code; NO change required — every claim still holds.** Re-stamped to record that the reading happened | Flagged `presumed-stale` by `doc-currency`: 3 commits / 2 days after this document's last commit (`b4eed42`, 2026-07-24). The drift is real but lands entirely in `plugin/scripts/session-start.sh`, a hub file many ADRs govern — **`scripts/issue-watch.mjs` and `scripts/issue-fix.mjs` did not change at all.** The one issue-related line in that diff *upholds* this ADR rather than eroding it: ADR-054's off-switch explicitly lists "the open-issue SLA banner" among the things that **keep running while the brain is off**, because the issue pipeline must not be silenceable — this document's whole thesis, honoured by a later decision |
| 2026-07-27 | **Re-read again — same verdict, NO change required.** `scripts/issue-watch.mjs` / `scripts/issue-fix.mjs` are STILL unchanged since `b4eed42` (confirmed via `git rev-list`). `plugin/scripts/session-start.sh` moved 4 more commits (`19509f8` ASCII→SVG detector, `1978088` external-signal watch plane, `987590a` ADR-058 D8 stranger-matrix, `a285fcd` its merge) — all four append NEW, unrelated surfacer blocks (ascii-drift, CI-signal-watch, grounding-unproven) after the existing open-issue SLA block; none of them touch or restructure the open-issue counting/banner logic I1-I3 describe | Flagged `presumed-stale` again, 4 commits (0d) after this document's own last commit (`24b65ad`) |
