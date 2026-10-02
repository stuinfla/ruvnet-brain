// agentdb-first-e2e.test.mjs — the whole AgentDB-first chain through the REAL dispatch path (ADR-0101):
// hook-shim.mjs ground-ruvnet (UserPromptSubmit) → ground-ruvnet.sh's injection-budget assembler →
// agentdb-recall.mjs → ruflo (a fake that speaks the real JSON shape) against BOTH stores; then
// hook-shim.mjs agentdb-first-gate (Stop) on a transcript that scored without and then with a recall.
// Isolated HOME / RUVNET_BRAIN_HOME / CODEX_HOME; the user's real ~/.claude, ~/.codex, ~/.cache are never read.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeWorld, PLAN, CARD } from '../helpers/agentdb-fake-ruflo.mjs';

const PLUGIN = path.resolve(import.meta.dirname, '../../plugin');
const SHIM = path.join(PLUGIN, 'scripts', 'hook-shim.mjs');

function shim(w, id, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [SHIM, id], { input: JSON.stringify(payload), cwd: w.proj, encoding: 'utf8', timeout: 30_000,
    env: { ...w.env, CLAUDE_PLUGIN_ROOT: PLUGIN, RUVNET_NODE_BIN: process.execPath, RUVNET_BRAIN_METER: '0', ...extraEnv } });
}
const prompt = (text, sid = 'e2e') => ({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: text, cwd: undefined });

describe('UserPromptSubmit: the recall reaches the model through ground-ruvnet', () => {
  it('a score prompt injects a block naming the memory.db-only plan AND the agentdb-memory.db-only scorecard', () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const t0 = Date.now();
    const r = shim(w, 'ground-ruvnet', prompt('score the app against the north star'));
    const ms = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('AgentDB recall (BOTH stores)');
    expect(r.stdout).toContain(PLAN.key);
    expect(r.stdout).toContain(CARD.key);
    expect(r.stdout).toContain(`ruflo memory retrieve -k ${PLAN.key}`);
    expect(ms).toBeLessThan(9000);                       // inside the hook's declared 10 s, with the recall ≤ 2.0 s
    expect(fs.readdirSync(w.proj).sort()).toEqual(['.swarm']);   // nothing planted in the project
    // The same recall in the same session is not re-sent (once-per-session dedupe by content hash).
    const again = shim(w, 'ground-ruvnet', prompt('score the app against the north star'));
    expect(again.stdout).not.toContain('AgentDB recall (BOTH stores)');
  });

  it('an ordinary prompt runs no recall and injects no recall block', () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const r = shim(w, 'ground-ruvnet', prompt('fix the typo in README'));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('AgentDB recall');
    expect(w.calls()).toEqual([]);
  });

  it('ruflo absent → no recall bytes; a project without a store → no recall bytes; opted out → none', () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN] } });
    expect(shim(w, 'ground-ruvnet', prompt('score the app'), { RUFLO_BIN: path.join(w.dir, 'missing-ruflo') }).stdout).not.toContain('AgentDB recall');
    expect(shim(w, 'ground-ruvnet', prompt('score the app', 's2'), { RUVNET_AGENTDB_FIRST: 'off' }).stdout).not.toContain('AgentDB recall');
    const bare = fakeWorld({ stores: {} });
    expect(shim(bare, 'ground-ruvnet', prompt('score the app')).stdout).not.toContain('AgentDB recall');
    expect(bare.calls()).toEqual([]);
  });

  it('a hung ruflo cannot hang the prompt: the hook returns inside its budget with a "timed out" recall', () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const t0 = Date.now();
    const r = shim(w, 'ground-ruvnet', prompt('score the app'), { FAKE_RUFLO_SLEEP_MS: '30000' });
    expect(Date.now() - t0).toBeLessThan(9000);
    expect(r.stdout).toMatch(/timed out/);
  });
});

describe('Stop: a score with no recall is continued once, then passes after a recall', () => {
  const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const bash = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'rows' }] } });
  it('46/100 with no recall → one block; stop_hook_active → silent; after `ruflo memory search` → passes', () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const tp = path.join(w.dir, 'session.jsonl');
    const answer = 'Against the North Star I would score the app **46/100**.';
    fs.writeFileSync(tp, [user('score the app against the north star'), say(answer)].join('\n') + '\n');
    const stop = { hook_event_name: 'Stop', session_id: 'e2e', transcript_path: tp, last_assistant_message: answer, cwd: w.proj };
    const first = shim(w, 'agentdb-first-gate', stop);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toMatch(/score without recalling AgentDB first/);
    expect(shim(w, 'agentdb-first-gate', { ...stop, stop_hook_active: true }).stdout).toBe('');
    // The model obeys: it recalls, then answers again — the same turn now carries the read.
    fs.appendFileSync(tp, [bash('r1', `ruflo memory search --path ${w.swarm}/memory.db -q plan`), result('r1'), say(answer)].join('\n') + '\n');
    expect(shim(w, 'agentdb-first-gate', { ...stop, session_id: 'e2e-2' }).stdout).toBe('');
  });
});
