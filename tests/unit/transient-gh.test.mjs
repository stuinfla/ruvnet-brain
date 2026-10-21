// scripts/transient-gh.mjs — the ONE classifier and the ONE bounded retry for transient GitHub/API/git failures.
// Each rule below is stated once and a mutation of it fails here (see the fault-injection suite for the nights).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ATTEMPTS, TRANSIENT_HTTP, failureText, isGhWrite, isTransientResult, isTransientText,
  retryTransient, retryTransientAsync, retryTransientResult, retryingGh,
} from '../../scripts/transient-gh.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const sleeps = () => { const delays = []; return { delays, sleep: (ms) => { delays.push(ms); } }; };

describe('what is weather and what is an answer', () => {
  it.each([
    'API rate limit exceeded for user ID 1 (HTTP 403)', 'You have exceeded a secondary rate limit', 'gh: Service Unavailable (HTTP 503)',
    'HTTP 429', 'HTTP 502', 'HTTP 408', 'read tcp: connection reset by peer', 'ECONNRESET', 'EAI_AGAIN api.github.com',
    'fatal: unable to access https://github.com/x/y.git: Could not resolve host: github.com',
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'error: RPC failed; curl 56 OpenSSL SSL_read: Connection reset', 'fatal: early EOF', 'TLS handshake timeout', 'socket hang up',
  ])('transient: %s', (text) => expect(isTransientText(text)).toBe(true));

  it.each([
    'gh: Not Found (HTTP 404)', 'gh: Gone (HTTP 410)', 'gh: Forbidden (HTTP 403)', 'Resource not accessible by integration (HTTP 403)',
    'release not found', 'network down', 'create blew up', 'public verification aggregate signature mismatch',
    'spawnSync gh ENOENT', 'fatal: repository not found', '',
  ])('an answer, never retried: %s', (text) => expect(isTransientText(text)).toBe(false));

  it('a result is transient only when it FAILED with transient text; ENOENT (no binary) never is', () => {
    expect(isTransientResult({ status: 0, stderr: 'HTTP 503' })).toBe(false);
    expect(isTransientResult({ status: 1, stderr: 'HTTP 503' })).toBe(true);
    expect(isTransientResult({ status: null, error: { code: 'ENOENT', message: 'spawnSync gh ENOENT' } })).toBe(false);
    expect(isTransientResult({ status: null, error: { message: 'ETIMEDOUT' } })).toBe(true);
    expect(failureText({ stderr: 'a', stdout: 'b', error: { message: 'c' } })).toBe('a\nb\nc');
  });

  it('the anonymous-fetch status set treats a shared-runner 403 as transient (the 2026-10-18 canary night)', () => {
    expect([...TRANSIENT_HTTP].sort()).toEqual([403, 408, 429, 500, 502, 503, 504].sort());
    expect(TRANSIENT_HTTP.has(404)).toBe(false);
  });
});

describe('bounded retry', () => {
  it('retries a transient throw with growing delays and returns the first success', () => {
    const { delays, sleep } = sleeps();
    let calls = 0;
    const value = retryTransient(() => { calls += 1; if (calls < 3) throw new Error('HTTP 502'); return 'ok'; }, { sleep, baseDelayMs: 10 });
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('BOUND: after DEFAULT_ATTEMPTS the last error is rethrown unchanged', () => {
    const { delays, sleep } = sleeps();
    let calls = 0;
    expect(() => retryTransient(() => { calls += 1; throw new Error('HTTP 503 still'); }, { sleep })).toThrow('HTTP 503 still');
    expect(calls).toBe(DEFAULT_ATTEMPTS);
    expect(delays).toHaveLength(DEFAULT_ATTEMPTS - 1);
  });

  it('an answer is thrown at once: one call, no sleep', () => {
    const { delays, sleep } = sleeps();
    let calls = 0;
    expect(() => retryTransient(() => { calls += 1; throw new Error('gh: Not Found (HTTP 404)'); }, { sleep })).toThrow(/404/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('the async twin behaves the same, with an injected classifier', async () => {
    const delays = [];
    let calls = 0;
    const value = await retryTransientAsync(async () => { calls += 1; if (calls === 1) throw new Error('moved'); return calls; },
      { sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 5, isTransient: (error) => /moved/.test(error.message) });
    expect(value).toBe(2);
    expect(delays).toEqual([5]);
    await expect(retryTransientAsync(async () => { throw new Error('moved'); }, { sleep: async () => {}, isTransient: () => false })).rejects.toThrow('moved');
  });

  it('a result-shaped runner returns the last result instead of throwing, retried only while transient', () => {
    const { delays, sleep } = sleeps();
    const answers = [{ status: 1, stderr: 'HTTP 503' }, { status: 1, stderr: 'release not found' }];
    const result = retryTransientResult(() => answers.shift(), { sleep, baseDelayMs: 1 });
    expect(result).toEqual({ status: 1, stderr: 'release not found' });
    expect(delays).toEqual([1]);
    expect(retryTransientResult(() => ({ status: 0, stdout: 'x' }), { sleep })).toEqual({ status: 0, stdout: 'x' });
  });
});

describe('gh writes run exactly once', () => {
  it('classifies the argument vector: create/delete/upload and non-GET api are writes; view/list/download and edit are not', () => {
    expect(isGhWrite(['release', 'create', 'v1'])).toBe(true);
    expect(isGhWrite(['release', 'delete-asset', 'v1', 'x'])).toBe(true);
    expect(isGhWrite(['release', 'edit', 'v1', '--draft=false'])).toBe(false);
    expect(isGhWrite(['release', 'view', 'v1'])).toBe(false);
    expect(isGhWrite(['release', 'download', 'v1'])).toBe(false);
    expect(isGhWrite(['api', 'repos/o/r/releases/latest'])).toBe(false);
    expect(isGhWrite(['api', '-X', 'POST', 'repos/o/r/x'])).toBe(true);
    expect(isGhWrite(['api', '--method', 'GET', 'repos/o/r/x'])).toBe(false);
    expect(isGhWrite(['api', 'repos/o/r/x', '-f', 'a=b'])).toBe(true);
    expect(isGhWrite(['api', 'graphql', '-f', 'query=...'])).toBe(true);
    expect(isGhWrite(['workflow', 'run', 'x.yml'])).toBe(false); // the dispatcher's one write is not routed through this runner
  });

  it('THE PUBLISHER CONFIRM (2026-09-29): a transient `release view` right after a write is retried; `release create` is never repeated', () => {
    const { sleep } = sleeps();
    const calls = [];
    const scripted = { view: [{ status: 1, stderr: 'HTTP 502' }, { status: 0, stdout: '{"tagName":"t"}' }], create: [{ status: 1, stderr: 'HTTP 502' }] };
    const run = (command, args) => { calls.push([command, ...args]); return scripted[args[2]].shift(); }; // args[0] is the seam script
    const gh = retryingGh({ run, prefix: ['/seam.mjs'], command: 'node', sleep, baseDelayMs: 1 });
    expect(gh(['release', 'view', 't'])).toEqual({ status: 0, stdout: '{"tagName":"t"}' });
    expect(gh(['release', 'create', 't', 'a.zip'])).toEqual({ status: 1, stderr: 'HTTP 502' });
    expect(calls.filter((call) => call[3] === 'view')).toHaveLength(2);
    expect(calls.filter((call) => call[3] === 'create')).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['node', '/seam.mjs']);
  });

  it('is the runner scripts/release.mjs\'s corpus path actually uses, and the canary shares the status set', () => {
    const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
    expect(release).toMatch(/import \{ retryingGh \} from '\.\/transient-gh\.mjs'/);
    expect(release).toMatch(/const gh = retryingGh\(\{ run, command: env\.RUVNET_GH_COMMAND \|\| 'gh'/);
    const canary = fs.readFileSync(path.join(ROOT, 'scripts/corpus-canary.mjs'), 'utf8');
    expect(canary).toMatch(/import \{ TRANSIENT_HTTP, retryTransientAsync \} from '\.\/transient-gh\.mjs'/);
    expect(canary).not.toMatch(/const TRANSIENT_HTTP = new Set/);
    for (const file of ['scripts/approved-runtime.mjs', 'scripts/corpus-next-seed.mjs', 'scripts/corpus-watchdog.mjs']) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(/retryTransientResult\(\(\) => spawnSync\(/);
    }
  });
});
