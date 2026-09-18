# The 8-dimension grading rubric — CANONICAL, reuse verbatim

Updated: 2026-09-17 18:31:22 EDT | Version 1.0.1
Created: 2026-07-27

Preserved 2026-07-27 from a SESSION TEMP DIRECTORY, which was its only copy. This rubric is
what makes two gradings comparable; if it drifts or is lost, a re-score measures a different
thing and every before/after claim built on it becomes meaningless. It lives in the repo now.

Baseline it produced (2026-07-27, on the QE APPARATUS, not the product):
Fable 5 **53/100** · GPT-5.6-Sol **38/100** — per-dimension table in `docs/adr/0058-the-95-contract.md`.

**Re-score protocol:** both graders, this file verbatim, same SHA, both must land >=95.
One grader at 95 and the other at 60 is a 60. No self-score counts.

---

# GRADE THE QE SUITE AGAINST EXPERIENCE, NOT PASS COUNTS (owner mandate 2026-07-27)

The owner, verbatim in spirit: "Review the agentic QE test suite and make sure it is intelligent,
complete, and comprehensive for what we are trying to measure. We are NOT trying to measure that
things pass. When RuvNet Brain is working it should feel PROACTIVE and INTELLIGENT - like a smart
buddy sitting with you recommending things so it goes better. Everything has to feel smooth, clean,
effective. I want the LEVEL, QUALITY, COMPLETENESS, INTELLIGENCE and ELEGANCE of the suite graded."

## THE EIGHT DIMENSIONS TO GRADE (his words, made testable - this is the rubric)
D1 WORKS WELL - not "exits 0": correct under real conditions, real data, real machines.
D2 WORKS AS EXPECTED - matches the user's mental model, not the implementer's. A feature the user
   cannot find (yesterday: the brain switch buried in Settings) is not implemented.
D3 PROACTIVE - does it interrupt/offer at the right moment, unprompted, and is that MEASURED?
D4 DEMONSTRATES LEARNING - does the product visibly get better from real outcomes, and is the
   learning loop tested end to end (offer -> outcome -> changed behaviour), not just its parts?
D5 WORKS WITH THE USER'S EXISTING SYSTEM - coexistence with THEIR hooks, THEIR config, THEIR tools,
   on THEIR OS. Never assumes our machine.
D6 THE EXPERIENCE FEELS POSITIVE - latency the user feels, dead air, clarity of refusals, whether a
   first-time user smiles or uninstalls. Is any of that even measurable today?
D7 PROPER/CLEAN/EFFECTIVE - no half-states, no lies on any surface, no ceremony passing as substance.
D8 POST-IMPLEMENTATION CHECKLIST - MANDATORY and currently the weakest: anything we install on a
   stranger's machine must be provably harmless to THEIR prompts and THEIR hooks afterwards. A hook
   error on someone else's machine is an uninstall. What is the checklist, is it mechanical, does it
   run after install on THEIR machine, and can it fail?

## TASK
1. GROUND FIRST, DO NOT ASSERT: use the search_ruvnet MCP tool (or read ~/.cache/ruvnet-brain/kb) to
   establish what the agentic-qe fleet ACTUALLY ships (agents, MCP tools, CLI verbs, coverage/flaky/
   security capabilities) with cited source paths. Known caveat: qe_qx_analyze HALLUCINATES on remote
   URLs - verify anything it reports against the real artifact. The aqe binaries are installed; read
   their --help before claiming any flag.
2. INVENTORY WHAT WE ACTUALLY HAVE, by reading it: tests/unit (~1800 assertions, ~100 files),
   tests/integration, tests/mutation, plugin/test/run-tests.mjs (the 60-check battery), scripts/qe/*,
   scripts/eval-brain.mjs, scripts/falsify.mjs, scripts/claims-verify.mjs, scripts/hook-registry.mjs
   (new mesh lint), tests/unit/npm-tarball-codex.test.mjs (artifact-first), tests/unit/brain-off.test.mjs,
   the CI workflows, and docs/adr/0028 (test classes), 0053 (experience QA - SPECIFIED, mostly
   UNBUILT), 0055 (mesh + proactivity).
3. GRADE each dimension D1-D8 /100 with EVERY DEDUCTION EVIDENCE-CITED (file:line or a command +
   output). House rule: no inflated scores; a known architectural gap caps that dimension at <=70;
   include a "what I did NOT test" section per dimension. Then one overall grade with the same rigor.
4. NAME THE MISSING TESTS that would move each weak dimension, ranked by user-pain-avoided, each as a
   concrete test with its failure condition (what makes it go red).
5. Say where the real rUv QE fleet should GENERATE or RUN parts of this vs where a deterministic test
   is the right instrument - with the honest budget caveat (the $1,600 burn lesson: fleets get capped,
   never unattended loops).
6. ELEGANCE, judged not admired: is the suite's shape simple enough that a contributor can add the
   right test in the right place without being told? Cite examples of both good and bad shape.
7. HISTORICAL LIVE EVIDENCE, pre-retirement: verify-interface.sh false-POSITIVE-blocked a maintainer
   command because product prose inside a heredoc looked like an invocation. Issues #12, #13 and #44
   are the same regex-parsing-of-shell class. Grade what this says about D7 and about the suite's
   ability to catch its own gates misfiring.

Deliverable: the graded rubric (D1-D8 + overall, deductions cited), the ranked missing-test list, the
QE-fleet integration plan, and the elegance verdict. Numbered, concrete, no praise, no hedging.
State plainly what you could not verify.
