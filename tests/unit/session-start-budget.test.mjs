// tests/unit/session-start-budget.test.mjs — the DERIVED-SUM latency contract (ADR-067 pattern),
// added 2026-09-11 per the cross-review correction: "add a test that derives the sum from the
// budget constants and fails if it exceeds the hooks.json timeout." This test reads BOTH numbers
// live (the budgets from session-start-budget.mjs, the timeout from plugin/hooks/hooks.json) so a
// future retiming of either one is a reviewable diff here, never a silent drift.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  STAGE_BUDGETS_MS,
  MEASURED_NODE_BOOT_MS,
  sumBudgetsMs,
  sessionStartTimeoutMs,
  sessionStartDeadlineAt,
} from '../../plugin/scripts/session-start-budget.mjs';
import { SESSION_CONTINUITY_DEADLINE_MS } from '../../plugin/scripts/project-progression-session-start.mjs';

describe('SessionStart derived-sum latency budget contract', () => {
  it.each(['registered-envelope', 'inherited-deadline'])('the actual Codex wrapper respects %s instead of silently truncating restoration at four seconds', kind => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-wrapper-')));
    try {
      const source = path.resolve(import.meta.dirname, '../../plugin');
      const home = path.join(root, 'home'); const brain = path.join(root, 'brain'); const generation = path.join(brain, 'versions/fixture');
      fs.mkdirSync(path.join(generation, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(generation, 'hooks')); fs.mkdirSync(home);
      for (const file of ['session-start-budget.mjs']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(generation, 'scripts', file));
      fs.copyFileSync(path.join(source, 'hooks/codex-hooks.json'), path.join(generation, 'hooks/codex-hooks.json'));
      fs.copyFileSync(path.join(source, 'scripts/codex-hook-wrapper.mjs'), path.join(root, 'wrapper.mjs'));
      fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: generation }));
      const protectedFile = path.join(root, 'protected.txt'); fs.writeFileSync(protectedFile, 'unchanged'); const pidFile = path.join(root, 'adapter.pid');
      fs.writeFileSync(path.join(generation, 'scripts/codex-hook-adapter.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(protectedFile)},'completed');console.log(JSON.stringify({marker:'restore-completed',deadlineAt:Number(process.env.RUVNET_SESSION_START_DEADLINE_AT)}));},${kind === 'registered-envelope' ? 4500 : 1000});`);
      const started = Date.now();
      const run = spawnSync(process.execPath, [path.join(root, 'wrapper.mjs'), 'session-start', 'SessionStart'], {
        input: JSON.stringify({ cwd: root }), cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), RUVNET_BRAIN_HOME: brain,
          RUVNET_CODEX_HOOK_TIMEOUT_MS: '', RUVNET_SESSION_START_DEADLINE_AT: kind === 'inherited-deadline' ? String(started + 350) : '' } });
      expect(run.status, run.stderr).toBe(0);
      if (kind === 'registered-envelope') {
        const result = JSON.parse(run.stdout); expect(result.marker).toBe('restore-completed');
        expect(result.deadlineAt).toBeLessThanOrEqual(started + 7500); expect(Date.now() - started).toBeLessThan(7500);
        expect(fs.readFileSync(protectedFile, 'utf8')).toBe('completed');
      } else {
        expect(run.stdout).not.toContain('restore-completed'); expect(run.stderr).toContain('PROJECT CONTINUITY UNKNOWN');
        expect(Date.now() - started).toBeLessThan(1500); expect(fs.readFileSync(protectedFile, 'utf8')).toBe('unchanged');
        const pid = Number(fs.readFileSync(pidFile, 'utf8')); expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 12000);
  it('uses each registered host envelope and never restarts an inherited deadline', () => {
    expect(sessionStartDeadlineAt({ host: 'claude', env: {}, startedAt: 1000 })).toBe(1000 + sessionStartTimeoutMs() - MEASURED_NODE_BOOT_MS);
    expect(sessionStartDeadlineAt({ host: 'codex', env: {}, startedAt: 1000 })).toBe(1000 + 7500 - MEASURED_NODE_BOOT_MS);
    for (const host of ['claude', 'codex']) {
      expect(sessionStartDeadlineAt({ host, env: { RUVNET_SESSION_START_DEADLINE_AT: '1200' }, startedAt: 1000 })).toBe(1200);
    }
  });
  it('sums every declared stage budget below the hook\'s own hooks.json timeout, minus measured node boot', () => {
    const timeoutMs = sessionStartTimeoutMs();
    const sum = sumBudgetsMs();
    expect(sum).toBeLessThan(timeoutMs - MEASURED_NODE_BOOT_MS);
  });

  it('durable replay and restore share a 3500ms ceiling; banner stays below 200ms', () => {
    expect(STAGE_BUDGETS_MS.restore).toBeLessThanOrEqual(3500);
    expect(STAGE_BUDGETS_MS.banner).toBeLessThanOrEqual(200);
  });

  it('the continuity implementation enforces the same restore ceiling declared in this budget', () => {
    expect(SESSION_CONTINUITY_DEADLINE_MS).toBe(STAGE_BUDGETS_MS.restore);
  });

  it('every declared stage has an explicit, positive budget', () => {
    expect(Object.keys(STAGE_BUDGETS_MS).length).toBeGreaterThan(0);
    for (const [name, ms] of Object.entries(STAGE_BUDGETS_MS)) {
      expect(ms, `stage "${name}" must have a positive budget`).toBeGreaterThan(0);
    }
  });

  it('fails loudly (not silently) if a future stage budget pushes the sum over the timeout', () => {
    // Prove the contract can actually fail — not a test that only ever passes (Rule 22's "a test
    // that cannot fail on broken code is not a test"). Simulate a stage added carelessly.
    const inflated = { ...STAGE_BUDGETS_MS, 'hypothetical-new-stage': 100_000 };
    const timeoutMs = sessionStartTimeoutMs();
    expect(sumBudgetsMs(inflated)).toBeGreaterThan(timeoutMs - MEASURED_NODE_BOOT_MS);
  });

  it('sessionStartTimeoutMs reads the REAL hooks.json SessionStart timeout, not a hand-copied number', () => {
    const timeoutMs = sessionStartTimeoutMs();
    expect(timeoutMs).toBeGreaterThan(0);
    expect(Number.isInteger(timeoutMs)).toBe(true);
  });
});
