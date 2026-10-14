// Owner ruling 2026-10-12: no retry queue, no outbox, no replay worker. A write that ruflo refuses
// (its WAL guard: "active native WAL connection — refusing an unsafe sql.js whole-image write") must be
// REPORTED — one row in the hook-failures ledger that the next SessionStart summarizes — never dropped.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo, rows, tmp, WAL_REFUSAL_TEXT } from '../helpers/continuity-fixture.mjs';
import { failureLine } from '../../plugin/scripts/hook-failures.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugin/scripts/session-snapshot-hook.mjs');
afterEach(() => cleanup());

const OUTCOME = `Implemented the change and ran the focused tests. ${'Every assertion passed and the receipt was read back. '.repeat(6)}`;
const ledger = (brainHome) => {
  const file = path.join(brainHome, 'hook-failures.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

function fireStop({ refusals }) {
  const p = adoptedProject();
  const ruflo = fakeRuflo({ refusals });
  const brainHome = tmp('refusal-bh-');
  const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: brainHome, RUVNET_HOOK_HOST: 'claude', RUVNET_TURN_CAPTURE: 'on' };
  const r = spawnSync(process.execPath, [HOOK, 'Stop'], { cwd: p.dir, env, encoding: 'utf8', timeout: 20_000,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'refusal', cwd: p.dir, last_assistant_message: OUTCOME }) });
  return { p, ruflo, brainHome, r };
}

describe('a refused turn write is loud', () => {
  it('records one turn-capture failure row, stores nothing, and SessionStart summarizes it', () => {
    const { p, ruflo, brainHome, r } = fireStop({ refusals: 1 });
    expect(r.status).toBe(0);
    expect(ruflo.calls().filter((c) => c.argv[1] === 'store').length).toBe(1);
    expect(rows(path.join(p.dir, '.swarm', 'memory.db'), 'turns')).toEqual([]);
    const failures = ledger(brainHome).filter((row) => row.hook === 'turn-capture');
    expect(failures.length).toBe(1);
    expect(failures[0].error).toContain('WAL');
    expect(failures[0].event).toBe('Stop');
    expect(failureLine(brainHome)).toMatch(/HOOK FAILURES\] 1 advisory hook run\(s\).*turn-capture ×1/);
    // No queue, journal or outbox was created to retry it.
    expect(fs.readdirSync(path.join(p.dir, '.swarm')).filter((n) => /outbox|journal|queue/.test(n))).toEqual([]);
    expect(WAL_REFUSAL_TEXT).toContain('WAL');
  }, 30_000);

  it('an accepted write is stored, read back by exact key, and leaves the ledger empty', () => {
    const { p, brainHome, r } = fireStop({ refusals: 0 });
    expect(r.status).toBe(0);
    const stored = rows(path.join(p.dir, '.swarm', 'memory.db'), 'turns');
    expect(stored.length).toBe(1);
    expect(stored[0].content).toContain('OUTCOME: Implemented the change');
    expect(ledger(brainHome)).toEqual([]);
    const receipts = fs.readFileSync(path.join(brainHome, 'turn-capture', 'receipts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(receipts.filter((row) => row.kind === 'store').map((row) => [row.key, row.verified])).toEqual([[stored[0].key, true]]);
  }, 30_000);
});
