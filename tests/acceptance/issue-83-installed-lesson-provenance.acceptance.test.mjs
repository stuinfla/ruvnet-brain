import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { PACKED_TEARDOWN_BUDGET_MS, chromeExecutable, installPackedConsole } from './helpers/packed-console-fixture.mjs';

const fixtures = [];
const browsers = [];
const chrome = chromeExecutable(chromium);

const lesson = (id, statement, origin, sourceClass, extra = {}) => ({
  id,
  statement,
  trigger: 'claim-done',
  enforcement: 'review',
  evidence: [{ observed: `fixture evidence for ${id}` }],
  origin,
  sourceClass,
  status: 'candidate',
  projects: [],
  repeatCount: 1,
  demoted: false,
  ...extra,
});

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
}, PACKED_TEARDOWN_BUDGET_MS);

describe('issue #83 packed unrelated-user Console provenance', () => {
  const test = chrome ? it : it.skip;

  test('renders four provenance classes without laundering imported ownership', async () => {
    const fixture = await installPackedConsole({ prefix: 'brain-issue83-installed-' });
    fixtures.push(fixture);
    const store = path.join(fixture.home, '.config', 'ruvnet-brain', 'lessons.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, `${JSON.stringify({ version: 1, lessons: [
      lesson('personal', 'The current user stated this personal verification rule.', 'user-stated', 'current-user'),
      lesson('owner-import', 'A maintainer imported this unrelated owner rule.', 'imported', 'imported-owner', { demoted: true }),
      lesson('model', 'The model inferred this behavior from observed history.', 'model-inferred', 'model-inferred'),
      lesson('demo', 'This demonstration record is never personal policy.', 'imported', 'demonstration', { demoted: true }),
    ] }, null, 2)}\n`);

    const server = await fixture.start();
    const response = await fetch(`${server.url}api/lessons`);
    expect(response.status).toBe(200);
    const api = await response.json();
    expect(api.lessons.map(({ id, origin, sourceClass, userStated, quarantined }) => (
      { id, origin, sourceClass, userStated, quarantined }
    )).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'demo', origin: 'demonstration data — not personal policy', sourceClass: 'demonstration', userStated: false, quarantined: true },
      { id: 'model', origin: 'I inferred this from what happened', sourceClass: 'model-inferred', userStated: false, quarantined: false },
      { id: 'owner-import', origin: 'imported maintainer history — not yours', sourceClass: 'imported-owner', userStated: false, quarantined: true },
      { id: 'personal', origin: 'you taught me this', sourceClass: 'current-user', userStated: true, quarantined: false },
    ]);

    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.locator('.lesson-row').count()).toBe(4);
    const rendered = await page.locator('.lesson-row').evaluateAll((rows) => rows.map((row) => row.textContent));
    expect(rendered.filter((text) => text.includes('you taught me this'))).toHaveLength(1);
    expect(rendered.find((text) => text.includes('unrelated owner rule'))).toContain('imported maintainer history — not yours');
    expect(rendered.find((text) => text.includes('model inferred'))).toContain('I inferred this from what happened');
    expect(rendered.find((text) => text.includes('demonstration record'))).toContain('demonstration data — not personal policy');
  }, 60_000);
});
