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
test('leading Python module documentation and JavaScript comments pass', () => {
  for (const payload of [event('# SQLite helper\n"""Never access AgentDB."""\nimport sqlite3\n'),
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
test('split managed-store paths and table indicators retain strict guard and Add File scanning', () => {
  for (const body of [
    'db = sqlite3.connect(str(Path(".swarm") / "memory.db"))\ndb.execute("DELETE FROM memory_entries")\n',
    'db = sqlite3.connect("memory.db")\n',
    'db.execute("DELETE FROM memory_entries")\n',
    'directory = Path(".swarm")\n',
  ]) {
    const source = '"""AgentDB memory is managed."""\nimport sqlite3\nfrom pathlib import Path\n' + body;
    assert.throws(() => projectGroundingInput(JSON.stringify(event(source))), /Managed memory/);
    assert.equal(run(event(source)).status, 2, body);
    assert.equal(invokeAddFile(source).status, 2, body);
  }
});
test('ordinary application SQLite with inert product documentation still passes both paths', () => {
  const source = example + '\ndb = sqlite3.connect(str(Path("app-data") / "orders.db"))\ndb.execute("DELETE FROM orders WHERE expired = 1")\n';
  assert.equal(run(event(source)).status, 0);
  assert.equal(invokeAddFile(source).status, 0);
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
  assert.equal(run(event('// harmless\u2028import agentdb;', '/tmp/app.mjs')).status, 2);
});
test('missing optional helper retains the original stricter guard', () => {
  const copy = path.join(home, 'standalone-guard.sh'); fs.copyFileSync(gate, copy);
  const out = spawnSync('bash', [copy], { input: JSON.stringify(event(example)), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: home, MODEL_ROUTER_PROFILE: path.join(home, '.claude/model-router/profile.json'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUVNET_SKIP_GROUNDING_CHECK: '0' } });
  assert.equal(out.status, 2); assert.match(out.stderr, /BLOCKED/);
});
test('MultiEdit retains strict scanning because fragments lack enclosing context', () => {
  const payload = { tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/app.py', edits: [
    { old_string: '# AgentDB prohibited', new_string: '# Ruflo prohibited' }, { old_string: 'x = 1', new_string: 'import agentdb' }] } };
  assert.throws(() => projectGroundingInput(JSON.stringify(payload)), /context/); assert.equal(run(payload).status, 2);
});

const executableContexts = [
  'import importlib\nx = importlib.import_module(\n    """agentdb"""\n)\n',
  'x = [\n    """agentdb"""\n]\n',
  'x = (\n    """agentdb"""\n)\n',
  'x = {\n    """agentdb""": 1\n}\n',
  'x = lambda: (\n    """agentdb"""\n)\n',
  'if True:\n    use(\n        """agentdb"""\n    )\n',
  'def helper():\n    """agentdb"""\n    return 1\n',
  'x = ' + String.fromCharCode(92) + '\n    """agentdb"""\n',
  '# coding: utf-7\n#+AAo-import agentdb\n',
  '# coding: unknown\n# agentdb\n',
  '# harmless\rimport agentdb\r',
];
function invokeAddFile(content) {
  const adapter = path.resolve(import.meta.dirname, '../../plugin/scripts/codex-hook-adapter.mjs');
  const payload = { hook_event_name: 'PreToolUse', cwd: home, session_id: '373-regression', tool_name: 'apply_patch',
    tool_input: `*** Begin Patch\n*** Add File: backup.py\n${content.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` };
  return spawnSync(process.execPath, [adapter, 'ground-before-write'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: home, MODEL_ROUTER_PROFILE: path.join(home, '.claude/model-router/profile.json'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUVNET_SKIP_GROUNDING_CHECK: '0', RUVNET_HOOK_HOST: 'codex' } });
}
test('expression, continuation and encoding regressions block through real guard and native Add File', () => {
  for (const source of executableContexts) {
    assert.equal(run(event(source)).status, 2, source);
    const native = invokeAddFile(source); assert.equal(native.status, 2, source + native.stderr);
  }
});
test('isolated Edit and MultiEdit cannot exempt literals used by an enclosing call', () => {
  for (const tool of ['Edit', 'MultiEdit']) {
    const edit = { old_string: '"old_module"', new_string: '"""agentdb"""' };
    const payload = { tool_name: tool, tool_input: { file_path: '/tmp/app.py', ...(tool === 'Edit' ? edit : { edits: [edit] }) } };
    assert.throws(() => projectGroundingInput(JSON.stringify(payload)), /context/);
    assert.equal(run(payload).status, 2);
  }
});
test('UTF-7 witness compiles to an import without executing the import', () => {
  const probe = spawnSync('python3', ['-c', 'import json; source = b"# coding: utf-7\\n#+AAo-import agentdb\\n"; print(json.dumps(compile(source, "<encoding-witness>", "exec").co_names))'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return;
  assert.equal(probe.status, 0, probe.stderr); assert.deepEqual(JSON.parse(probe.stdout), ['agentdb']);
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
