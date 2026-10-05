Updated: 2026-10-05 07:42:14 UTC | Version 1.0.1
Created: 2026-10-05 06:05:27 UTC

# North Star product capability rubric v1

This is a readable snapshot of the fixed rubric stored in the canonical project AgentDB. It grades product capability, separately from QE-apparatus grading and evidence coverage.

Authority: `.swarm/memory.db`, namespace `ruvnet-brain`, key `north-star-product-rubric-v1-1791177098594`.

Rubric ID: `north-star-product-capability-v1`. Canonical SHA-256: `a43ac8e6be3ee6bcc7b89c75073e6c4df799aab6964179b4878bc9c0f4cf8321`.

The project goals, categories and weights were recovered from stored North Star records. The five equal criteria and point anchors below were explicitly formalized on 2026-10-05; they are not claimed to be the missing historical point schedule.

Every category is graded out of 100. The target is at least 95 in **each** category; an average cannot conceal a failing category. Each category has five criteria worth 20 points apiece.

## Fixed scoring anchors

- **0/20:** Criterion capability absent, inoperative, or fundamentally unsafe in the assessed delivered product.
- **5/20:** Primitive/manual/disabled capability exists, but the intended ordinary behavior is mostly unavailable or has a blocking gap.
- **10/20:** Useful partial capability works in restricted or assisted cases; important normal-case behavior remains incomplete.
- **15/20:** Ordinary intended behavior is substantially usable; material edge, scope, reliability or integration limitations remain.
- **20/20:** Criterion is functionally complete across declared scope, with no material known defect and representative real-path support. This is not a guarantee of no bugs.

For every deduction, state the concrete shortfall and evidence. An unresolved material architectural flaw caps the affected category at 70. Missing verification reduces confidence; it does not automatically prove the capability absent. A full award requires representative real-path support.

Preserve these criteria, weights, anchors and cap for subsequent comparisons. Bind every assessment to the release source and explain each criterion change. A rubric amendment requires a new version and old/new grading of one common baseline.

The weighted overall grade is the sum of each category grade multiplied by its weight, divided by 100. Show exact and rounded values. The separately named F/B/N/J/R evidence-coverage score is not the product capability grade.

## Fixed categories and criteria

### Advocacy — weight 25%

- `advocacy-1` — Discover current existing capabilities (20 points).
- `advocacy-2` — Recognize ordinary needs and proactively activate (20 points).
- `advocacy-3` — Explain fit, evidence, cost and trade-offs (20 points).
- `advocacy-4` — Compose or apply the recommendation toward the outcome (20 points).
- `advocacy-5` — Respect refusal and retain useful offer outcomes (20 points).

### Learning — weight 5%

- `learning-1` — Automatically capture safe substantive experience (20 points).
- `learning-2` — Retain and deliver lessons in correct canonical scope (20 points).
- `learning-3` — Change executed outcomes through retained lessons (20 points).
- `learning-4` — Judge and promote beneficial learning safely (20 points).
- `learning-5` — Retain benefits across refresh, hosts and later tasks (20 points).

### Continuity — weight 20%

- `continuity-1` — Capture substantive goals, state and outcomes automatically (20 points).
- `continuity-2` — Append to canonical AgentDB with exact verified readback (20 points).
- `continuity-3` — Restore coherent actionable state at the next boundary (20 points).
- `continuity-4` — Resume across supported hosts and machines independently of private transcripts (20 points).
- `continuity-5` — Preserve correctness under growth, concurrency and interruption (20 points).

### Docs — weight 5%

- `docs-1` — Explain current outcome-oriented installation and use (20 points).
- `docs-2` — Keep commands, versions and support claims accurate (20 points).
- `docs-3` — Explain failure, recovery and owner action truthfully (20 points).
- `docs-4` — Provide usable installed rendered guidance and console (20 points).
- `docs-5` — Enable independent onboarding, update and resume without undocumented help (20 points).

### QA — weight 10%

- `qa-1` — Bind qualification and release to exact source/artifact identity (20 points).
- `qa-2` — Exercise supported runtime and platform boundaries (20 points).
- `qa-3` — Enforce all promised product obligations through real entrypoints (20 points).
- `qa-4` — Detect negative cases, unsafe actions and meaningful mutations (20 points).
- `qa-5` — Report outcomes, gaps and independent review truthfully (20 points).

### Grounding — weight 20%

- `grounding-1` — Maintain eligible current source corpus and provenance (20 points).
- `grounding-2` — Retrieve decisive sources for declared technical queries (20 points).
- `grounding-3` — Resolve representative plain-language or unfamiliar needs (20 points).
- `grounding-4` — Give faithful resolvable citations and evidence-bound answers (20 points).
- `grounding-5` — Handle stale, missing, poisoned and insufficient evidence safely (20 points).

### Ops — weight 5%

- `ops-1` — Install and activate the correct public generation (20 points).
- `ops-2` — Preserve private stores and user authority during updates (20 points).
- `ops-3` — Deliver unattended updates and truthful freshness (20 points).
- `ops-4` — Recover cleanly from failure and control storage footprint (20 points).
- `ops-5` — Expose accurate operational state and allow diagnosis (20 points).

### DevLoop — weight 10%

- `devloop-1` — Recall prior history and inspect live state before decisions (20 points).
- `devloop-2` — Discover and compose existing RuvNet/Ruflo capabilities (20 points).
- `devloop-3` — Route work within native subscriptions, authority and useful capacity (20 points).
- `devloop-4` — Execute isolated owned work with meaningful verification (20 points).
- `devloop-5` — Persist outcomes and resume the complete outcome-only workflow (20 points).

## Initial current-release assessment

The 4.5.7 assessment is stored as `north-star-product-score-current-1791177098594`, bound to source `f7ec936b5c760661d0806980a341cf781861f08d`. It records each award, deduction, confidence and limitation. Its weighted capability estimate is 54.75/100, rounded to 55. This is engineering judgment, not a measured task-success percentage or a controlled improvement over earlier incompatible scores.

Subsequent improvements require a new append-only assessment under this same rubric. Do not overwrite the baseline or infer a higher score merely from a passing release.

## Evidence-bound correction to the same public release

Assessment `north-star-product-score-current-1791186134236` retains this exact rubric and the 4.5.7 source. A newly reproduced unsafe cleanup classifier reduces `ops-4` from 10 to 0 under the existing fundamentally-unsafe anchor: a changed unknown file can be declared disposable merely because its pathname also exists in live. The read-only counterexample did not delete a collision file or establish customer data loss. Ops becomes 55/100; the weighted overall estimate becomes 54.25, rounded to 54. All other awards remain unchanged. Private-update preservation evidence is scoped to the tested fenced stores. The pending 4.5.8 safety repair does not raise the public-release grade until delivered evidence supports a new assessment.
