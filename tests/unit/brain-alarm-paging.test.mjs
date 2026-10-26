// tests/unit/brain-alarm-paging.test.mjs — the brain-down alarm must reach the phone, and only when it matters.
//
// THE DEFECTS (4.7.21, RC1.1 / RC1.7): kb/brain-alarm.mjs titled its pages "🚨 RuvNet Brain is DOWN" and
// "✅ RuvNet Brain recovered". fetch() refuses a non-ByteString header before sending, `catch → false` hid
// it, so the brain-down alarm had NEVER paged anyone. The moment that is fixed a second defect goes live: the
// throttle reset on every "up", so a flapping brain would page DOWN/RECOVERED on every flap. Both are fixed
// together and pinned here against a real local HTTP server (NTFY_URL), never ntfy.sh.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const T0 = Date.parse('2026-10-26T04:00:00Z');
let dir; let server; let requests; let alarm;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-alarm-'));
  requests = [];
  server = http.createServer((req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('NTFY_TOPIC', 'alarm-fixture'); vi.stubEnv('NTFY_URL', `http://127.0.0.1:${server.address().port}`);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.resetModules();
  alarm = await import('../../kb/brain-alarm.mjs');
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (ms) => vi.setSystemTime(new Date(T0 + ms));
const down = (ms) => { at(ms); return alarm.reportBrainDown({ error: 'ERR: every repo failed', source: 'test' }); };
const up = (ms) => { at(ms); return alarm.reportBrainUp({ source: 'test' }); };
const health = () => JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'ruvnet-brain', 'health.json'), 'utf8'));

describe('brain-alarm paging', () => {
  it('a sustained outage pages DOWN once with an ASCII title (before: zero pages, ever)', async () => {
    await down(0); await down(6 * MIN);
    expect(requests).toHaveLength(1);
    expect(requests[0].title).toMatch(/^[\x20-\x7e]+$/);
    expect(requests[0].title).toBe('RuvNet Brain is DOWN');
    expect(requests[0].priority).toBe('urgent');
    expect(health().status).toBe('down');
  });

  it('a single transient failure pages nothing, but the banner still sees it', async () => {
    await down(0);
    await up(MIN);
    expect(requests).toHaveLength(0);
    expect(health().status).toBe('ok');
  });

  it('two failures less than 5 minutes apart do not page yet', async () => {
    await down(0); await down(2 * MIN);
    expect(requests).toHaveLength(0);
    expect(health().status).toBe('down'); // the session banner is never damped
  });

  it('down / up / down within 6 h is ONE DOWN page; the recovery is announced once', async () => {
    await down(0); await down(6 * MIN);                 // page 1: DOWN
    await up(20 * MIN);                                 // page 2: recovered (paged outage, lasted 20 min)
    await down(30 * MIN); await down(40 * MIN);         // second outage, within 6 h of the last DOWN page
    await up(60 * MIN);                                 // its DOWN never paged, so no recovery either
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN', 'RuvNet Brain recovered']);
    await down(7 * 60 * MIN); await down(7 * 60 * MIN + 6 * MIN); // more than 6 h later: pages again
    expect(requests).toHaveLength(3);
  });

  it('a paged outage shorter than 10 minutes recovers silently', async () => {
    await down(0); await down(5 * MIN);
    await up(8 * MIN);
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
  });

  it('NTFY_TOPIC="" sends nothing even with a topic file present (before: the file was used)', async () => {
    vi.stubEnv('NTFY_TOPIC', '');
    fs.mkdirSync(path.join(dir, '.cache', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cache', 'ruvnet-brain', 'ntfy-topic'), 'file-topic');
    await down(0); await down(6 * MIN);
    expect(requests).toHaveLength(0);
    expect(health().status).toBe('down');
  });

  it('an HTTP error is not a delivered page: it is retried on the next failure', async () => {
    let first = true;
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); res.statusCode = first ? 429 : 200; first = false; res.end(); }); });
    await down(0); await down(6 * MIN); await down(7 * MIN);
    expect(requests).toHaveLength(2);
    await down(8 * MIN);
    expect(requests).toHaveLength(2); // delivered once; quiet after that
  });

  // 4.7.21 review (Fable P2-1): every "up" reset the outage, so a flapping brain never paged.
  it('a brain that flaps down/up every 2 minutes pages DOWN once in 6 h (before: zero pages)', async () => {
    for (let t = 0; t < 6 * 60 * MIN; t += 4 * MIN) { await down(t); await up(t + 2 * MIN); }
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
  });

  it('4-minute outages with a minute of health between them page DOWN once in 6 h; the flaps recover silently', async () => {
    for (let t = 0; t < 6 * 60 * MIN; t += 6 * MIN) { await down(t); await down(t + 4 * MIN); await up(t + 5 * MIN); }
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
  });

  it('failures more than an hour apart are not a flap: one blip a day never pages', async () => {
    for (let d = 0; d < 3; d++) { await down(d * 24 * 60 * MIN); await up(d * 24 * 60 * MIN + MIN); }
    await down(3 * 24 * 60 * MIN); await up(3 * 24 * 60 * MIN + 61 * MIN); await down(3 * 24 * 60 * MIN + 62 * MIN);
    expect(requests).toHaveLength(0);
  });

  // 4.7.21 review (Opus #3): read -> await push -> write was not atomic; parallel failing searches all paged.
  it('three parallel failing searches in one process page ONCE (before: three pages)', async () => {
    await down(0);
    at(10 * MIN);
    await Promise.all([1, 2, 3].map(() => alarm.reportBrainDown({ error: 'ERR: every repo failed', source: 'parallel' })));
    expect(requests).toHaveLength(1);
    expect(health().downPaged).toBe(true);
  });

  it('an undelivered claimed page is released: the next failure retries it', async () => {
    let first = true;
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); res.statusCode = first ? 503 : 200; first = false; res.end(); }); });
    await down(0);
    at(10 * MIN);
    await Promise.all([1, 2, 3].map(() => alarm.reportBrainDown({ error: 'ERR', source: 'parallel' })));
    expect(requests).toHaveLength(1); // one claimed attempt, refused
    expect(health().downPaged).toBe(false);
    await down(11 * MIN);
    expect(requests).toHaveLength(2);
    expect(health().downPaged).toBe(true);
  });

  it('a claim abandoned by a killed sender does not swallow the page for 6 h', async () => {
    await down(0);
    const file = path.join(dir, '.cache', 'ruvnet-brain', 'health.json');
    const h = health();
    fs.writeFileSync(file, JSON.stringify({ ...h, downPaged: 'pending', lastDownPageAt: T0 + 5 * MIN, claimPrevPageAt: 0 }));
    await down(5 * MIN + 30_000); // claim still fresh (sender may be mid-POST): no second page
    expect(requests).toHaveLength(0);
    await down(7 * MIN);          // claim older than 60 s: abandoned, page now
    expect(requests).toHaveLength(1);
  });

  // Review round 2 (Codex r4 #4): the "ok" record dropped the pending claim but kept its timestamp, so a claim whose
  // sender died mid-POST and was followed by one good search silenced every DOWN page for 6 h.
  it('a claim abandoned across a recovery is still released: the next outage pages (before: silent for 6 h)', async () => {
    await down(0);
    const file = path.join(dir, '.cache', 'ruvnet-brain', 'health.json');
    fs.writeFileSync(file, JSON.stringify({ ...health(), downPaged: 'pending', lastDownPageAt: T0 + 5 * MIN, claimPrevPageAt: 0 }));
    await up(5 * MIN + 10_000);   // the sender is dead; one good search lands
    expect(health().status).toBe('ok');
    await down(20 * MIN); await down(26 * MIN);
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
    expect(health().downPaged).toBe(true);
  });

  it('a claim still in flight survives a recovery: the up does not let a second sender page', async () => {
    await down(0);
    const file = path.join(dir, '.cache', 'ruvnet-brain', 'health.json');
    fs.writeFileSync(file, JSON.stringify({ ...health(), downPaged: 'pending', lastDownPageAt: T0 + 6 * MIN, claimPrevPageAt: 0 }));
    await up(6 * MIN + 5_000);
    await down(6 * MIN + 20_000); await down(6 * MIN + 30_000); // claim 30 s old: its sender may still be mid-POST
    expect(requests).toHaveLength(0);
  });

  // Review round 2 (Codex r4 #5): only the newest 50 failures were kept, so failures every few seconds never spanned the
  // 5-minute confirm window and a brain flapping that fast never paged.
  it('a brain failing every 4 seconds with good searches in between pages DOWN once (before: zero pages in 20 min)', async () => {
    for (let t = 0; t < 20 * MIN; t += 4_000) { await down(t); await up(t + 2_000); }
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
    expect(health().recentFails.length).toBeLessThanOrEqual(50);
  });

  // Review round 2 (Opus #8): a recovery that landed while the DOWN page was in flight lost its "recovered" note.
  it('a DOWN page delivered while the brain recovered still earns its recovery note (outage >= 10 min)', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', async () => { requests.push(req.headers);
      if (requests.length === 1) await held; res.end('{}'); }); });
    await down(0);
    const paging = down(10 * MIN);                       // claims, then waits on the held POST
    while (requests.length === 0) await new Promise((r) => setImmediate(r));
    await up(12 * MIN);                                  // recovery lands mid-POST: it cannot know the page arrived
    expect(requests).toHaveLength(1);
    release(); await paging;
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN', 'RuvNet Brain recovered']);
    expect(health().status).toBe('ok');
    expect(health().downPaged).toBeUndefined();
    await down(13 * MIN); await down(19 * MIN);          // the 6 h DOWN-page memory still holds
    expect(requests).toHaveLength(2);
  });

  it('a short outage recovered mid-POST stays quiet, and a refused mid-POST page is released for the next outage', async () => {
    let release; let status = 200;
    const held = new Promise((r) => { release = r; });
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', async () => { requests.push(req.headers);
      if (requests.length === 1) await held; res.statusCode = status; res.end('{}'); }); });
    await down(0);
    const paging = down(6 * MIN);
    while (requests.length === 0) await new Promise((r) => setImmediate(r));
    await up(7 * MIN);                                   // a 7-minute outage: no recovery note
    status = 503; release(); await paging;               // ...and the page was refused
    expect(requests).toHaveLength(1);
    expect(health().lastDownPageAt).toBe(0);             // claim released, not kept for 6 h
    status = 200;
    await down(30 * MIN); await down(36 * MIN);
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN', 'RuvNet Brain is DOWN']);
  });
});

describe('brain-alarm across processes', () => {
  it('three PROCESSES failing at once page ONCE', async () => {
    vi.useRealTimers();
    const stateDir = path.join(dir, '.cache', 'ruvnet-brain');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, 'health.json'), JSON.stringify({ status: 'down', firstDownTs: now - 10 * MIN, failCount: 1,
      recentFails: [now - 10 * MIN], lastDownPageAt: 0, downPaged: false }));
    // Slow the stub so every process is mid-POST together (the window the old code double-paged in).
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); setTimeout(() => res.end('{}'), 300); }); });
    const mod = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kb', 'brain-alarm.mjs');
    const go = path.join(dir, 'go');
    const script = `import fs from 'node:fs'; while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
const a = await import(${JSON.stringify(new URL(`file://${mod}`).href)}); await a.reportBrainDown({ error: 'ERR', source: 'proc' });`;
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, NTFY_TOPIC: 'alarm-fixture', NTFY_URL: process.env.NTFY_URL };
    const kids = [1, 2, 3].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: 'ignore' }));
    const exits = kids.map((k) => new Promise((r) => k.on('exit', r)));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(go, '');
    expect(await Promise.all(exits)).toEqual([0, 0, 0]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'health.json'), 'utf8')).downPaged).toBe(true);
  }, 20_000);
});
