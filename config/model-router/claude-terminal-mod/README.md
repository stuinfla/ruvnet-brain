Updated: 2026-10-04 16:10:00 EDT | Version 0.1.1
Created: 2026-10-04 16:10:00 EDT

# Native terminal routing prototype

Tested against the installed Claude Code 2.1.289 native binary and its generated mod declarations. Mods require 2.1.287 or later. This routes the native host's own `turn.step` middleware: it passes model and effort to `yield* next(...)`, preserving the native streaming result and TUI. It does not call a separate inference API or inject slash commands.

`prepareClaudeTerminalMod({ destination })` in `scripts/claude-terminal-mod.mjs` materializes a private plugin directory, generates absolute Node/helper/engine paths, and copies the approved pure classifier into the mod. The source directory is deliberately unprepared. No Node APIs run inside sandboxed mod code. `$.process.run` invokes the bridge with prompt JSON on stdin, never in arguments. The existing policy engine validates current per-user catalog, profile, reviewed model/effort allocation and subscription eligibility. Review age remains evidence for the weekly refresh and does not revoke the owner-approved allocation; it supplies no native/default/metered fallback.

A launcher must provide `RNB_CLAUDE_MOD_NONCE` (64 lowercase hexadecimal characters) and `RNB_CLAUDE_MOD_RECEIPT` (absolute receipt filename in an already prepared private directory). `session.start` calls the bridge to write an atomic, mode-0600 activation receipt. The launcher must compare nonce, exact real plugin root, native version, source digest, timestamp and live process state before accepting startup. `prepareClaudeTerminalMod` returns `modDigest`; `terminalModDigest` recomputes it. The receipt's `pid` is the bridge parent's mod worker, not an asserted main CLI PID. `--health` supports the same bounded receipt schema; it does not invent a native crash guard.

`prompt.submit` approves the prompt once. Its optional `turnId` denotes a running turn, not the upcoming idle turn. A bounded FIFO stores pending text and decisions in RAM only. `turn.start` binds the next approved prompt to the newly minted exact turn ID. If native settings hooks settled different text, the bridge reclassifies that text using the original task class as a minimum. Image-only submissions use a conservative hard-review classification while passing original attachments and text unchanged. Every backend step keeps the bound model/effort and exact turn ID/index. Completion and session end remove decisions. Queue/active maps cap at 32 entries; pending prompts expire after five minutes. Direct mid-turn deliveries (a running `turnId` without `wait`) refuse because no new authoritative `turn.start` exists; queue the prompt to start its own turn. Subagent steps and unbound continuations refuse instead of borrowing the main turn's decision.

A prompt/helper failure returns `{ drop }` without `next`. A step failure returns an immediate native refusal result without `next`, retaining turn ID/index. Every consequential hook has a `.catch` handler whose refusal does no process, filesystem or model work. Missing activation refuses subsequent prompts and steps.

## Failure boundary

Claude Code can skip all hooks if the mod fails to load, the native mod worker crashes, hooks are disabled, another guard refuses registration, or a hook and its catch handler both fail. Other mods later in the chain can rewrite model/effort. A startup receipt proves that the activation hook ran for that nonce and source digest; it is not a perpetual guarantee that routing hooks remain active. This prototype cannot claim universal fail-closed enforcement. The root CLI wrapper owns the startup guard and any further runtime monitoring. Native model inference and rendered TUI acceptance remain separate checks; plugin tests stub the engine boundary and incur no inference.

## Checks

Run `claude plugin validate config/model-router/claude-terminal-mod`, `claude plugin test config/model-router/claude-terminal-mod`, and `vitest run tests/unit/claude-terminal-mod.test.mjs`. The native tests exercise the installed mod runtime, including two different turn allocations, high coding effort, final-text class floors, missing decisions and helper exceptions. Unit tests call the actual policy engine against isolated catalog/profile/policy fixtures, including stale allocation, invalid policy, absent hard model and disabled subscription states.
