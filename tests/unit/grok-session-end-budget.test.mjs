// Grok SessionEnd: "A plugin's SessionEnd hook runs for at most that default [1.5 s], whatever its timeout"
// (~/.grok/docs/user-guide/10-hooks.md:644-645). Before this change the adapter budgeted 2200 ms and never told
// the body, so session-snapshot-hook planned for 8 s and ran an inline store+readback that Grok killed partway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { budgetFor, SESSION_END_BUDGET_MS } from '../../plugin/scripts/grok-hook-adapter.mjs';
import { effectiveBudgetMs, CHECKPOINT_NEED_MS } from '../../plugin/scripts/session-snapshot-hook.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADAPTER = path.join(ROOT, 'plugin/scripts/grok-hook-adapter.mjs');
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };

describe('Grok SessionEnd budget is inside the documented 1.5 s cap and reaches the body', () => {
  it('budgets under 1500 ms, and that budget makes the body detach its checkpoint', () => {
    expect(SESSION_END_BUDGET_MS).toBeLessThan(1500);
    expect(budgetFor('session-snapshot', 'SessionEnd')).toBe(SESSION_END_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: String(SESSION_END_BUDGET_MS) })).toBeLessThan(CHECKPOINT_NEED_MS); // detach path
    expect(effectiveBudgetMs({})).toBeGreaterThanOrEqual(CHECKPOINT_NEED_MS); // without the seam the body plans inline
  });

  it.skipIf(process.platform === 'win32')('the real adapter hands RUVNET_CODEX_BUDGET_MS to the SessionEnd body, and to no other event', () => {
    // A dev-mode spine: the REAL adapter and shim dispatch to a body we control, which records what it was given.
    const brainHome = tmp('gse-bh-'); const code = tmp('gse-code-'); const seen = path.join(brainHome, 'seen.jsonl');
    fs.mkdirSync(path.join(code, 'scripts'));
    fs.writeFileSync(path.join(code, 'scripts', 'session-snapshot-hook.mjs'),
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ event: process.argv[2], budget: process.env.RUVNET_CODEX_BUDGET_MS ?? null }) + '\\n');`);
    fs.writeFileSync(path.join(brainHome, 'dev.json'), JSON.stringify({ codeRoot: code }));
    const fire = (event) => spawnSync(process.execPath, [ADAPTER, 'session-snapshot', event], {
      input: JSON.stringify({ hook_event_name: event, session_id: 's', cwd: tmp('gse-cwd-') }), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: tmp('gse-state-'), GROK_PLUGIN_ROOT: path.join(ROOT, 'plugin') },
    });
    expect(fire('SessionEnd').status).toBe(0);
    expect(fire('PreCompact').status).toBe(0);
    const rows = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([{ event: 'SessionEnd', budget: String(SESSION_END_BUDGET_MS) }, { event: 'PreCompact', budget: null }]);
  }, 30_000);
});
