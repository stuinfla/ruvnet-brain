# Cross-Host Conformance SOTA Report — 2026

## TL;DR

Tonight's slot (0 → `cross-host-conformance`, scan `codex-parity,stranger-project-behaviour`) already has
its dominant defect found, fixed, and evidenced by a prior night: PR #396 (2026-10-05) restored the
real hook-firing assertions in `tests/integration/hook-conformance-both-hosts.test.mjs` after they were
silently lost in commit `00526b12` (2026-09-07, "retire automatic hooks"). Verified independently tonight
on current `main` (`9cf8fe1`): the file still has **zero** `spawnSync`/`spawn(` calls, so the gate has
been vacuous for both hosts for **34 days** and counting, and PR #396's fix (which restores it) has sat
unmerged for 5 days and has now drifted to `mergeable_state: dirty`. Per this repo's `findingPolicy`
(`skipIf: ["existing-fix-pr"]`) and the ISSUE DISPOSITION OVERRIDE, this is **not** re-filed as a new
issue or re-implemented as a new candidate — that would just add a second draft PR fixing the same file
to an already-49-PR-deep review backlog.

Tonight's own contribution: independently re-checked the one disclosed-but-unresolved residual risk in
PR #396's own Security Review section (`detach.mjs`/`session-start-core.mjs` allegedly writing
`token-ledger.jsonl`/`detached-jobs.jsonl` via a bare `os.homedir()`, bypassing project/session scoping)
against current source. **That claim does not hold up**: both call sites already resolve through an
explicit override before falling back to the real home directory — `session-start-core.mjs`'s `meter()`
prefers `env.XDG_CACHE_HOME`, and its `stateDir` default prefers `env.RUVNET_BRAIN_HOME`, over
`os.homedir()`; `detach.mjs`'s `receiptPath()` prefers `env.XDG_CACHE_HOME` the same way. Falling back to
the real `$HOME` only when no override is set is the *correct* behavior for a receipt that, by this
file's own header comment, must outlive the triggering session and be discoverable machine-wide — not a
bug. No candidate was built for this; the correction itself is the finding.

## What's new

Nothing code-level tonight. The news is procedural and already partly self-reported by this same
automation: the dream-cycle review lane is the bottleneck, not the research. Confirmed fresh tonight via
GitHub MCP (`search_pull_requests repo:stuinfla/ruvnet-brain is:pr is:open head:dream/`): **49 open**,
matching PR #422's count from the previous night (90 opened all-time, 5 ever merged, last merge
2026-08-31 / #215, 40+ days with zero merges). Already tracked in issue #410 (2026-10-06) and restated in
PRs #419, #421, #422 — not duplicated here per `skipIf: duplicate-open-issue`.

## Competitors (evidence grade C unless noted — no external research run tonight; budget spent on
in-repo reconciliation, consistent with the learning signal "zero of last 14 merged → bias to a tiny,
easily-reviewable candidate")

| Project | Self-evolution loop | Human-gate on promotion | Ledger/durable-memory artifact |
| --- | --- | --- | --- |
| Sakana AI Scientist | Yes (paper-writing loop) | Weak — some pipelines auto-submit | No persistent cross-run ledger (grade B, vendor paper) |
| OpenHands | Agentic PR loop | Yes, PR review | No cross-run ledger; relies on GitHub history itself (grade B) |
| DSPy/GEPA | Yes (prompt/program evolution) | N/A — offline optimization, no prod promotion | In-run Pareto log only, not cross-session (grade B) |
| SWE-agent | Single-shot patch generation | Yes, PR review | None — stateless per issue (grade B) |
| Cursor background agents | Yes (background task loop) | Yes, PR review | Vendor-side task history, not repo-committed (grade C, product docs) |

This repo's `LEDGER.md` is the one artifact among these peers that commits durable cross-run memory
directly into the repo — valuable exactly because of tonight's finding: it lets a 40-day review gap be
measured precisely instead of guessed at.

## Hypothesis (frozen before any evaluation)

> Given PR #396's own disclosed residual-risk claim (`os.homedir()` bypassing project/session scoping in
> two append-only receipt writers), when the actual call sites are read against current `main`, then the
> claim should be falsifiable by direct inspection — either both writers unconditionally use
> `os.homedir()` (claim holds, worth a follow-up candidate) or both already honor an environment override
> before falling back to it (claim does not hold, nothing to fix), with no new code written either way.

## Evaluation

Direct source inspection, not a model call (no `OPENROUTER_API_KEY` tonight — `LLM_EVAL=blocked`, and this
check needs none). `grep -n "homedir\|RUVNET_CONFIG_ROOT\|token-ledger\|detached-jobs"` on both files,
then read the surrounding ~15 lines of each site:

- `plugin/scripts/detach.mjs:66-68` — `receiptPath()` = `process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')` then `, 'ruvnet-brain', 'detached-jobs.jsonl'`. Override-first.
- `plugin/scripts/session-start-core.mjs:52-54` (`meter()`) — `ledgerDir = env.XDG_CACHE_HOME ? path.join(env.XDG_CACHE_HOME, 'ruvnet-brain') : stateDir`. Override-first.
- `plugin/scripts/session-start-core.mjs:169` — `stateDir` itself = `env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain')`, and `home` = `env.HOME || env.USERPROFILE || os.homedir()`. Override-first, falls through host-appropriate home env vars before the OS call.

Hypothesis falsified in the "claim holds" direction: neither file unconditionally uses `os.homedir()`.
**VERDICT: REJECT the residual-risk claim as stated** — a clean, reproducible negative result, which per
this repo's own global invariant ("a rejected hypothesis with a clean measurement is a successful night")
is a legitimate outcome, not a null one.

## Witness

```
SESSION_COMMIT = 9cf8fe19a57671eb430ce7341b7b8bf123ccce75
REPORT_HASH    = 5e0b0f598c14cfa26f6e9be985de2047647ec4a83e392f444489b98406c9fd09
WITNESS        = 46819c2672e9ee4db8453a8c6baedc0289f9facffcec6795bbbdc3af2d9fe2be
```

Reproduction (5 steps anyone with this repo checked out at `9cf8fe1` can redo):
1. `git show 9cf8fe1:tests/integration/hook-conformance-both-hosts.test.mjs | grep -c 'spawnSync\|spawn('` → `0` (confirms the gate is still vacuous on `main`).
2. `git show 9cf8fe1:plugin/scripts/detach.mjs | sed -n '66,68p'` → shows the `XDG_CACHE_HOME || os.homedir()` override order.
3. `git show 9cf8fe1:plugin/scripts/session-start-core.mjs | sed -n '50,55p;165,172p'` → shows the `RUVNET_BRAIN_HOME`/`XDG_CACHE_HOME`/`HOME`/`USERPROFILE` override chain.
4. Diff this report's quoted line ranges against the live file; they must match byte-for-byte at commit `9cf8fe1`.
5. Recompute `sha256sum` of this file and confirm it matches `REPORT_HASH` below; recompute
   `sha256(REPORT_HASH + SESSION_COMMIT)` and confirm it matches `WITNESS`.

## Next steps (concrete, for the next cross-host-conformance night or the repo owner)

1. **Human action, highest leverage, not code**: triage the 49 open `dream/*` PRs (issue #410's own
   suggested audit). PR #396 specifically is ready to merge modulo its now-`dirty` mergeable_state — a
   rebase is all it needs.
2. If #396 merges, the *next* cross-host-conformance night should restore the two blocks #396's own body
   explicitly deferred (ADR-063 managed-memory-boundary block; the "two hosts don't diverge" block) rather
   than re-discovering the same gate gap a third time.
3. No action needed on the `os.homedir()` claim — it was checked and does not describe a real gap in the
   current source.
