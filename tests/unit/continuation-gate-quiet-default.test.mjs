// The Stop gates are QUIET by default: no promise nudges, no completion-claim corrections, no turn-gate nudge,
// unless RUVNET_STOP_NUDGES=full. (Owner, 2026-10-15: a Stop hook that talks on ordinary turns gets disabled.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const GATE = path.resolve('plugin/scripts/continuation-gate.mjs');
const TURN = path.resolve('plugin/scripts/grounding-turn-gate.mjs');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function stop(script, message, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'));
  dirs.push(dir);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, RUVNET_HOOK_HOST: 'claude',
    RUVNET_WORK_LEDGER: path.join(dir, 'ledger.json'), RUVNET_CONTINUATION_COOLDOWN_MS: '1', ...extraEnv };
  const r = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 's1', last_assistant_message: message }) });
  return { status: r.status, out: r.stdout };
}

describe('quiet by default', () => {
  it('a promise is never nudged on an ordinary stop', () => {
    const quiet = { RUVNET_STOP_NUDGES: '' };
    expect(stop(GATE, "I'll add the retry test to the updater.", quiet).out).toBe('');
    expect(stop(GATE, 'Here is the summary you asked for.', quiet).out).toBe('');
  });
  it('a completion claim without a check is not corrected', () => {
    expect(stop(GATE, 'The updater is fixed.', { RUVNET_STOP_NUDGES: '' }).out).toBe('');
  });
  it('the grounding turn gate exits silently', () => {
    expect(stop(TURN, 'Ruflo does everything.', { RUVNET_STOP_NUDGES: '' }).out).toBe('');
  });
  it('the per-prompt advisory hooks are silent through the shim unless full', () => {
    const SHIM = path.resolve('plugin/scripts/hook-shim.mjs');
    for (const id of ['unprompted-speech', 'capacity-aware-parallel-work', 'grounding-turn-gate']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-shim-'));
      dirs.push(dir);
      const run = (nudges) => spawnSync(process.execPath, [SHIM, id], { cwd: dir, encoding: 'utf8',
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dir, prompt: 'Please research and implement three independent workstreams in parallel: refactor the updater, rewrite the docs, and add tests for the installer, each in separate files' }),
        env: { ...process.env, HOME: dir, RUVNET_STOP_NUDGES: nudges } });
      const quiet = run('');
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toBe('');
      expect(quiet.stderr).toBe('');
      if (id === 'capacity-aware-parallel-work') expect(run('full').stdout).toContain('Capacity-aware parallel-work advisory');
    }
  });
  it('an observed SLA-breach issue is not printed on an ordinary stop', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-obs-'));
    dirs.push(dir);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/a.git'], { cwd: dir });
    const issues = path.join(dir, 'issues.json');
    fs.writeFileSync(issues, JSON.stringify({ repo: 'example/a', at: new Date().toISOString(),
      issues: [{ number: 439, title: 'x', breach: true, ageHours: 50 }] }));
    const run = (nudges) => spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: 's1', last_assistant_message: 'Here is the summary.' }),
      env: { ...process.env, HOME: dir, RUVNET_HOOK_HOST: 'claude', RUVNET_WORK_LEDGER: path.join(dir, 'l.json'),
        RUVNET_OPEN_ISSUES_FILE: issues, RUVNET_CONTINUATION_COOLDOWN_MS: '1', RUVNET_STOP_NUDGES: nudges } });
    expect(run('full').stderr).toContain('continuation-advisory');
    expect(run('').stderr).not.toContain('continuation-advisory');
  });
});
