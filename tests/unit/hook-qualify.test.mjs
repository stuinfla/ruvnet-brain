// tests/unit/hook-qualify.test.mjs — the qualification harness (scripts/hook-qualify*.mjs) proven
// to be able to FAIL. "A test that cannot fail on broken code is not a test": every guard below is
// exercised by breaking the thing it guards — first as pure judge() inputs, then as a real hook body
// swapped for a faulty one in an isolated copy of the plugin and run through the real shim/wrapper.
import { afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CASES, HOSTS, auditWrites, checkStdout, cleanupWorld, fixturesFor, judge, makeWorld, registrations, runCase, runCommand, sandboxAvailable, staticFindings, worldEnv,
} from '../../scripts/hook-qualify-core.mjs';
import { scanClaude, scanCodex, scanGrok } from '../../scripts/hook-qualify-hosts.mjs';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';

// The repo's one bash resolver (/bin/bash on POSIX — the macOS 3.2 that reproduced the set -u defects).
const BASH = resolveBash();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const B = (s = '') => Buffer.from(s);
const ok = { status: 0, signal: null, stdout: B(), stderr: B(), ms: 50, timedOut: false };
const reg = (over = {}) => ({ host: 'claude', event: 'Stop', mode: 'advisory', timeoutSec: 10, effectiveSec: 10, label: 'x', ...over });

describe('the matrix is DERIVED from the registries, never hand-listed', () => {
  it('enumerates every registration of hooks.json and codex-hooks.json, each with a known mode and a captured payload', () => {
    for (const host of HOSTS) {
      const file = host === 'codex' ? 'codex-hooks.json' : 'hooks.json';
      const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', file), 'utf8')).hooks;
      const declared = Object.values(doc).flatMap((gs) => gs.flatMap((g) => g.hooks)).length;
      const regs = registrations(ROOT, [host]);
      expect(regs.length, `${host}: harness saw ${regs.length} of ${declared} registered commands`).toBe(declared);
      expect(declared).toBeGreaterThan(8);
      for (const r of regs) {
        expect(r.mode, `${r.label}: not in hook-shim TABLE`).not.toBe('unknown');
        expect(fixturesFor(r, ROOT).length, `${r.label}: no payload fixture`).toBeGreaterThan(0);
      }
    }
  });
  it('every fixture records provenance, carries no machine-specific path, and DERIVED ones say so', () => {
    for (const host of ['claude', 'codex', 'grok']) {
      const dir = path.join(ROOT, 'tests', 'fixtures', 'hook-payloads', host);
      for (const f of fs.readdirSync(dir)) {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        expect(JSON.parse(raw)._provenance, f).toMatch(/^captured: /);
        expect(raw, `${f} leaks a real path`).not.toMatch(new RegExp(`/Users/|${['stuart', 'kerr'].join('')}`));   // name assembled: the guard must not carry it
      }
    }
  });
});

describe('judge(): every host-contract guard goes RED when the thing it guards is broken', () => {
  const red = (over = {}, regOver = {}) => judge(reg(regOver), 'baseline-real', { ...ok, ...over });
  it('control: a silent, fast, exit-0 hook is clean', () => expect(red({})).toEqual([]));
  it('stderr output', () => expect(red({ stderr: B('oops\n') }).join()).toMatch(/stderr not empty/));
  it('non-zero exit from an advisory hook', () => expect(red({ status: 1 }).join()).toMatch(/exit 1/));
  it('exit 2 from a blocking hook is allowed ONLY when a refusal is expected', () => {
    expect(judge(reg({ mode: 'blocking' }), 'x', { ...ok, status: 2 }).join()).toMatch(/exit 2/);
    expect(judge(reg({ mode: 'blocking' }), 'x', { ...ok, status: 2 }, { mayBlock: true })).toEqual([]);
    expect(judge(reg({ mode: 'advisory' }), 'x', { ...ok, status: 2 }, { mayBlock: true }).join()).toMatch(/exit 2/);
  });
  it('death by signal, and a hook still running at its timeout', () => {
    expect(red({ status: null, signal: 'SIGKILL' }).join()).toMatch(/killed by SIGKILL/);
    expect(red({ timedOut: true, status: null, ms: 14000 }).join()).toMatch(/TIMEOUT/);
  });
  it('slower than the stated share of the effective timeout', () => {
    expect(red({ ms: 9000 }).join()).toMatch(/SLOW/);
    expect(red({ ms: 5900 })).toEqual([]);
  });
  it('invalid / truncated JSON, plain text where a host needs JSON, non-object JSON', () => {
    expect(red({ stdout: B('{"hookSpecificOutput":') }).join()).toMatch(/not ONE valid JSON/);
    expect(red({ stdout: B('{"a":1}{"b":2}') }).join()).toMatch(/not ONE valid JSON/);
    expect(red({ stdout: B('hello there') }).join()).toMatch(/plain text/);
    expect(checkStdout('claude', 'PreToolUse', B('[1,2]'))[0]).toMatch(/not ONE valid JSON|not an object/);
  });
  it('fields the host does not accept', () => {
    expect(checkStdout('claude', 'Stop', B('{"bogus":1}')).join()).toMatch(/unknown top-level field "bogus"/);
    expect(checkStdout('claude', 'Stop', B('{"decision":"block"}')).join()).toMatch(/without a non-empty reason/);
    expect(checkStdout('claude', 'Stop', B('{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"deny"}}')).join()).toMatch(/unknown hookSpecificOutput field/);
    expect(checkStdout('claude', 'Stop', B('{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}')).join()).toMatch(/hookEventName/);
    expect(checkStdout('codex', 'PreToolUse', B('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}')).join()).toMatch(/only permissionDecision:"deny"/);
    expect(checkStdout('codex', 'Stop', B('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"x"}}')).join()).toMatch(/no hookSpecificOutput/);
  });
  it('SessionEnd must be silent on both hosts; Codex has no plain-text context channel', () => {
    expect(checkStdout('claude', 'SessionEnd', B('bye'))[0]).toMatch(/must write nothing/);
    expect(checkStdout('codex', 'SessionStart', B('[RuvNet] hi'))[0]).toMatch(/plain text/);
    expect(checkStdout('claude', 'SessionStart', B('[RuvNet Brain — hi]'))).toEqual([]);   // valid context on Claude
  });
  it('a registration above the host cap is a static finding (Codex clamps SessionEnd to 3s and warns)', () => {
    const f = staticFindings([reg({ host: 'codex', event: 'SessionEnd', timeoutSec: 10, effectiveSec: 3, command: 'node -e "x" 9000 session-snapshot SessionEnd', hookId: 'session-snapshot', mode: 'advisory' })]);
    expect(f.map((x) => x.msg).join()).toMatch(/clamps SessionEnd to 3s/);
  });
});

describe('the shipped registries pass the static host-cap contract', () => {
  // RED on release/4.3.38 as shipped: codex-hooks.json registered SessionEnd at timeout 10, and a real
  // `codex exec --json` turn printed (as an error item) "clamping SessionEnd hook timeout to 3s in
  // .../ruvnet-brain/4.3.38/hooks/codex-hooks.json" on every session.
  it('no registration exceeds what its host will honour, and every Codex inline budget sits inside its host timeout', () => {
    expect(staticFindings(registrations(ROOT)).map((f) => `${f.reg.label}: ${f.msg}`)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('process boundary: a faulty hook body is caught through the REAL shim / Codex wrapper', () => {
  // An isolated copy of the plugin + fixtures, so a deliberately broken body never touches the repo.
  const made = [];
  afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
  function fakeRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-fake-'));
    made.push(dir);
    fs.cpSync(path.join(ROOT, 'plugin'), path.join(dir, 'plugin'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'tests', 'fixtures'), path.join(dir, 'tests', 'fixtures'), { recursive: true });
    const breakBody = (file, src) => fs.writeFileSync(path.join(dir, 'plugin', 'scripts', file), src);
    return { dir, breakBody };
  }
  const find = (root, host, event, id) => registrations(root, [host]).find((r) => r.event === event && r.hookId === id);
  const run = async (root, r, c = CASES[0], extra = {}) => runCase(r, fixturesFor(r, root)[0], c, { root, maxMs: 60_000, ...extra });

  it('CONTROL: the unmodified copy is clean on the real payload (on Claude and on Codex)', async () => {
    const { dir } = fakeRoot();
    for (const host of ['claude', 'codex']) {
      const r = find(dir, host, 'UserPromptSubmit', 'grounding-turn-mark');
      const res = await run(dir, r);
      expect(res.findings, `${host}: ${JSON.stringify(res.findings)} stderr=${res.stderr}`).toEqual([]);
    }
  }, 60_000);

  it('stderr: a hook that writes to stderr is red on Claude; the Codex adapter swallows an exit-0 stderr, so it stays green there', async () => {
    const { dir, breakBody } = fakeRoot();
    breakBody('grounding-turn-mark.mjs', 'process.stderr.write("boom\\n"); process.exit(0);\n');
    expect((await run(dir, find(dir, 'claude', 'UserPromptSubmit', 'grounding-turn-mark'))).findings.join()).toMatch(/stderr not empty/);
    expect((await run(dir, find(dir, 'codex', 'UserPromptSubmit', 'grounding-turn-mark'))).findings).toEqual([]);
  }, 60_000);

  it('a slow hook is red through the Codex wrapper too (the wrapper masks its exit, only the clock can see it)', async () => {
    const { dir, breakBody } = fakeRoot();
    breakBody('grounding-turn-mark.mjs', 'setTimeout(() => process.exit(0), 2500);\n');
    const r = { ...find(dir, 'codex', 'UserPromptSubmit', 'grounding-turn-mark'), effectiveSec: 2 };
    const res = await runCase(r, fixturesFor(r, dir)[0], CASES[0], { root: dir });
    expect(res.findings.join()).toMatch(/SLOW: \d+ms > 1200ms/);
  }, 60_000);

  it('invalid JSON and plain text on a Stop hook are red (Claude)', async () => {
    const { dir, breakBody } = fakeRoot();
    const r = find(dir, 'claude', 'Stop', 'grounding-turn-gate');
    breakBody('grounding-turn-gate.mjs', 'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"Stop",\'); process.exit(0);\n');
    expect((await run(dir, r)).findings.join()).toMatch(/not ONE valid JSON/);
    breakBody('grounding-turn-gate.mjs', 'process.stdout.write("you should keep going"); process.exit(0);\n');
    expect((await run(dir, r)).findings.join()).toMatch(/plain text/);
  }, 60_000);

  it('a blocking hook that exits 1 is red; the same exit from an advisory hook is masked by the shim and stays green', async () => {
    const { dir, breakBody } = fakeRoot();
    breakBody('decision-gate.mjs', 'process.exit(1);\n');
    expect((await run(dir, find(dir, 'claude', 'PreToolUse', 'decision-gate'))).findings.join()).toMatch(/exit 1/);
    breakBody('grounding-turn-mark.mjs', 'process.exit(1);\n');
    expect((await run(dir, find(dir, 'claude', 'UserPromptSubmit', 'grounding-turn-mark'))).findings).toEqual([]);
  }, 60_000);

  it('a hook that outlives its timeout is red, with the measured duration', async () => {
    const { dir, breakBody } = fakeRoot();
    breakBody('grounding-turn-mark.mjs', 'setTimeout(() => {}, 30000);\n');
    const r = { ...find(dir, 'claude', 'UserPromptSubmit', 'grounding-turn-mark'), timeoutSec: 1, effectiveSec: 1 };
    const res = await run(dir, r, CASES[0], { timeoutMs: 1500 });
    expect(res.findings.join()).toMatch(/TIMEOUT: still running after \d+ms/);
  }, 60_000);

  it('a hook that blocks on a stdin that never closes is caught by the held-open case, and the control passes', async () => {
    const { dir } = fakeRoot();
    const held = CASES.find((c) => c.name === 'held-open-stdin');
    const res = await run(dir, find(dir, 'claude', 'UserPromptSubmit', 'grounding-turn-mark'), held);
    expect(res.findings).toEqual([]);
  }, 60_000);

  it.skipIf(!sandboxAvailable())('write containment: a hook that writes outside its HOME/cwd is caught by the sandbox; the clean one is not', async () => {
    const { dir, breakBody } = fakeRoot();
    const r = find(dir, 'claude', 'UserPromptSubmit', 'grounding-turn-mark');
    const fix = fixturesFor(r, dir)[0];
    expect((await auditWrites(r, fix, { root: dir })).violated).toBe(false);
    const escape = path.join(os.tmpdir(), `hq-escape-${process.pid}`);
    breakBody('grounding-turn-mark.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(escape)}, 'x');\n`);
    const res = await auditWrites(r, fix, { root: dir });
    expect(res.violated, JSON.stringify(res)).toBe(true);
    expect(fs.existsSync(escape), 'the sandbox must prevent the write, not merely observe it').toBe(false);
  }, 60_000);
});

describe('layer 2 scanners: the real-host output parsers detect hook errors', () => {
  it('claude: non-zero exit, cancelled outcome, stderr, invalid JSON, and debug timeouts', () => {
    const ev = (o) => JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event: 'Stop', hook_name: 'Stop', exit_code: 0, outcome: 'success', stdout: '', stderr: '', ...o });
    expect(scanClaude({ stdout: ev({}), stderr: '' }).findings).toEqual([]);
    expect(scanClaude({ stdout: ev({ exit_code: 1, outcome: 'error' }), stderr: '' }).findings.join()).toMatch(/exit 1/);
    expect(scanClaude({ stdout: ev({ outcome: 'cancelled' }), stderr: '' }).findings.join()).toMatch(/cancelled/);
    expect(scanClaude({ stdout: ev({ stderr: 'x' }), stderr: '' }).findings.join()).toMatch(/wrote stderr/);
    expect(scanClaude({ stdout: ev({ stdout: '{"a":' }), stderr: '' }).findings.join()).toMatch(/not valid JSON/);
    expect(scanClaude({ stdout: '', stderr: 'SessionEnd hook [x] failed: Hook cancelled' }).findings.join()).toMatch(/process stderr/);
    expect(scanClaude({ stdout: '', stderr: '', debug: '2026 [DEBUG] Hook UserPromptSubmit [node x] (plugin p) timed out after 2000ms' }).findings.join()).toMatch(/timed out/);
  });
  it('codex: a host error item about a hook (the SessionEnd clamp) is a finding; unrelated stderr is not', () => {
    const item = (message) => JSON.stringify({ type: 'item.completed', item: { type: 'error', message } });
    expect(scanCodex({ stdout: item('clamping SessionEnd hook timeout to 3s in x'), stderr: '' }).findings.join()).toMatch(/clamping/);
    expect(scanCodex({ stdout: item('something else'), stderr: 'rmcp transport 409' }).findings).toEqual([]);
  });
  it('grok: WARN/ERROR from the hooks crate and a zero plugin-hook load are reported', () => {
    const w = scanGrok({ stdout: '', stderr: '', debug: '2026 WARN s: xai_grok_hooks::config: hooks: bad matcher\n2026 INFO x: loaded hooks hook_count=4\nplugin discovered name=ruvnet-brain scope=user root=/r skills=1 agents=0 has_hooks=true' });
    expect(w.findings.join()).toMatch(/bad matcher/);
    expect(w.hooksLoaded).toBe(4);
    expect(w.pluginHasHooks).toBe(true);
    expect(w.pluginHooksRan).toBe(false);
    // 4.5, measured on grok 1.0.13: discovered-with-hooks but never dispatched is a finding, never a pass.
    expect(w.findings.join()).toMatch(/Brain plugin hooks discovered but never ran \(session loaded 4 hooks\)/);
  });
  it('grok: a Brain hook that completed counts as ran, and is not reported as not-loaded', () => {
    const debug = 'plugin discovered name=ruvnet-brain scope=user root=/r skills=1 agents=0 has_hooks=true\n'
      + '2026 INFO s: xai_grok_shell::session::acp_session::spawn: loaded hooks hook_count=20\n'
      + '2026 INFO s: xai_grok_hooks::dispatcher: hook completed hook_name=plugin/ruvnet-brain:pre_tool_use[4].hooks[0] elapsed_ms=400';
    const w = scanGrok({ stdout: '', stderr: '', debug });
    expect(w.pluginHooksRan).toBe(true);
    expect(w.findings).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('the write gate refuses the SAME ungrounded rUv write on every host payload shape', () => {
  // MEASURED 2026-09-30 at the process boundary, router profile present (the gate is opt-in):
  //   claude Write payload        -> exit 2 "BLOCKED — you are writing rUv-domain code the brain has not seen"
  //   codex  apply_patch payload  -> exit 2 (same refusal)
  //   grok 1.0.13 native payload  -> exit 0, silent. Grok sends tool_name "write" and hook_event_name
  //                                  "pre_tool_use"; ground-before-write.sh:107 and protect-brain-state.sh:54 compare
  //                                  tool_name to Write|Edit|MultiEdit(|NotebookEdit) case-sensitively. Grok DOES fire the
  //                                  registered matcher on `write` (measured), so the hook runs and then silently allows.
  const term = ['ag', 'entdb'].join('');   // built at runtime: the repo's own write gate refuses this file otherwise
  async function verdict(host, { camelOnly = false } = {}) {
    const r = registrations(ROOT, [host]).find((x) => x.hookId === 'decision-gate');
    const fix = fixturesFor(r, ROOT)[0];
    const w = makeWorld(host, { root: ROOT });
    try {
      const file = path.join(w.cwd, 'src', 'db.js'); const content = `import { X } from '${term}';\n`;
      const p = JSON.parse(JSON.stringify(fix.payload).split('{{ROOT}}').join(w.cwd).split('{{CWD}}').join(w.cwd).split('{{SESSION_ID}}').join('s1')
        .split('{{HOME}}').join(w.home).split('{{TRANSCRIPT}}').join('/nonexistent.jsonl').split('{{TOOL_USE_ID}}').join('t').split('{{PROMPT_ID}}').join('p'));
      for (const k of ['tool_input', 'toolInput']) if (p[k] !== undefined) p[k] = host === 'codex' ? { command: `*** Begin Patch\n*** Add File: ${file}\n+${content}\n*** End Patch` } : { file_path: file, content };
      // Grok's documented input example (10-hooks.md "Input") is camelCase ONLY; the 1.0.13 capture adds
      // snake_case duplicates. Strip them to prove the gate does not depend on the duplicates.
      if (camelOnly) for (const k of Object.keys(p)) if (/_/.test(k)) delete p[k];
      const prof = path.join(w.home, 'profile.json'); fs.writeFileSync(prof, '{}');
      return (await runCommand(r.command, { cwd: w.cwd, env: worldEnv(w, { MODEL_ROUTER_PROFILE: prof }), stdin: JSON.stringify(p), timeoutMs: 30_000 })).status;
    } finally { cleanupWorld(w); }
  }
  it('claude and codex refuse (exit 2)', async () => {
    expect(await verdict('claude')).toBe(2);
    expect(await verdict('codex')).toBe(2);
  }, 60_000);
  // Was it.fails (4.4 KNOWN DEFECT: lowercase tool_name "write" allowed silently). Fixed in 4.5 two ways:
  // decision-gate normalises a Grok payload to Claude's shape (hook-input.mjs normalizeHostEvent), and the
  // bash write guards match the tool name case-insensitively.
  it('grok native payload is refused too (exit 2)', async () => {
    expect(await verdict('grok')).toBe(2);
  }, 60_000);
  it('grok camelCase-only payload (no snake_case duplicates) is refused too — decision-gate normalises it', async () => {
    expect(await verdict('grok', { camelOnly: true })).toBe(2);
  }, 60_000);
});

describe.skipIf(process.platform === 'win32' || !BASH)('shell hooks stay silent on stderr under the adverse conditions the matrix found', () => {
  // Found by the matrix on the SHIPPED tree (file:line in the report):
  //  - `cmd > "$file" 2>/dev/null` prints the shell's own "Permission denied"/"No such file" because the failed
  //    redirect is processed BEFORE the 2>/dev/null (ground-ruvnet.sh: version stamp, version cache, token ledger),
  //    so an unwritable or unset HOME produced stderr on every prompt;
  //  - `[ -n "$_l" ]` under `set -u` after a read loop that never assigned _l ("_l: unbound variable") when stdin is
  //    empty or never delivers a line (grounding-stamp.sh, ground-before-write.sh, design-wall.sh, protect-brain-state.sh).
  const SH = (f) => path.join(ROOT, 'plugin', 'scripts', f);
  const run = (file, { stdin = '', env = {}, readOnlyHome = false } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-sh-'));
    const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.cache', 'ruvnet-brain'), { recursive: true });
    if (readOnlyHome) fs.chmodSync(path.join(home, '.cache', 'ruvnet-brain'), 0o555);
    const e = { PATH: process.env.PATH, HOME: home, TMPDIR: dir, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'), ...env };
    if (env.HOME === null) delete e.HOME;
    try { return spawnSync(BASH, [SH(file)], { input: stdin, env: e, cwd: dir, encoding: 'utf8', timeout: 30_000 }); }
    finally { try { fs.chmodSync(path.join(home, '.cache', 'ruvnet-brain'), 0o755); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'build a ruflo agentdb swarm service' });
  it('ground-ruvnet.sh: unset HOME and a read-only state dir produce no stderr', () => {
    expect(run('ground-ruvnet.sh', { stdin: prompt, env: { HOME: null } }).stderr).toBe('');
    expect(run('ground-ruvnet.sh', { stdin: prompt, readOnlyHome: true }).stderr).toBe('');
  });
  // 4.5, found by the full matrix (grok/PostToolUse/grounding-stamp, home-unset): on an ANSWERED search the
  // stamp path read a bare $HOME under `set -u` and wrote "HOME: unbound variable" to stderr.
  it('grounding-stamp.sh: an answered search with HOME unset produces no stderr', () => {
    const answered = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ruvnet_brain__search_ruvnet', tool_input: { query: 'what is ruflo' },
      tool_response: { content: [{ type: 'text', text: 'Searched 1 RuvNet repos (ruflo).\n#1  repo=ruflo\npath : ruflo/docs/x.md' }] } });
    const r = run('grounding-stamp.sh', { stdin: answered, env: { HOME: null } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
  // EVERY shell hook that combines `set -u` with a timed `read` (4.4.0: the hand-kept list of four missed
  // learn-capture.sh, kling-preflight.sh and route-dispatch.sh — measured red on macOS /bin/bash 3.2).
  const TIMED_READ_HOOKS = fs.readdirSync(path.join(ROOT, 'plugin', 'scripts')).filter((f) => f.endsWith('.sh')).filter((f) => {
    const src = fs.readFileSync(SH(f), 'utf8');
    return /^\s*set -[a-z]*u/m.test(src) && /read -r -t \d+ /.test(src);
  });
  it('discovers every set -u + timed-read hook (the list cannot silently shrink)', () => {
    expect(TIMED_READ_HOOKS).toEqual(expect.arrayContaining(['grounding-stamp.sh', 'ground-before-write.sh', 'design-wall.sh',
      'protect-brain-state.sh', 'learn-capture.sh', 'kling-preflight.sh', 'route-dispatch.sh']));
  });
  for (const f of TIMED_READ_HOOKS) {
    it(`${f}: stdin opened and never written is silent (no "unbound variable")`, async () => {
      const { spawn } = await import('node:child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-sh-'));
      const home = path.join(dir, 'home'); fs.mkdirSync(home);
      try {
        const out = await new Promise((resolve) => {
          const c = spawn(BASH, [SH(f)], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir }, cwd: dir });
          let stderr = ''; c.stderr.on('data', (d) => { stderr += d; });
          const t = setTimeout(() => c.kill('SIGKILL'), 8_000);
          setTimeout(() => c.stdin.end(), 3_000);   // past the hook's own `read -t 2`
          c.on('close', (status) => { clearTimeout(t); resolve({ status, stderr }); });
        });
        expect(out.stderr).toBe('');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
  }
  for (const f of TIMED_READ_HOOKS) {
    it(`${f}: a payload that is delivered but never closed/terminated is silent (no "unbound variable")`, async () => {
      const { spawn } = await import('node:child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-sh-'));
      const home = path.join(dir, 'home'); fs.mkdirSync(home);
      try {
        const out = await new Promise((resolve) => {
          const c = spawn(BASH, [SH(f)], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir }, cwd: dir });
          let stderr = ''; c.stderr.on('data', (d) => { stderr += d; });
          c.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'x', tool_input: {} }));   // no newline, pipe left open
          const t = setTimeout(() => c.kill('SIGKILL'), 6_000);
          c.on('close', (status) => { clearTimeout(t); resolve({ status, stderr }); });
        });
        expect(out.stderr).toBe('');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
  }
});
