import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ISSUE #84 — a hook that CANNOT block must never be described, registered, or behave as if it can.
 *
 * The reporter measured this on real Claude Code (2.1.220; still 2.1.223 as of 2026-08-06, and this
 * test asserts our honesty, not their timing):
 *
 *     21:18:08.691Z  tool_dispatch_end          ← the subagent has ALREADY run to completion
 *     21:18:08.830Z  Checking hook async_hook_34311 (PreToolUse:Agent)   ← ~139ms too late
 *
 * PreToolUse:Agent/Task hooks are registered asynchronously and their result is consumed as a later
 * bookkeeping step. An `exit 2` refusal from route-dispatch.sh therefore arrives after the model
 * call it meant to prevent. The reporter's own conclusion is that the fix lives in the CLI, not here.
 *
 * SO WHAT IS OURS? The claim. `route-dispatch.sh` originally called itself "a wall, not advice."
 * On this harness that is not true, and shipping a product that overstates what it enforces is the
 * failure this repo treats as non-negotiable: a security-adjacent control that quietly does nothing
 * is worse than an absent one, because people plan around it.
 *
 * This test pins the honesty in place — in the registration, in the runtime behaviour, and in the
 * prose — so a future edit cannot quietly re-promise enforcement the host cannot deliver.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIM = path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs');
const ROUTE_DISPATCH = path.join(ROOT, 'plugin', 'scripts', 'route-dispatch.sh');
const HOOKS_JSON = path.join(ROOT, 'plugin', 'hooks', 'hooks.json');

const shimSource = fs.readFileSync(SHIM, 'utf8');

describe('issue #84 — no hook may claim enforcement the host cannot deliver', () => {
  it('registers route-dispatch as advisory, not blocking', () => {
    const entry = shimSource.match(/'route-dispatch':\s*\{[^}]*\}/)?.[0] || '';
    expect(entry, 'route-dispatch must appear in the dispatch table').toBeTruthy();
    expect(entry, 'PreToolUse:Agent cannot block on this host — advisory is the only honest mode')
      .toMatch(/mode:\s*'advisory'/);
  });

  it('route-dispatch exits 0 and stays silent even on a dispatch it disapproves of', () => {
    // A subagent dispatch with NO declared model — precisely what the gate was built to refuse.
    // It must still exit 0: a refusal here would be a refusal the host ignores, so the only thing
    // an exit 2 could achieve is breaking the turn while preventing nothing.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue84-'));
    try {
      const r = spawnSync('bash', [ROUTE_DISPATCH], {
        input: JSON.stringify({
          tool_name: 'Task',
          tool_input: { subagent_type: 'coder', prompt: 'mechanical rename across 40 files' },
          session_id: 'issue-84',
        }),
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') },
      });
      expect(r.status, 'an exit-2 the host discards is a broken turn bought for nothing').toBe(0);
      expect(r.stdout || '', 'a hook that cannot enforce must not emit a blocking decision')
        .not.toMatch(/"permissionDecision"\s*:\s*"deny"/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('no shipped prose calls route-dispatch a wall or an enforced block', () => {
    // The stale comment that motivated this test read: "the exit code IS the contract
    // (route-dispatch's exit-2 wall)" — true of ground-before-write, false of this hook.
    const shipped = [SHIM, ROUTE_DISPATCH, HOOKS_JSON];
    for (const file of shipped) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        // Only flag prose that ties route-dispatch to a wall/enforcement CLAIM. The file is expected
        // — required, even — to DISCUSS the limitation at length; describing why it cannot block is
        // the opposite of the defect.
        if (!/route-dispatch/i.test(line)) continue;
        //
        // THE EXCUSE LIST IS DELIBERATELY NARROW, and this is the second version of it. The first
        // excused any line containing "advisory" — and the exact stale comment it was written to
        // catch ended "…(route-dispatch's exit-2 wall). Advisory: always 0.", so the guard skipped
        // the one line in the repo it existed for. Caught by mutating the comment back and watching
        // this test stay green. Only HISTORICAL or NEGATING context earns an exemption; merely
        // saying the word "advisory" somewhere on the line does not.
        const claimsAWall = /\bwall\b/i.test(line)
          && !/not a wall|cannot|can't|never|too late|used to|was false|that was|instead of/i.test(line);
        expect(claimsAWall, `${path.basename(file)}:${i + 1} re-promises enforcement #84 proved impossible: ${line.trim()}`)
          .toBe(false);
      }
    }
  });
});
