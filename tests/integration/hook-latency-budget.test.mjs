// Every handler registered in plugin/hooks/hooks.json, fired through the REAL hook-shim with a stub ruflo
// that sleeps past the shim's watchdog. The host kills a hook at its registered timeout and discards its
// output, so (a) each handler must return before that timeout, and (b) a handler that called ruflo and
// did not get an answer must leave a hook-failures row (loud, owner ruling 2026-10-12) — never silence.
// Restores the budget proof whose predecessor was deleted with the hand-rolled queue (review t4).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, tmp } from '../helpers/continuity-fixture.mjs';
import { slowRuflo, ledgerRows, until } from '../helpers/slow-ruflo.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const STUB_SLEEP_MS = 12_000; // past every watchdog (registered timeout - 1.5 s <= 8.5 s)
const OUTCOME = 'Replaced the cookie parser with a tokenizer that keeps quoted equals signs, added three regression cases '
  + 'from real headers, and confirmed the whole unit suite passes on the branch before reporting the change as done.';
const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hooks.json'), 'utf8')).hooks;
const handlers = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({
  event, timeoutMs: h.timeout * 1000,
  args: h.command.split('hook-shim.mjs"')[1].replace('|| true', '').trim().split(/\s+/).filter(Boolean),
}))));
afterAll(() => cleanup());

function payloadFor(event, dir) {
  const base = { hook_event_name: event, session_id: 'latency', cwd: dir };
  if (event === 'Stop') return { ...base, last_assistant_message: OUTCOME, stop_hook_active: true };
  if (event === 'PostToolUse') return { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } };
  if (event === 'PreToolUse') return { ...base, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'x.mjs'), old_string: 'a', new_string: 'b' } };
  if (event === 'UserPromptSubmit') return { ...base, prompt: 'Fix the cookie parser' };
  if (event === 'SessionStart') return { ...base, source: 'startup' };
  return base;
}

function fire(h) {
  const p = adoptedProject();
  const home = p.home;
  fs.mkdirSync(path.join(home, '.claude', 'global-memory', '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'), '');
  fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}'); // learning ON: exercise it
  const stub = slowRuflo(tmp('lat-ruflo-'), { delayMs: STUB_SLEEP_MS, delayAll: true });
  const brainHome = tmp('lat-bh-');
  const env = { ...p.env, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), CLAUDE_PROJECT_DIR: p.dir, RUFLO_BIN: stub.bin,
    RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'), RUVNET_BRAIN_PROJECT_DIR: p.dir,
    RUVNET_LEARNING_SCOPE: 'user', RUVNET_TURN_CAPTURE: 'on' };
  return new Promise((resolve) => {
    const t = performance.now();
    const child = spawn(process.execPath, [SHIM, ...h.args], { cwd: p.dir, env, stdio: ['pipe', 'ignore', 'ignore'] });
    const killer = setTimeout(() => child.kill('SIGKILL'), h.timeoutMs + 5000);
    child.on('exit', () => { clearTimeout(killer); resolve({ ...h, ms: performance.now() - t, stub, brainHome }); });
    child.stdin.end(JSON.stringify(payloadFor(h.event, p.dir)));
  });
}

describe('registered hook handlers stay inside their timeout when ruflo hangs, and say so', () => {
  it('fires every handler in hooks.json concurrently against a 12 s ruflo', async () => {
    expect(handlers.length).toBeGreaterThanOrEqual(10);
    const results = await Promise.all(handlers.map(fire));
    for (const r of results) {
      expect(r.ms, `${r.event} ${r.args.join(' ')} took ${r.ms.toFixed(0)} ms (registered ${r.timeoutMs} ms)`).toBeLessThan(r.timeoutMs);
    }
    const calledRuflo = results.filter((r) => r.stub.calls().length > 0);
    // The lifecycle boundary (Stop turn store, PreCompact/SessionEnd checkpoint, PostToolUse learning) must call ruflo here.
    expect(calledRuflo.map((r) => `${r.event}:${r.args[0]}`)).toEqual(expect.arrayContaining(
      ['Stop:session-snapshot', 'PreCompact:session-snapshot', 'SessionEnd:session-snapshot', 'PostToolUse:session-snapshot']));
    console.log(calledRuflo.map((r) => `${r.event}:${r.args.join(' ')} → ${[...new Set(r.stub.calls().map((c) => c.argv.slice(0, 2).join(' ')))].join(', ')}`).join('\n'));
    // (b) is the memory-WRITE contract (owner ruling): every lifecycle handler that writes through ruflo. Read-only
    // advisory callers (SessionStart restore, ground-ruvnet) disclose in-band or fail open; they are listed above.
    for (const r of calledRuflo.filter((x) => x.args[0] === 'session-snapshot')) {
      expect(await until(() => ledgerRows(r.brainHome).length > 0, 15_000), `${r.event} ${r.args.join(' ')} called ruflo, got no answer, and left no hook-failures row`).toBe(true);
    }
  }, 90_000);
});
