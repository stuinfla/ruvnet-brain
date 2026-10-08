import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = path.join(ROOT, 'plugin/scripts/lesson-gate.mjs');
let home, store, consent;
const block = (overrides = {}) => ({
  id: 'BUDGET-owner-block', statement: 'Verify the actual target before claiming completion.',
  trigger: 'claim-done', enforcement: 'block', origin: 'user-stated', status: 'ratified',
  check: 'a verification command ran against the actual target', evidence: [{ observed: 'explicit owner instruction' }],
  projects: [], repeatCount: 1, ...overrides,
});
const advisory = (overrides = {}) => block({
  id: 'BUDGET-long-advisory', statement: 'Verify ' + 'x'.repeat(1300), trigger: 'report-status',
  enforcement: 'checklist', check: null, repeatCount: 100, ...overrides,
});
function seed(rows, ids = []) {
  fs.writeFileSync(store, JSON.stringify({ version: 1, lessons: rows.map(row => ({ ...row, projects: [home] })) }));
  fs.writeFileSync(consent, JSON.stringify({ version: 1, blocking: ids }));
}
function fire(extraArgs = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [GATE, '--event', 'UserPromptSubmit',
    '--trigger', 'report-status', '--trigger', 'claim-done', '--session', 'budget-case', ...extraArgs], {
    cwd: home, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_LESSON_STORE: store,
      RUVNET_LESSON_OPTIN: consent, RUVNET_LESSON_GATE_STATE: path.join(home, 'state.json'),
      RUVNET_EMIT_CANDIDATES: '0', RUVNET_NUDGE_BUDGET: '1200', ...extraEnv },
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-lesson-budget-'));
  const git = spawnSync('git', ['init', '-q'], { cwd: home, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  store = path.join(home, 'lessons.json'); consent = path.join(home, 'blocking-optin.json');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('trusted refusal survives the cross-trigger advisory budget', () => {
  it('keeps the same refusal when a higher-repeat 1300-character advisory is added', () => {
    seed([block()], [block().id]);
    expect(fire()).toEqual({ code: 2, stdout: '', stderr: expect.stringContaining(block().statement) });
    seed([advisory(), block()], [block().id]);
    const result = fire();
    expect(result.code).toBe(2); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('⛔ ' + block().statement);
    expect(result.stderr).toContain('BLOCKED');
  });
  it.each(['ratified', 'active'])('retains every opted-in %s blocker with a one-character budget', status => {
    const second = block({ id: 'BUDGET-second-block', statement: 'Verify the second actual target too.', trigger: 'report-status', status });
    seed([advisory(), block({ status }), second], [block().id, second.id]);
    const result = fire([], { RUVNET_NUDGE_BUDGET: '1' });
    expect(result.code).toBe(2); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('⛔ ' + block().statement);
    expect(result.stderr).toContain('⛔ ' + second.statement);
  });
  it('emits a real block candidate while leaving candidate-mode enforcement to the runtime', () => {
    seed([advisory(), block()], [block().id]);
    const result = fire([], { RUVNET_EMIT_CANDIDATES: '1' });
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    const candidate = JSON.parse(result.stdout);
    expect(candidate.channel).toBe('lesson'); expect(candidate.effect).toBe('block');
    expect(candidate.copy).toContain('⛔ ' + block().statement);
  });
  it.each([
    ['no opt-in', {}, false], ['not blocking', { enforcement: 'checklist' }, true],
    ['unratified', { status: 'candidate' }, true], ['imported', { origin: 'imported' }, true],
    ['model inferred', { origin: 'model-inferred' }, true], ['disabled row', { demoted: true }, true],
  ])('never grants refusal authority to %s under budget pressure', (_label, override, optedIn) => {
    seed([advisory(), block(override)], optedIn ? [block().id] : []);
    const result = fire();
    expect(result.code).toBe(0); expect(result.stderr).not.toContain('BLOCKED');
    if (['unratified', 'imported', 'model inferred'].includes(_label)) {
      expect(result.stderr).toContain('IGNORED'); // rejected store rows remain diagnosed, not refusals
    } else expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).not.toContain('⛔');
  });
  it('ordinary over-budget advisories remain trimmed and cannot manufacture a block', () => {
    seed([advisory(), block({ enforcement: 'checklist' })]);
    const result = fire(['--json']);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    const presentation = JSON.parse(result.stdout);
    expect(presentation.blocking).toEqual([]);
    expect(presentation.inForce.map(row => row.id)).toEqual([advisory().id]);
  });
});
