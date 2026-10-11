import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { ensureProjectMemory, enrollProjectMemory, enrollmentPlan } from '../../plugin/scripts/project-memory-enrollment.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { runSessionSnapshotHook } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { captureTurnOutcome, runSteps } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const binary = resolveRuflo();
it.skipIf(!binary)('bootstraps real native stores, isolates projects and replays the first linked-worktree boundary', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-native-enrollment-'))); roots.push(root);
  const primary = path.join(root, 'primary'); const second = path.join(root, 'second'); const linked = path.join(root, 'linked');
  const home = path.join(root, 'home'); const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(path.join(brainHome, 'turn-capture'), { recursive: true });
  for (const project of [primary, second]) {
    fs.mkdirSync(project); execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['config', 'user.name', 'Enrollment Test'], { cwd: project });
    execFileSync('git', ['config', 'user.email', 'enrollment@example.invalid'], { cwd: project });
    fs.writeFileSync(path.join(project, 'tracked'), 'fixture'); execFileSync('git', ['add', 'tracked'], { cwd: project });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: project });
  }
  execFileSync('git', ['worktree', 'add', '-qb', 'linked', linked], { cwd: primary });
  fs.writeFileSync(path.join(brainHome, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, default: 'on',
    projects: { [primary]: 'on', [second]: 'on' }, paths: {} }));
  const env = { ...process.env, RUVNET_TURN_CAPTURE: 'force', HOME: home, RUVNET_BRAIN_HOME: brainHome, RUFLO_BIN: binary };
  const first = ensureProjectMemory({ projectDir: linked, env, event: 'Stop', payload: { session_id: 'native-first',
    last_assistant_message: 'We completed a source-grounded strategic implementation decision and verified the canonical project store with the actual native writer. The initial event must survive first-use enrollment and remain available to future project recall. The remaining publication work is outside this fixture.' }, launch: () => false });
  expect(first).toMatchObject({ state: 'pending', queued: true });
  const replays = []; const deliveries = [];
  env.RUVNET_BRAIN_PROGRESSION_SUSPENDED = '1';
  const enrolled = await enrollProjectMemory({ projectDir: linked, env, replay: (projectDir, event, options) => {
    replays.push({ projectDir, event, payload: JSON.parse(options.rawInput) });
    return runSessionSnapshotHook(projectDir, event, { ...options, captureEvents: () => ({ recorded: 0 }),
      captureTurn: (captureOptions) => captureTurnOutcome({ ...captureOptions, ruflo: binary, brainHome, home,
        launch: (steps, { receipts }) => { deliveries.push(...runSteps({ steps, receipts }, { env, home, brainHome, projectDir })); return { launched: true }; } }) });
  } });
  expect(enrolled.state).toBe('ready');
  expect(replays).toHaveLength(1);
  expect(deliveries.some((delivery) => delivery.verified === true)).toBe(true);
  const turnReceipts = fs.readFileSync(path.join(brainHome, 'turn-capture', 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(turnReceipts.some((receipt) => receipt.verified === true && receipt.db === path.join(primary, '.swarm', 'memory.db'))).toBe(true);
  expect(replays[0]).toMatchObject({ projectDir: linked, event: 'Stop', payload: { session_id: 'native-first' } });
  expect(fs.existsSync(path.join(linked, '.swarm'))).toBe(false);
  expect(resolveProjectStore({ projectDir: linked }).canonicalAgentDbPath).toBe(path.join(primary, '.swarm', 'memory.db'));
  expect(enrollmentPlan({ projectDir: linked, env }).state).toBe('existing');
  expect(fs.readdirSync(path.join(primary, '.swarm', '.memory-enrollment-pending'))).toHaveLength(0);
  ensureProjectMemory({ projectDir: second, env, launch: () => false });
  expect((await enrollProjectMemory({ projectDir: second, env })).state).toBe('ready');
  expect(fs.readFileSync(path.join(primary, '.swarm', '.memory-enrollment.json'), 'utf8'))
    .not.toBe(fs.readFileSync(path.join(second, '.swarm', '.memory-enrollment.json'), 'utf8'));
  for (const project of [primary, second]) {
    const entries = fs.readdirSync(project);
    expect(entries).not.toContain('.ruflo'); expect(entries).not.toContain('CLAUDE.md');
    expect(fs.readdirSync(path.join(project, '.swarm')).filter((name) => /memory.*\.db$/.test(name))).toEqual(['memory.db']);
    expect(fs.readFileSync(path.join(project, '.swarm', 'memory.db')).subarray(0, 15).toString()).toBe('SQLite format 3');
  }
}, 90000);
