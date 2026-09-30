// Turn-outcome capture through the shared capture boundary (runSessionSnapshotHook).
// Every writer is a fake: `launch` records the steps the detached worker would run, so nothing here
// touches a real AgentDB store or the user's home.
import fs from 'node:fs';
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

function harness({ withSwarm = false } = {}) {
  const home = tmp('turn-home-');
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
const valueOf = (step) => step.args[step.args.indexOf('--value') + 1];
const flag = (step, name) => step.args[step.args.indexOf(name) + 1];

describe('turn-outcome capture at the shared snapshot boundary', () => {
  it('(1) records a stop_hook_active=true Stop exactly once; an identical repeat records nothing', () => {
    const h = harness();
    const payload = { session_id: 's-1', stop_hook_active: true, last_assistant_message: OUTCOME };
    const first = h.fire('Stop', payload);
    const second = h.fire('Stop', payload);
    expect(first.turn.recorded).toBe(true);
    expect(second.turn.recorded).toBe(false);
    expect(second.turn.skipped).toBe('same turn outcome already recorded');
    expect(stores(h.launches)).toHaveLength(1);
    expect(flag(stores(h.launches)[0], '-n')).toBe('turns');
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

  it('(3) a project with no .swarm records to the machine-wide db and never creates .swarm', () => {
    const h = harness();
    h.fire('Stop', { session_id: 's-3', last_assistant_message: OUTCOME });
    const expected = path.join(h.home, '.claude', 'global-memory', '.swarm', 'memory.db');
    expect(flag(stores(h.launches)[0], '--path')).toBe(expected);
    expect(fs.existsSync(path.join(h.project, '.swarm'))).toBe(false);
    // and a project that HAS a store keeps its turns in it
    const p = harness({ withSwarm: true });
    p.fire('Stop', { session_id: 's-3b', last_assistant_message: OUTCOME });
    expect(flag(stores(p.launches)[0], '--path')).toBe(path.join(p.project, '.swarm', 'memory.db'));
  });

  it('(4) a Codex-shaped Stop payload records correctly', () => {
    const h = harness();
    // codex-cli 0.158.0 stop.command.input: cwd, hook_event_name, last_assistant_message (nullable),
    // model, permission_mode, session_id, stop_hook_active, transcript_path (nullable), turn_id.
    const codex = { session_id: '01a0eb25-6d1c-79a0-8a1a-579ad830c784', turn_id: 'turn-7', model: 'gpt-5.5',
      permission_mode: 'default', stop_hook_active: false, transcript_path: null, last_assistant_message: OUTCOME };
    const result = h.fire('Stop', codex, 'codex');
    expect(result.turn.recorded).toBe(true);
    const step = stores(h.launches)[0];
    expect(valueOf(step)).toContain('host=codex');
    expect(valueOf(step)).toContain('Concluded: the continuation gate');
    expect(flag(step, '--tags')).toContain('host=codex');
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
    const h = harness({ withSwarm: true });
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

  // Dream Cycle 2026-09-30 (stranger-project-behaviour). Every other consumer of a project's
  // `.swarm/memory.db` goes through project-store-resolver.mjs, which refuses a store that symlinks
  // outside the project ("store symlink escape rejected" — pinned for the Console by
  // console-memory-canonical-store.test.mjs and for the managed CLI by managed-cli-interface.test.mjs).
  // A cloned repository can carry that symlink. Turn capture must not be the one writer that
  // follows it: neither the ruflo `--path` target nor the breadcrumb may land in the foreign dir.
  it.each([
    ['the db file', (project, foreign) => {
      fs.mkdirSync(path.join(project, '.swarm'));
      fs.symlinkSync(path.join(foreign, 'memory.db'), path.join(project, '.swarm', 'memory.db'));
    }],
    ['the .swarm directory', (project, foreign) => {
      fs.symlinkSync(foreign, path.join(project, '.swarm'), 'dir');
    }],
  ])('(7) a project whose %s symlinks outside it never receives a turn write through that link', (_label, plant) => {
    const h = harness();
    const foreign = tmp('turn-foreign-store-');
    fs.writeFileSync(path.join(foreign, 'memory.db'), 'foreign');
    plant(h.project, foreign);

    const result = h.fire('Stop', { session_id: 's-7', last_assistant_message: OUTCOME });

    expect(result.turn.recorded).toBe(true); // still recorded — just never through the foreign link
    const target = flag(stores(h.launches)[0], '--path');
    expect(fs.realpathSync.native(path.dirname(target)).startsWith(foreign)).toBe(false);
    expect(target).toBe(path.join(h.home, '.claude', 'global-memory', '.swarm', 'memory.db'));
    expect(fs.readdirSync(foreign)).toEqual(['memory.db']); // no agentdb-turns.jsonl breadcrumb
    expect(fs.readFileSync(path.join(foreign, 'memory.db'), 'utf8')).toBe('foreign');
  });

  it('skips trivial turns and honours the RUVNET_TURN_CAPTURE=off switch', () => {
    const h = harness();
    expect(h.fire('Stop', { session_id: 's-t', last_assistant_message: 'Done.' }).turn.skipped).toBe('trivial turn');
    const off = captureTurnOutcome({ projectDir: h.project, event: 'Stop', payload: { session_id: 'x', last_assistant_message: OUTCOME },
      env: { RUVNET_TURN_CAPTURE: 'off' }, home: h.home, ruflo: '/fake/ruflo', launch: () => { throw new Error('must not launch'); } });
    expect(off.skipped).toBe('RUVNET_TURN_CAPTURE=off');
  });

  it('the worker runs store before distill, bounded, with the daemon autostart disabled', () => {
    const calls = [];
    const receipts = path.join(tmp('turn-receipts-'), 'r.jsonl');
    runSteps({ receipts, steps: [
      { kind: 'store', ruflo: '/fake/ruflo', args: ['memory', 'store', '-k', 'k1', '--value', 'v', '-n', 'turns', '--path', '/db'] },
      { kind: 'distill', ruflo: '/fake/ruflo', args: ['memory', 'distill', 'run', '--db', '/db'] },
    ] }, { run: (bin, args, opts) => { calls.push({ args, opts }); return { status: 0 }; } });
    expect(calls.map((c) => c.args[1])).toEqual(['store', 'distill']);
    expect(calls.every((c) => c.opts.env.RUFLO_DAEMON_AUTOSTART === '0' && c.opts.timeout > 0)).toBe(true);
    // ruflo writes hnsw.index / ruvector.db relative to its cwd even with --path: contain them.
    expect(calls.every((c) => c.opts.cwd === '/' && c.opts.env.CLAUDE_FLOW_MEMORY_PATH === '/')).toBe(true);
    const rows = fs.readFileSync(receipts, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.kind, r.db, r.status])).toEqual([['store', '/db', 0], ['distill', '/db', 0]]);
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
