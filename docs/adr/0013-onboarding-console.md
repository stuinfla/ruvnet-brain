---
id: ADR-013
title: The Onboarding Console — RuvNet Brain becomes a mirror, an advisor, and only then a configurator
status: Accepted
date: 2026-07-14
updated: 2026-08-30
updated_source: authored-current
authors: [Stuart Kerr, Claude Code]
tags: [onboarding, ux, config, stack, memory-health, savings, safety, coverage]
supersedes: []
related: [ADR-0012 (grounding gate), ADR-0069 (artifact-bound source coverage), ruflo/plugins/ruflo-ruvector ADR-0001 (pin + smoke-test contract)]
governs:
  - scripts/onboarding-console.mjs
  - scripts/console-runtime-identity.mjs
  - console/*
  - plugin/commands/configure.md
  - plugin/commands/coverage.md
  - plugin/scripts/coverage.mjs
created_at: 2026-07-14T17:28:48-04:00
created_at_source: derived-from-git
updated_at: 2026-08-21T08:10:43-04:00
updated_at_source: authored-current
---

# ADR-013: The Onboarding Console

**Status**: Accepted

The Console is implemented. Decision status and implementation state are
separate axes: `Accepted` records the architectural decision, while the governed runtime and tests
establish what is built.
**Date**: 2026-07-14
**Updated**: 2026-07-18 — recorded that the console shipped and is live (`/configure` / `/rvbc`,
served from `scripts/onboarding-console.mjs`). That revision used `Implemented` as the decision status;
the 2026-08-21 currency pass corrected the decision axis to `Accepted` while retaining implementation
truth in the governed runtime, tests, and this record.

**Updated 2026-07-30** — the Settings surface now distinguishes a working control from a persisted
preference. A choice is interactive only when a runtime consumes it and the effect can be verified;
declared-but-unenforced choices remain named with the missing path instead of appearing as switches.

**Updated 2026-08-01** — issue #79 exposed that a detached Console process could outlive an update
and pass the old branded-root probe while retaining an incompatible API router. The server-side
lifecycle contract is now explicit: each project scope has a mode-0600 instance receipt, the live
server exposes a non-secret `/api/runtime` identity, reuse requires an exact API/source identity
match, and only a receipt-proven instance accepts token-authenticated graceful shutdown. A legacy or
foreign listener is never killed; the current Console binds a free port and persists that instance
for subsequent reuse. The issue #79 transaction now stages and syntax-verifies `.console-runtime`
before host activation, persists its exact version/source identity, activates it only after host and
Stable Spine convergence, and restores the prior runtime if activation or receipt finalization fails.
The convergence receipt reports `pending-console-restart` when an owned instance still serves older
bytes; the next launch uses the receipt/token lifecycle above to replace it safely. The running
Console reads its version from that staged `runtime-identity.json` before consulting any host plugin
registry, so a Codex-only installation has a valid ownership receipt and can replace stale bytes on
the same URL. Real-browser acceptance builds both candidates through the installer's canonical
runtime transaction rather than a parallel hand-maintained fixture manifest.

**Updated 2026-08-02** — Console integrity issues #83, #85, #86, and #87 make four trust boundaries
explicit. Bundled maintainer lessons carry imported-owner provenance, legacy fingerprints are
quarantined, and imported/demonstration rows cannot become personal policy. Compaction survival now
requires a fresh structurally valid versioned snapshot (with validated Ruflo legacy migration paths),
not arbitrary file existence. The packed and staged Console runtime must contain a valid provider
catalog; native boolean provider detection remains visible with an explicit degraded state if that
catalog cannot load. Finally, normal installs add reviewed subscription-covered managed models to an
existing user catalog without overwriting user rows or adding metered authority, while the Console
shows the complete launchable development inventory and marks the latest routing receipt separately.

**Updated 2026-08-01** — issue #81 identified the residual project-discovery split left after issue #19.
`scripts/memory-doctor.mjs` now owns the common and configured candidate-root policy, canonical
root/store de-duplication, scoped explicit-root behavior, and display naming. The standalone doctor
and Console import that same policy, so a machine-wide fleet count can no longer mean `~/Code` on
one surface while the Console scans `~/source`, `~/work`, or user-configured roots on another.

**Updated 2026-08-21** — Coverage is now the Console's third linked page, alongside the primary
Console and How to Use It. `console/coverage.html`, `coverage.css`, and `coverage.js` render a
read-only searchable projection through `GET /api/coverage`; `gatherSourceCoverage()` reads the
installed knowledge bundle's canonical `COVERAGE.json` first and accepts `source-coverage.json`
only as a compatibility filename. Missing, malformed, unsupported, or internally incoherent data is
shown as unavailable, never as zero or complete coverage. The page reads the installed KB on each
request rather than embedding a checkout snapshot in the persistent Console runtime.

The page and API follow the existing Console lifecycle rather than creating another server. The
whole `console/` directory is already a member of `CONSOLE_RUNTIME_SURFACE`, so the page participates
in the staged runtime digest and atomic activation transaction. A running Console with old frontend
bytes cannot pass as the new runtime merely because its Node entrypoint is unchanged. Coverage data
has the separate knowledge-bundle lifecycle: refreshing `COVERAGE.json` does not require replacing
the Console runtime.

The installed plugin also supplies `/ruvnet-brain:coverage`. Its command declaration is boot-frozen
host metadata and therefore appears only after the host loads the plugin generation that contains
it. Once loaded, `plugin/scripts/coverage.mjs` resolves the managed KB path per invocation and reads
that generation's installed `COVERAGE.json`; it never substitutes repository state or remembered
counts. This is intentionally a compact terminal projection of the same ledger, not a fourth source
of coverage facts.

## Context

RuvNet Brain is a passive knowledge base. It answers when asked. Everything else about
adopting rUv's stack — what to install, where it lives, whether it is current, whether it is
even *working* — is left to the user, and the evidence says the user cannot see it.

We know this because we just measured a machine that has been carefully tended for months
(2026-07-14, Stuart's M3 Max — the most RuvNet-literate machine in existence outside rUv's own):

| Finding | Measured |
|---|---|
| Global stack packages | 40 |
| Behind the registry | **0** |
| **Broken installs** (present, no readable version) | **1** (`@ruvector/edge-net` — half-written, `sharp` orphan inside) |
| **Stale shadow copies in the npx cache** | **15** — incl. `@ruvector/rvf@0.1.9` while global was `0.2.3` |
| **Global installers fighting each other** | **2** — nightly `@alpha` vs hourly `@latest` |
| **`npx <pkg>@tag` calls wired into tool-use hooks** | **~190, across 16 projects** |
| Package specs in use for the same tool | **3** (`@claude-flow/cli@latest`, `claude-flow@alpha`, bare `claude-flow`) |
| Places comparing versions with `!=` (fires in EITHER direction) | **3** — one of which *executes* `npm install -g` |

None of this was visible to the operator. Every command "worked". Every `--version` printed a
plausible number. The update nag was confidently telling him to **downgrade**.

Two facts make this a product problem rather than one man's mess:

1. **The user did not write those 190 npx hooks. `init` did.** They are the ecosystem's default.
   Every RuvNet user on earth has this configuration, therefore every RuvNet user has the shadow
   risk, the per-call npx latency, and no single place to answer "what am I actually running?"

2. **npx does not merely fail to catch drift — it manufactures the illusion of currency.** It runs
   its own private copy from `~/.npm/_npx`. The command succeeds, the version string is new, and
   the binary the MCP server actually executes quietly rots. A check that cannot fail protects
   nothing; a check that *reports health while broken* is worse than no check.

Meanwhile the capabilities that would most help a newcomer — MetaHarness routing, Agentic-QE,
AgentDB memory — are invisible until someone tells you they exist, and unverifiable after that.

### The constraint that shapes everything

Hundreds of people will use this. **Many are far more advanced than we are, and we do not know how
they are using it.** A configurator that assumes their setup is wrong, mutates it to match our
opinion, or presents a single "Fix everything" button is a configurator they will uninstall — and
they will be *right* to. Heavy-handedness is not a UX flaw here; it is a correctness flaw, because
we do not have the information required to be confident.

## Decision

Build the **Onboarding Console**: a locally-served, static web page that RuvNet Brain renders from
real machine state. It obeys one ordering, and the ordering is the whole design:

> **Mirror → Explain → Recommend → (only on explicit consent) Apply → Undo.**

### The five principles (each exists to kill a specific failure)

1. **Read-only by default.** The page renders without changing anything. Opening it can never alter
   a working setup. *Kills: the configurator that breaks the expert's machine on first launch.*

2. **Accuracy earns the right to advise.** The first thing a user sees is not our recommendation —
   it is **their own setup, described more accurately than they could describe it themselves**,
   including things they did not know (a shadow copy shadowing their global; 1.4s of npx resolution
   on every tool call). *Kills: the advice nobody trusts because the tool clearly doesn't understand
   their machine.*

3. **Existing choices are data, not errors.** If someone deliberately runs npx everywhere, we do not
   say "wrong". We show the tradeoff with numbers and let them choose. *Kills: condescension toward
   users who know more than us.*

4. **Every recommendation carries evidence, cost, and a reversal.** No item may appear without:
   what we observed, what changes, what it costs (time/latency/$), and the exact undo. A change with
   no recorded inverse may not be offered. *Kills: the irreversible "helpful" mutation.*

5. **Every number traces to a receipt.** No estimated savings. No "up to 90%". If we cannot show the
   measurement, the number does not appear. *Kills: the dashboard that inflates its own value —
   the exact sin our own scoring rule (no inflated scores) already forbids.*

### Sections (progressive disclosure — each collapsed, each independently useful)

| # | Section | Answers | Powered by |
|---|---|---|---|
| 1 | **Your stack** | What is installed, is it current, is there more than one copy, is anything broken? | `scripts/stack-sync.mjs --audit` (built, working) |
| 2 | **How it's wired** | Do your tools resolve via npx (slow, shadow-prone) or a global binary? Where? | hook/MCP surface scan |
| 3 | **What we'd suggest** | Ranked, evidenced proposals — each with diff, cost, undo | Recommendation engine |
| 4 | **Is your memory actually working?** | Not "is AgentDB up" — *does recall return the right things after a compact?* | Memory-health probes |
| 5 | **MetaHarness** | What it does; the zero-cost setup for *your* harness; what it has actually saved you | Savings ledger (receipts only) |
| 6 | **Agentic-QE** | Same shape: what it is, your setup, your receipts | Savings ledger |

Sections 5–6 are the template: **explain → personalize → prove.** New capabilities plug in as new
sections without redesigning the page.

### The delivery-mechanism question, answered

Stuart asked: plugins? global installs? npx everywhere? a post-prompt processor? Our recommendation,
grounded in what we measured rather than taste:

| Thing | Mechanism | Why |
|---|---|---|
| **CLIs the hooks/MCP execute** | **Global install, one copy, nightly synced** | npx demonstrably shadows and lies (15 stale copies found). A global binary is one path, one version, verifiable. |
| **Skills / agents / hooks / commands** | **Plugin** | Per-user, versioned, reversible, no PATH surgery. |
| **Model-facing tools** | **MCP server pointed at the absolute global binary** | Never `npx` in an MCP command: it re-resolves on every launch. |
| **Prompt optimization** | **Advisory injection + an explicit command. NOT a silent rewriter.** | See below. |

**We recommend AGAINST a silent post-prompt processor that rewrites the user's prompt.** It is the
purest form of heavy-handedness: it changes what the user said, invisibly, and it will mangle the
carefully-worded prompts of exactly the advanced users we must not break. Instead: keep the advisory
context injection (which adds, never replaces) and offer an explicit, invocable optimizer the user
chooses to run. *The user's words are theirs.*

### Section 4 deserves its own note: memory health is a QUALITY question

"Is AgentDB working" is a liveness check and it is nearly useless — the store answered fine
throughout the 2026-05-31 incident where memory was reported broken three times and never was.
The question that matters is **does recall return the right things when it counts**:

- **Liveness** — does a real store→search round-trip work on the path actually in use?
- **Coverage** — does this project have a checkpoint at all, and how stale is it?
- **Recall quality** — given a synthetic question about the project, does top-k actually contain the
  checkpoint? (This is *measurable*, and nobody measures it.)
- **Compaction survival** — was a PreCompact snapshot written?
- **Session surfacing** — does session start actually put the project's state in front of the model?

Score 0–100 with **named deductions and evidence per deduction**. A known-broken dimension caps the
score. No dimension may be scored from an assumption.

## Consequences

**Positive.** A newcomer gets an onboarding ramp instead of a wall. An expert gets a mirror that
tells them something true they did not know, and never touches their machine without consent. Every
capability becomes discoverable and *provable* rather than folkloric.

**Negative.** Read-only-by-default plus per-item consent means adoption is slower than a "Fix
everything" button would give us. That is the correct trade: we do not have the information required
to be confident about a stranger's machine, and pretending otherwise is how we earn a reputation for
breaking things.

**Risk we are accepting.** The page reports on a machine it does not control. Between render and
apply, state can change (a nightly job, another window). Therefore **apply re-reads state and
re-verifies before mutating**, and refuses if the world moved. Stale-read-then-write is how the
concurrent-session clobber happened on 2026-07-12; we do not repeat it.

## Amendment (2026-07-14) — plain-English machine impact is a first-class principle

Added during implementation, at Stuart's direction: *"Don't do anything to the machine without
explicitly explaining, in plain words, what it does. Most people don't know how this is set up on
their computer; they just want it to work."* This becomes **principle 6**:

6. **Anything that touches the machine explains itself in plain English, first.** Every recommendation
   carries a `touchesMachine` flag and, when true, a jargon-free `plainImpact` that says what happens to
   the computer, why it is safe, and that it is reversible — written for a smart person who has never
   heard of npx. The UI renders that impact and requires an explicit confirm before applying. Actions
   that only write RuvNet Brain's own user-level settings file (`touchesMachine:false`) say so plainly.
   The recommendation factory *refuses to construct* a machine-touching rec without a `plainImpact`.

## Verification — status at implementation (2026-07-14)

1. `stack-sync --audit` exits non-zero on a machine with drift and zero on a clean one. **✅ Done** — pre-existing, verified live.
2. The console renders with **zero writes**. **✅ Done by construction** — the render path (`gatherState`) uses only read helpers and opens no file for writing; the ONLY writer is the authenticated apply/save POST path. *(The stack audit reaches the npm registry over the network but mutates no user file.)* A read-only-filesystem proof test is filed as a follow-up.
3. Every recommendation object fails schema validation if it lacks `evidence`, `cost`, or `undo` (and, per principle 6, `plainImpact` when it touches the machine). **✅ Done + tested** — `makeRecommendation` throws; `scripts/console-engine.test.mjs` (15 cases) proves each rejection.
4. Memory-health scoring refuses to emit a score for any dimension it did not actually probe. **✅ Done + tested** — untested dimensions land in `notTested[]`, contribute to neither numerator nor denominator, and a fully-unprobed report scores `null`, never a number.

## Implementation (2026-07-14)

- **Engine (pure, no I/O):** `scripts/console-engine.mjs` — the schema-enforced `makeRecommendation`
  factory, the stack/wiring recommendation builders, and `scoreMemoryHealth`. Tested by table.
- **Server (the only writer):** `scripts/onboarding-console.mjs` — read-only state assembly over the
  existing engines (`stack-sync.auditModel`, `memory-doctor.diagnose`, a read-only wiring survey),
  a 127.0.0.1 token-gated HTTP server, and an apply/save/undo path that **re-verifies before writing,
  journals the inverse first, and dispatches to the already-safe `stack-sync --sync` /
  `reconcile-project --apply` scripts rather than re-implementing any mutation.**
- **UI:** `console/index.html` + `app.js` + `style.css` — the six progressive-disclosure sections,
  theme-aware, offline/self-contained, built to the frozen contract in `console/CONTRACT.md`, with a
  generated hero (`console/assets/hero.webp`).
- **Trigger:** `plugin/commands/configure.md` → `/ruvnet-brain:configure`; plus repo-local
  `.claude/commands/configure.md` → `/configure`. Both launch `onboarding-console.mjs --serve --open`.
- **Proven live:** `--print-state` returns real data from this machine (773 wiring sites across 12
  projects, 104 memory stores, memory health 100/100 on 4 probed dims); `--print-stack` returns the
  real 39-package audit; the 15 engine tests pass.
- **Public installation:** implemented. `beginConsoleRuntimeTransaction()` stages the complete
  `CONSOLE_RUNTIME_SURFACE` under the installed KB, validates it, binds its byte digest into
  `runtime-identity.json`, and activates it only after host convergence. The Coverage page travels
  inside that same runtime; the coverage ledger itself travels inside the knowledge bundle as
  `COVERAGE.json` and `COVERAGE.md`.

## Currency log

| 2026-08-30 | The configurator documentation now reflects the live settings form: ordinary user preferences have runtime consumers and are served through the shared save path. | `console/app.js`, `scripts/onboarding-console.mjs`, and `plugin/scripts/runtime-preferences.mjs` are the current implementation boundary. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-21 | Added the third Coverage page, installed-ledger API, terminal command, and their two-track lifecycle contract; corrected decision status to `Accepted` while retaining the implemented runtime truth. | `console/coverage.html`, `console/coverage.js`, `scripts/onboarding-console.mjs`, `scripts/console-runtime-identity.mjs`, `plugin/commands/coverage.md`, and `plugin/scripts/coverage.mjs` now expose one installed `COVERAGE.json` projection without creating another mutable source of facts. |
| 2026-08-02 | Recorded the shipped provider, runtime-identity, compaction, provenance, and project-discovery trust boundaries. | Issues #79, #81, #83, #85, #86, and #87 changed the governed Console runtime and its acceptance boundaries. |
