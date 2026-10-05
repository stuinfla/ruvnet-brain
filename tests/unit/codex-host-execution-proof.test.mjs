import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startupDeclaration, classifyOwnedExecution, produceOwnedCodexExecutionProof, executionProofMain } from '../../scripts/codex-host-execution-proof.mjs';
import { runtimeSnapshot } from '../../scripts/model-routing-launchers.mjs';
import { codexHookHash, codexHookIdentities } from '../../scripts/codex-hook-trust.mjs';
import { proofDigest } from '../../scripts/codex-host-proof-runtime.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..'); const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
describe('explicit diagnostic command', () => {
  it('prints help without starting native execution', async () => {
    const run = vi.fn(); const output = vi.fn();
    expect(await executionProofMain(['--help'], { run, output })).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(output.mock.calls[0][0]).toContain('Overall convergence remains UNPROVEN');
  });
  it.each([[], ['--options', '/tmp/inputs.json'], ['--authorize-owned-startup'],
    ['--authorize-owned-startup', '--options', 'relative.json'], ['--help', '--authorize-owned-startup']])('refuses incomplete or conflicting authorization %j', async (...args) => {
    const run = vi.fn();
    expect(await executionProofMain(args, { run, output: vi.fn() })).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([{ env: {} }, { dependencies: {} }, { authorizeOwnedStartup: true }, [], { timeoutMs: '90000' }])('rejects injected or malformed configuration %j', async (options) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-proof-cli-')); dirs.push(dir);
    const file = path.join(dir, 'inputs.json'); write(file, JSON.stringify(options)); const run = vi.fn();
    expect(await executionProofMain(['--authorize-owned-startup', '--options', file], { run, output: vi.fn() })).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });
  it('dispatches explicit inputs and preserves the unproven exit status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-proof-cli-')); dirs.push(dir);
    const file = path.join(dir, 'inputs.json'); const options = { binary: '/owned/codex', timeoutMs: 90000 };
    write(file, JSON.stringify(options)); const run = vi.fn().mockResolvedValue({ ok: false, state: 'fresh-execution-unproven' });
    const output = vi.fn();
    expect(await executionProofMain(['--authorize-owned-startup', '--options', file], { run, output, platform: 'darwin' })).toBe(1);
    expect(run).toHaveBeenCalledWith({ ...options, authorizeOwnedStartup: true });
    expect(JSON.parse(output.mock.calls[0][0]).state).toBe('fresh-execution-unproven');
  });
  it('refuses Windows execution before reading inputs or launching a client', async () => {
    const run = vi.fn();
    expect(await executionProofMain(['--authorize-owned-startup', '--options', path.resolve('missing.json')], { run, output: vi.fn(), platform: 'win32' })).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses a directory or symbolic-link options file before launch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-proof-cli-')); dirs.push(dir);
    const link = path.join(dir, 'link.json'); fs.symlinkSync(dir, link); const run = vi.fn();
    for (const file of [dir, link]) expect(await executionProofMain(['--authorize-owned-startup', '--options', file], { run, output: vi.fn() })).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });
});
function fixture({ sibling = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-owned-proof-'))); dirs.push(dir);
  const version = '4.5.7'; const codexHome = path.join(dir, 'codex'); const cwd = dir;
  const brainHome = path.join(dir, 'brain'); const codeRoot = path.join(brainHome, 'versions/4.5.7');
  const root = path.join(codexHome, 'plugins/cache/ruvnet-brain/ruvnet-brain/4.5.7'); const releasedPluginRoot = path.join(dir, 'released');
  const hooks = { hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node body.mjs session-start', timeout: 8 },
    ...(sibling ? [{ type: 'command', command: 'node body.mjs learn-flush', timeout: 8 }] : [])] }] } };
  const manifest = { name: 'ruvnet-brain', version }; const hashes = {};
  for (const [file, value] of [['.codex-plugin/plugin.json', manifest], ['hooks/codex-hooks.json', hooks]]) {
    const bytes = JSON.stringify(value); hashes[file] = proofDigest(bytes);
    for (const base of [root, releasedPluginRoot]) write(path.join(base, file), bytes);
  }
  const declaration = { key: [...codexHookIdentities(hooks).keys()][0], currentHash: codexHookHash('SessionStart', hooks.hooks.SessionStart[0], hooks.hooks.SessionStart[0].hooks[0]),
    eventName: 'sessionStart', matcher: 'startup|resume', handlerType: 'command', command: 'node body.mjs session-start', timeoutSec: 8, displayOrder: 11,
    async: false, source: 'plugin', sourcePath: path.join(root, 'hooks/codex-hooks.json'), enabled: true, trustStatus: 'trusted', pluginId: 'ruvnet-brain@ruvnet-brain' };
  const listed = { data: [{ cwd, hooks: [declaration], errors: [], warnings: [] }] };
  if (sibling) listed.data[0].hooks.push({ ...declaration, key: [...codexHookIdentities(hooks).keys()][1],
    command: 'node body.mjs learn-flush', currentHash: codexHookHash('SessionStart', hooks.hooks.SessionStart[0], hooks.hooks.SessionStart[0].hooks[1]), displayOrder: 12 });
  const mcpShell = path.join(dir, 'shell/mcp/server.mjs'); const worker = path.join(brainHome, 'kb/forge-mcp-all.mjs');
  const core = path.join(codeRoot, 'scripts/session-start-core.mjs');
  for (const file of [core, mcpShell, worker]) write(file, '// fixture');
  write(path.join(brainHome, 'active.json'), '{"generation":38}');
  const runtime = { version, generation: 38, codeRoot, mcpShell, worker, activeSha256: proofDigest('{"generation":38}'),
    bindings: [core, mcpShell, worker].map((file) => ({ path: file, sha256: proofDigest('// fixture') })) };
  const body = { schema: 1, state: 'body-executed', nonce: 'a'.repeat(64), pid: 90003, sourcePath: core,
    sourceSha256: proofDigest('// fixture'), cwd, version, restore: { name: 'restore', ms: 1, failed: false },
    stages: [{ name: 'banner', ms: 2, skipped: false }], bodyFailed: false, bannerFallback: false };
  const threadId = '00000000-0000-0000-0000-000000000391';
  const hookRuns = [{ threadId, run: { eventName: 'sessionStart', sourcePath: declaration.sourcePath, source: 'plugin', handlerType: 'command', status: 'completed', displayOrder: 11 } }];
  if (sibling) hookRuns.push({ ...hookRuns[0], run: { ...hookRuns[0].run, displayOrder: 12 } });
  const turnContext = { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'medium', cwd, service_tier: null } };
  const search = { isError: false, content: [{ type: 'text', text: '#1  repo=ruflo\npath : ruflo/README.md\n----- full document -----\nRuflo orchestration architecture.' }] };
  const mcp = { owned: true, server: 'ruvnet-brain', pid: 90001, workerPid: 90002, shellSha256: proofDigest('// fixture'), workerSha256: proofDigest('// fixture'),
    readiness: { state: 'ready', generation: '38:one:two', pid: 90001, workerPid: 90002 } };
  const terminalConfig = path.join(dir, 'terminal.json'); const expectedRoutingDigest = runtimeSnapshot(ROOT).digest;
  write(terminalConfig, JSON.stringify({ managedBy: 'ruvnet-brain-terminal-launchers', realCodex: process.execPath, nodeBinary: process.execPath,
    runtimeRoot: ROOT, runtimeDigest: expectedRoutingDigest }));
  return { dir, version, codexHome, cwd, brainHome, releasedPluginRoot, root, hashes, declaration, listed, mcpShell, runtime,
    body, threadId, hookRuns, turnContext, search, mcp, terminalConfig, expectedRoutingDigest, binary: process.execPath, nonce: body.nonce };
}
function backend(f, mode) {
  const requests = []; const children = []; const killed = []; let child; let launchEnv; let declarationEnv;
  let live = [
    { uid: process.getuid?.() ?? 0, pid: 80000, ppid: 1, birth: 'foreign-birth', command: 'shared native daemon' },
  ];
  const entry = (pid, ppid, command) => ({ uid: process.getuid?.() ?? 0, pid, ppid, birth: `birth-${pid}`, command });
  const dependencies = {
    declarations: async (options) => { declarationEnv = options.env; return { ok: true, pluginRoot: f.root, sourceHashes: f.hashes, nativeBinary: f.binary, nativeVersion: 'codex-cli 0.160.0', nativeBinarySha256: proofDigest(fs.readFileSync(f.binary)) }; },
    verifyRuntime: async () => f.runtime,
    processes: () => structuredClone(live),
    kill: (pid, signal) => { killed.push({ pid, signal }); if (mode !== 'kill-no-exit') live = live.filter((row) => row.pid !== pid);
      if (child?.pid === pid && mode !== 'kill-no-exit') { child.signalCode = signal; child.emit('exit', null, signal); } },
    spawn: (_binary, args, options) => {
      launchEnv = options.env;
      child = Object.assign(new EventEmitter(), { pid: 90000, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, unref: vi.fn() });
      children.push(child); live.push(entry(90000, process.pid, 'owned gateway'), entry(90001, 90000, `node ${f.mcpShell}`), entry(90002, 90001, `node ${f.runtime.worker}`));
      const respond = (request, result) => queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      child.stdin.on('data', (chunk) => { for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line); if (!request.id) continue; requests.push(request); if (mode === 'hang') continue;
        if (request.method === 'initialize') respond(request, {});
        else if (request.method === 'hooks/list') {
          const registry = structuredClone(f.listed);
          if (mode === 'warnings') registry.data[0].warnings.push('foreign modules');
          if (mode === 'foreign') registry.data[0].hooks.push({ ...f.declaration, pluginId: 'owner@foreign' });
          if (mode === 'registry-race' && requests.some((r) => r.method === 'turn/start')) registry.data[0].warnings.push('changed');
          respond(request, registry);
        } else if (request.method === 'thread/start') {
          const transcript = path.join(f.codexHome, `sessions/proof-${f.threadId}.jsonl`);
          write(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: f.threadId } })}\n${JSON.stringify(f.turnContext)}\n`);
          respond(request, { thread: { id: f.threadId, path: transcript } });
        } else if (request.method === 'turn/start') {
          if (mode === 'detached-hidden') live.push(entry(90099, 1, 'unobserved detached startup maintenance'));
          live.push(entry(90003, 90000, `node ${f.body.sourcePath}`));
          const nonce = options.env.RUVNET_BRAIN_HOST_PROOF_NONCE;
          write(options.env.RUVNET_BRAIN_HOST_PROOF_PATH, JSON.stringify({ ...f.body, nonce,
            startedAt: Date.now() - 1, finishedAt: Date.now() }));
          if (mode !== 'body-untracked') dependencies.processes();
          // Preserve this short-lived body long enough for the producer's periodic ownership observation.
          setTimeout(() => {
            if (mode === 'approval') child.stdout.write('{"id":400,"method":"item/commandExecution/requestApproval","params":{}}\n');
            if (mode !== 'no-hook') for (const run of f.hookRuns) child.stdout.write(`${JSON.stringify({ method: 'hook/completed', params: run })}\n`);
            child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: f.threadId, turn: { status: 'completed' } } })}\n`);
            respond(request, { turn: { id: 'turn', status: 'completed' } });
          }, 150);
        } else if (request.method === 'mcpServerStatus/list') respond(request, { data: [{ name: 'ruvnet-brain', runtimeStatus: 'connected' }] });
        else if (request.method === 'mcpServer/tool/call') {
          write(path.join(f.brainHome, 'mcp-readiness.d/90001.json'), JSON.stringify(f.mcp.readiness)); respond(request, f.search);
        } else if (request.method === 'thread/unsubscribe') respond(request, {});
      } });
      return child;
    },
  };
  return { dependencies, children, requests, killed, getLive: () => live, envs: () => [declarationEnv, launchEnv].filter(Boolean) };
}
describe('one owned native startup and search proof', () => {
  it('accepts only the explicit scoped evidence and retains UNKNOWN for other windows and health', () => {
    const f = fixture(); expect(classifyOwnedExecution(f)).toMatchObject({ ok: true, model: 'gpt-6.1-sol', effort: 'medium', existingWindows: 'unproven', startupHealth: 'unknown', otherHooks: 'unknown' });
  });
  it('distinguishes the published startup body from a separate owned learn-flush hook', () => {
    const f = fixture({ sibling: true }); expect(startupDeclaration(f.listed, f.cwd)).toEqual(f.declaration);
    expect(classifyOwnedExecution(f).ok).toBe(true);
    f.hookRuns = f.hookRuns.filter((row) => row.run.displayOrder === 12);
    expect(() => classifyOwnedExecution(f)).toThrow('Native startup notification');
  });
  it.each(['nonce', 'body failed', 'fallback banner', 'restore failed', 'skipped stage', 'missing hook', 'other thread', 'wrong source', 'wrong model', 'wrong effort', 'priority', 'search error', 'no citation', 'foreign MCP', 'wrong generation', 'wrong worker'])('refuses %s without projecting healthy execution', (kind) => {
    const f = fixture();
    if (kind === 'nonce') f.body.nonce = 'c'.repeat(64);
    if (kind === 'body failed') f.body.bodyFailed = true;
    if (kind === 'fallback banner') f.body.bannerFallback = true;
    if (kind === 'restore failed') f.body.restore.failed = true;
    if (kind === 'skipped stage') f.body.stages[0].skipped = true;
    if (kind === 'missing hook') f.hookRuns = [];
    if (kind === 'other thread') f.hookRuns[0].threadId = 'foreign';
    if (kind === 'wrong source') f.body.sourceSha256 = 'c'.repeat(64);
    if (kind === 'wrong model') f.turnContext.payload.model = 'gpt-6-astra';
    if (kind === 'wrong effort') f.turnContext.payload.effort = 'high';
    if (kind === 'priority') f.turnContext.payload.service_tier = 'priority';
    if (kind === 'search error') f.search.isError = true;
    if (kind === 'no citation') f.search.content[0].text = 'Search succeeded';
    if (kind === 'foreign MCP') f.mcp.owned = false;
    if (kind === 'wrong generation') f.mcp.readiness.generation = '37:one:two';
    if (kind === 'wrong worker') f.mcp.workerSha256 = 'c'.repeat(64);
    expect(() => classifyOwnedExecution(f)).toThrow();
  });
  it.each(['warnings', 'errors', 'foreign', 'agent', 'foreign turn hook'])('preflights %s before allowing a first turn', (kind) => {
    const f = fixture();
    if (kind === 'warnings') f.listed.data[0].warnings.push('foreign modules');
    if (kind === 'errors') f.listed.data[0].errors.push('unknown');
    if (kind === 'foreign') f.listed.data[0].hooks.push({ ...f.declaration, pluginId: 'foreign' });
    if (kind === 'agent') f.listed.data[0].hooks[0].handlerType = 'agent';
    if (kind === 'foreign turn hook') f.listed.data[0].hooks.push({ ...f.declaration, pluginId: 'owner@foreign', eventName: 'userPromptSubmit' });
    expect(() => startupDeclaration(f.listed, f.cwd)).toThrow();
  });
  it('requires explicit authorization and does not launch anything by default', async () => {
    const f = fixture(); const launch = vi.fn();
    const result = await produceOwnedCodexExecutionProof({ ...f, dependencies: { spawn: launch } });
    expect(result.ok).toBe(false); expect(result.inferenceRequests).toBe(0); expect(launch).not.toHaveBeenCalled();
  });
  it('rejects a different launcher interpreter before any owned native launch', async () => {
    const f = fixture(); const config = JSON.parse(fs.readFileSync(f.terminalConfig)); const alternate = path.join(f.dir, 'alternate-node');
    write(alternate, '#!/bin/sh\nexit 0'); config.nodeBinary = alternate; write(f.terminalConfig, JSON.stringify(config));
    const b = backend(f); const result = await produceOwnedCodexExecutionProof({ ...f, authorizeOwnedStartup: true, dependencies: b.dependencies });
    expect(result.ok).toBe(false); expect(result.inferenceRequests).toBe(0); expect(b.children).toHaveLength(0);
  });
  it('refuses an unverified native schema version before a thread or turn', async () => {
    const f = fixture(); const b = backend(f); const original = b.dependencies.declarations;
    b.dependencies.declarations = async (options) => ({ ...await original(options), nativeVersion: 'codex-cli 9.0.0' });
    const result = await produceOwnedCodexExecutionProof({ ...f, authorizeOwnedStartup: true, dependencies: b.dependencies });
    expect(result.ok).toBe(false); expect(result.inferenceRequests).toBe(0); expect(b.children).toHaveLength(0);
  });
  it('bounds a stalled owned child and drops every referenced owned pipe', async () => {
    const f = fixture(); const b = backend(f, 'hang'); const start = Date.now();
    const result = await produceOwnedCodexExecutionProof({ ...f, authorizeOwnedStartup: true, dependencies: b.dependencies, timeoutMs: 3000 });
    expect(result.ok).toBe(false); expect(result.inferenceRequests).toBe(0); expect(Date.now() - start).toBeLessThan(3000);
    if (process.platform === 'win32') { expect(b.children).toHaveLength(0); return; }
    expect(b.children[0].unref).toHaveBeenCalled(); expect(b.children[0].stdout.destroyed).toBe(true);
    dirs.push(result.directory);
  });
  it.each(['success', 'owned-sibling', 'detached-hidden', 'warnings', 'foreign', 'registry-race', 'no-hook', 'approval', 'kill-no-exit'])('exercises transport and owned cleanup for %s', async (mode) => {
    const f = fixture({ sibling: mode === 'owned-sibling' }); const b = backend(f, mode);
    f.env = { ...process.env, NODE_OPTIONS: '--require foreign.mjs', NODE_PATH: '/foreign', BASH_ENV: '/foreign', ENV: '/foreign' };
    const result = await produceOwnedCodexExecutionProof({ ...f, authorizeOwnedStartup: true, dependencies: b.dependencies, timeoutMs: 5000 });
    if (process.platform === 'win32') { expect(result.ok).toBe(false); expect(b.children).toHaveLength(0); return; }
    expect(result.ok).toBe(false); // Polling alone cannot prove exhaustive detached-child cleanup.
    for (const env of b.envs()) for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) expect(env[key]).toBeUndefined();
    expect(b.killed.some((row) => row.pid === 80000)).toBe(false); expect(b.getLive().some((row) => row.pid === 80000)).toBe(true);
    if (mode === 'detached-hidden') { expect(b.killed.some((row) => row.pid === 90099)).toBe(false); expect(b.getLive().some((row) => row.pid === 90099)).toBe(true); }
    expect(result.inferenceRequests).toBe(['warnings', 'foreign'].includes(mode) ? 0 : 1);
    expect(b.requests.filter((row) => row.method === 'turn/start')).toHaveLength(result.inferenceRequests);
    expect(b.children.every((child) => child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed && child.unref.mock.calls.length)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(path.join(result.directory, 'receipt.json'))); dirs.push(result.directory);
    expect(receipt.ok).toBe(result.ok);
    if (mode === 'kill-no-exit') expect(result.retirement).toBe('unverified');
    if (['success', 'owned-sibling', 'detached-hidden'].includes(mode)) expect(result).toMatchObject({ state: 'fresh-execution-unproven',
      retirement: 'discovered-owned-processes-retired', exhaustiveDescendants: 'unproven',
      executionEvidence: { ok: true, model: 'gpt-6.1-sol', effort: 'medium', optOuts: ['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'multi_agent', 'web_search'] } });
  });
});
