// #423: the Stop gate reads a Codex rollout through the shared nativeTurnLines reader, so an observed,
// scoped check on Codex is judged like the same check on Claude — and missing, failed, stale,
// overlapping or unsupported evidence still cannot establish one. Driven through the REAL gate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeTurn, auditCompletionClaims } from '../../plugin/scripts/completion-claim-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
let dir; let home;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codex-')); home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, 'caps'), { recursive: true }); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function repo() {
  const d = path.join(dir, 'repo'); fs.mkdirSync(d, { recursive: true });
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/example/a.git']]) spawnSync('git', args, { cwd: d });
  return fs.realpathSync(d);
}
let turnSeq = 0;
function fire(cwd, message, transcriptPath, host = 'codex') {
  const r = spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', cwd, session_id: 'cx1', turn_id: `t${++turnSeq}`, prompt_id: `t${turnSeq}`, stop_hook_active: false, last_assistant_message: message,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_HOOK_HOST: host, RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'),
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(home, 'none.json'),
      RUVNET_CAPABILITY_ROOTS: path.join(home, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(home, 'live.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(home, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1' } });
  expect(r.status).toBe(0);
  return r.stdout;
}

const ev = (payload) => JSON.stringify({ type: 'event_msg', payload });
const ri = (payload) => JSON.stringify({ type: 'response_item', payload });
const user = ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please fix the updater' }] });
const patch = (start, end) => ev({ type: 'item_completed', started_at_ms: start, completed_at_ms: end,
  item: { type: 'FileChange', id: `fc-${start}`, status: 'completed', stdout: 'Success. Updated the following files' } });
const run = (start, end, { command = 'npx vitest run tests/unit/updater.test.mjs', exit = 0, out = 'Tests  5 passed (5)' } = {}) => ev({ type: 'item_completed',
  started_at_ms: start, completed_at_ms: end, item: { type: 'CommandExecution', id: `ce-${start}`, command: ['/bin/zsh', '-lc', command],
    status: exit === 0 ? 'completed' : 'failed', exit_code: exit, aggregated_output: out } });
const rollout = (...lines) => { const f = path.join(dir, `rollout-${Math.random().toString(16).slice(2)}.jsonl`); fs.writeFileSync(f, `${lines.join('\n')}\n`); return f; };

const SCOPED = 'Targeted unit tests are passing.\nVerified: npx vitest run tests/unit/updater.test.mjs — 5 passed.\nNot verified: the complete consumer path.';
const UNPARSED = 'transcript is unavailable or not parsed';

describe('Codex completion audit reads the native rollout (#423)', () => {
  it('accepts a scoped claim backed by a native exit-0 check after the last change', () => {
    const t = rollout(user, patch(100, 110), run(200, 300));
    expect(fire(repo(), SCOPED, t)).toBe('');
    expect(auditCompletionClaims(SCOPED, { turn: readClaudeTurn(t, { host: 'codex' }), host: 'codex' }).verdict).toBe('OBSERVED_CHECK');
  });
  it('the same scoped claim is still corrected when the evidence does not qualify', () => {
    const r = repo();
    expect(fire(r, SCOPED, rollout(user, patch(100, 110), run(200, 300, { exit: 1, out: 'FAIL 1' })))).toContain('no end-to-end check ran this turn after the last change');
    expect(fire(r, SCOPED, rollout(user, run(50, 90), patch(100, 110)))).toContain('no end-to-end check ran this turn after the last change');
    // Completion order hides overlap: the check started before the patch finished, so it proves nothing.
    expect(fire(r, SCOPED, rollout(user, patch(100, 250), run(200, 300)))).toContain('no end-to-end check');
    // An unsupported native tool after the check is a change boundary.
    expect(fire(r, SCOPED, rollout(user, patch(100, 110), run(200, 300),
      ri({ type: 'function_call', name: 'spawn_agent', call_id: 'sa', arguments: '{}' })))).toContain('no end-to-end check');
    // No current-turn boundary, or no transcript at all, stays UNKNOWN.
    expect(fire(r, SCOPED, rollout(patch(100, 110), run(200, 300)))).toContain(UNPARSED);
    expect(fire(r, SCOPED)).toContain(UNPARSED);
  });
  it('legacy exec_command records need an explicit exit 0', () => {
    const call = ri({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'npx vitest run tests/unit/updater.test.mjs' }) });
    const output = (text) => ri({ type: 'function_call_output', call_id: 'c1', output: text });
    const r = repo();
    expect(fire(r, SCOPED, rollout(user, patch(100, 110), call, output('Process exited with code 0\nOutput:\nTests  5 passed (5)')))).toBe('');
    expect(fire(r, SCOPED, rollout(user, patch(100, 110), call, output('Tests  5 passed (5)')))).toContain('no end-to-end check');
  });
  it('Claude transcripts are judged exactly as before', () => {
    const rec = (type, content) => JSON.stringify({ type, message: { role: type, content } });
    const t = rollout(rec('user', 'go'), rec('assistant', [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/r/a.mjs' } }]),
      rec('user', [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }]),
      rec('assistant', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npx vitest run tests/unit/updater.test.mjs' } }]),
      rec('user', [{ type: 'tool_result', tool_use_id: 'b', content: 'Tests  5 passed (5)' }]));
    expect(fire(repo(), SCOPED, t, 'claude')).toBe('');
  });
});

// Review fix (4.7.21): a Codex read-only/observation tool after the check is not a change. Names grounded in
// codex-cli 0.164.0 (its tool handlers: view_image, plan/update_plan, tool_search, mcp_resource/*, current_time,
// get_context_remaining, wait_for_environment, multi_agents/wait) and in real rollouts on the owner's Mac
// (`wait` with a cell_id, `wait_agent`/`list_agents` under the `collaboration` namespace).
describe('Codex read-only tools are not change boundaries', () => {
  const call = (name, args = {}, namespace) => ri({ type: 'function_call', name, ...(namespace ? { namespace } : {}), call_id: `ro-${name}`, arguments: JSON.stringify(args) });
  const verdictAfter = (...extra) => auditCompletionClaims(SCOPED, { turn: readClaudeTurn(rollout(user, patch(100, 110), run(200, 300), ...extra), { host: 'codex' }), host: 'codex' }).verdict;
  it.each([
    ['view_image', { path: '/tmp/a.png' }], ['update_plan', { plan: [] }], ['tool_search', { query: 'x' }],
    ['list_mcp_resources', {}], ['list_mcp_resource_templates', {}], ['read_mcp_resource', { server: 's', uri: 'u' }],
    ['web_search', { query: 'x' }], ['current_time', {}], ['get_context_remaining', {}], ['wait_for_environment', {}],
    ['wait', { cell_id: '32', yield_time_ms: 1000 }], ['wait_agent', { timeout_ms: 60000 }, 'collaboration'],
  ])('%s after the check keeps the observed check', (name, args, ns) => {
    expect(verdictAfter(call(name, args, ns))).toBe('OBSERVED_CHECK');
  });
  it('an unknown or acting tool after the check is still a change (fail toward asking)', () => {
    for (const [name, ns] of [['js', 'mcp__cua_repl'], ['send_message', 'collaboration'], ['some_future_tool', undefined]]) {
      expect(verdictAfter(call(name, {}, ns))).not.toBe('OBSERVED_CHECK');
    }
  });
  it('through the real gate: a tool search and an agent wait after the check raise no correction', () => {
    expect(fire(repo(), SCOPED, rollout(user, patch(100, 110), run(200, 300), call('tool_search', { query: 'x' }), call('wait_agent', { timeout_ms: 1 }, 'collaboration')))).toBe('');
  });
});

// Cross-vendor review D (4.7.21): a Codex MCP call can complete as a transport while the tool itself failed
// (CallToolResult.isError). A failed run_tests must never count as the observed check.
describe('a Codex MCP tool failure is a failure even when the call completed', () => {
  const SCOPED_MCP = 'Targeted unit tests are passing.\nVerified: run_tests — 5 passed.\nNot verified: the complete consumer path.';
  const mcp = (start, end, result, status = 'completed') => ev({ type: 'item_completed', started_at_ms: start, completed_at_ms: end,
    item: { type: 'McpToolCall', id: `mcp-${start}`, server: 'qa', tool: 'run_tests', status, result } });
  const audit = (...lines) => auditCompletionClaims(SCOPED_MCP, { turn: readClaudeTurn(rollout(user, patch(100, 110), ...lines), { host: 'codex' }), host: 'codex' });
  it('completed + isError:true is not a passing check', () => {
    const v = audit(mcp(200, 300, { content: [{ type: 'text', text: '3 failed' }], isError: true }));
    expect(v.verification.checks).toEqual([]);
    expect(v.verdict).not.toBe('OBSERVED_CHECK');
  });
  it('completed + isError:false still counts as the observed check', () => {
    expect(audit(mcp(200, 300, { content: [{ type: 'text', text: '5 passed' }], isError: false })).verdict).toBe('OBSERVED_CHECK');
  });
});

// Review r2 (4.7.21, GPT-6.1): one itemized tool anywhere used to make EVERY code-mode `exec` wrapper vanish, so an
// opaque acting exec after the check kept OBSERVED_CHECK. Only an exec whose call/output bracket holds native items
// (the shape Codex writes) is dropped; any other exec after the check is a possible change.
describe('opaque Codex exec wrappers after the check are changes', () => {
  const execCall = (id, script = 'await tools.apply_patch({input: "..."})') => ri({ type: 'custom_tool_call', status: 'completed', call_id: id, name: 'exec', input: script });
  const execOut = (id) => ri({ type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }] });
  const verdict = (...lines) => auditCompletionClaims(SCOPED, { turn: readClaudeTurn(rollout(user, ...lines), { host: 'codex' }), host: 'codex' }).verdict;
  it('an exec with no native item inside its bracket, after the check, is a change', () => {
    expect(verdict(patch(100, 110), run(200, 300), execCall('x1'), execOut('x1'))).not.toBe('OBSERVED_CHECK');
  });
  it('an exec still running (no output yet) after the check is a change', () => {
    expect(verdict(patch(100, 110), run(200, 300), execCall('x2'))).not.toBe('OBSERVED_CHECK');
  });
  it('an exec whose bracket holds the native check item keeps the observed check', () => {
    expect(verdict(patch(100, 110), execCall('x3', 'await tools.exec_command({cmd: "npx vitest run"})'), run(200, 300), execOut('x3'))).toBe('OBSERVED_CHECK');
  });
  it('a paired exec that patched after the check is judged by its native items: a change', () => {
    expect(verdict(patch(100, 110), run(200, 300), execCall('x4'), patch(400, 410), execOut('x4'))).not.toBe('OBSERVED_CHECK');
  });
  it('through the real gate: an opaque exec after the check is corrected', () => {
    expect(fire(repo(), SCOPED, rollout(user, patch(100, 110), run(200, 300), execCall('x5'), execOut('x5')))).toContain('no end-to-end check');
  });
});
