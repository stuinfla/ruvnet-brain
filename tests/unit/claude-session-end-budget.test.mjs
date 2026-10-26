// Issue #420 item 2. Claude Code gives SessionEnd hooks a shared 1.5 s budget, and "Timeouts set on
// plugin-provided hooks don't raise the budget"; only CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS does
// (code.claude.com/docs/en/hooks.md, SessionEnd section). hooks.json's 10 s never applied, yet the body
// planned for 8 s, ran its checkpoint inline, and Claude Code printed "Hook cancelled" on /exit.
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_NEED_MS, CLAUDE_SESSION_END_BUDGET_MS, CAPTURE_BUDGET_MS, effectiveBudgetMs } from '../../plugin/scripts/session-snapshot-hook.mjs';

describe('SessionEnd under Claude Code plans for the budget Claude Code really gives', () => {
  it('defaults to 1.5 s minus spawn overhead, so the checkpoint is detached, not cancelled mid-store', () => {
    expect(CLAUDE_SESSION_END_BUDGET_MS).toBe(1500);
    const budget = effectiveBudgetMs({}, 'SessionEnd');
    expect(budget).toBeLessThan(1500);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(CHECKPOINT_NEED_MS); // runLifecycleBoundary's detach path
    expect(effectiveBudgetMs({ RUVNET_HOOK_HOST: 'claude' }, 'SessionEnd')).toBe(budget);
  });

  it('honours CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS, capped by the shim watchdog plan', () => {
    expect(effectiveBudgetMs({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '5000' }, 'SessionEnd')).toBe(4700);
    expect(effectiveBudgetMs({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '60000' }, 'SessionEnd')).toBe(CAPTURE_BUDGET_MS);
    for (const bad of ['', '0', '-1', 'abc']) {
      expect(effectiveBudgetMs({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: bad }, 'SessionEnd')).toBe(1200);
    }
  });

  it('leaves every other event, and the Codex/Grok hand-down, exactly as before', () => {
    for (const event of ['Stop', 'PreCompact', 'PostToolUse', undefined]) expect(effectiveBudgetMs({}, event)).toBe(CAPTURE_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '2200' }, 'SessionEnd')).toBe(1900);
    expect(effectiveBudgetMs({ RUVNET_HOOK_HOST: 'codex' }, 'SessionEnd')).toBe(CAPTURE_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_HOOK_HOST: 'grok' }, 'SessionEnd')).toBe(CAPTURE_BUDGET_MS);
  });
});
