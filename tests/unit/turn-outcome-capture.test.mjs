// Turn-outcome capture through the shared capture boundary (runSessionSnapshotHook).
// Every writer is a fake: `launch` records the steps the detached worker would run, so nothing here
// touches a real AgentDB store or the user's home.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSessionSnapshotHook } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { captureTurnOutcome, runSteps } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { CONTINUITY_EVENTS } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const OUTCOME = 'Concluded: the continuation gate continues most turns, so the final Stop carries '
  + 'stop_hook_active=true and must still be recorded; duplicates are removed by a per-session '
  + 'fingerprint of the outcome text and the files changed, never by skipping the flag.';
const USER_PROMPT = 'SECRET-USER-PROMPT please refactor the billing module for acme corp';

function harness({ withSwarm = true, settings = null } = {}) {
  const home = tmp('turn-home-');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  if (settings) {
    fs.mkdirSync(path.join(brainHome, 'turn-capture'), { recursive: true });
    fs.writeFileSync(path.join(brainHome, 'turn-capture', 'settings.json'), JSON.stringify(settings));
  }
  const project = tmp('turn-project-');
  if (withSwarm) {
    fs.mkdirSync(path.join(project, '.swarm'));
    fs.writeFileSync(path.join(project, '.swarm', 'memory.db'), '');
  }
  const launches = [];
  const captureTurn = (opts) => captureTurnOutcome({
    ...opts, env: {}, home, ruflo: '/fake/bin/ruflo',
    launch: (steps) => { launches.push(steps); return { launched: true }; },
  });
  const fire = (event, payload, host = 'claude') => runSessionSnapshotHook(project, event, {
    rawInput: JSON.stringify({ hook_event_name: event, cwd: project, ...payload }), host, captureTurn,
  });
  return { home, project, launches, fire };
}

function transcript(dir, records) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

const stores = (launches) => launches.flat().filter((s) => s.kind === 'store');
// The value travels in the 0600 spool file the worker imports, never on argv (G-001).
const valueOf = (step) => JSON.parse(fs.readFileSync(step.spool, 'utf8')).entries[0].value;
const flag = (step, name) => step.args[step.args.indexOf(name) + 1];

describe('turn-outcome capture at the shared snapshot boundary', () => {
  it('(1) records a stop_hook_active=true Stop exactly once; an identical repeat records nothing', () => {
    const h = harness();
    const payload = { session_id: 's-1', stop_hook_active: true, last_assistant_message: OUTCOME };
    const first = h.fire('Stop', payload);
    const second = h.fire('Stop', payload);
    expect(first.turn.queued).toBe(true);
    expect(first.turn.recorded).toBe(false); // only the worker's exact read-back proves a record (G-014)
    expect(second.turn.queued).toBe(false);
    expect(second.turn.skipped).toBe('same turn outcome already recorded');
    expect(stores(h.launches)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(stores(h.launches)[0].spool, 'utf8')).entries[0].namespace).toBe('turns');
  });

  it('(2) last_assistant_message wins over the transcript text', () => {
    const h = harness();
    const stale = 'STALE transcript text from the previous assistant message, which the host had not '
      + 'yet replaced with the closing message when Stop fired. '.repeat(3);
    const file = transcript(h.home, [
      { type: 'user', message: { role: 'user', content: USER_PROMPT } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: stale }] } },
    ]);
    h.fire('Stop', { session_id: 's-2', transcript_path: file, last_assistant_message: OUTCOME });
    const value = valueOf(stores(h.launches)[0]);
    expect(value).toContain('Concluded: the continuation gate');
    expect(value).not.toContain('STALE transcript text');
  });

  it('(3) a project with no store records NOTHING by default (G-002), the machine-wide db only when opted in, and never creates .swarm', () => {
    const h = harness({ withSwarm: false });
    const r = h.fire('Stop', { session_id: 's-3', last_assistant_message: OUTCOME });
    expect(h.launches).toHaveLength(0);
    expect(r.turn).toMatchObject({ queued: false, scope: 'none' });
    expect(r.turn.skipped).toMatch(/has not adopted an AgentDB store/);
    expect(fs.existsSync(path.join(h.home, '.claude', 'global-memory'))).toBe(false);
    const opted = harness({ withSwarm: false, settings: { unadopted: 'global' } });
    opted.fire('Stop', { session_id: 's-3g', last_assistant_message: OUTCOME });
    expect(stores(opted.launches)[0].db).toBe(path.join(opted.home, '.claude', 'global-memory', '.swarm', 'memory.db'));
    expect(fs.existsSync(path.join(opted.project, '.swarm'))).toBe(false);
    // and a project that HAS a store keeps its turns in it
    const p = harness();
    p.fire('Stop', { session_id: 's-3b', last_assistant_message: OUTCOME });
    expect(stores(p.launches)[0].db).toBe(path.join(p.project, '.swarm', 'memory.db'));
  });

  it('(4) a Codex-shaped Stop payload records correctly', () => {
    const h = harness();
    // codex-cli 0.158.0 stop.command.input: cwd, hook_event_name, last_assistant_message (nullable),
    // model, permission_mode, session_id, stop_hook_active, transcript_path (nullable), turn_id.
    const codex = { session_id: '01a0eb25-6d1c-79a0-8a1a-579ad830c784', turn_id: 'turn-7', model: 'gpt-5.5',
      permission_mode: 'default', stop_hook_active: false, transcript_path: null, last_assistant_message: OUTCOME };
    const result = h.fire('Stop', codex, 'codex');
    expect(result.turn.queued).toBe(true);
    const step = stores(h.launches)[0];
    expect(valueOf(step)).toContain('host=codex');
    expect(valueOf(step)).toContain('Concluded: the continuation gate');
    const empty = h.fire('Stop', { ...codex, session_id: 'codex-2', last_assistant_message: null }, 'codex');
    expect(empty.turn.skipped).toBe('codex payload carried no last_assistant_message');
  });

  it('(5) the record never contains user prompt text, and keeps files + Bash descriptions', () => {
    const h = harness();
    const file = transcript(h.home, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: USER_PROMPT }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/billing.mjs', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: OUTCOME }] } },
    ]);
    h.fire('Stop', { session_id: 's-5', transcript_path: file, last_assistant_message: OUTCOME });
    const value = valueOf(stores(h.launches)[0]);
    expect(value).not.toContain('SECRET-USER-PROMPT');
    expect(value).not.toContain('acme corp');
    expect(value).toContain('FILES CHANGED: /repo/src/billing.mjs');
    expect(value).toContain('ACTIONS: Run the unit tests');
  });

  it('(6) SessionEnd queues distill against the same db with --db, and records no turn', () => {
    const h = harness();
    const result = h.fire('SessionEnd', { session_id: 's-6', reason: 'exit' });
    const db = path.join(h.project, '.swarm', 'memory.db');
    const distill = h.launches.flat().filter((s) => s.kind === 'distill');
    expect(distill).toHaveLength(1);
    expect(distill[0].args.slice(0, 3)).toEqual(['memory', 'distill', 'run']);
    expect(flag(distill[0], '--db')).toBe(db);
    expect(flag(distill[0], '--namespace')).toBe('turns');
    expect(result.turn.distill).toEqual({ queued: true, db });
    expect(stores(h.launches)).toHaveLength(0);
  });

  it('skips trivial turns and honours the RUVNET_TURN_CAPTURE=off switch', () => {
    const h = harness();
    expect(h.fire('Stop', { session_id: 's-t', last_assistant_message: 'Done.' }).turn.skipped).toBe('trivial turn');
    const off = captureTurnOutcome({ projectDir: h.project, event: 'Stop', payload: { session_id: 'x', last_assistant_message: OUTCOME },
      env: { RUVNET_TURN_CAPTURE: 'off' }, home: h.home, ruflo: '/fake/ruflo', launch: () => { throw new Error('must not launch'); } });
    expect(off.skipped).toBe('RUVNET_TURN_CAPTURE=off');
  });

  it('G-001: a persisted opt-out (machine or one project) takes effect at the next Stop of a live session, and a malformed settings file fails closed', () => {
    const h = harness();
    const fire = (id) => h.fire('Stop', { session_id: id, last_assistant_message: `${OUTCOME} ${id}` }).turn;
    expect(fire('live-1').queued).toBe(true);
    const cli = path.join(ROOT, 'plugin', 'scripts', 'turn-capture-state.mjs');
    const env = { ...process.env, HOME: h.home, RUVNET_BRAIN_HOME: path.join(h.home, '.cache', 'ruvnet-brain') };
    execFileSync(process.execPath, [cli, '--capture', 'off', '--project', h.project], { env });
    expect(fire('live-2')).toMatchObject({ queued: false });
    expect(fire('live-2').skipped).toMatch(/turn capture is off for/);
    execFileSync(process.execPath, [cli, '--capture', 'on', '--project', h.project], { env });
    expect(fire('live-3').queued).toBe(true);
    execFileSync(process.execPath, [cli, '--capture', 'off'], { env });
    expect(fire('live-4').skipped).toMatch(/turn capture is off on this machine/);
    const file = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture', 'settings.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, '{ not json');
    expect(fire('live-5').skipped).toMatch(/not valid JSON: recording nothing/);
    expect(stores(h.launches)).toHaveLength(2);
  });

  it('G-001: the record is redacted before it is written anywhere; the jsonl index holds only {ts,key,hash,len} at 0600', () => {
    const h = harness();
    const token = ['gh', 'p_'].join('') + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    h.fire('Stop', { session_id: 's-red', last_assistant_message: `${OUTCOME} The deploy used ${token} for the push.` });
    const step = stores(h.launches)[0];
    expect(valueOf(step)).toContain('[REDACTED:token]');
    expect(valueOf(step)).not.toContain(token);
    expect(fs.statSync(step.spool).mode & 0o777).toBe(0o600);
    const jsonl = path.join(h.project, '.swarm', 'agentdb-turns.jsonl');
    const rows = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(Object.keys(rows[0]).sort()).toEqual(['hash', 'key', 'len', 'ts']);
    expect(fs.statSync(jsonl).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(step)).not.toContain('The deploy used');
  });

  it('the worker imports the spool, reads it back by exact key, removes the spool, and runs ruflo outside the store', () => {
    const calls = [];
    const dir = tmp('turn-worker-');
    const receipts = path.join(dir, 'r.jsonl');
    fs.mkdirSync(path.join(dir, '.swarm'));
    const db = path.join(dir, '.swarm', 'memory.db');
    fs.writeFileSync(db, '');
    const value = 'the outcome';
    const spool = path.join(dir, 'spool.json');
    fs.writeFileSync(spool, JSON.stringify({ entries: [{ key: 'k1', namespace: 'turns', value }] }), { mode: 0o600 });
    const hash = crypto.createHash('sha256').update(value).digest('hex');
    const run = (bin, args, opts) => {
      calls.push({ args, opts });
      if (args[1] === 'retrieve') return { status: 0, stdout: value };
      return { status: 0, stdout: '', stderr: '' };
    };
    const rows = runSteps({ receipts, steps: [
      { kind: 'store', ruflo: '/fake/ruflo', db, scope: 'project', key: 'k1', spool, hash },
      { kind: 'distill', ruflo: '/fake/ruflo', db, scope: 'project', args: ['memory', 'distill', 'run', '--db', db] },
    ] }, { run });
    expect(calls.map((c) => c.args[1])).toEqual(['import', 'retrieve', 'distill']);
    expect(calls[0].args).toEqual(['memory', 'import', '-i', spool, '-n', 'turns', '--path', db]);
    expect(calls.every((c) => c.opts.env.RUFLO_DAEMON_AUTOSTART === '0' && c.opts.timeout > 0)).toBe(true);
    expect(calls.every((c) => !c.opts.cwd.startsWith(dir) && c.opts.env.CLAUDE_FLOW_MEMORY_PATH === c.opts.cwd)).toBe(true);
    expect(calls.every((c) => !fs.existsSync(c.opts.cwd))).toBe(true);
    expect(fs.existsSync(spool)).toBe(false);
    expect(rows.map((r) => [r.kind, r.ok, r.readBack])).toEqual([['store', true, 'verified'], ['distill', true, undefined]]);
  });
});

describe('both hosts reach the capture boundary at Stop', () => {
  it('Codex registers session-snapshot at Stop in the policy and in codex-hooks.json', () => {
    expect(CONTINUITY_EVENTS.Stop.find((r) => r.id === 'session-snapshot')?.hosts).toEqual(['claude', 'codex']);
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/codex-hooks.json'), 'utf8'));
    const stop = codex.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)).join('\n');
    expect(stop).toMatch(/session-snapshot Stop/);
  });
});
