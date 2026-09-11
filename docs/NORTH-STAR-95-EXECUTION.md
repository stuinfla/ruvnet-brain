# North Star 95/100+ Execution Plan

> **SUPERSEDED 2026-09-11 15:50 EDT.** The four unlock levers this plan scheduled (ADR-076–079) were built the same day without reading the code they replaced, then measured and rejected — see each ADR's status block and PROGRESS.md 2026-09-11. The goal, 95/100 across eight pillars, stands; this route to it does not. Kept as the record of what was planned.

**Goal**: Reach 95/100+ on all eight North Star pillars by end of Week 6 (2026-09-25)

**Authority**: Dual analysis (Claude + Codex), verified against current state (31/100 baseline, Stage 1 → 55/100)

---

## Executive Summary

| Metric | Current | W2 Target | W4 Target | W6 Target |
|--------|---------|-----------|-----------|-----------|
| **Overall Score** | 31/100 | 70/100 | 90/100 | **95/100** |
| **Continuity** | 10 | 35 | 65 | **75** |
| **Learning** | 22 | 30 | 50 | **75** |
| **Ops** | 18 | 40 | 45 | **70** |
| **QA** | 48 | 60 | 65 | **80** |
| **DevLoop** | 35 | 42 | 43 | **65** |
| **Advocacy** | 35 | 42 | 55 | **65** |
| **Grounding** | 43 | 46 | 60 | **70** |
| **Docs** | 25 | 33 | 60 | **75** |

---

## Four Unlock Levers (Dependency Order)

### Lever 1: Memory Full Integration (Week 3, 4 days)
**Blocks**: Learning, Continuity, DevLoop

**What**: 
- Session-start auto-recall `project-state-current-*` from AgentDB
- Every decision → memory store with ADR link
- Decision paths use recalled patterns (not re-research)

**Files**:
- `plugin/scripts/session-start-core.mjs` — add recall
- `~/.claude/hooks/agentdb-ensure.sh` — global hook auto-recall
- Memory format spec (ADR-TBD)

**Success Criteria**:
- Session-start prints recalled project state
- Latest ADR linked in memory at boot
- Decision trace visible in git log + memory

**Payoff**: Learning +30, Continuity +20 = **+50 points**

---

### Lever 2: Continuity Gates (Week 3, 2 days)
**Blocks**: Continuity, DevLoop

**What**:
- ADR-as-code automation (every architecture decision → ADR auto-create if missing)
- Every ADR linked to code commit hash
- Pre-commit gate validates ADR exist + linked

**Files**:
- `scripts/enforce-adr-discipline.sh` — pre-commit hook
- `.git/hooks/pre-commit` — integration
- `plugin/hooks/hooks.json` — add gate

**Success Criteria**:
- Pre-commit blocks if new architecture commit lacks ADR
- ADR numbered and linked in commit message
- Example ADR created + passed gate

**Payoff**: Continuity +25, DevLoop +5 = **+30 points**

---

### Lever 3: Release Automation (Week 2, 3 days)
**Blocks**: Ops, DevLoop, Advocacy

**What**:
- `npm version patch/minor/major` + tag in one command
- Vercel deploys from tag (no manual push)
- Changelog auto-generated from commits
- Version bump verified against shipped bytes

**Files**:
- `scripts/release.mjs` — orchestrator (exists, harden)
- `.github/workflows/release.yml` — CI gate
- `package.json` — version script
- Release checklist enforcement

**Success Criteria**:
- `npm run release` deploys to Vercel
- Version in package.json matches live deployment
- Changelog updated + committed
- Green CI before deploy

**Payoff**: Ops +25, DevLoop +7, Advocacy +7 = **+39 points**

---

### Lever 4: Testing Gates + Public CI (Week 2, 2 days)
**Blocks**: QA, DevLoop, Advocacy

**What**:
- Pre-commit: `vitest` + `npm test` both pass (hard block)
- Coverage gates: new code cannot decrease coverage
- Pre-ship: all suites green, version bumped same commit
- Release CI shows green checkmarks (public)

**Files**:
- `.github/workflows/test.yml` — test gate
- `scripts/pre-commit-tests.sh` — local runner
- `.git/hooks/pre-commit` — integration
- Coverage threshold config

**Success Criteria**:
- Every commit has green test checks
- Coverage badge shows current %
- Failed tests block merge
- Public CI dashboard accessible

**Payoff**: QA +12, DevLoop +5, Advocacy +7 = **+24 points**

---

## Staged Rollout (W2 → W6)

### WEEK 2: Foundation (Aim: 55→70)
**Track A (Release)**: Release automation (3 days)
**Track B (Testing)**: Testing gates + public CI (2 days)

**Result**: Ops +22, DevLoop +7, QA +12
**Verification**: 
- One deploy via `npm run release` succeeds
- CI shows all checks green, publicly visible
- Version in package.json matches deployed build

### WEEK 3: Continuity (Aim: 70→85)
**Track A (Continuity)**: ADR-as-code gates (2 days)
**Track B (Memory)**: Session-start auto-recall (4 days)

**Result**: Continuity +55, Learning +28, DevLoop +5
**Verification**:
- Session-start prints auto-recalled state
- Pre-commit blocks missing ADRs
- Decision trace in git + memory

### WEEK 4: Advocacy (Aim: 85→90)
**Track A**: Metrics dashboard (2 days)
**Track B**: Customer story #1 (2 days)

**Result**: Advocacy +20, Grounding +17, Learning +5, Docs +10
**Verification**:
- Live metrics dashboard at public URL
- Real customer story with name + quote
- Benchmarks reproducible

### WEEK 5-6: Excellence (Aim: 90→95+)
**Track A**: Story #2 + deep docs (3 days)
**Track B**: Edge cases + stress tests (3 days)
**Track C**: Public validation proof (2 days)

**Result**: All pillars 70+, most 75+
**Verification**:
- 3 customer stories (independent proof)
- Performance benchmarks beating published
- Docs comprehensive + indexed
- North Star re-measured: all 8 pillars ≥70

---

## Execution Discipline

### Progress Tracking
- **Daily**: Update `PROGRESS.md` (5 min)
- **Weekly**: Re-score each pillar against acceptance criteria (30 min)
- **Per-commit**: Verify each change moves at least one pillar +1 point (no drift)

### Memory & Learning
- Store decisions in AgentDB: `project-state-current-<epochms>`
- Capture blockers when discovered (don't hide)
- Promote lessons from project → global when proven 2x

### Gates Before Shipping
- All eight pillars measured independently
- Each score has proof artifact (not asserted)
- No fabricated numbers on any surface
- Contingency: if any pillar drops, halt and investigate

### Rollback Plan
- If W2 misses: extend W2, compress W3-4
- If W3 misses: de-scope W4 (drop customer stories, keep tooling)
- If W4 misses: accept 85/100 by W6, schedule W7 for polish
- **Never** claim > goal without independent verification

---

## What Gets Cut (If Timeline Tightens)

| Priority | Item | Cost | Impact |
|----------|------|------|--------|
| **Keep** | Release automation | 3d | Core: enables W2 → W3 → W4 |
| **Keep** | Testing gates | 2d | Core: proves discipline |
| **Keep** | ADR gates + memory | 6d | Core: unblocks Learning |
| **Defer** | Story #2 | 3d | Nice: Advocacy/Grounding, not load-bearing |
| **Defer** | Edge case tests | 3d | Polish: if schedule slips |
| **Cut** | Windows CI | 2d | Low ROI: 2 known failures, non-blocking |

---

## Linked ADRs & DDD Models

- **ADR-TBD**: Memory Full Integration
- **ADR-TBD**: Continuity Gates (ADR-as-code)
- **ADR-TBD**: Release Automation
- **ADR-TBD**: Testing Gates & Public CI
- **DDD Model**: Bounded contexts (Continuity, DevLoop, Learning)

---

## Success Definition (End of W6)

✅ All eight pillars measured and ≥70/100  
✅ At least four pillars ≥75/100  
✅ Every claim has independent proof artifact  
✅ Public metrics dashboard live  
✅ 2-3 documented customer wins  
✅ Benchmarks reproducible  
✅ ADR discipline enforced in CI  
✅ Memory auto-recall working at every session start  

**North Star Score**: **95/100** (measured by independent dual vendors)

---

## Authority & Accountability

**Plan Authority**: Dual analysis (Claude + Codex), 2026-09-11, verified against current state

**Execution Lead**: Stuart Kerr

**Success Owner**: North Star goal reached by 2026-09-25

**Gate Reviews** (Weekly):
- W2 gate (2026-09-18): Release automation proven, CI gates live
- W3 gate (2026-09-18): ADR discipline enforced, memory recall working
- W4 gate (2026-09-25): Metrics live, customer story published
- W6 gate (2026-09-25): All pillars re-scored, 95/100 verified

---

Generated: 2026-09-11T16:45:00Z
Next Review: When ADR/DDD agents complete
