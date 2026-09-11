---
id: ADR-080
title: Hybrid Model Routing Strategy for 95/100 North Star Campaign
status: Proposed
date: 2026-09-11
updated: 2026-09-11
authors: [System Architect, Claude, Codex]
tags: [architecture, model-routing, optimization, north-star, campaign]
supersedes: []
relates: [ADR-079, ADR-073, ADR-050, ADR-077, ADR-078]
governs:
  - scripts/model-router.mjs
  - config/model-routing.json
  - .github/workflows/campaign-*.yml
---

# ADR-0080: Hybrid Model Routing Strategy for 95/100 North Star Campaign (W2–W6)

**Status**: Proposed (2026-09-11)  
**Date:** 2026-09-11  
**Authors:** System Architect (Claude + Codex dual-grade)  
**Related:** ADR-0079 (testing gates), ADR-0073 (memory), ADR-0050 (issue automation)

---

## Problem

The RuvNet Brain campaign must reach 95/100 North Star by 2026-09-25 (14 days), lifting all 8 dimensions from a measured baseline of 31/100. With 6 agents working in parallel (W2–W6), the model routing strategy must balance:

1. **Cost vs. confidence tradeoff:** Cheaper models (Haiku, Sonnet, GPT-5.6) are fast but risk gate failures on high-reasoning tasks (advocacy, grounding, security audit). Expensive models (Opus, Fable, Astra) are slow but guarantee gate passage.
2. **Gate risk by dimension:** High-risk gates (advocacy, grounding, docs/honesty) fail on weaker models; low-risk gates (self-improve, dev loop) tolerate cheaper models.
3. **Escalation budgeting:** If a cheaper model fails a gate, escalation to a stronger model costs tokens but saves campaign time.
4. **Independent grading:** All 8 dimensions must be scored by independent reviewers (not self-graded) using top-tier models to ensure 95/100 is credible.

**Prior routing decision (ADR-070):** Documented the agentic-flow CLI as the cheap-model path for read-only work; however, a coordinated campaign with 6 agents requires **coordinated, context-aware** model selection, not just isolated task batching.

---

## Decision

Use **HYBRID ROUTING** across three phases:

### Phase 1 (W2): Setup & Routine Work — Cost-First Priority
- **Researcher:** Opus 5 (primary, high-risk research) + Haiku escalation (low-risk scans)
- **Architect:** Sonnet 5 (design) + Opus 5 (duel if needed)
- **Developer:** Sonnet 5 + GPT-5.6 Terra (code, tests)
- **Tester:** Haiku 4.5 (gap detection) + Sonnet 5 (escalation if semantic ambiguity)
- **Reviewer:** Opus 5 (security audit, non-negotiable)
- **Ops:** Haiku 4.5 (config audit) + Sonnet 5 (escalation if heartbeat logic unclear)

**Phase 1 Budget:** ~$1.2K  
**Phase 1 Confidence:** 65% first-pass on high-risk gates.

### Phase 2 (W3–W4): Hard Gates & Escalations — Goal-First Priority
- **Researcher:** GPT-6 Astra (primary reasoning, #1 on GPQA Diamond) + Fable 5.1 (synthesis, #1 overall) + Opus 5 (verification)
- **Architect:** Opus 5 (primary) + GPT-6 Astra (duel backup for AgentDB state machine)
- **Developer:** Opus 5 (complex refactoring) + Fable 5.1 (final QA)
- **Tester:** Opus 5 + Fable 5.1 (coverage gaps, semantic severity)
- **Reviewer:** Fable 5.1 (audit, content) + Opus 5 (security deep-dive)
- **Ops:** Opus 5 (heartbeat proof-of-correctness, Byzantine logic)

**Phase 2 Budget:** ~$4K  
**Phase 2 Confidence:** 80% on hard gates.

### Phase 3 (W5–W6): Final Proof & Ship — Independent Grading (Expensive but Final)
- **All dimensions:** Reviewed by independent graders (Fable 5.1 + GPT-6 Astra dual-grade).
- **Score published:** Only after independent verification reaches 95/100 across all 8 dimensions.
- **No shortcuts:** Every high-risk gate double-reviewed before ship.

**Phase 3 Budget:** ~$2–3K  
**Phase 3 Confidence:** 95%+ after independent grading.

**TOTAL BUDGET:** $7–9K (hybrid approach balances cost + confidence).

---

## Escalation Rules (Automatic Tier 1)

These trigger without human gate-keep:

1. **Advocacy gate (cite-check fails):** → Re-run synthesis with GPT-6 Astra.
2. **Dev loop (CI fails on first attempt):** → Re-implement with Opus 5 or split task.
3. **Grounding (coverage <70%):** → Fable 5.1 synthesis round 2.
4. **AgentDB design (duel fails):** → Escalate to Opus 5 + Astra duel.

Tier 2 (manual gate review) and Tier 3 (campaign halt) escalations per ADR-0080 appendix.

---

## Live Model Lineup (Sept 2026, OpenRouter)

| Model | Input | Output | Capability | Speed | Gate Use |
|---|---|---|---|---|---|
| Haiku 4.5 | $0.80 | $2.40 | Fast, weak reasoning | 90+ tok/s | Ops config, low-risk scans |
| Sonnet 5 | $2.00 | $10.00 | Balanced, solid reasoning | 65 tok/s | Dev, architecture baseline |
| Opus 5 | $5.00 | $25.00 | Best Anthropic reasoning | 51.7 tok/s | High-risk research, security, design duels |
| Fable 5.1 | $10.00 | $50.00 | #1 overall (1525 ELO) | ~40 tok/s | Content synthesis, grounding, final audit |
| GPT-5.6 Terra | $2.00 | $12.00 | Competitive coding | ~60 tok/s | Dev alternative to Sonnet |
| GPT-6 Astra | $7.70 | $7.70 | #1 reasoning (GPQA 96%) | 45.1 tok/s | Advocacy, hard reasoning, duel fallback |
| Gemini 3.8 Flash | $0.75 | $3.75 | Cheapest, risky for gates | ~80 tok/s | Batching only, not gate work |

**Source:** OpenRouter API rankings, September 9–11, 2026.

---

## Rationale

### Why Hybrid, Not Cost-First Only?

- **Cost-first alone** would save $1–2K but risks gate failures on high-reasoning dimensions (advocacy, grounding, security audit). Recovery from a failed advocacy gate in W4 costs time + tokens and may miss the W6 deadline.
- **Hybrid** accepts $7–9K spend to guarantee gate passage on hard gates (W3–W4), then uses cheapest models on low-risk routine work (W2).

### Why Hybrid, Not Goal-First Only?

- **Goal-first alone** would cost $12–15K (Astra + Fable + Opus everywhere) and is slower (40–45 tok/s vs 90+ tok/s). Hybrid achieves same 95% confidence with 30–40% lower cost and faster W2 execution.

### Why Independent Grading in Phase 3?

- All 8 dimensions must be scored by reviewers *not* the authors of the work. Dual-grade (Fable + Astra) removes self-assessment bias and provides credible proof for the 95/100 claim.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cheaper models fail advocacy gate | MEDIUM | Campaign slip into W5 | Escalate immediately to Astra; budget 1–2 re-runs. |
| Sonnet design loses duel to Astra | LOW | Redesign delay | Duel in W3, not W2; promote to Astra if needed. |
| Dev CI fails after Sonnet code | MEDIUM | Re-implement cost | Tester reviews code quality before ship; escalate to Opus if risky. |
| Independent graders disagree on score | LOW | Dispute resolution | Use published rubric; if tied, third grader (Opus) breaks tie. |
| Token budget overrun (>$10K) | MEDIUM | Cost surprise | Pre-allocate escalation budget; halt non-critical research if budget tracked >80%. |

---

## Alternatives Considered & Rejected

1. **Cost-first only (Sonnet/Haiku everywhere):** Would save $6K but risks 40–50% gate failure rate on advocacy/grounding. Recovery would blow deadline.
2. **Goal-first only (Astra/Fable/Opus everywhere):** Guarantees gates but costs $12–15K and is slower (40–45 tok/s). Hybrid achieves same confidence for 30–40% less cost.
3. **Per-token routing (dynamic model selection on token count):** Complex orchestration; not yet implemented in project hooks. Static phase-based routing is simpler and more debuggable.

---

## Consequences

- **Dimensions reach 95+ predicted:** All 8 pillars expected to reach 95/100 by ship, with independent grading proof.
- **Cost predictability:** Budget tracked in three phases; escalation triggers are explicit.
- **Campaign velocity:** W2 fast (cheap models), W3–W4 careful (goal-first gates), W5–W6 proof (independent grading).
- **Precedent set:** Future campaigns adopt hybrid routing (cost + confidence phases) as standard practice.

---

## Sign-Off

This decision is pending dual-optimizer analysis (cost-first vs goal-first agents currently running in parallel). Final sign-off after both optimizers complete and reconciliation is reviewed by Stuart.

**Expected completion:** 2026-09-11 afternoon (within 2 hours of analysis launch).

