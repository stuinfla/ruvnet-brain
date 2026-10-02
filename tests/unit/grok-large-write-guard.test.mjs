// grok-large-write-guard.test.mjs — a Grok write larger than the shim's 64 KiB stdin bound is still a write
// (independent review NIT, 2026-10-01).
//
// Grok sends its camelCase envelope FIRST (toolName, toolInput with the whole content) and only then the
// snake_case copies (tool_name, tool_input). The shim keeps the first 65536 bytes of a blocking hook's
// payload, so for a big write the cut lands inside toolInput.content: the JSON no longer parses (no
// normalisation happens) and `tool_name` is gone, and ground-before-write read "not a write" and allowed
// an ungrounded rUv-domain write. Driven through the REAL door: hook-shim.mjs decision-gate write.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHIM = path.resolve(import.meta.dirname, '../../plugin/scripts/hook-shim.mjs');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-big-'));
  fs.mkdirSync(path.join(home, '.claude', 'model-router'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'model-router', 'profile.json'), '{}');
  return home;
}
const grokWrite = (content) => {
  const input = { file_path: '/tmp/grok-big/agentdb-glue.mjs', content };
  return JSON.stringify({ hookEventName: 'pre_tool_use', sessionId: 'g1', toolName: 'write', toolUseId: 't1', toolInput: input,
    toolInputTruncated: false, hook_event_name: 'pre_tool_use', session_id: 'g1', tool_name: 'write', tool_input: input, tool_use_id: 't1' });
};
const gate = (home, payload) => spawnSync(process.execPath, [SHIM, 'decision-gate', 'write'], { input: payload, encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'), RUVNET_DUPLICATE_GATE: 'off' } });

describe.skipIf(!hasBash || process.platform === 'win32')('the write guard recognises a > 64 KiB Grok write', () => {
  it('a small Grok write of ungrounded agentdb code is refused (control)', () => {
    const home = world();
    try {
      const r = gate(home, grokWrite('// agentdb capture glue\nexport const x = 1;\n'));
      expect(r.status, r.stderr).toBe(2);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('the same write with 80 KiB of content (snake_case fields cut off by the bound) is still refused', () => {
    const home = world();
    try {
      const payload = grokWrite(`// agentdb capture glue\n${'const filler = 1;\n'.repeat(80 * 1024 / 18)}`);
      expect(Buffer.byteLength(payload)).toBeGreaterThan(65536 * 2);
      expect(payload.indexOf('"tool_name"')).toBeGreaterThan(65536); // the cut removes it
      const r = gate(home, payload);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
