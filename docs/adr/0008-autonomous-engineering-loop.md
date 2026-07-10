---
id: ADR-008
---
# ADR-0008: The autonomous RuvNet-native engineering loop (the build product on top of the brain)

**Status**: Accepted (2026-06-28)
**Updated**: 2026-07-09 — the loop CONTRACT is now implemented via ADR-0011 Phase 1: autonomy gate in ground-ruvnet.sh (no-halt override, resume-first, hard fence) + scripts/loop-checkpoint.mjs (machine-checkable done-criteria, two-strike no-progress, atomic checkpoints). Full autonomous build-test-score loop remains open.
**Date**: 2026-06-28

**Origin:** Stuart's "real definition of success" (2026-06-28) — the brain
(ADR-0001..0007) is the grounding floor; this ADR is the *building*. **Grounded via the brain itself**
(`search_ruvnet` / `forge-ask-all`) against real RuvNet source — paths cited inline.

## Context
The shipped brain (`dist/ruvnet-brain.zip`) makes Claude *answer* about RuvNet from real source and stop
doubting capabilities (capability gate 45/45). But the real goal is bigger: a drop-in that, given a request or
an ADR, makes Claude Code **autonomously architect → build → test → score 1–100 → loop to ≥98 → ship with
visuals**, using the full RuvNet stack, **without stopping or drifting**. Graded against that bar the current
artifact is ~30/100: the grounding layer is real; the autonomous loop, the brain↔Ruflo wiring, a generalized
app scorer, and a one-command global install do not exist.

The building blocks **do** exist in real RuvNet source (confirmed by querying the brain):
- **Orchestration / swarm sizing** — `ruflo/v3/@claude-flow/codex/.agents/skills/swarm-orchestration/SKILL.md`
  ("3+ files / new features / refactoring" → swarm; "single file / simple fix" → skip).
- **5-phase build methodology** — `ruflo/.agents/skills/agent-sparc-coordinator/SKILL.md` and
  `agentdb/ui/.claude/agents/templates/sparc-coordinator.md` (SPARC: Spec→Pseudocode→Architecture→
  Refinement→Completion, gates between phases).
- **Enforcement hooks** — `ruflo/v3/@claude-flow/mcp/.claude/commands/hooks/overview.md`: `pre-task`
  (auto-spawn agents for complex tasks), `pre-edit` (validate/assign before writes), `pre-bash` (command
  safety), `post-edit` (format + learn) — configured in `.claude/settings.json` via `PreToolUse` matchers
  running `npx claude-flow hook …`.
- **Routing** — `guidance_recommend` (`concepts/ruflo/L2/guidance-mechanism`).
- **Scoring / self-improvement** — `ruvector/docs/metaharness-implementation-plan.md` (MetaHarness benchmark).
- **Grounding/enforcement primitives already decided** — ADR-0005 (retrieve-and-inject, PreToolUse hard-deny,
  Stop judge, drift-rate SLO).

## Decision
Ship **`ruvnet-engineer`** — a Claude Code plugin (npm-global / marketplace) that, on install, wires the brain +
Ruflo + RuVector/AgentDB + hooks + an autonomous build-verify skill into a single drop-in. Seven decisions:

1. **Two roles, wired — Ruflo *decides*, Claude Code *acts*, the brain *grounds*.** Architectural constraint:
   Ruflo's `agent_execute` is a stateless reasoning call and **cannot touch files**, so it plans/architects/
   sizes-the-swarm/routes (via `task_orchestrate`, `guidance_recommend`, the SPARC coordinator), while Claude
   Code **Task subagents** do all file/build/test work. Every RuvNet decision on both sides is grounded by
   `search_ruvnet` first. No step invents a capability the brain can't cite.

2. **Autonomous SPARC build loop.** A bundled skill (`autonomous-build`) runs request/ADR →
   **S**pecification → **P**seudocode → **A**rchitecture (Ruflo architect + swarm sizing) → **R**efinement
   (implement + the score loop below) → **C**ompletion, with a quality gate between phases. Models the real
   sparc-coordinator. "Don't stop to ask" applies *within* the loop.

3. **Generalized verify→score→loop-to-≥98 engine** (`brain-score-loop`). Generalizes the proven KB grader
   (`brain-grade-groundtruth.mjs`) + RuVector MetaHarness to *arbitrary built apps*: scores each artifact
   1–100 on a task-appropriate rubric (correctness, tests-pass, security/AIMDS, performance, **visual/UX**,
   RuvNet-idiom), 3-vendor + mechanical checks (build passes, tests green), and **loops** (diagnose→fix→
   re-score) until **≥98 or a budget cap**. Same measure→diagnose→fix→re-measure discipline that took the
   capability gate 84→100 this session. Ungrounded/unverified gains are rejected (ADR-0002 carries over).

4. **Enforcement = ADR-0005 hooks, IMPLEMENTED, plus pre-task orchestration.** Install into the host
   `.claude/settings.json`: `UserPromptSubmit` retrieve-and-inject (auto-runs `search_ruvnet`, injects real
   source so the agent reasons *from* truth); `PreToolUse` hard-deny (block pgvector/pinecone/chroma/weaviate
   deps + hand-rolled cosine/JSON-embeddings when an RVF path exists); `pre-task` auto-spawn for complex tasks;
   `Stop` semantic judge (re-open once if a RuvNet capability is dismissed without a citation). Grounding/
   routing become **structural, not optional**. Drift is measured against the ADR-0005 SLO each release.

5. **Auto-visuals as a build step, not an afterthought.** The Completion phase invokes image generation
   (`gen-images.mjs`, gpt-image-1) + the frontend-design discipline to produce the explaining web page /
   diagrams, and the score loop's **visual/UX dimension** gates them (the explainer's ≥90 skeptic bar
   generalized). No "working but ugly/incoherent" ships.

6. **One-command global install + auto-wiring.** A `ruvnet-engineer` package whose `postinstall` (or Claude
   Code plugin manifest) registers the brain MCP (`search_ruvnet` → `forge-mcp-all.mjs`), the Ruflo MCP, and
   AgentDB; drops the hooks into `.claude/settings.json`; and installs the `autonomous-build` skill — so a user
   does one install and is "perfectly set up," no manual MCP paste. The 268 MB brain ships as a fetched asset,
   not inlined.

7. **On-demand stack coverage.** When a task needs a RuvNet repo not yet in the brain, the loop triggers the
   existing `self-update.mjs --include-new --repo <name>` path to deep-walk + embed it, then grounds against it.
   So "download anything else it needs from the RuvNet architecture" is real, not hand-wave.

## Consequences
- **Honest scope:** this is a multi-phase build (plugin + score-loop engine + hooks + skill + installer), not a
  config tweak. The brain is base camp; this is the climb.
- **Autonomy has hard guardrails:** "never stop to ask" covers architect/build/test/score/iterate/visuals. It
  does **not** cover irreversible/outward actions — deploys, secret writes, `git push`, deletions, keychain/
  system mutation — which still require explicit approval (global safety rules + ADR-0005 hard-deny). Autonomy
  ≠ unsafe.
- **Enforcement strength is host-graded** (full on Claude Code, weaker on Cursor/Codex/API), per ADR-0005.
- **Unproven until measured:** that Ruflo's architect actually drives a clean end-to-end build to ≥98 is a
  hypothesis to verify on a real ADR, not an assertion. First proof target: feed this very ADR to the loop.

## Alternatives rejected
- *"The brain alone is the product."* — It's the grounding floor; it neither builds nor verifies. Rejected as
  the success definition.
- *Run the build inside Ruflo `agent_execute`.* — Stateless, no file access; cannot build. Rejected for the
  act-role; Ruflo stays the decide-role.
- *Suggest-don't-enforce grounding (tool description only).* — Paraphrase-evadable / decline-able; drift
  returns. Enforcement must be structural hooks (ADR-0005).
- *Inline the 268 MB brain into the npm package.* — Bloated, slow installs; ship as a fetched asset.
