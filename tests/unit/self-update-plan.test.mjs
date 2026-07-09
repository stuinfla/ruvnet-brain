// tests/unit/self-update-plan.test.mjs — scripts/self-update.mjs's freshness/rebuild decision
// (lines 53-65) is the exact bug class that already bit this repo once: ruflo + agentic-flow were
// stamped `builtFromSha: 'unknown'` and self-update treated 'unknown' as up-to-date, so the two
// most-central repos silently NEVER auto-rebuilt until a version bump exposed it (see
// PROGRESS.md 2026-07-05 entry). That fix is now encoded as the `action` branching below, but it
// has never been unit-tested — a future refactor could reintroduce the exact same silent-staleness
// bug and nothing would catch it.
//
// PREREQUISITE: this logic is NOT a function — it's inline module-top-level code (a `for` loop
// building the `plan` array directly at import time, driven by `remoteHead()` doing REAL
// `git ls-remote` network calls). Importing self-update.mjs for a test would both (a) run real
// network calls and (b) be untestable with fixture inputs since nothing is parameterized. The fix
// is a pure-function extraction — no behavior change, just giving the existing branching a name
// and a fixture-friendly signature:
//
//   export function planAction(built, live) {
//     if (!built) return 'build (new)';
//     if (built === 'unknown') return live ? 'rebuild (changed)' : 'up-to-date';
//     if (live && live !== built) return 'rebuild (changed)';
//     return 'up-to-date';
//   }
//
// ...then have the existing loop (lines 53-65) call `planAction(built, live)` instead of inlining
// the branches. Flag to Stuart before applying — confirm the extracted signature matches intent
// before landing it, since this is the exact logic a prior real incident was caused by.
import { describe, it, expect } from 'vitest';

describe.todo('self-update.mjs — planAction(built, live) (requires extracting the inline branch into a named export, see file header)', () => {
  it.todo('returns "build (new)" when built is null/undefined (never built before)');
  it.todo('returns "rebuild (changed)" when built === "unknown" and live is reachable — the exact ruflo/agentic-flow incident this logic exists to prevent; must NOT regress to "up-to-date"');
  it.todo('returns "up-to-date" when built === "unknown" and live is unreachable (git ls-remote failed) — cannot prove staleness, so do not force a rebuild blind');
  it.todo('returns "rebuild (changed)" when live is a real SHA that differs from built');
  it.todo('returns "up-to-date" when live === built');
});
