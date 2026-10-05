import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preToolUseEnvelope } from '../../plugin/scripts/hook-input.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const scripts = path.join(root, 'plugin', 'scripts');
const homes = [];
afterEach(() => homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true })));

function fire(entry, command, boundary = 'advise') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hijack-no-defer-'));
  homes.push(home);
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ version: 1, settings: { managedMemoryBoundary: boundary } }));
  return spawnSync(entry === 'direct' ? 'bash' : process.execPath,
    entry === 'direct' ? [path.join(scripts, 'hijack-ruvnet.sh')]
      : [path.join(scripts, 'hook-shim.mjs'), 'hijack-ruvnet'], {
      cwd: home,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'advisory-test' }),
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home,
        CLAUDE_PLUGIN_ROOT: path.join(root, 'plugin'), RUVNET_BRAIN_HOME: path.join(home, 'brain'),
        RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUVNET_SETTINGS_FILE: settings },
    });
}

describe('#326 advisory envelopes leave permission policy to the host', () => {
  it.each([undefined, null, ''])('omits an absent decision: %j', (decision) => {
    const envelope = JSON.parse(preToolUseEnvelope(decision, 'advisory "quoted"\n測'));
    expect(envelope.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: 'advisory "quoted"\n測' });
    expect(envelope.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });
  it.each(['allow', 'deny', 'ask', 'defer'])('preserves an explicit %s decision for other callers', (decision) => {
    expect(JSON.parse(preToolUseEnvelope(decision, 'context')).hookSpecificOutput)
      .toEqual({ hookEventName: 'PreToolUse', permissionDecision: decision, additionalContext: 'context' });
  });
  it('the real emitter CLI does not replace an empty decision with defer or allow', () => {
    const result = spawnSync(process.execPath, [path.join(scripts, 'hook-input.mjs'), 'emit', '', 'literal context'], {
      input: '', encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput)
      .toEqual({ hookEventName: 'PreToolUse', additionalContext: 'literal context' });
  });
});

// These subprocess cases require Bash, the same supported interpreter used by hook-shim.
// A missing interpreter is a reported prerequisite failure, never a skipped passing case.
describe('#326 explicit legacy CLI is advisory; automatic registration remains retired', () => {
  for (const entry of ['direct', 'shim']) {
    it.each([
      ['qdrant', 'RuVector'],
      ['openai_new_embedding_call', 'local ONNX embeddings'],
      ['cohere_new_embed_call', 'local ONNX embeddings'],
    ])(`${entry} emits guidance without a decision for %s`, (command, guidance) => {
      const result = fire(entry, command);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      expect(output.hookEventName).toBe('PreToolUse');
      expect(output.additionalContext).toContain(guidance);
      expect(output).not.toHaveProperty('permissionDecision');
    });
    it.each(['echo harmless', "ruflo memory search 'sqlite3 memory'"])(`${entry} remains silent for %s`, (command) => {
      const result = fire(entry, command);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toBe('');
    });
    it(`${entry} preserves the explicit managed-memory refusal`, () => {
      const result = fire(entry, "sqlite3 .swarm/memory.db 'DELETE FROM memory_entries'", 'read-only');
      expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/ruflo memory (store|search)/);
      expect(result.stdout).toBe('');
    });
  }
  it('does not add a direct automatic hijack registration in either host', () => {
    for (const filename of ['hooks.json', 'codex-hooks.json']) {
      const hooks = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'hooks', filename), 'utf8')).hooks;
      const commands = Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks ?? []))
        .map((hook) => hook.command ?? '');
      expect(commands.some((command) => /(?:hijack-ruvnet|hijack-ruvnet\.sh)/.test(command))).toBe(false);
    }
  });
});
