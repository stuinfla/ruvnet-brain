---
id: ADR-107
title: Issue autofix — one bounded unattended writer ships fixes for human-filed issues through the existing machine gates
status: Accepted
date: 2026-10-29
updated: 2026-10-30
version: 2.1.0
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [issues, automation, release, authority, safety, security]
amends: [ADR-050]
relates: [ADR-050, ADR-068, ADR-103, ADR-024]
governs:
  - scripts/issue-autofix.mjs
  - scripts/issue-autofix-night.mjs
  - scripts/issue-autofix-fix.mjs
  - scripts/issue-autofix-policy.mjs
  - scripts/issue-autofix-security.mjs
  - scripts/issue-autofix-gate.mjs
  - scripts/issue-autofix-sandbox.mjs
  - scripts/issue-autofix-agents.mjs
  - scripts/issue-autofix-prompts.mjs
  - scripts/issue-autofix-notes.mjs
  - scripts/issue-autofix-release.mjs
  - scripts/issue-autofix-comment.mjs
  - scripts/issue-autofix-diff.mjs
  - scripts/issue-autofix-exec.mjs
  - scripts/issue-autofix-release-ship.mjs
  - scripts/issue-autofix-release-util.mjs
  - scripts/issue-autofix-report.mjs
  - scripts/issue-autofix-state.mjs
  - scripts/issue-autofix-runner.mjs
  - scripts/issue-autofix-selftest.mjs
  - scripts/issue-fix-lock.mjs
  - scripts/issue-fix.mjs
  - deploy/com.ruvnet.issue-autofix.plist
  - config/issue-autofix/plan.schema.json
  - config/issue-autofix/verify.schema.json
  - config/issue-autofix/note.schema.json
  - config/issue-autofix/redteam.schema.json
  - config/scheduled-jobs.json
---

# ADR-107 — Issue autofix: one bounded unattended writer

**Status**: Accepted

**Related**: ADR-050, ADR-068, ADR-103

## Context

ADR-050 (2026-07-24) closed the fixer's public voice and left it read-only when scheduled: the
`unattended` mode triages, the `supervised` mode prepares a local candidate, and any autonomous
public action waited for a GitHub App identity boundary. ADR-068 and `docs/DDD.md` v0.3 stated that
no unattended source writer owns a developer checkout.

On 2026-10-29 the owner reversed the "no unattended source writer" position for issues that other
people file: a daily process that fixes open issues filed by other humans, end to end, with no human
in the loop. On 2026-10-30 he added three requirements: (1) a security gate, any finding of which
blocks the night's release, so that no malware enters the app; (2) fix every eligible open issue
each night, each independently, batched into one release, with an honest answer for every issue
that cannot be fixed; (3) a personal thank-you note per reporter, never a form letter. This ADR does
not argue for the reversal; it bounds it. The design spec is the integration owner's `AUTOFIX-SPEC.md`
(session scratchpad, 2026-10-29), as amended by this ADR.

## Decision

One mode, `autofix`, on `scripts/issue-fix.mjs`, driven by `scripts/issue-autofix.mjs` and run daily
at 10:30 local by the LaunchAgent `com.ruvnet.issue-autofix` (no editor, terminal or Claude Code
session is involved). The `unattended` and `supervised` modes are unchanged; `autonomous` is refused.

**What it may do.** Work only in its own clone (`~/.cache/ruvnet-brain/autofix-repo`) and linked
worktrees under `~/.cache/ruvnet-brain/issue-fix-worktrees/`. Push a new `release/X.Y.Z` branch, open
one pull request from it (so the required `canonical-qa` check runs on the exact SHA), fast-forward
`main` with `git push origin "${SHA}:refs/heads/main"`, dispatch `protected-release.yml` in
`mode=code`, and send at most one `recover-public-verification` dispatch per release. It comments on
and labels issues, and closes one only when its release is install-verified.

**What it may never do.** Touch the primary checkout; force-push or use `+refs`; delete a branch or
tag; call `gh pr merge` or the merge API; perform any publish operation (`scripts/release-authority.mjs`
enforces this); set repository variables or edit `.github/**`; close an issue that is not
install-verified; let any LLM stage run a command, reach the network, or touch git/gh; consume Dream
issues or PRs.

**A night.** S0 kill switch and lock; S13b follow-up of earlier releases (this runs even while halted:
it only reads and comments); resume of an unfinished release journal (nothing new starts until it is
finished); the release window; selection of every eligible issue, oldest first, and of person-filed
issues labelled `enhancement`, `design`, `question`, `discussion` or `needs-owner` (these get one
personal reply, never a fix). Each candidate's whole text is screened by rUv's AIDefence
(`@claude-flow/aidefence`, already a dependency; an unavailable scanner fails closed). Then, per issue
and independently, in its own worktree: plan (`opus`, read-only tools) → build (`sonnet`, file tools
only) → diff policy and the deny-by-default allowlist → static malware/secret scan → sandboxed test
validity (one repair round) → red-team (`opus`, sees only that diff, no tools) → independent verifier
(`opus`, read-only) whose evidence the orchestrator re-runs in the sandbox → fix commit. A failure
drops that issue only. Every passing fix is cherry-picked onto ONE `release/X.Y.Z` branch (one
version bump per night; a fix that does not apply on top of the others waits for the next night),
then census stamp, the mechanical ADR-0103 row, the night's security gate, `release:prepush`, the
local gates, push, preflight on the exact SHA, PR checks, `release:prepush --pre-dispatch`, the
fast-forward, protected-release, the terminal install check, and one note per person. The time
budget (9.5 h internal, 3.5 h reserved for the release, `JOB_MAX_SECONDS` 10 h) decides how many
issues a night takes; the rest wait for the next night.

**The security gate** (owner requirement 1; any finding blocks):
1. *Deny-by-default editable paths* (`scripts/issue-autofix-security.mjs` `isEditablePath`): only
   ordinary source, docs and tests (`scripts/*.mjs` top level, `plugin/scripts/**`, `plugin/mcp/**`,
   `kb/*.mjs`, `console/**`, `docs/**/*.md` except ADRs, `tests/unit|integration|regression|fixtures/**`).
   Never: `.github/**`, CODEOWNERS, any dotfile or dot-directory, manifests and lockfiles, `bin/**`,
   `deploy/**`, `config/**`, `data/**`, `keys/**`, `docs/adr/**`, `plugin/hooks/**`, shell and binary
   files, and any file whose name mentions release, install, update, sign, verify, key, token,
   secret, auth, download, hook, heartbeat, watchdog and similar trust machinery. The ADR-0103
   governed set and the older protected patterns still apply on top.
2. *Manifest and lockfile*: only the `"version"` fields may change — no dependency, lifecycle
   (`preinstall`/`install`/`postinstall`/`prepare`…) or package script change.
3. *Static scan of every added line*, tests included: network egress to non-allowlisted hosts,
   process execution, dynamic code (eval, Function, vm, computed require/import), obfuscation
   (base64/hex blobs, char-code building, escape runs, high-entropy literals), credential and env
   harvesting, writes outside the repo, fetch-and-execute, hidden Unicode (bidi, zero-width,
   homoglyph identifiers, line-terminator tricks), module tampering, native code, install hooks,
   prototype pollution; plus a secret and local-path scan of the diff text.
4. *`npm pack --dry-run` file list* against the last published release: no unexpected file, no
   unexpected size change outside reviewed paths, no binary.
5. *`npm audit`*: no NEW high or critical advisory relative to `origin/main`.
6. *Red-team*: a fresh `opus` session that sees only the diff and a malice rubric, once per fix and
   once over the whole night's batch. Its claims are re-checked by the orchestrator: any finding,
   any verdict but CLEAN, or a "not present" answer that the static scanner contradicts, blocks.
A finding on one fix drops that fix and places the issue on security hold (URGENT page; it is never
retried until a person labels it `autofix:go`); a finding at the night level blocks the release.

**Running stranger-influenced code.** No LLM stage can run a command: every `claude -p` call is
`--restricted --safe-mode --tools <list> --permission-prompts none --strict-mcp-config` with an empty
MCP config and no Bash. Measured live on claude 2.1.314 (2026-10-30): with these flags a planted
`.claude/settings.json` hook and a planted CLAUDE.md are inert, reads and writes outside the working
directory are refused, writes to `.claude/settings.json` and `.git/hooks` are refused, and the
subscription login works with no API key. Code a model wrote runs only in the orchestrator, after the
static scan, under macOS `sandbox-exec` (`scripts/issue-autofix-sandbox.mjs`): no outbound network,
no keychain lookups, no reads of `~/.ssh`, `~/.npmrc`, `~/.config` (where `gh` keeps its token),
`~/.claude`, `~/Library`, `~/Code` and similar, writes only in the worktree and a temp dir, and an
environment with no tokens and a temporary HOME. Measured on this Mac (2026-10-30): a malicious test
inside the sandbox could read none of those, could not resolve or fetch a host, and saw no token;
vitest ran normally. Off macOS nothing runs (`sandbox-unavailable`). The shared `node_modules` is
checked after each build for writes through the link (`modules-tampered`).

**Kill switch and resumability.** The repository variable `ISSUE_AUTOFIX` must be exactly `on`, and
`~/.config/ruvnet-brain/issue-autofix.off` must be absent; unset or unreadable (offline) counts as
off. It is re-read before every stage and immediately before every irreversible step: branch push,
PR create, `main` fast-forward, dispatch, recovery dispatch, and every comment. The release is a
journal in the state file; every step first looks for its own effect on GitHub (branch at the SHA,
open PR for the head, `main` at the SHA, a `protected-release code X.Y.Z` run), so a run cut off by a
dropped connection, Mac sleep, the kill switch or the wall clock is finished by the next armed run
without a second push, PR or dispatch. A dispatched run that has not appeared is looked for again,
never re-dispatched; after 30 minutes it needs a person.

**Self-halt.** A definite red after `main` moved (a concluded red protected-release, a terminal
check that fails after it, a lost fast-forward race) writes `~/.config/ruvnet-brain/issue-autofix.halt`
and pages urgently; only a person removes it. A transient failure after `main` moved does NOT halt:
it pauses, pages urgently that `main` is ahead, and the next run resumes. A red before the
fast-forward changes nothing public and keeps the branch; the window stays closed on that branch
until a person deletes it (the job never deletes a branch).

**What reporters are told** (owner requirements 2 and 3). Every comment begins with `BOT_MARKER`
and ends with a hidden dedupe marker read from the live thread. Kinds: `fixed` (install-verified;
closes the issue), `shipping` (published, verification still finishing), `findings` (a root cause
with file and line that needs a maintainer), `not-fixed` (a fix was tried and did not pass
verification or the security gate; it says so plainly and reveals nothing about what was detected),
`reply` (a request or question; nothing changed). Each comment carries "Checked / Not checked" lines
built from machine facts, never from a model. One note per person per night covers all of that
person's issues and sits on the first of them. It is written fresh by `opus` from the person's own
words in the full thread and must pass `scripts/issue-autofix-notes.mjs`: it quotes something the
person wrote, is not boilerplate or generic, shares no 6-word run and no opening or closing with any
note ever posted to anyone, apologises plainly after a wait of more than 7 days, mentions only the
reporter, carries no closing keyword, path, secret or model internals, and claims no fix or platform
the facts do not show. A rejected note is regenerated with the reasons (up to 3 times); if none
passes, the factual report goes out without it and the owner is paged to write one.

**Identity (decision recorded 2026-10-29).** The owner's `gh` token as a fallback; a
repository-scoped GitHub App without `workflows` permission is follow-up F1 (ADR-050 Phase 2).

**Where it runs.** launchd starts `scripts/job-heartbeat.sh` → `node scripts/issue-fix.mjs --mode autofix`
from the job's OWN runner worktree, `~/.cache/ruvnet-brain/autofix-runner`, a detached worktree of its
clone pinned to the newest install-verified release tag (`scripts/issue-autofix-runner.mjs`) — never
the owner's checkout. After each run the runner moves to a newer tag only when that tag is npm's
latest, GitHub's latest release and resolves as install-verified, and only if the runner tree is
clean. Every file in the import closure of what launchd runs is outside the editable allowlist (a
test walks the closure), so the job can never change the code it runs; only a person's release can.
Pages read the ntfy topic from `$NTFY_TOPIC` or `~/.cache/ruvnet-brain/ntfy-topic`.

**Self-test.** `node scripts/issue-fix.mjs --mode autofix --self-test` proves, from wherever it is
started, every outside dependency: tools on PATH, HOME, no API key in the environment, `gh` logged in,
the kill switch readable, `caffeinate` holding an assertion, the sandbox refusing a planted credential
read, the network and a home write, a restricted tool-less `claude -p` served by `opus` on the
subscription judging a planted payload not CLEAN, and a delivered page. It writes a receipt beside the
nightly ones and changes nothing in the repository or on GitHub.

**Rehearsal.** `node scripts/issue-fix.mjs --mode autofix --rehearse [--base <sha>] [--only n,m]` runs the real
night — real model stages, gate and sandbox on real open issues — with every write that would reach GitHub refused
by the exec layer (push, comment, label, close, PR, workflow, dispatch, variable), its own state file and no pages;
the comments it would post are in its receipt. `--base` cuts the worktrees from an older commit, to replay issues a
person has since fixed and compare.

**Arming.** The code ships disarmed. The integration owner arms it only after the simulations
(`tests/integration/issue-autofix-simulate.test.mjs`, `tests/integration/issue-autofix-simulate-night.test.mjs`)
pass and, from launchd under a test label, both the self-test and a live `--dry-run` pass. Arming is:
`node scripts/issue-autofix-runner.mjs --install --tag v<released>`; copy the plist to
`~/Library/LaunchAgents/`; `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.ruvnet.issue-autofix.plist`;
`gh variable set ISSUE_AUTOFIX --body on`. Disarming is `gh variable set ISSUE_AUTOFIX --body off`
or creating the local off file; `launchctl bootout gui/$UID/com.ruvnet.issue-autofix` unloads it.

**ADR-050 is amended**, not superseded: I1 and I2 bind autofix unchanged; I3 now allows, after the
acknowledgment, one outcome comment per shipped version, one findings or not-fixed comment per issue
update, and one reply per issue, ever — never a progress or timeout note.

## What this gives up

1. **Unread code reaches every user.** The allowlist, static scan, two red-team passes, sandbox and
   independent verifier narrow this; a plausible, subtly wrong but non-malicious change in an
   editable file can still ship with no person reading it.
2. **Regex scanning is defense in depth, not proof.** A payload split across lines or built from
   aliases can evade it; the red-team and the sandbox sit behind it. False positives are deliberate.
3. **Local gates run unsandboxed.** `npm test` and `release:qualify` on the release worktree run with
   the owner's environment, after every security check has passed.
4. **Install-verified does not mean fixed for the reporter.** The comment says what was not checked.
5. **`main` can sit ahead of npm** after a red or a pause past the fast-forward until a person or the
   next run acts; force-push is forbidden.
6. **The note is model-written** and nobody reads it before it posts; the guards bound genericness,
   repetition and false claims, not tone.
7. **Subscription quota** competes with the owner's interactive work.
8. **Owner-token identity until F1.**
9. **A failed release branch closes the window** until a person deletes it.
10. **A machine-written ADR-0103 review row** when the governed changes are version-only.

Follow-ups: F1 GitHub App identity; F2 reopen when a reporter replies after close; F3 footprint
classification for `issue-fix-worktrees`; F4 sandbox the local gates; F5 a corpus lease so the
nightly corpus cannot race a release in flight (needs an ADR-0091 amendment).

## Currency log

| 2026-10-30 | Version 2.1.0, after the supervised launchd runs and three real rehearsals on issues 499 and 500 (nothing reached GitHub). Each found a defect no simulation had: (1) under launchd the keychain's Claude login was an expired session (`claude auth status`: loggedIn false), so the stages now run with keychain lookups denied and use the file login the owner's sessions keep fresh (launchd self-test: served by opus, PASS); (2) vitest writes `node_modules/.vite-temp`, refused when node_modules was a link into the shared install, so each worktree owns a directory of links; (3) the sandbox's read-deny on `~/.cache/ruvnet-brain` hid that shared install, so its link targets are re-opened for reading; (4) the note guard rejected four truthful notes ("nothing has shipped yet", quoted `resolved.projectRoot`), so only asserted states count as claims; (5) a planner put prose in `testPlan.newTests`, now a path-only schema and a retried `plan-malformed`, never a public verdict; (6) a builder's test ran `git init` through child_process, so the build prompt states the test-code rules. Also: the runner worktree, `--self-test`, `--rehearse`, stale release branches and PRs below main no longer close the window, and the closure test that keeps the job from editing its own code (it found `scripts/architecture-review-lock.mjs` editable). Every fix has a test that fails without it. | Written by the integration agent (Claude Opus 5.5); no person reviewed the code. Evidence: launchd self-test and rehearsal receipts under `~/.cache/ruvnet-brain/issue-autofix/runs/` on the owner Mac. |
| 2026-10-30 | Version 2.0.0: owner requirements of 2026-10-30 (security gate, every eligible issue per night in one release, personal notes) and the adversarial review findings (stranger-influenced code ran unsandboxed with the owner's credentials; `--setting-sources project` loaded worktree hooks; a kill-switch abort after the fast-forward exited silently; no kill-switch re-read before PR create, comments or recovery; the production test-validity scratch worktree had no `node_modules`; the issue title entered commit messages). Source read: `scripts/issue-autofix*.mjs`, `scripts/issue-fix.mjs`, `config/issue-autofix/*`, `deploy/com.ruvnet.issue-autofix.plist`. | Written by the integration agent (Claude Opus 5.5) under the owner's instruction; the security, notes and unit-suite modules were built by sub-agents and checked by the integration agent; no person reviewed the code. Simulations and the launchd dry-run results are recorded in the release evidence. |
| 2026-10-29 | Reviewed on decision: the owner reversed ADR-050's "no unattended source writer" for person-filed issues and this ADR bounds the replacement. Source read: `scripts/issue-fix.mjs` (mode policy), `scripts/issue-autofix-policy.mjs`, `scripts/issue-fix-lock.mjs`, `deploy/com.ruvnet.issue-autofix.plist`. | Owner instruction 2026-10-29; ADR-050 amendment; `docs/DDD.md` v0.4; `CONTRIBUTING.md` 1.6.0. Code is built and unarmed. |
