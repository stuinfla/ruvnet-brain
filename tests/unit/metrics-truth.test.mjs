import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import handler from '../../explainer/api/metrics.mjs';
const html = fs.readFileSync(new URL('../../explainer/metrics.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function call(fetcher, method = 'GET') {
  vi.stubGlobal('fetch', fetcher);
  let body, status;
  await handler({ method }, { setHeader() {}, status(n) { status = n; return this; }, json(x) { body = x; }, end() {} });
  return { status, body };
}
function render(data) {
  const elements = new Map();
  const el = () => ({ innerHTML: '', textContent: '', style: {}, appendChild() {} });
  const document = { readyState: 'loading', addEventListener() {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, el()); return elements.get(id);
  }, createElement: el };
  const context = vm.createContext({ document, console, Date, setInterval() {} });
  vm.runInContext(script, context);
  context.payload = { data };
  vm.runInContext('updateDashboard(payload)', context);
  return elements;
}
describe('metrics observations never manufacture a score or measurements', () => {
  it('original failure: unavailable providers cannot produce performance numbers or random trends', async () => {
    const { body } = await call(async () => { throw new Error('offline'); });
    expect(body.ok).toBe(true);
    expect(body.data).not.toHaveProperty('northStarScore');
    expect(body.data).not.toHaveProperty('community');
    expect(body.data.performance).toMatchObject({ uptime: null, errorRate: null, latency: null, requestsPerSecond: null });
    expect(body.data.repo).toBeNull(); expect(body.data.npm).toBeNull(); expect(body.data.trends).toEqual([]);
    expect(body.data.sources.github.status).toBe('unavailable');
    const page = render(body.data);
    expect(page.get('dashboard').innerHTML).toContain('Unavailable');
    expect(page.get('dashboard').innerHTML).not.toContain('North Star');
    expect(page.get('latency-chart').textContent).toContain('Unavailable');
  });
  it('retains actual provider observations and their bounds without estimating throughput', async () => {
    const downloads = [{ day: '2026-10-03', downloads: 11 }, { day: '2026-10-04', downloads: 0 }];
    const { body } = await call(async url => ({ ok: true, json: async () => String(url).includes('api.npmjs.org')
      ? { downloads } : { stargazers_count: 72, forks_count: 24, open_issues_count: 21 } }));
    expect(body.data.npm.thisWeek).toBe(11); expect(body.data.npm.daily).toEqual(downloads);
    expect(body.data.trends).toEqual(downloads.map(d => ({ date: d.day, downloads: d.downloads })));
    expect(body.data.sources.npm.period).toEqual({ start: '2026-10-03', end: '2026-10-04' });
    expect(body.data.sources.github.checkedAt).toBe(body.timestamp);
    expect(body.data.performance.requestsPerSecond).toBeNull();
    expect(render(body.data).get('dashboard').innerHTML).toContain('72');
  });
  it('partial and malformed sources render missing values without false zeros', async () => {
    const { body } = await call(async url => ({ ok: true, json: async () => String(url).includes('npm')
      ? { downloads: [{ day: 'bad', downloads: -1 }] } : { stargazers_count: 0, forks_count: 0, open_issues_count: 0 } }));
    expect(body.data.repo.stars).toBe(0); expect(body.data.npm).toBeNull();
    expect(render(body.data).get('dashboard').innerHTML).toContain('Source unavailable');
    expect(() => render({})).not.toThrow();
  });
  it('labels old observations stale and never adds a product grade', () => {
    const page = render({ repo: { stars: 1 }, sources: { github: { status: 'observed', checkedAt: '2000-01-01T00:00:00Z' } } });
    expect(page.get('dashboard').innerHTML).toContain('stale observation');
    expect(html).not.toContain('North Star Score');
  });
  it('preserves method controls without fetching', async () => {
    const fetcher = vi.fn(); expect((await call(fetcher, 'POST')).status).toBe(405);
    expect((await call(fetcher, 'OPTIONS')).status).toBe(204); expect(fetcher).not.toHaveBeenCalled();
  });
});
