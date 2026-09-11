# RuvNet-Brain Case Studies

**Status:** Research phase for first story  
**Goal:** Real customer stories showing "I used RuvNet-Brain to solve X"  

---

## Story 1: PowerPlatePulse — Medical Knowledge Without Hallucination

**Status:** ✍️ Draft outline + research complete  
**Theme:** "I used RuvNet-Brain to solve medical knowledge grounding"  
**Files:**
- `story-1-draft.md` — Full outline with research questions, RuvNet-Brain sources, proof strategy
- `RESEARCH-SUMMARY.md` — Condensed research notes for the full write

**The story in one sentence:**
PowerPlatePulse needed a medical Q&A system that cites real research (477 PubMed IDs) without hallucinating. RuvNet-Brain showed them proven patterns from Ruflo (retrieve-and-inject), Cognitum (persona adaptation), RuVector (embeddings), and RuLake (caching). Result: 91% accuracy, live in production.

**Key RuvNet sources used:**
- Ruflo ADR-0005 (retrieve-and-inject pattern)
- Cognitum-Learn (medical KB + persona adapter)
- RuVector (embedding strategy)
- RuLake (vector caching for <500ms queries)
- AgentDB (append-only audit trail)

**Next steps:**
1. ✅ Research + outline complete
2. ⬜ Full story write (~1200 words, code samples, proof screenshots)
3. ⬜ Terminal search proof-of-concept (run forge-ask-all.mjs queries)
4. ⬜ PowerPlatePulse /ask.html live screenshot
5. ⬜ Edit + publish

**Timeline:** Ready for full write. Can be published once KB is rebuilt and searches verified.

---

## Pipeline (Planned)

| Story | Theme | Project | Status | Why This One |
|---|---|---|---|---|
| **Story 1** | Medical knowledge grounding | PowerPlatePulse | ✍️ Outline done | Solves "how do I prevent hallucination" + verifiable proof |
| **Story 2** | Distributed agent coordination | Ruflo (self-dog-food) | 📋 Planned | Shows RuvNet-Brain used by its own core tool |
| **Story 3** | Financial prediction + accuracy | cognitum-trader | 📋 Planned | "I used RuvNet-Brain to find ensemble strategies" |
| **Story 4** | Health intelligence + privacy | Helix | 📋 Planned | Privacy-preserving knowledge system (similar to PowerPlatePulse but health-focused) |
| **Story 5** | Cross-repo pattern discovery | Ask-Ruvnet (self-dog-food) | 📋 Planned | How RuvNet-Brain's own indexer uses itself |

---

## How to Use This Folder

**For Stuart:**
- Review `story-1-draft.md` to approve outline before full write
- Review `RESEARCH-SUMMARY.md` for research quality (proof strategy)

**For stories-researcher (if assigned):**
1. Read `story-1-draft.md` — this is the story structure
2. Read `RESEARCH-SUMMARY.md` — this is the proof strategy
3. Write full story using template:
   - Headline + lede (problem)
   - "The search journey" (what questions we asked RuvNet-Brain)
   - "What we found" (sources + proof)
   - "How we applied it" (code samples)
   - "The outcome" (verifiable results)
4. Collect proof (terminal searches, screenshots)
5. Publish to case-studies/ with featured image

**For readers:**
Each story answers: **"How do I build [X] without hallucinating / making expensive mistakes / reinventing?"** and shows the exact RuvNet-Brain sources and code patterns that answered it.

---

## Story Structure Template

Every case study follows this pattern:

```
1. PROBLEM (2-3 sentences)
   - What was the domain challenge?
   - What constraint made it hard?

2. HOW RUVNET-BRAIN HELPED (Research Questions)
   - Q1: [What we asked] → [What we found] → [Proof]
   - Q2: [What we asked] → [What we found] → [Proof]
   - Q3: ...
   - (3-5 research questions typical)

3. OUTCOME (Measured, Verifiable)
   - What changed?
   - What's the proof? (production URL? accuracy %)
   - What was the adoption pattern?

4. PROOF (Terminal + Screenshots)
   - RuvNet-Brain search query that found the pattern
   - Code side-by-side (other repo → this repo)
   - Live screenshot or production metrics
```

---

## Quality Bar

Every case study must have:

- [ ] **Real problem** — not hypothetical; solved by an actual product
- [ ] **RuvNet-Brain sources** — 3+ repos cited with exact file paths
- [ ] **Verifiable outcome** — metrics, URLs, or published results
- [ ] **Code proof** — not just "we learned from X," show "we adapted X's code like this"
- [ ] **No handwaving** — every recommendation was actually adopted, not just considered

---

## Notes

- **Story order matters:** Start with PowerPlatePulse (grounding) → then Ruflo (dog-food) → then financial (complexity)
- **Keep stories independent:** Each reader should understand the story without reading others
- **Terminal proof is the gold standard:** A screenshot of `forge-ask-all.mjs` returning the exact RuvNet repo is worth more than a narrative
- **Honest about limitations:** If RuvNet-Brain didn't help with X, say so; that's credible

---

**Created:** 2026-09-11  
**Last updated:** 2026-09-11
