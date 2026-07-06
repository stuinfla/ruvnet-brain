# RuvNet Brain → RuvNet Engineer — VISION & FULL CONVERSATION CONTEXT

`Captured 2026-06-28 to guarantee ZERO context loss across a project-directory switch. This is the
narrative of the entire conversation that conceived this solution. Read this + PROGRESS.md + docs/adr/
0001–0008 and you have everything.`

---

## 1. What this is (the one-paragraph truth)
A downloadable, source-grounded **brain for the entire RuvNet open-source ecosystem** (rUv / Reuven Cohen's
~248 non-fork repos, ~297 public total) that is becoming a **drop-in autonomous engineering system**. Phase 1 (DONE): make Claude/Codex
answer about RuvNet from Ruv's REAL source code — point to exact files, never skim, never drift to training
priors (pgvector/Pinecone), and **never wrongly doubt what a repo can do**. Phase 2 (NEXT — ADR-0008): turn
that grounded brain into a system that, given a request or an ADR, **autonomously architects → builds →
tests → scores 1–100 → loops to ≥98 → ships with visuals**, using the full RuvNet stack, without stopping or
drifting.

## 2. WHY it matters (the problem we're killing)
Claude Code (and Cursor/Codex) has a chronic, expensive failure mode with RuvNet: it **drifts** to its
training priors, **hallucinates** APIs, **doubts** that a repo can do something it actually can, and **skims**
instead of reading the real implementation. For a Rust-first, ~248-repo ecosystem that Claude's training barely
covers, that makes the assistant unreliable — it second-guesses Ruv's own tools. The brain fixes the
KNOWLEDGE half; the autonomous loop fixes the ACTION half. The end state: **Claude Code builds with the RuvNet
stack as fluently and confidently as Ruv would** — "the ultimate intelligence source" for the ecosystem,
that directs Claude and keeps it on-rails.

## 3. The ULTIMATE definition of success (Stuart's words, 2026-06-28 — this is the bar)
> "This works if and only if I can download it into Claude Code and it can immediately put Claude Code to
> work together with Ruflo, RuVector, and any other things it thinks it needs to download from the RuvNet
> architecture. I can give it a request or an ADR and it can build out the full solution of the code without
> having to stop and ask me. It can verify, validate, test it, know how to score it 1–100 on all the
> important parameters, iterate and loop until it gets to 98 or better, include the right visuals, and build
> far more sophisticated applications that make full and rich use of the entire RuvNet stack. … npm install
> and this drops down globally alongside Ruflo and RuVector … and it never allows Claude Code to hallucinate
> or stop or drift or take it in a different direction. … When you ask a question, Ruflo picks it up, Ruflo
> architects the answer, Ruflo decides how many agents it needs, Ruflo decides the architecture, Ruflo
> decides how to bring in images to explain it, building out the web page, making sure they are effective,
> viable, consistent and working."

**Decoded into the architecture (ADR-0008):** Ruflo **decides** (architect, swarm sizing, guidance, SPARC) ·
Claude Code **acts** (file/build/test via Task agents — because Ruflo's `agent_execute` is stateless and
cannot touch files) · the brain **grounds** every RuvNet decision · a generalized **score-loop** drives to
≥98 · **enforcement hooks** make grounding/routing structural so it can't drift · **one-command install**
auto-wires everything · **visuals** are a gated build step, not an afterthought.

## 4. HONEST grade against that ultimate bar: ~30 / 100 (as of 2026-06-28)
Per the no-inflated-scores rule. The brain (grounding floor) is real and strong; the autonomous loop — the
bulk of the vision — is **unbuilt**. Breakdown: anti-drift grounding 65 (but 19/~248 repos + passive, not
enforced) · drop-in global install 15 · autonomous build-from-ADR 10 · generalized score-to-98 loop 20 ·
auto-visuals 35 · Ruflo-orchestration integration 20. The foundation FOR the product is ~70; the product
itself ~30. **We are at base camp with a proven base; the climb (ADR-0008) is next.**

## 5. What is DONE and PROVEN (Phase 1 — the brain)
- **`dist/ruvnet-brain.zip`** (SHA-stamped, acceptance-tested as a real consumer: unzip → npm i → ask).
- **19 repos loaded** (of ~248): agent-harness-generator, agentdb, agentic-flow, agenticow, cve-bench, daa,
  dspy.ts, fact, helix, qudag, ruflo, rulake, rupixel, ruv-fann, ruvector, ruview, safla, sparc, synthlang +
  a **concepts store** (L2 + primers). ≈75,000 chunks total. The other ~229 are roadmap;
  `scripts/self-update.mjs --include-new` deep-walks any on demand.
- Both embedding variants (MiniLM-384 + bge-768), all reconcile + pass the anti-regression guard.
- **3-vendor ground-truth grade** (the **graded core of 5** — ruflo, ruvector, agentdb, rulake, ruview):
  REAL-USE 63–85, **0 hallucinated citations** on tuned AND held-out sets. Primers now exist for all 19, so
  capability claims are grounded across the full covered set (the other 14 are *covered*, not yet *graded*).
- **★ Capability-confidence gate = 45/45 (100%)** — the "never wrongly doubt a capability" guarantee. Started
  84% (ruflo 4/9); the fix (prose capability primers in the concepts store) took it to 100%. Controls prove it
  also won't INVENT capabilities. KEY INSIGHT: the cross-encoder trusts PROSE that describes a capability but
  under-scores CODE that implements it → prose capability statements are the fix.
- **Cross-repo tool:** `kb/forge-ask-all.mjs` (CLI) + `kb/forge-mcp-all.mjs` (MCP tool `search_ruvnet`).
- **Explainer LIVE & public:** https://explainer-stuart-kerrs-projects.vercel.app
- **Nightly self-update** installed (LaunchAgent, 3:15 AM, safe-scope: rebuilds changed built-repos only).

## 6. What is NEXT (Phase 2 — ADR-0008, tasks #12–#17)
Build the autonomous engineering loop, score-loop engine FIRST (de-risks the hardest claim), then hooks,
SPARC skill, brain↔Ruflo router, the one-command plugin/installer, and the acceptance test (feed ADR-0008 to
the loop and have it build the rest to ≥98). The "never stop to ask" autonomy has HARD guardrails: it never
auto-does irreversible/outward actions (deploy, secrets, git push, deletes, system mutation) — those still
require explicit approval.

## 7. The DISCIPLINE that must carry forward (how we work — non-negotiable)
- **PROVE-IT:** never say "works/done/verified" without running the real command on the actual path and
  showing output. Test the real door. (This session it caught: a nightly that would re-embed 28K chunks every
  night, a 40-repo unattended build, the bundle needing `npm i`, and a "public" URL that was an SSO wall.)
- **No inflated scores:** list each deduction with evidence; known architectural flaws cap ≤70; include
  "what I did NOT test."
- **Measure → diagnose → fix → re-measure:** the only honest route to "perfect" (took capability 84→100).
- **Honest weak points stay visible** (e.g., RuView grades 63 — shown, not hidden).
- **Effectiveness-first, size no constraint; ground-truth citations are the gate of record, not LLM scores.**

## 8. Locked architectural decisions (don't regress — see docs/adr/)
ADR-0001 zip bundle not single file · 0002 ground-truth+multivendor gate · 0003 point-deeper retrieval ·
0004 effectiveness-first · 0005 behavioral grounding via retrieve-and-inject + PreToolUse hard-deny + Stop
judge + drift SLO (the anti-drift enforcement) · 0006 segment-per-repo · 0007 tiered scope (T0–T3) ·
**0008 the autonomous engineering loop (Ruflo decides / Claude acts / brain grounds)**.

## 9. Where everything lives (repo-relative)
`PROGRESS.md` (complete build log) · `docs/adr/` (decisions) · `docs/VISION.md` (this file) · `kb/` (the brain:
per-repo .rvf + .big.rvf + passages + symbols + primers + concepts + forge tools) · `dist/ruvnet-brain.zip`
(the deliverable) · `explainer/` (the deck) · `scripts/` (build/grade/score/self-update tooling). API keys
(OPENROUTER/OPENAI) live in a local `.env` outside this repo (never committed); the model cache is a local
ONNX cache dir set via `KB_MODEL_CACHE`. Neither path is published here (SEC-0010 #12 — no absolute local
paths or secret locations in a public repo).
