// ADR-106: learn-capture and learn-flush lost their own registrations. The REAL registered commands
// that replaced them (session-snapshot PostToolUse / SessionEnd, through the real shim) must still
// capture and schedule, and must still be silent when learning or the brain is off.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';
import { learningFixture, repository } from '../helpers/learning-fixture.mjs';

const SHIM = path.join(repository, 'plugin/scripts/hook-shim.mjs');
const made = [];
afterEach(() => { for (const f of made.splice(0)) f.cleanup(); });
const setup = () => { const f = learningFixture('project'); made.push(f); return f; };
const fire = (f, event, payload, overrides = {}) => spawnSync(process.execPath, [SHIM, 'session-snapshot', event], {
  cwd: f.project, encoding: 'utf8', timeout: 30_000, env: { ...f.env, ...overrides },
  input: JSON.stringify({ hook_event_name: event, session_id: 'fold-s', cwd: f.project, ...payload }),
});
const queued = (f) => { try { return fs.readdirSync(f.queue).filter((n) => n.startsWith('session-')); } catch { return []; } };

test('session-snapshot PostToolUse captures the fixed workflow vocabulary in-process', () => {
  const f = setup();
  const r = fire(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } });
  expect(r.status).toBe(0);
  const files = queued(f);
  expect(files).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(f.queue, files[0]), 'utf8'))).toEqual({ tool: 'Bash', action: 'npm test' });
});

test('a failed tool, a non-workflow tool, learning off and brain off capture nothing', () => {
  const f = setup();
  expect(fire(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 } }).status).toBe(0);
  expect(fire(f, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } }).status).toBe(0);
  expect(fire(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, { RUVNET_LEARNING_SCOPE: 'off' }).status).toBe(0);
  fs.mkdirSync(f.env.RUVNET_BRAIN_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.RUVNET_BRAIN_STATE_DIR, 'brain-off'), '');
  expect(fire(f, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }).status).toBe(0);
  expect(queued(f)).toEqual([]);
});

test('session-snapshot SessionEnd schedules learn-flush, which drains a pending queue', async () => {
  const f = setup();
  f.write('pending', `${JSON.stringify({ tool: 'Bash', action: 'npm test' })}\n`);
  expect(fire(f, 'SessionEnd', {}).status).toBe(0);
  // The worker is detached; wait (bounded) for the learner to be called by it.
  const until = Date.now() + 20_000;
  while (Date.now() < until && f.readCalls().length === 0) await new Promise((r) => setTimeout(r, 200));
  expect(f.readCalls().length).toBeGreaterThan(0);
}, 30_000);

test('SessionStart schedules learn-flush through the real session-start body', async () => {
  const f = setup();
  f.write('pending', `${JSON.stringify({ tool: 'Bash', action: 'npm test' })}\n`);
  const r = spawnSync(process.execPath, [SHIM, 'session-start'], { cwd: f.project, encoding: 'utf8', timeout: 30_000, env: f.env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'fold-s', cwd: f.project }) });
  expect(r.status).toBe(0);
  const until = Date.now() + 20_000;
  while (Date.now() < until && f.readCalls().length === 0) await new Promise((res) => setTimeout(res, 200));
  expect(f.readCalls().length).toBeGreaterThan(0);
}, 45_000);

test('recovery spawns no worker when no learning bytes are queued (no stray process holds the project directory)', async () => {
  const { scheduleLearningRecovery } = await import('../../plugin/scripts/learn-capture.mjs');
  const f = setup();
  const spawned = [];
  const spawnFn = (...args) => { spawned.push(args); return { on() {}, unref() {} }; };
  expect(scheduleLearningRecovery({ cwd: f.project, env: f.env, spawnFn })).toBe(false);
  expect(spawned).toEqual([]);
  f.write('pending', `${JSON.stringify({ tool: 'Bash', action: 'npm test' })}\n`);
  expect(scheduleLearningRecovery({ cwd: f.project, env: f.env, spawnFn })).toBe(true);
  expect(spawned).toHaveLength(1);
});
