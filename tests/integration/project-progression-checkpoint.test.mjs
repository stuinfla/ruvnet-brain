/**
 * The EXPLICIT boundary. Two properties matter and nothing else does:
 *   1. what the model hands over reaches the stored row, marked as the model's own claim;
 *   2. it goes through the ONE writer — a checkpoint is not a second path into memory.db.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readCheckpointState, runCheckpoint } from '../../plugin/scripts/project-progression-checkpoint.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { restoreProgressionForSession } from '../../plugin/scripts/project-progression-session-start.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

const CHECKPOINT = path.resolve(import.meta.dirname, '../../plugin/scripts/project-progression-checkpoint.mjs');
const ruflo = resolveRuflo();
const roots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"checkpoint"}\n');
  const resolution = resolveProjectStore({ projectDir: root });
  fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });
  return root;
}

const STATE = {
  currentGoal: 'Prove the explicit checkpoint writes a verified row',
  acceptanceContract: { required: ['readbackVerified true'] },
  nextAction: 'Run the acceptance suite in both directions',
  decisions: [{ text: 'Route /checkpoint through captureProjectTransition', why: 'one writer' }],
  untested: ['a real Codex Stop delivery'],
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('explicit project checkpoint', () => {
  it('accepts only declared fields, and refuses a checkpoint that says nothing', () => {
    expect(readCheckpointState({ json: JSON.stringify({ ...STATE, somethingElse: 'ignored' })}))
      .toEqual(STATE);
    expect(() => readCheckpointState({ json: '{}' })).toThrow(/must set at least one/);
    expect(() => readCheckpointState({ json: 'not json' })).toThrow(/not JSON/);
    expect(() => readCheckpointState({})).toThrow(/needs --json/);
    expect(() => readCheckpointState({ json: JSON.stringify({ decisions: 'a string' }) }))
      .toThrow(/decisions must be an array/);
  });

  it('stores the model\'s own state, marked as the model\'s claim, and restores it', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const project = temporaryProject();
    const outcome = runCheckpoint({ projectDir: project, state: STATE, sessionId: 'checkpoint-session' });
    expect(outcome.receipt.readbackDigest).toBe(outcome.receipt.payloadDigest);
    expect(outcome.sequence).toBe(1);
    // Every field the model supplied is recorded as its own claim, NOT as a fact from the machine.
    for (const field of Object.keys(STATE)) {
      expect(outcome.provenance[field], field).toEqual({ source: 'model-checkpoint', authoritative: false });
    }
    const restored = restoreProgressionForSession({
      env: { ...process.env, CLAUDE_PROJECT_DIR: project }, cwd: project,
    });
    expect(restored.status).toBe('restored');
    expect(restored.context).toContain(STATE.currentGoal);
    expect(restored.context).toContain(STATE.nextAction);
    expect(restored.context).toContain('model-checkpoint');
  }, 300_000);

  it('is ONE writer: it goes through captureProjectTransition, never straight to the store', () => {
    const project = temporaryProject();
    const seen = [];
    const outcome = runCheckpoint({
      projectDir: project,
      state: { currentGoal: 'one writer only' },
      produce: ({ resolution, trigger }) => {
        seen.push(`produce:${trigger}`);
        return {
          projectProgression: {
            canonicalAgentDbPath: resolution.canonicalAgentDbPath,
            sourceIdentity: {
              checkoutPath: resolution.checkoutRoot, worktreeId: 'w', branch: 'b', head: 'h',
              trackedDigest: 't', untrackedDigest: 'u', dirtyTreeDigest: 'd',
            },
            sequence: 1, occurredAt: '2026-09-11T00:00:00.000Z', parentEventKeys: [], dedupId: 'x',
            completeProjectState: { provenance: {} },
          },
        };
      },
      capture: ({ payload, host }) => {
        seen.push(`capture:${host}:${payload.hook_event_name}`);
        // The checkpoint's own state must have reached the payload the ONE writer receives.
        expect(payload.projectProgression.completeProjectState.currentGoal).toBe('one writer only');
        return { snapshot: { sequence: 1 }, receipt: { eventKey: 'k', payloadDigest: 'd', readbackDigest: 'd' } };
      },
      storeFactory: () => ({ replay: () => [] }),
    });
    expect(seen).toEqual(['produce:checkpoint', 'capture:claude:checkpoint']);
    expect(outcome.receipt.eventKey).toBe('k');
  });

  it('prints a receipt a reader can check, and exits non-zero when it cannot store', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const project = temporaryProject();
    const ok = spawnSync(process.execPath, [CHECKPOINT, '--json', JSON.stringify(STATE), '--project-dir', project],
      { encoding: 'utf8', cwd: project, timeout: 300_000, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    expect(ok.status, ok.stderr).toBe(0);
    const receipt = JSON.parse(ok.stdout);
    expect(receipt).toMatchObject({ checkpoint: 'stored', readbackVerified: true, sequence: 1 });
    expect(receipt.eventKey).toMatch(/^project-progress-v1-/);

    // A project that never adopted the canonical store must refuse, loudly, rather than create one.
    const unadopted = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-unadopted-')));
    roots.push(unadopted);
    execFileSync('git', ['init', '-q'], { cwd: unadopted });
    const refused = spawnSync(process.execPath, [CHECKPOINT, '--json', JSON.stringify(STATE), '--project-dir', unadopted],
      { encoding: 'utf8', cwd: unadopted, timeout: 120_000, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/has not adopted the canonical store/);
    expect(fs.existsSync(path.join(unadopted, '.swarm'))).toBe(false);
  }, 300_000);
});
