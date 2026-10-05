import { test, afterAll, describe } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { codeWithoutInertText, projectGroundingInput } from '../../plugin/scripts/grounding-code-projection.mjs';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'issue373-'));
fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
const gate = path.resolve(import.meta.dirname, '../../plugin/scripts/ground-before-write.sh');
const example = '#!/usr/bin/env python3\n"""Consistent application SQLite backup; never access Ruflo/AgentDB memory stores."""\nimport sqlite3\n';
const event = (content, file = '/tmp/backup.py') => ({ tool_name: 'Write', tool_input: { file_path: file, content } });
function run(payload) {
  const out = spawnSync('bash', [gate], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: home, MODEL_ROUTER_PROFILE: path.join(home, '.claude/model-router/profile.json'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUVNET_SKIP_GROUNDING_CHECK: '0' } });
  assert.equal(out.error, undefined); return out;
}
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
describe.skipIf(!hasBash || process.platform === 'win32')('issue373 real guard seams (POSIX)', () => {
test('exact reported unrelated SQLite backup docstring passes the real bash guard', () => {
  assert.equal(run(event(example)).status, 0);
});
test('inert Python function documentation and comments, and JavaScript comments pass', () => {
  for (const payload of [event('def backup():\n    """Never access AgentDB."""\n    # Do not use Ruflo\n    return 1\n'),
    event('// Avoid AgentDB\n/* Ruflo is unrelated */\nexport const answer = 1;\n', '/tmp/app.mjs')]) assert.equal(run(payload).status, 0);
});
test('imports, executable strings, assigned/call-argument triples, interpolation and owned paths still block', () => {
  for (const [content, file] of [
    ['import agentdb\n', '/tmp/backup.py'], ['import { AgentDB } from "agentdb";', '/tmp/app.mjs'],
    ['command = "ruflo memory store"\n', '/tmp/backup.py'], ['query = """agentdb command"""\n', '/tmp/backup.py'],
    ['exec("""import agentdb""")\n', '/tmp/backup.py'], ['f"""agentdb {run()}"""\n', '/tmp/backup.py'],
    [example, '/tmp/agentdb-autocapture.py'], ['const command = `ruflo ${run()}`;', '/tmp/app.mjs'],
  ]) { const out = run(event(content, file)); assert.equal(out.status, 2, content); assert.match(out.stderr, /BLOCKED/); }
});
test('raw SQL against canonical managed memory is not exempted by inert documentation', () => {
  assert.equal(run(event(`${example}\ndb = sqlite3.connect(".swarm/memory.db")\ndb.execute("DELETE FROM memory_entries")\n`)).status, 2);
});
test('malformed/ambiguous source retains strict original scan instead of granting exemption', () => {
  for (const [content, file] of [['"""AgentDB unfinished', '/tmp/app.py'], ['/* AgentDB unfinished', '/tmp/app.mjs'],
    ['const pattern = /agentdb/;', '/tmp/app.mjs'], ['"""AgentDB"""\nexec(__doc__)\n', '/tmp/app.py']]) assert.equal(run(event(content, file)).status, 2);
});
test('inline comment-looking executable strings are retained byte for byte', () => {
  for (const text of ['const script = "// agentdb";', "x = '# agentdb'"]) {
    assert.equal(codeWithoutInertText(text, text.startsWith('x =')), text);
  }
  assert.throws(() => codeWithoutInertText('const nested = `x${`// agentdb`}y`;'));
});
test('missing optional helper retains the original stricter guard', () => {
  const copy = path.join(home, 'standalone-guard.sh'); fs.copyFileSync(gate, copy);
  const out = spawnSync('bash', [copy], { input: JSON.stringify(event(example)), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: home, MODEL_ROUTER_PROFILE: path.join(home, '.claude/model-router/profile.json'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUVNET_SKIP_GROUNDING_CHECK: '0' } });
  assert.equal(out.status, 2); assert.match(out.stderr, /BLOCKED/);
});
test('MultiEdit projects all fragments and preserves an executable product in any edit', () => {
  const payload = { tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/app.py', edits: [
    { old_string: '# AgentDB prohibited', new_string: '# Ruflo prohibited' }, { old_string: 'x = 1', new_string: 'import agentdb' }] } };
  assert.match(projectGroundingInput(JSON.stringify(payload)), /import agentdb/); assert.equal(run(payload).status, 2);
});
test('actual Codex Add File normalization preserves the reported documentation exemption', () => {
  const native = { hook_event_name: 'PreToolUse', cwd: '/tmp', session_id: '373-native', tool_name: 'apply_patch',
    tool_input: `*** Begin Patch\n*** Add File: backup.py\n${example.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` };
  const adapter = path.resolve(import.meta.dirname, '../../plugin/scripts/codex-hook-adapter.mjs');
  const invoke = (payload) => spawnSync(process.execPath, [adapter, 'ground-before-write'], {
    input: JSON.stringify({ ...payload, cwd: home }), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: home, MODEL_ROUTER_PROFILE: path.join(home, '.claude/model-router/profile.json'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUVNET_SKIP_GROUNDING_CHECK: '0', RUVNET_HOOK_HOST: 'codex' } });
  const permitted = invoke(native); assert.equal(permitted.status, 0, permitted.stderr);
  const blocked = invoke({ ...native, tool_input: native.tool_input.replace('+import sqlite3', '+import agentdb') });
  assert.equal(blocked.status, 2); assert.match(blocked.stderr, /BLOCKED/);
});

});
