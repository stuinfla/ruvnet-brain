import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_WARMUP_TIMEOUT_MS, RELEASE_SEARCH_DEADLINE_MS, SELF_STORE_PROOF_QUERY,
  resolveInstalledMcpServer, runHostMatrixAsync } from '../../scripts/host-install-matrix.mjs';
import { getVersion } from '../../scripts/version.mjs';

const ok = (stdout = '') => ({ status: 0, signal: null, error: null, stdout, stderr: '' });
const locate = (name) => `/tools/${name}`;

describe('host install matrix cold-model orchestration', () => {
  it('warms each host worker before running its measured search sequentially', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-matrix-serial-'));
    let active = 0, maxActive = 0;
    const order = [];
    try {
      const result = await runHostMatrixAsync({
        packageRoot: '/candidate/package', version: getVersion(), variant: 'staged', locate, temp,
        sequentialSearches: true,
        runCommand: async (_command, args, options) => args.some((arg) => /[\\/]bin[\\/]install\.mjs$/.test(arg))
          ? ok() : ok('repo=ruvnet-brain path=README.md'),
        runMcpSearch: async ({ mode, query }) => {
          active += 1; maxActive = Math.max(maxActive, active); order.push(`${mode}:${query === SELF_STORE_PROOF_QUERY ? 'warmup' : 'search'}`);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          const result = ok(`repo=ruvnet-brain path=${mode}.md`);
          result.broadMs = query === SELF_STORE_PROOF_QUERY ? 100 : 25;
          return result;
        },
        verifyGrounding: async () => ({ grounded: true, receipt: { repo: 'ruvnet-brain', path: 'README.md' } }),
        resolveMcpServer: ({ home }) => path.join(home, 'installed-mcp', 'server.mjs'),
      });
      expect(result.verdict).toBe('PASS');
      expect(maxActive).toBe(1);
      expect(order).toEqual(['claude:warmup', 'claude:search', 'codex:warmup', 'codex:search', 'dual:warmup', 'dual:search']);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  it('installs isolated staged hosts, primes disk cache, then warms and probes each MCP host', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-matrix-order-'));
    const calls = [];
    const pendingSearches = [];
    let installsCompleted = 0;
    let prewarmCompleted = false;

    const runCommand = async (_command, args, options) => {
      const isInstall = args.some((arg) => /[\\/]bin[\\/]install\.mjs$/.test(arg));
      if (isInstall) {
        calls.push({ phase: 'install', args, env: options.env });
        installsCompleted += 1;
        return ok();
      }
      calls.push({ phase: 'prewarm', args, env: options.env });
      expect(installsCompleted).toBe(3);
      prewarmCompleted = true;
      return ok('repo=ruvnet-brain path=README.md');
    };

    const runMcpSearch = ({ mode, serverPath, env, query, k, timeoutMs }) => new Promise((resolve) => {
      expect(prewarmCompleted).toBe(true);
      const phase = query === SELF_STORE_PROOF_QUERY ? 'warmup' : 'search';
      calls.push({ phase, mode, serverPath, env, query, k, timeoutMs });
      const response = ok(`repo=ruvnet-brain path=${mode}.md`);
      response.broadMs = phase === 'warmup' ? 100 : 25;
      pendingSearches.push(() => resolve(response));
      if (pendingSearches.length === 3) pendingSearches.splice(0).forEach((finish) => finish());
    });

    try {
      const result = await runHostMatrixAsync({
        packageRoot: '/candidate/package',
        version: getVersion(),
        variant: 'staged',
        locate,
        temp,
        runCommand,
        runMcpSearch,
        resolveMcpServer: ({ home }) => path.join(home, 'installed-mcp', 'server.mjs'),
        verifyGrounding: async () => ({ grounded: true, receipt: { repo: 'ruvnet-brain', path: 'README.md', file: 'ruvnet-brain.passages.jsonl', storedPath: 'README.md' } }),
      });

      expect(result.verdict).toBe('PASS');
      const installs = calls.filter((call) => call.phase === 'install');
      expect(installs).toHaveLength(3);
      expect(installs.every((call) => call.args.includes('--no-verify'))).toBe(true);

      const homes = new Set(installs.map((call) => call.env.HOME));
      const brainHomes = new Set(installs.map((call) => call.env.RUVNET_BRAIN_HOME));
      const kbDirs = new Set(installs.map((call) => call.env.RUVNET_BRAIN_KB));
      const modelCaches = new Set(installs.map((call) => call.env.KB_MODEL_CACHE));
      expect(homes.size).toBe(3);
      expect(brainHomes.size).toBe(3);
      expect(kbDirs.size).toBe(3);
      expect(modelCaches.size).toBe(1);

      const phases = calls.map((call) => call.phase);
      expect(phases.slice(0, 3)).toEqual(['install', 'install', 'install']);
      expect(phases[3]).toBe('prewarm');
      const prewarm = calls[3].args;
      expect(prewarm).toContain('--bounded');
      expect(prewarm).toContain('--repos');
      expect(prewarm[prewarm.indexOf('--repos') + 1]).toBe('ruvnet-brain');
      expect(prewarm).toContain('--pool');
      expect(prewarm[prewarm.indexOf('--pool') + 1]).toBe('8');
      expect(phases.slice(4).filter((phase) => phase === 'warmup')).toHaveLength(3);
      expect(phases.slice(4).filter((phase) => phase === 'search')).toHaveLength(3);
      for (const mode of ['claude', 'codex', 'dual']) {
        const hostCalls = calls.filter((call) => call.mode === mode);
        expect(hostCalls.map((call) => call.phase)).toEqual(['warmup', 'search']);
        expect(hostCalls[0]).toMatchObject({ k: 1, timeoutMs: HOST_WARMUP_TIMEOUT_MS });
        expect(hostCalls[1]).toMatchObject({ k: 5, timeoutMs: RELEASE_SEARCH_DEADLINE_MS });
      }

      for (const call of calls.filter((entry) => entry.phase === 'search')) {
        expect(call.serverPath).toBe(path.join(call.env.HOME, 'installed-mcp', 'server.mjs'));
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('resolves Claude through its real managed plugin cache and Codex through its durable copy', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-matrix-paths-'));
    try {
      const home = path.join(temp, 'home');
      const installPath = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', getVersion());
      fs.mkdirSync(path.join(installPath, 'mcp'), { recursive: true });
      fs.writeFileSync(path.join(installPath, 'mcp', 'server.mjs'), '');
      const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.writeFileSync(registry, JSON.stringify({ plugins: {
        'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath }],
      } }));
      expect(resolveInstalledMcpServer({ mode: 'claude', home })).toBe(path.join(installPath, 'mcp', 'server.mjs'));
      expect(resolveInstalledMcpServer({ mode: 'codex', home }))
        .toBe(path.join(home, '.claude', 'ruvnet-brain', 'mcp', 'server.mjs'));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('preserves status, signal, and spawn error when a real MCP probe fails', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-matrix-diagnostic-'));
    try {
      const result = await runHostMatrixAsync({
        packageRoot: '/candidate/package',
        version: getVersion(),
        variant: 'staged',
        locate,
        temp,
        runCommand: async () => ok('repo=ruvnet-brain path=README.md'),
        runMcpSearch: async ({ mode }) => mode === 'codex'
          ? { status: null, signal: 'SIGKILL', error: Object.assign(new Error('worker terminated'), { code: 'ETIMEDOUT' }), stdout: '', stderr: 'cold start exceeded budget' }
          : ok(`repo=ruvnet-brain path=${mode}.md`),
        verifyGrounding: async () => ({ grounded: true, receipt: { repo: 'ruvnet-brain', path: 'README.md', file: 'ruvnet-brain.passages.jsonl', storedPath: 'README.md' } }),
        resolveMcpServer: ({ home }) => path.join(home, 'installed-mcp', 'server.mjs'),
      });

      expect(result.verdict).toBe('FAIL');
      expect(result.fixtures.codex).toMatchObject({
        status: 'FAIL',
        process: { status: null, signal: 'SIGKILL', errorCode: 'ETIMEDOUT', errorMessage: 'worker terminated' },
      });
      expect(result.error).toMatch(/status=null/);
      expect(result.error).toMatch(/signal=SIGKILL/);
      expect(result.error).toMatch(/error=ETIMEDOUT: worker terminated/);
      expect(result.error).toMatch(/cold start exceeded budget/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
