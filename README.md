<div align="center">

![RuvNet Brain — the answer key for Ruv's code](assets/hero.png)

# 🧠 RuvNet Brain

### 🧠 RuvNet Brain — [![RuvNet Brain version 3.9.100-dev — updated 2026-07-24 16:09 EDT](https://img.shields.io/badge/version_3.9.100--dev-updated_2026--07--24_16:09_EDT-1E90FF?style=for-the-badge&labelColor=0757BA)](https://github.com/stuinfla/ruvnet-brain/blob/main/plugin/.claude-plugin/plugin.json)

**A portable, source-grounded brain over Reuven Cohen's (rUv's) RuvNet stack — delivered as a Claude Code plugin that makes Claude _use_ the stack instead of fighting it.**

</div>

> ## 🧭 North Star
>
> **rUv has built dozens of genuinely powerful capabilities that are effectively invisible — not undocumented, but _undiscovered_.** Ruflo's own docs call cross-project IPFS pattern transfer *"the substrate plugin's most underused capability."* The author knows people can't find his own work.
>
> **This project exists to close that gap** — a CTO on your shoulder that says *"you have this, it's off, here's what turning it on buys you."*
>
> **Retrieval was never the product. Proactive capability advocacy is the product.**
>
> The test we hold ourselves to: a developer who solves a hard problem with this tool and later learns they'd been sitting on a capability that would have made it trivial — that is a **failure of this project**, not of the user. Knowing which question to ask is the scarce thing; supplying that question is the job.
>
> Every feature is judged against this. If a surface can detect something useful and doesn't volunteer it, it is broken — see [ADR-027](docs/adr/0027-capability-advocacy-and-active-signals.md) and [DDD-0004](docs/ddd/0004-advocacy-context.md).

<div align="center">

[![plugin version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fstuinfla%2Fruvnet-brain%2Fmain%2Fplugin%2F.claude-plugin%2Fplugin.json&query=%24.version&label=plugin&color=e8a13a&style=flat-square)](plugin/.claude-plugin/plugin.json)
[![installer version](https://img.shields.io/npm/v/ruvnet-brain?label=installer%20%28npm%29&color=2e7d32&style=flat-square)](https://www.npmjs.com/package/ruvnet-brain)
[![download](https://img.shields.io/badge/download-latest%20brain-2e7d32?style=flat-square)](https://github.com/stuinfla/ruvnet-brain/releases/latest)
[![explainer](https://img.shields.io/badge/▶%20see%20it%20live-isovision.ai%2Fruvnet--brain-e8a13a?style=flat-square)](https://isovision.ai/ruvnet-brain/)
[![license](https://img.shields.io/badge/license-MIT-8ecae6?style=flat-square)](LICENSE)
[![grounded](https://img.shields.io/badge/answers-cited%20rUv%20source-333?style=flat-square)](#testing--proof)
[![coverage](https://img.shields.io/badge/coverage-28%25%20of%20ALL%20source%20·%20honest-b58900?style=flat-square)](#testing--proof)

> **Three independent things version separately here — by design, not drift. Headline claims are regenerated and checked by the claims ledger (`scripts/claims-verify.mjs`); other numbers below are hand-stamped and dated:**
> - **`plugin`** (badge above) — the Claude Code plugin itself: SKILL.md, the grounding hooks, the MCP server. Read live from [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json). Updates often — this is where behavior fixes land.
> - **`installer (npm)`** (badge above) — the `npx ruvnet-brain` setup script. Read live from the [npm registry](https://www.npmjs.com/package/ruvnet-brain). Only moves when the installer script itself changes — rare.
> - **Brain Release** (the downloadable knowledge bundle, linked from the "download" badge above) — always resolves to [`releases/latest`](https://github.com/stuinfla/ruvnet-brain/releases/latest) (the nightly publishes fresh bundles as the corpus grows). Only moves when the underlying knowledge base is rebuilt — separate again from the two above.
> - **On an old version? One line makes you current — and, with `--auto`, keeps you current forever:**
>   ```
>   npx ruvnet-brain@latest --update --auto
>   ```
>   `--update` pulls the latest plugin + knowledge (backs up first, re-verifies, fails loud instead of half-applying). Adding `--auto` enrolls you in **Evergreen** — the brain keeps itself up to date from then on, so you never run this again. Drop `--auto` for a one-time update: `npx ruvnet-brain@latest --update`.
> - **Turn Evergreen off any time:** `npx ruvnet-brain --disable-nightly` (Linux/Windows get the cron line documented in the bundle's `forge-update.mjs`).
> - **Your copy only advances when a new Release is published** — the updater pulls `releases/latest`, so running it between releases is a safe no-op.

<sub>Built by **[Stuart Kerr](https://isovision.ai)** at [Isovision.ai](https://isovision.ai) · free & fair use, to help everyone leverage the high end of agentic coding.</sub>

### [▶ Come see it visually explained](https://isovision.ai/ruvnet-brain/)

<sub>An interactive, animated walkthrough of what you can actually build — **click the preview** to open it.</sub>

[![The RuvNet Brain interactive explainer — click to open the visual walkthrough](assets/explainer-preview.png)](https://isovision.ai/ruvnet-brain/)

</div>

---

## What's new in 3.9 — it anticipates, and it learns whether it was right

**Building toward L4/L5 (3.9.x, dev).** The mechanisms for the top two rungs of the proactivity
ladder are built and wired — but they are **not yet verified to 4.0's bar**, which requires all five
of ADR-028's test classes green under independent grading. Until then, [ADR-028](docs/adr/0028-what-proactive-means.md)
grades the shipped, *verified* state at **L2–L3**, and `-dev` is the honest version. 4.0 is claimed
only when L3+L4+L5 are each measured, not when the code merely exists.

- **L4 Anticipatory (mechanism built).** It infers what you're *trying to do* and names the capability
  that serves that goal — before you hit the wall. Built to stay quiet: a match needs **two
  independent cues** (the problem AND that the topic is your AI workflow), so near-misses get
  silence. Measured on the negative table: **0 false positives**; fires on a genuine match. What's
  still owed for L4: the full five-class verification, independently graded.
- **L5 Compounding (mechanism built, metric now live).** Advocacy records whether it was right —
  precision = acted-on ÷ offered, ADR-028's line between advocating and nagging. The numerator is
  now **derived from an observed state transition** (offered → later switched on = applied) and
  surfaced in the console; it reads an honest `null` until enough offers resolve, never a fabricated
  score. A dismissal is evidence about **fit, not importance** — asymmetric budget: a suggestion dies
  on one dismissal, an important finding needs three. What's still owed for L5: real precision data
  from use, and the cross-project promotion test.
- **The admin page is rebuilt around deltas**, not lifetime totals — and the humans who wrote in
  are promoted to the top, ranked by recency rather than lifetime count.

<details>
<summary><b>Earlier &#8212; what 3.8 shipped</b> &#183; the gate that fires when you stop. <i>Expand.</i></summary>

## 3.8 — the gate that fires when you stop

**Shipped 2026-07-22.** Every gate in this project fires on an **action** — a write, a push, a
claim. That is what makes it enforceable. But **stopping is the absence of an action**, so the most
expensive failure of the night had no trigger at all, and a system built to prevent it did not.

- **`continuation-gate.mjs`** runs when a turn ends. If work you committed to is unfinished, it
  makes that the last thing in context. It cannot force another turn — claiming otherwise would be
  the fabrication this project exists to kill — but it removes the silence that let a stop pass
  unnoticed.
- **Project-scoped ledgers.** Three simultaneous projects never see each other's commitments; a
  "you didn't finish X" fired in a repo that never heard of X is a false alarm, and ADR-028 fixes
  the false-alarm rate at zero.
- **Installed machine-wide**, merged into existing hooks rather than replacing them, with a backup
  taken first — that file governs every project on the machine.

<details>
<summary><b>Earlier &#8212; what 3.7 shipped</b> &#183; your lessons can now refuse your work. <i>Expand.</i></summary>

## 3.7 — your lessons can now refuse your work

**Shipped 2026-07-22.** 3.6 made the machine legible. 3.7 closes the loop: a lesson you taught is
read by a gate at the moment it applies, and — once you ratify it — **refuses the action**.

- **`lesson-gate.mjs`** — a gate asks the store "what applies right now?" and gets your own words
  back, with the evidence and how many times you had to say it. Wired into the real pre-push gate.
- **`lesson-ratify.mjs`** — see every lesson, ratify it, or delete it. **Demotion is sticky**: it
  survives every future mining run, because a reject the nightly quietly undoes is worse than none.
- **The model cannot ratify its own rules.** Lessons it inferred about itself are quarantined and
  can never block, no matter what is asked of them — closing an injection path an adversarial
  review found, where a hallucinated session summary could have become a blocking gate.
- Proven end to end: before ratification the ship gate informs (exit 0); after ratifying the
  version-discipline lesson it **refuses** (exit 1). Same wire, no code change — enforcement is data.

<details>
<summary><b>Earlier &#8212; what 3.6 shipped</b> &#183; it could finally show you what you own. <i>Expand.</i></summary>

## 3.6 — it can finally show you what you own

**Shipped 2026-07-22.** 3.5 made the brain speak. 3.6 makes it *legible*: a console panel that
answers the question the owner has been asking for weeks — **"what is actually turned on?"**

- **Eleven capabilities, each ON / OFF / UNKNOWN**, every state *derived* from a real check on your
  machine at render time. `UNKNOWN` is a first-class state and is visually separated from `OFF` in a
  non-colour channel, because collapsing the two is precisely the lie this release exists to kill.
- **A one-line plain-English "what it buys you"** on every row, and the evidence we observed.
- **Settings that are conservative by construction.** Each setting declares which of its *values*
  escalate beyond the current project, and `default ∉ escalates` is asserted as a test — so the rule
  holds for settings added later instead of relying on a comment nobody re-reads.
- **A false alarm found and killed.** 3.5's audit reported *"26 learning hooks installed and every
  one is switched off."* That was wrong: `ruflo hooks list` renders a table column keyed `enabled`
  against a payload that has no such key, so it prints "No" 26 times. The learner had 457
  trajectories and had adapted 106 minutes earlier. We scraped a human-readable table instead of
  reading state, which is the exact mistake this project keeps writing rules about. The detector now
  reads the learner's own state file and **stays silent when it cannot tell** — ADR-028 fixes the
  false-alarm rate at zero and calls it non-negotiable.
- **Three surfaces that were built and never wired** are now connected. `capability-registry.mjs`
  had zero call sites; the client referenced it only in comments. Built-tested-unwired is this
  project's signature failure, and it happened three times in one night.

Honest limit: this is still a dev release, **not 4.0**. 4.0 requires levels 3–5 of ADR-028's ladder
(contextual, anticipatory, compounding) **shipped and independently graded ≥95**. The mechanisms now
exist — L3's delivery seam (the chokepoint), an L4 goal surface, and L5 cross-project promotion (lessons
promoted to your global brain, and survival across `--update` is now *tested* rather than argued —
`tests/unit/promoted-lessons-survive-update.test.mjs` runs the real updater against a sandboxed HOME
and asserts the promoted block is byte-identical afterward) — but the ladder still grades **L2–L3**,
because L3 is built rather than live (deploy-gated) and the five acceptance metrics aren't all measured.
See `docs/4.0-READINESS.md` and `docs/4.0-EXECUTIVE-BRIEFING.md` (last independent grade: 70/100 overall).

<details>
<summary><b>Earlier &#8212; what 3.5 shipped</b> &#183; it stopped waiting to be asked. <i>Expand for the receipts.</i></summary>

## 3.5 — it stopped waiting to be asked

**Shipped 2026-07-22.** For three weeks this thing had indexed rUv's entire learning stack — ReasoningBank, SONA, MoE, the ADR-174 distillation pipeline — and could have answered any question about any of it. It never once said the only sentence that mattered:

> *"Your learning system is installed, and it is switched off."*

Stuart found it himself. The measurement: **1,884 captured events sat undelivered** while the learner held 5 trajectories and hadn't trained in six days. Draining the queue took it to 412 in one command. Three weeks of learning had been sitting there, available for the asking, and nobody knew to ask.

**That gap is the product.** A brain that waits to be asked is a search box with good manners. 3.5 is the version where it speaks first.

- **It now tells you what you own and aren't using.** On the author's machine, unprompted, from a real scan: *"36 project stores are embedded but have never been distilled — 6,858 memories sitting in those stores, teaching nothing."* Every recommendation is built from what was actually **observed on your machine** — never a hardcoded list of cool features, which would rot the week rUv ships again.
- **Detection without a remedy is now structurally impossible.** The console used to detect a corrupt memory store, score it 49/100, render it into a card, and offer nothing. Stuart's verdict: *"the fact that it didn't recommend a fix is unconscionable."* Every recommendation now carries evidence, a cost, a plain-English impact, and a **real, tested undo** — enforced by a factory that throws, not by a code review that can be skipped.
- **It stopped lying in four specific ways.** It claimed `ruflo` wasn't installed to anyone whose npm prefix wasn't the author's. It answered *"nothing to undo"* about a database repair for which it held a backup. It reported a distillation that wrote 684 patterns as having done nothing (the check used a read-only connection that can't see another process's WAL). And its installer threw away the stderr that explained every crash — so a missing module and a slow download looked identical. All four found by running the thing rather than trusting it.
- **Every offered fix is provably runnable and reversible.** The remedy registry makes the id→executor→inverse binding a single value, and a closure test drives the real builders to prove nothing can be *offered* that cannot be *run* and *undone*. It found that this ADR's own headline recommendation had **no executor at all** — it rendered as a button that answered "Unknown recommendation id." Proven to fail on both known-bad cases before being trusted.
- **It stopped writing into your repos** ([#36](https://github.com/stuinfla/ruvnet-brain/issues/36)) and **stopped hiding the error that explains a failure** ([#37](https://github.com/stuinfla/ruvnet-brain/issues/37)) — both reported by users, both fixed at root cause, with an upstream report filed to rUv for the two bugs that turned out to be his.

The honest limit: this is **3.5, not 4.0**. The advocacy surface is live and the engine behind it is proven, but score-delta alarms aren't built and ADR-027 has not yet survived its own required adversarial review. A major version marks the release where the product becomes a different thing to the person using it. This is the release where it starts talking.

<details>
<summary><b>Earlier &#8212; what 3.4 shipped</b> &#183; the invisible work, made visible and readable. <i>Expand for the receipts.</i></summary>

## 3.4 — the invisible work, made visible (and readable)

**Shipped 2026-07-17.** 3.3 made every card lead with a point. Then Stuart looked at the two pages meant to *teach* the stack and scored them 55/100: the graphics were mediocre, the one page that should show how the pieces fit was a wall of text, and two diagrams were literally unreadable. 3.4 is the fix — the harness's invisible work, finally drawn, and drawn so you can actually read it.

- **The animation that shows the whole argument** — one prompt, sent two ways. Plain Claude Code: a bare wire to one expensive model, no grounding, no memory, no gates. The same model **wrapped in the harness**: it grounds the prompt, routes it to the cheapest model that can do the job, hands back what your project already decided, **inspects the write and can refuse it**, and checks it on the way out. The left lane finishes first — and that's the problem.
- **MetaHarness, as a picture** — the old card was rectangles with words in them. It's now the thesis at a glance: the model a **frozen** cyan crystal that never moves, seven policy surfaces evolving in a warm orbit around it, the kept branch merging back and the pruned one dying mid-air. *Freeze the model, evolve the harness.* Per agentic-flow's ADR-076: 28.5% cheaper at 98.1% bar-compliance.
- **Diagrams you can actually read** — two of them shipped with labels rendering at **8px and 3px**: present, un-clipped, and invisible. An SVG sized in one coordinate system, crushed into a narrower column, silently shrinks its own text and no error ever fires. There's now a gate for exactly that (`scripts/check-legibility.mjs`) — it measures the *effective* pixel size in the live page, proven to catch the known-bad case before it was trusted. Every diagram label now clears 12px on a phone.
- **The tips page has a door** — its only link wore the same style as a status readout beside it, and on a phone was hidden entirely — the page was **unreachable under 640px**. There's now an unmissable button where it belongs.
- **Real generated imagery** — three commissioned stills built from the console's own palette, so they belong to the page instead of sitting on top of it.

<details>
<summary><b>Earlier &#8212; what 3.3 proved</b> &#183; it stopped reciting facts and started making a point. <i>Expand for the receipts.</i></summary>

## 3.3 — it stopped reciting facts and started making a point

**Shipped 2026-07-17.** 3.2 made the stack visible. Visible turned out not to be the same as *useful*: the console could tell you 21 things and leave you no smarter. Stuart, looking at his own product: *"I have no idea what message it's supposed to tell me… it seems to be facts without purpose."* 3.3 is the answer to that — every card now leads with a **verdict**, not a census.

- **A second page — [how to actually use this](console/tips.html)** — the question nobody could answer: *there are plugins, there are commands, and there's just… typing. Which am I supposed to use?* One page, three depths, and the first depth is **doing nothing**. Built on rUv's own doctrine: *"I don't have to load 350 skills that 99% of which I never use — the system is smart enough to know which one this task needs."*
- **MetaHarness, explained where you decide** — the card asked you to switch on a word you'd never seen. It now shows the architecture instead: the model **frozen** at the centre, seven policy surfaces evolving around it, four pillars underneath. rUv called this exact risk in ADR-076 (*"'Meta-harness' is a newer term… must define it in the first screen so it doesn't read as jargon"*); we'd shipped the jargon and skipped the mitigation. Every element traces to an accepted ADR.
- **The wiring card was lying to you** — it warned about 21 npx call sites. 18 were inside *clones of rUv's own repos* (one a `tests/init-test` fixture), and two were `echo` strings printing advice. Real exposure: **zero**. It now says so: *"Every rUv tool here resolves to one known version."* A card that shows amber for a problem you don't have is worse than no card.
- **The money leads** — the router card buried *$15.17 saved* as the dimmest text on the row while `FRONTIER — 0` read like missing data. It's the punchline: the expensive model never had to fire. Now it says that, in that order.
- **What caught Claude** — a new card. 21 gates read every move before it lands; 6 can stop one. The walls now record what they *catch*, not just what they pass — because the ledger held 13 receipts, 13 passing, while the design wall had refused a commit minutes earlier and written nothing down.
- **The console loads in 0.2s** (was ~14s) — a fleet-wide scan of 107 memory stores sat on the critical path of first paint. It hydrates late now.

</details>

<details>
<summary><b>Earlier &#8212; what 3.2 proved</b> &#183; the invisible stack, made visible. <i>Expand for the receipts.</i></summary>

## 3.2 — the invisible stack, made visible

**Shipped 2026-07-16.** rUv's tools do their best work invisibly — which meant nobody could see them working, working stale, or working in conflict. The 3.x line makes the machinery visible, and everything it shows you is measured, never projected.

- **A living console** — `/rvbc` puts your whole stack on one page: what's installed, how it's wired, what your AI learned. Every warning arrives paired with a one-click, undoable fix, and the page re-checks itself after every change so you always see the *after* state.
- **Your brain, visible** — a live **Brain Activity** card: every memory stored, every lesson distilled, clickable down to the verbatim task → what-failed → what-works cards from your own AgentDB (ADR-0018).
- **Receipts, not estimates** — the routing dashboard recomputes from real routing receipts against *your* frontier; subscriptions price at $0; a providers row shows exactly which license pays for what.
- **No model fact ships from memory** — the 3.0 live-verification wall: every model/version claim checks the live catalog in CI (ADR-0016), and router profiles self-optimize from rUv's bench plus live prices (ADR-0015).
- **It learns YOU** — a recursive per-user learning loop (ADR-017): patterns from how you actually work, shared across your projects, isolated where they must be.

![The RuvNet Brain Console — your invisible AI stack, made visible: live Brain Activity card, real memories and lessons, one-click reversible fixes](assets/console-v31.png)

**Open it any time with `/rvbc`** (RuvNet Brain Console) — and the first time you load the Brain, it offers to open it for you.

> New gate with this release: **narrative versions are tested.** If any public page says "What's new in X" where X isn't the shipping version, CI fails — because this README sat on 2.5 while 3.1 shipped, and nobody's eyes are a gate.

</details>

<details>
<summary><b>Earlier &#8212; what 2.5 proved</b> &#183; it uses rUv's real tools (a CI gate makes silent hand-rolls impossible), every scheduled job must prove it ran, and no subagent inherits an expensive model by accident. <i>Expand for the receipts.</i></summary>

## 2.5 — the receipts

**Shipped 2026-07-13. Two hard lessons, both fixed at the root.**

### 1. It stopped faking rUv's tools — and now a CI gate makes faking impossible

The 2.4 router was **hand-rolled**: our own heuristic with a placeholder policy, presented as "the MetaHarness router." rUv had already shipped the real thing. 2.5 replaces it with **[`@metaharness/router`](https://www.npmjs.com/package/@metaharness/router)** — his actual learned cost-optimal router (k-NN over labelled embeddings, the productized DRACO Phase-2 finding, ADR-040/043).

Our code now does **one honest job**: a price transform. A model your subscription already covers becomes `costPerMTok = 0`, and rUv's router does the rest natively — a $0 model that clears the quality bar simply *is* the cheapest sufficient candidate. Cost-optimal routing and "already paid for" compose; they never competed.

> **`npm run substitution:check`** — a new CI gate that fails the build if any code implements a capability rUv already ships *and* wears his name without either using the real package or openly disclosing the hand-roll. **Verified to fire on the exact commit where we got this wrong.** You may hand-roll. You may never hand-roll *silently*.

### 2. Every scheduled job must PROVE it ran — silence is no longer health

`launchctl` reports **exit 0 for a job that has never run** — byte-identical to success. So "check the exit code" cannot tell triumph from total absence, and a nightly job sat unfired for its entire life while every surface read green.

- **A registry** (`config/scheduled-jobs.json`) of what *must* run — so unloaded, deleted, or never-fired is a **violation**, not a silence.
- **A wrapper** every job runs through — start receipt, end receipt, real exit code, urgent phone push on failure. Break-tested through all four death modes (including SIGKILL, which no trap can catch — the watchdog catches that one).
- **A watchdog** that treats *absence of evidence as failure*, and which is **in its own registry** — because a supervisor nobody supervises just moves the blind spot up one level.

Result: **11 jobs supervised, every one producing a fresh successful receipt.** One had been *totally blind* — writing zero bytes on a healthy day, so "ran fine" and "never ran" were indistinguishable. Cured without changing a line of its logic.

### 3. A subagent can no longer inherit your expensive model by accident

**A subagent inherits your session's model unless something says otherwise.** Ten agents on an Opus session are ten Opus agents; on a Fable session that's `$10/$50` per Mtok — up to **10× what the same mechanical work costs on Haiku**. That single default was the biggest cost leak in the harness, and an advisory rule did not fix it (the router's entire first life saved **$0.018**).

So 2.5.1 makes it a **wall, not advice**: a `PreToolUse` gate that **blocks any subagent dispatch that doesn't declare a `model`**, tells you which tier the task actually needs, and logs every allowed dispatch so routing is *auditable* rather than merely claimed. Forks still inherit — that's what a fork is.

> **`npm run falsify`** — the adversary. Every question that had to be asked of this project ("is the nightly *actually* running?", "is that really rUv's code?", "why is my quota still burning?", "is CI *actually* green?") is now a check that fails on an **unproven claim**, not merely on broken code. Because tests you wrote yourself passing is circular evidence.

![MetaHarness routing — your subscriptions first, always](assets/diagrams/router-path.svg)

</details>

<details>
<summary><b>Earlier &#8212; what 2.0 proved</b> &#183; the release where the brain stopped taking its own word for anything: 69 verified repos, a 120-question fail-closed eval gate, ~90% cheaper per-turn injection, and an 8-dimension evidence-backed scorecard (55 &#8594; 83 in two days). <i>Expand for the receipts.</i></summary>

### 2.0 — the receipts

**2.0 is the release where the brain got bigger — and, more importantly, stopped taking its own word for anything.** Every number below regenerates from an artifact on disk; the claims ledger (`node scripts/claims-verify.mjs`) re-checks the advertised ones in CI:

| | v1 (0.x–1.x) | v2.0 |
|---|---|---|
| **Corpus** | 24 repos built | **69 repos** built (of 248 in the org), each verified by a live retrieval query |
| **Depth** (flagship `ruvector`) | 18,491 passages · **0** full source bodies | **28,018 passages · 2,996 full bodies** — depth also restored to `agent-harness-generator` (8,896/715), `ruview` (7,434/765), `open-claude-code` (195/69) |
| **Corpus QA gate** | none | every store must prove *embeds correctly + reads correctly* — vector count == passage count, depth floors, a 3-passage self-retrieval round-trip per store — **72/72 store-variants PASS**, wired fail-closed into the nightly publish |
| **Retrieval eval** | 12 frozen questions | **120 frozen, hash-pinned questions** across 5 strata; promotion gated on Wilson lower bounds, fail-closed — it blocked a real release this morning, which is the feature working |
| **Token cost** | 6,183 bytes injected per hook turn · zero self-measurement | **684 bytes (~90% cut)** with an eval-PASS proving zero quality loss · a live token meter measuring real bytes/tokens per prompt class · ~27% faster repeat queries via the KB cache |
| **rUv's gists** | not indexed | **444 gists** indexed with per-chunk freshness/provenance banners, refreshed nightly with cost-disciplined skip |
| **Reliability** | claims were prose | **claims ledger** (6 marketing claims mechanically re-verified in CI) · integration tests in CI incl. Linux · a Windows CI job · an honest coverage denominator (all source files) |
| **Autonomy** | hooks asked questions to an empty room — the #1 real-user complaint | **`/loop` contract** — checkpoint / resume / done-criteria; hooks detect autonomous mode and stop asking — 10 mutation-verified tests |
| **Publishing** | manual npm token · a nightly release PATH bug | **self-renewing npm token** (launchd daemon, proven end-to-end) · PATH bug root-caused and cured |
| **Memory layer** | silent SQLite corruption · searches returning 0 · invisible flywheel patterns | **3 root-caused fixes** (an ABI-mismatched binary falling back to WAL-blind whole-file overwrites; keys that were never scored; a split-store display bug) — plus **6 exact patches queued upstream to ruflo** |

The depth jump wasn't tuning — it was two pipeline root-causes fixed for good: missing `--full` hints, and a day-one `v2/` skip-dir bug that had made two repos undepthable since the first build.

### The scorecard — 8 dimensions, self-scored /100, every deduction evidenced — 2026-07-10 (evening re-score)

| Dimension | v1 (2026-07-09) | v2.0 (2026-07-10) | Δ | What moved it |
|---|---:|---:|---:|---|
| End-user experience | 54 | 83 | +29 | One-command install now offers nightly self-updates (default yes); the page lives on isovision.ai; publishing renews itself |
| Knowledge corpus | 71 | 88 | +17 | 24→69 verified repos; a 72/72 embeds-and-reads QA gate; full source depth restored — flagship went 0→2,996 source bodies |
| Effectiveness (eval-proven retrieval) | 58 | 88 | +30 | 120-question Wilson-bound gate — it blocked a bad release, then passed the fix *above* the old baseline |
| Acting like rUv | 38 | 72 | +34 | Memory layer root-caused and fixed with proofs; 6 exact patches queued upstream; real multi-agent swarm operations |
| Developer smarter | 62 | 84 | +22 | `/brain-score` runs this same scorecard on any repo; honest tool announcements; per-answer source receipts |
| Token cost efficiency | 41 | 82 | +41 | ~90% smaller per-turn injection, eval-proven free; a live token meter — measured, not guessed |
| Engineering reliability | 61 | 86 | +25 | 312 tests green; a claims ledger re-verifies marketing claims in CI; fail-closed publishing; Windows CI added |
| Safety & privacy | 74 | 82 | +8 | Private-store fence held under full rebuild; secrets never transit chat; autonomy hard fence |
| **Overall** | **55** | **83** | **+28** | — |

These are self-scores under a hard rule: **every deduction requires specific evidence, and a known architectural flaw caps a dimension at ≤70 until the flaw is fixed** — *acting like rUv* spent the morning capped for its memory-layer flaw; the flaw was root-caused and fixed with proofs, the cap lifted, and it re-scored 72. Overall **55 → 83 in two days**, each number regenerating from a stored receipt — and the same scoring that produced these blocked a release mid-day. **That's why they're credible: scores you can trust beat scores that flatter.**

</details>

**The honest small print, kept visible:** warm query is ~21 s on the large corpus (it grew with depth; candidate dedup/pruning is the next optimization) · the 8 newest repos are findable by name but don't yet have primers/capability cards for described-need routing (coming) · the Windows CI job is new and unproven until its first green run.

---

## The one thing to understand first

**Reuven Cohen (rUv) builds about nine months ahead of the state of the art.** His RuvNet building blocks — Ruflo, RuVector, AgentDB, agentic-flow, SPARC and ~20 more — are the working prototypes of what becomes mainstream AI tooling three quarters later. This is the actual front edge.

But **Claude was trained on _classical_ software development.** Point it at rUv's stack and it doesn't recognize the work: it drifts, it _doubts real capabilities_ (“ruflo can't edit files,” “RuvNet has no vector DB — use Pinecone”), and it quietly falls back to the patterns it knows (pgvector, LangChain, a hand-rolled cosine loop). A newcomer gets the **worst of both worlds** — a revolutionary toolset with no instruction manual, _and_ an assistant that talks them out of using it.

> **RuvNet Brain is the missing instruction manual.** It reads rUv's real source, hands Claude the _answer key_, and removes Claude's permission to make things up about the stack. Install it once, aim it at any repo, and a newcomer can build ~9 months ahead — without being rUv.

The novelty is **structural grounding, not plain retrieval.** Plain RAG only decides what to _add_ to context. This ships a `UserPromptSubmit` hook that injects a grounding directive on **every** RuvNet-relevant turn — the harness consumes that stdout structurally, so the directive is _always present_, not a decline-able suggestion. It's a **strong, always-on nudge** — Claude is pointed at the real source and told to ground before asserting on every relevant turn — not a hard block on the model's output. (That describes the *grounding* hook. Separately, a few `PreToolUse` gates **can** block a call — opt-in (model-router profile), repo-scoped, or path-scoped to the brain's own consent switch — and all fail open; [SECURITY.md](SECURITY.md#what-runs-automatically-and-when) lists every hook and whether it can block you.) **RAG decides what to add; this makes grounding the default the model has to actively argue its way out of.**

---

## The problem it solves

You know the failure mode. You ask Claude to build with Ruflo or RuVector, and instead of reading rUv's actual code it reaches for its training priors: _“let's just use pgvector,” “I'll hand-roll cosine similarity,” “I don't think ruflo can edit files.”_ It skims, it guesses, it doubts tools that work perfectly well — and the result drifts **off** the very stack you chose.

![The drift problem, before and after RuvNet Brain](assets/diagrams/drift-before-after.svg)

<details><summary>ASCII version (for AI / accessibility)</summary>

```
WITHOUT the brain — drift          |   WITH RuvNet Brain — grounded
                                   |
 You: build with Ruflo/RuVector    |    You: the same request
            |                      |              |
            v                      |              v
 Claude falls back to priors       |    Enforcement hook grounds the turn
            |                      |              |
            v                      |              v
 "just use pgvector"               |    search_ruvnet -> cited rUv source
 hand-rolls cosine similarity      |    (whole files, labeled repo + path)
 "ruflo can't edit files"          |              |
            |                      |              v
            v                      |    Builds ON the stack (RVF/HNSW, swarms)
 Drifts OFF the stack              |
```

</details>

---

## Install — one line

```bash
npx ruvnet-brain
```

That single command runs the whole setup, narrating _what it's doing and why_ at each step: it downloads the brain from the [latest GitHub Release](https://github.com/stuinfla/ruvnet-brain/releases/latest), unpacks it to `~/.cache/ruvnet-brain/kb`, installs its local reader (no cloud calls, no API keys), and wires the Claude Code plugin — the `search_ruvnet` MCP tool + the `UserPromptSubmit` grounding hook — at user scope. The installer and the `search_ruvnet` tool run on **macOS, Linux, and Windows**; the grounding/enforcement **hooks are POSIX shell**, so they fire on macOS, Linux, and Windows-via-WSL/Git-Bash (on native Windows without WSL the search tool still works, but the auto-grounding hooks don't fire — a Node port of the hooks is on the roadmap). It's safe to re-run, and the brain itself always fetches the current Release regardless of which install path you use — you install once; you don't keep re-downloading.

> Want the bleeding-edge installer, even ahead of the last npm publish? `npx github:stuinfla/ruvnet-brain` always runs straight off the latest GitHub commit.

> **Anonymous usage counts — opt-in, counts only.** At the end of the install you're asked once: _"Share anonymous usage counts (installs/searches — never your queries or code)?"_ If you say yes, the only things ever transmitted are event counts (`install` / `search` / `session`) plus the bundle version — batched to at most one ping per machine per day. **Never** your queries, code, repo names, or paths; the entire client is one readable file (`kb/telemetry-ping.mjs`). Your answer is a plain-text file you can read or flip any time (`~/.cache/ruvnet-brain/.telemetry-consent`), and `npx ruvnet-brain --no-telemetry` declines without being asked. Found it useful? [Star the repo](https://github.com/stuinfla/ruvnet-brain) or [leave feedback in Discussions](https://github.com/stuinfla/ruvnet-brain/discussions).

<details><summary>Manual install (what the one-liner automates)</summary>

```bash
claude plugin marketplace add stuinfla/ruvnet-brain
claude plugin install ruvnet-brain@ruvnet-brain --scope user
```

Registers the `search_ruvnet` MCP tool, the grounding skill, and the `UserPromptSubmit` enforcement hook — globally, at user scope. The plugin expects the brain at `~/.cache/ruvnet-brain/kb` (or point `RUVNET_BRAIN_KB` at your own copy). The first install may show a one-time trust prompt for the hook.

</details>
</details>
</details>
</details>
</details>
</details>

**Then just ask.** _“How does Ruflo orchestrate agent swarms, and what implements it?”_ The hook grounds the turn, Claude calls `search_ruvnet`, and it answers from cited source — down to the function body.

![Install and use, step by step](assets/diagrams/install-and-use.svg)

---

## Staying current — how updates work

You install once. After that, three mechanisms keep you on the current brain without you having to remember an update command.

- **Consent-gated auto-update heartbeat** (the `SessionStart` hook, `plugin/scripts/session-start.sh`). The **first** time the plugin runs on a machine it asks you **once** whether it may keep itself updated in the background — a security-conscious opt-in, because self-update can change the model's own instructions. Your answer is remembered (`~/.cache/ruvnet-brain/.auto-update-pref`) and never asked again. On each session start it does a rate-limited (~15 min) 3s-capped check of the live GitHub `plugin.json`. If a newer plugin version exists **and** you opted in, it downloads it in the background through Claude Code's own trusted marketplace path — but the new version is **staged, not active**: Claude Code only loads plugins at process start, so **this session keeps running the version it started with** until you restart (`claude --continue` brings your conversation right back on the new version). If you declined, it just tells you the command to run. The knowledge bundle is handled more conservatively — **detect + notify only**, never auto-applied, because the bundle isn't cryptographically signed yet and applying it would overwrite executable tool files (SEC-0010 #6).

- **Grounding receipt line** (the `UserPromptSubmit` gate, `plugin/scripts/ground-ruvnet.sh`). When the brain engages on a prompt, the answer ends with one dim line stating what it actually did — either it read rUv's real source and **names the file**, or it says plainly that it didn't:
  `🧠 RuvNet Brain jumped in · cited agentic-flow/docs/adr/ADR-076-reposition-agentic-flow-as-agentic-meta-harness.md · v3.4.18-dev`
  `🧠 RuvNet Brain jumped in · guidance only, no source read · v3.4.18-dev`
  An unearned citation is worse than no citation, so the line may only name a path the tools genuinely returned — and on a prompt where nothing fires, it stays silent rather than manufacture a receipt. The version shown is the one **actually loaded in memory** for this session; if a newer one is staged awaiting a restart, the line says so plainly (`… vX staged, restart to load`). So you never have to wonder whether the brain is on, which version is acting, or whether an answer was grounded or guessed.

- **Nightly publish → `releases/latest` chain** (`scripts/self-update.mjs --publish`, run by the `deploy/com.ruvnet.brain-nightly.plist` LaunchAgent at 03:15). The nightly rebuilds only the repos whose upstream changed, and **if anything was rebuilt** it bumps the product version, cuts a GitHub Release, and advances [`releases/latest`](https://github.com/stuinfla/ruvnet-brain/releases/latest). Plugin and knowledge bundle move under **one** version number, so the heartbeat above picks up both automatically. (The LaunchAgent is not auto-installed — enabling a system scheduler needs explicit owner approval.)

---

## ✨ What the knowledge bundle knows — the stack _down to the code_

Earlier bundles knew only the **docs and architecture**. v0.5 began re-indexing the code-rich repos to **full function bodies**, against each repo's real source layout — so “how is this actually implemented?” returns the implementation, not a summary. The table below is that v0.5 depth jump, kept as the before/after receipt; **2.0 went further still** — flagship `ruvector` alone now carries 28,018 passages and 2,996 full bodies (see the "what 2.0 proved" foldout near the top):

| Repo | Full-body code passages (v0.5) | |
|---|---:|---|
| `agentic-flow` | 296 → **984** | model-routing, ReasoningBank |
| `ruv-fann` | 52 → **779** | ruv-swarm, cuda-wasm, neuro-divergent |
| `qudag` | → **531** | post-quantum crypto core, exchange, MCP |
| `daa` | → **266** | orchestrator, economy, rules, swarm |
| `safla` | 0 → **136** | the metacognitive / self-modification layer |

Plus: the **“take the wheel” behavioral pipeline** (below), a **4-level behavioral test harness**, a build-integrity fix (empty files no longer pollute the index), and the private-store fence that keeps unpublished repos out of the public bundle.

---

## How it works

The expensive work happens **once, at build time**: every covered repo is deep-walked (whole files, full function bodies, plus a symbol index), embedded into **two** vector variants (MiniLM-384 for edge/portability, bge-768 for depth) stored on-disk in **RVF / HNSW**, and distilled into a concepts + capability layer of per-repo primers and cards. That's **150,161 source chunks**. At **query time**, `search_ruvnet` searches every repo's store at once, pools the hits, and runs them through **one cross-encoder rerank** on a common scale — so the truly relevant file wins regardless of which repo it lives in — then returns whole source files, each labeled by repo and path.

![RuvNet Brain architecture pipeline](assets/diagrams/architecture-pipeline.svg)

- **Per-repo RVF stores** — each repo gets its own HNSW graph; the tool queries across them and normalizes.
- **Dual embeddings + cross-encoder** — MiniLM-384 for edge/portability, bge-768 for depth; a single cross-encoder rerank puts every candidate on one comparable scale. (The cross-encoder — a third model reading query+passage together — is the real quality lever, not a fusion of the two embedders.)
- **Concepts / capability layer** — per-repo primers and capability cards let the model ground _capability_ claims and route a described need to the right repo, not just do file lookups.

---

## How it changes Claude's behavior — it takes the wheel

Grounding is **injected every turn, not left to chance.** On a RuvNet-relevant prompt the `UserPromptSubmit` hook injects a directive into context; Claude calls `search_ruvnet`, gets whole source files labeled by repo and path, and answers _from_ them. Because the hook's stdout is consumed by the harness every turn, the directive is _always there_ — a strong grounding nudge on every relevant turn. (It's a nudge, not a hard gate: the hook can't rewrite Claude's output, so it steers rather than blocks — see [ADR-0005](docs/adr/0005-behavioral-grounding-not-lock.md) for exactly what ships.)

![The grounding flow: prompt to cited answer](assets/diagrams/grounding-flow.svg)

And on a **build request**, the brain doesn't wait to be told each step — it runs the process **the way Ruv would**:

> **Propose the architecture first** → one go/no-go → then execute end-to-end: **SPARC** (Spec → Pseudocode → Architecture → Refinement → Completion) · model the domain (**DDD**) and capture **ADRs** · spin up **parallel Ruflo swarms** · persist decisions to **AgentDB** · treat design as a build step (**frontend-design + AI image generation**, never “working but ugly”) · **test → score 1–100 → loop to ≥98** · and it asks for an **API key** when a step needs one instead of silently skipping it.

The downstream effect: Claude **prefers RuvNet building blocks over generic defaults** (RVF/HNSW over pgvector/Pinecone, Ruflo swarms over hand-rolled orchestration) and drives the whole assess → build → verify → score loop rather than answering one question at a time.

---

## Capability-confidence routing

The brain answers **both** kinds of questions. **Name the repo or ask something specific** and it resolves to the right repo (**47/48, 98%**). **Describe a _need_ without naming the repo** — the way a newcomer would — and it still lands the right repo (**26/28, 93%**). That newcomer path used to be the weak spot (**33% before the fix**); adding **capability cards** — a capability-phrased passage per building block — closed the gap.

![Capability-confidence routing](assets/diagrams/capability-routing.svg)

---

## What it covers

69 of rUv's repos in the [ruvnet](https://github.com/ruvnet) org — the reusable **building blocks** you'd actually compose into a system — each deep-walked and embedded in both variants. The core blocks below also carry symbol indexes and capability cards (the 8 newest repos are findable by name; their capability cards are coming).

![The RuvNet stack the brain covers](primer/assets/diagrams/ruvnet-stack.svg)

| Repo | What it gives you | Repo | What it gives you |
|---|---|---|---|
| [`ruflo`](https://github.com/ruvnet/ruflo) | Agent orchestration / swarms | [`ruvector`](https://github.com/ruvnet/ruvector) | RVF + on-disk HNSW vectors |
| [`agentdb`](https://github.com/ruvnet/agentdb) | Agent memory + graph/Cypher | [`rulake`](https://github.com/ruvnet/rulake) | Vector cache layer |
| [`ruview`](https://github.com/ruvnet/ruview) | Camera-free WiFi/CSI sensing (presence, pose, vitals) | [`agentic-flow`](https://github.com/ruvnet/agentic-flow) | Cheap multi-provider model routing |
| [`agenticow`](https://github.com/ruvnet/agenticow) | Copy-on-write agent memory (branch 1M vectors in ~162 B) | [`sparc`](https://github.com/ruvnet/sparc) | 5-phase build methodology |
| [`qudag`](https://github.com/ruvnet/qudag) | Quantum-resistant DAG messaging | [`safla`](https://github.com/ruvnet/safla) | Self-aware feedback loop |
| [`ruv-fann`](https://github.com/ruvnet/ruv-FANN) | Fast neural nets (Rust/WASM) + ruv-swarm | [`daa`](https://github.com/ruvnet/daa) | Decentralized autonomous agents |
| [`synthlang`](https://github.com/ruvnet/synthlang) | Prompt compression (~75% token cut) | [`rupixel`](https://github.com/ruvnet/rupixel) | On-device visual embeddings |
| [`dspy.ts`](https://github.com/ruvnet/dspy.ts) | DSPy-style programmable LLM pipelines in TS | [`fact`](https://github.com/ruvnet/fact) | Fast-Access Cached Tools + circuit breaker |
| [`cve-bench`](https://github.com/ruvnet/cve-bench) | Security-fix benchmark | [`metaharness`](https://github.com/ruvnet/metaharness) | Harness scaffolding / metaharness |
| [`rvm`](https://github.com/ruvnet/rvm) | Proof-gated capability microhypervisor | [`rUv-dev`](https://github.com/ruvnet/rUv-dev) · [`open-claude-code`](https://github.com/ruvnet/open-claude-code) | Dev workflow + agent tooling |

> **Not in the public brain:** rUv's private **Cognitum One** repos (seed, v0-appliance, platform-docs) are fenced out of the download by design — verified zero-leak in every build. **Helix** (rUv's local-first health app) is a finished product, not a building block, so it's out too.

---

## Testing & proof

Everything below is **re-runnable** — the proof is the output of a command, not a claim.

```bash
bash scripts/gate.sh                              # the pass/fail routing gate
node scripts/behavioral-l1-l4.mjs                 # the 4-level behavioral harness
node plugin/test/run-tests.mjs                    # full plugin QA over real JSON-RPC
```

| Test | Result | What it proves |
|---|---|---|
| **Named / specific routing** | **47 / 48 (98%)** | name the tool → right repo |
| **Described-need routing** | **26 / 28 (93%)** | describe the need, no name → right repo (was 33% before capability cards) |
| **Context-scenario routing** | **7 / 8 (88%)** | full-scenario prompts route correctly |
| **L1–L4 behavioral harness** | **all pass** | route · deep-recall (returns _code_) · implement (cites the API) · orchestrate (the hook drives the full pipeline) |
| **Plugin QA** | **26 / 26** | manifests, hook firing, MCP `initialize`/`tools/list`, capability battery |
| **Clean-room install** | **3 / 3** | download the published bundle fresh → unzip → query → grounded, cited answers |
| **Unit tests** | **1,832 passing, 169 todo** · 28% of ALL source covered | `npm run test:cov` regenerates both — the coverage floor fails CI if it slips (`claims:verify` re-derives the %, it is not a hand-typed badge). 28% is the honest number over every shipped file; the previous "75%" measured a hand-picked 8-file subset |
| **Grounding proof** | `npx ruvnet-brain --doctor` | asks a real question, then checks the cited path really exists in the on-disk store; a citation that doesn't resolve is reported as **NOT grounded** |
| **Held-out eval** | **grounded 100/100** · routed 63/80 | `npm run eval` — 120 frozen, hash-pinned questions across 5 strata, never used for tuning, graded on ground truth, never by a model |

<sub>The suite also carries **169 `it.todo` stubs** — a written backlog, each naming an untested behavior and what it would take to cover. They are deliberately **not** counted as tests: a stub proves nothing, and a number that flatters is worse than no number.</sub>

Two honest residuals, not hidden: one described question (_“route to cheaper models to cut cost”_) routes to `open-claude-code` instead of `agentic-flow`; one _“methodology”_ question routes to `agent-harness-generator` (in `PROOF.md`) or `cognitum-cogs` (in `HELIX-DEMO-NOHELIX.md`) instead of `sparc`/`ruflo`. Proof reports land in [`PROOF.md`](PROOF.md), [`DESCRIBED-PROOF.md`](DESCRIBED-PROOF.md), and [`HELIX-DEMO-NOHELIX.md`](HELIX-DEMO-NOHELIX.md).

### The eval flywheel

Most of the numbers above were tuned against. [`evals/held-out.json`](evals/held-out.json) was not: **120 frozen, hash-pinned questions across 5 strata** (named, described, scenario, adversarial, provenance), phrased the way a newcomer would ask, each with the owning repo chosen **from first principles before the brain ever saw them**. `npm run eval` scores, among other things, two claims — both without asking a model's opinion:

- **grounded** — the cited passage genuinely exists in the on-disk store. A path that doesn't resolve is a *fabricated* citation, and is counted as a failure however plausible it reads.
- **routed** — the citation came from a repo that actually owns the capability.

`npm run eval:gate` fails the build (exit 1) if either score drops below [`evals/baseline.json`](evals/baseline.json) — and also if there is **no baseline at all**, since you cannot promote against nothing. Baselines are only ever written deliberately, with `npm run eval:record`; a baseline that silently follows the code is a ratchet with no teeth.

**Why not let an LLM grade it?** Because on this very repo an LLM panel scored a **zero-citation answer 98/100**. Model-as-judge is blind to the one failure that matters here.

Current baseline (n=120, [`evals/baseline.json`](evals/baseline.json)): **grounded 100/100 · routed 63/80 · abstain 18/20 · banner 20/20**, promotion gated on Wilson lower bounds. The routing misses are recorded, not tuned away — the recurring shapes: `"generate tests and find coverage gaps"` cites agentic-qe's real test generator, which lives *vendored inside the ruflo repo*, so the answer is right and the repo label is a corpus-attribution artifact; `"spend less money on model calls"` cites a genuine `agentic-qe/docs/guides/cheaper-model-eval-lanes.md`, the same cost/orchestration overlap noted above.

**Query it directly (CLI):**

```bash
cd kb
export KB_MODEL_CACHE=/path/to/models-cache
node forge-ask-all.mjs --dir . --q "How does RuVector implement HNSW vector search?" --k 3
```

> Cross-repo answer quality **requires the cross-encoder**, which requires `npm i` in the bundle. Without it, search falls back to raw vectors and ranks poorly.

---

## Honest status

This project versions in the open (see the live badge up top for the exact plugin version; the downloadable knowledge bundle is a separate track) — we don't claim “done,” “complete,” or “zero hallucinations.” Where it stands:

- ✅ **The grounding brain is real and proven** — 62 public stores · 150,161 public source chunks (69 built stores incl. private), dual embeddings, cross-encoder rerank, plugin (MCP tool + enforcement hook + skill), all re-runnable.
- ✅ **Code-level depth** — the code-rich repos are indexed to full function bodies; “how is it implemented?” returns the implementation. Verified in the shipped bundle (clean-room 3/3).
- ✅ **Routing holds** — named 47/48, described 26/28, scenario 7/8; behavioral L1–L4 all pass; private stores fenced out of the public bundle (zero-leak verified).
- ⚠️ **Two routing residuals** (above) — surfaced, not hidden.
- ✅ **Published on npm** — `npx ruvnet-brain` (short form); `npx github:stuinfla/ruvnet-brain` always tracks the latest commit if you want it even fresher.
- ✅ **Every automatic hook is documented** — [SECURITY.md](SECURITY.md#what-runs-automatically-and-when) lists each one, what it reads, and whether it can block a turn. Most are advisory; the gates that *can* block are opt-in (model-router profile) or scoped to this repo, and all fail open.
- ⏳ **The fully-autonomous engineering loop** ([ADR-0008](docs/adr/)) — the behavioral hook injects the loop CONTRACT (assess → SPARC → ADR/DDD → QA → score); the fully-autonomous loop is ADR-0008's open work.

---

## What's in the box

- `kb/` — the brain: per-repo `.rvf` + `.big.rvf` stores, full-passage sidecars, symbol indexes, per-repo primers, the concepts store, and the `forge-*` query tools (CLI + MCP `search_ruvnet`).
- `plugin/` — the Claude Code plugin (MCP server, grounding skill, `UserPromptSubmit` enforcement hook, marketplace manifest, test suite).
- `scripts/` — `gate.sh` (routing gate), `behavioral-l1-l4.mjs` (behavioral harness), `prove.mjs`, `build-bundle.mjs`, `brain-stamp.mjs`.
- `docs/` — [`VISION.md`](docs/VISION.md) (the why), [`adr/`](docs/adr/) (locked decisions incl. ADR-0008), [`DDD.md`](docs/DDD.md).
- `explainer/` — the source of the [live explainer](https://isovision.ai/ruvnet-brain/).
- `SPEC.md` · `PROGRESS.md` — the master spec and the living, timestamped build log.

The brain binaries ship via the [Release](https://github.com/stuinfla/ruvnet-brain/releases/latest), not git — a fresh clone is lightweight; `npx` fetches the full bundle.

---

## Community

- **Tell us how it went — one command:** `npx ruvnet-brain --feedback` prefills a [Discussion](https://github.com/stuinfla/ruvnet-brain/discussions) with your version + a 3-line health summary (you see exactly what's in it; never your queries, code, or paths) and opens it in your browser.
- **Questions, ideas, show-and-tell:** [Discussions](https://github.com/stuinfla/ruvnet-brain/discussions) · bugs go to [issues](https://github.com/stuinfla/ruvnet-brain/issues) — new issues and PRs page the maintainer's phone in real time, so first response is typically within 1 business day.
- **Contributors get credited:** merged PRs land in [`CONTRIBUTORS.md`](CONTRIBUTORS.md) — the two-signal hook gate and the `/brain-build` contract both started as user field reports. House rules: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md); build/test map: [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Links

- **▶ Live explainer:** https://isovision.ai/ruvnet-brain/
- **Download / Release:** https://github.com/stuinfla/ruvnet-brain/releases/latest
- **rUv's RuvNet org:** https://github.com/ruvnet
- **Built by:** [Stuart Kerr — Isovision.ai](https://isovision.ai)

<div align="center"><sub>MIT licensed · free & fair use · grounded in rUv's real source, cited every time.</sub></div>
