---
id: ADR-051
title: Codex host wiring — register MCP and adapt the full lifecycle without version-pinned commands
status: Accepted
date: 2026-07-24
updated: 2026-08-19
authors: [Stuart Kerr, Claude Code]
tags: [codex, mcp, install, doctor, honesty, portability]
supersedes: []
relates: [ADR-023]
governs:
  - bin/install.mjs
  - .codex/config.toml
  - .codex/hooks.json
  - plugin/skills/*
  - plugin/skills/rvbc/SKILL.md
  - plugin/commands/brain-console.md
  - plugin/commands/rvcb.md
  - plugin/.codex-plugin/plugin.json
  - plugin/hooks/codex-hooks.json
  - plugin/scripts/codex-hook-adapter.mjs
  - plugin/scripts/codex-hook-wrapper.mjs
---

# ADR-051: Codex host wiring

**Status**: Implemented
**Date**: 2026-07-24
**Related**: ADR-023


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `bin/install.mjs` now exits non-zero when `--update` lands nothing (issue #106), `kb/forge-update.mjs` releases its rollback on the no-op path and keeps it on the damaged path (#108), and `scripts/health-repair.mjs` no longer reports a hollow "fed 0" (#104). Checked against this decision: these changes implement its honesty requirement — no clause here is contradicted or superseded.


> **Reviewed 2026-08-04 (4.0.9).** Governed code moved: `bin/install.mjs` (runUpdate now converges the managed router catalog, #87), `console/app.js` + `console/style.css` (a third not-checked provider state so an unloadable catalog is never rendered as a finding about the user credentials, #86), and `scripts/model-router-catalog.mjs`. Checked against this decision: the host wiring, the grader contract and the 95 thresholds are unchanged — these make an existing claim honest and reach an existing merge from the update path. Console re-graded 96/100 at 1440 and 1920 under the design wall. No clause contradicted or superseded.


> **Reviewed 2026-08-04 (4.0.11).** Governed code moved: plugin/.codex-plugin/plugin.json carries the 4.0.11 generation, and plugin/scripts/session-start-core.mjs now surfaces ONE customer-facing version (the plugin/bundle split is routed to the maintainer instead of printed to users, per #77). Checked against this decision: the Codex host wiring, its hook registration and its skill payload are untouched; this changes what is DISPLAYED, not what is wired. No clause contradicted.


> **Reviewed 2026-08-05 (4.0.12 PUBLISHED).** Governed code moved: plugin/.codex-plugin/plugin.json carries the 4.0.12 generation, promoted from 4.0.12-dev and published to npm. Checked against this decision: the Codex host wiring, hook registration and skill payload are unchanged — this is a version promotion, not a wiring change. No clause contradicted.


> **Reviewed again 2026-08-05, later same day (4.0.14-dev).** tests/unit/dispatch-gate-wiring.test.mjs now uses pathToFileURL() for its dynamic import: a raw absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows, where the drive letter reads as a URL scheme. ci.yml:147 records this as cluster 7, fixed 2026-07-26; that test reintroduced it the day it was written. Codex host wiring, hook registration and the skill payload are unchanged.

> **Reviewed 2026-08-06 (4.0.16-dev).** Governed code moved: plugin/scripts/continuation-gate.mjs now also derives open work from signal-watch's ci-status.json, so a RED build on main counts as outstanding work — the gate previously saw only open issues and stayed silent while ci was red. tests/unit/dispatch-gate-wiring now sets USERPROFILE alongside HOME, because os.homedir() ignores HOME on Windows and the fixture was pointing the detector at the real user profile. Checked against this decision: the gate's channel, its fail-open posture and its loop-safety guards are unchanged; this widens what counts as evidence, not what it may say.

## Context

Issue #42 (Henrik Pettersen, observed on 3.9.68-dev / plugin 3.9.70-dev, `npx ruvnet-brain` on
Linux) reported that on a Codex host the brain is **entirely unavailable** — no `search_ruvnet`, no
skills, no commands — while every artifact needed was already shipping. The gap was not a missing
capability; it was a missing *registration*:

- `plugin/mcp/server.mjs` ships and works. `plugin/.mcp.json` declares it — for Claude Code only,
  and cannot be reused verbatim because it depends on `${CLAUDE_PLUGIN_ROOT}`, which Codex does not
  expand.
- `.codex/config.toml` ships with `[shell_environment_policy]` and **no `[mcp_servers.*]` at all**.
- `bin/install.mjs` had 21 `codex` references and every one of them *read* `~/.codex/auth.json` to
  classify the user's subscription for cost-routing. Nothing ever wrote `~/.codex/config.toml`.

The failure was invisible, which is the worse half of it: `--doctor`'s health predicate is
`repos > 0 && reader && mcp`, all three Claude-Code-side facts, so a machine where Codex could reach
nothing still printed "Healthy … Grounding PROVEN" and then "It works in EVERY project".

The same directory carried a second, separate defect: `.codex/hooks.json` shipped
`"/bin/bash \"/Users/<maintainer>/Code/ruvnet-brain/plugin/scripts/version-bump-gate.sh\""` — a
maintainer's absolute path that exists on no other machine, invoking an interpreter that is not a
valid path on native Windows. That is the same failure class as ruvnet/ruflo#2132 and #2721, where a
hardcoded `/bin/bash` in `hooks.json` made every tool call report `hook (failed) exit code 1`.

Issue #52 exposed the lifecycle half that the original decision explicitly left out. Codex had the
MCP server, but no Brain-owned SessionStart, UserPromptSubmit, tool, learning, SessionEnd, or Stop
behavior. When Codex later began importing the Claude plugin automatically, that did not close the
gap: Codex 0.145.0 rejected both `plugin/hooks/hooks.json` and `.codex/hooks.json` before dispatch
because their top-level `_note` field is not in Codex's hook schema. Even if parsing had succeeded,
Claude's Stop `hookSpecificOutput.additionalContext` is not Codex's continuation contract, and
versioned plugin-cache entrypoints become dead paths when an already-open session survives an
upgrade that removes its old cache generation.

**Grounding.** Current Codex plugin discovery is verified at the installed boundary with
`codex plugin marketplace add`, `codex plugin add`, and `codex debug prompt-input`. That live path
discovers native `plugin/skills/<name>/SKILL.md` files and migrates eligible Claude commands. The
older repo-local `.codex/skills/*/skill.toml` convention is not the shipped plugin skill surface.

## Decision

### 1. Install-time registration, not documentation

The active Codex home is `$CODEX_HOME` when set, otherwise `~/.codex`. When that directory is
present — the same detection surface the installer's existing `codexAuth` probe already reads —
`wireCodexHost()` registers `[mcp_servers.ruvnet-brain]` in `<active Codex home>/config.toml` with
`command = "node"` and a single resolved absolute path argument. It runs in the main install flow
next to `wirePlugin()`, wrapped in the same non-fatal `try` every other wiring step uses: a second
host we cannot reach must never break the one we can. A machine with no active Codex-home directory
is not a warning — nothing is said and nothing is changed.

### 2. Merge, never clobber

`<active Codex home>/config.toml` (normally `~/.codex/config.toml`) is the *user's* file and already carries their settings (ours ships
`[shell_environment_policy]` plus a `RUFLO_HARNESS_LOOP` var). There is no TOML dependency in this
package and adding one to write six lines is not worth it, so our lines live inside a
comment-delimited managed block:

```toml
# --- ruvnet-brain (managed block, installer-rewritten) ---
[mcp_servers.ruvnet-brain]
command = "node"
args = ["/absolute/path/to/server.mjs"]
# --- end ruvnet-brain ---
```

Three outcomes, and the third is the one that matters:

| Found | Action |
|---|---|
| our markers | rewrite exactly those bytes in place |
| nothing | append the block |
| `[mcp_servers.ruvnet-brain]` **outside** our markers | change nothing, and say so |

The third case is a user's hand-written entry. Their config outranks our convenience, so we report it
and tell them how to hand it over rather than overwriting it. Every byte outside the markers is
preserved, and re-running over our own output reproduces it byte for byte — the merge is a pure
function (`mergeCodexConfig`) precisely so that idempotency is testable without going near a real
`~/.codex`.

### 3. The registered path must outlive the install

`args` gets a **resolved absolute path**, and it may not be the npx checkout: that directory is
ephemeral, and registering it would rot the moment it vanished. The installer already solved this
twice — the spend watchdog and the router tools are copied under `~/.claude` for exactly this reason
("stable path — the npx dir vanishes"). `plugin/mcp/server.mjs` and its local, Node-builtins-only
`managed-cli-interface.mjs` sibling are copied under `~/.claude/ruvnet-brain/mcp/`; only the stable
absolute `server.mjs` path is registered. `wireCodexHost()` copies the dependency first and swaps
the server second, both atomically. The sibling implements the structured `ruvnet_cli_help` /
`ruvnet_cli_run` boundary; it is an implementation dependency at the same persistent boundary, not
a second registration or an ephemeral npx path. This also means the wiring does not depend on
Claude Code being installed, which matters because the whole point is Codex-only hosts.

### 4. The doctor probes; it does not assert

`--doctor` gains one line derived entirely from disk, never from the fact that an install once ran:

- **`Codex: wired`** — our entry is in `config.toml` **and** the `server.mjs` it names exists. Both
  halves are required: a registration pointing at a deleted file is worse than no registration,
  because Codex fails at spawn time with nothing to read.
- **`Codex: host detected but NOT wired`** — with which half is missing, and the one command that
  fixes it.
- **`Codex: no host detected`** — dim, informational, no call to action.

The doctor reads the active Codex home. It decodes the JSON-escaped TOML argument before checking
whether the named server exists, so quoted Windows paths retain their real backslashes and quotes;
a malformed argument is treated as unwired, never guessed valid.

**2026-08-01 readiness refinement.** Registration and live readiness are now reported as separate
facts. The managed Codex block declares a 30-second startup deadline. `tools/list` returns the
protocol shell's stable declarations immediately, while the first real search joins worker
initialize/warmup and records `registered | ready | degraded` in `mcp-readiness.json`. Doctor still
derives wiring from config plus the server path, but it reports readiness separately and fails on a
live degraded receipt. A registered state is not promoted to live grounding proof.

And the banner is scoped honestly: when a Codex host is detected but unwired, "It works in EVERY
project" becomes "It works in EVERY project in Claude Code … Codex is NOT wired yet". The original
sentence is a true claim about Claude Code that would be read as a claim about every editor, which is
precisely the invisible gap #42 reported.

### 5. Native plugin skills are the Codex command surface

Codex discovers the prose contracts under `plugin/skills/*/SKILL.md` directly. The plugin therefore
ships native skills for every durable Brain workflow, including `brain-console` and `whats-new`.
Those two are self-contained because the real command migrator drops rendered commands above its
size ceiling and does not copy sibling Markdown files into the generated skill directory.

The Claude commands remain available, but migrated aliases must also be self-contained. In
particular, `brain-console.md` and `rvcb.md` carry their own launch procedure instead of telling
Codex to read an absent `rvbc.md` beside the generated `SKILL.md`.

The obsolete `.codex/skills/*/skill.toml` files are removed. They were neither the native plugin
surface nor exercised by the installed loader, so retaining them created a second, misleading
contract. `search_ruvnet` remains reachable through the registered MCP server; `savings` remains a
native plugin skill.

### 6. The project file is schema-valid and deliberately empty

`.codex/hooks.json` is now a real Codex config source, so its top level is limited to the documented
`description` and `hooks` fields. It stays empty because lifecycle behavior is user-global and owned
by the installed plugin; duplicating the same handlers at project scope would fire them twice.
`version-bump-gate.sh` remains a maintainer-only dev convenience and is not smuggled back into the
product hook surface.

### 7. One hook implementation, a Codex adapter, and a generation-independent door

`plugin/.codex-plugin/plugin.json` points Codex at `plugin/hooks/codex-hooks.json`, not at Claude's
host-specific registration file. Every Codex command enters through the same installed path:

```text
<parent of active Codex home>/.cache/ruvnet-brain/codex-hook.mjs
```

`wireCodexHost()` copies that self-contained wrapper atomically beside the Brain's stable cache.
With the default Codex home this remains `~/.cache/ruvnet-brain/codex-hook.mjs`; an isolated
`CODEX_HOME` keeps the wrapper beside that isolated home rather than leaking state into the login
home.
The wrapper reads `active.json` on every invocation, resolves only a contained
`versions/<version>/` generation, and runs that generation's `codex-hook-adapter.mjs`. Therefore an
already-loaded command never names the plugin cache generation that an updater may remove.

The adapter then runs the existing shared `hook-shim.mjs` and hook bodies. It translates only real
host differences: Codex `session_id` becomes the learner's `CLAUDE_SESSION_ID`; bracket-prefixed
UserPromptSubmit text is wrapped as valid `additionalContext`; Claude's Stop continuation envelope
becomes Codex `decision: "block"` plus `reason`; and invalid advisory
`permissionDecision: "defer"` is removed rather than promoted into a deny. SessionEnd is registered
at Codex's actual three-second maximum. The bodies and their Brain off/on law remain single-source.

### 8. Initial installation and continuing convergence share one installer

Codex is not a one-time side branch. The Stable Spine's `host-update.mjs` invokes the published
installer in update mode; that path refreshes stable MCP/wrapper files, synchronizes the Codex
plugin through Codex's supported marketplace lifecycle, preserves an intentional disabled state,
and requires the installed version to equal the candidate exactly. `update-apply.mjs` discovers
staged payloads in both Claude Code and Codex caches, so a Codex-only SessionStart can advance the
same runtime Spine without a `claude` executable.

## Consequences

**Good.** `search_ruvnet` becomes reachable in Codex, which the reporter correctly identified as the
substantive capability. The doctor can no longer print an unqualified clean bill of health on a
machine where a detected host reaches nothing. The leak class is dead: a repo-wide test walks every
shipped file under `.codex/` and `plugin/` and fails on any `/Users/<account>/` path, so it fails on
reintroduction rather than on a reporter noticing — and it is proven against the exact line that
shipped in 3.9.70-dev, not merely against a clean tree.

Writing that guard turned up something worth recording: a naive `includes('/Users/')` also flagged
`plugin/scripts/session-start.sh` and `plugin/scripts/learn-capture.sh`. Both are comments — one
*explaining this very bug class*, one illustrating the learner with `cd /Users/me/ClientProject`.
Neither is a leak, and a guard that forbids documenting a defect is a guard that gets deleted. So the
rule flags a concrete home directory and allows a short, explicit placeholder list (`me`, `<maintainer>`,
`<user>`, …); `stuartkerr` is not on it.

**Costs, honestly.** The stable MCP shell and its structured-interface sibling now each exist at the
plugin path and the registered persistent path, so either copy can drift from the plugin's. The
drift is bounded by design — the shell proxies search to
`~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs`, while the sibling exposes a small allowlisted CLI
boundary; their schemas are part of the frozen contract (ADR-023), and the self-updating knowledge
half remains the brain. Each reinstall refreshes both files, dependency first, with atomic
replacement. An active Codex-home directory existing is treated as "a Codex host", which is a
heuristic: a leftover directory would get an entry it never asked for, inside a clearly marked and
removable block.

The wrapper is a second stable shell alongside the MCP supervisor. That duplication is intentional:
the command must survive plugin-cache replacement, while behavior continues to hot-swap through
`active.json`. A missing or invalid active adapter fails silent so a broken optional Brain hook never
prevents Codex from starting or stopping.

**Not tested.** Windows command expansion for the stable wrapper is not yet proven on native
Windows. Hook trust still requires explicit user review in `/hooks`; installation must never bypass
that review. Native skill discovery is proven with the installed Codex loader on macOS, not yet on
native Windows.

## Follow-ups

- **A CI guard for the leaked-path class.** The unit test added here (`codex-wiring.test.mjs`) walks
  `.codex/` and `plugin/` for `/Users/<account>/`, which catches it on any run of the suite. Promoting
  it to a dedicated pre-push/CI gate — extended to every shipped surface rather than those two trees,
  and to the other developer-path shapes (`/home/<account>/`, `C:\Users\`) — is the remaining work.
  The placeholder allowlist is the part to watch: it is the one place where a real leak could hide by
  choosing a permitted name.
- Add a native-Windows lifecycle round trip for the stable wrapper command.
- Make installer/doctor output distinguish active hooks from pending trust and print the exact
  `/hooks` review procedure while definitions are pending.

## Currency log
| 2026-08-10 | **The Codex host's dependency copy is now DERIVED from server.mjs, and this ADR's contract is strengthened.** | The wiring hand-listed `managed-cli-interface.mjs` and `runtime-preferences.mjs` — a second copy of the server's own import graph. ADR-067 added one import and the Codex host shipped a server whose sibling was absent: `tests/unit/npm-tarball-codex.test.mjs` caught it on the packaging boundary as "no reply to initialize in 15s". `serverDependencies()` now walks the real imports transitively and preserves each specifier so `./x` and `../scripts/y` both land where the server looks. Registration, wrapper, adapter and doctor lines unchanged; what changed is that a future import cannot silently break this host. |
| 2026-08-03 | Re-read Codex wrapper behavior against the packed 4.0.8 host proof; no contract change. | PR #100 exact-SHA release evidence is green; Windows unit remains the sole required red lane. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-19 | **Codex host parity closed: the gate is routed there, and the manifest carries only the two top-level keys Codex's parser accepts.** | The both-hosts conformance gate (added 2026-08-14) asserted that Claude Code routed PreToolUse through `decision-gate` while `codex-hooks.json` invoked policies individually — so `identifier-preflight`, `degradation-watch` and `adr-currency` were unreachable on Codex with no stated reason. Now routed, and the gate goes red if the hosts diverge again. The `hostParity` metadata block that documented this was REMOVED from codex-hooks.json deliberately, not lost: Codex 0.147.0 rejects any top-level key beyond `description` and `hooks` (ADR-055 F17, same class as the `_note` keys). Re-adding it during this pass broke `codex-claude-hook-parity` immediately, which is the test doing its job — the parity record belongs in this ADR, where no parser reads it. Codex's complete event set is pre_tool_use, permission_request, post_tool_use, session_start, user_prompt_submit, session_end and stop; `swarm-slot-recycler` is DECLARED ABSENT there because Codex has no TeammateIdle event. |
| 2026-08-10 | **Re-read after #128/#129; this decision is STRENGTHENED, not changed.** | Both governed changes move toward this ADR. #129: the macOS LaunchAgent and the printed cron recipe used to schedule `kb/forge-update.mjs --apply`, the KB-only path — so a *scheduled* update never reached the Codex registration, wrapper or adapter this ADR specifies, and only in-session updates did. Both now run the exact argv `plugin/scripts/host-update.mjs` uses (`--update --host-sync-only --no-nightly-prompt`), so the wiring contract holds on every path rather than one. #128: stale generations in `~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/` each carry their own `codex-hooks.json` and are still discovered; pruning them is what makes "one registered generation answers" true on disk. The registration, wrapper, adapter and doctor lines are unchanged. |
| 2026-08-07 | **Re-read after the #123 convergence fix; Codex host wiring is unchanged.** | `bin/install.mjs` is governed here, and the change is confined to version COMPARISON in host convergence — `installed === expected` became `installed >= expected`, so a `-dev` build ahead of the published release stops being reported as a broken install. The Codex registration, the stable wrapper, the adapter and the doctor's three Codex lines are untouched. Notably this ADR is titled '…without version-pinned commands', and the defect being fixed was precisely a version pin in disguise: an equality test standing in for an ordering test. The fix moves further in this decision's direction, not against it. |
| 2026-08-06 | **Fourth re-read today; NO change required. Same version-only cause.** | `4.0.19 → 4.0.20-dev` (`sync-version.mjs`) after the 4.0.19 candidate was withdrawn: the publisher rejected its own evidence on a key-order comparison, so main stopped asserting a clean version it had not shipped. Only the manifest `version` field moved; no Codex wiring, adapter, wrapper, skill or command file. See the structural note in the row below — this ADR governs a file rewritten by every bump, which is why it lands here on each one. |
| 2026-08-06 | **Third re-read today; still NO change required — and the repetition is the finding.** | Same cause a third time: the only governed movement is `plugin/.codex-plugin/plugin.json` `"version"` (`4.0.18 → 4.0.19-dev`, `c83c1b0`), no Codex wiring touched. Worth naming rather than repeating silently: this ADR `governs:` the codex plugin manifest, and `sync-version.mjs` rewrites that manifest on EVERY version bump, so every bump marks this document presumed-stale regardless of whether anything it describes moved. That is a false positive by construction, and a currency gate that fires on every bump trains people to stamp without reading — the exact failure that produced a blanket 61-ADR stamp in this repo. The honest fix is to narrow `governs:` to the Codex wiring this ADR actually decides, not the manifest's version field; recorded here rather than done in a release-repair commit. |
| 2026-08-06 | **Re-read again after the release-rail repair; still NO change required.** | Flagged `presumed-stale` a second time the same day. Same cause, same verdict: across all 23 governed paths the only movement is `plugin/.codex-plugin/plugin.json` `"version"`, this time `4.0.18 → 4.0.18-dev` as `sync-version.mjs` returned main to the unreleased suffix after the release-identity deadlock was found (`66e71ea`). No Codex registration, adapter, wrapper, skill or command file moved. Restating the reason rather than pointing at the row below, because "same as last time" is how a currency log stops being read: this ADR is titled "…without version-pinned commands", so a version string is the one class of change it is constructed to be immune to. |
| 2026-08-06 | **Re-read against the governed code; NO change required — every claim still holds.** | Flagged `presumed-stale`: 2 commits (0d) after this document's last commit. Read the actual diff rather than the file list — `git diff 7b3ce4c..HEAD` across all 23 governed paths returns exactly ONE changed line, `plugin/.codex-plugin/plugin.json` `"version": "4.0.17-dev" → "4.0.18-dev"`, from `scripts/sync-version.mjs` during the #78/#83/#84 commit (`5206ef5`, `14803f5`). No Codex wiring, registration, adapter, wrapper, skill, or command file moved at all. This ADR is titled "…without version-pinned commands" and §1-6 turn on the wrapper being the single generation-independent entrypoint, so a version-string bump is precisely the class of change the decision was made to be immune to — if this row required a contract change, the ADR's central claim would already be false. The one governed-adjacent file the same commit did touch, `tests/acceptance/issue-78-codex-cold-mcp.acceptance.test.mjs`, only adds a host-unavailable skip so a credit-exhausted Codex account stops being reported as a Brain defect; the MCP registration it exercises is unchanged. |
| 2026-08-03 | Gave the held-open registered-command probe a 2s process-start budget on every host while retaining the 250ms wrapper input deadline. | The hosted full-suite check still killed the first `SessionStart` process at the 750ms outer budget under runner contention; the assertion itself remains unchanged and still proves completion without stdin EOF. `tests/unit/codex-lifecycle-hooks.test.mjs`, commits `1a1136e` and `70c4441`. |
| 2026-08-03 | Re-read the governed Codex host surface after the 4.0.8 wrapper and release-QE repairs. | `plugin/scripts/codex-hook-wrapper.mjs` and the installed Codex registration remain aligned: the wrapper is the single generation-independent entrypoint, now with bounded held-open pipe handling; commits `640ae01` and `1e728b0`. |
| 2026-08-02 | Re-read the 4.0.8 Codex hook and public-proof changes; stable registration and generation-independent dispatch remain intact. | ADR-062 changes `bin/install.mjs`, `plugin/hooks/codex-hooks.json`, `plugin/scripts/codex-hook-wrapper.mjs`, and the release-proof skill so packed hooks must pass held-open stdin and public Codex-only/dual installs must run doctor plus functional MCP search. Exact-SHA CI and public receipts remain authoritative. |
| 2026-08-02 | Re-read the final 4.0.7 Codex payload and installer changes; stable MCP registration, managed configuration, lifecycle adaptation, generation-independent hooks, and native skill discovery remain intact. | Commits `3668b1b`, `67b283e`, and `78e897b` add installed provenance, bounded swarm-slot recycling, and the remote release transaction through `bin/install.mjs`, the packaged skills, and the Codex plugin manifest. They preserve disabled-plugin state and do not create a second host transport. Exact-SHA CI and public clean-install proof remain release gates. |
| 2026-08-02 | Repaired a missing or malformed Brain-owned Codex marketplace snapshot before asking Codex to report plugin state; an explicitly disabled plugin remains disabled. | Public 4.0.6 installed the RVF Brain successfully but a retained local marketplace registration pointed at a missing snapshot, so `codex plugin list --json` failed before the old later repair path could run. `bin/install.mjs` now validates and atomically rebuilds only its own snapshot before that probe, reports preparation failures distinctly, and leaves healthy current caches byte-untouched. Real isolated-Codex regressions cover missing, malformed, disabled, and preparation-failure states. |
| 2026-08-02 | Made the stable Codex hook door fail-open before Node can report a missing module, and aligned it with custom `CODEX_HOME`. | The 4.0.5 manifest invoked the stable wrapper directly. Plugin-only upgrades, a retained plugin after uninstall, or a deleted wrapper therefore failed before the wrapper's safety logic could run; custom Codex homes also wrote and read different paths. Every 4.0.6 registration now uses a cross-platform inline Node trampoline that resolves the installer's stable path, returns silent exit 0 when it is absent or unhealthy, and preserves only intentional blocking exit 2. The wrapper adds an internal deadline below the host deadline and suppresses unexpected adapter failures. Focused source tests pass 23/23 and the packed-artifact regression passes 7/7; exact-SHA CI and public-artifact proof remain the release gates. |
| 2026-08-02 | Re-read the governed Codex manifest for the 4.0.5 patch release. The stable MCP registration, managed-block merge, lifecycle adapter, generation-independent wrapper, hook schema, and native skill-discovery decisions are unchanged; only the product generation advanced. | Commit `1c2bdbf` changes `plugin/.codex-plugin/plugin.json` from 4.0.4 to 4.0.5 through the single-source version workflow. `node scripts/sync-version.mjs --check`, 141 focused version/release tests, and `node scripts/no-silent-substitution.mjs` passed before push. Exact-SHA CI and public Claude/Codex installation remain release gates and are not claimed by this row. |
| 2026-08-01 | Re-read the complete host boundary after the four-state update matrix and public-artifact receipt producer landed. Claude-only, Codex-only, both-host, and neither-host installs are now explicit acceptance states; absent hosts remain untouched, an explicitly disabled Codex lifecycle remains disabled, and either detected-host failure restores the prior Console runtime byte-for-byte. | `tests/unit/console-runtime-transaction.test.mjs` exercises the four host states, host-specific failures, persisted runtime identity, and pending-restart counts through injected host adapters in `bin/install.mjs`; the integrated focused rerun passed 70/70. `scripts/publication-receipt.mjs` verifies installed Claude and Codex payloads after publication but does not alter their MCP or lifecycle transport. Native-Windows exact-SHA CI and public installation proof remain release gates, not claims made by this row. |
| 2026-08-01 | Re-read the Claude/Codex host boundary after the issue #79 Console runtime transaction and protected-release instructions changed. The stable MCP registration, managed-block merge, host adapter, generation-independent wrapper, hook schema, and native skill discovery decisions remain intact. | `bin/install.mjs` now stages and verifies the Console runtime before host convergence, activates it only after the detected Claude and Codex hosts plus Stable Spine converge, rolls back the prior generation on failure, and persists exact runtime identity plus pending-restart state. `plugin/skills/release-proof/SKILL.md` changes release authority, not Codex transport. Exact-SHA CI and public-artifact proof remain outstanding and are not claimed here. |
| 2026-08-01 | Re-read the governed Codex host surfaces after installed What's New authority, subscription-backed fix-workstream guidance, and MCP readiness discovery changed. The stable MCP registration, managed-block merge, host adapter, generation-independent wrapper, hook schema, and native skill discovery decisions remain intact; §4 now distinguishes registration from live worker readiness. | `bin/install.mjs` now invokes the immutable installed `plugin/scripts/whats-new.mjs` payload and adds `startup_timeout_sec = 30` plus readiness-aware doctor output (integration commit `b606900`). `plugin/skills/whats-new/SKILL.md` follows that installed authority, while `plugin/skills/ruvnet-brain/SKILL.md` requires native Claude/Codex subscription agents and isolated fix worktrees. None changes the wrapper/adapter transport or stated native-Windows and hook-trust limitations. The #78 lane reported 138/138 focused tests; no broad, packed, exact-SHA, public-artifact, or 95 proof is claimed. |
| 2026-07-30 | Re-read the complete Codex install and lifecycle boundary after the 4.0.2 control-plane work; the stable wrapper and host-adapter architecture remain intact. | `bin/install.mjs` now persists the Console runtime and uses a realpath main-entry guard so imports are side-effect free. `plugin/skills/*` and the command aliases expose `$ruvnet-brain:rvbc`; `plugin/hooks/codex-hooks.json` remains schema-valid. Focused lifecycle, mutation, stale-install, and skill-discovery tests cover the shipped paths; external exact-SHA CI remains the release gate. |
| 2026-07-29 | Added a native `rvbc` Codex skill and made the shared SessionStart body emit `$ruvnet-brain:rvbc` on Codex while retaining `/rvbc` on Claude Code. | A live Codex 0.145.0 session rejected `/rvbc` before model dispatch even though `commands/rvbc.md` shipped. The official Codex manual documents plugin workflows as skills invoked through `/skills` or `$`, while slash commands are a built-in host surface. `tests/integration/codex-skill-discovery.test.mjs` now requires the installed plugin loader to expose `ruvnet-brain:rvbc`; `tests/unit/codex-console-invocation.test.mjs` pins the host-specific session contract. |
| 2026-07-29 | Re-read the Codex lifecycle registration after increasing only the two UserPromptSubmit host deadlines from 5s to 10s; the stable wrapper, adapter, and single-source hook-body decision remain unchanged. | PR #65 / commit `6734597` measured the real installed `ground-ruvnet` and `unprompted-speech` paths at 3.48–4.26s cold against an internal 4s runtime bound, leaving no safe margin under the former 5s host deadline. Post-fix real-path probes completed in 0.75s and 1.15s; `tests/unit/codex-lifecycle-hooks.test.mjs` requires at least 2× internal-runtime headroom while capping the declaration at 10s. |
| 2026-07-29 | Re-read all governed Codex wiring after eight later commits; the architecture still holds, with active-home and Windows path handling made explicit. | Commits `b1760d4`, `4a0529c`, `04b0008`, `e6ca575`, `9ece40f`, and `d09363f` only advance `plugin/.codex-plugin/plugin.json`; `c2d5ef0` changes only canonical `*.big.rvf` doctor counting; issue #61 / commit `ebe51a5` makes `bin/install.mjs` honor `CODEX_HOME`, keep the stable wrapper beside that active home, and decode JSON-escaped MCP paths before probing them. `tests/unit/codex-wiring.test.mjs` passes 42/42. |
| 2026-07-28 | Re-read all governed Codex wiring after three later installer commits; corrected the persistent MCP boundary from “one self-contained server file” to the server plus its local structured-interface dependency. | Commit `e089074` changes `bin/install.mjs`, `plugin/skills/ruvnet-brain/SKILL.md`, and `PLAYBOOK.md`: `wireCodexHost()` now refuses an incomplete pair, atomically copies `managed-cli-interface.mjs` before `server.mjs`, and the skill directs CLI-only gaps through `ruvnet_cli_help` then literal-argv `ruvnet_cli_run`. Commits `2f420e7` (test-only Release-resolution seam) and `7eb11fb` (assembled-directory local install, stale-store pruning, shared runtime model-cache path) also changed governed `bin/install.mjs` but do not alter the managed-block merge, doctor verdict, stable hook wrapper, native-skill discovery, or stated Windows/trust limitations. |
| 2026-07-28 | Native `brain-console` and `whats-new` Codex skills replace the dropped-command and absent-sibling failure; obsolete `skill.toml` manifests are removed. | The real isolated-home plugin install showed `rvbc` and `whats-new` were omitted at migration while `brain-console` and `rvcb` referenced `rvbc.md`, which was not copied. `tests/integration/codex-skill-discovery.test.mjs` pins the installed boundary. |
| 2026-07-28 | Codex shell events now normalize `exec_command`, `functions.exec_command`, and `functions__exec_command` into the shared Bash contract; custom `codexDir` installs keep the stable wrapper inside the matching isolated home. | Exact installed-boundary tests in `tests/unit/codex-lifecycle-hooks.test.mjs` reproduce the previously missed raw Codex tool names and prove the wrong Ruflo command is blocked. `tests/unit/codex-wiring.test.mjs` proves a temporary Codex home causes no write to the maintainer's `~/.cache`. |
| 2026-07-28 | **Issue #52 lifecycle wiring added and verified through live Codex 0.145.0.** | Commit `c466c2a` adds the Codex manifest, dedicated schema-valid registration, stable wrapper, and host adapter. Before the fix, `codex exec --ephemeral --json --dangerously-bypass-hook-trust` reported `unknown field '_note'` for both the installed plugin and project hook file, so no Brain lifecycle handler loaded; it also clamped the user SessionEnd timeout from 30000s to 3s. After installing the candidate files, the same fresh-session command completed without either hook error. Direct real-path proofs then invoked the installed `~/.cache/ruvnet-brain/codex-hook.mjs`: SessionStart returned valid developer context in 0.527s, and a Stop event with one real open ledger item returned `{"decision":"block","reason":"..."}` in 1.172s. `tests/unit/codex-lifecycle-hooks.test.mjs`, `codex-wiring.test.mjs`, and `npm-tarball-codex.test.mjs` pass 52/52. |
| 2026-07-27 | **Re-read against the governed code; NO change required — every claim still holds.** | Flagged `presumed-stale`: 6 commits (0d) after this document's last commit. All 6 (`aa8c090`, `314be33`, `a285fcd`, `987590a`, `2b4e24d`, `720a4bf`) touch only `bin/install.mjs`; `.codex/config.toml`, `.codex/hooks.json` and `.codex/skills/*` are untouched since `969b1ed`/`7ccaf1f`. Read `git show aa8c090 -- bin/install.mjs`: ADR-058 D5's coexistence suite adds three `export` keywords to existing private functions so `wireCodexHost`/`mergeCodexConfig` are testable — commit message states "Zero logic changed", confirmed by reading the diff. The model-cache fix (`2b4e24d`) and D8 stranger-matrix work (`987590a`/`a285fcd`) do not touch Codex code at all (`git show <sha> -- bin/install.mjs \| grep -i codex` empty for both). Compared this ADR's §1-6 claims against current code: the managed-block merge markers, `wireCodexHost()`'s atomic write + symlink-resolve, the three doctor lines (`grep -n "Codex: wired\|Codex: host detected\|Codex: no host"`), and both `.codex/skills/*.toml` manifests all still match verbatim |

## Addendum (2026-07-26) — issue #43: the wiring was dead on every npm install

Henrik Pettersen proved the registration this ADR shipped could never fire on its primary path: the
npm tarball's `files` whitelist excluded `plugin/mcp/server.mjs`, the exact package-relative path
`wireCodexHost()` resolves, so every `npx ruvnet-brain` from the registry hit the `no-source` branch.
It worked only from a repo/marketplace checkout — and every test in `codex-wiring.test.mjs` ran
against the source checkout, the one place the file always exists.

Fixed in 3.9.77-dev, three parts, matching #43's acceptance verbatim:

- At the 3.9.77-dev fix, `package.json` `files` shipped exactly `plugin/mcp/server.mjs` (plus
  `!plugin/README.md`, which npm's always-include README rule would otherwise drag in). Commit
  `e089074` later added the server's required `plugin/mcp/managed-cli-interface.mjs` sibling to the
  whitelist; the rest of `plugin/` stays excluded.
- Both writes in `wireCodexHost()` are now atomic (write-beside + `rename()` via `atomicReplace`):
  an interrupted copy can no longer leave a torn `server.mjs` at a path an existing config already
  names, and a failed config write leaves the previous bytes intact. Because `rename()` swaps
  inodes, the helper also resolves symlinks (a dotfiles-managed `config.toml` stays a symlink and
  the bytes land in the dotfiles repo) and re-applies the target's mode (a chmod-600 config never
  comes back 644) — both found by the independent review of this fix, and both now pinned in
  `codex-wiring.test.mjs`. Scope is process interruption, the #43 scenario; power-loss fsync
  durability is deliberately out of scope for a config write.
- `tests/unit/npm-tarball-codex.test.mjs` runs `npm pack`, unpacks the real tarball, and exercises
  the installer FROM THE ARTIFACT with default source resolution — plus an MCP
  `initialize`/`tools/list` round trip against the installed server and two write-failure
  injections that demonstrably fail on the pre-fix code. The gate can no longer borrow files from
  the checkout.
