---
id: ADR-043
title: The continuation gate re-engages every stop, not once per session — the guard that killed "don't stop"
status: Proposed
date: 2026-07-23
updated: 2026-10-29
authors: [Stuart Kerr, Claude Code]
tags: [proactive, learning, stop-hook, continuation, enforcement, dogfooding, 4.0]
supersedes: []
relates: [ADR-028, ADR-030]
---

**Status**: Proposed (2026-07-23)

Governed DDD: none. This is a single-function change to one hook; it introduces no new bounded context,
aggregate, or domain event. A DDD would be ceremony — stated out loud per the no-silent-substitution
discipline rather than skipped silently.

## The problem, from the owner, in one session (2026-07-23)

> *"You used to continue things, but now you stop at the end of turns… you had fixed it, but then you
> created a bug, so now you seem to have removed the entire set of functionality."* … *"I need that
> fixed permanently across all projects… so things stop stopping."*

And the deeper indictment, which is the one that matters:

> *"How the hell is the intelligence and learning ready if you're still making decisions this poor?"*

He is right, and it is the sharpest statement of ADR-030's open gap. The lessons
`lesson-turned-loose-maximize-never-stop` and `lesson-default-to-parallel-swarms` are **already promoted
and surfaced to the model at every session start** — and the model stopped anyway. A lesson that is
stored, retrieved, and surfaced but does not change behaviour at its decision point is ADR-030
verification #1 failing in the wild. **The model's own stopping is the falsification.** This ADR is the
enforcement mechanism the "never stop" lesson has been missing.

## Root cause — and a mechanism scare that verify-first caught

The gate (`plugin/scripts/continuation-gate.mjs`) already uses a **working** continuation mechanism:
`additionalContext` in a `hookSpecificOutput` envelope at exit 0. The single defect is that it fires
**at most once per session** and then goes silent:

```
if (hookInput.session_id && led.nudgedSession === hookInput.session_id) process.exit(EXIT_ALLOW);  // lines 165-166
```

The existing contract test `hook-contract.test.mjs:105-113` *encodes that silence as correct*
(`expect(second.stdout).toBe('')`). So after the first nudge in a session, every subsequent natural
stop with outstanding work is unguarded — which is precisely "things stop stopping."

**The scare, and why it is in the record.** A first pass nearly rewrote this to exit 2, on the strength
of the `claude-code-internals` skill, which stated *"exit 0 = end, exit 2 = continue; additionalContext
at exit 0 is a passive FYI."* Because this is a machine-wide hook, the mechanism was confirmed against
the **official docs** (`claude-code-guide` agent, which itself caught its own first WebFetch hallucinating
a framing and re-pulled the raw markdown via `curl` to quote verbatim). The authoritative contract from
`code.claude.com/docs/en/hooks.md`:

| Stop-hook mechanism | Forces continuation? | Under `stop_hook_active` + 8-consecutive cap? |
|---|---|---|
| exit 0, plain stdout | No — stop proceeds | — |
| exit 0, `hookSpecificOutput.additionalContext` | **Yes** (labeled "Stop hook feedback") | **Yes** |
| exit 0, `{"decision":"block","reason":…}` | **Yes** | Yes |
| exit 2, stderr | **Yes** | Yes |

**The reverse-engineered internals doc was wrong; the gate's own comments were right.** So the exit-2
rewrite was unnecessary *and* would have added risk (removing `|| true`, changing the fail-open surface)
for no benefit. The lesson-verify-architecture-before-changing-it rule paid for itself here directly.

## Decision

Make the gate **re-engage on every fresh natural stop** with genuine open work, keeping the mechanism
and loop-safety exactly as they already are:

1. **Remove the once-per-session `nudgedSession` guard** (lines 165-166). This is the whole bug.
2. **Keep `additionalContext` at exit 0** — the documented, working continuation channel. No exit-2, no
   `|| true` removal, no wiring change. Surgical.
3. **Keep the `stop_hook_active` guard** (line 147: `if (stop_hook_active) exit 0`). This is the
   documented loop-safety and it is what prevents the 2026-07-22 runaway: a fresh stop forces exactly
   ONE continuation, because the next stop in that chain has `stop_hook_active === true` and exits 0.
   The harness's 8-consecutive cap is the backstop beneath that.
4. **Directive copy, not an escape hatch.** The current text — *"if the remaining items are genuinely
   blocked or already done, say so and finish the turn"* — invites the exact rationalisation it should
   prevent. New copy instructs continuation and sanctions stopping only when **all** remaining items are
   done or genuinely blocked, each with a one-line reason.

**Why this is safe and not a re-run of the 2026-07-22 incident.** That incident continued 8 times
consecutively because the gate *ignored stdin* — the `stop_hook_active` guard was unreachable. With the
guard live (it has been since 3.9.9), the ceiling per natural-stop episode is one forced continuation,
not eight. Removing `nudgedSession` changes "once per session" to "once per fresh natural stop with open
work" — the behaviour the owner explicitly asked for, still bounded by the same guard the incident
lacked.

**Scope — machine-wide by construction, which is the ask.** The gate is a user-level plugin hook, so
this governs every project on the machine ("fixed permanently across all projects").

## Failure modes the duel must red-team

1. **Runaway** — is `stop_hook_active` truly sufficient once `nudgedSession` is gone, or is there a
   sequence (subagent stops, nested continuations) where it does not reset and the 8-cap is the only
   thing stopping a machine-wide loop again?
2. **Stale-ledger nag** — items never marked done now force a continuation on every user turn forever.
   Is a staleness TTL / max-age required, or is "mark it done or `--clear`" acceptable?
3. **Non-interactive / CI / subagent** — should re-engagement be gated to interactive sessions so a
   headless run is never trapped?
4. **Gaming** — does a mechanical Stop gate just teach the model to mark items done without doing them?
   Is that better or worse than stopping?

## Verification (before Accepted) — each test proven to FAIL on the un-fixed gate first

1. A SECOND fresh natural stop in the same session with open work re-nudges (kills the once-per-session
   silence the current test encodes).
2. `stop_hook_active === true` → exit 0, silent (loop-safety preserved; the existing test at
   `hook-contract.test.mjs:70-80` must stay green).
3. A corrupt/unreadable ledger → exit 0 (fail-open, unchanged).
4. No open work → exit 0 (silence carries no false alarm — ADR-028's zero-false-alarm bar).
5. The Fable-5 × GPT-5.6 duel is recorded in `docs/reviews/0043-*.md`, including anything it defeated.

## Duel outcome — Fable 5 (2026-07-23) + GPT-5.6-Sol (2026-07-24), a real two-model duel

Recorded in `docs/reviews/0043-duel-continuation-gate.md`. **Correction (2026-07-24): I first recorded that
"GPT-5.6-Sol was degraded and produced no output" — that was FALSE, and the owner caught it.** `codex`'s
model IS `gpt-5.6-sol` and runs fine; the `missing field supports_reasoning_summaries` line is a non-fatal
cache warning. My failures were invocation errors (a variadic `-i` ate the prompt; a 120s tool-timeout).
The genuine GPT-5.6-Sol pass has since run — **VERDICT: SIGN-WITH-CHANGES** — and found three real residual
holes Fable and I both missed (an empty `{}` still forced; the cooldown was fail-open + racy; a missing `at`
bypassed the TTL and `--done` could clear a singleton by substring), all now fixed with tests. This is a
true two-model duel: Fable REJECT-in-proposed-form → hardened, GPT-5.6-Sol SIGN-WITH-CHANGES → applied.

Fable's verdict was **REJECT-in-proposed-form**, and it was right on the substance even though it reviewed
the earlier exit-2 draft. Four findings were adopted into the committed fix, each with a falsifiable test:

- **#1 stdin laundering (a real loop bug).** `readHookInput` returned `{}` on a parse failure, which under
  a forcing gate reads as "fresh stop" → a machine-wide loop (macOS `EAGAIN` on `readFileSync(0)` is a real
  footgun). Fixed: a `__source` tag; only an affirmatively-parsed payload may force. Plus `stop_hook_active`
  is now truthy-checked, and a **cooldown this file owns** (`COOLDOWN_MS`, default 20s) bounds any runaway
  the harness field fails to stop — because a machine-wide hook must not rest 100% on one harness field.
- **#3 stale-ledger fabrication pressure + the `--done` barn door.** Added a 24h freshness TTL (stale items
  stop forcing, never re-nag), and killed `--done`'s substring match (`--done "e"` could clear the whole
  ledger) — now exact-or-unambiguous only.
- **Wiring:** added `timeout: 10` to the Stop hook. `|| true` is **kept** (the crash-fail-open Fable worried
  about under the exit-2 draft is handled by it, since the gate now forces via `additionalContext` at exit 0).

**Deferred, and named rather than silently dropped:** (a) `projectKey()` keys by basename, so two repos of
the same name could share a ledger — a full-path hash is the fix, deferred because it orphans existing
ledgers and needs a migration; (b) headless/CI/subagent runs could still eat one forced turn if their
project ledger has fresh items — the empty-by-default ledger and the TTL bound this, but an interactive-only
gate is the real answer; (c) a public opt-in switch is **not** needed today because nothing auto-populates
the ledger (verified: no `--commit-to` in `hooks.json`), so a fresh install never forces — but the moment
any auto-populator is added, forcing must become opt-in.

## Consequences

This does not move a metric on its own. It is a **forced re-confrontation with the open list** — a strong,
bounded nudge — not full enforcement: honestly, the gate enforces the *ledger*, not the lesson (it sees only
what was registered via `--commit-to`, so the "agree in prose then stop silently" failure is still uncaught
unless a capture path feeds it), and discharge is one `--done` away. Calling it "makes a lesson enforce"
would overstate it — corrected here per Fable #5. Still, it is the first mechanism that makes the *never-stop*
commitment cost something at the exact boundary it was being ignored, which is the half of ADR-030 the
model's own stopping exposed. Decision + duel landed here before the fix was committed.

## Update 2026-10-29 (#369)

A captured promise records the inline-code commands of its sentence (`evidenceCommands`, max 2). The same session's later observed check of that command, with a matching claim and a stated gap, moves it to `evidenced`, which is not `done` and is no longer forced; promises with no command keep the bounded forces then `deferred`.
