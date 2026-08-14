---
id: ADR-067
title: One decision, one reason — and a ledger that can report bad news
status: Accepted
date: 2026-08-10
updated: 2026-08-13
authors: [Stuart Kerr, Claude Code]
tags: [hooks, architecture, enforcement, measurement, simplification]
supersedes: []
relates: [ADR-040, ADR-054, ADR-063, ADR-065, ADR-066, ADR-0012]
governs:
  - plugin/scripts/decision-gate.mjs
  - plugin/scripts/decision-outcomes.mjs
  - plugin/scripts/degradation-watch.mjs
  - plugin/scripts/identifier-preflight.mjs
  - plugin/scripts/adr-currency-gate.mjs
  - plugin/scripts/mcp-readiness.mjs
  - plugin/hooks/hooks.json
  - tests/unit/decision-gate.test.mjs
  - tests/unit/decision-outcomes.test.mjs
  - tests/integration/bridge-to-model-e2e.test.mjs
---

# ADR-067 — One decision, one reason

**Status**: Accepted

## The measurement

Read from `hooks.json`'s own matchers, 2026-08-10:

```
Write | Edit  →  hijack-ruvnet · ground-before-write · protect-state · unprompted-speech
Bash          →  hijack-ruvnet · design-wall · unprompted-speech
```

**Four independent processes could refuse the same Write.** Five `exit 2` sites across four bash
scripts, no precedence, no shared context, no way for any of them to know what the others thought.
Whichever exited first won; the user got that one's reason and no hint that a second wall stood
behind it. Fix the first, re-run, hit the second — one round-trip per wall.

That is the concrete form of the owner's own words: *"not just a bunch of constraints rules that
break and collapse on each other."* Nothing owned the decision, so everything had an opinion.

## Decision 1 — the refusal chokepoint

**Every refusal of a tool call passes through ONE gate that consults every policy and alone decides.**

Not a new mechanism: this is ADR-040's invariant for *speech* (`unprompted-runtime.mjs` — "ONE runtime
alone decides whether bytes reach the user") applied to the other half. One pattern used twice keeps
the codebase learnable; inventing a parallel vocabulary here would repeat exactly what ADR-066
records.

**The policies do not change.** Each already speaks a precise contract — `exit 0` allow, `exit 2` +
stderr refuse — documented identically in all four files. That contract *is* a verdict function; it
was only ever missing a caller. The gate runs each as a captured child and reads `(code, stderr)`.
Zero edits to four working guards, zero new protocol to keep in sync, every existing per-policy test
still exercising the real thing.

What the user gains: one message naming the policy that refused **and every other that also would
have**; declared precedence (consent → correctness → grounding → taste); one process on the hot path
under one deadline.

**Fail-open, deliberately.** Any failure of the *gate itself* allows. `lesson-gate.mjs` states the
rule this repo paid for: a gate that blocks because it cannot read a config file "would be worse than
no gate, and would be switched off within a day, which is how every over-eager gate dies."

## Decision 2 — measure whether a refusal teaches

ADR-066's honesty boundary said it plainly: *"Delivery is proven; obedience is not measured."* And
`lesson-stamps-prove-ceremony-not-obedience` — itself a bridged lesson — names that exact failure.

**What is NOT observable:** whether the model obeyed an advisory. It reaches the context and what
happens next is unconstrained prose. Claiming to measure it would be the inflated-score failure.

**What IS observable**, from the one gate that sees every Write/Edit/Bash — what happened after a
refusal:

| outcome | meaning |
|---|---|
| `corrected` | the same target was retried and ALLOWED — the reason landed |
| `repeated` | retried and refused again — the reason did **not** land |
| `abandoned` | never retried. Ambiguous on purpose, never counted as a win |

**The one way to fabricate this is to record only `corrected`.** So the invariant is not "record
outcomes" but **every refusal produces exactly one record**, and `abandoned` is what an unresolved
refusal becomes — swept from the gate on activity, not at SessionEnd, because SessionEnd does not
fire on a crash, a kill, or a compact (ADR-027 already paid for that with 1,884 undelivered events).
An empty ledger reports `null`, never 0% or 100%: both are claims about a measurement that has not
happened.

## Decision 3 — the bridge reads both tiers

`lesson-bridge` read only global memory. A project's own `.swarm/memory.db` holds the lessons learned
*here*, and 35 of them reached nothing. Both tiers now bridge, distinguished only by SCOPE: a global
row is unscoped (it won twice, it may travel), a project row carries its own directory so
`lesson-gate`'s existing `isHome()` keeps it home. Ten were tagged; the rest are reported unbridged
by name, most because they duplicate a native or global lesson and a second copy teaches skimming.

## What this cost to learn

1. **`skipNoBash` is not a predicate.** It is a one-time notice emitter that returns 0 and writes to
   stderr — which on this hot path *is* the refusal channel. Calling it would have injected an install
   hint into the middle of a refusal. Read the signature; do not infer it from the name.
2. **A `const` arrow used by a top-level block is in the temporal dead zone.** The first live refusal
   threw `Cannot access 'speechEventFor' before initialization`.
3. **Severity had to outrank enforcement class.** Bridging ten project `checklist` lessons displaced
   issue #122's high-severity `inject` lesson from `write-code` — the *second* time in one day that
   lesson lost its slot. With `limit: 3`, selection is the scarce resource: what matters more must not
   lose to what merely acts more forcefully. The prior test asserting the old rule was updated with
   the reason, not silently flipped, and a case still proves enforcement decides at equal severity.

## Honesty boundary

- **MAY claim**: exactly one hook can refuse a given tool call, pinned by a test that reads
  `hooks.json` and fails if a second refuser ever appears; and refusal outcomes are now recorded with
  `abandoned` inside the denominator.
- **May NOT claim**: that advisory lessons change behaviour. That remains unobservable and unmeasured,
  and is stated rather than estimated.
- **Coverage is partial and deliberately so**: this measures the blocking path. Advisories are counted
  as surfaced for coverage and never scored.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-13 | **Both hooks I added today misbehaved in OTHER people's projects — found by an adversarial hook audit, not by a test.** | The owner reported "a ton of hook errors" opening this plugin in another project; an independent audit reproduced the causes. (1) `degradation-watch` probed `process.cwd()/.swarm/memory.db`, so machine-wide it ran `ruflo memory store` against WHATEVER REPO you were standing in — creating a `.swarm` directory and writing a probe row into projects that never asked for it. The audit named it "unrelated-project mutation"; it is the plainest violation of ADR-058 D5 (never touch what we do not own), shipped in the hook whose purpose is preventing silent damage. The fix was not tighter scoping but noticing the question was mis-framed: "does ruflo durably persist?" is a property of the SQLite driver and its ABI against the running node, which is MACHINE-wide. It now probes a scratch db in tmpdir — mutates nothing, and additionally closes the separately-flagged hole where an absent store had to be skipped, making the store-CREATING first write the one write the guard could never falsify. A scratch path is always absent, so the first-write case is now the ONLY case. (2) `identifier-preflight` treated the single `model` in ~/.codex/config.toml as the complete allowlist — a false-refusal waiting to happen, since an account accepts several models. It now refuses only a NEAR MISS of the configured name (a typo, which is what actually happened: `gpt-5.6` for `gpt-5.6-sol`) and passes anything genuinely different as unknown. 82/82 across the three gate suites. STILL OPEN from the same audit, ranked: Codex does not load the shipped hook manifest; `signal-watch` emits invalid Codex hook output; Claude has the new decision gate while Codex still has the old one; `continuation-gate` treats this repo's open PRs as "work you committed to" in EVERY project; a missing KB renders as a global emergency. |
| 2026-08-13 | **degradation-watch's cache DELETED, and its absent-store exemption closed — both found by two independent audits that could not see each other.** | The cache was keyed `/tmp/ruvnet-degradation-$USER.json` while the probe targets a PER-PROJECT path, and each audit found a different half: a degraded project cached `ok:false` and refused `git push` in a HEALTHY project for five minutes citing another repo's evidence; a healthy project cached `ok:true` so a BROKEN project shipped inside the TTL without ever being probed — the direction that actually loses data. Two blind models finding two different bugs in one cache is the signal that the cache, not its key, was the defect, so it is gone: the probe runs only on `git push` / `npm publish` / `ruflo memory store`, where one second is invisible and a wrong answer is expensive. Separately, `proveMemoryDurable` returned `{ok:true, skipped:true}` for an absent DB — which, as one audit put it, means the first `ruflo memory store`, THE OPERATION THAT CREATES THE STORE, was precisely the write the guard could not falsify: a hole shaped exactly like a fresh machine's first write. Ship detection also corrected in BOTH files that define it (they shipped already disagreeing on day one): `git -C <abs> push` matched nothing, while `grep -n "npm publish" docs/` matched, so reading ABOUT shipping counted as shipping. Quoted regions are now stripped before matching in both, and a parity test asserts the two definitions agree in both directions. 61/61 lesson-gate, 12/12 decision-gate. |
| 2026-08-13 | **The new gate was itself dead on every shipped install, and the payload test caught it in the commit that cited ADR-065.** | `adr-currency-gate.mjs` statically imported `../../scripts/doc-currency.mjs`. Only `plugin/` reaches a user (marketplace.json `"source": "./plugin"`), so that specifier resolves in a checkout and throws ERR_MODULE_NOT_FOUND on every real layout — a gate that would have been silently absent for every user, which is the exact class ADR-065 exists to stop and the class I had spent the day fixing elsewhere. `payload-self-contained.test.mjs` failed on it immediately. The fix is not an exemption: doc-currency IS correctly repo-only, because a user's install has no `docs/adr/` and this gate has nothing to say there. So it resolves at runtime and its absence is a CLEAN SKIP rather than an error. Also corrected in the same pass: the brain-score README guard was flagging past-tense narrative ("the console USED TO … score it 49/100") because the line contains "now" — a guard that flags correct prose gets deleted, and then protects nothing. And the public README's "Current baseline" line, which asserted a 2026-07-10 measurement as today's, is now dated from the artifact's own `recorded` field. Census drift (139,373 -> 139,519 across four surfaces) regenerated through `claims:fix`; the diff was audited to confirm only the chunk count moved, since `sync-census` is known to rewrite role-blind when the org total shifts. 55/55 across the four suites. |
| 2026-08-13 | **A fourth policy joined the WRITE path, and it exists to move a gate earlier rather than to add one.** | `adr-currency` refuses a write to code governed by a document that is ALREADY stale. The rule is not new and the logic is not new — it calls `scripts/doc-currency.mjs`, never a second copy, because one fact implemented twice is the defect this repo has paid for at least five times. What changed is WHEN. Earlier today three commits left ADR-055, 065, 066 and 067 all describing a world the code had left; the pre-push gate refused, correctly, but only after the files were written and I had moved on, and my own word for the reconciliation was "skipped". The owner quoted that back as the exhibit for a larger complaint — that the right thing only ever happens because a hook forces it at the last second — and he is right about the shape: a gate at the end cannot influence work, only penalise it, and it trains running at the wall. So this refuses DEBT rather than change: governed code may be edited freely, but not while a governing document is still unreconciled. Measured before writing, not after: `evaluateDoc` costs ~200ms per document via git and there are 83, so a naive loop would put ~19s on every Write and become the gate everyone disables; a frontmatter-only first pass over all 83 costs 40ms, and only the 1-4 documents that actually govern the file are evaluated — 981ms on a governed file, 146ms otherwise. Mutation-proved, and the first run FAILED: it reported "STALE ADR -> DID NOT FIRE" while all three allow-cases passed, because `fs.readFileSync` was hardcoded where the test needed a seam. A suite of allow-cases only would have shipped a green unfireable guard — the fourth instance of that class in one day. 9/9 now, `decision-gate` still 12/12 including the second-refuser mutation. |
| 2026-08-13 | **Two policies joined the registry. The invariant holds: still exactly one process refuses.** | `degradation-watch` (2nd in precedence) and `identifier-preflight` (3rd) are new verdict functions on the `bash` event, added because both failures they close were SILENT. (1) AgentDB had not durably persisted a write since 2026-08-10: `better_sqlite3.node` was built for NODE_MODULE_VERSION 141 against a node needing 137, ruflo fell back to sql.js, and three days of lessons and checkpoints evaporated while the CLI printed `[OK] Data stored successfully`. The warning printed on EVERY write and was read; a warning is text and text is skimmable, so this is a refusal — and it probes only commands whose truth DEPENDS on durable memory, so ordinary Bash pays nothing. (2) `codex exec --model gpt-5.6` (correct: `gpt-5.6-sol`) printed a 400 and EXITED 0 into a redirected file, so a 50-minute audit produced nothing and there was no exit code to catch. Both refuse only on a POSITIVELY-known-bad state and allow every unknown: an adversarial review the same day found the first one turning a missing `sqlite3` into a confident claim about a different subsystem, which is worse than no check because it spends the credibility the channel runs on. `decision-gate.test.mjs` still passes 12/12, including the mutation case that fails if a second refuser appears. OPEN, from that same review and not yet fixed: degradation-watch's cache is keyed by `$USER` while it probes a per-project path, so one project's verdict can leak into another; and its probe shares the gate's 4000ms budget, where a timeout-kill reads as allow. |
| 2026-08-12 | **The decision is unchanged; the file got shorter and its Windows behaviour got stated.** | Two changes to `decision-gate.mjs`, neither touching the invariant. (1) Its header had grown to 54 lines of prose before the first import, and the six new modules averaged 40-51% comment — the owner asked whether this was becoming elegant or convoluted, and on that metric it was drifting convoluted. The measurements were never the problem, their LOCATION was: they already live in this ADR, so the header now carries only what surprises a reader at the call site (the policies are unchanged verdict functions; one decision names every refuser; fail-open is deliberate). 54 -> 17 lines, no fact lost. (2) The real-gate cases now require bash. Every refusal policy is a `.sh` file, so on a Windows runner without Git Bash `resolveBash()` returns nothing, no policy contributes a verdict, and the gate correctly FAILS OPEN — the same behaviour those four walls always had on a bashless host. The product was right and the assertion demanded a refusal that cannot occur there; it turned PR #137 red while looking like a dependency problem. The pure `decide()` / `policiesFor()` cases carrying precedence and composition still run on every platform. |
| 2026-08-10 | **Decisions 4 and 5 landed: the end-to-end proof, and promotion that reports whether it acted.** | (4) `tests/integration/bridge-to-model-e2e.test.mjs` walks the WHOLE chain with real processes — tagged AgentDB row → bridge → lessons.json → lesson-gate → unprompted-runtime → decision-gate → the model's additionalContext — in a hermetic HOME. Every prior test covered ONE hop, which is how two excellent halves stayed unconnected for 18 days. Mutation-proved: disabling the bridge turns 2 of 3 cases red, and two TEETH cases prove the trigger is load-bearing (an untagged row travels no further than the store; a lesson tagged for `ship` does not fire at `write-code`). (5) `lesson-promote --apply` now prints a DERIVED firing status — "31 of 34 machine-wide lessons reach a decision point" — and names the inert ones. It deliberately does NOT auto-assign a trigger: guessing the moment is the keyword-classifier mistake ADR-065 recorded in its own numbers, and a test asserts the store is untouched by a report. |
| 2026-08-10 | Accepted as built: `decision-gate.mjs`, `decision-outcomes.mjs`, `hooks.json` rewired from 7 PreToolUse entries (4 able to refuse) to 4 (1 able to refuse). | Live-fired both paths: allow → exit 0, 1525B advisory forwarded, byte-empty stderr; refuse → exit 2, the policy's own words, byte-empty stdout. Obedience loop proven end-to-end: refuse → retry → scored `repeated`; a dead session's debt → `abandoned`. 152/152 across the six affected suites, and the structural invariant is mutation-proved (re-adding a second refuser fails two cases). |
