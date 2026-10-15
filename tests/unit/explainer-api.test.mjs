// tests/unit/explainer-api.test.mjs — the two Vercel functions behind /admin and the telemetry ping.
//
//   api/ping.mjs        — validatePing strictness (nothing but {event,v,n} ever enters the store)
//                         + graceful degradation when no KV store is linked (200, never a 5xx to users)
//   api/admin-stats.mjs — auth fails CLOSED: no ADMIN_TOKEN env → 503; wrong token → 401.
//                         No network is touched in any of these paths.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ping, { validatePing } from '../../explainer/api/ping.mjs';
import adminStats, { tokenMatches, hashFromResult, readOpenWork } from '../../explainer/api/admin-stats.mjs';

const KV_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const saved = {};
beforeEach(() => {
  for (const k of [...KV_VARS, 'ADMIN_TOKEN', 'GITHUB_TOKEN']) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function mockRes() {
  return {
    headers: {}, statusCode: 0, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

describe('ping.mjs validatePing — strict gate on what can enter the counter store', () => {
  const ok = (b) => validatePing(b);
  it('accepts the three real events and defaults n to 1', () => {
    expect(ok({ event: 'install', v: 'v9.9.9-test' })).toEqual({ event: 'install', v: 'v9.9.9-test', n: 1 });
    expect(ok({ event: 'search', v: 'v1', n: 42 })).toEqual({ event: 'search', v: 'v1', n: 42 });
    expect(ok({ event: 'session', v: 'v1' })).toEqual({ event: 'session', v: 'v1', n: 1 });
  });
  it('rejects unknown events, bad counts, and non-objects', () => {
    expect(ok({ event: 'query', v: 'v1' })).toBeNull();       // no such event — queries don't exist here
    expect(ok({ event: 'search', v: 'v1', n: 0 })).toBeNull();
    expect(ok({ event: 'search', v: 'v1', n: -5 })).toBeNull();
    expect(ok({ event: 'search', v: 'v1', n: 1.5 })).toBeNull();
    expect(ok(null)).toBeNull();
    expect(ok([1, 2])).toBeNull();
    expect(ok('not json {')).toBeNull();
  });
  it('caps runaway counts and sanitizes hostile version strings to "unknown"', () => {
    expect(ok({ event: 'search', v: 'v1', n: 999999 }).n).toBe(10000);
    expect(ok({ event: 'install', v: '<script>alert(1)</script>' }).v).toBe('unknown');
    expect(ok({ event: 'install', v: 'x'.repeat(64) }).v).toBe('unknown');
  });
  it('parses a raw JSON string body (clients that skip the content-type header)', () => {
    expect(ok(JSON.stringify({ event: 'session', v: 'v2' }))).toEqual({ event: 'session', v: 'v2', n: 1 });
  });
});

describe('ping.mjs handler — graceful degradation, never an error back to a user machine', () => {
  it('no KV store linked → 200 { ok: true, stored: false } (accepted, dropped, no retry storm)', async () => {
    const res = mockRes();
    await ping({ method: 'POST', body: { event: 'search', v: 'v1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: false });
  });
  it('garbage payload → 400 (the only client error it ever returns)', async () => {
    const res = mockRes();
    await ping({ method: 'POST', body: { event: 'exfiltrate', q: 'secret query text' } }, res);
    expect(res.statusCode).toBe(400);
  });
  it('GET → 405; OPTIONS → 204 (CORS preflight)', async () => {
    const a = mockRes(); await ping({ method: 'GET' }, a); expect(a.statusCode).toBe(405);
    const b = mockRes(); await ping({ method: 'OPTIONS' }, b); expect(b.statusCode).toBe(204);
  });
});

describe('admin-stats.mjs — auth fails CLOSED', () => {
  it('no ADMIN_TOKEN configured → 503, the dashboard stays shut', async () => {
    const res = mockRes();
    await adminStats({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(503);
  });
  it('wrong token → 401', async () => {
    process.env.ADMIN_TOKEN = 'right-token';
    const res = mockRes();
    await adminStats({ method: 'GET', headers: { 'x-admin-token': 'wrong-token' } }, res);
    expect(res.statusCode).toBe(401);
  });
  it('tokenMatches is length-guarded constant-time equality', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);   // unequal length = false, not a throw
    expect(tokenMatches('', 'abc')).toBe(false);
    expect(tokenMatches('anything', '')).toBe(false); // empty expected = closed
  });
  it('hashFromResult decodes Upstash HGETALL pairs', () => {
    expect(hashFromResult({ result: ['install', '3', 'search', '17'] })).toEqual({ install: 3, search: 17 });
    expect(hashFromResult({ result: [] })).toEqual({});
    expect(hashFromResult(null)).toEqual({});
  });
});


describe('admin current-work inventory', () => {
  const issue = (number) => ({ number, title: `Issue ${number}`, user: { login: 'contributor' }, created_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/example', state: 'open' });
  it('includes older open work beyond the first page, owner-authored issues and PRs', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => Array.from({ length: 100 }, (_, n) => issue(n)) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...issue(101), user: { login: 'stuinfla' }, pull_request: {} }] });
    vi.stubGlobal('fetch', fetcher);
    const result = await readOpenWork('');
    expect(result.available).toBe(true);
    expect(result.items).toHaveLength(101);
    expect(result.items[100]).toMatchObject({ login: 'stuinfla', isPR: true });
    expect(fetcher.mock.calls[1][0]).toContain('page=2');
    expect(fetcher.mock.calls[0][0]).toContain('state=open');
  });
  it('a failed page is unknown, never an empty or partial cleared queue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await readOpenWork('')).toMatchObject({ available: false, items: null });
  });
  it('uses releases/latest even when list order has an older release first', async () => {
    process.env.ADMIN_TOKEN = 'test-only';
    vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => {
      if (url.endsWith('/releases/latest')) return { tag_name: 'v4.6.0', assets: [{ name: 'bundle.zip', download_count: 10 }] };
      if (url.includes('/releases?')) return [{ tag_name: 'v4.3.13', assets: [{ download_count: 75 }] }];
      if (url.includes('/issues?') || url.includes('/stargazers?') || url.includes('/forks?')) return [];
      return {};
    } })));
    const res = mockRes();
    await adminStats({ method: 'GET', headers: { 'x-admin-token': 'test-only' } }, res);
    expect(res.body.latestRelease.tag).toBe('v4.6.0');
    expect(res.body.openWork).toMatchObject({ available: true, items: [] });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
