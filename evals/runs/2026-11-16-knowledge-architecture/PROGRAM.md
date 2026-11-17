Updated: 2026-11-17 00:54:00 EST | Version 1.0.0
Created: 2026-11-17 00:54:00 EST

# RuvNet Brain v5 programme: state, decisions, queue

Purpose of this file: the programme must not depend on one agent session. Anyone who takes over reads this
file and the documents it names, and can continue. It is updated at every change of state. Times are Eastern.
RUN = `evals/runs/2026-11-16-knowledge-architecture/` in worktree `.claude/worktrees/agent-a605de6750254d5d5`
(branch `worktree-agent-a605de6750254d5d5`; `v5/rewrite` points at commit 78172389 on it).

## 1. How a new programme owner gets up to speed (reading order, about one hour)

1. `docs/brain-research/OWNER-NOTE.md`, then `README.md`, `EMBEDDING-RECIPE.md` in the same folder (what
   ships today and why; committed).
2. RUN/`REPLAN.md` (the direction after the research) and RUN/`ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md`
   with `ORIGIN-AND-PHILOSOPHY.md` (rUv's own memory design: cue, tag, content).
3. RUN/`DECISIONS.md`, D0 to the last entry (every decision with its numbers; read the newest five first).
4. RUN/`PREREGISTRATION.md` (rules R1 to R10 and amendments A1 to A12; `PREREGISTRATION.sha256` lists every
   hash). Nothing is scored without a rule here first. Thresholds are never edited after a result.
5. RUN/`app-architecture/TARGET-ARCHITECTURE.md` and `ROADMAP.md` (the v5 application design and build order
   by the v5 architect), then RUN/`MISSING-PIECES.md` and RUN/`SURVEY-2026.md`.
6. RUN/`PAUSED.md` and section 4 below (what is running, held, or waiting).
7. Project memory: `ruflo memory search -q "ka-run" --path /Users/stuartkerr/Code/ruvnet-brain/.swarm/memory.db`
   (keys `ka-run-2026-11-16-*` and `ka-run-2026-11-17-*`).

## 2. The owner's goals and the fixed protections

Goals: RuvNet Brain v5 as a full rewrite; it must find, answer AND guide (a novice states a goal and gets the
right tools in a workable order, the way rUv builds). Green light for the full rebuild with a recipe only when
that recipe reaches 93% or better on the owner's measure on the pre-registered blind sets with the independent
blind grader; aim 98%. It works for amateurs or it does not ship.
Fixed: pre-registered rules and blind grading; builder never grades its own work; every release gate in
CONTRIBUTING.md stays on; no secrets committed; no deletion or overwrite of private stores, AgentDB or the
owner's data without a verified backup (deletions through `del`, ledger reported); the owner's folder stays on
`main`; cutover gated by soak and a verified on/off brake; machine load under about 60 with ONE heavy job at a
time; measurements, not verdicts.
Who does what: the programme owner plans, decides, builds and verifies through agents. It does NOT commit,
push, open PRs or release. Hand-off format to the parent session: branch, exact file list, checks run with
output; the parent session (or a release owner it launches) commits and releases.

## 3. Where the evidence stands (numbers with their files are in DECISIONS.md)

| Question | State | Number |
|---|---|---|
| Shipped 4.7.28, right file in the top 5 | measured | 4 of 113 (dev), 8 of 164 (E), 4 of 27 so far (F) |
| Rebuilt passages + keyword lane | admitted (three blind sets) | 78 of 164 (E), 41 of 68 (F), 15 of 120 (G, all amateurs) |
| History lane as its own section | admitted | 17 of 21 (E), 8 of 12 (F) |
| Current passage vectors fused in | not admitted | no gain on E, F, G |
| Concept cards (half coverage) | not admitted | failed confirmation on F and the answer-level ablation |
| Answer level, E sample of 84, 3 runs | measured | no tool 25.4; files + history 73.1; shipped 60.8 (49 questions, 1 run) |
| Two gaps | measured | gold reached the answering session in 72.5% of answers (amateurs 54%); when it did, 72% reached 8 of 10 |
| Amateur problem-only questions (set G) | measured, the hard number | keyword lane 12.5% top-5; right file in the first 100 for about a third |
| rUv-design slice (cues, graph walk, need index) | being built | interim look due about 2:00 to 3:30 a.m. 2026-11-17 |
| Embedding model | open by owner order | no RuVector-native retrieval model exists; proposal: a small model on cue sentences |
| Guidance (set H, rule A10) | question set being written | no measurement yet |

## 4. Jobs (state at 12:54 a.m., 2026-11-17)

Running:
- Slice extraction (Sonnet calls, parallelism follows load: 4 below 50, 2 to 100, 1 above): about 1,050 of
  9,029 units; tiers per A8; markers `tier1.done`, `tier2.done` in
  `/Users/stuartkerr/Code/RVF-KnowledgeBases/ruvnet-brain-ka-20261116/slice/`; scripts in RUN/`candidates/slice/`.
- Slice builder (Opus), THE one heavy job, gated at load 60: rUv's `TypedGraph::search_then_traverse` built from
  source; need index in RVF; author-written cues (2,698) and playbooks (349) parsed from rUv's own tables;
  centroid landing; two looks per A8 (interim, then final at tier 2). Output: RUN/`candidates/slice/`
  (`FROZEN.md` before any blind score).
- F answer judging (Opus judge, parallelism 2): RUN/`candidates/answers-F/`.
- Set H authors (2 Opus): RUN/`instrument/H/H1.json`, `H2.json`; the lead re-verifies quotes, then merges.
- v5 walking skeleton builder (Opus, own worktree, uncommitted): roadmap A2, tests S1 to S14 each shown red on
  its break; reports its worktree path at the end.
Held, checkpointed, resume files named in RUN/`PAUSED.md`: re-ranker test (measured 1.5 pairs a second under
load: run only on an idle machine); query-rewriting test A4.2 / A9.1 (276 of 330 rewrites written; the
cheapest untested lever, resume first when load allows); embedder screen (resume only rUv's two small models
and gte on blind sets); side-by-side document (DRAFT; needs about 50 shipped queries); informed-query ladder
(shipped half only on an idle machine). Not to be run: stage 2 full re-embed; three shipped-arm runs.

## 5. Queue, in order

1. Slice look 1 (interim), then look 2 (rules judged). Report amateurs first, against the keyword + history
   lanes and the shipped Brain on the same questions. If the graph design does not beat them, say so.
2. `RECIPE-FINAL.md` (due 6:00 a.m.): the recipe as a buildable component spec for v5 work packages 1 and 5.
3. Query-rewriting test (A4.2, A9.1) on E, F, G: model calls plus light keyword runs.
4. Set H verified; calibration set for guidance (A10.4); answer-level run on H: no tool, files + history,
   files + history + playbooks.
5. Judge F; finish SIDE-BY-SIDE.md.
6. Re-ranker test and the full-precision test (A8.5) on an idle machine.
7. The instrument for 93% / 98%: at least 300 questions per group, gold confirmed by a second author,
   success in 2 of 3 runs. Today's sets cannot separate 93% from 98% (D14).
8. v5 build, per `app-architecture/ROADMAP.md`:
   - Stage 1: walking skeleton (running). Exit: S1 to S14 green and each shown red; contract ready to tag.
   - Wave one, after the skeleton is merged by the integration owner: WP1 engine (branch `v5/wp1-engine`),
     WP4 installer (`v5/wp4-installer`), WP5 builder (`v5/wp5-builder`). Opus builders, one worktree each.
   - Wave two: WP2 server (`v5/wp2-server`), WP3 health (`v5/wp3-health`), WP6 release rail
     (`v5/wp6-release`), WP7 host shims (`v5/wp7-shims`).
   - Then WP8 answer gate (wires this run's question sets and rules into the release rail), WP9 migration,
     WP10 guard, WP11 generated documents; WP12 independent review by an agent that built nothing; WP13 soak
     beside 4.7.28 on the owner's machine, then cutover as release/5.0.0 through CONTRIBUTING.md.
   - Retrieval layers enter later as lanes plus pack files, each only after its pre-registered rule passes:
     cue layer and small model (WP14), re-ranker (WP15), graph walk and typed abstention (WP16), learning from
     use on a private branch (WP17), playbooks / guidance section (new, rule A10.3).
   - v5's base recipe needs nothing unproven: keyword lane + history lane + sections + size cap + explicit
     "nothing matched". That is what work packages 1 and 5 build first.
9. 4.7.29 hotfix: owned by the release owner the parent session launched; its result is an input here (the
   node-path defect, the oversized-result defect and the read-only sidecar rewrite are in
   RUN/`architecture/ARCHITECTURE.md` section 7).

## 6. What from RUN belongs in the repository

Commit (small, durable, no private text): `PREREGISTRATION.md`, `PREREGISTRATION.sha256`, the `append_a*.py`
scripts, `DECISIONS.md`, `REPLAN.md`, `PROGRAM.md`, `PAUSED.md`, `RECIPE-FINAL.md` (when written),
`SIDE-BY-SIDE.md` (when finished), `SURVEY-2026.md`, `MISSING-PIECES.md`, `architecture/ARCHITECTURE.md`,
`app-architecture/`, `ontology/ONTOLOGY.md`, `ontology/TRAVERSAL-BRIEF.md`, `ontology/merge_ontology.py`,
`ruvector-deepdive/*.md` (not `raw/`, `probes/`), `history/*.md` (not `evidence/`, `bisect/` raw files),
`inventory/sources.md`, and the small `*.md` rule and table files under `candidates/` (not JSONL).
Do NOT commit: `instrument/` (the blind question sets and their gold: the corpus indexes this repository, so
committing them would contaminate every future measurement; keep them outside any indexed repository and
record their hashes only); `ontology/ontology-merged.json` and `ontology/T4-ideas.json` (they contain items
drawn from private meetings); all `candidates/**/**.jsonl`, vectors, SQLite files, models; anything under
`/Users/stuartkerr/Code/RVF-KnowledgeBases/ruvnet-brain-ka-20261116/` (scratch stores).

## 7. Deletion ledger for this run

Agents reported: scratch files of their own removed with `del` (validator scratch, pause notes); two `rm`
uses on an agent's own failed scratch files (history index attempt; one concept-rig scratch file), disclosed
in their reports. Nothing under `~/.cache/ruvnet-brain`, the pilot folder or the owner's data was deleted.
Nine shipped `.idmap.json` sidecars were rewritten with identical bytes by a read-only open (D11).

## 8. Redaction (1:02 a.m., 2026-11-17)

Eight research files named private stores, clients or people. Their unredacted originals were MOVED out of
the repository to `/Users/stuartkerr/Code/RVF-KnowledgeBases/ruvnet-brain-private-originals-20261117/` (same
relative paths). The files now under the original names in RUN are the public versions (names replaced by
neutral labels, every finding kept): `app-architecture/DEFECTS.md`, `app-architecture/ROADMAP.md`,
`review/REVIEW.md`, `history/BISECT.md`, `history/CURRENT-EMBEDDING-STRATEGY.md`, `history/STORY.md`,
`history/VERSION-TABLE.md`, `history/HISTORY.md`. The label-to-name mapping is not in the repository.
Rule from now on: any research file is checked by `redaction/REPORT.md`'s method (private-name list and the
8-word question-overlap check) before it is handed over for commit.

## 9. Corpus nightly is DISABLED (owner decision, executed by the parent session at 1:12 a.m., 2026-11-17)

1. The hosted workflows `corpus-nightly-dispatch` and `corpus-watchdog` are disabled until the v5 build and
   update path replaces them. Reversible with `gh workflow enable <name> --repo stuinfla/ruvnet-brain`. The
   in-progress corpus release run 44023686696 was cancelled while still sealing a candidate; nothing was
   published. Still running: the local brain-update scheduled job and the gists nightly (not corpus).
2. Re-enabling both workflows (or replacing them with the v5 release rail's nightly dispatcher and watchdog,
   roadmap work package 6) is a CUTOVER CHECKLIST ITEM. Cutover is not complete while they are off.
3. Known limitation until then, to state in the cutover plan: the knowledge installed on users' machines stays
   at the last published corpus generation; new upstream work by rUv does not reach users.

## 10. State at 2:00 a.m., 2026-11-17 (supersedes sections 3 to 5 where they differ)

Evidence added (numbers and files in DECISIONS.md D21, RECIPE-FINAL.md):
- Set F at answer level: no tool 23.8, keyword + history 77.8 of 100. Owner's measure (8 of 10 or better in at
  least 2 of 3 runs): experts 16 of 17, practitioners 24 of 31, amateurs 17 of 32. The 93% gate is not met.
- Blind query rewriting (A4.2) and the caller-side arm (A9.1): not met as registered; on problem-only amateur
  questions the hit rate goes 12.5% to 34.2% when the original list is kept. A confirmation is owed.
- Slice look 1 (interim; build failed its soundness checks; 1,617 of 9,029 units): amateurs 18 of 101 for the
  keyword lane, 46 with the need index, 50 with the graph walk, at equal slots. Walk unstable across processes;
  fixed by a registered sort for look 2 (A15).
- Pre-registration is at amendment A15 (v1.15.0).

v5 build: walking skeleton committed by the parent session as 1c994dfc on `v5/rewrite` (14 of 14 acceptance
tests, every break red). Wave one launched 1:42 a.m.: `v5/wp1-engine` (also the single owner of root gate
wiring), `v5/wp4-installer`, `v5/wp5-builder`; each builder in its own worktree, uncommitted, hand-off format
as in section 2. `packages/contract` is frozen; tag `contract-v1` after wave one reports no change request.

Running: extraction tier 2 (expected about 3:05 a.m.); slice builder (shipped runs on F and G slice questions,
then look 2 at `tier2.done` or 4:30 a.m.); set H answers and judging (`candidates/answers-H/`), then the A14.2
answer test on the 65 amateur slice questions (`candidates/answers-G/`); three wave-one builders.
Held: re-ranker, embedder screen on passages, side-by-side document, bisect arms, shipped ladder.

## 11. State at 4:15 a.m., 2026-11-17 (supersedes section 10 where they differ)

Read first: RUN/`RECIPE-FINAL.md` (version 1.0), then DECISIONS.md D21 to D24 (D24 corrects D23).
- Admitted recipe = Tier 1 only (keyword lane, history lane, sections, cap, explicit "nothing matched"). No
  embedding model. Owner's measure with it: experts 16 of 17, practitioners 24 of 31, amateurs 17 of 32 (F) and
  36 of 65 (G slice), guidance 4 of 40 (H). The 93% gate is not met; the full rebuild is not triggered.
- Not admitted, each by its registered rule: passage vectors, concept cards, rewriting as registered (A4.2,
  A9.1), keyword-chosen playbooks (A10.3), capability descriptions (A14.2, A16), need index (A6.4 thresholds
  met numerically on a build that failed its soundness checks; A18 at answer level +4.6 [-6.2, 16.9], not
  met), graph walk (no gain over the need index; tuned settings not adopted). A17 is void (host delivery).
- Host delivery limit: results above about 50,000 characters are rejected by the host. Cap is now 44,000
  characters and 20,000 estimated tokens, server-enforced. v5 commit 3dff2bc7 still has 60,000 and test S5
  checks 60,000: the wave-two integration must change both. Audit: RUN/`candidates/answers/HOST-DELIVERY.md`.
- Pre-registration is at amendment A18 (v1.18.0). Sets G and H have been used two and three times: no further
  admission decision may use E, F, G or H. Next instrument: 300 questions per group at least (about 700
  amateurs to resolve a 5-point difference), two authors per gold, two gold plans per guidance goal.
- v5: skeleton 1c994dfc; wave one integrated 3dff2bc7 (tag `contract-v1`), both committed and pushed by the
  parent session. Wave two launched 3:35 a.m. from 3dff2bc7, four builders in their own worktrees:
  `v5/wp2-server` (also the delivery cap and the private-pack project check), `v5/wp3-health`,
  `v5/wp6-release` (sole owner of root and CI wiring; workflows named `v5-*`, inert until cutover),
  `v5/wp7-shims` (must close the planted-`node` weakness, test wp4-12). Then one integration owner produces a
  single tree; the lead re-runs the suite and the break runner by absolute path and hands off in the agreed
  format; the parent session commits. After that: draft PR for remote CI (ask the parent session), then
  WP8 answer gate, WP9 migration, WP10 guard, WP11 documents, WP12 independent review, WP13 soak and cutover.
- Slice extraction stopped at 3:27 a.m. (tiers 1 and 2 complete; tier 3 at 537 of 5,780; resume with
  `node run-extract.mjs --par 4` in `candidates/slice/`). Not needed until a cue-based part passes at answer level.
- Running at 4:15 a.m.: wave-two builders; shipped 4.7.28 at answer level on the 65 amateur questions (one
  run, information only); the two old-release bisect arms (load-gated at 40).
- 5:30 a.m. update: wave two is integrated in worktree `agent-aab9c891092aae788` (branch
  `v5/wave2-integration`, from 3dff2bc7, uncommitted, handed to the parent session at 5:27 a.m.): 84 tests (83
  pass, 1 opt-in skip), 135 breaks red in one run, re-run by the lead; real host settings files unchanged.
  It contains the 44,000-character / 20,000-token delivery ceiling. Host registration is off by default
  (`install --register-hosts`). Next v5 steps after the parent session commits it: draft PR for remote CI
  (Linux, Windows); WP8 answer gate (wire a frozen question set and the owner's measure into
  `packages/release/gate/gate.mjs --release <dir> --out <file>`, which the release-candidate workflow already
  calls); the trusted public key (roadmap A1); WP9 migration from 4.7; WP10 guard; WP11 generated documents;
  WP12 review by an agent that built nothing; WP13 soak and cutover. Cutover checklist items collected so far:
  re-enable or replace the corpus nightly and watchdog; make 4.7's release-candidate-preflight skip
  `release/5.*`; add schedules and `V5_NIGHTLY=on`; switch host registration on; hook start-up time measured
  on a quiet machine (p95 192 ms at load 27 against a 150 ms target); Windows launcher executed on Windows.
- Shipped 4.7.28 at answer level on the 65 amateur questions (one run): 56.5 against 69.2; old-release arms:
  no past release found the right file on the bisect questions (D25).
- Scratch rule from now on: every agent gets its own scratch subfolder (a builder's cleanup removed another
  agent's file from the shared folder; nothing of the owner's was lost).
- Upstream reports owed to rUv, with reproductions: graph store edge order differs per process
  (`candidates/slice/look1-checks.md`); the memory walk scores and abstains on question-to-content similarity
  (`ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md` section 8d).
