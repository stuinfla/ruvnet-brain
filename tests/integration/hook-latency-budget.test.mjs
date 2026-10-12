// The host kills a hook at its registered timeout and DISCARDS its output ("timed out after 10s —
// output discarded", measured on the owner's machine 2026-10-11). Prompt and tool boundaries must
// therefore return in near-constant time even when queued memory work is slow: they fsync the
// observation, hand the queue to the detached worker, and return. This fixture makes every native
// store write take 3 s and keeps >= 5 items queued, then fires the REAL registered commands.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo, rows, tmp } from '../helpers/continuity-fixture.mjs';
import { queuedWork } from '../../plugin/scripts/project-capture-queue.mjs';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hooks.json'), 'utf8')).hooks;
const timeoutOf = (event) => Math.min(...hooks[event].flatMap((g) => g.hooks).filter((h) => / session-snapshot /.test(h.command)).map((h) => h.timeout));
afterEach(() => cleanup());

describe('prompt and tool boundaries stay inside their registered timeout under slow, queued memory work', () => {
  it('every boundary returns in constant time with >=5 queued items and a 3 s store; the worker still drains them with exact readback', async () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo({ storeDelayMs: 3000 });
    const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: tmp('lat-bh-'), RUVNET_BRAIN_STATE_DIR: tmp('lat-state-'),
      RUVNET_CONTINUITY_CAPTURE: 'off' };
    const fire = (event, payload) => {
      const t = performance.now();
      const r = spawnSync(process.execPath, [SHIM, 'session-snapshot', event], { cwd: p.dir, env, encoding: 'utf8', timeout: 30_000,
        input: JSON.stringify({ hook_event_name: event, session_id: 'lat', cwd: p.dir, ...payload }) });
      return { ms: performance.now() - t, out: r.stdout, status: r.status };
    };
    const events = [
      ['UserPromptSubmit', { prompt: 'Fix parseCookies in parser.mjs' }],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }],
      ['PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }],
      ['UserPromptSubmit', { prompt: 'Now fix serializeCookies too' }],
      ['PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(p.dir, 'x.mjs') } }],
      ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(p.dir, 'x.mjs') }, tool_response: { success: true } }],
    ];
    const results = events.map(([event, payload]) => ({ event, ...fire(event, payload) }));
    for (const r of results) {
      expect(r.status, r.event).toBe(0);
      expect(r.ms, `${r.event} took ${r.ms.toFixed(0)} ms`).toBeLessThan(timeoutOf(r.event) * 1000 - 1500); // the host contract
      expect(r.ms, `${r.event} took ${r.ms.toFixed(0)} ms`).toBeLessThan(2500); // magnitude: no inline 3 s write
      expect(r.out, 'a normal queued boundary prints nothing').toBe('');
    }
    // The detached worker drains the queue in order and each observation is committed by exact readback.
    const until = Date.now() + 120_000;
    while (Date.now() < until && (queuedWork(p.dir) > 0 || fs.existsSync(path.join(p.dir, '.swarm', '.progression-replay.lock')))) await new Promise((r) => setTimeout(r, 500));
    expect(queuedWork(p.dir)).toBe(0);
    const stored = rows(path.join(p.dir, '.swarm', 'memory.db'), 'project-progression');
    const observed = stored.flatMap((r) => JSON.parse(r.content).completeProjectState?.observations || []);
    expect(new Set(observed.map((o) => o.id)).size).toBe(events.length);
    // Committed means exact readback passed: nothing may be left fsynced-but-unverified in the outbox.
    expect(new ProgressionOutbox({ projectRoot: p.dir }).pendingSnapshots()).toEqual([]);
    expect(ruflo.calls().filter((c) => c.argv[1] === 'store').length).toBeGreaterThanOrEqual(events.length);
  }, 180_000);
});
