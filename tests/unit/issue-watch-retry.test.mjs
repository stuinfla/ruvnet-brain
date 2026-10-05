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
  it('retries a failed page after successful acknowledgment without duplicating the comment', async () => {
    fetcher.mockResolvedValueOnce({ ok: false });
    await run({ now: NOW }); const first = read();
    expect(first.ackAt).toBeTruthy(); expect(first.newAlertAt).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ 38: { ...first, preserved: 'owner-field' } }));
    await run({ now: NOW + 60000 }); const next = read();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(ackCalls()).toHaveLength(1);
    expect(next.newAlertAt).toBe(new Date(NOW + 60000).toISOString());
    expect(next.ackAt).toBe(first.ackAt); expect(next.firstSeenAt).toBe(first.firstSeenAt);
    expect(next.preserved).toBe('owner-field');
    expect(ackCalls()[0][1].at(-1)).not.toMatch(/has been paged/);
  });
  it('acknowledgment never asserts page delivery when the notification request fails', async () => {
    fetcher.mockRejectedValueOnce(new Error('fixture network unavailable'));
    await run({ now: NOW });
    const body = ackCalls()[0][1].at(-1);
    expect(body).toMatch(/^🤖 Automated acknowledgment/);
    expect(body).not.toMatch(/has been paged/);
    expect(read().newAlertAt).toBeUndefined();
  });
  it('retries a failed acknowledgment without repeating a delivered page', async () => {
    ackStatus = 1; await run({ now: NOW }); const first = read();
    expect(first.newAlertAt).toBeTruthy(); expect(first.ackAt).toBeUndefined();
    ackStatus = 0; const nextRun = await run({ now: NOW + 60000 });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ackCalls()).toHaveLength(2);
    expect(read().newAlertAt).toBe(first.newAlertAt); expect(read().ackAt).toBeTruthy();
    expect(nextRun.alertsSent[0]).toMatchObject({ sent: true, acked: true, pageAttempted: false });
  });
  it('fresh sighting sends both once and fully delivered state never duplicates either', async () => {
    await run({ now: NOW }); const first = read();
    expect(first.ackAt).toBeTruthy(); expect(first.newAlertAt).toBeTruthy();
    await run({ now: NOW + 60000 }); expect(read()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ackCalls()).toHaveLength(1);
  });
  it('missing notification configuration retains pending page independently of acknowledgment', async () => {
    vi.stubEnv('NTFY_TOPIC', ''); await run({ now: NOW });
    expect(read().newAlertAt).toBeUndefined(); expect(read().ackAt).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv('NTFY_TOPIC', 'owned-fixture'); await run({ now: NOW + 60000 });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ackCalls()).toHaveLength(1);
  });
  it('dry-run never delivers or writes state and does not consume either obligation', async () => {
    await run({ now: NOW, dryRun: true });
    expect(fs.existsSync(file)).toBe(false); expect(fetcher).not.toHaveBeenCalled(); expect(ackCalls()).toHaveLength(0);
    await run({ now: NOW }); expect(read().newAlertAt).toBeTruthy(); expect(read().ackAt).toBeTruthy();
  });
  it('SLA escalation still excludes bot acknowledgment and preserves delivery fields', async () => {
    const first = { firstSeenAt: new Date(NOW - 600000).toISOString(), newAlertAt: new Date(NOW - 600000).toISOString(), ackAt: new Date(NOW - 600000).toISOString(), untouched: 1 };
    fs.writeFileSync(file, JSON.stringify({ 38: first })); comments = [{ author: { login: 'stuinfla' }, body: '🤖 Automated acknowledgment' }];
    const output = await run({ now: NOW + 5 * 3600000 });
    expect(output.results[0].breach).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ackCalls()).toHaveLength(0); expect(read()).toMatchObject(first); expect(read().lastAlertAt).toBeTruthy();
  });
});
