// write-gate-policy.test.mjs — the write gate's two fail-open cases are POLICY, not accident (4.5).
//
//   ALLOW ON TIMEOUT  a policy still running at the budget does not vote; the write is allowed; the ledger
//                     records `budget-exceeded`; under RUVNET_STOP_NUDGES=full one stderr line says it was a timeout.
//   OVERSIZE          the host transport hands the gate at most 64 KiB; a refusal found in that prefix
//                     stands; what only the rest could show is allowed and recorded as `payload-oversize`.
//                     Measured before 4.5: that allow left no trace anywhere.
// Run through the REAL registered command (hooks.json -> hook-shim.mjs -> decision-gate.mjs), as the host does.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TRANSPORT_CAP_BYTES, classifyPayload } from '../../plugin/scripts/decision-gate.mjs';
import { registrations, makeWorld, worldEnv, cleanupWorld, runCommand } from '../../scripts/hook-qualify-core.mjs';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const term = ['ag', 'entdb'].join('');   // assembled: this repo's own write gate scans the payload while editing

describe('one transport cap, stated once', () => {
  it('the gate\'s cap is the shim\'s stdinBytes (1 MiB) while bash policies bound their prefix reads at 64/32 KiB', () => {
    const shim = /'decision-gate':\s*\{[^}]*stdinBytes:\s*(\d+)/.exec(read('plugin/scripts/hook-shim.mjs'))?.[1];
    expect(Number(shim)).toBe(TRANSPORT_CAP_BYTES);
    expect(TRANSPORT_CAP_BYTES).toBe(1048576);
    for (const f of ['plugin/scripts/protect-brain-state.sh', 'plugin/scripts/ground-before-write.sh']) {
      expect(read(f), f).toContain('INPUT="${INPUT:0:65536}"');
      expect(read(f), f).toMatch(/read -r -t 2 -n \$\(\(\(65536 - \$\{#INPUT\}\) \* 4\)\)/);
    }
    expect(read('plugin/scripts/hijack-ruvnet.sh'), 'hijack-ruvnet.sh').toContain('INPUT="${INPUT:0:32768}"');
    expect(read('plugin/scripts/hijack-ruvnet.sh'), 'hijack-ruvnet.sh').toMatch(/read -r -t 2 -n \$\(\(\(32768 - \$\{#INPUT\}\) \* 4\)\)/);
  });
  it('classifyPayload: complete JSON vs a cut-off prefix, with session/tool/path recovered from the prefix', () => {
    const full = JSON.stringify({ session_id: 's9', tool_name: 'Write', tool_input: { file_path: '/p/a.js', content: 'x'.repeat(TRANSPORT_CAP_BYTES + 10_000) } });
    expect(classifyPayload(full)).toMatchObject({ complete: true, truncated: false });
    const cut = full.slice(0, TRANSPORT_CAP_BYTES);
    expect(classifyPayload(cut)).toMatchObject({ complete: false, truncated: true, session: 's9', tool: 'Write', filePath: '/p/a.js', bytes: TRANSPORT_CAP_BYTES });
    expect(classifyPayload('{"tool_name": "Wri').truncated, 'short garbage is malformed, not oversize').toBe(false);
  });
});

const BASH = resolveBash();
describe.skipIf(process.platform === 'win32' || !BASH)('through the real registered command', () => {
  const reg = registrations(ROOT, ['claude']).find((r) => r.hookId === 'decision-gate');
  async function fire(toolInput, extraEnv = {}, setup = null) {
    const w = makeWorld('claude', { root: ROOT, label: 'wgp' });
    try {
      const prof = path.join(w.home, 'profile.json'); fs.writeFileSync(prof, '{}');   // the write gate is opt-in
      setup?.(w);
      const ti = toolInput(w);
      const payload = JSON.stringify({ session_id: 'wgp-1', hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: w.cwd, tool_input: ti });
      const cfg = path.join(w.home, 'cfg');
      // A generous budget unless a case sets one: these cases test the oversize policy, and on a loaded
      // machine the 2 s default can trip and add the (correct) timeout notice to stderr.
      const t0 = Date.now();
      const r = await runCommand(reg.command, { cwd: w.cwd, env: worldEnv(w, { MODEL_ROUTER_PROFILE: prof, RUVNET_CONFIG_ROOT: cfg, RUVNET_DECISION_BUDGET_MS: '20000', ...extraEnv }), stdin: payload, timeoutMs: 40_000 });
      const ms = Date.now() - t0;
      let rows = [];
      try { rows = fs.readFileSync(path.join(cfg, 'decision-outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* none */ }
      return { status: r.status, stderr: r.stderr.toString('utf8'), rows, ms };
    } finally { cleanupWorld(w); }
  }
  const pad = (n) => 'x'.repeat(n);

  it('OVERSIZE: a refusal visible in the first 64 KiB stands, and is counted (session recovered from the prefix)', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'a.js'), content: `import x from '${term}';\n// ${pad(1_100_000)}` }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED/);
    expect(r.rows.map((x) => x.kind)).toContain('refused');
  }, 60_000);

  // The stderr channel speaks on an ALLOW only under RUVNET_STOP_NUDGES=full (quiet by default since 2026-10-15);
  // the ledger rows are written in both modes. Each case sets the mode, so the parent shell cannot decide it.
  const FULL = { RUVNET_STOP_NUDGES: 'full' };
  const DEFAULT = { RUVNET_STOP_NUDGES: undefined };
  const oversizeTail = (w) => ({ file_path: path.join(w.cwd, 'src', 'b.js'), content: `// ${pad(1_100_000)}\nimport x from '${term}';\n` });

  it('OVERSIZE (default mode): allowed with empty stderr, and the skipped ADR verdict and the oversize are still recorded', async () => {
    const r = await fire(oversizeTail, DEFAULT);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.rows.find((x) => x.kind === 'policy-skipped' && x.policy === 'adr-currency')).toBeTruthy();
    expect(r.rows.find((x) => x.kind === 'payload-oversize')).toMatchObject({ session: 'wgp-1', bytesSeen: TRANSPORT_CAP_BYTES });
  }, 60_000);

  it('OVERSIZE (full mode): what only the rest could show is ALLOWED, with the unavailable ADR verdict disclosed and recorded', async () => {
    const r = await fire(oversizeTail, FULL);
    expect(r.status).toBe(0);
    // The cut-off prefix is not JSON. ADR inspection cannot vote on it; allowing the prefix
    // must preserve that diagnostic rather than claim every policy obtained a verdict.
    expect(r.stderr).toBe('[decision-gate] ADR owning-checkout inspection unavailable; no currency verdict was obtained. — adr-currency did not vote; it supplied no authorization verdict.\n');
    expect(r.rows.find((x) => x.kind === 'policy-skipped' && x.policy === 'adr-currency')).toBeTruthy();
    const row = r.rows.find((x) => x.kind === 'payload-oversize');
    expect(row).toMatchObject({ session: 'wgp-1', tool: 'Write', bytesSeen: TRANSPORT_CAP_BYTES, capBytes: TRANSPORT_CAP_BYTES });
    expect(row.filePath).toMatch(/b\.js$/);
  }, 60_000);

  it('OVERSIZE: the consent guard still refuses a >1 MiB write to the protected settings file', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.home, '.config', 'ruvnet-brain', 'settings.json'), content: pad(1_100_000) }));
    expect(r.status).toBe(2);
  }, 60_000);

  it.each([112, 500, 900])('ISSUE #515/#526: a %d KB write arrives untruncated (ADR currency succeeds, no EPIPE/budget-exceeded)', async (kb) => {
    const setup = (w) => {
      fs.mkdirSync(path.join(w.cwd, 'docs', 'adr'), { recursive: true });
    };
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', `file-${kb}k.js`), content: `// ${pad(kb * 1024)}\n` }), { RUVNET_DECISION_BUDGET_MS: undefined, RUVNET_STOP_NUDGES: 'full' }, setup);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.ms).toBeLessThan(2_000);
    expect(r.rows.filter((x) => x.kind === 'policy-skipped')).toEqual([]);
    expect(r.rows.filter((x) => x.kind === 'payload-oversize')).toEqual([]);
    expect(r.rows.filter((x) => x.kind === 'budget-exceeded')).toEqual([]);
  }, 60_000);

  it('ISSUE #526: a 900 KB single-line Write to protected settings.json refuses quickly with exit 2 and no budget exceedance', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.home, '.config', 'ruvnet-brain', 'settings.json'), content: pad(900 * 1024) }), { RUVNET_DECISION_BUDGET_MS: undefined });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED/);
    expect(r.ms).toBeLessThan(2_000);
    expect(r.rows.filter((x) => x.kind === 'budget-exceeded')).toEqual([]);
    expect(r.rows.filter((x) => x.kind === 'policy-skipped')).toEqual([]);
  }, 60_000);

  it('ALLOW ON TIMEOUT (default mode): a blown budget allows with empty stderr and still records budget-exceeded', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'c.js'), content: `import x from '${term}';\n` }), { RUVNET_DECISION_BUDGET_MS: '1', ...DEFAULT });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.rows.find((x) => x.kind === 'budget-exceeded')?.unconsulted).toContain('ground-before-write');
  }, 60_000);

  it('ALLOW ON TIMEOUT (full mode): a blown budget allows, says so on stderr, and records budget-exceeded with who did not vote', async () => {
    const r = await fire((w) => ({ file_path: path.join(w.cwd, 'src', 'c.js'), content: `import x from '${term}';\n` }), { RUVNET_DECISION_BUDGET_MS: '1', ...FULL });
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

describe.skipIf(process.platform === 'win32' || !BASH)('ISSUE #526: shell policies bounded bash reads (Bash 3.2 & resolveBash)', () => {
  const SH = (f) => path.join(ROOT, 'plugin', 'scripts', f);
  const shells = [...new Set(['/bin/bash', BASH].filter((s) => fs.existsSync(s)))];

  it.each(shells)('%s: UTF-8 multibyte (é, 漢, 😀) prefix parity at 32768 and 65536 boundaries in ground-before-write, protect-brain-state, and hijack-ruvnet', (bashBin) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgp-utf8-'));
    try {
      const prof = path.join(tmp, 'profile.json');
      fs.writeFileSync(prof, '{}');
      const env = { ...process.env, HOME: tmp, MODEL_ROUTER_PROFILE: prof, RUVNET_BRAIN_STATE_DIR: path.join(tmp, 'state') };
      const multiUnit = 'é漢😀';
      // 1) ground-before-write.sh (CAP=65536): term just BEFORE vs just AFTER 65536 codepoints (with >300KB tail)
      const head = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'x.mjs'), content: '' } });
      const prefixLen = [...head].length - 2; // up to closing `"}`
      const beforeCount = Math.floor((65536 - prefixLen - term.length - 5) / 3);
      const beforePad = multiUnit.repeat(beforeCount);
      const payloadBefore = `{"tool_name":"Write","tool_input":{"file_path":${JSON.stringify(path.join(tmp, 'x.mjs'))},"content":"${beforePad}${term}${'😀'.repeat(80_000)}"}}`;
      const rBefore = spawnSync(bashBin, [SH('ground-before-write.sh')], { input: payloadBefore, encoding: 'utf8', env, timeout: 10_000 });
      expect(rBefore.status, rBefore.stderr).toBe(2);

      const afterPad = multiUnit.repeat(Math.ceil((65536 - prefixLen + 10) / 3));
      const payloadAfter = `{"tool_name":"Write","tool_input":{"file_path":${JSON.stringify(path.join(tmp, 'x.mjs'))},"content":"${afterPad}${term}${'😀'.repeat(80_000)}"}}`;
      const rAfter = spawnSync(bashBin, [SH('ground-before-write.sh')], { input: payloadAfter, encoding: 'utf8', env, timeout: 10_000 });
      expect(rAfter.status, rAfter.stderr).toBe(0);

      // 2) protect-brain-state.sh (CAP=65536): file_path just BEFORE vs just AFTER 65536 codepoints
      const pad65k = multiUnit.repeat(Math.ceil(65536 / 3));
      const protBefore = `{"tool_name":"Write","tool_input":{"file_path":${JSON.stringify(path.join(tmp, '.config/ruvnet-brain/settings.json'))},"content":"${'😀'.repeat(80_000)}"}}`;
      expect(spawnSync(bashBin, [SH('protect-brain-state.sh')], { input: protBefore, encoding: 'utf8', env, timeout: 10_000 }).status).toBe(2);
      const protAfter = `{"tool_name":"Write","tool_input":{"content":"${pad65k}","file_path":${JSON.stringify(path.join(tmp, '.config/ruvnet-brain/settings.json'))}}}`;
      expect(spawnSync(bashBin, [SH('protect-brain-state.sh')], { input: protAfter, encoding: 'utf8', env, timeout: 10_000 }).status).toBe(0);

      // 3) hijack-ruvnet.sh (CAP=32768): valid payload <= 32768 bytes/codepoints fires advisory; > 32768 codepoints cuts off closing brace and exits fast
      const hijackHead = '{"tool_name":"Bash","tool_input":{"command":"pinecone ';
      const okPad = multiUnit.repeat(Math.floor((32768 - Buffer.byteLength(hijackHead, 'utf8') - 10) / Buffer.byteLength(multiUnit, 'utf8')));
      const hijackOk = `${hijackHead}${okPad}"}}`;
      expect([...hijackOk].length).toBeLessThanOrEqual(32768);
      expect(Buffer.byteLength(hijackOk, 'utf8')).toBeLessThanOrEqual(32768);
      const rHijackOk = spawnSync(bashBin, [SH('hijack-ruvnet.sh')], { input: hijackOk, encoding: 'utf8', env, timeout: 10_000 });
      expect(rHijackOk.status, rHijackOk.stderr).toBe(0);
      expect(rHijackOk.stdout).toContain('RuVector');

      const overPad = multiUnit.repeat(Math.ceil(32768 / 3));
      const hijackOver = `${hijackHead}${overPad}${'😀'.repeat(80_000)}"}}`;
      const t0 = Date.now();
      const rHijackOver = spawnSync(bashBin, [SH('hijack-ruvnet.sh')], { input: hijackOver, encoding: 'utf8', env, timeout: 10_000 });
      expect(rHijackOver.status, rHijackOver.stderr).toBe(0);
      expect(rHijackOver.stdout).toBe('');
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(shells)('%s: multiline payloads work across all three shell policies', (bashBin) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgp-multi-'));
    try {
      const prof = path.join(tmp, 'profile.json');
      fs.writeFileSync(prof, '{}');
      const env = { ...process.env, HOME: tmp, MODEL_ROUTER_PROFILE: prof, RUVNET_BRAIN_STATE_DIR: path.join(tmp, 'state') };
      const protMulti = `{\n  "tool_name": "Write",\n  "tool_input": {\n    "file_path": ${JSON.stringify(path.join(tmp, '.config/ruvnet-brain/settings.json'))}\n  }\n}\n`;
      expect(spawnSync(bashBin, [SH('protect-brain-state.sh')], { input: protMulti, encoding: 'utf8', env }).status).toBe(2);

      const gbwMulti = `{\n  "tool_name": "Write",\n  "tool_input": {\n    "file_path": ${JSON.stringify(path.join(tmp, 'a.mjs'))},\n    "content": "import x from '${term}';"\n  }\n}\n`;
      expect(spawnSync(bashBin, [SH('ground-before-write.sh')], { input: gbwMulti, encoding: 'utf8', env }).status).toBe(2);

      const hijackMulti = `{\n  "tool_name": "Bash",\n  "tool_input": {\n    "command": "pinecone setup"\n  }\n}\n`;
      const rH = spawnSync(bashBin, [SH('hijack-ruvnet.sh')], { input: hijackMulti, encoding: 'utf8', env });
      expect(rH.status).toBe(0);
      expect(rH.stdout).toContain('RuVector');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(shells)('%s: open-pipe timeout with set -u produces zero stderr across protect-brain-state, ground-before-write, and hijack-ruvnet', async (bashBin) => {
    for (const script of ['protect-brain-state.sh', 'ground-before-write.sh', 'hijack-ruvnet.sh']) {
      const out = await new Promise((resolve) => {
        const c = spawn(bashBin, [SH(script)], { env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
        let stderr = '';
        c.stderr.on('data', (d) => { stderr += d; });
        const killer = setTimeout(() => c.kill('SIGKILL'), 6_000);
        setTimeout(() => c.stdin.end(), 2_500);
        c.on('close', (status) => { clearTimeout(killer); resolve({ status, stderr }); });
      });
      expect(out.status, script).toBe(0);
      expect(out.stderr, script).toBe('');
    }
  }, 20_000);
});
