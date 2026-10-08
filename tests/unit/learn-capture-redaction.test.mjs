// tests/unit/learn-capture-redaction.test.mjs — learn-capture.sh runs as a PostToolUse hook on every
// Bash call and appends what it saw to a local queue that later feeds the global learner.
//
// THE DEFECT THIS GUARDS (ADR-038, found 2026-07-22): it captured the first 120 characters of the
// command "up to the first embedded quote", and its own comment claimed that was "verb, not facts".
// It wasn't. Stopping at a *quote* protects quoted commands and does nothing for unquoted inline
// secrets, so `export AWS_SECRET_ACCESS_KEY=… && psql postgres://admin:pw@db.internal/prod` was
// written verbatim to a 0644 file. On a corporate laptop the internal hostname alone is a DLP
// finding; the credential is worse.
//
// These tests execute the real hook with real credential-bearing payloads and assert on what
// actually lands on disk. They fail if the redaction is weakened — which is the only way a test of
// this kind is worth anything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNodeSqlite } from '../../plugin/scripts/node-sqlite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'learn-capture.mjs');
const SID = 'redaction-test';

let home;
const queuePath = () => { const dir = path.join(home, '.cache', 'ruvnet-brain', 'learn'); return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => path.join(dir,n)).sort((a,b)=>fs.statSync(a).mtimeMs-fs.statSync(b).mtimeMs).at(-1); };

/** Run the hook against an explicit user-scope fake HOME so nothing touches the real queue. */
function capture(command) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { success: true } });
  execFileSync(process.execPath, [HOOK], {
    input: payload,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RUVNET_BRAIN_PROJECT_DIR: home,
      CLAUDE_SESSION_ID: SID,
      RUFLO_BIN: path.join(home, 'missing-ruflo'),
      // This suite asserts the user-scope queue path. The product default is project scope, so
      // leaving this implicit would test one scope and read another.
      RUVNET_LEARNING_SCOPE: 'user',
    },
    encoding: 'utf8',
  });
  const lines = fs.readFileSync(queuePath(), 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]).action;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcap-'));
  const dir = path.join(home, '.claude', 'global-memory', '.swarm');
  fs.mkdirSync(dir, { recursive: true }); new (loadNodeSqlite().DatabaseSync)(path.join(dir, 'memory.db')).close();
  fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
});
afterAll(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('only verified terminal success may enter the learning queue', () => {
  it('the genuine captured Write callback enters only fixed vocabulary, with outer failure still dominant', () => {
    const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/hook-payloads/claude/PostToolUse-Write.json'))).payload;
    const replaceCwd = value => typeof value === 'string' ? value.replaceAll('{{CWD}}', home)
      : Array.isArray(value) ? value.map(replaceCwd)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceCwd(item)])) : value;
    const payload = replaceCwd(original);
    const queue = path.join(home, '.cache', 'ruvnet-brain', 'learn');
    const run = value => execFileSync(process.execPath, [HOOK], { input: JSON.stringify(value), encoding: 'utf8', env: {
      ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, CLAUDE_SESSION_ID: SID,
      RUFLO_BIN: path.join(home, 'missing-ruflo'), RUVNET_LEARNING_SCOPE: 'user' } });
    const files = () => fs.existsSync(queue) ? fs.readdirSync(queue).filter(name => name.endsWith('.jsonl')) : [];
    const before = files(); run(payload); const added = files().filter(file => !before.includes(file));
    expect(added).toHaveLength(1); expect(JSON.parse(fs.readFileSync(path.join(queue, added[0])))).toEqual({ tool: 'Write', action: 'edit file' });
    const accepted = files().sort(); run({ ...payload, success: false });
    expect(files().sort()).toEqual(accepted);
  });
  it.each([{ success: false }, { ok: false }, { cancelled: true }, { canceled: true }, { status: 'failure' }, { outcome: 'unknown' },
    { tool_response: { completed: false, success: true } }, { tool_response: { status: 'pending', success: true } }])('rejects failure, cancellation or unfinished native outcome %j', outcome => {
    const queue = path.join(home, '.cache', 'ruvnet-brain', 'learn');
    const before = fs.existsSync(queue) ? fs.readdirSync(queue).filter(file => file.endsWith('.jsonl')).sort() : [];
    execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'npm test' }, tool_response: { success: true }, ...outcome }), encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, CLAUDE_SESSION_ID: SID,
        RUFLO_BIN: path.join(home, 'missing-ruflo'), RUVNET_LEARNING_SCOPE: 'user' } });
    const after = fs.existsSync(queue) ? fs.readdirSync(queue).filter(file => file.endsWith('.jsonl')).sort() : [];
    expect(after).toEqual(before);
  });
});

describe('learn-capture.sh records intent, never data', () => {
  it('drops an inline AWS key and a DB URL with an embedded password', () => {
    const action = capture(
      'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && psql postgres://admin:Hunter2Pass@db.internal/prod',
    );
    expect(action).toBe('export');
    expect(action).not.toContain('wJalr');
    expect(action).not.toContain('Hunter2Pass');
    expect(action).not.toContain('db.internal');
  });

  it('drops a GitHub token passed as an argument', () => {
    const action = capture('gh auth login --with-token ghp_A1b2C3d4E5f6G7h8I9j0');
    expect(action).toBe('gh auth');
    expect(action).not.toContain('ghp_');
  });

  it('drops filesystem paths, which can name a confidential client or project', () => {
    const action = capture('cd /Users/someone/Code/ConfidentialClientProject && npm test');
    expect(action).toBe('cd');
    expect(action).not.toContain('ConfidentialClientProject');
  });

  it('still keeps the workflow verb chain the learner actually needs', () => {
    expect(capture('git push origin main')).toBe('git push');
    expect(capture('npm test')).toBe('npm test');
  });

  it('never records more than two tokens, whatever the command', () => {
    const action = capture('one two three four five six');
    expect(action.split(/\s+/).length).toBeLessThanOrEqual(2);
  });

  it('writes the queue owner-only (0600) inside an owner-only directory (0700)', () => { // POSIX permission bits do not exist on win32
    capture('git status');
    const fileMode = fs.statSync(queuePath()).mode & 0o777;
    const dirMode = fs.statSync(path.dirname(queuePath())).mode & 0o777;
    if (process.platform === 'win32') { expect(fs.statSync(queuePath()).isFile()).toBe(true); return; }
    expect(fileMode, `queue must be 0600, got ${fileMode.toString(8)}`).toBe(0o600);
    expect(dirMode, `dir must be 0700, got ${dirMode.toString(8)}`).toBe(0o700);
  });

  // Proves the assertions above can actually fail: the old implementation is replayed here, and the
  // same expectation that passes against the current hook must fail against it. Without this, a
  // redaction test that silently stopped running would look identical to one that passes.
  it('the OLD implementation would fail these assertions', () => {
    const old = (cmd) => cmd.match(/^([^"]*)/)[1].slice(0, 120);
    const leaked = old('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && psql postgres://admin:Hunter2Pass@db.internal/prod');
    expect(leaked).toContain('wJalr');
    expect(leaked).toContain('Hunter2Pass');
    expect(leaked).not.toBe('export');
  });
});
