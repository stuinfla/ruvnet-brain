// tests/unit/ntfy-delivery.test.mjs — a page must actually LEAVE the machine (4.7.21, RC1).
//
// THE DEFECT THIS ENCODES: scripts/nightly-watchdog.mjs put an emoji in the ntfy `Title` header. Node's fetch
// refuses any non-ByteString header value ("Cannot convert argument to a ByteString") BEFORE a byte is sent,
// and push()'s `catch → false` hid it. Every transition was "undelivered", so the watchdog had never paged and
// then exited 1, which made the wrapper page "SCHEDULED JOB FAILED: nightly-watchdog" instead.
//
// These tests run the real watchdog main() as a subprocess against a LOCAL http server (NTFY_URL override), so
// nothing can reach ntfy.sh, and they bound every count: exact request numbers, exact exit codes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WATCHDOG = path.join(ROOT, 'scripts', 'nightly-watchdog.mjs');
const ASCII = /^[\x20-\x7e]+$/;
const posix = process.platform !== 'win32';

let dir; let server; let requests; let status; let port;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-delivery-'));
  requests = []; status = 200;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { requests.push({ url: req.url, headers: req.headers, body }); res.statusCode = status; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3600_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** A sealed watchdog world: its own HOME (agentic-kit owns the product scheduler, so only the fixture registry
 *  is judged), heartbeat dir, state file, and a `launchctl` stub that prints the given labels. */
function world({ jobs, receipts = {}, prevState, loaded = jobs.map((j) => j.label) }) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'agentic-kit'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'agentic-kit', 'kit.json'), JSON.stringify({ ruvnetBrain: true }));
  const hb = path.join(dir, 'hb'); fs.mkdirSync(hb, { recursive: true });
  for (const [label, r] of Object.entries(receipts)) fs.writeFileSync(path.join(hb, `${label}.json`), JSON.stringify({ label, ...r }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ jobs }));
  const state = path.join(dir, 'state.json');
  if (prevState) fs.writeFileSync(state, JSON.stringify(prevState));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const list = path.join(dir, 'launchctl-list.txt');
  fs.writeFileSync(list, loaded === null ? '' : `PID\tStatus\tLabel\n${loaded.map((l) => `-\t0\t${l}`).join('\n')}\n`);
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\ncat "${list}"\n`); fs.chmodSync(path.join(bin, 'launchctl'), 0o755);
  return { home, hb, registry, state, bin };
}

function runWatchdog(w, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WATCHDOG, ...args], {
      env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, USERPROFILE: w.home, WATCHDOG_REGISTRY: w.registry, WATCHDOG_STATE: w.state,
        JOB_HEARTBEAT_DIR: w.hb, NTFY_URL: `http://127.0.0.1:${port}`, NTFY_TOPIC: 'wd-fixture-topic', WATCHDOG_RETRY_MS: '20', ...env },
    });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}
const JOB = (label, extra = {}) => ({ label, what: 'fixture job', schedule: 'daily', maxAgeHours: 26, ...extra });
const readState = (w) => (fs.existsSync(w.state) ? JSON.parse(fs.readFileSync(w.state, 'utf8')) : null);

describe.skipIf(!posix)('nightly-watchdog main(): pages arrive, and the exit code means "the verdict was delivered"', () => {
  it('a FAILING job sends exactly one request with an ASCII Title, advances the state, and exits 0', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 3, ended_at: iso(HOUR) } } });
    const r = await runWatchdog(w, ['--quiet']);
    expect(requests).toHaveLength(1); // before the fix: 0 — the ByteString throw happened before any byte left
    expect(requests[0].url).toBe('/wd-fixture-topic');
    expect(requests[0].headers.title).toMatch(ASCII);
    expect(requests[0].headers.title).toBe('FAILING: com.test.a');
    expect(requests[0].headers.priority).toBe('urgent');
    expect(readState(w)['com.test.a']).toBe('FAILING');
    expect(r.code).toBe(0); // before the fix: 1 — any red job made the watchdog itself "fail"
  });

  it('a 429 makes the transition undelivered: 3 bounded attempts, state not advanced, exit 1', async () => {
    status = 429;
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 3, ended_at: iso(HOUR) } } });
    const r = await runWatchdog(w, ['--quiet']);
    expect(requests).toHaveLength(3); // retried in-run, never more than 3
    expect(readState(w)['com.test.a']).toBe('OK'); // the next run re-fires the transition
    expect(r.code).toBe(1);
  });

  it('NTFY_TOPIC="" is an opt-out: zero requests, no state written, exit 0', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 3, ended_at: iso(HOUR) } } });
    const r = await runWatchdog(w, ['--quiet'], { NTFY_TOPIC: '' });
    expect(requests).toHaveLength(0);
    expect(readState(w)).toBeNull(); // an opt-out never records a page as handled
    expect(r.code).toBe(0);
  });

  it('a failure the wrapper already paged for this streak is not paged twice', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 3, ended_at: iso(HOUR), failing_since: iso(HOUR), paged: true } } });
    const r = await runWatchdog(w, ['--quiet']);
    expect(requests).toHaveLength(0);
    expect(readState(w)['com.test.a']).toBe('FAILING');
    expect(r.code).toBe(0);
  });

  it('a run that never finished is paged even though its running receipt carries an old paged:true', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'running', started_at: iso(9 * HOUR), pid: 999999, failing_since: iso(30 * HOUR), paged: true } } });
    const r = await runWatchdog(w, ['--quiet']);
    expect(requests.map((q) => q.headers.title)).toEqual(['FAILING: com.test.a']);
    expect(r.code).toBe(0);
  });

  it('a recovery the watchdog did not page for is not announced by it (the wrapper owns that note)', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 3, ended_at: iso(2 * HOUR), failing_since: iso(2 * HOUR), paged: true } } });
    await runWatchdog(w, ['--quiet']);
    fs.writeFileSync(path.join(w.hb, 'com.test.a.json'), JSON.stringify({ label: 'com.test.a', state: 'ok', exit_code: 0, ended_at: iso(HOUR) }));
    const r = await runWatchdog(w, ['--quiet']);
    expect(requests).toHaveLength(0);
    expect(readState(w)['com.test.a']).toBe('OK');
    expect(r.code).toBe(0);
  });

  it('a STALE job is paged by the watchdog and its recovery is announced with an ASCII title', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'ok', exit_code: 0, ended_at: iso(40 * HOUR) } } });
    expect((await runWatchdog(w, ['--quiet'])).code).toBe(0);
    fs.writeFileSync(path.join(w.hb, 'com.test.a.json'), JSON.stringify({ label: 'com.test.a', state: 'ok', exit_code: 0, ended_at: iso(HOUR) }));
    expect((await runWatchdog(w, ['--quiet'])).code).toBe(0);
    expect(requests.map((q) => q.headers.title)).toEqual(['STALE: com.test.a', 'com.test.a is healthy again']);
    expect(requests[1].headers.priority).toBe('default');
  });

  // 4.7.21 review (Fable P2-2): fail (wrapper pages) -> stops firing (watchdog pages STALE) -> runs OK. The wrapper sends
  // "Recovered: X" (its last receipt was a delivered failing streak); the watchdog used to send "X is healthy again" too.
  it('fail -> stale -> recover: the watchdog leaves the one recovery note to the wrapper', async () => {
    const failed = (hAgo) => ({ state: 'failed', exit_code: 1, ended_at: iso(hAgo * HOUR), failing_since: iso(hAgo * HOUR), paged: true });
    const w = world({ jobs: [JOB('com.test.a', { maxAgeHours: 3 })], receipts: { 'com.test.a': failed(1) } });
    expect((await runWatchdog(w, ['--quiet'])).code).toBe(0); // wrapper already paged FAILING: silent
    fs.writeFileSync(path.join(w.hb, 'com.test.a.json'), JSON.stringify({ label: 'com.test.a', ...failed(5) }));
    expect((await runWatchdog(w, ['--quiet'])).code).toBe(0); // stopped firing: STALE, paged by the watchdog
    expect(readState(w)._pagedBy['com.test.a']).toBe('both');
    fs.writeFileSync(path.join(w.hb, 'com.test.a.json'), JSON.stringify({ label: 'com.test.a', state: 'ok', exit_code: 0, ended_at: iso(0.1 * HOUR) }));
    expect((await runWatchdog(w, ['--quiet'])).code).toBe(0);
    expect(requests.map((q) => q.headers.title)).toEqual(['STALE: com.test.a']); // before: + 'com.test.a is healthy again'
    expect(readState(w)._pagedBy['com.test.a']).toBeUndefined();
    expect(readState(w)['com.test.a']).toBe('OK');
  });

  it('a never-finished run whose receipt carries a delivered streak: one FAILING page, recovery left to the wrapper', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'running', started_at: iso(9 * HOUR), pid: 999999, failing_since: iso(30 * HOUR), paged: true } } });
    await runWatchdog(w, ['--quiet']);
    fs.writeFileSync(path.join(w.hb, 'com.test.a.json'), JSON.stringify({ label: 'com.test.a', state: 'ok', exit_code: 0, ended_at: iso(0.1 * HOUR) }));
    await runWatchdog(w, ['--quiet']);
    expect(requests.map((q) => q.headers.title)).toEqual(['FAILING: com.test.a']);
  });

  it('a STALE job the wrapper never paged keeps the watchdog\'s own recovery note', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 1, ended_at: iso(40 * HOUR), failing_since: iso(40 * HOUR), paged: 'suppressed' } } });
    await runWatchdog(w, ['--quiet']);
    fs.writeFileSync(path.join(w.hb, 'com.test.a.json'), JSON.stringify({ label: 'com.test.a', state: 'ok', exit_code: 0, ended_at: iso(HOUR) }));
    await runWatchdog(w, ['--quiet']);
    expect(requests.map((q) => q.headers.title)).toEqual(['STALE: com.test.a', 'com.test.a is healthy again']);
  });

  it('an empty `launchctl list` exits 2 with no pages and no state write', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: {}, loaded: null });
    const r = await runWatchdog(w, ['--quiet']);
    expect(r.code).toBe(2); // before the fix: every job read MISSING and paged
    expect(requests).toHaveLength(0);
    expect(readState(w)).toBeNull();
  });

  it('--no-push sends nothing and writes no state; --strict still exits 1 on any red job', async () => {
    const w = world({ jobs: [JOB('com.test.a')], receipts: { 'com.test.a': { state: 'failed', exit_code: 3, ended_at: iso(HOUR) } } });
    expect((await runWatchdog(w, ['--no-push'])).code).toBe(0);
    expect((await runWatchdog(w, ['--json'])).code).toBe(0); // --json implies --no-push
    expect((await runWatchdog(w, ['--no-push', '--strict'])).code).toBe(1);
    expect(requests).toHaveLength(0);
    expect(readState(w)).toBeNull();
  });

  it('--test-page sends one ASCII page and exits 0 only on a 2xx', async () => {
    const w = world({ jobs: [JOB('com.test.a')] });
    expect((await runWatchdog(w, ['--test-page'])).code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.title).toMatch(ASCII);
    expect(requests[0].headers.title).toMatch(/watchdog delivery test/i);
    status = 500;
    expect((await runWatchdog(w, ['--test-page'])).code).toBe(1);
    expect(requests.length).toBeLessThanOrEqual(4); // one, plus at most 3 attempts for the failing one
  });

  it('a run past maxRunHours with a LIVE wrapper pid is STUCK, and is paged', async () => {
    // A process whose command line looks like the wrapper's for this label (judge() guards against pid reuse).
    const fake = spawn('/bin/sh', ['-c', 'sleep 30; :', 'job-heartbeat.sh', 'com.test.stuck'], { stdio: 'ignore' });
    try {
      const w = world({ jobs: [JOB('com.test.stuck', { maxRunHours: 1 })], receipts: { 'com.test.stuck': { state: 'running', started_at: iso(2 * HOUR), pid: fake.pid } } });
      const r = await runWatchdog(w, ['--quiet']);
      expect(requests.map((q) => q.headers.title)).toEqual(['STUCK: com.test.stuck']); // before: OK, "running right now"
      expect(r.code).toBe(0);
    } finally { fake.kill('SIGKILL'); }
  });

  it('the watchdog does not judge its own receipt while it is running', async () => {
    const self = 'com.ruvnet.nightly-watchdog';
    const w = world({ jobs: [JOB(self)], receipts: { [self]: { state: 'running', started_at: iso(60_000), pid: process.pid } }, prevState: { [self]: 'FAILING' } });
    const r = await runWatchdog(w, ['--quiet']);
    expect(requests).toHaveLength(0); // before: a false "healthy again" for its own in-progress run
    expect(readState(w)[self]).toBe('FAILING'); // SessionStart and the spend guard judge it instead
    expect(r.code).toBe(0);
  });
});

// scripts/notify.sh and scripts/key-canary.mjs — the same opt-out and delivery rules (WP-17).
describe.skipIf(!posix)('notify.sh and key-canary: opt-out honoured, HTTP errors are failures, state follows delivery', () => {
  const NOTIFY = path.join(ROOT, 'scripts', 'notify.sh');
  const curlStub = () => {
    const bin = path.join(dir, 'cbin'); fs.mkdirSync(bin, { recursive: true });
    const log = path.join(dir, 'curl.log');
    // Behaves like curl for an HTTP error: exit 22 only when --fail was passed. Remove --fail and this test fails.
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "$@" >> "${log}"\nfail=0; for a in "$@"; do [ "$a" = "--fail" ] && fail=1; done\n`
      + `[ "\${CURL_HTTP_STATUS:-200}" -ge 400 ] && [ "$fail" = 1 ] && exit 22\nexit 0\n`);
    fs.chmodSync(path.join(bin, 'curl'), 0o755);
    return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
  };
  const notify = (c, env) => spawnSync('/bin/sh', [NOTIFY, 'Title x', 'body', 'urgent'], { encoding: 'utf8', env: { PATH: `${c.bin}:/usr/bin:/bin`, HOME: dir, ...env } });

  it('notify.sh: NTFY_TOPIC="" sends nothing (before: it fell through to the repo .env topic)', () => {
    const c = curlStub();
    const r = notify(c, { NTFY_TOPIC: '' });
    expect(c.calls()).toHaveLength(0);
    expect(r.status).toBe(2); // "not delivered, by choice" — distinct from a failure
  });

  it('notify.sh: a 2xx exits 0; an HTTP error exits non-zero (before: always 0)', () => {
    const c = curlStub();
    expect(notify(c, { NTFY_TOPIC: 'nfx', NTFY_URL: 'http://127.0.0.1:9' }).status).toBe(0);
    expect(notify(c, { NTFY_TOPIC: 'nfx', NTFY_URL: 'http://127.0.0.1:9', CURL_HTTP_STATUS: '429' }).status).toBe(1);
    expect(c.calls()).toHaveLength(2);
    expect(c.calls()[0]).toContain('--fail');
    expect(c.calls()[0]).toContain('http://127.0.0.1:9/nfx');
  });

  it('key-canary --notify keeps the old state for a key whose DEAD page was not delivered', () => {
    const c = curlStub();
    // Every provider probe answers 401 (no network): a preload replaces fetch before the canary runs.
    const preload = path.join(dir, 'fetch401.mjs');
    fs.writeFileSync(preload, 'globalThis.fetch = async () => ({ ok: false, status: 401 });\n');
    const stateFile = path.join(dir, '.claude', 'metaharness', 'key-canary-state.json');
    const runCanary = (env) => spawnSync(process.execPath, ['--import', preload, path.join(ROOT, 'scripts', 'key-canary.mjs'), '--notify'], {
      encoding: 'utf8', env: { PATH: `${c.bin}:/usr/bin:/bin`, HOME: dir, XAI_API_KEY: 'fixture-not-a-key', NTFY_TOPIC: 'kfx', NTFY_URL: 'http://127.0.0.1:9', ...env } });
    runCanary({ CURL_HTTP_STATUS: '503' });
    expect(c.calls()).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(after.XAI_API_KEY?.status).not.toBe('DEAD'); // not recorded: the next run pages again
    runCanary({});
    expect(c.calls()).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).XAI_API_KEY.status).toBe('DEAD');
    runCanary({});
    expect(c.calls()).toHaveLength(2); // delivered once; transition-only from here
  });
});
