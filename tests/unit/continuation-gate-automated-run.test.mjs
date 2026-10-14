// continuation-gate-automated-run.test.mjs — automated runs keep their exact output (4.7.1, check 2f).
//
// Measured before the fix: `claude -p` (CLAUDE_CODE_ENTRYPOINT=sdk-cli) returned a "Correction to my
// previous reply ... Verified:" paragraph and `codex exec` returned "UNVERIFIED: ...", because this Stop
// gate asked for a correction. Interactive sessions must stay gated: both directions are tested, and the
// Codex case runs the real gate under a real process whose command line is `codex exec`.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { continuationProjectIdentity } from '../../plugin/scripts/continuation-objective.mjs';
import { isAutomatedRun } from '../../plugin/scripts/automated-run.mjs';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/continuation-gate.mjs');
const posix = process.platform !== 'win32';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-auto-'));
  // The gate keeps a per-session loop guard; a shared id made later cases depend on earlier ones.
  const sid = `s-auto-${path.basename(dir)}`;
  const identity = continuationProjectIdentity(dir);
  const at = new Date().toISOString();
  const ledger = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ items: [{ text: 'finish the open work', at, done: false }],
    objective: { schemaVersion: 1, kind: 'continuation-preferences', authoritative: false, id: 'fixture', text: 'finish the open work',
      at, state: 'active', projectId: identity.projectId, worktreeIds: [identity.worktreeId], sessionIds: [sid],
      authorization: { kind: 'user', reference: 'fixture-explicit-user-request' } } }));
  const env = { ...process.env, RUVNET_WORK_LEDGER: ledger, RUVNET_CONTINUATION_COOLDOWN_MS: '0',
    RUVNET_OPEN_ISSUES_FILE: path.join(dir, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(dir, 'none.json') };
  delete env.CLAUDE_CODE_ENTRYPOINT; delete env.RUVNET_HOOK_HOST;
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: false, cwd: dir,
    last_assistant_message: 'Here is the requested answer.' });
  return { dir, env, payload };
}
function forced(out) { try { return JSON.parse(out).decision === 'block'; } catch { return false; } }
function run(cmd, args, { env, payload }) {
  try { return execFileSync(cmd, args, { input: payload, encoding: 'utf8', env }); } catch (e) { return e.stdout || ''; }
}

describe('continuation-gate skips automated runs and still gates interactive ones', () => {
  it('claude -p (CLAUDE_CODE_ENTRYPOINT=sdk-cli): no correction request', () => {
    const s = sandbox();
    try { expect(forced(run(process.execPath, [GATE], { ...s, env: { ...s.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }))).toBe(false); }
    finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('interactive Claude (CLAUDE_CODE_ENTRYPOINT=cli) is still gated', () => {
    const s = sandbox();
    try { expect(forced(run(process.execPath, [GATE], { ...s, env: { ...s.env, CLAUDE_CODE_ENTRYPOINT: 'cli' } }))).toBe(true); }
    finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  it.skipIf(!posix)('Codex under a real `codex exec` ancestor: no correction request; interactive `codex` still gated', () => {
    const s = sandbox();
    try {
      // A real process whose command line is `<dir>/codex exec …` (or `<dir>/codex` interactive) that runs
      // the gate as a grandchild, so the ancestor walk is exercised on the real `ps` table.
      const fake = path.join(s.dir, 'codex');
      fs.writeFileSync(fake, `#!${process.execPath}\nconst r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(GATE)}],{stdio:'inherit'});process.exit(r.status??0);\n`, { mode: 0o755 });
      const env = { ...s.env, RUVNET_HOOK_HOST: 'codex' };
      expect(forced(run(fake, ['exec', 'reply OK'], { ...s, env }))).toBe(false);
      expect(forced(run(fake, [], { ...s, env }))).toBe(true);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
});

describe('continuation-gate under Grok', () => {
  it.skipIf(!posix)('under a real `grok -p` ancestor: no correction request; interactive `grok` still gated', () => {
    const s = sandbox();
    try {
      const fake = path.join(s.dir, 'grok');
      fs.writeFileSync(fake, `#!${process.execPath}\nconst r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(GATE)}],{stdio:'inherit'});process.exit(r.status??0);\n`, { mode: 0o755 });
      const env = { ...s.env, GROK_HOOK_EVENT: 'stop', GROK_SESSION_ID: 'fixture' };
      expect(forced(run(fake, ['-p', 'reply OK'], { ...s, env }))).toBe(false);
      expect(forced(run(fake, [], { ...s, env }))).toBe(true);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
});

describe('isAutomatedRun', () => {
  const table = (rows) => (pid) => rows[pid] ?? null;
  it('matches the sdk- entrypoint prefix only', () => {
    expect(isAutomatedRun({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, ps: () => null })).toBe(true);
    expect(isAutomatedRun({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, ps: () => null })).toBe(true);
    for (const ep of ['cli', 'claude-desktop', 'claude-vscode', '']) {
      expect(isAutomatedRun({ env: { CLAUDE_CODE_ENTRYPOINT: ep }, ps: () => null })).toBe(false);
    }
  });
  it('finds `codex exec` several ancestors up, only on the Codex host', () => {
    const rows = { 10: { ppid: 9, args: 'node hook-shim.mjs continuation-gate' }, 9: { ppid: 8, args: 'node codex-hook.mjs' },
      8: { ppid: 7, args: '/opt/homebrew/bin/codex exec --json reply OK' } };
    expect(isAutomatedRun({ env: { RUVNET_HOOK_HOST: 'codex' }, ppid: 10, ps: table(rows) })).toBe(true);
    expect(isAutomatedRun({ env: {}, ppid: 10, ps: table(rows) })).toBe(false);
  });
  it('fake chain gate -> hook-shim -> node wrapper -> codex-hook -> `codex exec` skips; the same chain under interactive `codex` stays gated', () => {
    const chain = (top) => ({ 20: { ppid: 19, args: 'node /x/plugin/scripts/hook-shim.mjs continuation-gate' },
      19: { ppid: 18, args: 'node /x/codex-hook-adapter.mjs continuation-gate' }, 18: { ppid: 17, args: 'node /h/.cache/ruvnet-brain/codex-hook.mjs continuation-gate' },
      17: { ppid: 16, args: 'node -e const f=require(...) 9000 continuation-gate' }, 16: { ppid: 1, args: top } });
    const env = { RUVNET_HOOK_HOST: 'codex' };
    expect(isAutomatedRun({ env, ppid: 20, ps: table(chain('/Users/u/.local/bin/codex exec --json "reply OK"')) })).toBe(true);
    expect(isAutomatedRun({ env, ppid: 20, ps: table(chain('/Users/u/.local/bin/codex')) })).toBe(false);
    expect(isAutomatedRun({ env, ppid: 20, ps: table(chain('/Users/u/.local/bin/codex resume --last')) })).toBe(false);
  });
  it('interactive codex, `codex execute-something`, and an unreadable ps all keep gating', () => {
    const env = { RUVNET_HOOK_HOST: 'codex' };
    expect(isAutomatedRun({ env, ppid: 5, ps: table({ 5: { ppid: 1, args: '/usr/local/bin/codex' } }) })).toBe(false);
    expect(isAutomatedRun({ env, ppid: 5, ps: table({ 5: { ppid: 1, args: 'codex executor' } }) })).toBe(false);
    expect(isAutomatedRun({ env, ppid: 5, ps: () => { throw new Error('no ps'); } })).toBe(false);
  });
  it('finds a headless `grok` ancestor only when Grok set its hook env or the Grok adapter marked the host', () => {
    const rows = { 10: { ppid: 9, args: 'node grok-hook-adapter.mjs stop' }, 9: { ppid: 8, args: 'node hook-shim.mjs continuation-gate' },
      8: { ppid: 7, args: '/Users/u/.grok/bin/grok -p Reply with exactly: ok' } };
    expect(isAutomatedRun({ env: { GROK_HOOK_EVENT: 'stop' }, ppid: 10, ps: table(rows) })).toBe(true);
    expect(isAutomatedRun({ env: { RUVNET_HOOK_HOST: 'grok' }, ppid: 10, ps: table(rows) })).toBe(true);
    expect(isAutomatedRun({ env: {}, ppid: 10, ps: table(rows) })).toBe(false);
    for (const top of ['/Users/u/.grok/bin/grok', '/Users/u/.grok/bin/grok --cwd /x', '/Users/u/.grok/bin/grok login', 'grokker -p x']) {
      expect(isAutomatedRun({ env: { GROK_SESSION_ID: 'x' }, ppid: 8, ps: table({ 8: { ppid: 1, args: top } }) })).toBe(false);
    }
    for (const top of ['grok --single hi', 'grok --prompt-file p.txt', 'grok --prompt-json {}', 'grok agent run']) {
      expect(isAutomatedRun({ env: { GROK_SESSION_ID: 'x' }, ppid: 8, ps: table({ 8: { ppid: 1, args: top } }) })).toBe(true);
    }
  });
});
