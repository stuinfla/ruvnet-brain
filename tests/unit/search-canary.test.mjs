// tests/unit/search-canary.test.mjs
//
// "IF SEARCH IS NOT WORKING IT MUST TELL ME IMMEDIATELY" (owner, 2026-11-16). Search was down for hours
// after a 3:31 a.m. Homebrew upgrade and nothing said so. scripts/search-canary.mjs runs every 5 minutes;
// these tests pin what it must do:
//   - alert on the 2nd consecutive failure with the exact subject, what failed, since when (Eastern) and the
//     first thing to check; repeat at most hourly; one recovery; one daily OK heartbeat; e-mail only on the
//     first alert and the recovery
//   - under fault injection report DOWN without touching the live health/readiness files, and page through
//     ntfy (a local fake server here); without injection, answer OK through a REAL fresh server.mjs search
//   - judge the stale long-running server: a shell that cannot start its worker is DOWN unless its own node
//     runs now (its next search then retries); a node-runtime failure is always DOWN
//   - make the session-start health line say SEARCH IS DOWN when the canary has judged it so.
// Every run here sets a temp HOME and a fake ntfy URL; nothing reaches the owner's phone.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, cheapChecks, judge, takeLock, ALERT_TITLE } from '../../scripts/search-canary.mjs';
import { health } from '../../plugin/scripts/session-start-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANARY = path.join(ROOT, 'scripts', 'search-canary.mjs');
const SERVER = path.join(ROOT, 'plugin', 'mcp', 'server.mjs');
const temps = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
afterAll(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-11-16T15:00:00Z'); // 10:00 a.m. ET
const down = { ok: false, what: 'the worker died', check: 'run node -e 0' };

describe('decide: when to speak', () => {
  it('stays quiet on the first failure, alerts on the second with subject, cause, since (ET) and first check', () => {
    const a = decide({}, down, T0, { emailReady: true });
    expect(a.messages).toEqual([]);
    const b = decide(a.state, down, T0 + 5 * 60_000, { emailReady: true });
    expect(b.messages).toHaveLength(1);
    const m = b.messages[0];
    expect(m).toMatchObject({ kind: 'alert', title: ALERT_TITLE, priority: 'urgent', email: true });
    expect(ALERT_TITLE).toBe('SERIOUS ALERT: RuvNet Brain search down');
    expect(m.body).toMatch(/What failed: the worker died/);
    expect(m.body).toMatch(/Since: Nov 16, 10:00 AM ET/);
    expect(m.body).toMatch(/First thing to check: run node -e 0/);
  });

  it('repeats at most hourly (ntfy only), then sends one recovery (with e-mail) and resets', () => {
    let s = decide({}, down, T0).state;
    s = { ...decide(s, down, T0 + 5 * 60_000, { emailReady: true }).state, lastAlertAt: T0 + 5 * 60_000 };
    expect(decide(s, down, T0 + 30 * 60_000, { emailReady: true }).messages).toEqual([]);
    const later = decide(s, down, T0 + 66 * 60_000, { emailReady: true });
    expect(later.messages[0]).toMatchObject({ kind: 'repeat', email: false });
    const ok = decide(s, { ok: true, cited: 'ruvnet-brain/kb/package.json' }, T0 + 70 * 60_000, { emailReady: true });
    expect(ok.messages.map((m) => m.kind)).toEqual(['recovery']);
    expect(ok.messages[0]).toMatchObject({ email: true });
    expect(ok.state).toMatchObject({ consecutiveFailures: 0, failingSince: null, lastAlertAt: null });
  });

  it('sends one low-priority OK heartbeat per Eastern day, after 9 a.m., never by e-mail', () => {
    const early = decide({}, { ok: true }, Date.parse('2026-11-16T13:00:00Z')); // 8 a.m. ET
    expect(early.messages).toEqual([]);
    const first = decide({}, { ok: true }, T0);
    expect(first.messages).toMatchObject([{ kind: 'heartbeat', priority: 'low', email: false }]);
    expect(decide({ lastHeartbeatDay: '2026-11-16' }, { ok: true }, T0 + 3_600_000).messages).toEqual([]);
  });
});

describe('the stale long-running server', () => {
  const home = () => { const h = tmp('rnb-canary-ready-'); fs.mkdirSync(path.join(h, 'mcp-readiness.d')); return h; };
  const record = (h, rec) => fs.writeFileSync(path.join(h, 'mcp-readiness.d', `${process.pid}.json`), JSON.stringify({ pid: process.pid, ...rec }));
  it('a shell whose worker cannot start under any node is DOWN', async () => {
    const h = home();
    record(h, { state: 'degraded', phase: 'node-runtime', error: 'the search worker could not start under any Node runtime' });
    const r = await cheapChecks({ brainHome: h });
    expect(r.failures[0].what).toMatch(new RegExp(`\\(pid ${process.pid}\\) cannot start its search worker`));
  });
  it('a shell that failed to start but whose node runs now stays DOWN until a real search answers; then it is a note', async () => {
    const h = home();
    record(h, { state: 'degraded', phase: 'initialize', error: 'brain worker exited' });
    const r = await cheapChecks({ brainHome: h });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ retriable: true });
    // A working node alone proves nothing about that session's worker (Codex review): no real search, still DOWN.
    expect(judge(r, null)).toMatchObject({ ok: false });
    expect(judge(r, { ok: false, what: 'a real search failed', check: 'x' })).toMatchObject({ ok: false });
    const proven = judge(r, { ok: true, cited: 'ruvnet-brain/kb/package.json' });
    expect(proven.ok).toBe(true);
    expect(proven.notes[0]).toMatch(/runs now and a real search answered/);
  });
  it('a post-fix shell that found no node (node-runtime) recovers the same way once a node runs and a search answers', async () => {
    const h = home();
    record(h, { state: 'degraded', phase: 'node-runtime', error: 'no node' });
    const r = await cheapChecks({ brainHome: h });
    expect(r.failures[0]).toMatchObject({ retriable: true });
    expect(judge(r, { ok: true }).ok).toBe(true);
  });
  it('a record whose pid now belongs to a younger process (pid reuse) is not that server', async () => {
    const h = home();
    record(h, { state: 'degraded', phase: 'node-runtime', error: 'old', at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    expect((await cheapChecks({ brainHome: h })).failures).toEqual([]);
  });
  it('a recorded past outage (health.json) is superseded by a real search that answers, never by silence', () => {
    const cheap = { failures: [{ what: 'the last search outage was recorded 3 min ago', check: 'doctor', recorded: true }], notes: [] };
    expect(judge(cheap, null).ok).toBe(false);
    expect(judge(cheap, { ok: true }).ok).toBe(true);
  });
  it('a ready shell whose worker retired idle is not a failure', async () => {
    const h = home();
    record(h, { state: 'ready', workerPid: 999999 });
    expect((await cheapChecks({ brainHome: h })).failures).toEqual([]);
  });
});

// A fake ntfy that records every POST.
function fakeNtfy({ rejectAuth = false } = {}) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      posts.push({ url: req.url, headers: req.headers, body, status: rejectAuth && req.headers.authorization ? 401 : 200 });
      res.statusCode = posts.at(-1).status; res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ posts, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function runCanary(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CANARY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

// The worker a real server.mjs supervises, answering like the brain: a retrieval result citing a path.
const STUB_WORKER = `
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'brain/warmup') return send({ jsonrpc: '2.0', id: m.id, result: { ready: true } });
  if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ answer: 'x', retrieval: { results: [{ repo: 'ruvnet-brain', path: 'kb/package.json', text: 'npm package: ruvnet-brain-kb' }] } }) }] } });
});
`;

describe('end to end through the script', () => {
  it('DOWN under fault injection pages once on the 2nd run, never touches the brain home; OK through a real server recovers', async () => {
    const ntfy = await fakeNtfy();
    try {
      const t = tmp('rnb-canary-e2e-');
      const brainHome = path.join(t, 'brain');
      fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true });
      fs.writeFileSync(path.join(brainHome, 'kb', 'forge-mcp-all.mjs'), STUB_WORKER);
      const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(t, 'home'), RUVNET_BRAIN_HOME: brainHome,
        SEARCH_CANARY_STATE: path.join(t, 'state.json'), SEARCH_CANARY_SERVER: SERVER, NTFY_TOPIC: 'test-topic', NTFY_URL: ntfy.url, NTFY_TOKEN: '' };
      const injected = { ...env, RUVNET_BRAIN_CANARY_INJECT: 'down' };
      const one = await runCanary(['--json'], injected); // --json: judge and print only
      expect(JSON.parse(one.out)).toMatchObject({ verdict: 'DOWN' });
      const r1 = await runCanary([], injected);
      expect(r1.code).toBe(0);
      expect(ntfy.posts).toHaveLength(0);
      const r2 = await runCanary([], injected);
      expect(r2.code, r2.err).toBe(0);
      expect(ntfy.posts).toHaveLength(1);
      expect(ntfy.posts[0].url).toBe('/test-topic');
      expect(ntfy.posts[0].headers.title).toBe(ALERT_TITLE);
      expect(ntfy.posts[0].headers.priority).toBe('urgent');
      expect(ntfy.posts[0].body).toMatch(/What failed: fault injected/);
      expect(fs.existsSync(path.join(brainHome, 'mcp-readiness.d'))).toBe(false); // live files untouched
      const r3 = await runCanary([], injected);
      expect(r3.code).toBe(0);
      expect(ntfy.posts).toHaveLength(1); // inside the hour: no repeat

      const ok = await runCanary([], env); // no injection: a real search through a fresh server.mjs
      expect(ok.code, ok.err + ok.out).toBe(0);
      expect(ok.out).toMatch(/search-canary: OK/);
      expect(ntfy.posts.map((p) => p.headers.title)).toContain('Recovered: RuvNet Brain search is working again');
      expect(ntfy.posts.at(-1).body + ntfy.posts.at(-2).body).toMatch(/ruvnet-brain\/kb\/package\.json/);
    } finally { ntfy.close(); }
  }, 90_000);
});

describe('e-mail rides ntfy with the account token, only on the first alert and the recovery', () => {
  const world = (ntfy) => {
    const t = tmp('rnb-canary-mail-');
    const brainHome = path.join(t, 'brain');
    fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(brainHome, 'kb', 'forge-mcp-all.mjs'), STUB_WORKER);
    const state = path.join(t, 'state.json');
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(t, 'home'), RUVNET_BRAIN_HOME: brainHome,
      SEARCH_CANARY_STATE: state, SEARCH_CANARY_SERVER: SERVER, NTFY_TOPIC: 'test-topic', NTFY_URL: ntfy.url, NTFY_TOKEN: 'tk_test' };
    return { env, state, injected: { ...env, RUVNET_BRAIN_CANARY_INJECT: 'down' } };
  };

  it('first alert and recovery carry Authorization + X-Email; the hourly repeat does not', async () => {
    const ntfy = await fakeNtfy();
    try {
      const w = world(ntfy);
      await runCanary([], w.injected); await runCanary([], w.injected);
      expect(ntfy.posts).toHaveLength(1);
      expect(ntfy.posts[0].headers).toMatchObject({ authorization: 'Bearer tk_test', 'x-email': 'yes' });
      const s = JSON.parse(fs.readFileSync(w.state, 'utf8'));
      fs.writeFileSync(w.state, JSON.stringify({ ...s, lastAlertAt: s.lastAlertAt - 2 * 3_600_000 }));
      await runCanary([], w.injected);
      expect(ntfy.posts).toHaveLength(2);
      expect(ntfy.posts[1].headers.title).toBe(ALERT_TITLE);
      expect(ntfy.posts[1].headers.authorization).toBeUndefined();
      expect((await runCanary([], w.env)).code).toBe(0);
      const recovery = ntfy.posts.find((p) => /working again/.test(p.headers.title));
      expect(recovery.headers).toMatchObject({ authorization: 'Bearer tk_test', 'x-email': 'yes' });
    } finally { ntfy.close(); }
  }, 90_000);

  it('a rejected token (401) still delivers the phone alert, resent without the e-mail headers', async () => {
    const ntfy = await fakeNtfy({ rejectAuth: true });
    try {
      const w = world(ntfy);
      await runCanary([], w.injected);
      const r = await runCanary(['--json'], w.injected); // --json judges only: prove the real run below
      expect(JSON.parse(r.out).verdict).toBe('DOWN');
      const sent = await runCanary([], w.injected);
      expect(sent.code, sent.out + sent.err).toBe(0);
      expect(ntfy.posts.map((p) => p.status)).toEqual([401, 200]);
      expect(ntfy.posts[1].headers.title).toBe(ALERT_TITLE);
      expect(ntfy.posts[1].headers.authorization).toBeUndefined();
    } finally { ntfy.close(); }
  }, 60_000);
});

describe('the ntfy inbox files the alert so sessions see it, and the recovery closes it', () => {
  it('classifies alert, recovery and TEST page', async () => {
    const { classify } = await import('../../scripts/ntfy-inbox.mjs');
    expect(classify({ id: 'a', title: ALERT_TITLE, priority: 5 })).toMatchObject({ kind: 'search', key: 'search:down', actionable: true });
    expect(classify({ id: 'b', title: 'Recovered: RuvNet Brain search is working again', priority: 3 })).toMatchObject({ key: 'search:down', resolves: true });
    expect(classify({ id: 'c', title: `TEST - ${ALERT_TITLE}`, priority: 3 })).toMatchObject({ kind: 'info', actionable: false });
  });
  it('closes an open search alert once the canary has judged search OK after it, and only then', async () => {
    const { resolvedNow } = await import('../../scripts/ntfy-inbox.mjs');
    const alert = { kind: 'search', key: 'search:down', lastAt: new Date(T0).toISOString() };
    expect(resolvedNow(alert, { canary: () => ({ lastVerdict: 'ok', lastRunAt: T0 + 60_000 }) })).toMatch(/OK again/);
    expect(resolvedNow(alert, { canary: () => ({ lastVerdict: 'ok', lastRunAt: T0 - 60_000 }) })).toBe(false);
    expect(resolvedNow(alert, { canary: () => ({ lastVerdict: 'down', lastRunAt: T0 + 60_000 }) })).toBe(false);
    expect(resolvedNow(alert, { canary: () => null })).toBe(false);
  });
});

describe('ntfy is optional; nothing secret leaves the canary', () => {
  it('no topic: a DOWN run exits 0, sends nothing, writes the 0600 state and the DOWN flag; recovery removes the flag', async () => {
    const t = tmp('rnb-canary-notopic-');
    const brainHome = path.join(t, 'brain');
    fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(brainHome, 'kb', 'forge-mcp-all.mjs'), STUB_WORKER);
    const state = path.join(t, 'state.json');
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(t, 'home'), RUVNET_BRAIN_HOME: brainHome,
      SEARCH_CANARY_STATE: state, SEARCH_CANARY_SERVER: SERVER, NTFY_TOPIC: '', NTFY_TOKEN: '' };
    const injected = { ...env, RUVNET_BRAIN_CANARY_INJECT: 'down' };
    expect((await runCanary([], injected)).code).toBe(0);
    expect(fs.existsSync(`${state}.down`)).toBe(false); // one failing run is not an outage
    const second = await runCanary([], injected);
    expect(second.code, second.out + second.err).toBe(0);
    expect(second.out).not.toMatch(/FAILED/);
    expect(fs.existsSync(`${state}.down`)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(state).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(state, 'utf8'))).toMatchObject({ lastVerdict: 'down', consecutiveFailures: 2 });
    const ok = await runCanary(['--deep'], env);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(fs.existsSync(`${state}.down`)).toBe(false);
  }, 90_000);

  it('the topic never reaches the state file or the output, even when a failure quotes it', async () => {
    const ntfy = await fakeNtfy();
    try {
      const t = tmp('rnb-canary-redact-');
      const state = path.join(t, 'state.json');
      const topic = 'secret-topic-4d2f9a';
      // The "server" is a file that prints the topic and exits: its failure text would carry the topic.
      const server = path.join(t, 'server.mjs');
      fs.writeFileSync(server, `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { message: 'boom ${topic}' } }) + '\\n');`);
      const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(t, 'home'), RUVNET_BRAIN_HOME: path.join(t, 'brain'),
        SEARCH_CANARY_STATE: state, SEARCH_CANARY_SERVER: server, NTFY_TOPIC: topic, NTFY_URL: ntfy.url, NTFY_TOKEN: '' };
      const a = await runCanary(['--deep'], env); const b = await runCanary(['--deep'], env);
      expect(a.out + b.out).toMatch(/DOWN/);
      expect(a.out + a.err + b.out + b.err).not.toContain(topic);
      expect(fs.readFileSync(state, 'utf8')).not.toContain(topic);
      expect(fs.readFileSync(state, 'utf8')).toContain('[redacted]');
      expect(ntfy.posts.map((p) => p.body).join('\n')).not.toContain(topic);
    } finally { ntfy.close(); }
  }, 90_000);

  it('an idle session that stays retriable backs the real search off (15, then 30 minutes), though every verdict is OK', async () => {
    const t = tmp('rnb-canary-backoff-');
    const brainHome = path.join(t, 'brain');
    fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true });
    fs.mkdirSync(path.join(brainHome, 'mcp-readiness.d'));
    fs.writeFileSync(path.join(brainHome, 'kb', 'forge-mcp-all.mjs'), STUB_WORKER);
    // This test process stands in for the idle session: degraded at start-up, its node runs now.
    fs.writeFileSync(path.join(brainHome, 'mcp-readiness.d', `${process.pid}.json`), JSON.stringify({ state: 'degraded', phase: 'initialize', error: 'brain worker exited', pid: process.pid, at: new Date().toISOString() }));
    const state = path.join(t, 'state.json');
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(t, 'home'), RUVNET_BRAIN_HOME: brainHome,
      SEARCH_CANARY_STATE: state, SEARCH_CANARY_SERVER: SERVER, NTFY_TOPIC: '', NTFY_TOKEN: '', SEARCH_CANARY_TRACE: '1' };
    const age = (min) => { const st = JSON.parse(fs.readFileSync(state, 'utf8')); fs.writeFileSync(state, JSON.stringify({ ...st, lastDeepAt: st.lastDeepAt - min * 60_000, lastDeepOkAt: st.lastDeepOkAt - min * 60_000 })); };
    const r1 = await runCanary([], env);
    expect(r1.err).toMatch(/deep due/);
    expect(r1.out).toMatch(/search-canary: OK/);
    age(20);
    const r2 = await runCanary([], env);
    expect(r2.err).toMatch(/deep due \(retry 15 min\)/);
    expect(r2.out).toMatch(/search-canary: OK/);
    age(20);
    const r3 = await runCanary([], env);
    expect(r3.err).toMatch(/deep not due \(retry 30 min\)/);
    expect(r3.out).toMatch(/search-canary: OK/);
  }, 120_000);

  it('the lock: held by a live owner, never by an empty or dead file, and released only by its owner', () => {
    const t = tmp('rnb-canary-lock-');
    const file = path.join(t, 'state.json');
    fs.writeFileSync(`${file}.lock`, ''); // a torn lock (created, never written)
    const release = takeLock(file);
    expect(release).toBeTypeOf('function');
    expect(takeLock(file)).toBe(null); // this process holds it now
    fs.writeFileSync(`${file}.lock`, `${process.pid}:other-owner`); // someone else's lock replaced ours
    release();
    expect(fs.existsSync(`${file}.lock`)).toBe(true); // not ours: never removed
    fs.writeFileSync(`${file}.lock`, '999999999:dead');
    const again = takeLock(file);
    expect(again).toBeTypeOf('function');
    again();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe('session start', () => {
  it('opens with SEARCH IS DOWN when the canary judged it down twice in the last half hour', () => {
    const home = tmp('rnb-canary-ss-');
    const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
    fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
    fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
    fs.writeFileSync(path.join(kb, 'x.rvf'), 'x');
    const file = path.join(home, '.cache', 'ruvnet-brain', 'search-canary.json');
    fs.writeFileSync(file, JSON.stringify({ lastVerdict: 'down', consecutiveFailures: 2, lastRunAt: Date.now(), failingSince: Date.now() - 600_000, lastReason: 'the worker died', lastCheck: 'run node -e 0' }));
    expect(health(home, false).problem).toMatch(/^SEARCH IS DOWN since .* ET \(search canary\): the worker died\. First thing to check: run node -e 0/);
    fs.writeFileSync(file, JSON.stringify({ lastVerdict: 'ok', consecutiveFailures: 0, lastRunAt: Date.now() }));
    expect(health(home, false).problem).toBe('');
  });
});
