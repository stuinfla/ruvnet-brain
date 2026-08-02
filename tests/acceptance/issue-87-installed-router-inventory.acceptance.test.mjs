import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { chromeExecutable, installPackedConsole } from './helpers/packed-console-fixture.mjs';

const fixtures = [];
const browsers = [];
const chrome = chromeExecutable(chromium);
const profile = { harnesses: { 'claude-code': { available: true, subscription: true } } };
const decision = {
  ts: '2026-08-02T18:30:00.000Z',
  model: 'claude-fable-5',
  tier: 'frontier',
  routedBy: '@metaharness/router',
  reason: 'policy-backed fixture receipt',
};
const opus = {
  id: 'claude-opus-4-8', provider: 'anthropic', harness: ['claude-code'],
  subscription: ['claude-code'], tier: 'frontier', costPerMTok: null, verified: 'reviewed old row',
};
const fable = {
  id: 'claude-fable-5', provider: 'anthropic', harness: ['claude-code'],
  subscription: ['claude-code'], tier: 'frontier', costPerMTok: null, verified: 'reviewed old row',
};

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function installedInventory(candidates) {
  const fixture = await installPackedConsole({
    prefix: 'brain-issue87-installed-',
    catalog: { updated: '2026-07-12 old user catalog', candidates },
    profile,
    decisions: [decision],
  });
  fixtures.push(fixture);
  fixture.measureState();
  const server = await fixture.start();
  const stateResponse = await fetch(`${server.url}api/state`);
  expect(stateResponse.status).toBe(200);
  const state = await stateResponse.json();

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  const development = page.locator('.rp-profile').filter({ hasText: 'Development' });
  await expect.poll(() => development.locator('tbody tr').count()).toBe(5);
  const rows = await development.locator('tbody tr').evaluateAll((items) => items.map((row) => ({
    model: row.cells[1].textContent.trim(),
    routing: row.cells[3].textContent.trim(),
  })));
  return { fixture, state, rows };
}

describe('issue #87 packed installed Console inventory', () => {
  const test = chrome ? it : it.skip;

  test('merges additions and renders an order-invariant full inventory with a receipt marker', async () => {
    const first = await installedInventory([fable, opus]);
    const second = await installedInventory([opus, fable]);
    const expectedIds = [
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
    ];

    for (const result of [first, second]) {
      const router = result.state.sections.savings.routerEngine;
      expect(router.catalogSource).toBe('catalog');
      expect(router.pool.filter((row) => row.provider === 'anthropic').map((row) => row.id).sort()).toEqual(expectedIds);
      expect(router.pool.find((row) => row.id === 'claude-opus-5').verified).toMatch(/2026-08-02.*launch/i);
      expect(router.pool.find((row) => row.id === 'claude-fable-5').verified).toBeTruthy();
      expect(router.decisions[0]).toMatchObject({ model: 'claude-fable-5', reason: 'policy-backed fixture receipt' });

      const installed = JSON.parse(fs.readFileSync(result.fixture.installedCatalog, 'utf8'));
      expect(installed.managedVersion).toBe(2);
      expect(installed.updated).toBe('2026-07-12 old user catalog');
      expect(result.rows.filter((row) => row.routing === 'last selected')).toEqual([
        expect.objectContaining({ model: expect.stringMatching(/Fable 5/i) }),
      ]);
    }

    expect(first.rows.map((row) => row.model)).toEqual(second.rows.map((row) => row.model));
    expect(first.rows.map((row) => row.model).join(' ')).toMatch(/Haiku.*Sonnet.*Fable.*Opus 4\.8.*Opus 5/i);
  }, 120_000);
});
