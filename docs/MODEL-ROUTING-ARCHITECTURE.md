Updated: 2026-11-22 01:38:30 EST | Version 2.2.0
Created: 2026-11-22 01:32:00 EST
Author: Stuart Kerr (with Antigravity Gemini 4 Neon)
Status: CANONICAL — SINGLE SOURCE OF TRUTH (supersedes all prior 2026-07 and 2026-10 routing docs, research notes, and policies)

# MetaHarness 4-Host Subscription-Only Model & Thinking Router (Architecture, Philosophy & Forensic Rationale)

This document is the **sole authoritative specification** for model routing, thinking/effort allocation, quota hygiene, automatic failure escalation, and weekly/nightly self-refresh across Stuart Kerr's MacBook Pro (`MacBook-Pro-Max`, M3 Max 128 GB). It records **both what the system does and the exact evidence and philosophy behind every decision** so RuvNet Brain and future agents never drift back into older, wasteful patterns.

---

## 1. Origin & System Distinction (Never Confuse These Two Routers)

1. **Meta Proxy (`~/.ruflo/bin/meta-proxy`, managed by `ruflo proxy`) — KEEP CLOUD MODE OFF:**
   - Meta Proxy is Cognitum's standalone proxy binary (`v0.7.5`, kept updated nightly in `developer-maintenance.mjs` for hygiene only).
   - Its `cloud` / Power Saver mode routes traffic to `api.cognitum.one` and **bills per token ("by the drink")**.
   - **Rule:** Never enable Meta Proxy Cloud or Power Saver mode. Paid per-token billing violates the `$0` prepaid subscription mandate.
2. **MetaHarness Model Router (`~/.claude/model-router/` & `~/Code/ruvnet-brain/`) — THE ACTIVE ROUTER:**
   - Hybrid architecture: RuvNet/Ruflo ships the underlying `@metaharness/router` package, and Stuart built the subscription-first wrapper around it in `~/Code/ruvnet-brain` starting July 2026 (after the "$1,600 API billing lesson").
   - `subscriptionOnlyEnv()` in `scripts/subscription-hosts.mjs` strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, and `XAI_API_KEY` before launching any child process so it **cannot accidentally charge by the drink**.

---

## 2. Why We Rebuilt This (Forensic Audit of Sep 21 – Nov 21, 2026)

Before this rebuild, Stuart was repeatedly hitting weekly and 5-hour rate limits—especially in Claude Code—forcing him to jump between tools. A direct forensic audit of all local session transcripts and routing logs over the 60-day window (`2026-09-21` to `2026-11-21`) uncovered the exact root causes:

### Measured 60-Day Usage Across All 4 Hosts
- **Claude Code (`~/.claude/projects`):** `7,196` session files (`9.4 GB`), **`255,079` actual API turns**, **`63.34 Billion` total tokens (`~31.7B/month`)** = **`~$11,930/month` API-equivalent compute burn**.
  - `claude-opus-5-5`: `128,621` turns (`50.4%`), `34.50B` cache-read, `910.6M` cache-create, `96.17M` output (`$13,376` API-equiv / 60d)
  - `claude-fable-5-1` + `claude-fable-5-2`: `16,644` turns (`6.5%`), `3.84B` cache-read, `351.8M` cache-create, `22.14M` output (`$5,175` API-equiv / 60d)
  - `claude-sonnet-5-5`: `93,330` turns (`36.6%`), `20.92B` cache-read, `807.4M` cache-create, `86.56M` output (`$4,976` API-equiv / 60d)
  - `claude-haiku-5-5`: `16,285` turns (`6.4%`), `1.67B` cache-read, `115.4M` cache-create, `20.87M` output (`$332` API-equiv / 60d)
  - **Two massive hidden leaks discovered:**
    1. **57% of all turns (`62.9%` of tokens, `68%` of dollar burn)** ran on Opus 5.5 / Fable 5.1 / Fable 5.2 — even though normal day-to-day prompts (`Oct 4 – Nov 19`) were **78% routine/medium and only 22% hard** (and typical coding days were only 10%–12% hard). Why? Because when a parent chat sits on Opus 5.5, all 30–80 follow-up tool calls (reading files, `git status`, running tests) also burn Opus 5.5 quota.
    2. **`43%` of the entire Claude burn (`$10,204` of `$23,859` over 60 days)** was **pure cache-write fees** (`$5/Mtok` on Opus 5.5, `$10/Mtok` on Fable 5.2) caused by uncompacted 500k+ token conversations and multi-file searches dumped into main chat history.
- **Codex (`~/.codex/sessions`):** `20` sessions, `6,018` turns, **`842.7M` tokens (`~421M/mo`, `93.8%` cached)** = `~$120–$175/mo` API-equiv. Heavily under-utilized relative to a `$200/mo` Pro plan; `gpt-6-luna` fired only 4 times in 60 days and `default_subagent_model` was still pinned to `gpt-6.1-sol`.
- **Grok (`~/.grok/sessions`):** `523` session files (`48.1 MB`), `~$60–$120/mo` API-equiv. Had no `UserPromptSubmit` routing hook installed.
- **Antigravity / Gemini 4 (`~/.gemini/antigravity-cli/brain`):** `447` sessions (`8.84 MB` compact logs; newly ramped up Nov 20–21).

### The 6 Specific Bugs Fixed in This Rebuild
1. **Advice-Only Paralysis (since Oct 13, 2026):** The Oct 5–7 controlled terminal wrappers were retired on Oct 13 because hijacking the TUI broke native interactive features and subagents. Since then, `user-model-prompt-hook.mjs` told the AI *"advice only, not enforced, do not launch anything"*, so coordinators never delegated up or down and never showed what model handled the prompt.
2. **Fast Tier Starvation (`0.4%` hit rate):** `policy.default.mjs` restricted `fast` to a 9-word whitelist (`summarize|classify|extract|translate|rephrase|format|typo|alphabetical order|markdown table`) and disqualified any prompt with common verbs (`check`, `list`, `show`, `where`, `what`). Even simple lookups like *"do we have metallm set up?"* were forced to `medium` or `hard`.
3. **Antigravity Misrouted to Codex:** `user-model-prompt-hook.mjs` line 22 had `payload?.host === 'claude-code' ? 'claude-code' : 'codex'`, so Antigravity received OpenAI `gpt-6.1-sol` advice instead of native Gemini 4 tiers.
4. **Stale Model Generations:** `routing-policy.json` was stuck on Oct 4 (`gpt-6.1-sol`, `gpt-6-astra`, `claude-sonnet-5-5` for `fast`, no `claude-fable-5-2`), even after `native-availability.json` discovered `gpt-6.2-sol` and `gpt-6.2-astra`.
5. **Broken Weekly Refresh:** `model-weekly-cycle.mjs` flagged `status: 'blocked'` whenever OpenRouter retired ancient 2024 models (`o1-pro`, `o3-mini-high`) that weren't even in `routing-policy.json`, and `developer-maintenance.mjs` wasn't running model catalog refresh.
6. **Frozen RuvNet Brain Dashboard (since Aug 8, 2026):** `route-cheap.mjs` only priced models up to `claude-opus-5` (Aug 8), causing `dispatch-receipt.mjs` to reject every 5.5/6.2/Gemini 4 subagent receipt as "unpriced", and `router-utilization.mjs` only read `routing-receipts.jsonl` instead of `routing-decisions.jsonl`.

---

## 3. Core Routing Philosophy ("Why" Every Design Choice Exists)

### Philosophy A: Intra-Vendor Tiering for Speed, Cross-Vendor Only for Two Jobs
- **Why mixing vendors on every routine turn is DUMB (The Cache Tax):**
  - `96.7%` of Claude input tokens and `93.8%` of Codex input tokens are **warm prompt cache reads** (90%–95% cheaper and ~1s latency).
  - Bouncing a routine turn from Claude Code to Codex or Grok mid-conversation starts a **cold cache** (re-reading the repo from disk = 5x–10x token burn + 15–30s CLI spawn lag + broken editor undo history).
- **The Rule:**
  - **90% of interactive turns stay IN-VENDOR** on the tool you have open, stepping across that vendor's own 5 tiers (`fast` -> `medium` -> `substantial` -> `hard` -> `exceptional`) via subagent delegation.
  - **Cross-vendor mixing is used ONLY for:**
    1. **Second-Opinion / Adversarial Review (`scripts/dual-host-deliberation.mjs`):** On high-stakes architecture, security, or stubborn bugs (~5% of work), having two different model families independently challenge the plan catches blind spots no single vendor catches alone—at `$0` extra cost.
    2. **Cold Heavy Multi-File Offload & Quota Load-Shedding:** When a vendor's 5h/7d window runs hot (>80%) or when starting a cold multi-file refactor/RAG task, run it in **Antigravity (Gemini 4 Neon)** where implicit caching has **$0.00 cache-write fees** (eliminating Anthropic's 43% cache-write penalty).

### Philosophy B: Thinking-Level Economics (Not Just Model Names)
Because reasoning models bill internal thinking tokens at the output rate, **thinking level (`low` / `medium` / `high` / `xhigh` / `max`) has as much impact on speed and quota burn as the model name itself.**

Grounded in **Artificial Analysis Intelligence Index v5.0.1**, **Vals Index v2.2**, **MindStudio KingBench 4**, **CursorBench 4.1**, and **Terminal-Bench 4.1**:

| Thinking / Effort | Gemini 4 Neon (Score / Cost / Time) | Claude Opus 5.5 (Score / Cost / Time) | Claude Fable 5.2 (Score / Cost / Time) |
| :--- | :--- | :--- | :--- |
| **Low** | `44` \| `$0.75` \| `3.7 min` | `35` \| `$0.98` \| `3.0 min` | `54` \| `$3.10` \| `5.5 min` |
| **Medium** | `55` \| `$1.90` \| `8.4 min` | `48` \| `$2.45` \| `6.7 min` | `56` \| `$3.80` \| `6.5 min` |
| **High** | **`60` \| `$3.74` \| `14.3 min`** *(Optimal)* | **`52` \| `$3.46` \| `9.2 min`** | **`62` \| `$9.08` \| `15.1 min`** *(Surgical)* |
| **XHigh** | `61` \| `$6.44` \| `22.3 min` *(+72% for +1 pt)* | `57` \| `$6.05` \| `15.8 min` | `62` \| `$14.83` \| `24.5 min` |
| **Max** | N/A | `59` \| `$10.04` \| `25.6 min` *(Avoid)* | `65` \| `$26.54` \| `42.2 min` *(Avoid)* |

- **Why `xhigh` and `max` are banned as routine defaults:** Jumping Neon `high -> xhigh` costs **+72% more ($3.74 -> $6.44)** for **+1 index point (60 -> 61)**; jumping Fable 5.2 `high -> max` costs **+192% more ($9.08 -> $26.54)** for **+3 points (62 -> 65)**.
- **Why Gemini 4 Neon is the primary multi-file engine:** Neon `high` (score `60` @ `$3.74`) beats Opus 5.5 `max` (score `59` @ `$10.04`) for nearly 1/3rd the cost, 11 minutes faster, with `$0` implicit cache-write fees and `95.2%` on GraphWalks 256K–1M (vs. Opus 5.5's `66.8%`).
- **Why Claude Opus 5.5 is capped at `medium`/`high`:** Opus 5.5 wins on pure terminal/bash execution (Terminal-Bench 4.1: `65.8%` vs. Neon's `65.2%`) and defensive security instincts. Never pay `$10.04/task` for Opus `max`.
- **Why Claude Fable 5.2 is strictly surgical (`<5%` of tasks, `high` effort, pre-distilled context):** On KingBench 4, Fable 5.2 scored #1 (`42.0/60`) but burned **212M tokens (`~$222`)** inside open-ended repo discovery vs. Neon's **27.1M tokens (`$20.36`)**—an 11x cost multiplier for +10% score. Therefore, Fable 5.2 is NEVER allowed to roam a repository; the coordinator distills the exact files/problem first and calls Fable 5.2 `@ high` strictly for initial system architecture, novel algorithms, final adversarial review, or prior-attempt failure escalation.

### Philosophy C: "Leave-It-Alone" Coordinators + Automatic Failure Escalation
Stuart should **never** have to call out model names or flip sliders.
- **Default Coordinators:**
  - **Antigravity:** `Gemini 4 Neon (Medium)` / `Gemini 4 Argon (Medium)` (`~/.gemini/antigravity-cli/settings.json`)
  - **Claude Code:** `sonnet` / `claude-sonnet-5-5` (`~/.claude/settings.json`)
  - **Codex:** `gpt-6.2-sol @ medium` (`~/.codex/config.toml`, `default_subagent_model = "gpt-6.2-sol"`)
  - **Grok:** `grok-4.7 @ low/medium`, `fork_secondary_model = "grok-build"` (`~/.grok/config.toml`)
- **Active 4-Host × 5-Tier Allocation (`~/.claude/model-router/routing-policy.json`):**

| Tier | Trigger | Antigravity (Ultra) | Claude Code (Max) | Codex (ChatGPT) | Grok (xAI Sub) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`fast`** | Mechanical edits, typos, quick status/version/lookup prompts, bulk file scans | `gemini-4-neon @ low` *(subagents: `flash`)* | `claude-haiku-5-5 @ low` *(subagents: `haiku`)* | `gpt-6-luna @ low` | `grok-4.7 @ low` |
| **`medium`** *(Default)* | Routine coding, debugging, single-module edits, feature work | `gemini-4-neon @ medium` | `claude-sonnet-5-5 @ medium` *(`high` for code)* | `gpt-6.2-sol @ medium` | `grok-4.7 @ medium` |
| **`substantial`** | Broad multi-file / cross-module implementation with settled design | `gemini-4-neon @ high` | `claude-opus-5-5 @ medium` | `gpt-6.2-sol @ high` | `grok-4.7 @ high` |
| **`hard`** | Architecture tradeoffs, security audits, race conditions, failover bugs, final review | `gemini-4-neon @ high` *(via `pro` subagent)* | `claude-opus-5-5 @ high` *(via `opus` subagent)* | `gpt-6.2-astra @ high` *(via `spawn_agent`)* | `grok-build @ high` |
| **`exceptional`** | Surgical frontier problems, formal proofs, or **automatic escalation when `hard` fails** | `gemini-4-neon @ xhigh` | `claude-fable-5-2 @ high` | `gpt-6.2-astra @ xhigh` | `grok-build @ xhigh` |

- **Automatic Failure Escalation:** Implemented in `policy.default.mjs` (`PRIOR_FAILURE` + `verifiedTaskQualityFailure`) and `user-model-prompt-hook.mjs`. If a test/build fails twice at the current tier, or if Stuart reports *"still broken / that didn't work / failed again"*, the router automatically steps up one tier (`fast -> medium -> hard -> exceptional`) with distilled failure evidence.
- **Line-1 Visibility Badge:** Every interactive reply begins with `[Routed: <tier> -> <model> (<effort> thinking) · $0 subscription]`.

---

## 4. The 4 Mandatory Quota-Hygiene Rules (Wired Into Hooks & Statuslines)

Injected on every prompt by `user-model-prompt-hook.mjs` and enforced visually in `statusline-ruflo.cjs` and `~/.grok/statusline.cjs`:

1. **Subagent Isolation for Multi-File Searches:** Never dump >5 raw files or large logs into main chat history; offload repo/log scans to a `fast` subagent (`Haiku 5.5` / `Gemini Flash` / `GPT-6 Luna`) so raw text dies with the subagent instead of being re-billed on every subsequent turn.
2. **50% Context Compact Guard (`⚡/compact`):** Both statuslines flash **`⚡/compact`** in bright red whenever `🧠 ctx >= 50%`. Compacting or starting a fresh chat at 50% cuts per-turn token burn by **5x–10x**.
3. **Pre-Distilled Context Before Frontier Escalation:** Never let `Fable 5.2`, `Neon xhigh`, `Astra xhigh`, or `Grok-Build xhigh` do open-ended repo discovery; distill exact files and errors first.
4. **Cross-Vendor Load-Shedding:** Keep interactive turns in-vendor for warm cache; shift heavy cold multi-file refactors or hot-quota (>80%) workloads to Antigravity (`Gemini 4 Neon`, `$0` cache-write fees) or an under-utilized subscription pool.

---

## 5. Automated Self-Refresh, Watchdog Audit & Dashboard Observability

- **Nightly Auto-Refresh (3:17 AM via `~/.codex/scripts/developer-maintenance.mjs`):** Runs `maintainModelRouter(apply)` -> `model-auto-refresh.mjs` alongside VS Code, Meta Proxy (`0.7.5`), Grok (`1.0.93`), and Antigravity (`agy 1.5.14`).
- **Weekly Auto-Refresh (Monday 7:30 AM via LaunchAgent `com.ruvnet.goldie-weekly` -> `goldie-weekly.sh`):** Runs `model-auto-refresh.mjs` + `model-weekly-cycle.mjs`.
- **Automatic Same-Family Promotion:** `model-auto-refresh.mjs` reads live local CLI caches (`~/.codex/models_cache.json`, etc.), registers newly discovered subscription models into `catalog.json` with verified efforts, and auto-promotes newer minor versions within the same family (`gpt-6.X-sol`, `gpt-6.X-astra`, `claude-fable-5-X`, `gemini-4-*`, `grok-4.X`) into `routing-policy.json` while keeping thinking-level caps locked.
- **Self-Audit Watchdog (`scripts/model-routing-audit.mjs`):** Run `node ~/.claude/model-router/bin/model-routing-audit.mjs` to check all 13 live invariants (4 hosts enabled at `$0`, 6 paid API keys off, 20 routes + effort caps intact, 36/36 eval cases passing, live hook verification on all 4 hosts, 50% `⚡/compact` statuslines, nightly + weekly refresh schedules wired, Meta Proxy Cloud off) and emit explicit `ALERT` lines if anything drifts.
- **Live Effectiveness Dashboard:** `scripts/router-utilization.mjs` reads both `routing-decisions.jsonl` and `routing-receipts.jsonl` with AA v5.0.1 effort-weighted quota equivalence, powering both the CLI bar graph (`node ~/.claude/model-router/bin/router-utilization.mjs`) and the RuvNet Brain Console (`node ~/Code/ruvnet-brain/scripts/onboarding-console.mjs` -> **Smart model routing** card).

---

## 6. Subscription Plan Sizing (Minimizing Spend While Maximizing Throughput)

Based on the 60-day measured baseline (`Sep 21 – Nov 21, 2026`) and the **3.8x–4.8x** Claude quota stretch + Antigravity Neon `$0` cache-write offload:

| Platform | 60-Day Measured Usage | Historical Burn (API-Equiv) | Optimized Burn (Same Work) | Recommended Subscription |
| :--- | :--- | :--- | :--- | :--- |
| **Antigravity (Gemini 4)** | `447` sessions (ramped Nov 20–21) | Primary new multi-file engine | `$0` cache-write fee; 3–4x efficiency vs Claude | **1 × Antigravity Ultra** *(Primary daily driver)* |
| **Claude Code (Anthropic)** | `255,079` turns / `63.34B` tokens | `~$11,930/mo` | `~$1,200–$2,000/mo` *(3.8x–4.8x stretch + Neon offload)* | **1 × Claude Max $100** *(drop 2nd seat after 14-day proof)* |
| **Codex (OpenAI)** | `20` sessions / `6,018` turns / `842.7M` tokens (`93.8%` cached) | `~$120–$175/mo` | `~$45–$70/mo` *(2.5x–3.0x stretch)* | **Downgrade $200 Pro -> $20 Plus** *(saves $180/mo)* |
| **Grok (xAI)** | `523` sessions (`48.1 MB` logs) | `~$60–$120/mo` | `~$40–$80/mo` *(1.5x–2.0x stretch)* | **1 × Standard SuperGrok** *(no $300 Heavy)* |

---

## 7. Forensic Thought Process & How Things Got Messed Up (So Future Agents Catch Up in 60 Seconds)

When diagnosing routing or quota problems in the future, do **not** trust summaries or high-level status chips—follow the exact evidence trail that exposed every hidden failure on `2026-11-22`:

### How the System Drifted (July 2026 -> November 2026)
1. **July 10–13, 2026 (The `$1,600` Lesson):** MetaHarness routing was first built to save money via OpenRouter (`route-cheap.mjs` -> `~/.claude/metaharness/routing-receipts.jsonl`), then locked to `$0` prepaid subscriptions (`subscriptionOnlyEnv()`).
2. **August 8, 2026 (Silent Ledger Freeze):** `route-cheap.mjs` (`CLAUDE_TIERS`) was last updated for `claude-opus-5`. When Claude 5.5 (`haiku-5-5`, `sonnet-5-5`, `opus-5-5`), Fable 5.1/5.2, GPT-6.x, and Gemini 4 arrived, `priceOf(model)` returned `null`. Because `dispatch-receipt.mjs` refuses to invent prices, **every single subagent receipt silently failed with exit code 2 after August 8**, making the RuvNet Brain Console look like routing had stopped.
3. **October 5–13, 2026 (Wrapper Retirement -> Advice-Only Paralysis):** Controlled terminal wrappers (`claude-controlled-terminal.mjs`, `codex-managed-terminal.mjs`) enforced per-prompt model launches for 3 days, but hijacking the TUI broke native interactive features and subagents. On Oct 13, the wrappers were retired to `~/.claude/archive/rnb-terminal-routing-20261013/`, leaving `user-model-prompt-hook.mjs` running in *"advice only, do not launch anything"* mode.
4. **October 13 – November 21, 2026 (Five Compounding Silent Failures):**
   - **False 60/40 Split Trap:** Looking only at aggregate counts in `routing-decisions.jsonl` showed `58.8% medium / 39.5% hard / 0.4% fast`. Breaking it down **by calendar day** revealed the truth: normal workdays (`Oct 4 – Nov 19`) were **78% routine and only 22% hard**, while **Nov 20–21 alone had `3,589` synthetic test prompts (`2,564 hard`)** written by test runs that didn't redirect `MODEL_ROUTER_DECISIONS` to `/tmp`.
   - **Actual Execution vs. Advice Gap:** Scanning the real session transcripts (`~/.claude/projects/*.jsonl`)—not just the decision log—proved `255,079` real turns executed `57%` on Opus 5.5/Fable (`62.9%` of tokens) and burned `$10,204` in pure cache-write fees (`43%` of total burn) because parent sessions stayed parked on Opus 5.5 and never compacted at 50%.
   - **Why `fast` Was Starved (0.4%):** `policy.default.mjs` required one of 9 narrow mechanical words AND banned every common verb (`check`, `list`, `show`, `where`, `what`).
   - **Why Antigravity Got Codex Models:** `user-model-prompt-hook.mjs` line 22 used a binary ternary (`host === 'claude-code' ? 'claude-code' : 'codex'`), silently mapping `antigravity` to `codex`.
   - **Why `model-router-status.mjs` Lied:** Line 114 checked `p[t].cost == null` instead of `(p[t].cost == null || p[t].cost === 0)`, printing `(no subscription-covered models)` even when `est_input_cost_usd` was `0`.
   - **Why Weekly Refresh Stalled:** `model-weekly-cycle.mjs` line 116 marked the entire weekly check `blocked` whenever OpenRouter retired ancient 2024 models (`o1-pro`, `o3-mini-high`) unrelated to `routing-policy.json`, and `model-native-catalog.mjs` appended `gpt-6.2-sol`/`gpt-6.2-astra` to `catalog.json` without ever promoting them in `routing-policy.json`.

---

## 8. How to Keep It Clean — Rapid-Recovery Playbook

If Stuart ever notices (a) he is hitting 5-hour/weekly limits again, (b) the `[Routed: ...]` badge disappears, (c) a new model generation launches and isn't being used, or (d) the RuvNet Brain Console stops updating, run these **5 checks in order**:

1. **Run the 13-Point Self-Audit Watchdog First:**
   ```bash
   node ~/.claude/model-router/bin/model-routing-audit.mjs
   ```
   - Must return **`PASS (13/13 checks passed)`**. Any `ALERT [...]` line names the exact broken invariant (`profile-hosts`, `zero-api-keys`, `policy-routes`, `effort-caps`, `eval-suite`, `hook-*`, `grok-hook-wired`, `statusline-compact-guard`, `auto-refresh-schedules`, `meta-proxy-cloud-off`).

2. **Check Live 4-Host Allocation & Effectiveness Graph:**
   ```bash
   node ~/.claude/model-router/bin/model-router-status.mjs
   node ~/.claude/model-router/bin/router-utilization.mjs
   ```
   - Confirm all 4 hosts show `$0 subscription`, `fast` routes to `low` thinking, no routine tier uses `xhigh`/`max`, and `router-utilization.mjs` shows rising `Cheap / Fast` and `Mid Workhorse` shares.

3. **Force a Model Catalog & Same-Family Refresh Check:**
   ```bash
   node ~/.claude/model-router/bin/model-auto-refresh.mjs
   node ~/.codex/scripts/developer-maintenance.mjs --check
   ```
   - Confirm `modelRouter.ok === true` and `metaProxy`, `grok`, and `agy` are `current`.

4. **Check for Sync Drift Between `~/.claude/model-router/` and `~/Code/ruvnet-brain/`:**
   - **Why this matters:** `~/Code/ruvnet-brain` is the source repo; `~/.claude/model-router/` is the installed runtime; `~/.claude/plugins/marketplaces/ruvnet-brain/` is the plugin cache. If you only edit one without syncing the others, the next Brain update can overwrite your fix.
   - Always keep `model-router-engine.mjs`, `user-model-prompt-hook.mjs`, `model-router-status.mjs`, `model-auto-refresh.mjs`, `model-routing-audit.mjs`, `route-cheap.mjs`, `router-utilization.mjs`, and `policy.default.mjs` identical across both locations.

5. **Verify Real Transcript Burn (Ground Truth When Quotas Feel Tight):**
   - Never rely solely on `routing-decisions.jsonl` if quotas are burning fast—inspect actual executed turns in `~/.claude/projects/*.jsonl` and `~/.codex/sessions/*.jsonl` to verify:
     1. Frontier turns (`Opus 5.5` / `Fable 5.2` / `Astra`) are staying **under ~15–20%** of total turns.
     2. Prompt cache hit rate remains **>90%** (if it drops, check whether sessions are compacting at 50% and whether multi-file searches are isolated in `fast` subagents).
     3. No paid API keys leaked into `profile.json` and Meta Proxy Cloud remains OFF.
