# ADR-0009: The Mirror Discipline — RuvNet Brain must pass its own bar (self-audit + ADR/DDD/doc QA)

**Status:** Accepted (2026-07-06) · **Origin:** Stuart's directive — "have RuvNet Brain review the
existing codebase, grade it 1–100 on core elements, paint the gaps, then add an ADR + DDD and QA them
just like RuvNet Brain always would… rUv uses ADRs and DDDs that are written and then QA'd aggressively
to make sure they're real and complete, and checks all documentation is current and complete."
**Grounded** via `search_ruvnet` against real rUv source (paths cited inline) and via a 5-agent parallel
self-audit of this repo at HEAD `ca248c9` (each agent read the real files; scores below are theirs).

## Context

RuvNet Brain's entire thesis is *anti-drift*: "training priors are stale, the brain is the source of
truth, ground before asserting, never let a stale artifact lie to you" (README.md:35-43, SKILL.md rule 1).
This ADR turns that discipline **on the product itself** for the first time. We ran a five-dimension
parallel audit (intent/effectiveness, code, architecture, docs, UX/visual), each agent grounded in the
real repository. The result is a genuinely strong core undermined by systemic *truth-consistency* debt —
which is the most damning possible failure for an anti-drift product.

### The scorecard (each score is an audit agent's, with file-cited evidence; no inflation)

| Dimension (Stuart's list) | Score /100 | One-line basis |
|---|---:|---|
| What it's trying to do (intent clarity) | **70** | Core thesis coherent; but version identity contradicts itself across the 3 primary docs. |
| How effective it is | **55** | Retrieval engine real & proven; the *enforcement* headline outruns the evidence (instruction-only). |
| How good the code is | **68** | High per-file craft (fail-closed, cross-platform); capped by no version SoT and no wired test/CI. |
| How elegant the architecture is | **70** | Clean retrieval core + brain/plugin proxy; capped by enforcement-vs-spec gap + version fracture + overloaded hook. |
| How complete the documentation is | **62** | Onboarding/architecture strong; 5 shipped subsystems have zero docs; no CONTRIBUTING. |
| How up-to-date everything is | **45** | `plugin/README.md` stuck at v0.1 (lists removed Helix, "300 MB"); ADRs describe enforcement that never shipped. |
| UI effectiveness | **86** | Installer narration + error recovery best-in-class (`bin/install.mjs`). |
| How compelling the experience is | **84** | Maya story, live drift demo, "you can't break anything" — genuinely exciting. |
| How professional/visual/next-gen | **84** | Bespoke Fraunces/Hanken type + custom animated SVGs; docked for the clichéd glowing-brain hero + premium-*safe* layout. |
| **Honest overall** | **~66** | Excellent surfaces (installer 86, explainer 84, retrieval core) eroded by systemic truth-consistency debt. |

### Problem statement — the five load-bearing debts (each found independently by ≥2 agents)

1. **Version single-source-of-truth has fractured into 5+ inconsistent numbers.** At one instant:
   `plugin/.claude-plugin/plugin.json`=**1.9.1-dev**, root `package.json`=**1.6.2-dev**,
   `data/manifest.json` `brainVersion`=**v0.3.0-dev** (the DDD's supposed aggregate root),
   README body=**v0.5.0-dev** (6 places), `kb/forge-mcp-all.mjs`/`kb/package.json`=**1.0.0**,
   installer/stamp fallbacks =**v0.5.0/v0.3.0-dev**. For a product whose whole value is "don't let stale
   artifacts lie," this is the deepest wound.
2. **Enforcement ships materially weaker than its own Accepted ADR.** `docs/adr/0005` promises four teeth:
   retrieve-and-inject, PreToolUse **hard-deny**, a **Stop** semantic judge, and a **measured drift-rate
   SLO**. Reality: `plugin/scripts/hijack-ruvnet.sh` sets `DECISION="defer"` (never blocks); **no `Stop`
   hook exists** in `plugin/hooks/hooks.json`; **no drift measurement exists** anywhere. Three of four
   teeth are unbuilt, and `docs/DDD.md`'s "measured drift-rate ≤ SLO" invariant is unmet. README describes
   the shipped soft-inject accurately — so the ADR and DDD are stale against *both* the code and the README.
3. **No proof discipline.** The single biggest recent effort (16 versions in one day) is graded against
   **one reviewer's** transcripts; the eval harness is `NEXT`/unbuilt (PROGRESS.md). Every quality score is
   a prediction. `package.json` has no `scripts` (so `npm test` is a no-op) and there is **no CI**.
4. **The nightly publisher can ship a broken brain.** `scripts/self-update.mjs` swallows per-repo build
   errors then still runs `--stamp`/`--bundle`/`--publish` (commit + `gh release create` + `git push`) —
   a failed rebuild ships in a new Release + version bump. There is **no smoke gate** on publish.
5. **Duplication with no owning source.** The "take the wheel" contract exists twice (shell heredoc +
   `SKILL.md`); the substitution map is triplicated (`ground-ruvnet.sh` / `hijack-ruvnet.sh` / `SKILL.md`);
   "is it stale?" currency logic is smeared across four uncoordinated places. All will drift.

### Grounding — rUv already ships the QA machinery we lack

- **Anti-Slop quality model** — `agent-harness-generator/docs/adrs/ADR-009-anti-slop.md` (Proposed):
  a plugin is *not publishable* unless its bundled **smoke contract** passes (gating, Ed25519-signed);
  quality is expressed as **measured signals**, never editorial; trust tiers are **derived, not declared**.
  RuvNet Brain *is* a plugin and has **none** of this. This is the template for defects 3 & 4.
- **aiGI Final Assembly** — `ruv-dev/aiGI/.roo/final-assembly/final-assembly.md`: rUv's QA/validation gate —
  Completeness / Correctness / Usability / Maintainability, with hard thresholds (≥90% line, 100% function
  coverage, ≥98% test reliability) and TDD validation *before* a deliverable is "done." The template for a
  real test/CI gate.
- **The self-improving flywheel** — `ruflo/v3/docs/adr/ADR-176` (harness loop) + `ADR-177` (signed config
  propagation): candidates are promoted **only** past an evidence gate (beats incumbent on a *frozen
  held-out* split + bootstrap lower-bound > 0 + no regression on human-labeled truth + deterministic
  replay), with an auditable lineage. The template for defect 3's eval harness.
- **agentic-flow as meta-harness** — `agentic-flow/docs/adr/ADR-076` (Accepted): "freeze the model, evolve
  the harness," four pillars **route / evolve / orchestrate / verify**. The strategic frame: RuvNet Brain's
  own behavior should be an evolved-and-verified harness, not a hand-tuned prompt.

## Decision

**Adopt the Mirror Discipline: RuvNet Brain must hold itself to the exact bar it enforces on others.**
Concretely, seven decisions — each closes a named defect above and is grounded in rUv's own practice.

1. **One version, one source of truth.** `plugin/.claude-plugin/plugin.json` `version` is the single
   product version. Every other surface reads it at runtime (installer, stamp, bundle, MCP `SERVER_INFO`,
   README body); all hardcoded `v0.x` fallbacks are deleted. `data/manifest.json.brainVersion` and the
   README *body* become generated, never hand-typed. (Closes defect 1. The three legitimately-independent
   tracks — plugin / npm-installer / brain-Release — stay, but each is machine-read, never duplicated.)

2. **Reconcile the plan to reality — the brain's own ADR-drift rule, applied to itself.** ADR-0005 and the
   DDD are updated to describe what actually shipped (soft retrieve-and-inject; hard-deny/Stop/SLO marked
   *deferred, not implemented*), or superseded. **No accepted ADR may describe a world the code doesn't
   live in** — the precise rule Gate 0 already nags users about. (Closes defect 2's honesty half.)

3. **A smoke-gated publish.** Per Anti-Slop: `scripts/self-update.mjs --publish` collects per-repo build
   failures and **aborts the Release** if any occurred; and a bundle **smoke contract** (install into a
   fresh test dir, assert `search_ruvnet` returns a real cited hit for 3 canonical questions) must pass
   before `gh release create`. A brain that can't answer never ships. (Closes defect 4.)

4. **The behavioral eval harness = RuvNet Brain's own flywheel.** Per ADR-176/177: the response contract's
   nine-point bar becomes a grader set; a **frozen held-out** scenario suite (never tuned against) plus the
   graded field transcripts (the human-truth guard) gate every version. A contract change is promoted only
   if it beats the incumbent and regresses nothing. Ends "Mario as QA"; turns every score from prediction
   into measurement. (Closes defect 3.)

5. **Three new first-class brain capabilities — the QA disciplines rUv runs, wired in.** The brain gains,
   as skill+hook behavior (design here; build tracked):
   - **ADR-QA** — when a project keeps ADRs, verify each is *real and complete*: has Status/dates, its claims
     match the code it governs (drift check, already nudged in Gate 0 — now with a verify step), and its
     dependencies resolve. Extends the ADR-0009-living-plans work.
   - **DDD-QA** — validate a domain model against the code: do the named bounded contexts exist, do the
     anti-corruption boundaries hold (no cross-context imports), are aggregate invariants enforced. Grounded
     in the `ruflo-ddd` `ddd-validate` tool where installed.
   - **Doc-currency verification** — the discipline this ADR was born from: scan docs for version strings,
     feature lists, and "what's new" claims and flag any that disagree with the single source of truth or
     with shipped reality. (This audit is the manual v0 of exactly this capability.)

6. **Collapse duplication to one owning source.** The substitution map, the behavioral contract, and the
   currency logic each get a single canonical definition that the shell hook, the skill, and the scripts
   all read — no more triplicated prose that drifts. (Closes defect 5.)

7. **A wired test gate + CI.** `package.json` gains `"test"`; a CI job runs the brain-independent checks
   (structure, hook fires-on-topic/silent-off-topic/exit-0, the injection-guard unit test) on every commit;
   the installer and publisher — the two highest-risk, currently-zero-coverage scripts — get smoke coverage.
   Per aiGI Final Assembly: nothing is "done" without a green gate from a fresh clone.

## Acceptance criteria (each decision is "done" only when measurable — an ADR about proof must prove itself)

An ADR whose whole thesis is "stop asserting, start measuring" cannot itself have hand-wave exit conditions.
Each decision above is DONE only when its check below is green — verified from a fresh clone, not asserted:

1. **Version SoT** — a CI check greps the tree for a hardcoded `vX.Y.Z-dev` literal and finds it in **exactly
   one** file (`plugin.json`); installer/stamp/bundle/README-body all read it at runtime. Deliberately editing
   `plugin.json` and rebuilding propagates everywhere with no second edit.
2. **Reconcile plan → reality** — **ADR-QA is green on our own repo**: no accepted ADR's claims contradict the
   code. ADR-0005 reconciliation is *done this commit* (48749be); the check must stay green thereafter.
3. **Smoke-gated publish** — a fault-injection test (deliberately break one repo's build, or corrupt the bundle)
   makes `self-update.mjs --publish` **abort before `gh release create`** and exit non-zero. Proven once.
4. **Eval flywheel** — a contract change that regresses the **frozen** scenario suite is **blocked in CI**,
   demonstrated once with a deliberately-worse variant.
5. **Three QA capabilities** — each (ADR-QA / DDD-QA / doc-currency) runs on **this repo** and produces a real,
   true finding (dogfood). doc-currency's v0 already fired: it found the 5-way version fracture.
6. **Collapse duplication** — the substitution map, the behavioral contract, and the currency logic each have
   **exactly one** defining file; `grep` proves no second copy; the hook/skill/scripts read the canonical one.
7. **Test + CI** — a fresh clone runs `npm test` green (structure + hook-behavior + injection-guard unit), and
   CI is green on a commit; the installer and publisher have smoke coverage.

## Consequences

- **Honest scope:** this ADR is design-before-code (the rUv way Stuart is asking for). It ships the
  *audit, the reconciled plan, and the DDD*; the seven fixes are tracked work, sequenced with #1 (version
  SoT) and #2 (ADR/DDD reconciliation) first because they're cheap, damning, and prove the discipline is
  real rather than documented.
- **The meta-win:** RuvNet Brain becomes the first user of its own three new QA capabilities — dogfooding
  ADR-QA/DDD-QA/doc-currency on its own repo is the proof they work.
- **Unproven until measured (carried from ADR-0008/0002):** that the eval harness actually moves behavioral
  quality, and that the smoke gate catches a real broken publish, are hypotheses to verify — first proof
  targets: run the harness on the field transcripts we already have; run the smoke gate against a
  deliberately-broken bundle.

## Alternatives rejected

- *"Just fix the version strings and move on."* — Treats a symptom. Without a single machine-read source
  and a doc-currency check, they re-drift on the next fast week (this one produced the fracture in a day).
- *"Keep grading behavior against field transcripts."* — That's the Goodhart-prone, N=1 loop ADR-176 exists
  to replace; it can't scale to hundreds of developers and can't prove a regression.
- *"Document the QA disciplines as SKILL guidance only."* — Guidance without a wired gate is exactly the
  instruction-only trap defect 2 indicts. The gate must be structural (CI + smoke), not advisory.
- *"Rewrite the enforcement to match ADR-0005 (build hard-deny + Stop + SLO)."* — A larger, separate build;
  reconciling the ADR to the shipped soft-inject is the honest move *now*, with the harder enforcement left
  to a future ADR that measures whether it's even needed.
