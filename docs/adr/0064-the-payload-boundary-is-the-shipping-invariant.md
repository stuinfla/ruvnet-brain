---
id: ADR-064
title: The payload boundary is the shipping invariant, and it is now a gate
status: Accepted
date: 2026-08-06
updated: 2026-08-06
authors: [Stuart Kerr, Claude Code]
tags: [packaging, payload, l4, anticipate, advocacy, hooks, guard, issue-114]
supersedes: []
relates: [ADR-027, ADR-028, ADR-040, ADR-052, ADR-055]
governs:
  - plugin/scripts/anticipate.sh
  - plugin/scripts/unprompted-runtime.mjs
  - plugin/scripts/capability-registry.mjs
  - plugin/scripts/hook-registry.mjs
  - tests/unit/payload-self-contained.test.mjs
---

# ADR-064 — The payload boundary is the shipping invariant, and it is now a gate

**Status**: Accepted

**Date**: 2026-08-06

## The defect, measured

The entire L4 "anticipate" surface — ADR-028's push channel, the thing built specifically because
"a surface the user must navigate to is a PULL surface" — has been **inert on every real install
since it was written**. Not degraded. Absent.

```
$ find ~/.cache/ruvnet-brain/versions/4.0.12 -name goal-match.mjs
(nothing)
```

`anticipate.sh` guards its matcher with `[ -f "$GOAL_MATCH" ] || exit 0`, which does exactly what it
promises: it stays silent. **A hook whose only failure mode is silence cannot report its own
breakage.** There was no error, no log line, and no red test for the entire life of the feature.

PR #114 fixed one half — path *resolution*. `anticipate.sh` now probes `$SELF_DIR` first instead of
asserting `$SELF_DIR/../..`. That was correct and necessary and **still left L4 inert**, because the
modules it probes for were never in the thing that ships.

## Why `plugin/` is the real boundary

`.claude-plugin/marketplace.json` declares `"source": "./plugin"`. Three distribution paths follow
from that one line, and **none of them can carry a file from outside `plugin/`**:

| Channel | Mechanism | Carries |
|---|---|---|
| Claude marketplace | `marketplace.json` `"source": "./plugin"` | `plugin/` only |
| Stable Spine update | `plugin/scripts/update-apply.mjs` `stagePayload()` → one `fs.cpSync(srcDir, staging, {recursive:true})` | the payload verbatim — it **cannot add** a file that was not in it |
| Codex install | `bin/install.mjs` `prepareCodexMarketplace()` | copies only `plugin/` |

And **all three FLATTEN the `plugin/` level**, so `scripts/` is not a sibling of `plugin/` anywhere a
user actually runs:

```
~/.cache/ruvnet-brain/versions/<gen>/scripts/anticipate.sh        (the Stable Spine)
~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/<ver>/scripts/  (the Claude plugin cache)
<src>/plugin/scripts/anticipate.sh                                (a git checkout — the ONLY layout
                                                                   that keeps plugin/, and the one
                                                                   nobody ships)
```

The repo already knew this and had already stated it three times, in the file headers of
`lesson-store.mjs`, `lesson-gate.mjs` and `session-snapshot-contract.mjs`:

> *"The executable implementation belongs inside the self-contained plugin payload so Stable Spine
> and Codex-only installs never depend on a separate Claude marketplace checkout."*

**The principle was written down and then not applied to the next surface built.** That is the thing
this ADR exists to make mechanical.

## What moved

Ten modules, `git mv scripts/… → plugin/scripts/…`:

| Module | Why it had to move |
|---|---|
| `goal-match.mjs` | the matcher `anticipate.sh` probes for |
| `capability-registry.mjs` | the state source it audits |
| `advocacy-outcomes.mjs` | the single suppression policy (DismissalLedger), all four modes |
| `nightly-controller.mjs` | **HARD static import** at `capability-registry.mjs:81` |
| `hook-registry.mjs` | **HARD static import** at `capability-registry.mjs:82` |
| `memory-doctor.mjs` | lazy helper — absent ⇒ `null` ⇒ row reads `unknown` ⇒ **SILENCE RULE 1 suppresses it** |
| `lesson-promote.mjs` | lazy helper, same; also the target of a `turnOn` command |
| `gates.mjs` | lazy helper, same |
| `learning-enable.mjs` | lazy helper, same |
| `user-settings.mjs` | the 1–5 advocacy dial, read by `unprompted-runtime.mjs` |

The two static imports are the reason a three-file move would not have worked: it dies with
`ERR_MODULE_NOT_FOUND` and `anticipate.sh`'s catch turns that straight back into silence. **The seven
lazy ones are worse**, because they degrade to `null` → `unknown` → suppressed — it would have
shipped *looking* fixed.

## The shim strategy

Each old path keeps a re-export, matching the three that already existed:

```js
// scripts/goal-match.mjs
export * from '../plugin/scripts/goal-match.mjs';
```

Verified before adopting it: **none of the ten has a `export default`**, so `export *` is complete.
Every existing importer — 40+ test files, `onboarding-console.mjs`, `selfcheck.mjs`,
`console-engine.mjs`, `remedy-registry.mjs` — works unchanged. `scripts/` is still in package.json
`files[]` and still in `CONSOLE_RUNTIME_SURFACE`, so both copies ship and both are hashed into the
console runtime digest. That is coherent: a shim is a real file and *is* part of the runtime's
identity.

Two CLIs needed one further edit. `hook-registry.mjs` and `learning-enable.mjs` gated their `main`
on strict path identity (`realpathSync(argv[1]) === realpathSync(self)`), which stops firing the
moment the old path is a shim — turning the documented `node scripts/hook-registry.mjs --lint` into a
silent no-op. Both now use the basename idiom their four siblings already used.

## Two regressions the move causes, and what was done about them

**`REPO` flips meaning.** `path.resolve(HERE, '..')` meant "the repo root" from `<src>/scripts/`; from
`<src>/plugin/scripts/` it means `<src>/plugin`. Every default-argument consumer —
`discoverSources()`'s `plugin` and `project` layers, `shimTable()`, `loadContracts()`,
`dispatchGateWiring()` — would then find nothing, and **none of them throw**: they return
`present:false` / `{}` / no contracts. The census would have gone *quiet*, which is the same failure
shape as the inert hook. So `hook-registry.mjs` now resolves its default root by **probe**
(`../..` when it holds `plugin/hooks/hooks.json`, else `..`), and `capability-registry.mjs` imports
that answer rather than recomputing it. `discoverSources()` also gained the two-layout probe
`shimTable()`/`loadContracts()` already had and it alone lacked.

**The dead-button risk.** `selfScript()` built `turnOn` commands naming `scripts/distill-project.mjs`
and `scripts/route-cheap.mjs`, which are **not** in the payload. Moving them too was rejected: both
are wired into `remedy-registry.mjs`'s console executor contract (`plan.exec.script`,
`usesServerProject`, the snapshot/restore undo) and into `bin/install.mjs`'s router-tools copy list,
so relocating them is a different change with a different blast radius — and this one is about L4.
Instead `selfScript()` **probes both homes and returns `null` when neither holds the script**, and
`turnOn: null` is an established, tested shape that both consumers (`console-engine`'s offer builder,
`anticipate.sh`'s one line) already render as "no button". A checkout and an npm install keep the
working button; a flattened install gets silence instead of a command that `ENOENT`s. If those
scripts are ever moved into the payload the button lights up on its own.

## The same bug, in a second file PR #114 did not touch

`plugin/scripts/unprompted-runtime.mjs:85` carried `CODE_ROOT = path.resolve(SCRIPTS_DIR,'..','..')`,
consumed at `:238-239` for `user-settings.mjs` (the **1–5 advocacy dial**) and `advocacy-outcomes.mjs`
(the **DismissalLedger**). Both imports `catch` to defaults — so on every real install the user's dial
setting was **silently unread** while the code read as though it were honoured. Both are now
`SCRIPTS_DIR`, and `CODE_ROOT` is gone.

## The gate

`tests/unit/installer-sibling-imports-packaged.test.mjs` **could not be extended.** It keys on
`npm pack` tarball membership, and package.json `files[]` lists `"scripts/"` — so all ten of these
modules were **always in the tarball**. A tarball-keyed assertion about them would have been green on
every commit while the feature was dead on every install. *That is the exact failure this ADR is
about, one level up.*

`tests/unit/payload-self-contained.test.mjs` keys on **payload membership** instead:

1. Walk `plugin/scripts/**` and `plugin/mcp/**`.
2. Extract every runtime module reference — the `$MODULE_DIR/…` / `$CODE_ROOT/scripts/…` shell idiom
   in `.sh`, `path.join(SCRIPTS_DIR|CODE_ROOT|…, 'name.mjs')` in `.mjs`, and `hook-shim.mjs`'s
   dispatch-table `file:` entries.
3. Take the transitive closure of relative ESM imports.
4. Assert every member exists **under `plugin/`**, and that no relative import escapes it.
5. **Anti-vacuity**: each derived list must be non-empty, per reference kind. A regex that silently
   matches nothing is the failure mode here, so a blind gate is RED, not green.

**Proven by breaking it** (a test that cannot fail on broken code is not a test):

```
$ mv plugin/scripts/goal-match.mjs /tmp && npx vitest run tests/unit/payload-self-contained.test.mjs
× every module the payload names at runtime is IN the payload
  AssertionError: … NOT in plugin/scripts/ … degrades to SILENCE:
    plugin/scripts/anticipate.sh → goal-match.mjs

$ mv plugin/scripts/nightly-controller.mjs /tmp && npx vitest run …
× every relative import reachable from the payload stays inside the payload
  AssertionError: these imports name a payload path that does not exist:
    plugin/scripts/capability-registry.mjs → ./nightly-controller.mjs
```

The first run of the gate also caught **itself**: greedy backtracking matched `token-ledger.jsonl` as
`token-ledger.js` and reported `ground-ruvnet.sh`'s data ledger as a missing module. The extension
list is now anchored with `(?![\w-])`. A gate that fails on a correct file gets muted, and a muted
gate is not guarding the thing it was written for either.

## Four more places `..` changed meaning — and how each was found

The two regressions above were reasoned out from the code. **The suite then found four more,
and review had found none of them.** That ratio is the most useful thing in this ADR, so each is
recorded with the evidence that caught it rather than as a tidy list of edits.

| # | Where | Found by |
|---|---|---|
| 1 | `nightly-controller.mjs` `ROOT` — the **third** instance of the `..` flip, and the only one with a user-visible symptom | `console-apply-timings.test.mjs`, driving a real `/api/apply` through the real console server |
| 2 | `proactivity-metrics.mjs` `REAL_REGISTRY` pointed at what is now a shim | `proactivity-detector-mutation.test.mjs` — ADR-041's own falsifiability proof |
| 3 | `anticipate-module-resolution.test.mjs` copied the **shims** into its fixture | itself, going red on both layouts |
| 4 | `hook-registry.mjs` carried a `/Users/<ellipsis>/` example into `plugin/`'s leak-scan scope | `codex-wiring.test.mjs` |

**(1) is worth reading in full.** The console returned HTTP **200** carrying:

> `"Nightly refresh did not reach off: Error: Cannot find module '<root>/plugin/bin/install.mjs'"`

The remedy reported its own failure honestly — the machinery worked exactly as designed — and it
failed for a packaging reason no reviewer would have guessed from the diff.

`ROOT` is now resolved by an **exact layout test rather than a probe**: this file's directory *is*
`<candidate>/plugin/scripts` **iff** `<candidate>` is a non-flattened root. `hook-registry.mjs`'s
`resolveRoot()` was switched to the same test, because its first version probed for
`plugin/hooks/hooks.json` — which is **absent from the Console's runtime root**
(`CONSOLE_RUNTIME_SURFACE` carries `plugin/scripts`, `plugin/docs` and `plugin/.claude-plugin`, but
not `plugin/hooks`), so the heuristic would have silently mis-rooted there. *An existence probe
answers "is this file present". The question was "is this a root".*

**(2) is the harness catching itself going blind.** The measurement would still have been correct —
the shim runs the same code — but the mutation test reads that path's **source** to build its
mutants, and a shim has no `return row(STATE.OFF, …)` to mutate. It threw the exact error it was
written to throw: *"mutation changed nothing — the target string moved. This test would otherwise run
an UNMUTATED copy and pass for the wrong reason."*

**(3)** is the fixture lesson stated once: a fixture must carry the bytes a user receives. Copying a
compatibility stub into an isolated directory grades something nobody runs.

**(4)** is a guard firing on a file that entered its scope. That is the guard working.

## L4 proven live

A flattened-layout fixture (the payload's contents copied flat, so `anticipate.sh` sits beside its
modules exactly as the Spine lays them out), a synthetic `HOME`, a real `UserPromptSubmit` payload,
and **no module env vars set at all**:

| | `anticipate.sh` on a prompt that should trigger advocacy | `anticipate.sh --status` |
|---|---|---|
| **origin/main `aadd381`** (with PR #114) | `exit=0`, **stdout 0 bytes** | `advocacy-outcomes module not found at …/scratchpad/scripts/advocacy-outcomes.mjs` |
| **this change** | `exit=0`, **stdout 937 bytes** — `[RuvNet Brain — anticipating] "Session capture" is installed here and switched OFF, and it serves this turn: …` | the real dismissal ledger, no "module not found" |

Note what the *before* `--status` line proves independently: the fallback path resolved to
`<fixture>/../../scripts`, one directory above the fixture — the overshoot, measured.

## Honesty boundary

- **MAY claim**: L4 resolves its modules and speaks on a flattened install; the payload is
  self-contained under a gate that has been shown to fail on broken code; the advocacy dial and the
  DismissalLedger are now actually read by `unprompted-runtime.mjs`.
- **May NOT claim**: that L4 has been observed firing on a *stranger's* machine, or that its ADR-028
  precision floor (0.60) has been measured. Neither has happened. The measurement above is a fixture
  that reproduces the shipped layout; it proves resolution and speech, not field precision. Precision
  becomes computable now that offers can actually be made — it was structurally zero before, because
  the denominator could never be written.

## Consequences

- The payload gains ~10 modules. This is the correct direction: the payload is what a user gets.
- Two copies of each moved module ship (payload + shim). Deliberate, and the same choice
  `lesson-store.mjs` already made; the shim is four lines.
- `capability-registry.test.mjs`'s "hardcodes no version literal" check was repointed at the payload
  copy. Left on `scripts/`, it would have read the four-line shim and passed **vacuously forever** —
  the same green-guarding-nothing failure, third instance in this one change.
- **Every test that reads a moved module's SOURCE, or copies it into a fixture, must name the payload
  path.** Importing the shim is fine and stays fine; reading or copying it is not. That is now the
  standing rule, and it is what findings (2) and (3) above cost to learn.
- **The version was deliberately NOT bumped here.** This repo's rule is that a behaviour-changing
  *push* carries a bump in the same commit; this branch is not pushed, and a bump in a worktree
  running beside other agents is a guaranteed conflict in `package.json` and
  `plugin/.claude-plugin/plugin.json`. The integration owner bumps at merge. Flagged rather than
  silently skipped.
