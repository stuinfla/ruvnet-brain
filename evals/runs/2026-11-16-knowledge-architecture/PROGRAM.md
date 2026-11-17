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
