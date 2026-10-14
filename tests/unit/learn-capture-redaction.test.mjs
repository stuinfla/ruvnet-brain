// tests/unit/learn-capture-redaction.test.mjs — learn-capture runs as a PostToolUse hook on every Bash
// call and hands what it saw to rUv's own `ruflo memory store` (owner ruling 2026-10-12: no local queue).
//
// THE DEFECT THIS GUARDS (ADR-038, found 2026-07-22): the capture kept the first 120 characters of the
// command, so `export AWS_SECRET_ACCESS_KEY=… && psql postgres://admin:pw@db.internal/prod` reached
// disk verbatim. These tests run the real hook with real credential-bearing payloads and assert on
// what is actually passed to rUv's tool: a stub `ruflo` records its exact argv and the value it was
// asked to store, so a secret that reaches the CLI (or any local file) fails here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNodeSqlite } from '../../plugin/scripts/node-sqlite.mjs';
import { safeAction } from '../../plugin/scripts/learn-capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'learn-capture.mjs');
const SECRETS = ['wJalr', 'Hunter2Pass', 'db.internal', 'ghp_', 'ConfidentialClientProject'];

let home; let stub; let argvLog; let storedFile;

/**
 * A ruflo stand-in written in Node, so it runs on every OS: logs argv; `memory store` records the
 * --value, `memory retrieve` echoes it back. On Windows it is laid out as npm's global `ruflo.cmd`
 * shim beside `node_modules/ruflo`, so the hook reaches it through the same rufloInvocation() path a
 * real Windows install takes (the .cmd itself fails if it is ever run); elsewhere RUFLO_BIN is the
 * executable script.
 */
function makeStub(dir) {
  const prefix = path.join(dir, 'npm-global');
  const pkg = path.join(prefix, 'node_modules', 'ruflo');
  fs.mkdirSync(pkg, { recursive: true });
  const entry = path.join(pkg, 'cli.mjs');
  fs.writeFileSync(entry, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const stored = ${JSON.stringify(path.join(dir, 'stored.json'))};
fs.appendFileSync(${JSON.stringify(path.join(dir, 'argv.log'))}, args.join(' ') + '\\n');
if (args[0] === 'memory' && args[1] === 'store') {
  for (let i = 0; i < args.length - 1; i += 1) if (args[i] === '--value') fs.writeFileSync(stored, args[i + 1]);
} else if (args[0] === 'memory' && args[1] === 'retrieve' && fs.existsSync(stored)) {
  process.stdout.write(fs.readFileSync(stored, 'utf8'));
}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ruflo', bin: { ruflo: 'cli.mjs' } }));
  if (process.platform !== 'win32') return entry;
  const shim = path.join(prefix, 'ruflo.cmd');
  fs.writeFileSync(shim, '@echo off\r\nexit /b 99\r\n');
  return shim;
}

/** Run the real hook with a fake HOME so nothing touches a real store; return what ruflo was handed. */
function capture(command) {
  fs.rmSync(storedFile, { force: true });
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'redaction-test', tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUFLO_BIN: stub, RUVNET_LEARNING_SCOPE: 'user' },
    encoding: 'utf8',
  });
  expect(fs.existsSync(storedFile), `the hook must hand an observation to ruflo memory store for: ${command.slice(0, 30)}`).toBe(true);
  return JSON.parse(fs.readFileSync(storedFile, 'utf8'));
}

beforeAll(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lcap-')));
  const dir = path.join(home, '.claude', 'global-memory', '.swarm');
  fs.mkdirSync(dir, { recursive: true }); new (loadNodeSqlite().DatabaseSync)(path.join(dir, 'memory.db')).close();
  fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
  stub = makeStub(home); argvLog = path.join(home, 'argv.log'); storedFile = path.join(home, 'stored.json');
});
afterAll(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('safeAction: intent, never data (pure)', () => {
  it('drops an inline AWS key and a DB URL with an embedded password', () => {
    const action = safeAction('Bash', 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && psql postgres://admin:Hunter2Pass@db.internal/prod');
    expect(action).toBe('export');
  });
  it('drops a GitHub token passed as an argument', () => {
    expect(safeAction('Bash', 'gh auth login --with-token ghp_A1b2C3d4E5f6G7h8I9j0')).toBe('gh auth');
  });
  it('drops filesystem paths, which can name a confidential client or project', () => {
    expect(safeAction('Bash', 'cd /Users/someone/Code/ConfidentialClientProject && npm test')).toBe('cd');
  });
  it('keeps the workflow verb chain the learner needs', () => {
    expect(safeAction('Bash', 'git push origin main')).toBe('git push');
    expect(safeAction('Bash', 'npm test')).toBe('npm test');
  });
  it('never yields more than two tokens, whatever the command', () => {
    expect(safeAction('Bash', 'one two three four five six').split(/\s+/).length).toBeLessThanOrEqual(2);
  });
  it('an unlisted executable is the literal word "command", never its name', () => {
    expect(safeAction('Bash', 'my-secret-internal-tool --flag')).toBe('command');
  });
});

describe('the real hook hands rUv\'s `ruflo memory store` an observation without data', () => {
  it('stores intent only: no secret appears in the stored value or in any ruflo argv', () => {
    const observed = capture('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && psql postgres://admin:Hunter2Pass@db.internal/prod');
    expect(observed.action).toBe('export');
    const everything = fs.readFileSync(argvLog, 'utf8') + JSON.stringify(observed);
    for (const secret of SECRETS) expect(everything, `leaked ${secret}`).not.toContain(secret);
  });

  it('calls rUv\'s tool the documented way: memory store (no upsert, system observation) then an exact-key retrieve', () => {
    capture('git status');
    const lines = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    const store = lines.filter((l) => l.startsWith('memory store')).pop();
    const retrieve = lines.filter((l) => l.startsWith('memory retrieve')).pop();
    expect(store, 'memory store call').toBeTruthy();
    expect(store).toContain('--no-upsert');
    expect(store).toContain('--provenance system_observation');
    expect(store).toContain('--namespace learning-observations');
    expect(retrieve, 'exact-key readback').toBeTruthy();
    expect(retrieve).toContain('--value-only');
    const key = /--key (\S+)/.exec(store)[1];
    expect(retrieve).toContain(`--key ${key}`);
  });

  it('keeps no private queue: nothing is written under the old learn queue directory', () => {
    capture('npm test');
    const legacy = path.join(home, '.cache', 'ruvnet-brain', 'learn');
    expect(fs.existsSync(legacy) ? fs.readdirSync(legacy).filter((n) => n.endsWith('.jsonl')) : []).toEqual([]);
  });

  // Teeth: the old implementation, replayed, must fail the same expectation the live hook passes.
  it('the OLD implementation would fail these assertions', () => {
    const old = (cmd) => cmd.match(/^([^"]*)/)[1].slice(0, 120);
    const leaked = old('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && psql postgres://admin:Hunter2Pass@db.internal/prod');
    expect(leaked).toContain('wJalr');
    expect(leaked).toContain('Hunter2Pass');
    expect(leaked).not.toBe('export');
  });
});
