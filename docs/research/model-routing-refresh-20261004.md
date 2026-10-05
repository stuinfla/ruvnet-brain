Updated: 2026-10-04 09:54:00 EDT | Version 1.0.3
Created: 2026-10-04 08:49:00 EDT

# Model routing refresh: Anthropic and OpenAI

This dated assessment replaces the obsolete model recommendations in rejected ADR-080. It is not a new release rulebook. Production procedures remain in CONTRIBUTING.md.

## Executive recommendation

The owner-reviewed objective is correctness and completeness first, included subscription allowance second, and elapsed time to a verified result third. API prices do not measure subscription consumption.

For Codex, route consequential architecture, ambiguous requirements, uncertain causal diagnosis and substantive review directly to GPT-6 Astra high. Use GPT-6.1 Sol high for demanding implementation under a sufficiently clear design, and Sol medium for bounded routine work. Keep Astra on implementation when design and execution remain tightly coupled. Luna low is optional for narrowly defined mechanical transformations with complete inexpensive verification; it is not an autonomous coding default. Astra xhigh requires a named exceptional reasoning problem, not a routine retry. Max remains separately qualified rather than a default route.

The Anthropic table remains independently qualified: Sonnet 5.5 low for mechanical support, medium for routine noncoding, high for ordinary coding, and Opus 5.5 high for consequential judgment. Current independent comparisons suggest testing Opus medium as an alternative to Sonnet high for demanding implementation; they do not establish the best subscription route. Fable 5.1 native access was verified, but the current aggregate evidence does not justify a default role. Never manufacture equivalent effort controls across providers.

Standard delivery speed is the default for managed Codex workers. OpenAI's current documentation distinguishes included subscription multipliers (Fast 2.5x, Astra Ultrafast 8x) from purchased-credit multipliers (2x and 6x). These are usage multipliers, not completion-speed measurements. Source: https://learn.chatgpt.com/docs/agent-configuration/speed (checked October 4, 2026).

GPT-6 Astra high independently reviewed this policy on October 4 and agreed with the role distinctions. This is a reviewed starting policy, not demonstrated optimality on the owner's projects. Route changes must remain grounded in supported native settings, subscription access, task outcomes, and current evidence.

## Independent evaluation evidence

Artificial Analysis release-comparison pages were checked October 4. These rows use Intelligence Index v4.3.2 and Terminal-Bench 4.0; API cost and task time are the evaluator's workload measurements, not this project's subscription charges or execution times.

| Model / effort | Intelligence index | Terminal-Bench | API USD / task | Seconds / task |
|---|---:|---:|---:|---:|
| Sol 6.1 medium | 48 | 48.0% | 0.21 | 175.95 |
| Sol 6.1 high | 50 | 51.5% | 0.32 | 265.39 |
| Sol 6.1 max | 52 | 56.1% | 0.72 | 735.07 |
| Sonnet 5.5 medium, fallback | 41 | 29.8% | 0.59 | 136.55 |
| Sonnet 5.5 high, fallback | 47 | 43.9% | 1.12 | 238.18 |
| Sonnet 5.5 max, fallback | 56 | 63.6% | 7.67 | 921.48 |
| Astra 6 high | 51 | 54.0% | 1.73 | 217.70 |
| Opus 5.5 high | 54 | 56.6% | 1.82 | 295.33 |
| Luna 6 low | 22 | 0.0% | 0.0045 | 16.61 |

Recommendation inferred from these measurements: use Sol medium for ordinary coding, rather than making max the universal default; Sonnet high for ordinary Anthropic coding, with medium reserved for noncoding work; Luna low only for narrow noncoding tasks. Escalate hard reasoning to Astra/Opus high, and use higher effort after a demonstrated need. An aggregate benchmark cannot guarantee the optimal route for every prompt. Claude rows explicitly include the evaluator's default fallback, so they are not evidence of exclusively Sonnet execution.

Arena's agent/code leaderboard was separately checked: Sol max confirmed-task rate 22.31% (+/-5.74%, 2184 sessions), with USD1.10 per coding task. Arena uses a different workload and metric; neither this percentage nor its WebDev preference Elo is interchangeable with Artificial Analysis's index or the project North Star. Use these as independent corroboration, not a combined invented score.

## Revised role allocation

| Role | Ordinary executor | Escalation trigger |
|---|---|---|
| Researcher | Sol / Sonnet 5.5 medium | High-risk evidence synthesis: Astra / Opus 5.5 |
| Architect | Sol / Sonnet 5.5 medium | Unresolved tradeoff or concurrency: bounded Astra / Opus 5.5 review |
| Developer | Sol / Sonnet 5.5 medium | Difficult failure: high effort, then hard-tier diagnosis |
| Tester | Luna low for narrow triage; Sol / Sonnet for semantic assertions | Ambiguous architecture or acceptance: independent hard-tier review |
| Reviewer | Sol / Sonnet for routine review | Security-critical changes: Opus 5.5 or Astra high, independent of the writer |
| Operations | Scripts first; Luna for interpretation; Sol for repair | Unclear recovery/heartbeat correctness: Astra / Opus 5.5 |

## Verified API prices

Standard text prices, USD per million tokens, checked October 4. These are API reference prices, not charges for work covered by an existing CLI subscription. Output includes billed reasoning tokens. Cached input, batch/flex discounts, long-context and fast-mode premiums may change actual cost.

| Model | Native model ID | Input | Output |
|---|---|---:|---:|
| Sonnet 5.5 | claude-sonnet-5-5 | $2 | $10 |
| Opus 5.5 | claude-opus-5-5 | $4 | $20 |
| Fable 5.1 | claude-fable-5-1 | $10 | $50 |
| GPT-6 Luna | gpt-6-luna | $0.10 | $0.50 |
| GPT-6.1 Sol | gpt-6.1-sol | $2 | $10 |
| GPT-6 Astra | gpt-6-astra | $10 | $50 |

OpenRouter uses different Claude slugs, such as anthropic/claude-opus-5.5. Do not pass those slugs to the native Claude CLI.

At identical input/output token counts, Luna costs 1/20 of Sol and Sol 1/5 of Astra. Opus 5.5's $4/$20 rates are 20% below Opus 5's $5/$25. Anthropic's larger advertised workload savings also reflect token efficiency; they are not measured savings on this project. Sonnet 5.5 and legacy Sonnet 5 currently have the same $2/$10 catalog rates. Do not claim a per-token reduction for that upgrade.

Haiku 4.5 remains in Anthropic's official current lineup at $1/$5, and is described as fastest. No newer Haiku was verified. It is excluded from the recommended routes at the owner's request; Sonnet low is not claimed to match Haiku's latency or token price. Mythos access was not established, so it is not a default. Older OpenAI Sol/Terra/Luna entries remain historical inventory, not recommended workhorses.

## Tools and access evidence

| Tool in use | Checked version | Outcome |
|---|---|---|
| Codex native CLI | 0.160.0 | Native update completed; same current version |
| Claude Code active npm executable | 2.1.289 | Native update command checked; already current |
| Global Ruflo | 3.51.1 | Matches live npm latest/alpha |
| AgenticKit | 4.0.0-alpha.61 | Matches live npm next; stable latest points to older alpha.0 |

Scope: these four active host/orchestration tools and the two provider model catalogs. This is not an upgrade of every unrelated global npm package or project dependency. The Claude wrapper preserves subscription routing; its multiple-install warning must not be interpreted as a second confirmed running server. No installation was deleted.

AgenticKit inventory refreshed October 4: 48 models, six sources. Codex's native account cache was refreshed October 4 and lists Sol 6.1, Luna 6 and Astra 6. Actual tool-free subscription launches succeeded for Sonnet 5.5 and Opus 5.5, with exact modelUsage identities and MODEL_OK. Tool-free Codex launches succeeded for Luna 6, Sol 6.1 and Astra 6 with completed-turn receipts. These are access smoke checks, not comparative quality benchmarks. Fable 5.1 remains inventory-only until a fresh launch verifies access. No direct authenticated provider Models API check was performed: API keys are absent from the process environment and subscription credentials were not repurposed as API keys.

Managed catalog merging is additive and preserves user overlays, so refreshing the packaged catalog does not by itself retire old local choices. This machine received a backed-up explicit cleanup of older Anthropic/OpenAI native eligibility and the five newly launch-verified candidates. Other providers and custom models were retained. The local policy was also corrected: it previously requested old gpt-5.6-luna, then silently fell back to the first pool entry, which produced Astra for a summary and a metered OpenRouter model for Claude work. The backed-up local fallback policy restricts its recommendations to native subscription candidates and fails closed rather than selecting a paid fallback. The engine consults the learned MetaHarness router before that policy, so this is not proof of a universal subscription-only constraint on every learned route. Six deterministic selections now match the fast/medium/hard table for both hosts. This remains a heuristic, not a learned quality guarantee. Current host activity routes and the parent conversation must not be claimed switched merely because a file was changed. Newly recommended metadata is not proof of a working dispatcher.

## Currency and remaining validation

The existing weekly model-catalog workflow refreshes prices and validates presence, but does not automatically replace an older model that still exists. This explains how a fresh snapshot could coexist with stale tier recommendations. The refresh updated the two provider ladders, removed unsupported fresh ranking claims, refreshed 466 model price records, and marked ADR-080 obsolete. No historical ADR was rewritten as an accepted operating policy.

A complete automatic new-model promotion would require provider discovery, account entitlement checks, representative task/effort trials, explicit subscription/spend checks, and safe integration with the existing router. That mechanism was not built in this document refresh. Before claiming measured improvement, compare correctness, successful task latency, retry rate, token use and cost per accepted result on the same project tasks. No API spending path is enabled by this assessment. Validation: 21 focused catalog/managed-merge/update tests passed; all 17 repository single-source checks passed; offline and live catalog verification passed. The initial tests pinned obsolete real-catalog model names; their expectations were updated for this requested tier change while synthetic legacy fixtures and overlay-preservation assertions were retained. Five native subscription smoke launches passed; the full task-quality/latency benchmark and newly measured Fable access were not run. Independent Astra review confirmed the metadata choices and identified remaining limits: effort recommendations are not dispatcher controls; learned routing can bypass the fallback policy; native Codex receipts bind the requested launch and completed turn rather than an independently returned model ID. An actual installed-package router check selected Luna correctly for a summary but reported the learned router unavailable because its packaged Transformers import was missing. Automatic learned routing is therefore degraded; this refresh does not claim to repair it.

## Sources checked

- OpenAI models: https://developers.openai.com/api/docs/models
- OpenAI model selection: https://developers.openai.com/api/docs/guides/model-selection
- OpenAI Luna: https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI effort/tool compatibility: https://developers.openai.com/api/docs/guides/deployment-checklist
- Anthropic current models/prices: https://platform.claude.com/docs/en/models/overview
- Anthropic effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic Opus 5.5: https://platform.claude.com/docs/en/models/opus-5-5/overview
- Anthropic Sonnet 5.5: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
- Live OpenRouter metadata: https://openrouter.ai/api/v1/models
- Native evidence: fresh ~/.codex/models_cache.json and ~/.config/agentic-kit/model-inventory.json; native version/update output and live npm dist-tags.

Independent sources checked:
- https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-sol-vs-claude-sonnet-5-5
- https://artificialanalysis.ai/models/releases/comparisons/gpt-6-luna-vs-gpt-6-astra
- https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-gpt-6-astra
- https://arena.ai/leaderboard/agent/code

## Additional coding-workflow evidence checked October 4

Artificial Analysis Coding Agent Index v1.5 was inspected in an actual browser, including the owner's selected 13-agent chart. The availability legend marks some model variants as not publicly available; it is not a data-access error. The index combines DeepSWE v1.1, Terminal-Bench 4.0 and SWE-Atlas-QnA. Rounded public summaries show Codex Sol 6.1 xhigh at 63 and 15.5 minutes per task; Codex Astra max at 62 and 29.4 minutes; Claude Code Sonnet 5.5 max at 68 and 1.5 hours; Claude Code Opus 5.5 max at 66 and 1.1 hours. API costs are not subscription usage. Mixed Devin Fusion/SWE-2 variants are different harnesses and cannot be assumed selectable through the owner's native subscriptions. Small score differences and different efforts do not establish architectural or review superiority. Source: https://artificialanalysis.ai/agents/coding-agents

VulcanBench's October 1 Sol 6.1 report uses 23 legacy-program reconstruction tasks per effort, one attempt per task, Codex 0.159.0 on ChatGPT Pro, and quality protocol v3.18. Medium passes 22/23 at 10.6 minutes per task; high passes 23/23 at 10.2 minutes. High API-equivalent cost is $0.33 versus medium $0.40. High, xhigh and max all pass 23/23; their combined scores are close. The small task sample and 33% model-judged code-quality component limit generalization. This supports testing high for demanding implementation, without proving weekly allowance savings or universal optimality. Source: https://vulcanbench.com/benchmarks/swe-v4-gpt61-sol-v318.html

The installed managed dispatcher completed a bounded Sol high acceptance request on October 4, after a fresh ordinary-allowance check. Receipt: /tmp/rnb-managed-sol-high-acceptance-20261004/result.json. This verifies the real dispatcher path accepted and completed its request; it does not independently identify the served backend model or prove arbitrary-parent-client switching, credit-race prevention, task quality, a weekly semantic analyst run or production publication.
