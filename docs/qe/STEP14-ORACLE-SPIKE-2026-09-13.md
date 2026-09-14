Updated: 2026-09-14 02:50:00 EDT | Version 1.0.0
Created: 2026-09-14 02:50:00 EDT

# Step 14 — oracle feasibility spike (ADR-086, owner criterion C3)

**What this is.** Dual rated Step 14 the single largest technical uncertainty in the corpus-seed
rebuild: *"trustworthy unattended semantic ground truth, followed by achieving 95% for the worst
repository without weakening the benchmark."* Its `unattended_oracles` clause says plainly that **no
suitable producer was verified in that review** and that this is therefore "an explicit engineering
deliverable, not an assumed capability."

This document reports what was measured when that producer was actually built and run. It is a
spike, not a shipped pipeline: nothing here is wired into `prepareCorpusCandidate` (that is Step 15).

**What this is NOT.** No retrieval was executed. This spike measures whether *labels* can be produced
and validated without a human; it does **not** measure whether any repository reaches 95% Hit@5, and
nothing below should be read as evidence about C3's threshold being met.

---

## 1. The three modules

| Module | Model? | What it does |
|---|---|---|
| `scripts/oracle/source-units.mjs` | **No** | Deterministic inventory. Enumerates U meaningful source units from an upstream snapshot, stratifies by top-level directory × language, selects `min(100, U)` with a PRNG seeded `repo@commit`. Binds each unit to path + git blob SHA + line span + sha256 of the unit bytes. |
| `scripts/oracle/produce-questions.mjs` | **Yes — subscription only** | Pass 1 `claude -p` sees exact upstream bytes, emits direct question + paraphrase + verbatim supporting span. Pass 2 `codex exec` (different vendor) sees **only** question + span and judges whether the span alone answers it. |
| `scripts/oracle/validate-labels.mjs` | **No** | Deterministic checks (a)–(d) below, against bytes re-read from disk and re-hashed. Local ONNX `bge-base-en-v1.5` supplies cosines; it refuses to run if the model is not already cached (never downloads). |

`scripts/oracle/spike-run.mjs` is the human-run driver that chains the three. It is declared
STANDALONE in `wired-check.mjs` — deliberately not imported by the pipeline, because Step 15 owns
any wiring decision.

### The four validation checks

- **(a) verbatim** — the span is an exact contiguous substring of the unit at the pinned blob SHA. The
  blob is re-hashed from disk first; any drift fails the label outright.
- **(b) non-trivial** — ≥ 40 chars and ≥ 6 tokens, ≤ 90% of the unit, not a heading line alone.
- **(c) no answer leakage** — cosine(question, span) < 0.92 **and** 4-gram coverage of the question by
  the span < 0.5.
- **(d) paraphrase differs** — token Jaccard(direct, paraphrase) ≤ 0.7 and not equal after normalisation.

Producer errors, timeouts and producer-initiated skips **fail every check**, per Dual's rule that
"errors and timeouts count as failures."

---

## 2. The hard fence — zero out-of-pocket spend

The owner mandate was subscription-billed access only. Evidence, not assertion:

```
$ env | grep -iE "OPENROUTER|OPENAI_API|ANTHROPIC_API"
OPENROUTER_API_KEY=<present, value redacted>
```

A billing key **is** present in the parent shell. The producer therefore builds its child environment
with `subscriptionOnlyEnv()` from `scripts/subscription-hosts.mjs`, which deletes every name in
`API_BILLING_ENV`, and it **refuses to spawn** if any survives. Each run records the asymmetry:

| Source | `parentHadBillingKeys` | `childHadBillingKeys` |
|---|---|---|
| hello_world_agent | `OPENROUTER_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY` | `[]` |
| gist-partition | `OPENROUTER_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY` | `[]` |
| ruflo | `OPENROUTER_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY` | `[]` |

Both hosts were verified subscription-authenticated before the run: `claude auth status --json` →
`authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType: "max"`; `codex login
status` → `Logged in using ChatGPT`.

Three further fence facts:

- `scripts/brain-grade-groundtruth.mjs` (the existing OpenRouter grader Dual said "cannot serve this
  subscription-only gate unchanged") is **not referenced anywhere** in `scripts/oracle/` — grep returns 0.
- `tests/unit/oracle-produce-questions.test.mjs` greps the producer's **code** (comments stripped) and
  fails if any provider key name, provider URL, or direct `fetch(`/`http://` appears in it.
- `--bare` is deliberately **not** used on `claude -p`. Its own help text says auth then becomes
  "strictly ANTHROPIC_API_KEY or apiKeyHelper … OAuth and keychain are never read" — the exact
  opposite of the fence. Context is minimised with `--system-prompt`, `--tools ""`,
  `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources ""` instead (measured: 1,009
  prompt tokens versus ~100k with host defaults).

The `total_cost_usd` figures below are the **hosts' own at-list-price estimates**. They are not
charges. Actual out-of-pocket spend for this spike was **$0.00**.

---

## 3. Sources, pinned to exact commits

| Source | Kind | Commit | Provenance |
|---|---|---|---|
| `ruflo` | LARGE repo | `b02c0cacec225deea01f586b66a9694393369432` | `data/source-coverage.json` row, `upstream.sha` |
| `hello_world_agent` | SMALL repo | `42584fa15554719b6eaf32e14f59008b2c59cdde` | `data/source-coverage.json` row, `upstream.sha` |
| gist partition (20 gists) | gist partition | composite `4f3cf1ac0420dcc00eb8fd94c395d886420ad6c4a847de380e806ed9b29bc583` | 20 markdown-only gists from `kb/ruv-gists.sources.json`, each checked out at its recorded `versionSha`; the composite is sha256 over the sorted `id:sha` list |

Cloned shallow into the session scratchpad, never inside the worktree.

---

## 4. Measured results

### 4.1 Inventory (deterministic, no model)

| Source | U | selected | N (=2×selected) | sampling coverage | strata | files total / considered / with units | uncovered files |
|---|---|---|---|---|---|---|---|
| ruflo | 10,023 | 100 | 200 | **1.00%** | 22 | 5,716 / 3,854 / 2,407 | 1,447 |
| hello_world_agent | 98 | 98 | 196 | **100%** | 10 | 104 / 56 / 39 | 17 |
| gist partition | 153 | 100 | 200 | **65.4%** | 21 | 27 / 23 / 22 | 1 |

Exclusions are by explicit named rule, and counted rather than silently dropped. For ruflo:
`test-dir` 638, `minified-map-or-typings` 120, `vcs-or-ide-dir` 57, `lockfile` 27,
`license-changelog-or-meta` 13, `binary` 6, `generated-marker` 1, plus 949 files whose extension is
in no covered language.

**Determinism is proven across a process boundary**, not merely in-process: the CLI is run twice as
separate `node` processes and the bytes compared (`cmp`) — identical, sha256
`b8e708f0e05e4017…` both times for ruflo. `tests/unit/oracle-source-units.test.mjs` pins the same
property on a fixture, and pins exact U on a hand-derived fixture repo.

**Languages covered**: Markdown (H2/H3 sections), JavaScript/TypeScript (`@babel/parser` AST:
exported or doc-commented top-level declarations), Rust (regex: bare `pub` fn/struct/enum/trait/
type/union), Python (module-level public def/class).
**NOT covered, and counted as unsupported rather than hidden**: Go, Java, C/C++, Shell, Svelte,
YAML/JSON/TOML, setext Markdown headings, CommonJS `module.exports`, Rust items under `#[cfg(test)]`,
Rust `pub(crate)`.

### 4.2 Producer and validation

| Source | claude calls | codex calls | producer errors | timeouts | skips | **overall pass** | (a) verbatim | (b) non-trivial | (c) no leak | (d) paraphrase | cross-vendor both-yes | wall clock | cost estimate (not charged) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hello_world_agent | 5 | 5 | 0 | 0 | 0 | **94/98 = 95.9%** | 98/98 = **100%** | 94/98 = 95.9% | 98/98 = 100% | 98/98 = 100% | 96/98 = 98.0% | 554s | $2.45 |
| gist partition | 5 | 5 | 0 | 0 | 0 | **98/100 = 98.0%** | 100/100 = **100%** | 100/100 = 100% | 98/100 = 98.0% | 100/100 = 100% | 100/100 = 100% | 631s | $2.80 |
| ruflo | 5 | 5 | 0 | 0 | 0 | **99/100 = 99.0%** | 100/100 = **100%** | 99/100 = 99.0% | 100/100 = 100% | 100/100 = 100% | 99/100 = 99.0% | 695s | $3.51 |
| **total** | **15** | **15** | **0** | **0** | **0** | **291/298 = 97.7%** | **298/298 = 100%** | 293/298 | 296/298 | 298/298 | **295/298 = 99.0%** | 1,880s | $8.76 |

Model ids: `claude-fable-5-1` (requested and confirmed in `modelUsage`; the host also reports a
`claude-haiku-4-5-20251001` entry, which is Claude Code's own internal routing, not the producer's
requested model) and `gpt-6-astra`. Per-call latency: claude 51.7s–114.5s, codex 39.6s–53.8s.

**The headline number: the producer emitted a byte-exact verbatim span for 298 of 298 units —
100%, with zero failures across three sources, two of them unfamiliar code bases.** Every span also
matched under whitespace normalisation, and the producer's self-reported line numbers pointed at the
right text in 289/298 (97.0%).

### 4.3 Cosine calibration (is the leakage gate real?)

Measured on this data, per source, cosine(question, span) against synthetic *leaky* questions built
from the span's own first 20 tokens:

| Source | real direct-vs-span p50 / p90 / max | synthetic leaky p10 / p50 |
|---|---|---|
| hello_world_agent | 0.730 / 0.824 / 0.876 | 0.857 / 0.918 |
| gist partition | 0.778 / 0.864 / 0.926 | 0.835 / 0.903 |
| ruflo | 0.741 / 0.818 / 0.917 | 0.831 / 0.908 |

Honest reading: the two distributions **separate but overlap** — real questions top out at
0.876–0.926 while synthetic leaky questions start around 0.83. The 0.92 threshold sits high in that
overlap, so it is a *conservative* gate: it fired exactly once in 298 labels. It is not a proven
discriminator at the boundary, and the n-gram rule is doing most of the real work. Anyone tightening
it should re-run this calibration rather than pick a number.

---

## 5. Five GOOD labels (verbatim)

All four checks pass and both vendors answered yes.

1. `[hello_world_agent] agent/README.md:80-90` (md-section)
   - **direct**: Which docs file does the agent README link to for the Human-in-the-Loop Guide?
   - **paraphrase**: In the README documentation list, what path is given for the guide covering human-in-the-loop?
   - **span**: `- [Human-in-the-Loop Guide](docs/human_in_the_loop.md)`
2. `[hello_world_agent] agent/config/config_loader.py:4-44` (py-class)
   - **direct**: What default format and min_length does ConfigLoader.apply_defaults assign to the thought validation rule?
   - **paraphrase**: When ConfigLoader fills in defaults, which format string and minimum length are set for validating thoughts?
   - **span**: `"thought": {\n "format": "Thought: {reasoning}",\n "min_length": 20\n },`
3. `[hello_world_agent] agent/config/react_validation.py:1-44` (py-class)
   - **direct**: What value does ReactValidator.update_progress return when the total argument is zero?
   - **paraphrase**: If total equals 0, what does the update_progress method of ReactValidator give back?
   - **span**: `def update_progress(self, current, total, message):\n self.current_step = current\n self.total_steps = total\n return (current / total * 100) if total > 0 else 0`
4. `[hello_world_agent] agent/crew.py:12-45` (py-function)
   - **direct**: What temperature value does stream_openrouter_response include in the JSON body sent to OpenRouter?
   - **paraphrase**: In the request payload that stream_openrouter_response posts to OpenRouter, which temperature setting is used?
   - **span**: `json={\n "model": model,\n "messages": messages,\n "stream": True,\n "temperature": 0.7\n },`
5. `[hello_world_agent] agent/crew.py:47-64` (py-class)
   - **direct**: What initial keys and values does HelloWorldCrew set in its progress_tracker dictionary?
   - **paraphrase**: How is the progress_tracker attribute initialized in the HelloWorldCrew constructor?
   - **span**: `self.validation_status = {"reasoning": [], "actions": []}\n self.progress_tracker = {"current_step": 0, "total_steps": 0, "status": ""}`

## 6. Five BAD labels (verbatim) — and what they actually prove

**This is the most important section in the report, because four of the five are not bad labels.**

1. `[hello_world_agent] agent/docs/readme.md:44-51` — **FAIL(b): span 5 tokens < 6**
   - direct: Which configuration file in agent/config/ contains the templates for prompts?
   - span: `` - `prompts.yaml`: Templates for prompts. ``
   - *Both vendors said yes. This is a correct, useful label rejected by my token floor.*
2. `[hello_world_agent] meta-agent/README.md:322-381` — **FAIL(b): span is a heading line alone**
   - direct: Which server argument limits the maximum requests per IP per minute for a generated agent's HTTP server?
   - span: `  # --rateLimit=<number> Max requests per IP per minute`
   - *A comment line inside a code block, misclassified as a Markdown heading by the `#` prefix. Validator defect, not a producer defect.*
3. `[hello_world_agent] meta-agent/agent.ts:125-140` — **FAIL(b): span 5 tokens < 6**
   - direct: Which two string literal values does the AgentConfig deployment field accept?
   - span: `  deployment: "local" | "http";   // Deployment mode`
   - *A perfect one-line code answer. The 6-token floor is calibrated for prose and is wrong for code.*
4. `[gist-partition] .../Agentic-Flow.md:460-466` — **FAIL(c): cosine 0.926 ≥ 0.92**
   - direct: How many concurrent testing agents were used in swarm coordination to cover all categories?
   - span: `3. **Swarm Coordination**: 5 concurrent testing agents covered all categories`
   - *A defensible catch: the question is a near-restatement of the span minus the number.*
5. `[gist-partition] .../tutorial.md:41-45` — **FAIL(c): 4-gram coverage 0.50 ≥ 0.5**
   - direct: What is named as one of the biggest advantages of using Google AI Studio for fine-tuning?
   - span: `One of the biggest advantages of using Google AI Studio is that fine-tuning is **completely free of charge**.`
   - *A genuine catch: the question lifts nine consecutive words from the span.*

Exact breakdown of all 7 failures across 298 labels: **5 are check (b)** — 4 short-span
token-floor rejections (3 in hello_world_agent, 1 in ruflo) and 1 heading misclassification — and
**2 are check (c)** answer-leakage catches, both of which look correct. Checks (a) and (d) failed
zero times. The producer's true error rate is therefore lower than the headline 97.7%; the
validator's non-triviality rule is the weak component and needs to be language-aware in Step 15.

---

## 7. Operational cost, and whether nightly is sane

Measured per source (100 units): 10 model calls (5 claude + 5 codex), ~627s mean wall clock.

Projected to the eligible set — 194 eligible repositories in `data/source-coverage.json`, plus gist
partitions:

| | per source | × 194 sources |
|---|---|---|
| subscription calls | 10 | **1,940 per full pass** (970 claude + 970 codex) |
| wall clock, sequential | ~627s | **~33.8 hours** |
| wall clock, 5-way parallel | — | ~6.8 hours |
| at-list-price estimate | ~$2.92 | ~$567 (**$0 out of pocket**) |

**A full nightly regeneration is not operationally sane.** 33.8 hours sequential does not fit in a
night, and 5-way parallelism against two subscription hosts invites exactly the rate limiting
described below.

**The amortization the inventory already supports.** Every unit carries `blobSha` and `bytesSha256`.
A unit whose blob is unchanged since the last pass needs no regeneration — its label is still bound
to the identical bytes. So the nightly cost is proportional to **churn**, not to corpus size: a
first full pass of ~1,940 calls, then a nightly delta that for a typical day's churn across the org
is a small fraction of that. This is the only version of "unattended nightly" that the measurements
support, and it needs no new mechanism — only a stored label set keyed by `blobSha`.

**Rate limiting is a live risk, not a hypothetical one.** This spike's own agent session was killed
mid-run by an API session limit and had to be resumed. Any unattended scheduler must treat host
refusal as an ordinary outcome: checkpoint per batch, resume, and count unproduced labels as
failures rather than silently shrinking the denominator.

---

## 8. Feasibility verdict

> Measured validation pass rates of 95.9% (94/98), 98.0% (98/100) and 99.0% (99/100) on
> hello_world_agent @42584fa155, a 20-gist partition @4f3cf1ac04, and ruflo @b02c0cacec — 291 of 298
> labels overall (97.7%) — under these conditions: units enumerated deterministically from exact
> upstream bytes; `min(100, U)` selected by a commit-seeded PRNG; labels produced in 15 `claude -p`
> calls on `claude-fable-5-1` and independently judged in 15 `codex exec` calls on `gpt-6-astra`,
> both subscription-billed with every provider API key stripped from the child environment; and
> validated deterministically with a local ONNX bge-base embedder, with producer errors, timeouts and
> skips all counted as failures. Zero producer errors, zero timeouts and zero skips occurred across
> all 30 calls. The decisive sub-measurement is that the producer returned a byte-exact verbatim
> supporting span for 298 of 298 units (100%), and the independent second vendor affirmed that the
> span alone answers both questions for 295 of 298 (99.0%). Of the 7 validation failures, 4 are
> false rejections by my own non-triviality rule against short code spans and 1 is a heading
> misclassification inside a fenced block, leaving 2 defensible answer-leakage catches; the producer's
> own error rate is therefore lower than the headline figure, and the weakest component measured here
> is the validator, not the producer. The bar I would require before letting this run unattended is
> ≥99% verbatim-span fidelity — because a non-verbatim span is silently wrong rather than loudly
> broken, and it would corrupt the benchmark it is meant to define — together with ≥95% end-to-end
> label validity and an auditable reason recorded for every rejection. On these three sources the
> oracle clears that bar: 100% verbatim against a ≥99% requirement, and 97.7% end-to-end against a
> ≥95% requirement. I am therefore reporting the producer question — "can a locally executable,
> pinned, source-grounded producer emit trustworthy labels without a human?" — as answered
> affirmatively for these sources, while explicitly NOT claiming that any repository meets C3's 95%
> retrieval threshold, because no retrieval was executed in this spike at all.

### What I did NOT test

- **No retrieval, at all.** Not one query was run against any candidate corpus, RVF store or passage
  sidecar. Hit@5 is unmeasured. C3's 95% gate remains entirely unproven.
- **Thin sampling on the large repo.** ruflo's 100 selected units are **1.0%** of its 10,023. Dual's
  spec permits `min(100, U)`, but a 1% sample is a weak basis for a per-repository claim, and the
  uncovered-file count (1,447) is large.
- **Paraphrase independence is partial.** The paraphrase is authored by the *same model in the same
  call* as the direct question. Codex validates that the span answers each question, but it sees both
  questions, so nothing here independently certifies that the paraphrase preserves meaning. Dual's
  "validate paraphrases independently" is satisfied only in the sense that no candidate output was
  involved.
- **Never actually run unattended.** Every invocation in this spike was launched and watched by hand.
  No scheduler, no retry-on-limit, no checkpoint/resume path exists yet — and this session was itself
  killed by a rate limit mid-run.
- **Only 3 of ~194 sources**, two of them small, all with a heavy Markdown/Python/TypeScript bias. No
  Go, Java, C/C++, Shell or Svelte unit was ever produced or validated.
- **No adversarial or drift testing of the producer.** I did not test a poisoned snapshot, a unit
  designed to induce fabrication, or a host returning plausible-but-wrong spans at scale.
- **Cost figures are host estimates**, not invoices, and the 33.8-hour projection is linear
  extrapolation from three sources, not a measured full pass.

### Recommended next steps for Step 15

1. Make check (b) language-aware — a 5-token code span is valid; the 6-token floor is a prose rule.
2. Fix the heading heuristic to ignore `#` inside fenced code blocks.
3. Persist labels keyed by `blobSha` so nightly cost tracks churn, not corpus size.
4. Add checkpoint/resume and treat host rate-limit refusal as a counted failure.
5. Before any per-repo 95% claim, raise sampling on large repositories or state the 1% coverage
   prominently next to the number.

---

## 9. Reproduction

```bash
node scripts/oracle/source-units.mjs   --dir <snapshot> --repo <name> --out inventory.json
node scripts/oracle/produce-questions.mjs --inventory inventory.json --dir <snapshot> --out labels.json \
  --batch 20 --max-claude-calls 6 --max-codex-calls 6
KB_MODEL_CACHE=<warm cache> node scripts/oracle/validate-labels.mjs --labels labels.json --dir <snapshot> --out validation.json
# or all three at once:
node scripts/oracle/spike-run.mjs --repo <name> --dir <snapshot> --out <outdir>
```

Tests: `npx vitest run tests/unit/oracle-source-units.test.mjs tests/unit/oracle-validate-labels.test.mjs
tests/unit/oracle-produce-questions.test.mjs` — 55 passed. The producer tests inject a spawn stub and
never invoke a model.

### Verification state at commit

| Gate | Result |
|---|---|
| Oracle unit tests (3 files) | **55 passed** |
| `npm test` | **58/58 checks passed** |
| `node scripts/wired-check.mjs --check` | **0 UNWIRED** (exit 0) — `spike-run` declared STANDALONE |
| Full suite `vitest run tests/unit tests/integration` | 474 files, **5,325 passed / 3 failed / 19 skipped / 203 todo**, 806s |

The three full-suite failures, each verified rather than assumed:

1. `no-restated-truth > NO NEW gate restates a truth` — **mine, and fixed.** My test asserted
   `toBe('1')`, which matches the gate's pinned-version-literal detector. Corrected to derive the
   value from `subscriptionOnlyEnv()`; the file now passes. The recorded run predates the fix.
2. `adr-format > 0086-…md > has a Status line ruflo-adr can parse` — **pre-existing at this branch
   point, already fixed on main.** This branch forks `b250e808`; the ADR-0086 Status line was
   repaired later by `5433bd27`, and `adr-format.test.mjs` passes 349/349 on the main checkout. Not
   caused by, and not fixable from, this change.
3. `convergence-manifest > proves the committed source surfaces converge` — the known worktree
   quirk named in this step's acceptance criteria.

Targeted re-run after the fix (`no-restated-truth` + the 3 oracle files + the 2 remaining):
**409 passed, 2 failed** — exactly items 2 and 3 above.

Two full-suite runs earlier died at exit 144 with no assertion failure. That was an unrelated agent
running a broad `pkill -f vitest` across all worktrees at 02:37 and 02:47, not a defect here.
