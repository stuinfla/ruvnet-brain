import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MANAGED_EXECUTABLES,
  MANAGED_CLI_TOOLS,
  callManagedCli,
  helpKey,
  normalizeManagedExecution,
  resolveManagedExecutable,
  stampKeysForHelp,
} from '../../plugin/mcp/managed-cli-interface.mjs';
import { readLiveSurfaceReceipts } from '../../plugin/scripts/capability-claim-evidence.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');

describe('managed CLI structured interface policy', () => {
  it('exposes exactly the seven managed executables', () => {
    expect(MANAGED_EXECUTABLES).toEqual([
      'ruflo',
      'claude-flow',
      'agentic-flow',
      'agentic-qe',
      'ruvector',
      'agent-browser',
      'ruv-swarm',
    ]);
  });

  it('derives the same two-level help key from structured argv without parsing shell text', () => {
    expect(helpKey('ruflo', ['memory', 'search', '-q', 'x'])).toBe('ruflo.memory.search');
    expect(helpKey('ruflo', ['memory'])).toBe('ruflo.memory');
    expect(helpKey('ruflo', [])).toBe('ruflo');
  });

  it('rejects unknown executable names and unsafe help-path tokens', () => {
    expect(() => helpKey('not-ruflo', ['memory'])).toThrow(/unknown managed executable/i);
    expect(() => stampKeysForHelp('ruflo', ['memory', '; touch /tmp/pwned'])).toThrow(/invalid subcommand/i);
  });

  it('a successful nested help read stamps the exact key and its parent', () => {
    expect(stampKeysForHelp('ruflo', ['memory', 'search'])).toEqual([
      'ruflo.memory.search',
      'ruflo.memory',
    ]);
    expect(stampKeysForHelp('ruflo', [])).toEqual(['ruflo']);
  });

  it('keeps the blocking policy independent of raw-shell reconstruction', () => {
    const source = fs.readFileSync(path.join(REPO, 'plugin/mcp/managed-cli-interface.mjs'), 'utf8');
    expect(source).not.toMatch(/hook-input|commandNodes|findInvocations|commandOf/);
    expect(source).toMatch(/shell:\s*false/);
  });

  it('keeps missing terminal status unknown and rejects nonzero or contradictory execution', () => {
    expect(normalizeManagedExecution({ code: null, stdout: '', stderr: '', error: null }).outcome).toBe('unknown');
    expect(normalizeManagedExecution({ code: 1, stdout: '', stderr: '', error: null }).outcome).toBe('failure');
    expect(normalizeManagedExecution({ code: 0, stdout: '[ERROR] refused', stderr: '', error: null }).outcome).toBe('failure');
    expect(normalizeManagedExecution({ code: 0, stdout: 'ok', stderr: '', error: null }).outcome).toBe('success');
  });

  it('pins Ruflo to the one global binary when it exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-ruflo-home-'));
    const canonical = path.join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(canonical, 0o755);
    expect(resolveManagedExecutable('ruflo', { HOME: home })).toBe(canonical);
    expect(resolveManagedExecutable('agentic-qe', { HOME: home })).toBe('agentic-qe');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('mints a content-bound current-version receipt from the exact managed CLI execution', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-ruflo-receipt-'));
    const canonical = path.join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
    const evidence = path.join(home, 'live-evidence.jsonl');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, process.platform === 'win32'
      ? '@echo ruflo v3.38.16\r\n'
      : '#!/bin/sh\nprintf "ruflo v3.38.16\\n"\n');
    fs.chmodSync(canonical, 0o755);
    const env = {
      ...process.env,
      HOME: home,
      RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      RUVNET_CAPABILITY_LIVE_EVIDENCE: evidence,
      RUVNET_HOOK_HOST: 'codex',
    };
    const result = await callManagedCli('ruvnet_cli_help', { executable: 'ruflo', argv: [] }, env);
    expect(result.isError).toBe(false);
    expect(readLiveSurfaceReceipts({ file: evidence })).toEqual([
      expect.objectContaining({ executable: 'ruflo', observationClass: 'current-version', observedVersion: '3.38.16' }),
    ]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('exposes the real managed execution boundary for durable pre/post capture', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cli-lifecycle-'));
    const canonical = path.join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, process.platform === 'win32'
      ? '@echo ruflo ok\r\n'
      : '#!/bin/sh\nprintf "ruflo ok\\n"\n');
    fs.chmodSync(canonical, 0o755);
    const env = { ...process.env, HOME: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'brain') };
    const phases = [];
    await callManagedCli('ruvnet_cli_help', { executable: 'ruflo', argv: ['status'] }, env);
    const result = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, env, globalThis.fetch, {
      beforeExecute: ({ executable, argv }) => { phases.push(['before', executable, argv]); },
      afterExecute: ({ normalized }) => { phases.push(['after', normalized.outcome]); },
    });
    expect(result.isError).toBe(false);
    expect(phases).toEqual([['before', 'ruflo', ['status']], ['after', 'success']]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('requires adopted projects to acknowledge durable pre and post progression capture', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cli-capture-'));
    const canonical = path.join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, process.platform === 'win32' ? '@echo ok\r\n' : '#!/bin/sh\nexit 0\n');
    fs.chmodSync(canonical, 0o755);
    const env = { ...process.env, HOME: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'brain') };
    await callManagedCli('ruvnet_cli_help', { executable: 'ruflo', argv: ['status'] }, env);
    const events = [];
    const result = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, env, globalThis.fetch, {
      capture: ({ event }) => { events.push(event); return { adopted: true, progressionCaptured: true }; },
    });
    expect(result.isError).toBe(false);
    expect(events).toEqual(['PreToolUse', 'PostToolUse']);

    const refused = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, env, globalThis.fetch, {
      capture: ({ event }) => event === 'PreToolUse' ? { adopted: true, progressionCaptured: false, skipped: 'outbox unavailable' } : { adopted: true, progressionCaptured: true },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('outbox unavailable');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses the actual managed path when the adopted canonical store resolves outside the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cli-foreign-'));
    const home = path.join(root, 'home');
    const bin = path.join(home, '.npm-global', 'bin');
    const project = path.join(root, 'project');
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(project, '.swarm'), { recursive: true }); fs.mkdirSync(foreign, { recursive: true });
    const executable = path.join(bin, 'ruflo');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n'); fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(foreign, 'memory.db'), 'foreign');
    fs.symlinkSync(foreign, path.join(project, '.swarm', 'memory.db'));
    const env = { ...process.env, HOME: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'brain'), RUVNET_BRAIN_PROJECT_DIR: project, RUVNET_HOOK_HOST: 'codex' };
    await callManagedCli('ruvnet_cli_help', { executable: 'ruflo', argv: ['status'] }, env);
    const result = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, env);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/store could not be resolved|refused/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes a read-only registry probe and mints latest-version evidence from its exact response', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-ruflo-registry-'));
    const evidence = path.join(home, 'live-evidence.jsonl');
    const env = {
      ...process.env,
      HOME: home,
      RUVNET_CAPABILITY_LIVE_EVIDENCE: evidence,
      RUVNET_HOOK_HOST: 'codex',
    };
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => '{"name":"ruflo","version":"3.38.16"}' };
    };
    const result = await callManagedCli('ruvnet_registry_latest', { executable: 'ruflo' }, env, fetchImpl);
    expect(result).toMatchObject({ isError: false });
    expect(result.content[0].text).toContain('3.38.16');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://registry.npmjs.org/ruflo/latest');
    expect(MANAGED_CLI_TOOLS.find(({ name }) => name === 'ruvnet_registry_latest')).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });
    expect(fs.readFileSync(path.join(REPO, 'plugin/mcp/server.mjs'), 'utf8'))
      .toContain("params?.name === 'ruvnet_registry_latest'");
    expect(readLiveSurfaceReceipts({ file: evidence })).toEqual([
      expect.objectContaining({ host: 'shared', executable: 'ruflo', observationClass: 'latest-version', observedVersion: '3.38.16' }),
    ]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('routes skills to native Ruflo MCP tools first and the gateway only for CLI-only gaps', () => {
    const skill = fs.readFileSync(path.join(REPO, 'plugin/skills/ruvnet-brain/SKILL.md'), 'utf8');
    expect(skill).toContain('ruvnet_cli_help');
    expect(skill).toContain('ruvnet_cli_run');
    expect(skill).toMatch(/Ruflo MCP tools first/i);
    expect(skill).toMatch(/CLI-only/i);
  });
});
