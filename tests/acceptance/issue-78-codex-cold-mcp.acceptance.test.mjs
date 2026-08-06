import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skipIfCodexHostUnavailable } from '../helpers/codex-host.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CODEX = process.env.RUVNET_CODEX_BIN || 'codex';
const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #78 real Codex cold MCP discovery', () => {
  const available = spawnSync(CODEX, ['--version'], { encoding: 'utf8' }).status === 0;
  const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const test = available && fs.existsSync(auth) ? it : it.skip;

  test('keeps Brain managed-CLI tools callable while worker warmup exceeds the host deadline', (ctx) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue78-codex-'));
    temps.push(root);
    const codexHome = path.join(root, 'codex');
    const kb = path.join(root, 'kb');
    const brainHome = path.join(root, 'brain');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method === 'brain/warmup') return setTimeout(() => reply({ ready: true }), 60_000);
  if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'cold-ready' }] });
});
`);
    const server = path.join(ROOT, 'plugin', 'mcp', 'server.mjs');
    const tomlPath = (value) => JSON.stringify(value);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      '[mcp_servers.ruvnet-brain]',
      `command = ${tomlPath(process.execPath)}`,
      `args = [${tomlPath(server)}]`,
      'startup_timeout_sec = 10',
      '[mcp_servers.ruvnet-brain.env]',
      `RUVNET_BRAIN_HOME = ${tomlPath(brainHome)}`,
      `RUVNET_BRAIN_KB = ${tomlPath(kb)}`,
      `RUVNET_BRAIN_PROJECT_SETTINGS_FILE = ${tomlPath(path.join(root, 'absent.json'))}`,
      '',
    ].join('\n'));

    fs.symlinkSync(auth, path.join(codexHome, 'auth.json'));
    const started = performance.now();
    const result = spawnSync(CODEX, [
      'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--sandbox', 'read-only', '--json',
      'Call ruvnet-brain ruvnet_cli_help with executable agentic-qe and empty argv. Do not call search. End with HOST_ACCEPTED.',
    ], {
      cwd: root,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      timeout: 55_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const elapsedMs = performance.now() - started;

    // A quota-exhausted or unreachable Codex is not a Brain result. Skip loudly rather than report
    // someone else's billing state as our regression. The host-independent proof of this same
    // guarantee is tests/regression/issue-78-tools-survive-cold-warmup.test.mjs, which needs no
    // account and therefore still runs on days like that one.
    if (skipIfCodexHostUnavailable(ctx, result)) return;

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(elapsedMs).toBeLessThan(55_000);
    expect(result.stdout).toContain('HOST_ACCEPTED');
    expect(result.stdout).toContain('Agentic QE');
  }, 60_000);
});
