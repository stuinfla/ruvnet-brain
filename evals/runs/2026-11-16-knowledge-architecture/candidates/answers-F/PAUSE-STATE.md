# PAUSE STATE (2026-11-16, 11:5x p.m. ET) — paused on the owner's order via the lead; nothing deleted, nothing running

RUN = /Users/stuartkerr/Code/ruvnet-brain/.claude/worktrees/agent-a605de6750254d5d5/evals/runs/2026-11-16-knowledge-architecture
cd $RUN/candidates/answers-F ; S=../answers/scripts ; Q=$RUN/instrument/F/F-verified.json

## Complete
- Set F (80 questions, F-verified.json sha256 436ac29b...a806d), arms A and D: 240 answers each (3 runs x 80), no errors, NOT judged.
  Files: answers-AD.jsonl (combined, 480), answers.jsonl (A), answers-D.jsonl (D), mechanical.jsonl (A), mechanical-D.jsonl (D) (mechanical checks done).
- Set E: arms A, C, D judged (see ../answers/README.md, answers.table.md, answers-R9.md). Gold-served table done.
- Arm B on E: 63 of 252 answers (run 1 partial), judged partial section in answers.table.md; runner stopped.
- Arm C on F: not started.

## Resume commands (do nothing until the lead says so)
1. Finish answers (idempotent; skips done rows): KA_DIR=$PWD KA_QFILE=$Q node $S/run-answers.mjs --par 4 --arms A,D --tag F-D --out $PWD/answers-AD.jsonl
2. Mechanical check: node $S/check-refs.mjs answers.jsonl mechanical.jsonl ; node $S/check-refs.mjs answers-D.jsonl mechanical-D.jsonl
   (split first if answers-AD.jsonl grew: A rows -> answers.jsonl, D rows -> answers-D.jsonl)
3. Judge batch 1 (A and D on F + 30 E answers re-judged as consistency):
   ARMS=AD PREFIX=F node $S/make-judge-items-F.mjs 1 30
   KA_QFILE=$Q node $S/judge-run.mjs answers-F/judge-items-1.jsonl answers-F/judge-grades-1.jsonl --par 4   (run from candidates/)
4. Tables: KA_DIR=$PWD KA_QFILE=$Q node $S/analyze.mjs   (writes answers.table.md, answers-R9.md, per-answer.jsonl, manifest.json here)
5. Arm C on F (3 runs): KA_DIR=$PWD KA_QFILE=$Q node $S/run-answers.mjs --par 4 --arms C --tag F-C --out $PWD/answers-C.jsonl ; then check-refs, ARMS=C PREFIX=F node $S/make-judge-items-F.mjs 2 0, judge, analyze. (analyze.mjs reads answers.jsonl + answers-D.jsonl; add C rows to answers.jsonl or adapt the join.)
6. Arm B on E (from candidates/answers): runner with --arms B --loadmax 55 --par 1 only when load < 35; then SKIP_JUDGED=1 ARMS=B PREFIX=B node $S/make-judge-items.mjs ..., judge, analyze, node $S/b-partial.mjs.

## What each decides
- F arms A vs D: does the shipped-style lookup without concepts beat no tools on harder asker questions (which-tool, troubleshooting, design-rationale, cross-repo, build-task, history)?
- F arm C vs D: does the CONCEPTS section add answer quality beyond files and history.
- E-consistency re-judges: whether the Opus judge scores stay stable across batches.
- Arm B: the shipped 4.7.28 server as the real-world baseline against C/D.
