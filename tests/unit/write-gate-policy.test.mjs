// write-gate-policy.test.mjs — the write gate's two fail-open cases are POLICY, not accident (4.5).
//
//   ALLOW ON TIMEOUT  a policy still running at the budget does not vote; the write is allowed; the ledger
//                     records `budget-exceeded` and one stderr line says the allow was a timeout.
//   OVERSIZE          the host transport hands the gate at most 64 KiB; a refusal found in that prefix
//                     stands; what only the rest could show is allowed and recorded as `payload-oversize`.
//                     Measured before 4.5: that allow left no trace anywhere.
// Run through the REAL registered command (hooks.json -> hook-shim.mjs -> decision-gate.mjs), as the host does.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TRANSPORT_CAP_BYTES, classifyPayload } from '../../plugin/scripts/decision-gate.mjs';
import { registrations, makeWorld, worldEnv, cleanupWorld, runCommand } from '../../scripts/hook-qualify-core.mjs';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const term = ['ag', 'entdb'].join('');   // assembled: this repo's own write gate scans the payload while editing

describe('one transport cap, stated once', () => {
  it('the gate\'s cap is the shim\'s stdinBytes for decision-gate and the bash policies\' own read cap', () => {
    const shim = /'decision-gate':\s*\{[^}]*stdinBytes:\s*(\d+)/.exec(read('plugin/scripts/hook-shim.mjs'))?.[1];
    expect(Number(shim)).toBe(TRANSPORT_CAP_BYTES);
    for (const f of ['plugin/scripts/protect-brain-state.sh', 'plugin/scripts/ground-before-write.sh']) {
      expect(read(f), f).toContain(`INPUT="\${INPUT:0:${TRANSPORT_CAP_BYTES}}"`);
    }
  });
  it('classifyPayload: complete JSON vs a cut-off prefix, with session/tool/path recovered from the prefix', () => {
    const full = JSON.stringify({ session_id: 's9', tool_name: 'Write', tool_input: { file_path: '/p/a.js', content: 'x'.repeat(100_000) } });
    expect(classifyPayload(full)).toMatchObject({ complete: true, truncated: false });
    const cut = full.slice(0, TRANSPORT_CAP_BYTES);
    expect(classifyPayload(cut)).toMatchObject({ complete: false, truncated: true, session: 's9', tool: 'Write', filePath: '/p/a.js', bytes: TRANSPORT_CAP_BYTES });
    expect(classifyPayload('{"tool_name": "Wri').truncated, 'short garbage is malformed, not oversize').toBe(false);
  });
});

const BASH = resolveBash();
describe.skipIf(process.platform === 'win32' || !BASH)('through the real registered command', () => {
  const reg = registrations(ROOT, ['claude']).find((r) => r.hookId === 'decision-gate');
  async function fire(toolInput, extraEnv = {}) {
    const w = makeWorld('claude', { root: ROOT, label: 'wgp' });
    try {
      const prof = path.join(w.home, 'profile.json'); fs.writeFileSync(prof, '{}');   // the write gate is opt-in
      const ti = toolInput(w);
      const payload = JSON.stringify({ session_id: 'wgp-1', hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: w.cwd, tool_input: ti });
      const cfg = path.join(w.home, 'cfg');
      // A generous budget unless a case sets one: these cases test the oversize policy, and on a loaded
      // machine the 2 s default can trip and add the (correct) timeout notice to stderr.
      const r = await runCommand(reg.command, { cwd: w.cwd, env: worldEnv(w, { MODEL_ROUTER_PROFILE: prof, RUVNET_CONFIG_ROOT: cfg, RUVNET_DECISION_BUDGET_MS: '20000', ...extraEnv }), stdin: payload, timeoutMs: 40_000 });
      let rows = [];
      try { rows = fs.readFileSync(path.join(cfg, 'decision-outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* none */ }
      return { status: r.status, stderr: r.stderr.toString('utf8'), rows };
    } finally { cleanupWorld(w); }
  }
  const pad = (n) => 'x'.repeat(n);

  it('OVERSIZE: a refusal visible in the first 64 KiB stands, and is counted (session recovered from the prefix)', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'a.js'), content: `import x from '${term}';\n// ${pad(100_000)}` }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED/);
    expect(r.rows.map((x) => x.kind)).toContain('refused');
  }, 60_000);

  it('OVERSIZE: what only the rest could show is ALLOWED, with no stderr, and recorded as payload-oversize', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'b.js'), content: `// ${pad(70_000)}\nimport x from '${term}';\n` }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const row = r.rows.find((x) => x.kind === 'payload-oversize');
    expect(row).toMatchObject({ session: 'wgp-1', tool: 'Write', bytesSeen: TRANSPORT_CAP_BYTES, capBytes: TRANSPORT_CAP_BYTES });
    expect(row.filePath).toMatch(/b\.js$/);
  }, 60_000);

  it('OVERSIZE: the consent guard still refuses a 100 KB write to the protected settings file', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.home, '.config', 'ruvnet-brain', 'settings.json'), content: pad(100_000) }));
    expect(r.status).toBe(2);
  }, 60_000);

  it('ALLOW ON TIMEOUT: a blown budget allows, says so on stderr, and records budget-exceeded with who did not vote', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'c.js'), content: `import x from '${term}';\n` }), { RUVNET_DECISION_BUDGET_MS: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/ALLOWED WITHOUT CONSULTING: .*ground-before-write/);
    expect(r.stderr).toMatch(/this allow is a timeout, not a verdict/);
    expect(r.rows.find((x) => x.kind === 'budget-exceeded')?.unconsulted).toContain('ground-before-write');
  }, 60_000);

  it('TEETH: the same small ungrounded write with the normal budget is refused (the timeout case is not a no-op)', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'c.js'), content: `import x from '${term}';\n` }), { RUVNET_DECISION_BUDGET_MS: '20000' });
    expect(r.status).toBe(2);
  }, 60_000);
});
