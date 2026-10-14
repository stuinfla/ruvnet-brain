// grok-hooks-contract.test.mjs — the Grok CLI host registration (plugin/hooks/grok-hooks.json), its
// plugin manifest (plugin/.grok-plugin/plugin.json) and its adapter (plugin/scripts/grok-hook-adapter.mjs).
//
// Host facts come from Grok's own docs (~/.grok/docs/user-guide/10-hooks.md, grok 1.0.50; line numbers
// cited inline) and from payloads captured on a real `grok -p` turn (tests/fixtures/hook-payloads/
// grok-1.0.50/). The round-trip cases drive the REAL door: adapter -> hook-shim.mjs -> the real body.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GROK_BLOCKING_HOOKS, budgetFor, grokOutput, grokToBrainPayload, isSessionEndStop,
} from '../../plugin/scripts/grok-hook-adapter.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PLUGIN = path.join(ROOT, 'plugin');
const ADAPTER = path.join(PLUGIN, 'scripts', 'grok-hook-adapter.mjs');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'hook-payloads', 'grok-1.0.50');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = readJson(path.join(PLUGIN, 'hooks', 'grok-hooks.json'));
const codex = readJson(path.join(PLUGIN, 'hooks', 'codex-hooks.json'));
const fixture = (name) => readJson(path.join(FIXTURES, `${name}.json`)).payload;

// 10-hooks.md:89-105 — the events Grok fires. 10-hooks.md:184 — the only handler fields Grok reads.
const GROK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionDenied', 'Stop', 'StopFailure', 'StopCancelled', 'Notification', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'SessionEnd'];
const GROK_HANDLER_FIELDS = new Set(['type', 'command', 'url', 'timeout', 'env']);
// Registered on Claude and Codex, deliberately not on Grok (reason in grok-hooks.json's description).
const NOT_ON_GROK = new Set(['session-start', 'ground-ruvnet', 'unprompted-speech', 'capacity-aware-parallel-work']);

const COMMAND_RE = /^node "\$\{GROK_PLUGIN_ROOT\}\/scripts\/([\w.-]+\.mjs)" ([a-z][\w-]*)(?: ([A-Za-z]+))?$/;
function registrations(doc) {
  return Object.entries(doc.hooks).flatMap(([event, groups]) => groups.flatMap((group) =>
    group.hooks.map((hook) => ({ event, matcher: group.matcher, hook }))));
}
function shimTable() {
  const src = fs.readFileSync(path.join(PLUGIN, 'scripts', 'hook-shim.mjs'), 'utf8');
  const table = {};
  for (const m of src.matchAll(/'([\w-]+)':\s*{\s*file:\s*'([\w.-]+)'[^}]*mode:\s*'(\w+)'/g)) table[m[1]] = { file: m[2], mode: m[3] };
  return table;
}
const codexKey = (r) => { const m = /"\s+\d+\s+([a-z][\w-]*)(?: ([A-Za-z]+))?$/.exec(r.hook.command); return `${r.event}|${m[1]}|${m[2] || ''}`; };
const grokKey = (r) => { const m = COMMAND_RE.exec(r.hook.command); return `${r.event}|${m[2]}|${m[3] || ''}`; };

describe('grok-hooks.json — manifest schema (Grok hook JSON format, 10-hooks.md:134-166)', () => {
  it('has only documented events, command handlers, Grok-read fields and positive timeouts', () => {
    expect(Object.keys(manifest).sort()).toEqual(['description', 'hooks']);
    for (const [event, groups] of Object.entries(manifest.hooks)) {
      expect(GROK_EVENTS, event).toContain(event);
      expect(Array.isArray(groups)).toBe(true);
      for (const group of groups) {
        // "A matcher on Stop or UserPromptSubmit is ignored with a warning" (10-hooks.md:163).
        if (['Stop', 'UserPromptSubmit'].includes(event)) expect(group.matcher, event).toBeUndefined();
        if (group.matcher !== undefined) expect(typeof group.matcher).toBe('string');
        for (const hook of group.hooks) {
          for (const key of Object.keys(hook)) expect(GROK_HANDLER_FIELDS.has(key), `${event} handler field ${key}`).toBe(true);
          expect(hook.type).toBe('command');
          expect(Number.isFinite(hook.timeout) && hook.timeout > 0).toBe(true);
          expect(hook.command, hook.command).toMatch(COMMAND_RE);
        }
      }
    }
  });

  it('every referenced script exists and every hook id is a hook-shim dispatch id', () => {
    const table = shimTable();
    for (const r of registrations(manifest)) {
      const [, script, id] = COMMAND_RE.exec(r.hook.command);
      expect(fs.existsSync(path.join(PLUGIN, 'scripts', script)), script).toBe(true);
      expect(table[id], id).toBeTruthy();
      expect(fs.existsSync(path.join(PLUGIN, 'scripts', table[id].file)), table[id].file).toBe(true);
    }
  });

  it('mirrors the Codex registrations exactly, minus the declared not-on-Grok set', () => {
    const grokKeys = new Set(registrations(manifest).map(grokKey));
    const codexKeys = new Set(registrations(codex).map(codexKey));
    for (const key of grokKeys) expect(codexKeys.has(key), `${key} is not a Codex registration`).toBe(true);
    for (const key of codexKeys) {
      const id = key.split('|')[1];
      expect(grokKeys.has(key) || NOT_ON_GROK.has(id), `${key} missing on Grok with no declared reason`).toBe(true);
    }
    for (const id of NOT_ON_GROK) expect(manifest.description).toContain(id);
  });

  it('gives the adapter a kill budget below each registration timeout, and refusal power only to decision-gate', () => {
    const table = shimTable();
    for (const r of registrations(manifest)) {
      const [, , id] = COMMAND_RE.exec(r.hook.command);
      expect(budgetFor(id, r.event), `${r.event} ${id}`).toBeLessThan(r.hook.timeout * 1000);
    }
    for (const id of GROK_BLOCKING_HOOKS) expect(table[id].mode).toBe('blocking');
    expect([...GROK_BLOCKING_HOOKS]).toEqual(['decision-gate']);
  });

  it('the write matcher selects the measured Grok write tool and Claude names, and nothing else', () => {
    const [group] = manifest.hooks.PreToolUse;
    const re = new RegExp(group.matcher);
    expect(re.test(fixture('PreToolUse-write').toolName)).toBe(true); // search_replace, measured
    for (const name of ['write', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(re.test(name), name).toBe(true);
    for (const name of [fixture('PreToolUse-bash').toolName, 'read_file', 'search_replace_x']) expect(re.test(name), name).toBe(false);
  });
});

describe('the Grok plugin manifest and host adapter descriptor', () => {
  it('.grok-plugin/plugin.json selects grok-hooks.json and keeps the skills and MCP server', () => {
    const plugin = readJson(path.join(PLUGIN, '.grok-plugin', 'plugin.json'));
    expect(plugin.name).toBe(readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json')).name);
    expect(plugin.hooks).toBe('./hooks/grok-hooks.json');
    for (const key of ['hooks', 'mcpServers', 'skills']) expect(fs.existsSync(path.join(PLUGIN, plugin[key])), key).toBe(true);
  });

  it('host-adapters/grok.json names tracked files only', () => {
    const adapter = readJson(path.join(PLUGIN, 'host-adapters', 'grok.json'));
    expect(adapter).toMatchObject({ schemaVersion: 1, kind: 'ruvnet-brain-host-adapter', id: 'grok' });
    for (const key of ['manifest', 'hooks', 'loader']) expect(fs.existsSync(path.join(ROOT, adapter[key])), key).toBe(true);
  });
});

describe('payload normalization on real grok 1.0.50 payloads', () => {
  it('maps search_replace to the Edit shape every write policy reads', () => {
    const p = grokToBrainPayload(fixture('PreToolUse-write'));
    expect(p).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Edit', host_tool_name: 'search_replace', host: 'grok' });
    expect(p.tool_input.file_path).toMatch(/probe\.txt$/);
  });

  it('gives Stop the snake_case fields the bodies read and withholds the foreign transcript', () => {
    const raw = fixture('Stop');
    expect(raw.last_assistant_message).toBeUndefined(); // measured: Grok sends only the camelCase copy
    const p = grokToBrainPayload(raw);
    expect(p).toMatchObject({ stop_hook_active: false, last_assistant_message: raw.lastAssistantMessage, prompt_id: raw.promptId });
    expect(p.transcript_path).toBeUndefined();
    expect(p.transcriptPath).toBeUndefined();
    expect(grokToBrainPayload(fixture('Stop-continued')).stop_hook_active).toBe(true);
  });

  it('recognises the session-end Stop fire (reason shutdown) and only that', () => {
    expect(isSessionEndStop(grokToBrainPayload(fixture('Stop-shutdown')))).toBe(true);
    expect(isSessionEndStop(grokToBrainPayload(fixture('Stop')))).toBe(false);
    expect(isSessionEndStop(grokToBrainPayload(fixture('SessionEnd')))).toBe(false);
  });
});

describe('output envelope (10-hooks.md:310-391, :531)', () => {
  it('PreToolUse: a decision-gate exit 2 is a deny with a stderr reason; no other id can refuse', () => {
    expect(grokOutput({ hookId: 'decision-gate', event: 'PreToolUse', status: 2, stderr: 'BLOCKED: x\n' }))
      .toEqual({ stdout: '', stderr: 'BLOCKED: x\n', code: 2 });
    expect(grokOutput({ hookId: 'decision-gate', event: 'PreToolUse', status: 2, stderr: '' }).stderr).not.toBe('');
    expect(grokOutput({ hookId: 'session-snapshot', event: 'PreToolUse', status: 2, stderr: 'x' }).code).toBe(0);
    expect(grokOutput({ hookId: 'decision-gate', event: 'PreToolUse', status: 1, stderr: 'crash' }).code).toBe(0);
  });

  it('PostToolUse prose becomes additionalContext; JSON passes through', () => {
    const prose = grokOutput({ hookId: 'grounding-stamp', event: 'PostToolUse', status: 0, stdout: 'stamped\n' });
    expect(JSON.parse(prose.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'stamped' } });
    const json = '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"a"}}';
    expect(grokOutput({ hookId: 'session-snapshot', event: 'PostToolUse', status: 0, stdout: json }).stdout).toBe(json);
  });

  it('Stop keeps the Claude decision vocabulary and drops prose', () => {
    const block = '{"decision":"block","reason":"verify first"}';
    expect(grokOutput({ hookId: 'continuation-gate', event: 'Stop', status: 0, stdout: block })).toEqual({ stdout: block, stderr: '', code: 0 });
    expect(grokOutput({ hookId: 'continuation-gate', event: 'Stop', status: 0, stdout: 'note' }).stdout).toBe('');
  });

  it.each(['SessionStart', 'UserPromptSubmit', 'PreCompact', 'SessionEnd'])('%s writes no stdout (Grok ignores it)', (event) => {
    expect(grokOutput({ hookId: 'session-snapshot', event, status: 0, stdout: '{"hookSpecificOutput":{}}' }))
      .toEqual({ stdout: '', stderr: '', code: 0 });
  });
});

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
describe.skipIf(!hasBash || process.platform === 'win32')('stdin round trip through the real adapter and hook-shim', () => {
  function world() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hooks-'));
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'model-router', 'profile.json'), '{}');
    return { home, cwd };
  }
  const run = ({ home, cwd }, args, payload) => spawnSync(process.execPath, [ADAPTER, ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000, cwd,
    env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'), RUVNET_DUPLICATE_GATE: 'off',
      RUVNET_TURN_CAPTURE: 'off', GROK_PLUGIN_ROOT: PLUGIN },
  });
  // The captured Grok search_replace payload, retargeted at an ungrounded rUv-product file.
  const grokWrite = (cwd, file, content) => {
    const base = fixture('PreToolUse-write');
    const toolInput = { file_path: path.join(cwd, file), old_string: '', new_string: content };
    return { ...base, cwd, workspaceRoot: `${cwd}/`, toolInput, tool_input: toolInput };
  };

  it('refuses an ungrounded rUv-product write with exit 2 and a reason (Grok deny)', () => {
    const w = world();
    try {
      const r = run(w, ['decision-gate', 'write'], grokWrite(w.cwd, 'agentdb-glue.mjs', '// agentdb capture glue\nexport const x = 1;\n'));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr.split('\n')[0].trim().length).toBeGreaterThan(0);
    } finally { fs.rmSync(w.home, { recursive: true, force: true }); }
  });

  it('the manifest\'s own command string, run as Grok runs it (sh -c, 10-hooks.md:189), refuses the same write', () => {
    const w = world();
    try {
      const { hook } = registrations(manifest).find((r) => r.event === 'PreToolUse');
      const r = spawnSync('sh', ['-c', hook.command], {
        input: JSON.stringify(grokWrite(w.cwd, 'agentdb-glue.mjs', '// agentdb capture glue\nexport const x = 1;\n')),
        encoding: 'utf8', timeout: hook.timeout * 1000, cwd: w.cwd,
        env: { ...process.env, HOME: w.home, RUVNET_BRAIN_HOME: path.join(w.home, '.cache', 'ruvnet-brain'),
          RUVNET_BRAIN_STATE_DIR: path.join(w.home, '.config', 'ruvnet-brain'), RUVNET_DUPLICATE_GATE: 'off', GROK_PLUGIN_ROOT: PLUGIN },
      });
      expect(r.status, r.stderr).toBe(2);
    } finally { fs.rmSync(w.home, { recursive: true, force: true }); }
  });

  it('allows an ordinary write silently (exit 0, nothing Grok would misread)', () => {
    const w = world();
    try {
      const r = run(w, ['decision-gate', 'write'], grokWrite(w.cwd, 'notes.txt', 'hi\n'));
      expect(r.status, r.stderr).toBe(0);
      if (r.stdout.trim()) expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally { fs.rmSync(w.home, { recursive: true, force: true }); }
  });

  it('runs nothing for the session-end Stop fire and writes nothing', () => {
    const w = world();
    try {
      const payload = { ...fixture('Stop-shutdown'), cwd: w.cwd };
      const r = run(w, ['continuation-gate'], payload);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(fs.existsSync(path.join(w.home, '.cache', 'ruvnet-brain'))).toBe(false);
    } finally { fs.rmSync(w.home, { recursive: true, force: true }); }
  });

  it.each([['SessionEnd', ['session-snapshot', 'SessionEnd']], ['UserPromptSubmit', ['grounding-turn-mark']]])(
    'a real %s payload exits 0 with no stdout', (name, args) => {
      const w = world();
      try {
        const r = run(w, args, { ...fixture(name), cwd: w.cwd });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toBe('');
      } finally { fs.rmSync(w.home, { recursive: true, force: true }); }
    });
});
