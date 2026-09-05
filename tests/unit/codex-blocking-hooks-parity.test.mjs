import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { shimTable, codexDispatchIdIn, REPO } from '../../plugin/scripts/hook-registry.mjs';
import { stripComments } from '../../scripts/wired-check.mjs';

/**
 * codex-hook-wrapper.mjs forwards a hook's real exit code to Codex ONLY when its id is a member of
 * its own `blockingHooks` Set — every other id's exit code is coerced to 0 (its own comment: "the
 * only non-zero status that carries product meaning is an intentional exit-2 refusal from a hook
 * whose contract is blocking"). hook-shim.mjs's own dispatch TABLE is the one authority on which
 * hook ids are actually mode: 'blocking' (hook-shim.mjs itself never returns a non-zero status for
 * anything else — see its dispatchHook(), `entry.mode === 'blocking' ? (r.status ?? 0) : 0`).
 *
 * These are two independently-maintained lists. Nothing before tonight proved they agree, and they
 * had already drifted: `route-dispatch` was blocking-shaped in `blockingHooks`, but TABLE has
 * declared it `mode: 'advisory'` since issue #84 — hook-shim.mjs's own comment says so, in the past
 * tense, about this exact membership ("This comment used to cite 'route-dispatch's exit-2 wall' as
 * the example. That was FALSE and had to go"). Harmless today only because hook-shim.mjs's own gate
 * already coerces route-dispatch's exit code to 0 regardless of what codex-hook-wrapper.mjs
 * believes — but a hook TRULY registered as blocking in TABLE and missing from `blockingHooks`
 * would have no such safety net: its exit-2 refusal would silently become an allow on Codex. That is
 * the direction that matters, and it is exactly the "wired and toothless" shape of three prior
 * ACCEPTED nightly findings on this file family (#149/#150's mesh census; #197's CONTEXT_EVENTS
 * hand-copy; the "declared absent" event-parity test in hook-conformance-both-hosts.test.mjs) — a
 * check that exists and points one surface away from where the drift actually happens.
 *
 * codex-hook-wrapper.mjs is deployed as a SINGLE, standalone file (bin/install.mjs's
 * `fs.copyFileSync(hookWrapperSource, tmp)` — no sibling files travel with it), so its own top level
 * cannot import a pure-data sibling the way hook-shim.mjs's TABLE-adjacent modules do (that was
 * tried and reproduces `tests/unit/codex-lifecycle-hooks.test.mjs`'s own real, spawned-wrapper
 * tests going red — a genuinely different constraint from hook-shim.mjs's, not the same one). Its
 * `blockingHooks` is read here by regex instead, the same authority-by-parsing idiom this file's own
 * DETACHED_HOOKS assertion (tests/unit/codex-lifecycle-hooks.test.mjs) and hook-shim.mjs's TABLE
 * (shimTable(), imported below) already use for exactly this reason.
 */
const WRAPPER = path.join(REPO, 'plugin', 'scripts', 'codex-hook-wrapper.mjs');

/** codex-hook-wrapper.mjs's own `blockingHooks` Set, parsed rather than re-implemented — mirrors
 *  tests/unit/codex-lifecycle-hooks.test.mjs's DETACHED_HOOKS regex on the same file. Comments are
 *  stripped first (scripts/wired-check.mjs's own stripComments()) so an explanatory comment that
 *  itself quotes a hook id — as the one documenting this Set's route-dispatch removal does — can
 *  never be mistaken for a member. */
function wrapperBlockingHooks() {
  const src = stripComments(fs.readFileSync(WRAPPER, 'utf8'), '.mjs');
  const body = src.match(/blockingHooks = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  const ids = new Set();
  for (const m of body.matchAll(/'([\w-]+)'/g)) ids.add(m[1]);
  return ids;
}

/** codex-hooks.json's own registered hookIds, via hook-registry.mjs's real per-command parser. */
function codexRegisteredHookIds() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8'));
  const ids = new Set();
  for (const groups of Object.values(manifest.hooks ?? {})) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) {
      const id = codexDispatchIdIn(h.command);
      if (id) ids.add(id);
    }
  }
  return ids;
}

describe('Codex blocking-hook contract: hook-shim TABLE and codex-hook-wrapper blockingHooks agree', () => {
  const registered = codexRegisteredHookIds();
  const blockingHooks = wrapperBlockingHooks();
  const table = shimTable();

  it('finds hook ids in both codex-hooks.json and blockingHooks, or this whole file is vacuous', () => {
    expect(registered.size, 'no hookIds parsed from codex-hooks.json — codexDispatchIdIn or the '
      + 'manifest path is wrong').toBeGreaterThan(5);
    expect(blockingHooks.size, 'no ids parsed from blockingHooks — the regex or wrapper path is wrong')
      .toBeGreaterThan(0);
  });

  it('every Codex-registered, mode:"blocking" hookId is in blockingHooks — else its exit-2 refusal silently becomes an allow', () => {
    const missing = [...registered].filter((id) => table[id]?.mode === 'blocking' && !blockingHooks.has(id));
    expect(missing, 'these hooks are mode:"blocking" in hook-shim.mjs\'s own TABLE and registered on '
      + 'Codex, but codex-hook-wrapper.mjs\'s blockingHooks does not know it — an exit-2 refusal from '
      + 'any of them is coerced to exit 0 (allow) on Codex today').toEqual([]);
  });

  it('blockingHooks names no hookId that TABLE does not also call "blocking" — a name here that is not actually blocking gives false confidence', () => {
    // The route-dispatch-shaped drift, measured tonight: harmless in practice (hook-shim.mjs's own
    // gate already coerces an advisory hook's exit code to 0, so membership here can never fire for
    // it), but exactly the false-confidence gap a reader of this file would not otherwise catch.
    const bogus = [...blockingHooks].filter((id) => table[id] !== undefined && table[id].mode !== 'blocking');
    expect(bogus, 'these are declared in blockingHooks as if an exit-2 from them means something, but '
      + "hook-shim.mjs's own TABLE says their mode is not \"blocking\" — hook-shim.mjs will never let "
      + 'their real exit code reach here, so this membership is misleading, not merely redundant').toEqual([]);
  });
});
