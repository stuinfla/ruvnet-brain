# Cross-Host Continuity Plane SOTA Report — 2026-09-10

## TL;DR

Tonight's rotation drew SLOT 0 (`20260910 % 5 == 0`) — `cross-host-conformance`, scan
`codex-parity`,`stranger-project-behaviour`. Per this repo's own ISSUE DISPOSITION OVERRIDE, the
first duty is reconciliation, not fresh manufacture. All four open issues on this DEEP surface
predating tonight — **#171** (Codex CLI never installed in the integration CI job), **#173**
(codex-hook-adapter dropping valid JSON, not just prose, on `SessionEnd`/`PreCompact`), **#254**
(Codex dispatch never threading the payload's `cwd`), **#256** (`codex-hook-wrapper.mjs`'s
`blockingHooks` naming a dead `route-dispatch` entry) — were found **already integrated on `main`**,
verified directly by reading current source and re-running their own regression tests, not assumed
from PR state. All four PRs (#172, #174, #255, #257) were closed unmerged in the 2026-09-07 batch,
but each fix independently landed on `main` — the same "release-reconciliation path" PRs #269/#276
documented for other surfaces. Closed all four issues tonight with evidence (comments + this report).

That freed the night for a targeted adversarial check of the one genuinely new artifact on this
surface: `bin/install.mjs` commit `5642043` ("fix(hooks): restore constrained continuity lifecycle
plane", human-authored, 2026-09-09 — one day before this run) rewrote both `plugin/hooks/hooks.json`
and `plugin/hooks/codex-hooks.json` from an empty, fully-retired registry back to a narrow two-handler
continuity plane (`SessionStart`→`session-start`, `Stop`→`continuation-gate`), backed by a new
`plugin/scripts/continuity-hook-policy.mjs` allowlist module. This is exactly the cross-host surface
tonight's slot targets, landed the day before the first cross-host-conformance rotation since, and
had not yet been independently re-audited for a Claude/Codex parity gap.

## Hypothesis (frozen before verification)

> Given the 2026-09-09 continuity-plane restore (`5642043`), which re-registers `SessionStart` and
> `Stop` independently in `plugin/hooks/hooks.json` (Claude) and `plugin/hooks/codex-hooks.json`
> (Codex), when the two hosts' matcher strings, per-layer timeout budgets, and
> `continuity-hook-policy.mjs` allowlist enforcement are compared directly, then a parity gap
> (a matcher or timeout that diverges without a documented reason, or a registration one host's
> retirement lint would silently miss) will be found — subject to: any gap found must be reproduced
> against current `main` source, not inferred from the diff alone.

## Verification (adversarial re-read, not the restore's own author)

**Matchers.** `hooks.json` `SessionStart.matcher` = `codex-hooks.json` `SessionStart.matcher` =
`"startup|resume|clear|compact|fork"`. `hooks.json` `Stop.matcher` = `codex-hooks.json`
`Stop.matcher` = `"*"`. Byte-identical on both hosts, matching `continuity-hook-policy.mjs`'s single
`CONTINUITY_EVENTS` source of truth (`isAllowedContinuityRegistration()` checks the same `spec.matcher`
regardless of which host file is being linted).

**Timeout budget chains.** Each host runs a 3-layer chain (host-declared hook timeout → the Codex
trampoline's own inner `spawnSync` budget → `codex-hook-wrapper.mjs`'s `timeoutFor()`), each layer
strictly inside the one above it, leaving margin for its own dispatch overhead:

| Event | Codex host timeout (`codex-hooks.json`) | Codex trampoline inner budget (hardcoded arg) | `codex-hook-wrapper.mjs` `timeoutFor()` |
|---|---|---|---|
| SessionStart | 5000ms | 4500ms | 4000ms (default branch) |
| Stop | 10000ms | 9000ms | 8500ms (`continuation-gate` branch) |

Claude's own path is single-layer (`hooks.json`'s declared timeout, 5s/10s, direct to
`hook-shim.mjs`) since it never crosses the Codex wrapper/adapter chain — no budget-chain
divergence to compare, by construction.

**Allowlist enforcement.** `commandHas()` (`continuity-hook-policy.mjs:16-20`) requires a command to
contain `hook-shim.mjs` or `codex-hook.mjs` AND the exact hookId as a delimited token. Confirmed
against the actual committed commands: `hooks.json`'s `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs"
session-start || true` and `codex-hooks.json`'s `node -e "...codex-hook.mjs...process.argv.slice(2)`
`... 4500 session-start"` both match. `automaticHookRetirementStatus()` (`bin/install.mjs:2020`) is
exercised by `tests/unit/automatic-hook-retirement.test.mjs` and
`tests/integration/hook-conformance-both-hosts.test.mjs`, both green on current `main` (33 passed
across the 3 test files run tonight, 0 failed — see Evaluation Receipt).

**hookId reachability (adversarial check on `codex-hook-wrapper.mjs`'s `blockingHooks` Set).**
`blockingHooks` (lines 18-38) names 6 ids (`decision-gate`, `hijack-ruvnet`, `ground-before-write`,
`protect-state`, `design-wall`, `unprompted-speech`) beyond the two Codex ever dispatches
(`session-start`, `continuation-gate` — `tests/unit/codex-blocking-hooks-parity.test.mjs`'s own hard
assertion: `codexRegisteredHookIds()` must equal exactly `{session-start, continuation-gate}`).
Investigated whether this is a live "wired and toothless" gap (the exact shape of the just-reconciled
#256 finding) or dead defensive code. Conclusion: **dead, not toothless** — `codex-hooks.json`'s own
description says so explicitly ("Broad legacy automatic gates remain retired"), `continuation-gate.mjs`
never exits non-zero (`grep` confirms the file's only exit-code constant is `EXIT_ALLOW = 0`, no
`process.exit(2)` anywhere in 643 lines), and Claude's own `hooks.json` retired the same gates in the
same commit — this is not a Codex-specific parity gap, it is a forward-declared allowlist for gates
both hosts equally retired. No fix warranted; disclosed rather than silently dropped.

## Verdict

**Hypothesis REJECTED** — no cross-host parity gap found in the 2026-09-09 restore. Matchers,
timeout-budget chains, and allowlist enforcement are consistent and correctly host-scoped. A
rejected hypothesis with a clean measurement is a successful night (this repo's own operating
principle) — no code candidate was warranted or produced.

## Evaluation Receipt

- `npx vitest run tests/unit/codex-blocking-hooks-parity.test.mjs tests/unit/codex-claude-hook-parity.test.mjs tests/integration/hook-conformance-both-hosts.test.mjs tests/unit/hook-registry*`: **4 files passed, 63 passed / 11 skipped (74)**.
- `npx vitest run tests/unit/automatic-hook-retirement.test.mjs tests/integration/hook-conformance-both-hosts.test.mjs tests/unit/codex-lifecycle-hooks.test.mjs`: **3 files passed, 33 passed / 10 skipped (43)**.
- `npm run wired:check`: exit 0.
- `node scripts/hook-retirement-check.mjs` (`npm run hooks:check`): `PASS — continuity-only lifecycle plane (SessionStart + guarded Stop); all legacy Brain gates retired across 8 source, contract, and host-pointer surfaces`.
- `npm run claims:verify`: 4 PASS / 3 SKIP (brain-not-installed class, same as every prior night).
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (`stores 0 dark 0`, container never materializes a corpus — not a credentials block). `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY` in this container.
- No production code was changed tonight (verification-only + 4 issue reconciliations), so no
  before/after regression comparison applies; the above confirms current `main`'s own health on this
  surface.

## Reward-Hack Check

N/A — no candidate, no benchmark or gold data touched, no threshold moved.

## Security Review

N/A — no code change. The adversarial `blockingHooks` re-check (above) specifically excludes a
security regression: confirmed the only hookIds Codex can ever dispatch are non-blocking-capable
today (`continuation-gate.mjs` cannot exit 2), so the dead allowlist entries pose no live
false-confidence risk — the direction that would matter (a truly `mode:'blocking'` hookId missing
from `blockingHooks`) remains covered by `codex-blocking-hooks-parity.test.mjs`'s own assertion.

## Scan Findings — codex-parity

Re-verified `codex-blocking-hooks-parity.test.mjs`'s hard assertion (`registered` must equal exactly
`{session-start, continuation-gate}`) still holds against the 2026-09-09 restore — it does. No new
parity gap found (see Verification above).

## Scan Findings — stranger-project-behaviour

Re-read `plugin/scripts/project-identity.mjs` (`contains()`/`pathIdentity()`, the shared
containment-check primitive `#85`/`#107` fixed and #254's fix reused) — unchanged since its last
audit, still device+inode based, no regression. `.claude/settings.json` (project layer) confirmed
empty (`"hooks": {}`, explicit `_note` dated 2026-09-04) — no stray project-level registration for
this repo's own checkout to leak into a stranger project's session. No new finding.

## Competitors

Internal infra verification; no directly comparable external benchmark for a two-host hook-lifecycle
allowlist at this granularity. Not load-bearing for the REJECT verdict — informational only.

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands | No published cross-host lifecycle-hook parity harness. | C |
| DSPy/GEPA | No published cross-host lifecycle-hook parity harness. | C |
| SWE-agent | Issue-driven; would fix a filed parity gap, does not self-audit for one. | B |
| Cursor background agents | No published cross-host lifecycle-hook parity harness. | C |
| Sakana AI Scientist | No published cross-host lifecycle-hook parity harness. | C |

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation as every
Dream Cycle night since 2026-08-19); not fabricated. Full report committed at
`docs/dream-cycle/2026-09-10-cross-host-conformance-report.md`.

## Witness

```
SESSION_COMMIT = 2eef2024cd596e3e6f11523f1b7603306bee5dd9
REPORT_HASH    = 2f3b4a1b0fbbf462b9197ae12016f206804b324556ba79c3c281dc23439777f9
WITNESS        = d1a700a6127cb825d559e9111fdba44c50c04a9a7b66afd7ae9ef8402b3338ef
```

5-step verifier anyone can reproduce:
1. `git log -1 --format='%H' 5642043 -- plugin/hooks/codex-hooks.json plugin/hooks/hooks.json plugin/scripts/continuity-hook-policy.mjs` — confirms the restore commit and its date (2026-09-09).
2. `sha256sum docs/dream-cycle/2026-09-10-cross-host-conformance-report.md` (the committed, final version of this file) and compare to `REPORT_HASH`.
3. `printf '%s%s' <REPORT_HASH> <SESSION_COMMIT> | sha256sum`, compare to `WITNESS`.
4. `npx vitest run tests/unit/codex-blocking-hooks-parity.test.mjs tests/unit/automatic-hook-retirement.test.mjs tests/integration/hook-conformance-both-hosts.test.mjs` — reproduce the 0-failed result this report cites.
5. `grep -c "EXIT_ALLOW = 0" plugin/scripts/continuation-gate.mjs; grep -c "process.exit(2)" plugin/scripts/continuation-gate.mjs` — reproduce the "1 exit-code constant, 0 exit(2) calls" claim underlying the dead-vs-toothless verdict.

## Next steps

1. `npm run hooks:check` (`scripts/hook-retirement-check.mjs`) is a real, currently-passing check but
   is not wired into any CI workflow or `qa-lanes.mjs` lane — only the underlying
   `automaticHookRetirementStatus()` function is (via `tests/unit/automatic-hook-retirement.test.mjs`).
   Considered as tonight's candidate and set aside: the logic it exercises is already continuously
   verified through vitest, so wiring the standalone CLI would add a redundant CI step rather than
   close a real coverage gap — not pursued to avoid manufacturing a PR for its own sake.
2. `hook-registry.mjs`'s header comment (lines ~27-31) still cites `decision-gate`, `route-dispatch`,
   `learn-capture` as ids `codex-hooks.json` uses — stale since 2026-08-20, and doubly stale after
   the 2026-09-09 restore (`codex-hooks.json` now uses only `session-start`/`continuation-gate`).
   Purely a comment, drives no runtime behavior (`codexRegisteredHookIds()` parses the JSON directly,
   never reads this comment) — flagged for whichever rotation next touches `hook-registry.mjs`'s
   header, not fixed tonight to keep this a verification-only night.
3. The dream-cycle issue backlog itself: 12 open dream-cycle issues remain from 2026-08-22 through
   2026-09-09 outside tonight's DEEP surface (`enforcement-integrity`, `brain-currency`) — each is
   this rotation's job to reconcile on its own night, not tonight's to touch.
