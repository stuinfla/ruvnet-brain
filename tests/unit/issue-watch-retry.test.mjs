import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const NOW = Date.parse('2026-10-05T12:00:00Z');
let dir, file, run, fetcher, ackStatus, comments;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-watch-retry-'));
  file = path.join(dir, 'state.json');
  vi.stubEnv('ISSUE_WATCH_STATE', file); vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir); vi.stubEnv('NTFY_TOPIC', 'owned-fixture');
  vi.resetModules(); ackStatus = 0; comments = [];
  vi.mocked(spawnSync).mockReset().mockImplementation((bin, args) => {
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ number: 38, title: 'fixture', createdAt: new Date(NOW - 3600000).toISOString() }]) };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments }) };
    if (args[1] === 'comment') return { status: ackStatus, stdout: '' };
    throw new Error('unexpected external command');
  });
  fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher);
  ({ run } = await import('../../scripts/issue-watch.mjs'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))['38'];
const ackCalls = () => vi.mocked(spawnSync).mock.calls.filter(c => c[1][1] === 'comment');
describe('watcher channel delivery is independent across consecutive runs', () => {
  // Since 2026-10-25 the arrival page belongs to .github/workflows/ntfy-alerts.yml (it fired twice before); the
  // watcher still posts the one public acknowledgment, retried independently until delivered.
  it('the watcher sends no arrival page and acknowledges once', async () => {
    await run({ now: NOW }); const first = read();
    expect(fetcher).not.toHaveBeenCalled();
    expect(first.ackAt).toBeTruthy(); expect(first.newAlertAt).toBeUndefined();
    await run({ now: NOW + 60000 }); expect(read()).toEqual(first);
    expect(ackCalls()).toHaveLength(1);
  });
  it('the acknowledgment never claims anyone was paged', async () => {
    await run({ now: NOW });
    const body = ackCalls()[0][1].at(-1);
    expect(body).toMatch(/^🤖 Automated acknowledgment/);
    expect(body).not.toMatch(/has been paged/);
  });
  it('a failed acknowledgment is retried next run, keeping fields it already has', async () => {
    ackStatus = 1; await run({ now: NOW });
    expect(read()?.ackAt).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ 38: { ...read(), preserved: 'owner-field' } }));
    ackStatus = 0; await run({ now: NOW + 60000 });
    expect(ackCalls()).toHaveLength(2); expect(read().ackAt).toBeTruthy(); expect(read().preserved).toBe('owner-field');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('dry-run never delivers or writes state and does not consume the acknowledgment', async () => {
    await run({ now: NOW, dryRun: true });
    expect(fs.existsSync(file)).toBe(false); expect(fetcher).not.toHaveBeenCalled(); expect(ackCalls()).toHaveLength(0);
    await run({ now: NOW }); expect(read().ackAt).toBeTruthy();
  });
  it('SLA escalation still excludes bot acknowledgment and preserves delivery fields', async () => {
    const first = { firstSeenAt: new Date(NOW - 600000).toISOString(), newAlertAt: new Date(NOW - 600000).toISOString(), ackAt: new Date(NOW - 600000).toISOString(), untouched: 1 };
    fs.writeFileSync(file, JSON.stringify({ 38: first })); comments = [{ author: { login: 'stuinfla' }, body: '🤖 Automated acknowledgment' }];
    const output = await run({ now: NOW + 5 * 3600000 });
    expect(output.results[0].breach).toBe(true);
    // The one SLA page (a 1 p.m. ET run may also carry the once-a-day summary, counted separately since 2026-10-25).
    expect(fetcher.mock.calls.filter(([, init]) => /^SLA breach/.test(init?.headers?.Title || ''))).toHaveLength(1);
    expect(ackCalls()).toHaveLength(0); expect(read()).toMatchObject(first); expect(read().lastAlertAt).toBeTruthy();
  });
});

// issue-fix shares the watcher's transient-error rule (4.7.21): a 1 a.m. "error connecting to api.github.com" or an
// HTTP 502 must not fail the run and page the phone.
describe('issue-fix retries a transient GitHub failure', () => {
  it.each(['error connecting to api.github.com', 'HTTP 502: Bad Gateway', 'net/http: TLS handshake timeout'])('%s', async (stderr) => {
    let lists = 0;
    vi.mocked(spawnSync).mockReset().mockImplementation((bin, args) => {
      if (bin === 'sleep') return { status: 0 };
      if (args[1] === 'list') { lists += 1; return lists === 1 ? { status: 1, stderr } : { status: 0, stdout: '[]' }; }
      throw new Error('unexpected external command');
    });
    vi.resetModules();
    const fix = await import('../../scripts/issue-fix.mjs');
    const out = await fix.run({ now: NOW }); // before: threw on the first failure for the first two messages
    expect(lists).toBe(2);
    expect(out.results).toEqual([]);
  });
  it('a non-transient failure still fails loudly, after one attempt', async () => {
    let lists = 0;
    vi.mocked(spawnSync).mockReset().mockImplementation((bin, args) => {
      if (bin === 'sleep') return { status: 0 };
      if (args[1] === 'list') { lists += 1; return { status: 1, stderr: 'HTTP 401: Bad credentials' }; }
      throw new Error('unexpected external command');
    });
    vi.resetModules();
    const fix = await import('../../scripts/issue-fix.mjs');
    await expect(fix.run({ now: NOW })).rejects.toThrow(/Bad credentials/);
    expect(lists).toBe(1);
  });
});
