// console-instances.test.mjs — the installer's automatic Console replacement must (a) start the new
// Console as a user process, not with the installer's own flags (RUVNET_NIGHTLY=1 under the scheduler),
// and (b) recognise a receipt whose pid was REUSED by an unrelated process at once, instead of waiting
// 20s for a Console that no longer exists and reporting a false failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleEnv, replaceStaleConsoles } from '../../scripts/console-instances.mjs';

const temps = [];
const temp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

function receiptFixture(over = {}) {
  const receiptDir = temp('console-instances-receipts-');
  const scope = temp('console-instances-scope-');
  const entry = path.join(temp('console-instances-runtime-'), 'onboarding-console.mjs');
  fs.writeFileSync(entry, '// current runtime\n');
  const receipt = { product: 'ruvnet-brain-console', schema: 1, apiContract: 1, pid: process.pid, port: 7499,
    startedAt: '2026-09-30T10:00:00.000Z', scope, scriptRealpath: '/old/onboarding-console.mjs', runtimeVersion: '4.3.39',
    sourceSha256: 'a'.repeat(64), controlToken: 'b'.repeat(48), ...over };
  const file = path.join(receiptDir, 'scope.json');
  fs.writeFileSync(file, JSON.stringify(receipt));
  const { controlToken: _secret, ...publicIdentity } = receipt;
  return { receiptDir, entry, file, receipt, publicIdentity, identity: { sourceSha256: 'c'.repeat(64) } };
}

describe('consoleEnv — the replacement Console is a user process', () => {
  it('keeps the user\'s keys, proxy and locale; drops installer, scheduler and test flags', () => {
    const user = { HOME: '/h', PATH: '/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', RUVNET_BRAIN_HOME: '/b',
      ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-r', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g2',
      XAI_API_KEY: 'x', HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem' };
    const run = { RUVNET_NIGHTLY: '1', RUVNET_NIGHTLY_IDENTITY: 'n', RUVNET_BRAIN_TEST: '1', RUVNET_REFRESH_RUN_TOKEN: 't',
      RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1', NODE_OPTIONS: '--inspect', npm_lifecycle_event: 'x', npm_config_cache: '/c',
      VITEST_WORKER_ID: '1', CONSOLE_PORT: '9999' };
    expect(consoleEnv({ ...user, ...run }, 7411)).toEqual({ ...user, CONSOLE_PORT: '7411' });
  });

  it('replaceStaleConsoles launches the current Console with that env, never the run\'s flags', () => {
    const f = receiptFixture();
    const launched = [];
    replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir, timeoutMs: 300,
      env: { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-a', HTTPS_PROXY: 'http://p:1', RUVNET_NIGHTLY: '1' },
      probe: () => f.publicIdentity,
      spawnFn: (cmd, args, opts) => { launched.push(opts); return { on() {}, unref() {} }; } });
    expect(launched).toHaveLength(1);
    expect(launched[0].env).toEqual({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-a', HTTPS_PROXY: 'http://p:1', CONSOLE_PORT: '7499' });
    expect(launched[0].cwd).toBe(f.receipt.scope);
  });
});

describe('replaceStaleConsoles — a live pid whose port does not answer', () => {
  it('is reported at once, never pruned: it may be a busy live Console (or a reused pid)', () => {
    const f = receiptFixture(); // pid = this test process: alive, and no Console answers on 7499
    const launched = [];
    const started = Date.now();
    const results = replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir,
      probe: () => null, spawnFn: () => { launched.push(1); return { on() {}, unref() {} }; } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results).toEqual([expect.objectContaining({ replaced: false, pid: process.pid,
      reason: expect.stringMatching(/is alive but port 7499 does not answer with that Console's identity.*receipt was kept/) })]);
    expect(results[0].pruned).toBeUndefined();
    expect(launched).toEqual([]);
    expect(fs.existsSync(f.file)).toBe(true); // the receipt of a possibly-live Console is never deleted
  });

  it('a port answering a DIFFERENT identity is the same: reported, receipt kept', () => {
    const f = receiptFixture();
    const results = replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir,
      probe: () => ({ ...f.publicIdentity, pid: 1 }), spawnFn: () => { throw new Error('must not launch'); } });
    expect(results).toEqual([expect.objectContaining({ replaced: false })]);
    expect(fs.existsSync(f.file)).toBe(true);
  });
});
