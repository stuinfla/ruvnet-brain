// console-index-structure.test.mjs — what an END USER sees by default on the console.
//
// Owner, 2026-09-12: "'Is this really what we published?' … doesn't belong in an end-user
// configuration screen. That's something for you and I to work through." The release-provenance
// card (#card-trust) therefore leaves the default flow: it lives in a CLOSED maintainer <details>
// at the bottom of the page, keeping its ids so hydration is unchanged. This test pins that.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = fs.readFileSync(path.join(ROOT, 'console/index.html'), 'utf8');

/** [start, end) of the element opened by the tag carrying `id`, closed by the first `</tag>` after it. */
function span(id, tag) {
  const open = HTML.indexOf(`id="${id}"`);
  if (open === -1) return null;
  const close = HTML.indexOf(`</${tag}>`, open);
  return close === -1 ? null : [open, close];
}
const within = (idx, s) => Boolean(s) && idx > s[0] && idx < s[1];

describe('console — the end-user flow does not carry release-provenance proofs', () => {
  const trust = HTML.indexOf('id="card-trust"');

  it('still has the provenance card (its ids are what app.js hydrates)', () => {
    expect(trust).toBeGreaterThan(-1);
    expect(HTML).toContain('id="chips-trust"');
    expect(HTML).toContain('id="body-trust"');
  });

  it('the card is NOT inside "What have I got?"', () => {
    const inventory = span('group-inventory', 'section');
    expect(inventory, '#group-inventory must exist').toBeTruthy();
    expect(within(trust, inventory)).toBe(false);
  });

  it('the card sits inside a maintainer <details> that is CLOSED by default', () => {
    const openTag = HTML.match(/<details[^>]*id="card-advanced"[^>]*>/);
    expect(openTag, 'a #card-advanced <details> must wrap the provenance card').toBeTruthy();
    expect(openTag[0]).not.toMatch(/\sopen(\s|>|=)/);
    const advanced = span('card-advanced', 'details');
    // the inner #card-trust is itself a <details>; the outer span must reach past it
    const innerClose = HTML.indexOf('</details>', trust);
    const outerClose = HTML.indexOf('</details>', innerClose + 1);
    expect(trust).toBeGreaterThan(advanced[0]);
    expect(trust).toBeLessThan(outerClose);
    expect(HTML.slice(advanced[0], trust)).toMatch(/Advanced/);
  });

  it('the maintainer section comes after every end-user question group', () => {
    const advancedIdx = HTML.indexOf('id="card-advanced"');
    for (const group of ['group-inventory', 'group-suggested', 'group-prove']) {
      expect(advancedIdx).toBeGreaterThan(HTML.indexOf(`id="${group}"`));
    }
  });

  it('"What have I got?" no longer promises the provenance check in its blurb', () => {
    const inventory = span('group-inventory', 'section');
    expect(HTML.slice(inventory[0], inventory[1])).not.toMatch(/really what we published/);
  });
});
