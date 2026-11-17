# Ladder run: PAUSED (owner order). Nothing deleted. Nothing running (pgrep checked).

## UPDATE (second pause): A4.2 / A9.1 only (ladder and shipped runs stay out of scope)
Done since the first pause: set G added (paths.json, make_gold.py); arm-A blind rewrites 276 of 330 file-gold E+F+G questions (rewrites.jsonl, Sonnet, parallelism now 2); arm-A lexical lane partial: rewrites-lex-1.jsonl has 44 rows (kept; ids in it count as done). Scripts written: lane_rw.py (A|B, chunks of 60, waits while load > 60, one bm25 at a time), rewriter_b.py (A9.1 arm: kind, 3 queries, terms; writes rewritesB.jsonl; none written yet), a42-score.mjs, a42-tables.py (-> a42.jsonl, a42.md), pipeline.sh (older ungated version; do not use as is, see below). Original-question lexical lane for G: candidates/rigG/v2-bm25.jsonl had 98 of 120 rows when checked (another agent's run; re-check before scoring).
Resume, in order (each resumable):
1. `python3 make_gold.py`
2. `nohup python3 rewriter.py sonnet E F G > rewriter4.log 2>&1 &`  (finishes arm A rewrites)
3. `python3 rewriter_b.py sonnet E F G` (arm B rewrites, after step 2 so calls stay at 2 in parallel)
4. `python3 lane_rw.py A` then `python3 lane_rw.py B`
5. `RIG_SCRATCH=<SCRATCH from paths.json> node a42-score.mjs && python3 a42-tables.py` (A4.2 table, extras, A9.1 arm, rule readings).

All commands run from this folder (candidates/ladder). Unset ANTHROPIC_* for model calls (the scripts do it). Machine rules from the owner still apply: shipped queries only when gate.mjs says so (load < 35, no embed-pool, no claude -p answer runner, no foreign worker, no other shipped harness).

## Complete
- Scripts copied unchanged from rigE: bm25-run-rig.mjs, build-fts-rig.mjs, lucene-bm25.ts, hist-run-rigE.mjs, score-rigE.mjs, score-retrieval.mjs, ask-shipped-rigE.mjs. New: paths.json, lib.mjs, score-cli.mjs, score-ladder.mjs, sample_build.py, make_gold.py, mkq.py, writer.py, rewriter.py, lanes.sh, gate.mjs, patch_runner.py (builds ask-shipped-ladder.mjs), tables.py.
- sample.json: E 60 of 151 eligible (30 amateurs), dev 20 of 109 eligible. F NOT sampled yet (needs the shipped-on-F run complete, candidates/sbs/F-shipped-raw.jsonl had 26 of 80 when paused). Rung 0 dev scored: rung0-dev-scored.jsonl.
- Informed writer (Opus, claude-opus-5-5): queries-raw.jsonl 80, queries.jsonl 80 (after leak check: 1 first draft leaked, 1 rewrite call). E and dev only.
- ladder-A-lex.jsonl: 240 of 240 lexical lane results for those 80 questions x 3 rungs (done).
- gold-min files E, F, dev, dev-questions-min.json.

## Incomplete (resume in this order)
1. Blind rewrites (A4.2; decides whether query rewriting enters the recipe): 191 of 210 file-gold E+F questions written by Sonnet (claude-sonnet-5-5), rewrites.jsonl. Resume (resumable): `nohup python3 rewriter.py sonnet E F > rewriter3.log 2>&1 &`. (Calls in flight at pause may have finished but their rows were not written.)
2. History lane for ladder A: ladder-A-hist.jsonl is partial (71). It is rewritten from scratch: `./lanes.sh ladder-queries-A.json ladder-A hist`. Do NOT rerun lex for A (done).
3. Dev rung 0 lanes: `./lanes.sh dev-questions-min.json dev-0` (writes dev-0-lex.jsonl, dev-0-hist.jsonl; not produced yet).
4. Blind-rewrite lanes (lexical only is used for A4.2): `python3 mkq.py && ./lanes.sh rewrites-queries-min.json rewrites lex`, then `cp rewrites-lex.jsonl rewrites-lex.jsonl` is already the name score-ladder.mjs reads; ladder-A-lex.jsonl must be copied to ladder-lex.jsonl and ladder-A-hist.jsonl to ladder-hist.jsonl (`cat` the batches).
5. F: when sbs/F-shipped-raw.jsonl has 80 rows: `python3 sample_build.py F`, `python3 writer.py F`, `python3 mkq.py` (then run the F ladder queries through lanes.sh as batch B and concatenate).
6. Shipped ladder (A4.1; decides whether the index can surface the answer for an informed query, fixed bands 50%/80% at rung 3): `RUVNET_...` not needed; `nice -n 10 node ask-shipped-ladder.mjs ladder-queries-min.json ladder-shipped.jsonl 2> ladder-shipped.log` (ladder-queries-min.json holds the shipped-bound rung queries; restrict to the rung ids of the sample). Gated and resumable. Gives up after 3 h of a closed gate.
7. Score and tables: `RIG_SCRATCH=<SCRATCH in paths.json> node score-ladder.mjs && python3 tables.py` (writes per-query.jsonl, a42.jsonl, ladder.md). Still to write: queries.json, manifest.json (hashes, models, seeds, date), README.md.

## Meant to decide
- A4.1: whether the shipped index fails even for informed queries (rung 3 cumulative < 50%) or only misses the bridge from naive wording (>= 80%), plus what the candidate lanes reach on the same queries.
- A4.2: whether blind query rewriting is admitted (amateurs E+F pooled: +10 points, exact McNemar p < 0.05, no asker group down more than 3 points), plus the upper bound with informed rung-1 queries.
