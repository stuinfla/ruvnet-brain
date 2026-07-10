---
name: brain-score
description: Score ANY repository 0-100 across 8 dimensions using the exact evidence-or-it-didn't-happen scorecard RuvNet-Brain applies to itself. Use when the user says "score this repo", "score my repo", "scorecard", "brain-score", "how good is this codebase", "rate this project", "audit quality", or asks for an honest 0-100 quality assessment of a repository. Every deduction must cite evidence from the actual repo; a known architectural flaw caps its dimension at ≤70; a "what I did NOT test" section is mandatory; all scores are out of 100, never out of 10.
---

# Brain-Score — the 8-dimension repo scorecard (0–100)

Score the repo in front of you the way RuvNet-Brain scores itself: **gates that could have failed,
before scores that can be believed.** A score is only real if the evidence behind it was collected
by running real commands against the actual repo — never from memory, never from vibes, never from
what the README promises.

## Non-negotiable scoring rules

1. **Every deduction cites evidence.** Each point lost names the file/line, the command you ran and
   its output, or the artifact you inspected. "Feels incomplete" is not a deduction; `"tests/ has 3
   files, 2 contain zero assertions (tests/foo.test.js:1-40)"` is.
2. **A known architectural flaw caps its dimension at ≤70** — no matter how much else in that
   dimension works. (Example: a quality gate whose sample size cannot statistically detect the
   regression it exists to catch caps reliability at 70, even with green CI.)
3. **A mandatory "What I did NOT test" section.** List every claim you could not verify (didn't run
   the app, didn't have the API key, skipped the 40-minute suite, couldn't reach the deployed URL).
   A scorecard without this section is invalid — do not present one.
4. **Scores are /100, never /10.** Per dimension and overall. Overall = the mean of the 8
   dimensions, reported alongside the lowest dimension (a 95 average hiding a 40 is the headline).
5. **When in doubt, score lower.** Unverified ≠ working.

## The 8 dimensions

| # | Dimension | What the evidence looks like |
|---|---|---|
| 1 | **Correctness-evidence** | Do claims trace to proof? Run the build/tests yourself; diff README claims against actual behavior; look for "verified" claims with no artifact behind them. |
| 2 | **Test honesty** | Not coverage %, honesty: do tests assert anything? Can the suite fail? Any skipped/todo masquerading as green? Does a missing dependency SKIP loudly or pass silently? |
| 3 | **Docs truthfulness** | Do docs describe the code that exists today? Stale install commands, APIs that 404, ADRs/status docs contradicting the source. Run the quickstart literally. |
| 4 | **Security posture** | Secrets in tree, dependency audit (`npm audit` / `cargo audit` / `pip-audit`), input handling at trust boundaries, unsigned auto-update/exec paths, injection surfaces. |
| 5 | **Token/cost efficiency** | For AI-touching repos: what is injected/spent per operation, and is it measured at all? For others: hot-path waste, N+1s, unbounded loops. "Nothing measures spend" is itself a deduction. |
| 6 | **Reliability/CI** | Does CI exist, run, and gate merges? Was it red while people kept pushing? Flaky tests, non-required checks, error handling on the paths that actually fail. |
| 7 | **Maintainability** | Duplication, dead code, module boundaries, dependency freshness, whether a newcomer could change one thing without breaking three. |
| 8 | **User experience** | The consumer's first contact: install-to-working time, error messages, defaults, docs entry path. For libraries: the API surface. Run the first-run flow yourself. |

## Procedure

1. **Collect receipts mechanically** (never from memory): run the test suite, the linter, the
   dependency audit; read CI config + recent run results if reachable; run the documented
   quickstart; grep for TODO/FIXME/skip; check the license, the lockfile, the entry docs.
2. **Use the real instruments when they're wired** (see honesty table below):
   - **ruflo MCP present** → call `metaharness_score` (5-dim harness readiness incl.
     `estCostPerRunUsd`) and `metaharness_oia_audit`. Both are READ-layer: **free, no API key, work
     on any repo.** Fold their findings into dimensions 5–6 as cited evidence — they complement the
     8 dimensions, they don't replace them.
   - **agentic-qe present** (`aqe` / aqe-mcp) → `coverage_analyze_sublinear` for dimension 2,
     `security_scan_comprehensive` for dimension 4, `test_generate_enhanced` to probe untested
     paths. **WARNING: `qe_qx_analyze` hallucinates on remote URLs** — it has returned templated
     grades in ~2ms with every claim false. Never relay its output on a URL or artifact without
     verifying against the real thing yourself first.
   - **Neither installed** → plain repo inspection is fully valid: read the code, run the
     commands, cite what you saw. Offer to install the tools (`npm i -g agentic-qe@latest`), but
     never block scoring on them and never fake their output.
3. **Score each dimension /100** with a deduction+evidence line per point cluster lost. Apply the
   ≤70 cap where an architectural flaw exists, and say which flaw triggered it.
4. **Write "What I did NOT test."** Then the overall (mean + lowest dimension).
5. If this repo has persistent memory (AgentDB / `.swarm/memory.db`), store the scorecard under
   key `scorecard-YYYY-MM-DD` so the next score can show movement.

## Output format

```
# Brain-Score: <repo> — <date>
Overall: NN/100 (mean of 8) · lowest: <dimension> at NN

| Dimension | /100 | Cap applied? |
|---|---|---|
...8 rows...

## Deductions (every point lost, with evidence)
- <dimension> −N: <claim> — evidence: <file:line / command + output>
...

## What I did NOT test
- ...

## Instruments used
- metaharness_score / oia_audit: <used | not wired — plain inspection> 
- agentic-qe: <used (which tools) | not wired>
```

## What's on by default vs what needs a key (say this honestly, never oversell)

| Capability | Status |
|---|---|
| `metaharness_score` + `metaharness_oia_audit` (READ layer) | **Free, on by default** in any repo when the ruflo MCP is installed — no API key. |
| agentic-qe test/coverage/security tools | **Free, on demand** when agentic-qe is installed (`npm i -g agentic-qe@latest`); `qe_qx_analyze` output must be verified against the real artifact. |
| `metaharness_evolve` (WRITE layer — self-improves the harness, keeps only measured winners) | **Needs `OPENROUTER_API_KEY`** + a runnable test command. Without the key: say so and offer the free READ layer instead. |
| Automatic per-task cheap-model routing | Goes through **agentic-flow `--router-mode cost-optimized`** — needs `OPENROUTER_API_KEY`. Claude-tier routing via `hooks_model-route` is free. |

Never claim the evolve loop or cheap routing "just works" when the key isn't set — check
(`printenv OPENROUTER_API_KEY` is empty?) and state which side of the line each feature is on.
