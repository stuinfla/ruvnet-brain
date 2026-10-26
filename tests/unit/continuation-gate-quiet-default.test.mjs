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
  it('quiet unprompted-speech still delivers a recorded lesson, and only the lesson', () => {
    // A recorded correction is not an advisory nudge: from 4.7.8 to 4.7.20 quiet mode exited this hook
    // whole and no learned lesson reached any prompt. Fake producers through the runtime's test seam.
    const SHIM = path.resolve('plugin/scripts/hook-shim.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-lesson-'));
    dirs.push(dir);
    const spawned = path.join(dir, 'advocacy-spawned');
    const emit = (channel, copy, marker = '') => ({ argv: [process.execPath, '-e',
      `${marker ? `require('fs').writeFileSync(${JSON.stringify(marker)}, '1');` : ''}`
      + `process.stdout.write(JSON.stringify({channel:'${channel}',effect:'advisory',copy:'${copy}'})+'\\n')`],
    feedStdin: false, channels: [channel] });
    const producers = JSON.stringify([emit('lesson', 'LESSON-COPY-7'), emit('advocacy', 'ADVOCACY-COPY-7', spawned)]);
    const run = (nudges) => spawnSync(process.execPath, [SHIM, 'unprompted-speech', 'UserPromptSubmit'], { cwd: dir, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dir, prompt: 'recall the caching note' }),
      env: { ...process.env, HOME: dir, RUVNET_STOP_NUDGES: nudges, RUVNET_UNPROMPTED_PRODUCERS: producers } });
    const quiet = run('');
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain('LESSON-COPY-7');
    expect(quiet.stdout).not.toContain('ADVOCACY-COPY-7');
    expect(fs.existsSync(spawned)).toBe(false);     // the advocacy producer was never even spawned
    expect(run('full').stdout).toContain('LESSON-COPY-7');
    expect(fs.existsSync(spawned)).toBe(true);      // and full mode still runs it
  });
  describe('plugin/spine skew keeps quiet mode quiet (4.7.21 review F1)', () => {
    // The shim is boot-frozen (plugin cache), the runtime body is hot-updated (spine), so either may be
    // older than the other. 73f31f2f is the 4.7.20 tree: its shim exits unprompted-speech whole in quiet
    // mode and its runtime ignores RUVNET_UNPROMPTED_CHANNELS. CI checks out full history (fetch-depth 0);
    // a missing commit fails here loudly instead of skipping.
    const OLD = '73f31f2f';
    const PROMPT = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'recall the caching note' });
    function extractOldPlugin(into) {
      const tar = spawnSync('git', ['archive', '--format=tar', OLD, 'plugin'], { maxBuffer: 256 * 1024 * 1024 });
      if (tar.status !== 0) throw new Error(`git archive ${OLD} failed: ${tar.stderr}`);
      fs.mkdirSync(into, { recursive: true });
      const x = spawnSync('tar', ['-x', '-f', '-', '-C', into], { input: tar.stdout });
      if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
      return path.join(into, 'plugin');
    }
    function world(spineFrom) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-skew-'));
      dirs.push(dir);
      const brain = path.join(dir, 'brain');
      fs.mkdirSync(path.join(brain, 'versions'), { recursive: true });
      fs.cpSync(spineFrom, path.join(brain, 'versions', 'gen1'), { recursive: true });
      fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: 'versions/gen1', generation: 1, version: 'skew' }));
      const marker = path.join(dir, 'advocacy-spawned');
      const emit = (channel, copy, mark = '') => ({ argv: [process.execPath, '-e',
        `${mark ? `require('fs').writeFileSync(${JSON.stringify(mark)}, '1');` : ''}`
        + `process.stdout.write(JSON.stringify({channel:'${channel}',effect:'advisory',copy:'${copy}',findingId:'f1'})+'\\n')`],
      feedStdin: false, channels: [channel] });
      const producers = JSON.stringify([emit('lesson', 'LESSON-SKEW'), emit('advocacy', 'ADVOCACY-SKEW', marker)]);
      const run = (shim, nudges) => {
        try { fs.rmSync(marker, { force: true }); } catch { /* fresh per run */ }
        const r = spawnSync(process.execPath, [shim, 'unprompted-speech', 'UserPromptSubmit'], { cwd: dir, encoding: 'utf8', input: PROMPT,
          env: { ...process.env, HOME: dir, USERPROFILE: dir, RUVNET_BRAIN_HOME: brain, RUVNET_STOP_NUDGES: nudges,
            RUVNET_UNPROMPTED_PRODUCERS: producers, RUVNET_UNPROMPTED_CHANNELS: '' } });
        return { status: r.status, out: r.stdout, spawned: fs.existsSync(marker) };
      };
      return { dir, run };
    }

    it('the NEW shim over the 4.7.20 runtime body never spawns advocacy in quiet mode', () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-old-'));
      dirs.push(scratch);
      const { run } = world(extractOldPlugin(scratch));
      const quiet = run(path.resolve('plugin/scripts/hook-shim.mjs'), '');
      expect(quiet.status).toBe(0);
      expect(quiet.out).toBe('');                       // the old body cannot narrow, so the shim does not run it
      expect(quiet.spawned).toBe(false);
      const full = run(path.resolve('plugin/scripts/hook-shim.mjs'), 'full');
      expect(full.out).toContain('LESSON-SKEW');        // the old body really is the one being dispatched
      expect(full.spawned).toBe(true);
    });

    it('the 4.7.20 shim over the NEW runtime body stays silent in quiet mode (whole-hook exit) and runs it under full', () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-old-'));
      dirs.push(scratch);
      const oldShim = path.join(extractOldPlugin(scratch), 'scripts', 'hook-shim.mjs');
      const { run } = world(path.resolve('plugin'));
      const quiet = run(oldShim, '');
      expect(quiet).toEqual({ status: 0, out: '', spawned: false });   // lessons too: the old shim exits before any body
      const full = run(oldShim, 'full');
      expect(full.out).toContain('LESSON-SKEW');
      expect(full.spawned).toBe(true);
    });

    it('the runtime body is quiet by itself when no shim narrows it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-body-'));
      dirs.push(dir);
      const marker = path.join(dir, 'advocacy-spawned');
      const emit = (channel, copy, mark = '') => ({ argv: [process.execPath, '-e',
        `${mark ? `require('fs').writeFileSync(${JSON.stringify(mark)}, '1');` : ''}`
        + `process.stdout.write(JSON.stringify({channel:'${channel}',effect:'advisory',copy:'${copy}'})+'\\n')`],
      feedStdin: false, channels: [channel] });
      const producers = JSON.stringify([emit('lesson', 'LESSON-BODY'), emit('promotion', 'PROMO-BODY', marker)]);
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, RUVNET_UNPROMPTED_PRODUCERS: producers };
      delete env.RUVNET_UNPROMPTED_CHANNELS;
      const r = spawnSync(process.execPath, [path.resolve('plugin/scripts/unprompted-runtime.mjs'), 'UserPromptSubmit'],
        { cwd: dir, encoding: 'utf8', input: PROMPT, env: { ...env, RUVNET_STOP_NUDGES: '' } });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('LESSON-BODY');
      expect(fs.existsSync(marker)).toBe(false);
      spawnSync(process.execPath, [path.resolve('plugin/scripts/unprompted-runtime.mjs'), 'UserPromptSubmit'],
        { cwd: dir, encoding: 'utf8', input: PROMPT, env: { ...env, RUVNET_STOP_NUDGES: 'full' } });
      expect(fs.existsSync(marker)).toBe(true);         // full mode still spawns the non-lesson producer
    });
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
