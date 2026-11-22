Updated: 2026-11-22 01:32:00 EST | Version 2.0.0
Created: 2026-10-05 EDT

# Model Routing Operations (Canonical Pointer)

> **Single Source of Truth:** All model routing, thinking-level optimization, quota hygiene, automatic failure escalation, and nightly/weekly auto-refresh rules are defined in [`docs/MODEL-ROUTING-ARCHITECTURE.md`](./MODEL-ROUTING-ARCHITECTURE.md).

## Operational Summary (All 4 Prepaid Subscription Hosts)

- **Zero Pay-By-The-Drink:** All 4 hosts (`antigravity`, `claude-code`, `codex`, `grok`) run exclusively on `$0` marginal-cost prepaid subscriptions (`subscriptionOnlyEnv()` strips all API keys; Meta Proxy Cloud stays OFF).
- **Default "Leave-It-Alone" Coordinators:**
  - Antigravity: `Gemini 4 Neon (Medium)` / `Gemini 4 Argon (Medium)`
  - Claude Code: `claude-sonnet-5-5` (`sonnet`)
  - Codex: `gpt-6.2-sol` (`medium`, `default_subagent_model = "gpt-6.2-sol"`)
  - Grok: `grok-4.7` (`low`/`medium`, `fork_secondary_model = "grok-build"`)
- **Active 5-Tier Allocation (AA v5.0.1 / Vals v2.2 / KingBench 4):**
  - `fast`: `gemini-4-neon @ low` | `claude-haiku-5-5 @ low` | `gpt-6-luna @ low` | `grok-4.7 @ low`
  - `medium`: `gemini-4-neon @ medium` | `claude-sonnet-5-5 @ medium/high` | `gpt-6.2-sol @ medium` | `grok-4.7 @ medium`
  - `substantial`: `gemini-4-neon @ high` | `claude-opus-5-5 @ medium` | `gpt-6.2-sol @ high` | `grok-4.7 @ high`
  - `hard`: `gemini-4-neon @ high` | `claude-opus-5-5 @ high` | `gpt-6.2-astra @ high` | `grok-build @ high`
  - `exceptional` (surgical `<5%` / automatic failure escalation): `gemini-4-neon @ xhigh` | `claude-fable-5-2 @ high` | `gpt-6.2-astra @ xhigh` | `grok-build @ xhigh`
- **Retired Legacy Behavior:** The October 5–7 controlled terminal wrappers (`claude-controlled-terminal.mjs`, `codex-managed-terminal.mjs`) remain retired; routing runs natively via `UserPromptSubmit` (`user-model-prompt-hook.mjs`), `PreToolUse` (`model-router-agent-hook.mjs`), and subagent delegation so native interactive features and ~95% warm prompt caches stay intact.
- **Verification & Self-Audit:**
  - Health & drift watchdog: `node ~/.claude/model-router/bin/model-routing-audit.mjs`
  - Live 4-host plan: `node ~/.claude/model-router/bin/model-router-status.mjs`
  - Live effectiveness chart: `node ~/.claude/model-router/bin/router-utilization.mjs`
  - Auto-refresh (runs nightly at 3:17 AM via `developer-maintenance.mjs` and weekly Monday 7:30 AM via `com.ruvnet.goldie-weekly`): `node ~/.claude/model-router/bin/model-auto-refresh.mjs`
