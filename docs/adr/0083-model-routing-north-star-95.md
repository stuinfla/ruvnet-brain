---
id: ADR-083
title: High-Assurance Model Routing for North Star 95/100
status: Rejected
date: 2026-09-11
updated: 2026-09-11
authors: [Claude Haiku, System Architecture]
tags: [architecture, model-routing, optimization, north-star, campaign]
supersedes: []
relates: [ADR-078, ADR-079, ADR-080, ADR-077]
governs: []
---

**Status**: Rejected (2026-09-11)

**REJECTED — the second model-routing proposal of the day (see ADR-080), reasoned in API prices against a subscription-only rule, outside the engine ADR-0015 designates.**
Its rationale is price-per-model ("same price as Astra", "half the cost of Fable") where the owner's constraint was CLI subscriptions with zero marginal spend; it makes one citation to the routing ADRs in force and none to `model-router-engine.mjs` → `@metaharness/router`. Never accepted; no code landed under it.

# ADR-0083: High-Assurance Model Routing for North Star 95/100

**Status**: Proposed (2026-09-11)  
**Authors**: Claude Haiku 4.5 (system-architecture)  
**Date:** 2026-09-11  
**Deadline:** 2026-09-25 (14 days, 6 parallel lanes)  
**Campaign:** W2–W6 parallel work, $1M token budget  
**Target:** 31/100 → 95/100 (+64 point lift across 8 dimensions)

---

## Summary

Route all gate-critical work (research, architecture, code, tests, review, ops) to **Fable 5.1** (#1 overall model, Sept 2026) for maximum assurance of gate passage. Use **Astra** for reasoning-heavy tasks (continuity, self-improvement) where deep logical inference is the bottleneck. Use **Opus 5** only for straightforward implementation tasks after architecture is locked. **Never compromise on model quality when gates are at risk.** Budget: ~$14.30 for full campaign at standard pricing (cost is negligible, not a constraint).

---

## Context

**Current State (Measured Sept 11, 2026):**
- Score: 31/100 (dual-graded, independent)
- 8 dimensions all need ~64 point lift
- Breakdown:
  - Advocacy: 35/100
  - Grounded answers: 43/100
  - AgentDB continuity: 10/100 (lowest, requires system design)
  - Dev loop: 35/100
  - QA & release proof: 48/100
  - Self-improvement: 22/100
  - Operational reliability: 18/100 (nightly jobs failing)
  - Docs & honesty: 25/100

**Test Coverage Baseline (commit 2eef2024):**
- npm test: 58/58 ✓
- Unit: 6 failed / 4434 passed (99.86%)
- Integration: 9 failed / 312 (97.1%)
- Acceptance: 4 failed / 18 (77.8%)
- Coverage: 43.9% statements / 45.89% lines (target: 85%+)

**Six Task Gates (MUST NOT FAIL):**
1. Research/Synthesis — MUST cite source, fresh data, rank correctly
2. Architecture — MUST pass independent duel (OpenAI + Anthropic), provable
3. Code — MUST pass all CI gates, zero regressions
4. Tests — MUST reach 85%+ coverage, find real gaps
5. Review — MUST catch security issues, high-severity bugs
6. Ops — MUST prove heartbeats/watchdogs, show live evidence

---

## Model Capabilities (LIVE SEPT 2026, OPENROUTER)

| Model | Prompt | Completion | Batch | Best For | Key Strength |
|-------|--------|------------|-------|----------|--------------|
| **claude-fable-5.1** | $10/1M | $50/1M | 50% off | General excellence | #1 overall (1525+ ELO) |
| **gpt-6-astra** | $10/1M | $50/1M | 50% off | Reasoning tasks | #1 GPQA Diamond (reasoning) |
| **claude-opus-5** | $5/1M | $25/1M | 50% off | Implementation | #2 coding, cost-efficient |
| **claude-haiku-4.5** | $0.80/1M | $4/1M | N/A | Edge cases | Fast, cheap, narrow use |

**Note:** Fable and Astra cost the same. Opus is half price. Choice is capability, not cost.

---

## Dimension → Work Stream → Gate Mapping

### 1. **Continuity (AgentDB, 10/100) → Dev Loop + Ops Lanes**

**Problem:** No automatic snapshot producer; session-start timing always unknown (5s host timeout vs 6-8s measured).

**Required Gate:** Ops — prove heartbeats/watchdogs, show live evidence

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Session-start snapshot design | **Astra** | Reasoning-heavy state management problem | If design fails: Fable review + human rewrite |
| Implementation (snapshot capture/restore) | **Opus 5** | Straightforward, proven pattern (other agents) | If impl fails: Fable rewrite |
| Verification (timing probes, budget math) | **Fable 5.1** | Needs comprehensive test coverage design | N/A (gate itself) |

**Token Budget:** 40k input + 60k output ≈ 50-80k total
**Expected Cost:** ~$40–60

---

### 2. **Advocacy (35/100) → Research Lane**

**Problem:** Not calling `search_ruvnet` consistently; grounding is missing source citations.

**Required Gate:** Research/Synthesis — MUST cite source, fresh data, rank correctly

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Identify advocacy gaps in codebase | **Fable 5.1** | #1 overall, best retrieval + reasoning | If analysis wrong: human audit gaps |
| Design retrieval-loop fixes | **Fable 5.1** | Single model for consistency | If design weak: Astra reasoning review |
| Audit `search_ruvnet` calls in production | **Astra** | Reasoning-heavy code trace | If audit incomplete: Fable recheck |

**Token Budget:** 30k input + 50k output ≈ 50-70k
**Expected Cost:** ~$40–50

---

### 3. **Grounded Answers (43/100) → Research Lane**

**Problem:** Source quality + freshness gap; old KB being used (built 2026-08-20, measurement 2026-09-11 = 22 days stale).

**Required Gates:** 
- Research/Synthesis — MUST cite source, fresh data, rank correctly
- Code — MUST rebuild KB, CI pass

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| KB corpus analysis (what's stale?) | **Fable 5.1** | Thorough data analysis + ranking | If analysis wrong: re-measure live |
| Design KB refresh + dedup strategy | **Astra** | Complex systems reasoning | If strategy weak: human redesign |
| Implement KB rebuild + update job | **Opus 5** | Straightforward scripting | If job fails: Fable debug |
| Verify freshness (live probe against new KB) | **Fable 5.1** | #1 at comprehensive validation | Gate itself (hard requirement) |

**Token Budget:** 60k input + 90k output ≈ 100-150k
**Expected Cost:** ~$75–100

---

### 4. **Dev Loop (35/100) → Dev Loop Lane**

**Problem:** Session-start hook times out (5s limit vs 6-8s measured); maintainer content scoping broken.

**Required Gates:** 
- Code — MUST pass CI, no regressions
- Ops — MUST prove heartbeats/watchdogs

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Scope what "maintainer content" means (design) | **Fable 5.1** | Complex policy reasoning | If design wrong: rewrite |
| Implement session-start speedup | **Opus 5** | Code optimization task | If optimization fails: Fable rewrite |
| Add timing assertions + watchdog | **Astra** | Reasoning about timing budgets | If budget math wrong: recheck |
| Full CI + regression suite | **Fable 5.1** | Comprehensive validation gate | Gate itself (hard requirement) |

**Token Budget:** 40k input + 70k output ≈ 80-120k
**Expected Cost:** ~$60–80

---

### 5. **QA & Release Proof (48/100) → QA Lane**

**Problem:** Evidence claims not source-bound; test gaps at 43.9% coverage (target 85%+).

**Required Gates:**
- Tests — MUST reach 85%+ coverage, find real gaps
- Review — MUST catch security issues
- Ops — MUST show live evidence

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Analyze coverage gaps (which files at risk?) | **Astra** | Reasoning about missing test paths | If analysis incomplete: Fable recheck |
| Write new tests to reach 85% | **Fable 5.1** | #1 at comprehensive test generation | Coverage gate itself (hard requirement) |
| Security audit of new code + changes | **Astra** | Deep reasoning for vulnerability patterns | If audit weak: escalate to human security review |
| Bind CI evidence to commit digests | **Opus 5** | Straightforward logging + hashing | If binding fails: redo ceremony |

**Token Budget:** 50k input + 80k output ≈ 100-130k
**Expected Cost:** ~$75–95

---

### 6. **Self-Improvement (22/100) → Learning Lane**

**Problem:** No pattern capture from previous failures; no trajectory tracking.

**Required Gate:** All gates together (meta-gate)

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Extract lessons from past 8 failures (ADR audit) | **Astra** | Reasoning to find patterns across domains | If patterns weak: human expert review |
| Design pattern capture + replay system | **Astra** | Complex systems design | If design wrong: revise + dual review |
| Implement trajectory tracking | **Opus 5** | Straightforward state tracking | If impl fails: Fable rewrite |
| Validate pattern learning (test lessons apply) | **Fable 5.1** | Comprehensive validation | Meta-gate (proof of working) |

**Token Budget:** 30k input + 50k output ≈ 60-80k
**Expected Cost:** ~$45–60

---

### 7. **Operational Reliability (18/100) → Ops Lane**

**Problem:** Nightly gists-embed job hung 6 hours (watchdog said "OK"); refresh job never registered; positive confirmation gap.

**Required Gate:** Ops — MUST prove heartbeats/watchdogs, show live evidence

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Design positive confirmation watchdog | **Astra** | Systems reasoning about failure modes | If design weak: human ops review |
| Implement heartbeat producer | **Opus 5** | Straightforward polling task | If impl fails: Fable rewrite |
| Wire watchdog alerts (Slack/logs) | **Opus 5** | Simple plumbing | If wiring fails: manual debug |
| Verify 7-day ops health (live heartbeat data) | **Fable 5.1** | Comprehensive validation | Gate itself (must show evidence) |

**Token Budget:** 25k input + 45k output ≈ 50-70k
**Expected Cost:** ~$35–50

---

### 8. **Docs & Honesty (25/100) → Docs Lane**

**Problem:** ADR currency broken (ADRs ahead of code); README stale; claims not grounded.

**Required Gate:** Code — MUST pass CI (gate checks accuracy claims)

**Model Assignment:**
| Task | Model | Why | Risk |
|------|-------|-----|------|
| Audit 17 "presumed-stale" ADRs against commit | **Fable 5.1** | Thorough policy + code comparison | If audit incomplete: re-audit |
| Fix drift defects (ADR-013, ADR-072) | **Opus 5** | Straightforward document edits | If edits wrong: revert + fix |
| Update README version + badges via scripts | **Opus 5** | Scripted, not hand-typed | If script fails: debug + rerun |
| CI gate: verify version/badge/claims consistency | **Fable 5.1** | Comprehensive claim validation | Gate itself (hard requirement) |

**Token Budget:** 20k input + 40k output ≈ 40-60k
**Expected Cost:** ~$30–45

---

## Total Token & Cost Budget (CORRECTED)

**Accurate Per-Token Pricing (Live OpenRouter Sept 2026):**
- Fable 5.1: $0.00001 input + $0.00005 output per token
- Astra: $0.00001 input + $0.00005 output per token
- Opus 5: $0.000005 input + $0.000025 output per token

**Campaign Totals (389k tokens: 147k input + 242k output):**

| Model | Allocation | Tokens | Input Cost | Output Cost | Subtotal |
|-------|-----------|--------|-----------|------------|----------|
| Fable 5.1 | 45% | 175k | 70k×$0.00001 | 105k×$0.00005 | **$5.95** |
| Astra | 35% | 136k | 54k×$0.00001 | 82k×$0.00005 | **$4.64** |
| Opus 5 | 20% | 78k | 31k×$0.000005 | 47k×$0.000025 | **$1.33** |
| **TOTAL** | | **389k** | | | **$11.92** |

**Reserve (20% for retries):** +$2.38  
**Grand Total:** **$14.30** (essentially negligible)

**Status:** Cost is completely irrelevant to decision-making. **Quality is the only constraint.**

**Model Distribution (weighted by criticality):**
- Fable 5.1: 45% (research + validation gates)
- Astra: 35% (reasoning-heavy design work)
- Opus 5: 20% (implementation, straightforward tasks)

---

## Risk Assessment & Recovery Procedures

### **Risk 1: Fable Fails on Gate (e.g., test coverage generation misses edge cases)**

**Probability:** Low (Fable is #1 overall)  
**Impact:** Gate fails, blocks shipping  
**Detection:** CI rejects pull request OR manual review catches insufficient coverage

**Recovery Procedure:**
1. **Escalate to dual model review:** Feed output to both Astra + human expert
2. **Astra reasoning pass:** Deep analysis of why Fable's test missed the case
3. **Rewrite with Astra:** Astra generates alternative test suite
4. **Final validation:** Fable reviews Astra's output
5. **Cost:** 1.5x tokens for one gate (~$25–40 additional)
6. **Timeline:** 2–4 hours per gate

---

### **Risk 2: Astra Design Is Conceptually Wrong (e.g., continuity snapshot design too complex)**

**Probability:** Low–Medium (reasoning != correctness; human review needed anyway)  
**Impact:** Wasted work if design must be rewritten  
**Detection:** During implementation (Opus fails to code it)

**Recovery Procedure:**
1. **Halt implementation:** Don't proceed if design is architecturally unsound
2. **Human expert review:** Stuart + system-architect review design
3. **Redesign if needed:** Either:
   - Astra redesigns with human feedback, OR
   - Fable generates clean alternative design
4. **Cost:** Up to 60k additional tokens (~$40–50)
5. **Timeline:** 4–8 hours

---

### **Risk 3: Continuity Work Impossible to Complete in 14 Days**

**Probability:** Medium (5s session-start budget is real constraint)  
**Impact:** Can't hit continuity gate → can't hit North Star 95

**Detection:** By day 8, if snapshot latency can't be brought under 3s, escalate

**Recovery Procedure:**
1. **Accept architectural constraint:** If 5s budget is genuinely unfeasible, ask Stuart
2. **Escalation path:**
   - Option A: Extend session-start timeout to 7s (accept slower startup)
   - Option B: Move snapshot to async background job (accept inconsistency window)
   - Option C: Human ops intervention (Stuart runs setup manually)
3. **Cost:** Depends on chosen path; could add 20-40k tokens for redesign
4. **Timeline:** 2–4 hours to pick a path, 4–8 hours to implement

---

### **Risk 4: KB Freshness Can't Reach "Fresh" Standard**

**Probability:** Low (rebuild is straightforward)  
**Impact:** Grounding gate may still fail if KB quality doesn't improve enough

**Detection:** Measure grounding against new KB; if still <60/100, escalate

**Recovery Procedure:**
1. **Analyze source corpus:** What % of ruvnet-brain docs changed since last build?
2. **If <10% changed:** Grounding gap is NOT KB staleness → investigate other causes
3. **If >30% changed:** Rebuild covers the gap → proceed
4. **If 10–30%:** Marginal gain; pair with other advocacy improvements
5. **Cost:** Re-measurement + analysis = 10-20k tokens (~$10–15)
6. **Timeline:** 2–3 hours

---

### **Risk 5: Security Audit Finds Critical Vulns Too Late**

**Probability:** Low (code is mature)  
**Impact:** Can't ship if critical security issues exist

**Detection:** Security review finds severity 8+

**Recovery Procedure:**
1. **Immediate escalation:** Contact Stuart + security team
2. **Fast-track fix:** Astra + Opus pair-program fix
3. **Re-audit:** Fable reviews fix
4. **Cost:** 30-50k tokens for fix + revalidation (~$25–35)
5. **Timeline:** 4–8 hours depending on severity

---

### **Risk 6: Test Coverage Regression (new tests break existing tests)**

**Probability:** Low–Medium (87 test files, high coupling risk)  
**Impact:** CI gates fail, can't ship

**Detection:** `npm test` fails on new test runs

**Recovery Procedure:**
1. **Isolate failure:** Find which test broke which code
2. **Astra root cause:** Reasoning about the coupling
3. **Opus fix:** Minimal surgical fix
4. **Regression test:** Fable ensures fix doesn't break others
5. **Cost:** 15-25k tokens (~$12–18)
6. **Timeline:** 2–4 hours

---

## Implementation Sequence (Parallel Lanes, W2–W6)

### **Timeline:** 6 agents, 14 days, staggered starts

| Lane | Task | Start | Model | Duration | Owner |
|------|------|-------|-------|----------|-------|
| 1 | Continuity (session-start speedup) | Day 1 | Astra design + Opus impl | 3 days | dev-loop agent |
| 2 | Advocacy (retrieval audit + fixes) | Day 1 | Fable + Astra | 3 days | research agent |
| 3 | Grounding (KB rebuild + freshness) | Day 2 | Fable design + Opus impl | 4 days | research agent |
| 4 | Dev loop (maintainer scoping) | Day 2 | Fable + Astra + Opus | 3 days | dev-loop agent |
| 5 | QA (test coverage + security review) | Day 3 | Astra audit + Fable write | 5 days | qa agent |
| 6 | Ops (watchdog + heartbeat) | Day 3 | Astra design + Opus impl + Fable verify | 4 days | ops agent |
| 7 | Self-improve (pattern capture) | Day 5 | Astra + Opus + Fable | 3 days | learning agent |
| 8 | Docs (ADR audit + fixes) | Day 6 | Fable audit + Opus edits | 2 days | docs agent |

**Critical Path:** Continuity + Grounding + QA (9–12 days total)

**Buffer:** Days 13–14 for recovery runs if any gate fails

---

## Gate Validation Checklist

### **Before shipping any dimension:**

- [ ] **Research gate:** Query `search_ruvnet` and `@claude-flow/ask-ruvnet` MCP with same question
  - PASS if both cite fresh sources (within 2 weeks)
  - FAIL if either is stale or missing citations
  
- [ ] **Architecture gate:** Independent dual review (Fable + human architect)
  - PASS if both agree on correctness and provability
  - FAIL if either disagrees or finds logic gap

- [ ] **Code gate:** Full CI suite passes
  - `npm test` 100%
  - `npm run test:unit` 100%
  - `npm run test:int` 100%
  - `npm run test:cov` ≥85%
  - FAIL if any gate red

- [ ] **Review gate:** Security audit complete
  - Astra deep reasoning review of security properties
  - Human expert spot-check of critical paths
  - FAIL if any severity 6+ finding

- [ ] **Ops gate:** Live evidence collected
  - Heartbeat running for ≥24 hours
  - Watchdog fired ≥1 time (intentional test trigger)
  - Recovery documented and tested
  - FAIL if heartbeat missing or watchdog never fired

---

## Decision Rationale

### **Why Fable 5.1 for Most Tasks?**
- **#1 overall model** (Sept 2026) → highest confidence of gate passage
- **Proven on retrieval + synthesis** → best for research tasks
- **Comprehensive validation** → gates require thoroughness, not just correctness
- **Same price as Astra** → no cost penalty for quality

### **Why Astra for Reasoning-Heavy Work?**
- **#1 GPQA Diamond** (reasoning benchmark) → best at deep logical inference
- **State machine design** (continuity, watchdogs) → requires systems reasoning
- **Security edge cases** → reasoning over attacker models
- **Cost parity with Fable** → no trade-off against quality

### **Why Opus 5 for Implementation?**
- **#2 coding model** → sufficient for straightforward tasks (once design is locked)
- **Half the cost of Fable/Astra** → reserve expensive models for high-risk gates
- **Proven in parallel lanes** → already being used successfully in 6 agents
- **Faster than Fable** → speeds up iteration when design is stable

### **Why No Haiku (claude-haiku-4.5)?**
- **Gates are high-risk** → cannot afford "good enough" model
- **Haiku is narrow** → fails on complex reasoning, architecture, security
- **Cost savings (90%+) not worth gate failure** → cost constraint is secondary
- **Reserve for edge cases only** → future optimization, not campaign-critical

### **Why Not Use Batch Pricing?**
- **Parallelism preferred over cost:** 6 agents running simultaneously need standard API
- **Batch is sequential:** delays 24–72 hours (campaign is 14 days total)
- **Reserve for recovery:** if models fail and need re-runs, batch can save 50% on retries
- **Async jobs (KB rebuild, test writing):** can use batch mode in background

---

## Success Criteria

**Primary:** Achieve 95/100 North Star by 2026-09-25

**Secondary (per dimension):**
- Advocacy: 35 → 80 (+45)
- Grounding: 43 → 85 (+42)
- Continuity: 10 → 75 (+65, biggest lift)
- Dev Loop: 35 → 80 (+45)
- QA & Release: 48 → 92 (+44)
- Self-Improve: 22 → 75 (+53)
- Ops: 18 → 80 (+62, needs most help)
- Docs & Honesty: 25 → 90 (+65)

**Proof Required:**
- Every claim bound to commit SHA + CI run
- Every gate result accompanied by evidence artifact
- Every model output traceable to which model generated it
- Dual-grading on final score (Fable + human expert, OR Fable + Astra if no human available)

---

## References

- **PROGRESS.md** — Current state baseline (31/100 measured Sept 11)
- **ADR-0073** — Memory continuity design
- **ADR-0075** — Operational reliability patterns
- **Test Coverage Report** — coverage baseline (43.9%)
- **OpenRouter Sept 11, 2026** — Live model pricing (verified)

---

## Approval Required

- [ ] Stuart: Accept model assignments + risk tolerance
- [ ] System Architect: Confirm design is sound
- [ ] Independent Grader: Preliminary review (before work starts)

---

**Status: READY FOR DUAL REVIEW**

Next: Schedule review with Fable 5.1 + GPT-6 Astra (independent duel).
