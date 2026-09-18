import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lesson = {
  id: 'BLK-deadline-test', statement: 'Verify the actual receipt before reporting the status.',
  trigger: 'report-status', enforcement: 'block', origin: 'user-stated', status: 'ratified',
  check: 'a verification command ran against the actual path', evidence: [{ observed: 'user instruction' }],
  projects: ['alpha', 'beta', 'gamma'], repeatCount: 25,
};
function fixture(base, optIn = true) {
  const plugin = path.join(base, 'plugin');
  fs.cpSync(path.join(ROOT, 'plugin'), plugin, { recursive: true });
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const brain = path.join(base, 'brain');
  fs.mkdirSync(path.join(brain, 'versions'), { recursive: true });
  const installed = path.join(brain, 'versions', 'fixture');
  fs.renameSync(plugin, installed);
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: installed, version: 'fixture', generation: 'fixture' }));
  fs.copyFileSync(path.join(installed, 'scripts/codex-hook-wrapper.mjs'), path.join(brain, 'codex-hook.mjs'));
  const scripts = path.join(installed, 'scripts');
  const stalled = path.join(scripts, 'stalled.mjs');
  fs.writeFileSync(stalled, `import fs from 'node:fs'; import {spawn} from 'node:child_process';
    const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});
    fs.writeFileSync(process.env.STALLED_PIDS,JSON.stringify([process.pid,c.pid]));
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(scripts, 'anticipate.sh'), '#!/bin/sh\nexec "$NODE_FOR_TEST" "$STALLED_SCRIPT"\n');
  fs.writeFileSync(path.join(scripts, 'advocacy-route.mjs'), `import fs from 'node:fs'; fs.writeFileSync(process.env.ADVOCACY_STARTED, 'started');`);
  const store = path.join(base, 'lessons.json');
  const optin = path.join(base, 'optin.json');
  const settings = path.join(base, 'settings.json');
  fs.writeFileSync(store, JSON.stringify({ version: 1, lessons: [lesson] }));
  fs.writeFileSync(optin, JSON.stringify({ version: 1, blocking: optIn ? [lesson.id] : [] }));
  fs.writeFileSync(settings, JSON.stringify({ version: 1, settings: { advocacy: 'off', learningScope: 'project', autoApply: false, newProjectDefaults: false } }));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), RUVNET_BRAIN_HOME: brain,
    RUVNET_LESSON_STORE: store, RUVNET_LESSON_OPTIN: optin, RUVNET_LESSON_GATE_STATE: path.join(base, 'gate.json'),
    RUVNET_LESSON_MAX_SHOWS: '1', RUVNET_SETTINGS_FILE: settings, RUVNET_ADVOCACY_OUTCOMES: path.join(base, 'outcomes.jsonl'),
    RUFLO_DAEMON_AUTOSTART: '0', NODE_FOR_TEST: process.execPath, STALLED_SCRIPT: stalled,
    STALLED_PIDS: path.join(base, 'stalled-pids.json'), ADVOCACY_STARTED: path.join(base, 'advocacy-started') };
  delete env.RUVNET_UNPROMPTED_PRODUCERS;
  delete env.RUVNET_UNPROMPTED_TIMEOUT_MS;
  delete env.RUVNET_CODEX_HOOK_TIMEOUT_MS;
  return { base, installed, env };
}
function run(fx, host, overrides = {}) {
  const document = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks', host === 'codex' ? 'codex-hooks.json' : 'hooks.json')));
  const registered = document.hooks.UserPromptSubmit.flatMap((group) => group.hooks)
    .find((hook) => hook.command.includes('unprompted-speech'));
  const command = registered.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', fx.installed);
  const started = performance.now();
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: fx.base, encoding: 'utf8',
    timeout: registered.timeout * 1000, killSignal: 'SIGKILL',
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: fx.base, prompt: 'Please report the current status of the project work.', session_id: 'deadline-fixture' }),
    env: { ...fx.env, ...overrides } });
  return { ...result, elapsed: performance.now() - started };
}
function cleanup(fx) {
  const marker = fx?.env.STALLED_PIDS;
  if (marker && fs.existsSync(marker)) for (const pid of JSON.parse(fs.readFileSync(marker))) {
    if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
describe('shipped hook command deadlines', () => {
  it.each(['claude', 'codex'])('%s delivers an opted-in refusal before advisory producers start', (host) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-host-block-')); let fx;
    try {
      fx = fixture(base);
      expect(fx.env).not.toHaveProperty('RUVNET_UNPROMPTED_PRODUCERS');
      const result = run(fx, host);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(lesson.statement);
      expect(result.elapsed).toBeLessThan(2500);
      expect(fs.existsSync(fx.env.STALLED_PIDS)).toBe(false);
      expect(fs.existsSync(fx.env.ADVOCACY_STARTED)).toBe(false);
      expect(fs.existsSync(fx.env.RUVNET_ADVOCACY_OUTCOMES)).toBe(false);
      const repeat = run(fx, host);
      expect(repeat.status, repeat.stderr).toBe(2);
      expect(repeat.stderr).toContain(lesson.statement);
    } finally { cleanup(fx); fs.rmSync(base, { recursive: true, force: true }); }
  });

  it.each(['claude', 'codex'])('%s delivers an unopted lesson after killing the stalled advisory tree', (host) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-host-advisory-')); let fx;
    try {
      fx = fixture(base, false);
      const result = run(fx, host);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(lesson.statement);
      expect(result.elapsed).toBeLessThan(2500);
      const pids = JSON.parse(fs.readFileSync(fx.env.STALLED_PIDS));
      expect(pids.every((pid) => !alive(pid))).toBe(true);
      const repeat = run(fx, host);
      expect(repeat.status, repeat.stderr).toBe(0);
      expect(repeat.stdout).not.toContain(lesson.statement);
      expect(JSON.parse(fs.readFileSync(fx.env.STALLED_PIDS)).every((pid) => !alive(pid))).toBe(true);
    } finally { cleanup(fx); fs.rmSync(base, { recursive: true, force: true }); }
  });

  it.each(['-1', '0', 'abc', 'Infinity', '1e12'])('invalid budget %s does not disable a refusal', (budget) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-host-budget-')); let fx;
    try {
      fx = fixture(base);
      const result = run(fx, 'claude', { RUVNET_UNPROMPTED_TIMEOUT_MS: budget });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(lesson.statement);
    } finally { cleanup(fx); fs.rmSync(base, { recursive: true, force: true }); }
  });
});
