/**
 * The SHIPPED spend watchdog (bin/api-spend-watchdog.mjs) pages on a CHANGE, never every hour.
 *
 * THE INCIDENT (2026-10-25): detector 3 paged every hour for as long as any com.ruvnet.* job's last exit
 * was non-zero — 31 consecutive hourly alerts, 2,157 alert lines on the owner's Mac — because the nightly
 * watchdog exits non-zero by design while anything is red, so the condition never cleared. The owner's
 * local copy was fixed that night; the copy this package SHIPS (and that `--enable-spend-guard` installs)
 * still had the flood. These tests run the real script as a subprocess in a throwaway HOME with stub
 * `launchctl` / `osascript` binaries on PATH and a recording fetch, so no page ever leaves the machine.
 *
 * "Hour 2" is simulated by ageing the cooldown stamp two hours, so a still-failing job is judged on the
 * transition rule alone, not hidden by the one-hour cooldown.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WATCHDOG = process.env.SPEND_WATCHDOG_UNDER_TEST || path.join(ROOT, 'bin', 'api-spend-watchdog.mjs');
const temps = [];
afterEach(() => temps.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-watchdog-'));
  temps.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, 'Code'), { recursive: true }); // the default scan root exists: not blind
  fs.mkdirSync(bin);
  const listing = path.join(root, 'launchctl-list.txt');
  const desktop = path.join(root, 'desktop.log');
  const posts = path.join(root, 'posts.jsonl');
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\ncat ${JSON.stringify(listing)}\n`, { mode: 0o755 });
  // osascript stub: records one line per desktop notification; OSASCRIPT_FAIL=1 makes the channel fail.
  fs.writeFileSync(path.join(bin, 'osascript'),
    `#!/bin/sh\nif [ "$OSASCRIPT_FAIL" = 1 ]; then exit 1; fi\necho "$2" >> ${JSON.stringify(desktop)}\n`, { mode: 0o755 });
  // A fetch that behaves like undici on headers (new Headers throws on a non-ByteString) and records the
  // POST instead of sending it. Nothing reaches ntfy.sh.
  const stub = path.join(root, 'fetch-stub.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs';
globalThis.fetch = async (url, init = {}) => {
  // The Admin Cost API answers with STUB_COST_STATUS (default 200, an empty report); it is not a page.
  if (String(url).startsWith('https://api.anthropic.com/')) {
    const status = Number(process.env.STUB_COST_STATUS || 200);
    return { ok: status < 400, status, json: async () => ({ data: [] }) };
  }
  let title;
  try { title = new Headers(init.headers).get('title'); }
  catch (error) { fs.appendFileSync(${JSON.stringify(posts)}, JSON.stringify({ threw: error.message }) + '\\n'); throw error; }
  fs.appendFileSync(${JSON.stringify(posts)}, JSON.stringify({ url: String(url), title }) + '\\n');
  return { ok: true, status: 200 };
};
`);
  const listingRows = (rows) => fs.writeFileSync(listing,
    `PID\tStatus\tLabel\n${rows.map(([pid, status, label]) => `${pid}\t${status}\t${label}`).join('\n')}\n`);
  const run = (extraEnv = {}) => {
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: os.tmpdir(), ...extraEnv };
    return spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, WATCHDOG], { encoding: 'utf8', env, timeout: 30_000 });
  };
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
  const stamp = path.join(home, '.claude', 'logs', 'api-spend-watchdog-last.ts');
  const ageCooldown = () => { if (fs.existsSync(stamp)) fs.writeFileSync(stamp, new Date(Date.now() - 2 * 3600_000).toISOString()); };
  const heartbeat = (label) => {
    const dir = path.join(home, '.cache', 'ruvnet-brain', 'heartbeats');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${label}.json`), '{"state":"failed"}\n');
  };
  return { root, home, run, listingRows, desktopAlerts: () => lines(desktop), posts: () => lines(posts).map((l) => JSON.parse(l)),
    ageCooldown, heartbeat, stamp };
}

describe('detector 3 pages on a transition, not every hour', () => {
  it('a persistently failing job that the heartbeat wrapper already watches: 0 alerts over 3 hours', () => {
    const s = sandbox();
    s.heartbeat('com.ruvnet.nightly-watchdog');
    s.listingRows([['-', '1', 'com.ruvnet.nightly-watchdog']]);
    for (let hour = 0; hour < 3; hour++) {
      expect(s.run().status).toBe(0);
      s.ageCooldown();
    }
    expect(s.desktopAlerts()).toHaveLength(0); // before: 3 (one every hour)
  });

  it('a NEW unwrapped failing job: exactly 1 alert in hour 1, 0 in hours 2 and 3 while it stays failing', () => {
    const s = sandbox();
    s.listingRows([['-', '0', 'com.ruvnet.healthy'], ['-', '78', 'com.stuartkerr.unwatched']]);
    const r1 = s.run();
    expect(r1.status).toBe(0);
    expect(s.desktopAlerts()).toHaveLength(1);
    expect(s.desktopAlerts()[0]).toMatch(/com\.stuartkerr\.unwatched \(exit 78\)/);
    s.ageCooldown();
    s.run();
    s.ageCooldown();
    s.run();
    expect(s.desktopAlerts()).toHaveLength(1); // before: 3
  });

  it('a running KeepAlive daemon whose last exit was -9 is not "failing": 0 alerts', () => {
    const s = sandbox();
    s.listingRows([['4242', '-9', 'com.ruvnet.ruos-proxy']]);
    s.run();
    s.ageCooldown();
    s.run();
    expect(s.desktopAlerts()).toHaveLength(0); // before: 1 per hour
  });

  it('a job that recovers and fails again pages again (the transition, both ways)', () => {
    const s = sandbox();
    s.listingRows([['-', '1', 'com.isovision.job']]);
    s.run();
    s.ageCooldown();
    s.listingRows([['-', '0', 'com.isovision.job']]);
    s.run();
    s.ageCooldown();
    s.listingRows([['-', '1', 'com.isovision.job']]);
    s.run();
    expect(s.desktopAlerts()).toHaveLength(2);
  });
});

describe('delivery is derived, never assumed', () => {
  it('when no channel delivers: no cooldown is recorded, the run exits 1, and the next run retries', () => {
    const s = sandbox();
    s.listingRows([['-', '1', 'com.ruvnet.unwatched']]);
    const first = s.run({ OSASCRIPT_FAIL: '1' });
    expect(first.status).toBe(1);
    expect(first.stderr).toMatch(/DELIVERY FAILED/);
    expect(fs.existsSync(s.stamp)).toBe(false); // before: the stamp was written BEFORE delivery was tried
    const second = s.run(); // the desktop channel works again, within the same hour
    expect(second.status).toBe(0);
    expect(s.desktopAlerts()).toHaveLength(1); // before: 0 — swallowed by a cooldown nothing earned
  });

  it('every ntfy title is a valid header: the runaway-fleet page actually leaves (no ByteString throw)', () => {
    const s = sandbox();
    const headless = path.join(s.home, 'Code', 'proj', '.claude-flow', 'logs', 'headless');
    fs.mkdirSync(headless, { recursive: true });
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(headless, `agent-${i}.log`), 'x');
    s.listingRows([]);
    const r = s.run({ AIE_NTFY_TOPIC: 'test-topic-not-real' });
    expect(r.status).toBe(0);
    const posts = s.posts();
    expect(posts.filter((p) => p.threw)).toEqual([]); // before: "Cannot convert argument to a ByteString"
    expect(posts).toHaveLength(1);
    expect(posts[0].title).toMatch(/^RUNAWAY AGENT FLEET/);
    expect(posts[0].title).toMatch(/^[\x20-\x7e]+$/);
  });

  it('a scanner that could read no project root is BLIND and exits 1, never "healthy"', () => {
    const s = sandbox();
    s.listingRows([]);
    const r = s.run({ SPEND_SCAN_ROOTS: path.join(s.root, 'no-such-root') });
    expect(r.status).toBe(1); // before: 0, "headless agents in last hour: 0"
    expect(r.stderr).toMatch(/BLIND/);
  });
});

describe('the shipped copy reads only its own topic config', () => {
  it('never reads another project\'s .env for a topic', () => {
    const s = sandbox();
    const other = path.join(s.home, 'Code', 'All In Expert');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, '.env'), 'AIE_NTFY_TOPIC=would-leak\n');
    s.listingRows([['-', '1', 'com.ruvnet.unwatched']]);
    s.run();
    expect(s.posts()).toEqual([]); // no topic of its own -> no phone page at all
    expect(s.desktopAlerts()).toHaveLength(1);
  });

  it('uses ~/.cache/ruvnet-brain/ntfy-topic when present', () => {
    const s = sandbox();
    const cfg = path.join(s.home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'ntfy-topic'), '# comment\ntopic-from-own-config\n');
    s.listingRows([['-', '1', 'com.ruvnet.unwatched']]);
    s.run();
    expect(s.posts()).toHaveLength(1);
    expect(s.posts()[0].url).toBe('https://ntfy.sh/topic-from-own-config');
  });
});

describe('a dead admin key pages on the transition, not every hour (4.7.21 review P1-2)', () => {
  const KEY = { ANTHROPIC_ADMIN_KEY: 'sk-ant-admin-test-not-real' };
  for (const code of ['401', '403']) {
    it(`HTTP ${code}: 1 page over 4 hourly runs, every run exits 1; recovery: exactly 1 note; a later death pages again`, () => {
      const s = sandbox();
      s.listingRows([]);
      const statuses = [];
      for (let hour = 0; hour < 4; hour++) {
        const r = s.run({ ...KEY, STUB_COST_STATUS: code });
        statuses.push(r.status);
        s.ageCooldown(); // judge each hour on the transition rule, not the 1-hour cooldown
      }
      expect(statuses).toEqual([1, 1, 1, 1]); // still degraded every hour, so the wrapper and watchdog see it
      expect(s.desktopAlerts()).toHaveLength(1); // before: 4 (one every hour)
      expect(s.desktopAlerts()[0]).toMatch(/ADMIN_KEY is DEAD/);
      for (let hour = 0; hour < 3; hour++) {
        expect(s.run({ ...KEY, STUB_COST_STATUS: '200' }).status).toBe(0);
        s.ageCooldown();
      }
      expect(s.desktopAlerts()).toHaveLength(2);
      expect(s.desktopAlerts()[1]).toMatch(/works again/);
      s.run({ ...KEY, STUB_COST_STATUS: code });
      expect(s.desktopAlerts()).toHaveLength(3);
      expect(s.desktopAlerts()[2]).toMatch(/ADMIN_KEY is DEAD/);
    });
  }

  it('an undelivered dead-key page is retried next run (state flips only on delivery)', () => {
    const s = sandbox();
    s.listingRows([]);
    expect(s.run({ ...KEY, STUB_COST_STATUS: '401', OSASCRIPT_FAIL: '1' }).status).toBe(1);
    expect(s.desktopAlerts()).toHaveLength(0);
    expect(s.run({ ...KEY, STUB_COST_STATUS: '401' }).status).toBe(1);
    expect(s.desktopAlerts()).toHaveLength(1);
  });

  // Review round 2 (Opus #4): the "works again" note earned the shared one-hour cooldown, so a spend alert in the
  // same run was swallowed for up to an hour.
  it('the key-recovery note does not hold back a spend-over-threshold alert in the same run', () => {
    const s = sandbox();
    s.listingRows([]);
    expect(s.run({ ...KEY, STUB_COST_STATUS: '401' }).status).toBe(1);
    s.ageCooldown();
    // Key works again AND today's spend is at the threshold (the stub reports $0; the threshold is $0).
    const r = s.run({ ...KEY, STUB_COST_STATUS: '200', SPEND_ALERT_USD: '0' });
    expect(r.status, r.stderr).toBe(0);
    const alerts = s.desktopAlerts();
    expect(alerts).toHaveLength(3); // before: 2 (the spend alert "in cooldown")
    expect(alerts[1]).toMatch(/works again/);
    expect(alerts[2]).toMatch(/API spend today = \$0\.00/);
    expect(r.stdout).not.toMatch(/in cooldown/);
    // The spend alarm keeps its own one-hour limit: the next run inside the hour does not repeat it.
    s.run({ ...KEY, STUB_COST_STATUS: '200', SPEND_ALERT_USD: '0' });
    expect(s.desktopAlerts()).toHaveLength(3);
  });

  it('a working key never pages, and a network error is not a dead key', () => {
    const s = sandbox();
    s.listingRows([]);
    expect(s.run({ ...KEY, STUB_COST_STATUS: '200' }).status).toBe(0);
    expect(s.run({ ...KEY, STUB_COST_STATUS: '500' }).status).toBe(0);
    expect(s.desktopAlerts()).toHaveLength(0);
  });
});
