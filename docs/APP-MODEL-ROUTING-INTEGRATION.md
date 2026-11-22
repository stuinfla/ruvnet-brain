Updated: 2026-11-22 01:40:00 EST | Version 1.0.0
Created: 2026-11-22 01:40:00 EST
Author: Stuart Kerr (with Antigravity Gemini 4 Neon)
Status: CANONICAL — PRODUCTION APP INTEGRATION STANDARD (companion to `docs/MODEL-ROUTING-ARCHITECTURE.md`)

# Production App Model Routing Integration Standard (Zero Hardcoded Models)

This document defines **how every deployed application Stuart builds** (e.g., `AppealArmor`, `salon-local`, `PowerPlatePulse`, `Synseer`, etc.) must call LLMs so that:
1. **No app ever hardcodes a model name** (like `"claude-opus-4-8"` or `"gpt-5.6-sol"`) that goes stale or gets retired 60 days later.
2. **Every app automatically gets the lowest-cost, fastest, highest-quality model + thinking level** for each feature.
3. **Personal coding vs. production apps never get confused.**

---

## 1. The Two-Lens Rule: Personal Coding vs. Deployed Apps

| Dimension | Lens 1: Personal Coding on MacBook Pro | Lens 2: Deployed Production Apps (Vercel / Cloud) |
| :--- | :--- | :--- |
| **Who pays & how** | Stuart's **prepaid flat-rate subscriptions** (Antigravity Ultra, Claude Max, ChatGPT Plus, Grok) — **`$0` marginal cost**. | **Metered API billing** (per 1M tokens) paid by the app/business — personal subscriptions legally & technically cannot run production SaaS traffic. |
| **Correct Router** | **MetaHarness Model Router** (`~/.claude/model-router/`). Strips all API keys (`subscriptionOnlyEnv()`). **Meta Proxy Cloud stays OFF.** | **Dynamic Tier-Alias Router / Gateway** (e.g., **Meta Proxy**, OpenRouter, or a central `model-tiers.json` / env config backed by weekly refresh). |
| **Why Meta Proxy fits here (and NOT on personal coding)** | On Stuart's laptop, Meta Proxy Cloud would charge him "by the drink" on top of subscriptions he already prepaid. | In a corporate / production app where every call is metered API anyway, a dynamic proxy/gateway automatically shifts traffic to newer/cheaper models, enforces rate limits/budgets, and fails over if one provider goes down—without redeploying app code. |
| **Governing Doc** | [`docs/MODEL-ROUTING-ARCHITECTURE.md`](./MODEL-ROUTING-ARCHITECTURE.md) | **This document (`docs/APP-MODEL-ROUTING-INTEGRATION.md`)** |

---

## 2. The Zero-Hardcoding Contract (Mandatory for All New & Updated Apps)

**Rule:** Application code (routes, workers, prompts, UI actions) **MUST NEVER contain a literal vendor model ID**.

Instead, every app imports one small module (`src/lib/model-router.js` or `.ts`) and requests work strictly by **capability tier**:

```ts
// GOOD — never goes stale, automatically upgrades when models improve
const result = await callLLM({
  tier: 'fast',        // 'fast' | 'medium' | 'substantial' | 'hard' | 'exceptional'
  purpose: 'extract-intake-fields',
  input: userText,
  requireJson: true,
  maxLatencyMs: 5000,
});

// BAD — FORBIDDEN (hardcoded model ID goes stale & locks in old pricing)
// model: 'claude-3-5-sonnet-20241022'
```

### Standard 5 Production App Tiers (AA v5.0.1 / Vals v2.2 / KingBench 4 Cost-to-Solve)

| App Tier | When an App Uses It | Current Optimal Production API Target (Nov 2026) | Thinking Cap | Fallback |
| :--- | :--- | :--- | :--- | :--- |
| **`fast`** | Classification, JSON extraction, tagging, short summaries, autocomplete, moderation | `gemini-4-flash` (`$0.15/$0.60`/Mtok) or `deepseek/deepseek-v4-flash` (`$0.14/$0.28`/Mtok) | `low` | `gpt-6-luna` (`$0.10/$0.50`) |
| **`medium`** | Standard customer chat, drafting emails/replies, routine RAG Q&A, single-doc synthesis | `gemini-4-neon` (`$3/$15`, `$0` implicit cache write, score `55` @ `medium`) or `claude-sonnet-5-5` (`$2/$10`) | `medium` | `gpt-6.2-sol @ medium` |
| **`substantial`** | Multi-document synthesis, long-context analysis (100K–1M tokens), structured reports | `gemini-4-neon` (score `60` @ `high`, `$3.74`/task, `95.2%` GraphWalks 256K–1M, `$0` cache write) | `high` | `gpt-6.2-sol @ high` |
| **`hard`** | Legal/medical/financial appeal generation, complex multi-step reasoning, security checks | `gemini-4-neon @ high` (Vals Index v2.2 `70.9%` at <½ the cost of Fable) or `claude-opus-5-5 @ high` | `high` | `gpt-6.2-astra @ high` |
| **`exceptional`** | Last-resort automatic retry when `hard` fails validation/schema/quality checks (`<5%` of calls) | `claude-fable-5-2 @ high` (Vals `71.3%`, score `62` @ `$9.08`) — **never `max` (`$26.54`)** | `high` | `gemini-4-neon @ xhigh` |

---

## 3. Built-In Production Guardrails (Every App Must Include These 4)

1. **Dynamic Tier Map (Externalized from Code):**
   - Store the tier-to-model mapping in a single config/env/remote registry (`MODEL_TIER_MAP` JSON or gateway route table), **never** scattered across route handlers.
   - Updating the winning model for `fast` or `medium` requires **zero code changes**—only updating the registry/env or letting the gateway refresh.
2. **Automatic Escalation on Validation Failure:**
   - If a `fast` or `medium` call returns invalid JSON, fails a schema check, or fails a domain assertion, the wrapper automatically retries **once** at the next tier up (`fast -> medium -> hard -> exceptional`) and logs the escalation event so you can tune the tier assignment.
3. **Cache-Aware Prompt Structure:**
   - Always place static system instructions, schemas, and reference documents at the **top** of the prompt (prefix) and dynamic per-user input at the **bottom** so implicit caching (Gemini 4 Neon: `$0` cache write, `95%` cache read discount) and explicit caching (Anthropic: `95%` cache read discount) hit >85%.
4. **Hard Cost & Thinking Caps:**
   - Every app wrapper enforces `maxOutputTokens` and caps thinking effort (`low` / `medium` / `high` — never `max` in production unless an admin explicitly triggers an offline batch job).
   - Every app logs `{ ts, app, purpose, tier, model, effort, inTokens, cachedTokens, outTokens, estCostUsd, escalated }` so real per-feature unit economics are always measurable.

---

## 4. Reference Drop-In Wrapper (`app-model-router.mjs`)

Any Node/TypeScript app can drop in `app-model-router.mjs` so model IDs live in one env/config map and never in business logic, with automatic cross-provider failover (`fallbackProvider`) and validation-failure `+1` tier auto-escalation:

```js
export const DEFAULT_PRODUCTION_TIERS = Object.freeze({
  fast:        { provider: 'google',    model: 'gemini-4-flash',   effort: 'low',    fallback: 'gpt-6-luna',        fallbackProvider: 'openai',    maxOutputTokens: 1024 },
  medium:      { provider: 'google',    model: 'gemini-4-neon',    effort: 'medium', fallback: 'claude-sonnet-5-5', fallbackProvider: 'anthropic', maxOutputTokens: 4096 },
  substantial: { provider: 'google',    model: 'gemini-4-neon',    effort: 'high',   fallback: 'gpt-6.2-sol',       fallbackProvider: 'openai',    maxOutputTokens: 8192 },
  hard:        { provider: 'google',    model: 'gemini-4-neon',    effort: 'high',   fallback: 'claude-opus-5-5',   fallbackProvider: 'anthropic', maxOutputTokens: 8192 },
  exceptional: { provider: 'anthropic', model: 'claude-fable-5-2', effort: 'high',   fallback: 'gemini-4-neon',     fallbackProvider: 'google',    maxOutputTokens: 8192 },
});

// Usage:
import { callWithAutoEscalation } from './app-model-router.mjs';

const { output, receipt } = await callWithAutoEscalation({
  tier: 'fast',
  purpose: 'extract-invoice-json',
  execute: (route) => llm.run({ provider: route.provider, model: route.model, effort: route.effort, maxTokens: route.maxOutputTokens, prompt }),
  validate: (out) => typeof out?.total === 'number' && Boolean(out?.vendor),
});
// receipt: { ts, purpose, requestedTier, executedTier, model, effort, provider, usedFallback, escalated, valid, durationMs }
```

---

## 5. Keeping Production Apps Current Automatically

- **Weekly Benchmark Check:** When `com.ruvnet.goldie-weekly` + `model-auto-refresh.mjs` discovers a newer model generation or a better Artificial Analysis cost-to-solve winner, update `APP_MODEL_TIERS_JSON` (or the central Meta Proxy / gateway route table) once—every app picks up the upgrade immediately with zero code edits.
- **Canary Before Switching:** Before promoting a new production default in `APP_MODEL_TIERS_JSON`, run the app's own deterministic validation/schema suite against the candidate model to verify zero regressions.
