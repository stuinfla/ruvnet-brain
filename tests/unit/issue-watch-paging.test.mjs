// issue-watch-paging.test.mjs — how often the issue watcher may page (owner, 2026-10-25: 10,747 notifications on
// one topic; most were "SLA breach" re-pages every 4 h for ~14 old issues, including the owner's own Dream Cycle
// issues). The rule now: a person's issue pages when it arrives and once more if it passes the 4 h SLA unanswered;
// an issue the owner's automation opened never pages; everything still waiting goes into ONE morning summary.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn(), spawn: vi.fn() }));

const START = Date.parse('2026-10-25T05:30:00Z'); // 1:30 a.m. ET, so the day holds exactly one 9 a.m.
const HOUR = 3_600_000;
let dir, run, digestDue, fetcher, issues;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-watch-paging-'));
  vi.stubEnv('ISSUE_WATCH_STATE', path.join(dir, 'state.json')); vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('NTFY_TOPIC', 'owned-fixture');
  vi.resetModules();
  issues = [
    { number: 301, title: 'a person waiting', createdAt: new Date(START - 40 * 24 * HOUR).toISOString(), author: { login: 'HF-teamdev' } },
    { number: 494, title: 'Dream Cycle self-report', createdAt: new Date(START - 5 * HOUR).toISOString(), author: { login: 'stuinfla' } },
    { number: 478, title: 'bump vite', createdAt: new Date(START - 5 * HOUR).toISOString(), author: { login: 'app/dependabot', is_bot: true } },
  ];
  vi.mocked(spawnSync).mockReset().mockImplementation((bin, args) => {
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: [] }) };
    if (args[1] === 'comment') return { status: 0, stdout: '' };
    throw new Error('unexpected external command');
  });
  fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher);
  ({ run, digestDue } = await import('../../scripts/issue-watch.mjs'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
const pages = () => fetcher.mock.calls.map(([, init]) => init?.headers?.Title || init?.headers?.title || '');

describe('issue watcher paging frequency', () => {
  it('a full day of hourly runs: a few clear pages, not dozens', async () => {
    for (let h = 0; h < 24; h += 1) await run({ now: START + h * HOUR });
    const titles = pages();
    // #301: one SLA page, then silence (arrival is paged by the GitHub workflow). Owner/bot issues: nothing.
    expect(titles.filter((t) => /#301/.test(t))).toHaveLength(1);
    expect(titles.some((t) => /#494|#478/.test(t))).toBe(false);
    // One morning summary (9 a.m. ET = 13:00 UTC), naming the person still waiting.
    expect(titles.filter((t) => /^Waiting on a reply/.test(t))).toHaveLength(1);
    expect(titles.length).toBe(2);
    // The bot never posts an acknowledgment on the owner's own issues.
    const commented = vi.mocked(spawnSync).mock.calls.filter((c) => c[1][1] === 'comment').map((c) => c[1][2]);
    expect(commented).toEqual(['301']);
  });
  it('the summary is once per Eastern day, from 9 a.m.', () => {
    expect(digestDue(undefined, Date.parse('2026-10-25T12:59:00Z')).due).toBe(false); // 8:59 a.m. EDT
    const at9 = digestDue(undefined, Date.parse('2026-10-25T13:00:00Z'));
    expect(at9).toEqual({ due: true, day: '2026-10-25' });
    expect(digestDue('2026-10-25', Date.parse('2026-10-25T20:00:00Z')).due).toBe(false);
    expect(digestDue('2026-10-25', Date.parse('2026-10-26T13:05:00Z')).due).toBe(true);
  });
  it('nothing waiting means no summary', async () => {
    issues = issues.filter((i) => i.number !== 301);
    for (let h = 0; h < 24; h += 1) await run({ now: START + h * HOUR });
    expect(pages()).toEqual([]);
  });
});

// 4.7.21 (RC1.5): 17 "SLA breach" pages landed within 11 s on Oct 25 when the watcher replayed every open breach
// at once. One run now sends at most ONE combined page, whatever the state file says.
describe('a burst of breaches is one page', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ number: 600 + i, title: `person issue ${i}`,
    createdAt: new Date(START - (10 + i) * HOUR).toISOString(), author: { login: `person${i}` } }));
  const ackedComments = [{ author: { login: 'stuinfla' }, body: '🤖 Automated acknowledgment — received and opened.' }];

  it('17 breaching issues with an empty state file produce exactly 1 request (before: 17)', async () => {
    issues = many(17);
    await run({ now: START });
    const titles = pages();
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatch(/^SLA breach: issue #\d+ \(\+16 more/);
    expect(titles[0]).toMatch(/^[\x20-\x7e]+$/);
    const body = fetcher.mock.calls[0][1].body;
    expect(body.split('\n').filter((l) => /^#\d+/.test(l)).length).toBeLessThanOrEqual(8); // bounded body
    await run({ now: START + HOUR });
    expect(pages()).toHaveLength(1); // every one of them is now recorded as paged
  });

  it('an unreadable state file baselines silently: one page, and no public re-acknowledgment of acked issues', async () => {
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
    issues = many(5);
    vi.mocked(spawnSync).mockImplementation((bin, args) => {
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
      if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: ackedComments }) };
      if (args[1] === 'comment') return { status: 0, stdout: '' };
      throw new Error('unexpected external command');
    });
    await run({ now: START });
    expect(pages()).toHaveLength(1);
    const commented = vi.mocked(spawnSync).mock.calls.filter((c) => c[1][1] === 'comment');
    expect(commented).toHaveLength(0); // before: 5 duplicate public comments
  });

  it('a page that fails is retried next run as the same single combined page', async () => {
    issues = many(4);
    fetcher.mockResolvedValueOnce({ ok: false, status: 429 });
    await run({ now: START });
    await run({ now: START + HOUR });
    expect(pages()).toHaveLength(2);
    await run({ now: START + 2 * HOUR });
    expect(pages()).toHaveLength(2);
  });

  it('one issue whose detail lookup fails is skipped, not the whole run', async () => {
    issues = many(3);
    vi.mocked(spawnSync).mockImplementation((bin, args) => {
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
      if (args[1] === 'view' && args[2] === '601') return { status: 1, stderr: 'HTTP 404: Not Found' };
      if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: [] }) };
      if (args[1] === 'comment') return { status: 0, stdout: '' };
      throw new Error('unexpected external command');
    });
    const out = await run({ now: START }); // before: threw, so nothing was judged or paged
    expect(out.results.map((r) => r.number)).toEqual([600, 602]);
    expect(out.degraded).toEqual([601]);
    expect(pages()).toHaveLength(1);
  });

  it('a transient GitHub error is retried with backoff instead of failing the run', async () => {
    issues = many(1);
    let lists = 0;
    vi.mocked(spawnSync).mockImplementation((bin, args) => {
      if (bin === 'sleep') return { status: 0 };
      if (args[1] === 'list') { lists += 1; return lists < 3 ? { status: 1, stderr: 'error connecting to api.github.com' } : { status: 0, stdout: JSON.stringify(issues) }; }
      if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: [] }) };
      if (args[1] === 'comment') return { status: 0, stdout: '' };
      throw new Error('unexpected external command');
    });
    const out = await run({ now: START }); // before: "error connecting" was not transient — the run failed
    expect(lists).toBe(3);
    expect(out.results).toHaveLength(1);
    const sleeps = vi.mocked(spawnSync).mock.calls.filter((c) => c[0] === 'sleep').map((c) => Number(c[1][0]));
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]); // backoff, not a fixed wait
  });
});

// 4.7.21 review (Opus pager #4): an issue whose detail can never be read was skipped every run with exit 0 — a person
// waiting forever with no SLA page.
describe('an issue whose detail cannot be read is still judged', () => {
  const failView = (numbers) => vi.mocked(spawnSync).mockImplementation((bin, args) => {
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
    if (args[1] === 'view' && numbers.includes(args[2])) return { status: 1, stderr: 'GraphQL: Something went wrong (HTTP 500)' };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: [] }) };
    if (args[1] === 'comment') return { status: 0, stdout: '' };
    throw new Error('unexpected external command');
  });

  it('a breaching person issue with unreadable detail gets its SLA page from the list comments, and no public ack', async () => {
    issues = [{ number: 700, title: 'unreadable detail', createdAt: new Date(START - 30 * HOUR).toISOString(), author: { login: 'alice' }, comments: [] }];
    failView(['700']);
    const out = await run({ now: START });
    expect(out.degraded).toEqual([700]);
    expect(out.results.map((r) => r.number)).toEqual([700]);
    expect(pages()).toEqual(['SLA breach: issue #700']); // before: [] — skipped, never paged
    expect(vi.mocked(spawnSync).mock.calls.filter((c) => c[1][1] === 'comment')).toHaveLength(0);
    await run({ now: START + HOUR });
    expect(pages()).toHaveLength(1); // once, like any other breach
  });

  it('an owner reply visible in the list comments counts: no page', async () => {
    issues = [{ number: 701, title: 'answered', createdAt: new Date(START - 30 * HOUR).toISOString(), author: { login: 'alice' },
      comments: [{ author: { login: 'stuinfla' }, body: 'Looking now.' }] }];
    failView(['701']);
    await run({ now: START });
    expect(pages()).toEqual([]);
  });

  it('with no list comments either, the run reports it unreadable ONCE, on the 3rd run in a row', async () => {
    issues = [{ number: 702, title: 'nothing readable', createdAt: new Date(START - 30 * HOUR).toISOString(), author: { login: 'alice' } }];
    failView(['702']);
    const seen = [];
    for (let h = 0; h < 5; h++) seen.push((await run({ now: START + h * HOUR })).unreadable);
    expect(seen).toEqual([[], [], [702], [], []]); // before: undefined every run (silently skipped forever)
    // Readable again: the streak resets, so a later outage escalates again.
    failView([]);
    await run({ now: START + 6 * HOUR });
    failView(['702']);
    const again = [];
    for (let h = 7; h < 10; h++) again.push((await run({ now: START + h * HOUR })).unreadable);
    expect(again).toEqual([[], [], [702]]);
  });

  it("the owner's own issue never escalates", async () => {
    issues = [{ number: 703, title: 'dream cycle', createdAt: new Date(START - 30 * HOUR).toISOString(), author: { login: 'stuinfla' } }];
    failView(['703']);
    const seen = [];
    for (let h = 0; h < 4; h++) seen.push((await run({ now: START + h * HOUR })).unreadable);
    expect(seen).toEqual([[], [], [], []]);
  });
});

// 4.7.21 review (Opus pager #5): the inbox filed a 17-issue combined page as ONE issue alert.
describe('the combined SLA page counts every issue in the owner\'s inbox', () => {
  it('17 breaching issues -> one page -> 17 open issue alerts (before: 1)', async () => {
    issues = Array.from({ length: 17 }, (_, i) => ({ number: 800 + i, title: `person issue ${i}`,
      createdAt: new Date(START - (10 + i) * HOUR).toISOString(), author: { login: `person${i}` } }));
    await run({ now: START });
    expect(pages()).toHaveLength(1);
    const [, init] = fetcher.mock.calls[0];
    const { fold } = await import('../../scripts/ntfy-inbox.mjs');
    const open = fold([], [{ id: 'msgAbc123', time: START / 1000, title: init.headers.Title, message: init.body, priority: 5 }],
      { now: START, resolver: () => false });
    const live = open.filter((a) => !a.closedAt);
    expect(live).toHaveLength(17);
    expect(live.every((a) => a.kind === 'issue')).toBe(true);
    expect(live.map((a) => a.number).sort()).toEqual(issues.map((i) => i.number).sort());
    expect(new Set(live.map((a) => a.id)).size).toBe(17); // every alert is separately ackable
    // Folding the same message again changes nothing.
    expect(fold(open, [{ id: 'msgAbc123', time: START / 1000, title: init.headers.Title, message: init.body, priority: 5 }],
      { now: START, resolver: () => false }).filter((a) => !a.closedAt)).toHaveLength(17);
  });
});
