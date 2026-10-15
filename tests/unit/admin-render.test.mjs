// DISTINCT-FROM: tests/unit/explainer-api.test.mjs — exercises actual browser rendering, not API shaping.
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

async function render(payload) {
  const elements = new Map();
  const select = (key) => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', addEventListener() {}, classList: { add() {}, remove() {} } });
    return elements.get(key);
  };
  const store = new Map([['rb-admin-token', 'fixture-only']]);
  vm.runInNewContext(fs.readFileSync(new URL('../../explainer/admin.js', import.meta.url), 'utf8'), {
    document: { querySelector: select, addEventListener() {} },
    localStorage: { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
    fetch: async () => ({ ok: true, json: async () => payload }),
    Date, setInterval() {}, clearInterval() {}, console,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return select;
}

const payload = {
  totalAssetDownloads: 75, generatedAt: '2026-10-10T12:00:00Z', people: { contributors: [], forks: [], stargazers: [] },
  releases: [{ tag: 'v4.3.13', assets: [{ downloads: 75 }] }],
  latestRelease: { tag: 'v4.6.0', assets: [{ downloads: 10 }], publishedAt: '2026-10-10' },
  openWork: { available: true, items: [{ number: 1, title: '<live bug>', login: 'stuinfla', at: '2026-10-01', url: 'https://github.com/example' }] },
};

describe('admin rendered current status', () => {
  it('renders current queue independently of historical external contributor inventory', async () => {
    const select = await render(payload);
    expect(select('[data-todo]').innerHTML).toContain('&lt;live bug&gt;');
    expect(select('[data-todo]').innerHTML).toContain('@stuinfla');
    expect(select('[data-reach]').innerHTML).toContain('pulled v4.6.0');
    expect(select('[data-reach]').innerHTML).not.toContain('pulled v4.3.13');
    expect(select('[data-reach]').innerHTML).not.toContain('ACTIVE installed base');
    expect(select('[data-gaps]').innerHTML).toContain('engineering backlog');
    expect(select('[data-reach]').innerHTML).toContain('up to 20 most recent releases');
    expect(select('[data-reach]').innerHTML).not.toContain('lifetime, all releases');
    expect(select('[data-since]').innerHTML).not.toContain('release bundle downloads');
  });
  it('renders failed source as unknown instead of claiming no open work', async () => {
    const select = await render({ ...payload, openWork: { available: false, items: null, note: 'GitHub unavailable; queue unknown.' } });
    expect(select('[data-todo]').innerHTML).toContain('queue unknown');
    expect(select('[data-todo]').innerHTML).not.toContain('No open engineering');
  });
});
