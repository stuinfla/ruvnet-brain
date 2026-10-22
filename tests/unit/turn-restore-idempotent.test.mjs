// SessionEnd and PreCompact re-sent the Stop turn (measured 2026-10-19/20: 12 "immutable append rejected: logical
// key already exists" rows, all at SessionEnd). Two guards, each failing on the code before this change:
//   (a) a key whose Stop-time store receipt is verified is not sent again, even when last-turn.json is gone;
//   (b) an append-only "already exists" refusal whose readback returns the identical bytes is success; different bytes fail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureTurnOutcome, runSteps } from '../../plugin/scripts/turn-outcome-capture.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p))); roots.push(d); return d; };
const OUTCOME = `Implemented the change and ran the focused tests. ${'Every assertion passed and the receipt was read back. '.repeat(4)}`;
const TRUSTED_ENV = { RUFLO_BIN: process.execPath, RUVNET_TURN_CAPTURE: 'force' };

function harness() {
  const home = tmp('restore-home-'); const project = tmp('restore-project-');
  fs.mkdirSync(path.join(project, '.swarm')); fs.writeFileSync(path.join(project, '.swarm', 'memory.db'), '');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const stores = [];
  const fire = (event, payload) => captureTurnOutcome({ projectDir: project, event, payload: { hook_event_name: event, cwd: project, ...payload },
    env: TRUSTED_ENV, home, ruflo: '/fake/bin/ruflo', launch: () => ({ launched: true }),
    write: ({ steps, receipts }) => { stores.push(...steps); const row = { kind: 'store', key: steps[0].args[steps[0].args.indexOf('--key') + 1], status: 0, verified: true, at: new Date().toISOString() };
      fs.mkdirSync(path.dirname(receipts), { recursive: true }); fs.appendFileSync(receipts, `${JSON.stringify(row)}\n`); return [row]; } });
  return { home, project, brainHome, stores, fire };
}

describe('(a) the Stop-time store is not re-sent at SessionEnd/PreCompact', () => {
  it('a verified receipt for the exact key skips the store even when last-turn.json has been lost', () => {
    const h = harness();
    const payload = { session_id: 'restore-1', last_assistant_message: OUTCOME };
    const stop = h.fire('Stop', payload);
    expect(stop.recorded).toBe(true);
    fs.rmSync(path.join(h.brainHome, 'turn-capture', 'last-turn.json'), { force: true }); // the per-session state is a cache
    const end = h.fire('SessionEnd', payload);
    expect(end.queued).toBe(false);
    expect(end.skipped).toBe('turn key already verified at an earlier boundary');
    expect(h.stores).toHaveLength(1);
    expect(h.fire('PreCompact', payload).queued).toBe(false);
    expect(h.stores).toHaveLength(1);
  });
  it('a receipt that was NOT verified does not block the re-send', () => {
    const h = harness();
    const payload = { session_id: 'restore-2', last_assistant_message: OUTCOME };
    const stop = h.fire('Stop', payload);
    const receipts = path.join(h.brainHome, 'turn-capture', 'receipts.jsonl');
    fs.writeFileSync(receipts, `${JSON.stringify({ kind: 'store', key: stop.key, status: 1, verified: false })}\n`);
    fs.rmSync(path.join(h.brainHome, 'turn-capture', 'last-turn.json'), { force: true });
    expect(h.fire('SessionEnd', payload).queued).toBe(true);
  });
});

describe('(b) an append-only "already exists" refusal is judged by exact readback', () => {
  const step = (brainHome, project) => {
    const binding = { projectRoot: project, projectDir: project, brainHome, rootIdentity: `${fs.statSync(project).dev}:${fs.statSync(project).ino}` };
    const db = path.join(project, '.swarm', 'memory.db');
    return { ...binding, kind: 'store', ruflo: process.execPath, args: ['memory', 'store', '--key', 'turn-p-abc', '--value', OUTCOME, '--namespace', 'turns', '--path', db, '--no-upsert', '--require-native', '--append-only'] };
  };
  const refusal = { status: 1, stderr: '[ERROR] immutable append rejected: logical key already exists' };
  const world = () => {
    const home = tmp('dup-home-'); const project = tmp('dup-project-');
    fs.mkdirSync(path.join(project, '.swarm')); fs.writeFileSync(path.join(project, '.swarm', 'memory.db'), '');
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const ledger = () => { try { return fs.readFileSync(path.join(brainHome, 'hook-failures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
    const rows = (readBack) => runSteps({ steps: [step(brainHome, project)], event: 'SessionEnd' }, { projectDir: project, brainHome, home, env: TRUSTED_ENV,
      run: (bin, args) => (args[1] === 'store' ? refusal : { status: 0, stdout: readBack }), read: () => readBack });
    return { rows, ledger };
  };
  it('identical bytes: verified, status 0, no ledger row', () => {
    const w = world();
    const [row] = w.rows(OUTCOME);
    expect(row).toMatchObject({ kind: 'store', status: 0, verified: true, error: null });
    expect(w.ledger()).toEqual([]);
  });
  it('different bytes: still a failure that names the cause', () => {
    const w = world();
    const [row] = w.rows('something else entirely');
    expect(row).toMatchObject({ status: 1, verified: false, error: 'duplicate turn key holds different content' });
    expect(w.ledger().map((r) => r.error)).toEqual(['duplicate turn key holds different content']);
  });
});
