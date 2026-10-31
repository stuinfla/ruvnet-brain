// console-receipts-visible.acceptance.test.mjs — a person who clicks a Console control SEES what it did,
// and still sees it after the page repaints (owner, 2026-10-30: "even if they work, they're not
// showing me that they've worked"). Driven in a real browser against an isolated, packed-and-installed
// Console (tests/acceptance/helpers/rnbc-fixture.mjs). Each block failed on 4.7.25:
//   • Brain power: the success note was written, then erased by the card's own repaint in the same tick.
//   • Apply: the "Applied" panel (log + Undo) was deleted when the re-measure landed.
//   • Settings: "Saved." beside a field still reading "Not chosen yet".
//   • Activity: a store the count query could not read was summed as 0 → "0 projects machine-wide".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { buildRnbcFixture, startRnbc, cleanupRnbc } from './helpers/rnbc-fixture.mjs';
import { chromeExecutable } from './helpers/packed-console-fixture.mjs';

const WAIT = 180_000;
let fx; let srv; let browser; let page;

beforeAll(async () => {
  fx = buildRnbcFixture();
  srv = await startRnbc(fx);
  browser = await chromium.launch({ executablePath: chromeExecutable(chromium) });
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForSelector('#card-brain [role="switch"]', { timeout: WAIT });
}, 300_000);

afterAll(async () => { await browser?.close(); await srv?.stop(); if (fx) cleanupRnbc(fx); }, 120_000);

const receiptIn = (sel) => page.locator(`${sel} .receipt`).first();
const repaint = () => page.evaluate(() => loadState());   // the same painter a landed re-measure uses

describe('every click leaves visible, durable evidence', () => {
  it('brain power: before → after read from disk, still on screen after the card repaints', async () => {
    await page.locator('#card-brain [role="switch"]').click();
    await page.getByRole('button', { name: 'Turn the brain off' }).click();
    const r = receiptIn('#bp-result-slot');
    await r.waitFor({ state: 'visible', timeout: WAIT });
    expect(await r.innerText()).toMatch(/Brain\s+on\s+off/);
    expect(fs.existsSync(`${fx.home}/.config/ruvnet-brain/brain-off`)).toBe(true);
    await repaint();
    await page.waitForTimeout(300);
    expect(await receiptIn('#bp-result-slot').isVisible()).toBe(true);
    // The history card holds it too, served by the server rather than remembered by the page.
    expect(await page.locator('#card-receipts .receipt').first().innerText()).toMatch(/Turn the brain off/);
    await page.locator('#card-brain [role="switch"]').click();      // back on: its own receipt
    await page.waitForFunction(() => /Turn the brain on/.test(document.querySelector('#bp-result-slot')?.innerText || ''), null, { timeout: WAIT });
    expect(fs.existsSync(`${fx.home}/.config/ruvnet-brain/brain-off`)).toBe(false);
  }, WAIT * 2);

  it('settings: the saved field shows its new value and the receipt names the change', async () => {
    await page.locator('#card-settings summary').first().evaluate((s) => { s.closest('details').open = true; });
    await page.locator('#field-routing .seg label').nth(1).click();
    await page.locator('#body-settings form.settings-form').first().locator('button[type="submit"]').click();
    await page.waitForFunction(() => /Token-smart routing\s+not chosen\s+off/.test(document.querySelector('#body-settings')?.innerText || ''), null, { timeout: WAIT });
    await page.waitForFunction(() => !/Not chosen yet/.test(document.querySelector('#field-routing')?.innerText || ''), null, { timeout: WAIT });
    expect(JSON.parse(fs.readFileSync(fx.configFile, 'utf8')).routing).toBe('off');
  }, WAIT * 2);

  it('apply: the applied card, its receipt and its Undo survive the re-measure that follows', async () => {
    const card = page.locator('article.rec').filter({ hasText: 'npx-project' }).first();
    await card.evaluate((c) => { for (let d = c.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true; });
    await card.getByRole('button', { name: /^Apply/ }).click();
    await card.getByRole('button', { name: 'Yes, change my computer' }).click();
    await card.locator('.rec-receipt .receipt').waitFor({ state: 'visible', timeout: WAIT });
    expect(await card.locator('.rec-receipt .receipt').innerText()).toMatch(/still detected on your machine\s+yes\s+no/);
    // Apply kicks a re-measure; once it lands the proposal is gone from the machine — the card must not be.
    await page.waitForFunction(() => /no longer detected/.test(document.querySelector('article.rec.is-applied .rec-remeasured')?.innerText || ''), null, { timeout: WAIT });
    expect(await card.locator('.applied .btn-undo').isVisible()).toBe(true);
    expect(await card.locator('.rec-receipt .receipt').isVisible()).toBe(true);
  }, WAIT * 2);

  it('activity: a store the count query cannot read is a project of unknown size, never "0 projects"', async () => {
    // The fixture store has no `status` column, so the per-store count is unreadable by design.
    await page.waitForFunction(() => /projects? machine-wide/.test(document.querySelector('#ab-stat-projects')?.innerText || ''), null, { timeout: WAIT });
    expect(await page.locator('#ab-stat-projects').innerText()).not.toMatch(/^\s*▸?\s*0\b/);
  }, WAIT);
});
