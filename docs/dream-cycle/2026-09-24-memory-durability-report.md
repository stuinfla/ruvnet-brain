# Memory-Durability SOTA Report — 2026

## TL;DR

Tonight's rotation (SLOT=4, DAYINT % 5 == 4) is `memory-durability`, scans `managed-boundary` +
`round-trip-proof` — the same surface as the last two nights (2026-09-18 PR #296, 2026-09-19 PR
#300), both still open/unmerged. Rather than stack a third dependent branch onto an already
two-deep, unreviewed chain, tonight's candidate consolidates both prior nights' already-proven
fixes into ONE small, freshly-based, conflict-free diff against current `main`
(`e89ea1ba167d9252ec99910304f534c8da5ca0ab`) — the same two files, same tests, re-verified
independently on this container rather than trusted from the prior PRs' own claims.

## What's new

Nothing algorithmically new tonight — this is a reconciliation, not a fresh defect hunt. The
finding (both parts) is unchanged from #296/#300:

1. (2026-09-18 origin) `sessionHookExists()` treated ANY `.claude/hooks` directory as proof of the
   specific recall hook, a false positive for a machine whose hooks dir holds only an unrelated
   script.
2. (2026-09-19 origin) even after (1), the check recognized only the legacy standalone
   `agentdb-ensure.sh` global hook and never credited the repo's own current, documented mechanism
   — the `ruvnet-brain` plugin's wired `SessionStart` hook (`plugin/hooks/hooks.json` →
   `project-progression-session-start.mjs`) — a false negative for anyone who installed the plugin
   the current, documented way.

## Competitors (evidence grade C — no external verification run tonight; carried from prior nights)

| Project | Relevant mechanism | Grade |
|---|---|---|
| Sakana AI Scientist | no analogous "is my own continuity probe honest" self-check documented | C |
| OpenHands | session/memory persistence is a known pain point in its own issue tracker; no bounded promotion gate | C |
| DSPy/GEPA | optimizes prompts/pipelines, not agent session continuity | C |
| SWE-agent | stateless per-episode by design; not directly comparable | C |
| Cursor background agents | no public spec of a SessionStart recall self-audit | C |

No new competitor research conducted tonight (reconciliation night, research budget spent on
independent re-verification instead — consistent with STEP 0.6 budget discipline).

## Hypothesis (frozen before implementation; unchanged from #296/#300, re-adopted verbatim)

> Given `scripts/onboarding-console.mjs`'s `sessionHookExists()` on unmodified `main`
> (`e89ea1ba1`), when a machine either (a) has a `.claude/hooks` directory holding only an
> unrelated script, or (b) has the `ruvnet-brain` plugin enabled via `~/.claude/settings.json`'s
> `enabledPlugins` but no legacy `agentdb-ensure.sh` file, then `sessionSurfacing` currently
> reports a false `ok` for (a) and a false `warn` for (b); crediting exactly two mechanisms — the
> specific legacy hook file, or an enabled `ruvnet-brain@*` plugin entry (mirroring
> `capability-registry.mjs`'s existing pattern) — and nothing weaker, should make both cases report
> correctly, subject to: the already-correct legacy-hook-present case is unaffected, a different
> plugin being enabled does not trigger a false `ok`, and no settings file at all still warns.

Not modified after evaluation began.

## Benchmarks / Evaluation

Baseline = unmodified `origin/main` @ `e89ea1ba167d9252ec99910304f534c8da5ca0ab` (today's actual
tip, re-fetched, not assumed).

- **TEETH, independently re-proven tonight, not trusted from #296/#300's own claims.** Applied the
  combined diff, ran the extended 8-case test file: 8/8 pass. Reverted only
  `scripts/onboarding-console.mjs` via `git stash` (test file kept): **4/8 fail** against
  unmodified `main` — `expected 'ok' to not be 'ok'` (bare hooks-dir false positive) and
  `expected 'warn' to be 'ok'` / `expected undefined to be 'agentdb-ensure'` (plugin-credit false
  negatives). Restored candidate: 8/8 green again.
- `npm ci`: clean, 107 packages, 0 vulnerabilities.
- Targeted blast-radius suite: `npx vitest run tests/unit/console-*.test.mjs
  tests/unit/codex-console-invocation.test.mjs` → 26/27 files pass, 187/193 tests pass. The one
  failing file, `console-memory-canonical-store.test.mjs` (4/6 tests), reproduces **identically** on
  unmodified `main` via `git stash` — this container has no `sqlite3` binary (`which sqlite3` →
  exit 1), the same pre-existing condition this ledger has documented on this exact file every
  night since 2026-08-26.
- Blast radius (repo-wide grep): `sessionHookExists`/`pluginEnabled` have exactly one call site,
  `probeMemory()`; no other reader.
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical composition to every prior night since
  2026-08-19; unaffected by this diagnostic-probe change.
- `npm run eval:gate`: not applicable (diagnostic probe, not retrieval quality) and independently
  blocked anyway — `no brain at /root/.cache/ruvnet-brain/kb`, unchanged every night since
  2026-08-19. `LLM_EVAL=blocked`.
- `npx vitest run tests/integration`: running; full result recorded in the committed report and
  PR body once complete (see Evaluation Receipt).

## Darwin

Not run — no continuous parameter to evolve for a discrete "which mechanism, if any, satisfies
this probe" check; same precedent as every prior memory-durability night (#142/143 through
#296/#300).

## Next steps (concrete)

1. The owner should review and merge (or reject) this consolidated PR, then close #296 and #300 —
   done tonight, by this session, as a housekeeping action, since this PR's diff is a strict
   superset of both.
2. The `dream/*` review backlog (~28 open draft PRs spanning 2026-08-22 through 2026-09-23, zero
   merged since 2026-08-26/178) is now the single largest risk to this program's value — a nightly
   loop whose output is never reviewed produces evidence nobody uses. Recommend either a
   lightweight weekly triage pass, or narrowing `dream.config.json`'s rotation to fewer nights
   until the backlog clears.
3. `plugin/scripts/project-progression-session-start.mjs`'s adjacent dispatch path (flagged as an
   open scope question by #296's own independent critic on 2026-09-18) remains unaudited — a
   candidate for a future memory-durability night if the backlog above clears first.

## Witness

```
SESSION_COMMIT = cc26c1ff2804be9ca4fff6e2d96a1447345c344d
REPORT_HASH    = 19623e92246edfc80c98c592ab1361e02df3e72c5f2c3a24a7f22803e8d79a52
WITNESS        = dd24183e1c566f0740a65752e62c106eb623ed484b7f3274e4093d2f62222fc2
```

**Verifier procedure (5 steps, reproducible by anyone):**
1. `git checkout cc26c1ff2804be9ca4fff6e2d96a1447345c344d`
2. `git stash push -- scripts/onboarding-console.mjs` (keep the new test file) — proves TEETH: `npx vitest run tests/unit/console-session-surfacing-hook-check.test.mjs` → 4/8 fail.
3. `git stash pop` — restore the candidate: same command → 8/8 pass.
4. `sha256sum` this report file → must equal `REPORT_HASH` above.
5. `printf '%s%s' <REPORT_HASH> cc26c1ff2804be9ca4fff6e2d96a1447345c344d | sha256sum` → must equal `WITNESS` above.
