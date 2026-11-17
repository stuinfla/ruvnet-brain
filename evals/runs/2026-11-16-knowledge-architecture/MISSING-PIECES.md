Updated: 2026-11-17 | Version 1.0.0
Created: 2026-11-17

# MISSING-PIECES: what passage vectors do not give a newcomer

Goal from the owner: the knowledge base must GUIDE and DRIVE (right workflow, tool combination, order, pitfalls, how rUv decides), for experts and for amateurs who only know "I'm playing with Claude". Source paths below were found by Brain questions logged in `ruvector-deepdive/BRAIN-QUESTION-LOG.md` (entries named in brackets) and, where marked CODE, read in the clones under /Users/stuartkerr/RVF-KnowledgeBases/ruvnet-brain-v2-work/src. Items marked DOC-ONLY rest on a document or prompt, not on code I read. Build cost: S under 1 day, M 1-3 days, L over 3 days. Question types: A = amateur problem-only, E = expert exact-term, I = integration, H = how-to-build.

Headline: the single biggest finding is that rUv already wrote the guidance layer in prose and tables; our store holds it only as passages that compete with 200k others. Items 1-4 are mostly extraction and promotion of what exists (cheap), not invention.

## Storage forms (what is written at build time)

| # | Idea | Supporting source | Fixes | Cost | Pre-registered test |
|---|---|---|---|---|---|
| 1 | Problem-to-solution cards from rUv's own "I need to..." tables | ruflo/plugins/ruflo-core/skills/discover-plugins/SKILL.md, "Decision Guide" (20 rows) [M-2]; QUICKSTART.md common workflows | A, H | S | 30 amateur problem-only questions with no tool names, written before the build; card present = hit@2 on the right tool combination; pass if hit@2 rises at least 20 points over passage-only and no expert exact-term question loses rank 1 |
| 2 | Recipe / playbook cards (ordered steps, with the first command) | QUICKSTART.md (swarm-init, agent-spawn, task-orchestrate; SPARC specification-architect-tdd-reviewer-optimizer; 7-step todo app) [M-2] | H | S-M | 15 "how do I build X" tasks; grade = does the returned card give the correct first three steps in order (two blind graders); pass at 80% |
| 3 | Capability cards with "when to use / what it adds" columns, grouped by phase (start here, learn, build right, ship safely) | discover-plugins SKILL.md catalog (32 plugins, 6 groups) [M-2]; CAPABILITY-MAP.md | A, I | S | The same 30 amateur questions; plus 10 "which of these two tools" questions; pass if the card names the right group and plugin |
| 4 | Cue sentences in newcomer wording stored as retrieval keys (cue -> tag -> content, MRAgent shape) | 04-DESIGN-THE-RUV-WAY.md cue/tag/content tables; R1-0b typed-graph bench as recipe (Doc/Topic/ABOUT/DocEmb) [R1-0b] | A (the naive questions N3, N-tools, N-stable all missed) | M | Replay the 3 naive questions plus 27 new ones; success = right repo or artifact in top 2; run before/after on frozen corpus |
| 5 | Problem-to-solution graph with typed edges (problem -> capability -> plugin -> command), searched then traversed | crates/ruvector-graph/src/typed_graph.rs `search_then_traverse` (CODE, round 1; ADR-252/253 numbering inconsistent) [R1-0b] | A, I | M-L | Same 30; compare cards-only vs cards+graph on the integration set (10 "A with B" questions) |
| 6 | Cross-repo integration map (which pieces connect: ruflo to agentdb to RVF to rulake) | agentdb-tools.ts and memory-bridge.ts (CODE, R2-10/11); ruLake bundle generations (CODE, R2-3) | I | M | 10 integration questions pre-written from the map's own edges plus 5 negatives (pieces that do NOT connect); pass if edges recalled and negatives refused |
| 7 | Per-repo "start here" path (entry file, first command, first working example) | QUICKSTART.md; repo READMEs; `ruvector-catalog` skill (listed in this session, not read) | A, H | S | For 20 repos, a stranger-grader follows the card and reaches a running example; measure steps to success |
| 8 | Anti-pattern and pitfall cards ("do not ...") | ruflo ADR-325 "Alternatives considered ... rejected" sections, ADR-320 name-collision rule [R3-1]; CLAUDE.md files; QUICKSTART troubleshooting [M-2] | H, A | M | 20 known mistakes drawn from the project's own failure notes; success = the card surfaces before the mistake when the plan is described |
| 9 | Version and lineage records (which doc is current, what superseded it) | QUICKSTART.md stale vs ruflo plugin docs [M-2]; ADR "Status: Proposed" headers [R3-1]; roadmap vs code [R2-14, R1-0a]; rvf epoch/branch/lineage (CODE, R2-3) | E, H | M | 15 questions whose old answer is wrong today; success = answer cites current form and flags superseded; count stale answers |
| 10 | Maturity labels on every card (S shipping, R real Rust no binding, X experimental, P plan) | Design legend; this deep-dive's file:line findings (diagnostic.rs real but ADR "Proposed"; tiering unwired; adaptive HNSW files absent) | all (prevents recommending a plan) | S per card, L to cover all | 20 questions about features that are plan-only; pass if zero are answered as shipped |
| 11 | Glossary / alias map (newcomer word to rUv term: "memory" to AgentDB/ReasoningBank, "swarm" to hive-mind, "vector search" to RVF/HNSW) | ruflo discover-plugins descriptions; ADR-320 disambiguation rule [R3-1] | A, E | S | Alias-only questions (term never in the target text); hit@2 before/after |
| 12 | Worked examples with the real output attached | QUICKSTART todo-app walk-through [M-2]; typed_graph_bench.rs [R1-0b] | H | M (needs a run, which is compute-heavy: defer) | Grader runs the example, compares to the card |
| 13 | "How rUv decides" rules (when to use which topology, which model tier, when not to swarm) | ruvnet-brain/CLAUDE.md "When to Swarm: YES 3+ files / NO 1-2 line fixes", 3-tier model routing (read in this project's instructions); ruflo guidance_recommend (round 1) | H, A | S-M | 20 task descriptions; the card must give the same swarm/no-swarm and tier call as the source rule |

## Query-time behaviours (nothing stored differently)

| # | Idea | Supporting source | Fixes | Cost | Pre-registered test |
|---|---|---|---|---|---|
| 14 | Calling model rewrites a newcomer question into a cue sentence plus 2 artifact-named sub-queries before search | Brain behaviour: router declines or misroutes plain words (N-tools, N-stable, R3-2) and works when a repo is named [R1-N-*, R3-2]; ReasoningBank "query expansion: extract key concepts, include domain context" (DOC-ONLY) [M-1] | A | S | Same 30 amateur questions; with-rewrite vs without; pass if hit@2 improves and no latency over a stated budget |
| 15 | Abstain on raw relevance, with a "closest thing" hint | Brain's own INSUFFICIENT_EVIDENCE banner works but gives no pointer [N3]; bounded-rag refuse path (CODE, R2-2); agentic-qe three states complete/incomplete/failed [N3] | A, E | S | 20 unanswerable plus 20 answerable; report abstain precision and recall |
| 16 | Router that picks the answer form (card, passage, graph walk) by question shape | OSpipe rule table router.rs 90 lines (CODE, R2-6); agentdb semantic-route is only an error-fallback wrapper (CODE, R2-10: do not copy) | all | M | Held-out shapes; routed vs single-path hit@2 |
| 17 | Fusion with an entity arm (RRF + MMR) | ruflo memory hybridSearch, entity-tagger.ts (CODE, R2-11) | E, I | M | Exact-term and integration sets; note rUv's own dream report shows fusion hurts paraphrase queries (R2-9), so test paraphrase separately |
| 18 | Stable ordering (distance, id) so the same question gives the same list | rvf-index/src/hnsw.rs:458/588/677; rvf-runtime/src/store.rs:984+ (CODE) | reproducibility (N-stable) | S | Same 50 queries twice across a process boundary; lists byte-identical |

## Learning from use

| # | Idea | Supporting source | Fixes | Cost | Pre-registered test |
|---|---|---|---|---|---|
| 19 | Retrieve-judge-distill-consolidate loop with a curator gate (accept at 0.7, review at 0.5) | adaptive-learner.md, experience-curator.md [M-1] (DOC-ONLY: the code behind `reasoningbank distill` was not read; weights as printed sum to 110%, so treat as illustrative) | all, over time | L | Offline replay of logged questions: does the distilled memory raise hit@2 on a held-out week without lowering exact-term ranks |
| 20 | Co-occurrence and error-fix learning (which tool pairs follow which problem) | npm/packages/ruvector `intelligence-engine.ts` recordCoEdit :1081, recordErrorFix :1116 (CODE, R2-13) | H, I | M | Held-out sessions; suggestion precision@3 |
| 21 | Frozen store + learning in the harness; promote only through the three-condition gate | ADR-325 + crates/ruvector-agent-memory/src/diagnostic.rs 998 lines (CODE, R3-1); ADR-282 research-gate; Darwin guard train/eval disjoint (CODE, R2-4); R2-14 finding that no learning index exists | nightly update, safety | M-L | Seeded regression: inject a worse retriever; the gate must block it and name the stage |
| 22 | Receipts for answers (what was returned, tamper-evident) | crates/ruvector-retrieval-receipt (CODE, R3-2); ruvnet-brain scripts/corpus-candidate.mjs [R3-2] | trust, audit | S | Mutate a result set; verification must fail |
| 23 | Shortcut edges and attractor boosts (Hopfield weight 0.10) | mcp-brain-server cognitive.rs (CODE, R2-9) | E | L | Ablation on weight; rUv's own report that fusion hurts paraphrase is the prior |

## Not covered (said plainly)

- How pi-brain, rulake, agenticow and metaharness learn from usage: tool surfaces exist (brain_vote, brain_drift, agenticow_lineage, metaharness_flywheel_gate are listed in this session), and the code reads in rounds 1-2 cover ruLake generations, agenticow-style branches in RVF, and the Darwin flywheel; I did not ask the Brain a fresh usage-learning question for pi-brain or SONA this round. Marked as the next questions.
- No measured improvement from any idea here. Every test above is pre-registered, not run. The machine is throttled and I ran nothing.
- "Temporal lineage" evidence for rUv's own habits across repos was not mined (no pass over commit history or CLAUDE.md files in other repos).
- 98% is undefined without the lead's metric; the tests above each state their own pass bar and none is a 98% claim.

## Order I would build in (by cost against the question types fixed)

1, 3, 10, 11, 18 first (S, mostly extraction from rUv's own tables and one sort rule), then 2, 4, 13, 14, 15, 22, then 5, 6, 8, 9, 16, 17, then 19-21 only with the gate in item 21 in place.

---

# ADDENDUM 2026-11-17: usage learning (code read), rUv's habits, round-3 leftovers

Added at the coordinator's request. Existing text above is unchanged except one correction: item 19's weights (65/15/20/10) are not a 110% error; the 10 is an MMR diversity penalty (agentic-flow reasoningbank/config/reasoningbank.yaml:10-13). Log entries: U-1..U-2, H-1, P3-1..P3-3, plus U-3 (code read) in `ruvector-deepdive/BRAIN-QUESTION-LOG.md`.

## A. What learns from usage, and whether it runs (code read)

| System | What runs (code) | What is documentation only | Lesson for our store |
|---|---|---|---|
| ReasoningBank, agentic-flow `src/reasoningbank/core/` | retrieve (0.65 cosine + 0.15 recency, 45-day half-life, + 0.20 reliability, - 0.10 MMR penalty), judge, distill, consolidate (LSH dedup at 0.87, contradiction 0.60, prune at 180 days or confidence < 0.30), post-task hook | the "4-phase closed loop" prose in agent prompts | A cheap proven recipe. Weakness: without an API key `heuristicJudge` (judge.ts:148-170) marks success if no "error" text and a "complete" text, confidence fixed 0.5. A learning loop on a weak judge writes noise; our promotion needs a real judge or none |
| SONA, RuVector `crates/sona` (6,231 lines) | instant loop per trajectory (micro-LoRA), background loop with k-means++ pattern extraction, EWC++, darwin_guard; no placeholder hits | weekly "dream" loop schedule is a doc comment; whether any product schedules it was not shown | Learns weights and pattern centroids, not retrieval ranking. In ruflo `learning-bridge.ts` degrades to a no-op when the neural system is missing |
| pi-brain / mcp-brain-server | votes: Beta(1,1) accuracy `(up+1)/(n+2)` once min observations met (reputation.rs:22-45), vote tracker rebuilt from persisted scores (no re-voting), SONA re-rank and trajectory record, 0.05 curiosity bonus (ADR-076) | the claim of "four AGI capabilities operating in production" is ADR text | rUv's own ADR lists the feedback-loop risk (popular gets more popular). A usage signal must be capped and held out |
| ruLake | nothing learned from usage (no learn/usage code in core/src) | none | A cache with generations: good for reproducibility, not for learning |
| agenticow | "learn" = embed ops, ingest into the branch; wired end to end per README (ADR-202); native cross-branch ANN recall@10 about 1.0 on linux-x64 (README figure, dataset not stated) | README status | Branches are the rollback unit for any learned update (supports MISSING-PIECES 21) |
| metaharness flywheel / Darwin | real package files (gate, lineage, budget, production-replay); learns by evolving harness candidates against a gate | none found | Offline promotion machinery, not end-user usage learning |
| agentdb SkillLibrary / ReflexionMemory | SkillLibrary read in round 2 | ReflexionMemory not re-read | unchanged |

Conclusion: "learning from usage" in rUv's stack means three different things: (1) memory distillation with a judge (ReasoningBank), (2) weight/centroid updates from trajectories (SONA), (3) human or agent votes (pi-brain). Only (1) and (3) are cheap enough for a retrieval store, and both need guards against self-reinforcement.

## B. How rUv works (habits, from clone files and git history, with sources)

1. Start: CLAUDE.md at repo root with identical "Behavioral Rules" in ruflo, RuVector (ruflo/CLAUDE.md:7-16; RuVector/CLAUDE.md): do exactly what is asked, edit over create, never write docs unless asked, read before edit, never commit secrets, files under 500 lines, validate at boundaries, TDD London School, DDD bounded contexts. Newcomer-facing: QUICKSTART and the discover-plugins "I need to..." table (M-2).
2. Default stack: Rust crates + NAPI-RS binaries (recurring "chore: Update NAPI-RS binaries for all platforms") + WASM + TypeScript/npm; npm publish from one authenticated `ruvnet` session; agents invoked as `npx @claude-flow/cli@latest ...` (conflicts with the owner's machine rule of never `npx ruflo@latest`: a newcomer-facing contradiction the KB must surface, not hide).
3. Swarm habit: hierarchical topology, max 15, MCP init plus Task agents in one message, named agents, SendMessage not polling, one writer per worktree (ruflo/CLAUDE.md:68-112, 585, 720). His own newest ADR (ADR-333) argues the 3+ file auto-swarm default wastes 3 to 7x tokens and proposes self-refine first (Proposed; paper figure 7.4x, not his measurement).
4. Release discipline (ruflo/CLAUDE.md:963-1084): only `latest`, no alpha/next tags (ADR-513, 2026-10-31), `files` allowlists, verify `npm view` for all three packages before saying published, a guard that checked zero leaves must not report clean.
5. Decision records: an ADR for nearly everything, with "Status: Proposed/Accepted/Implemented", "Alternatives considered" (rejections recorded), pre-registered hypotheses, matched-budget baselines, preserved negative results and bugs caught by tests (ADR-344 is the model; P3-1). Numbers are per repo, not global (ADR-150 means three different documents; P3-2).
6. Honesty habits, in his own files: "Not measured: prior 2.49x-7.47x figure was inherited from upstream marketing" (ruflo/CLAUDE.md:835); "Honest status (ADR-202)" in agenticow README; "Proposed ... synthetic-benchmark scale only" at the top of ADR-344; ADR-313's rule to check `git log` before repeating an inherited bug claim.
7. Cadence: ruflo 417 commits in 2026-09, 2,086 in 2026-10, 481 in the first 13 days of 2026-11; commit mix fix 121 / chore 38 / test 37 / feat 30 / docs 11 / release 6 / dream 6 (last 400). Nightly "dream" agent cycles open `dream/<date>-<topic>` branches merged by PR (e.g. #4961); agent-authored ADRs are marked "Authors: claude (dream-cycle agent)".
8. Anti-patterns he states: swarm for one-file tasks (ADR-333); polling after spawning; two writers in one worktree; hard dependency where optional was required (ADR-313/ruflo ADR-150 rule 2); promoting an optional dep silently (rule 4's `--ignore-optional` CI job); pre-release tags; claiming an inherited number without a source.

New ideas from this addendum (add to the list above; same fields):

| # | Idea | Source | Form | Fixes | Cost | Pre-registered test |
|---|---|---|---|---|---|---|
| 24 | "How rUv builds" playbook cards: the swarm/no-swarm rule, release checklist, ADR template, worktree rule, each with a quoted source line | ruflo/CLAUDE.md:68-112, 963-1084; RuVector/CLAUDE.md | storage | H, A | S-M | 20 "how should I start/release/organise" questions; two blind graders check the card's steps against the quoted lines; pass at 85% |
| 25 | Contradiction cards where rUv's sources disagree (npx vs global binary; QUICKSTART alpha vs plugin catalog; ADR-333 vs the 3+ file swarm rule) | M-2, H-1, this addendum | storage | A, H | S | 10 questions whose naive answer follows the stale source; pass if the card names both and says which is newer by date |
| 26 | Decision-record template cards (hypothesis, pre-registered criteria, matched baseline, negative result kept) as the promotion form for our nightly update | ADR-344 (P3-1) | storage + process | nightly update | S | Our next promotion is written in this form; a reviewer checks all five fields |
| 27 | Key ADR lookups by repo + number, never number alone | ADR-313 text on ADR-150 collision | storage | E | S | 10 queries "ADR-150" with a repo hint and without; pass if the right document ranks 1 given the repo and the Brain asks to narrow otherwise |
| 28 | Judge-quality guard on any learned memory (no heuristic-judge writes below a stated confidence) | judge.ts:148-170 | query/promotion-time | all | S | Seed 20 failing trajectories containing the word "complete"; the guard must block all |

## C. Round-3 leftovers, results

- ADR-344/ADR-299: found (P3-1): not wired, synthetic scale; the method is the reusable part (item 26).
- ADR-313: found (P3-2); ADR-315 not returned, existence not confirmed.
- sona trajectory to patterns: covered by U-1 (k-means++ in reasoning_bank.rs:162).
- ReasoningBank: code read (section A).
- exo-temporal consolidation: real 325-line file, SIMD cosine, sampled surprise, no stubs; example workspace.
- hnsw seed lines: test-only; the README recall numbers come from LCG-generated synthetic vectors.
- Not done: ADR-315, a Brain question on agentdb ReflexionMemory, mining the other repos' CLAUDE.md files (agentic-flow 193 lines, not read), and any commit-history mining for agentdb/agenticow/RuLake (single-commit snapshots, no history exists in the clones).
- Stop condition: this follow-up still produced new design items (24-28), so a no-new-findings round was not reached. Brain calls this follow-up: 5 of 20.
