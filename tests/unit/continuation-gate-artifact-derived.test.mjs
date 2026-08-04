import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(ROOT, 'plugin', 'scripts', 'continuation-gate.mjs');

/**
 * The continuation gate must be armable BY EVIDENCE, not only by the model remembering to arm it.
 *
 * On 2026-08-04 the owner asked why the model had gone back to stopping early. The ledger answered:
 * 25 items, ZERO open, last written 2026-07-25 — the gate had been structurally silent for ten days.
 * Not broken. STARVED. Its only source of "work is outstanding" was `--commit-to`, so the guard
 * against the model stopping early depended on the model noticing it should not stop. In the
 * sessions where that judgement fails — the only sessions the guard exists for — the guard is off,
 * and the sole symptom is nothing happening.
 *
 * These cases pin the second source: open work read from an artifact produced by something other
 * than the model.
 */
let home; let ledger; let issues;
const run = (payload) => {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      RUVNET_WORK_LEDGER: ledger,
      RUVNET_OPEN_ISSUES_FILE: issues,
      RUVNET_CONTINUATION_COOLDOWN_MS: '0',
    },
  });
  return `${r.stdout || ''}`;
};
const writeIssues = (list, atMs = Date.now()) => fs.writeFileSync(issues, JSON.stringify({
  repo: 'stuinfla/ruvnet-brain', at: new Date(atMs).toISOString(), issues: list,
}));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-artifact-'));
  ledger = path.join(home, 'ledger.json');
  issues = path.join(home, 'open-issues.json');
  fs.writeFileSync(ledger, JSON.stringify({ items: [] }));  // the starved state, exactly
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('continuation gate — armed by evidence, not only by memory', () => {
  it('forces on an SLA-breached issue even when the ledger is completely empty', () => {
    writeIssues([{ number: 111, ageHours: 5, breach: true, title: 'loadLessons clobbers ratified lessons' }]);
    const out = run({ hook_event_name: 'Stop', session_id: 's1' });
    expect(out, 'an empty ledger must no longer mean silence').toContain('additionalContext');
    expect(out).toContain('#111');
    expect(out).toContain('past its response SLA');
  });

  it('TEETH: stays silent when nothing is outstanding — it is a gate, not a nag', () => {
    writeIssues([{ number: 200, ageHours: 1, breach: false, title: 'within SLA' }]);
    expect(run({ hook_event_name: 'Stop', session_id: 's2' }), 'a backlog within SLA is not outstanding work').toBe('');
  });

  it('refuses a STALE observation — an old file is not evidence of anything now', () => {
    writeIssues(
      [{ number: 300, ageHours: 99, breach: true, title: 'old breach' }],
      Date.now() - 7 * 3600_000,   // older than the 6h freshness window
    );
    expect(run({ hook_event_name: 'Stop', session_id: 's3' })).toBe('');
  });

  it('keeps every existing loop-safety guard', () => {
    writeIssues([{ number: 111, ageHours: 5, breach: true, title: 'real breach' }]);
    // no session_id → not a confirmable Stop → never force
    expect(run({ hook_event_name: 'Stop' })).toBe('');
    // already re-engaged → must not force again
    expect(run({ hook_event_name: 'Stop', session_id: 's4', stop_hook_active: true })).toBe('');
  });
});
