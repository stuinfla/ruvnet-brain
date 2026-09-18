---
id: ADR-030
title: Latent knowledge is not knowledge — few gates, many lessons, retrieved at the decision point
status: Proposed
date: 2026-07-22
updated: 2026-09-17
authors: [Stuart Kerr, Claude Code]
tags: [learning, enforcement, gates, context-budget, compounding, 4.0]
supersedes: []
relates: [ADR-027, ADR-028, ADR-029]
---

**Status**: Proposed (2026-07-22)

Completes the 4.0 trilogy: **ADR-028** defines what proactive means, **ADR-029** mines which lessons
are universal, and **this** is how a promoted lesson actually changes behaviour instead of becoming
one more paragraph nobody acts on.

## The critique this exists to answer

The owner, 2026-07-22, and it is the sharpest thing said in the entire project:

> *"Knowledge you don't use, knowledge you don't leverage every time, knowledge you're not
> consistent with, is not knowledge. Latent knowledge and knowledge are two very different things.
> You've told me a dozen times, 'Oh, I knew it was there, I just didn't follow it,' which tells me
> that's a worthless strategy."*

He is describing a measurable fact, not a feeling. **ADR-029 would be worthless without this
document**: mining 284 lessons and writing them into a file that gets read past produces a longer
file and identical behaviour.

## The measurement that decides the architecture

From a single session (2026-07-21/22), sorted by what actually happened:

| Knowledge form | Instances | Complied? |
|---|---|---|
| `ground-before-write` gate | 3 | **3/3** — stopped a hand-roll every time |
| `verify-interface` gate | 1 | **1/1** — blocked a guessed CLI flag (historical, before shell-hook retirement) |
| `narrative-version` gate | 1 | **1/1** — forced the release story to be written |
| `sync-version --check` gate | 1 | **1/1** |
| no-hardcoded-version gate | 2 | **2/2** — caught the author's own test fixtures |
| **CLAUDE.md prose: "bump the version on any behaviour change"** | 6 commits | **0/6** — the owner caught it |
| **Memory file: "thank contributors personally"** | 2 issues | complied, but the owner still had to ask |

**Gates: 8/8. Prose: 0/6 on the load-bearing one.** The same model, the same session, the same
stated intentions. The only variable was whether the knowledge could interrupt.

This is ADR-027's finding — *"knowledge that does not interrupt does not act"* — reproduced under
controlled conditions, and it settles the storage question: **a lesson's tier determines whether it
is latent or active, and prose is the latent tier.**

## The constraint that rules out the obvious fix

The naive response is a gate per lesson. The owner pre-empted it, correctly:

> *"The answer can't be implementing a thousand hooks, because all that's going to do is clog my
> context. There has to be a more elegant architecture."*

He is right on both counts. 284 lessons at roughly 150 tokens each is **~42,000 tokens** — more than
the working context of most sessions, spent before a single word of the actual task. And a
per-lesson hook file is unmaintainable within a month.

## Decision

### 1. Gates are per DECISION POINT, not per lesson — and the FIRST one is the assumption

**Correction, 2026-07-22, made after the owner read the first draft.** The original list had five
entries and led with "before writing code." It was wrong in the most embarrassing possible way:

> *"I ask you questions about architecture, and you immediately do a casual look, look at the
> history, and come back and tell me something that's dead wrong. Why? Because you didn't bother to
> look deeply, didn't check the RuvNet brain, didn't do research, didn't check the assumptions.
> Those assumptions are the big toxic killer of quality and effectiveness. To have that not be in
> that list is inexcusable."*

He is right, and the omission is self-indicting: **his global CLAUDE.md Rule 0 is literally
"VERIFY-FIRST — NEVER ASSUME (overrides everything below; the #1 cause of failure)."** This document
enumerated the moments knowledge must interrupt and left out the one his own constitution ranks
first. An ADR about enforcing lessons, committing the exact failure it describes, in the act of
describing it.

The failure mode is also structurally different from the others, which is *why* it was missed: every
other gate fires on a **tool call** (Write, Edit, push) and is therefore easy to hook. An assumption
fires on **text output** — the cheapest possible action, with no tool boundary to intercept. It is
the least gated surface and the highest-frequency failure. That is not a coincidence; it is the
explanation.

The corrected enumeration. The gate count is bounded by decision **types** — it never grows with the
lesson count, which remains the trick — but there are more than five, and pretending otherwise was
tidiness at the cost of truth.

| # | Decision point | Hook surface | The question it forces |
|---|---|---|---|
| **1** | **Before asserting a fact about the world** (a version, an API, what a tool does) | `UserPromptSubmit` classify → `Stop` verify | **"Did you CHECK, or are you recalling? Name the source."** |
| **2** | **Before recommending an architecture** | `UserPromptSubmit` classify | **"Did you research, compare ≥3 options, and state tradeoffs — or pattern-match?"** |
| **3** | **Before relaying a number** (a score, a benchmark, a subagent's result) | `Stop` | **"Did you re-check the artifact, or repeat what you were handed?"** |
| 4 | Before writing code | `PreToolUse(Write\|Edit)` | "Does rUv already ship this? Is the term grounded?" |
| 5 | Before claiming done | `Stop` | "Did you RUN it, or are you asserting?" |
| 6 | Before shipping | `pre-push` | "Version bumped? Docs current? Both suites green?" |
| 7 | After finishing work | `PostToolUse` / `SessionEnd` | "Checkpointed? People thanked? Lesson captured?" |

1–3 are all species of the same disease — **asserting without checking** — separated because they
need different evidence: (1) a live source, (2) a comparison, (3) a re-measurement. Collapsing them
into "be careful" is how the whole class went unenforced.

Gates 4–7 exist today. **1–3 do not, and they are the ones that fail most often.**

### 1b. Repetition IS the signal — and rUv already built the detector

The owner: *"If I'm having to tell you three, four, five, and six times, that's indicative of a huge
failure. You should be looking for those, spotting those, and addressing it proactively."*

He independently reinvented `ruflo` ADR-G008 Step 1 (`v3/@claude-flow/guidance/src/ledger.ts`,
`RunLedger.rankViolations()`), which ranks by `frequency × cost`, and Step 2, which states verbatim:
*"Existing rule, frequently violated (>5 times): modify the rule text to be more specific and **add
automated enforcement annotation**."* Escalating a repeatedly-violated rule from prose to enforcement
is rUv's shipped design. We adopt it rather than inventing one.

The two readings of the same data are **different signals and must not be conflated**:

| Signal | Meaning | Response |
|---|---|---|
| Taught across ≥2 **projects** | universal knowledge | **promote** to the constitution (ADR-029) |
| Taught ≥3 times **within one project** | the existing rule is not being enforced | **escalate** to a blocking gate |

Measured on the owner's machine, 2026-07-22:

```
prove it works             25× in Code-PowerPlatePulse   → ESCALATE
version + release          14× in Code-ruvnet-brain      → ESCALATE
ground it / never assume    7× in Code-PowerPlatePulse   → ESCALATE
honesty / no fabrication    5× in Code-PowerPlatePulse   → ESCALATE
use the real tool           3× in Code-ruvnet-brain      → ESCALATE
```

**Version discipline was recorded 14 times in THIS repository, and was violated again on
2026-07-22** — six behaviour-changing commits at patch level with no bump. Promotion would not have
helped: the lesson was already here, in this project, fourteen times over. Only enforcement closes
that gap, and the repeat count is the trigger that should have demanded it long ago.

### 2. Lessons are DATA the gates read — never code

A promoted lesson is a row, not a file. Each carries the decision point it belongs to, so a gate can
ask for exactly its own moment's lessons and nothing else.

Adding a lesson therefore adds **zero** files, **zero** hooks, and zero maintenance. The system
scales in the dimension that grows (lessons) and stays fixed in the dimension that costs (gates).

### 3. Retrieval at the decision point, not bulk loading — this is the context answer

A gate injects the top 2–3 lessons **relevant to that moment**, retrieved semantically from the
personal brain. Not all 284.

| Approach | Context cost | Verdict |
|---|---|---|
| All 284 lessons in CLAUDE.md | ~42,000 tokens | impossible |
| Today: ~21 hand-written global rules | ~3,000 tokens | current baseline |
| **Constitutional 7 + 3 retrieved per gate** | **~1,450 tokens** | **cheaper than today** |

The architecture that makes behaviour *more* consistent also makes context *smaller*, because
relevance beats volume. That is the elegance the owner asked for, and it is why "retrieve at the
moment" is load-bearing rather than a nicety.

### 4. Three tiers, chosen by the job — not one store for everything

| Tier | Home | Holds | Job |
|---|---|---|---|
| **Corpus** | `~/.cache/ruvnet-brain/personal.rvf` | every promoted lesson, embedded | semantic recall at a decision point |
| **Constitution** | `~/.claude/CLAUDE.md` (fenced) | ~7 always-true rules | always-on, cheap, human-editable |
| **Enforcement** | 5 existing hooks | no lessons of their own | converts latent → active |

The personal RVF store answers the owner's direct question ("can you put it in a personal RuvNet
brain?"): **yes, and it is the right home** — because it is **user data outside the shipped bundle**,
which is precisely what makes a promoted lesson survive `--update` and the nightly refresh
(ADR-029 §5). A lesson stored in the bundle would be destroyed by the next release; that is not a
detail, it is the difference between compounding and starting over.

But the RVF store alone cannot make anything comply — it is a pull surface. Storage and enforcement
are different problems, and conflating them is how a lesson becomes latent.

### 5. Every promoted lesson is visible and reversible — one screen, one click

The owner's requirement: *"I should be able to see them all at a global level, and I should be able
to go delete any ones you thought were global but are really project-based."*

Non-negotiable, because ADR-029's promotion bar is evidence-based but not infallible — a keyword
cluster can absolutely lift something local. So every promoted lesson shows:

- its text, and the **decision point** it fires at
- **provenance**: which projects independently taught it, and how many times
- **demote**, which removes it from the constitution and marks it project-scoped so it is never
  re-promoted by a later mining run

Demotion must be **sticky**. A one-click demote that the next nightly mine silently undoes is worse
than no demote at all, because the user will stop trusting the control and, correctly, stop using it.

## Why this is the compounding loop, finally closed

```
  work happens
      ↓
  lesson captured                     (project memory — already automatic)
      ↓
  learned in a 2nd project            (ADR-029: independent rediscovery = evidence)
      ↓
  promoted to the personal brain      (survives updates: user data, outside the bundle)
      ↓
  retrieved by a gate at the moment   (THIS ADR: latent → active)
      ↓
  behaviour changes, in every project
      ↓
  outcome observed → demote if wrong  (the loop's error-correction)
```

Every previous attempt broke at the fourth arrow. Everything up to "promoted" already existed in
pieces; nothing turned a promoted lesson into an interruption, so nothing changed behaviour.

## Anti-goals

- **A gate per lesson.** The gate count is fixed at the number of decision points. If it starts
  growing with the lesson count, this design has failed and should be reverted, not extended.
- **Injecting everything "just in case."** A gate that injects 20 lessons is a gate people learn to
  ignore, and an ignored gate is prose with extra latency.
- **Silent promotion.** A rule the user cannot see, audit, and delete is a rule imposed on them.
- **Blocking on soft preferences.** Only non-negotiables block. Preferences are *injected as
  context*; taste that refuses to let you work is a bug, and it is how users disable gates entirely.

## Consequences

- Adding a lesson costs nothing structural — no file, no hook, no maintenance.
- Context cost goes DOWN relative to today while consistency goes up.
- **New risk:** a wrongly-promoted lesson now *blocks work* across every project rather than merely
  cluttering a file. This is exactly why §5 (visible, demotable, sticky) is not optional, and why
  only non-negotiables are permitted to block.
- The five gates become the highest-leverage code in the repo. They need their own tests, and a gate
  that fails open must say so loudly rather than silently passing.

## Verification (what must be true before this is Accepted)

1. ✅ **DONE (2026-07-22, v3.7.0-dev).** A promoted lesson demonstrably changes behaviour at its
   decision point. `scripts/lesson-gate.mjs` reads the store; the version-bump gate now appends the
   lesson's own words to its refusal. Proven by exit code: before ratification the ship trigger
   exits 0 (informs); after the owner ratified 9 user-stated lessons, five triggers exit 1 and
   refuse. A model-inferred lesson passed through `--ratify` stays `checklist` and CANNOT become
   `block` — the trust boundary holds under the exact bulk action that would defeat it.
2. ❌ Measured context cost of the constitution + per-gate retrieval is **below** today's baseline.
   The claim above is a calculation, not a measurement, and must not be repeated as fact until
   instrumented.
3. ⚠️ A promoted lesson survives `npx ruvnet-brain --update` and a nightly refresh (shared with
   ADR-029 #3) — demonstrated by isolation 2026-07-23 (unique promotion markers vs the installer's
   own `ruvnet-brain:start` block; no update-path writes to `CLAUDE.md`; idempotent), not yet by live
   execution. Full evidence in ADR-029 #3.
4. ⚠️ PARTIAL (2026-07-22). `scripts/lesson-ratify.mjs --list` shows every lesson with trigger,
   force, provenance, weight and evidence; `--demote` sets a sticky flag the miner must honour.
   Still ❌: demotion stickiness has NOT been proven across an actual subsequent mining run, and
   the surface is a CLI rather than part of the console. Both remain open.
5. ❌ Adversarial cross-model review recorded, per ADR-027 principle 6 — still outstanding for
   ADR-027, 028, 029 and this one.
