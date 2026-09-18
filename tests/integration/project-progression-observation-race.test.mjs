import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { buildProjectProgression } from '../../plugin/scripts/project-progression-producer.mjs';
import { runCheckpoint } from '../../plugin/scripts/project-progression-checkpoint.mjs';
import { inspectReconciliation } from '../../plugin/scripts/project-progression-reconciliation.mjs';
import { captureProjectTransition } from '../../plugin/scripts/project-progression-hook.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function project() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'observation-race-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"observation-race"}\n');
  fs.mkdirSync(path.join(root, '.swarm'));
  const store = new ProjectProgressionStore({ projectDir: root });
  const options = { resolution: store.resolution, host: 'claude',
    payload: { session_id: 'same-session', hook_event_name: 'checkpoint' },
    env: { RUVNET_WORK_LEDGER: path.join(root, 'absent-ledger.json') },
    now: () => '2026-09-17T00:00:00.000Z' };
  return { root, store, options };
}

it('persists same-session checkpoints built from one head and explicitly reconciles both', () => {
  const { root, store, options } = project();
  const shared = buildProjectProgression(options);
  // Freeze both observations before either writer commits: same session, sequence, time and dedup ID.
  const produce = () => structuredClone(shared);
  const a = runCheckpoint({ projectDir: root, sessionId: 'same-session', state: { currentGoal: 'first goal' }, produce });
  const b = runCheckpoint({ projectDir: root, sessionId: 'same-session', state: { currentGoal: 'second goal' }, produce });
  expect(a.receipt.eventKey).not.toBe(b.receipt.eventKey);
  expect(store.pendingReplayCount()).toBe(0);
  expect(store.replay()).toEqual([]);
  const exact = store.retrieveSnapshots([a.receipt.eventKey, b.receipt.eventKey]);
  expect(exact.rejected).toEqual([]);
  expect(exact.snapshots.map(row => row.completeProjectState.currentGoal).sort()).toEqual(['first goal', 'second goal']);
  expect(buildProjectProgression(options).skipped.reason).toMatch(/concurrent progression heads/);
  const inspected = inspectReconciliation({ store });
  expect(inspected.expectedHeads).toHaveLength(2);
  const dispositions = Object.fromEntries(inspected.conflicts
    .filter(row => !['sourceIdentity', 'provenance', 'evidence'].includes(row.field))
    .map(row => [row.conflictDigest, { conflictDigest: row.conflictDigest, action: 'select', head: a.receipt.eventKey }]));
  const merged = runCheckpoint({ projectDir: root, sessionId: 'reviewed-reconciliation', state: {},
    reconcile: { expectedHeads: inspected.expectedHeads, dispositions } });
  expect(merged.reconciliation.reconciled).toBe(true);
  expect(store.retrieveSnapshots([a.receipt.eventKey, b.receipt.eventKey]).snapshots).toEqual(exact.snapshots);
  expect(store.pendingReplayCount()).toBe(0);
}, 120_000);

it('binds final tool output and outcome, and replays identical observations without another row', () => {
  const { root, store, options } = project();
  const progression = buildProjectProgression(options).projectProgression;
  const invoke = (stdout, exitCode) => captureProjectTransition({ host: 'claude', projectDir: root,
    payload: { session_id: 'same-tool-session', hook_event_name: 'PostToolUse', projectProgression: progression,
      tool_name: 'Bash', tool_input: { command: 'synthetic check' }, tool_response: { stdout, exitCode } } });
  const first = invoke('first output', 0);
  const second = invoke('second output', 0);
  const failed = invoke('second output', 1);
  expect(new Set([first.snapshot.eventKey, second.snapshot.eventKey, failed.snapshot.eventKey]).size).toBe(3);
  expect(failed.snapshot.completeProjectState.failures).toHaveLength(1);
  const repeated = invoke('first output', 0);
  expect(repeated.snapshot).toEqual(first.snapshot);
  expect(repeated.receipt.alreadyStored).toBe(true);
  expect(repeated.receipt.readbackDigest).toBe(first.snapshot.payloadDigest);
  expect(store.listSnapshotKeys()).toHaveLength(3);
  expect(store.pendingReplayCount()).toBe(0);
}, 120_000);
