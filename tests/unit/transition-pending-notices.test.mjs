import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../helpers/continuity-fixture.mjs';
import { stopNotice } from '../../plugin/scripts/continuity-journal.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
const scripts = fileURLToPath(new URL('../../plugin/scripts/', import.meta.url));
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-notice-')));
  dirs.push(dir); fs.mkdirSync(path.join(dir, '.swarm'));
  createStore(path.join(dir, '.swarm', 'memory.db'));
  fs.writeFileSync(path.join(dir, '.swarm', '.progression-replay.lock'), `${process.pid}-${Date.now()}-fixture`);
  return dir;
}
function run(dir, script, session = 'one', event = 'UserPromptSubmit', extra = {}, raw, expected) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), event], {
    cwd: dir, input: raw ?? JSON.stringify({ cwd: dir, session_id: session, prompt: 'Fix parser', tool_name: 'Bash', tool_response: { exit_code: 0 } }),
    encoding: 'utf8', timeout: 5000, env: { ...process.env, RUVNET_BRAIN_HOME: dir, RUVNET_HOOK_HOST: 'claude', RUFLO_DAEMON_AUTOSTART: '0', ...extra },
  });
  const diagnostics = JSON.stringify({ script, event, session, status: result.status,
    signal: result.signal, error: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code } : null,
    stdout: result.stdout, stderr: result.stderr });
  expect(result.status, diagnostics).toBe(0);
  if (expected) expect(result.stdout, diagnostics).toMatch(expected);
  return result.stdout;
}
function pending(dir, script, session = 'one') {
  return run(dir, script, session, 'UserPromptSubmit', {}, undefined, /pending.*readback/);
}
const direct = 'project-transition-hook.mjs';
const compatibility = 'session-snapshot-hook.mjs';
const ledger = (dir) => path.join(dir, '.swarm', '.continuity-stop-notices.json');
describe('#380 pending notices retain capture and independent warning conditions', () => {
  for (const first of [direct, compatibility]) it(`deduplicates actual ${first} boundaries across both entrypoints`, () => {
    const dir = project();
    pending(dir, first);
    expect(run(dir, first, 'one', 'PreToolUse')).toBe('');
    expect(run(dir, first === direct ? compatibility : direct, 'one', 'PostToolUse')).toBe('');
    pending(dir, first, 'two');
    expect(fs.readdirSync(path.join(dir, '.swarm')).filter((name) => name.startsWith('.progression-capture-queue-'))).toHaveLength(4);
    expect(fs.lstatSync(ledger(dir)).isFile()).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(ledger(dir)).mode & 0o777).toBe(0o600);
    for (const problem of ['stuck-pending', 'quarantined', 'corrupt']) {
      const options = { journal: { swarm: path.join(dir, '.swarm'), now: Date.now }, session: 'one',
        status: { stuck: true, problem, pending: 4, corrupt: 1, quarantined: [{}] } };
      expect(stopNotice(options)).toMatch(/recording stuck/);
      expect(stopNotice(options)).toBe('');
    }
    expect(run(dir, first, 'one')).toBe('');
  });
  it('does not hide degraded capture errors after a pending notice', () => {
    const dir = project(); expect(run(dir, direct)).toMatch(/pending/);
    for (const script of [direct, compatibility]) {
      expect(run(dir, script, 'one', 'UserPromptSubmit', {}, '{')).toContain('capture degraded');
      expect(run(dir, script, 'one', 'UserPromptSubmit', {}, '{')).toContain('capture degraded');
    }
  });
  it('does not create notice state under automatic suspension or persisted opt-out', () => {
    const dir = project();
    for (const script of [direct, compatibility]) expect(run(dir, script, 'one', 'UserPromptSubmit', { RUVNET_BRAIN_PROGRESSION_SUSPENDED: '1' })).toBe('');
    fs.mkdirSync(path.join(dir, 'turn-capture'));
    const { projectRoot } = resolveProjectStore({ projectDir: dir });
    fs.writeFileSync(path.join(dir, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: { [projectRoot]: 'off' } }));
    for (const script of [direct, compatibility]) expect(run(dir, script)).toBe('');
    expect(fs.existsSync(ledger(dir))).toBe(false);
  });
  it('does not adopt an empty project or announce observations without session identity', () => {
    const dir = project();
    for (const script of [direct, compatibility]) expect(run(dir, script, '', 'UserPromptSubmit')).toBe('');
    fs.rmSync(path.join(dir, '.swarm'), { recursive: true });
    for (const script of [direct, compatibility]) expect(run(dir, script)).toBe('');
    expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
  });
  it.each(['unknown', null, []])('keeps malformed persisted consent fail closed: %j', (setting) => {
    const dir = project();
    const { projectRoot } = resolveProjectStore({ projectDir: dir });
    fs.mkdirSync(path.join(dir, 'turn-capture'));
    fs.writeFileSync(path.join(dir, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: { [projectRoot]: setting } }));
    for (const script of [direct, compatibility]) expect(run(dir, script)).toBe('');
    expect(fs.existsSync(ledger(dir))).toBe(false);
    expect(fs.readdirSync(path.join(dir, '.swarm')).filter((name) => name.startsWith('.progression-capture-queue-'))).toEqual([]);
  });
  it('keeps the existing ledger bounded to twenty sessions', () => {
    const dir = project();
    const journal = { swarm: path.join(dir, '.swarm'), now: () => 1000 };
    for (let i = 0; i < 24; i++) stopNotice({ journal: { ...journal, now: () => 1000 + i }, session: `session-${i}`, status: { stuck: true, problem: 'corrupt', pending: 1, corrupt: 1 } });
    expect(Object.keys(JSON.parse(fs.readFileSync(ledger(dir), 'utf8')))).toHaveLength(20);
  });
});
