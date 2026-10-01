/**
 * forge-guard's TRUNCATION rule, through the real command-line guard.
 *
 * Measured 2026-09-30: the nightly customer canary refused a valid corpus generation because one store
 * (45 passages) had ONE passage that happened to be exactly 200 or 240 characters long: 1/45 = 2.2% > 2%.
 * The precise clip scan (passage equals its own preview AND ends mid-content) found 0. The percentage rule
 * now needs a minimum absolute count, and the original wholesale-clipping bug must still be caught.
 *
 * The fixture is a parity-consistent passages/meta pair beside a placeholder .rvf. The LIVE QUERY check
 * fails on the placeholder, which is fine: these tests read only the TRUNCATION lines of the output.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kb', 'forge-guard.mjs');
let dir;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

/** n passages; the first `atCap` have exactly `capLen` chars (ending with a period), the rest 300 chars. */
function fixture({ n, atCap, capLen = 240, clippedMidContent = false }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-trunc-'));
  const entries = {};
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const len = i < atCap ? capLen : 300;
    const body = `passage ${i} `.padEnd(len - 1, 'x');
    const text = (clippedMidContent && i < atCap) ? `${body}x` : `${body}.`;
    entries[String(i)] = { preview: text.slice(0, 60) };
    lines.push(JSON.stringify({ id: String(i), text }));
  }
  fs.writeFileSync(path.join(dir, 'fx.rvf'), 'placeholder');
  fs.writeFileSync(path.join(dir, 'fx.passages.jsonl'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'fx.meta.json'), JSON.stringify({ entries, model: 'test', dimensions: 4, metric: 'cosine' }));
  return dir;
}
const truncationLines = (kbDir) => {
  const out = spawnSync(process.execPath, [GUARD, '--dir', kbDir, '--name', 'fx', '--variant', 'small'], { encoding: 'utf8', timeout: 60_000 });
  return `${out.stdout}${out.stderr}`.split('\n').filter((line) => /TRUNCATION/.test(line) && /FAIL/.test(line));
};

describe('forge-guard TRUNCATION rule', () => {
  it('does NOT refuse a small store where one passage coincidentally has a legacy-cap length (the measured canary failure)', () => {
    expect(truncationLines(fixture({ n: 45, atCap: 1 }))).toEqual([]);
    expect(truncationLines(fixture({ n: 45, atCap: 2, capLen: 200 }))).toEqual([]);
  });

  it('still refuses wholesale clipping at a legacy cap: 10 of 45 at 240 chars', () => {
    const lines = truncationLines(fixture({ n: 45, atCap: 10 }));
    expect(lines.join('\n')).toMatch(/10\/45 .*passages clipped at a legacy cap/);
  });

  it('still refuses a store whose passages are all clipped at a legacy cap', () => {
    const lines = truncationLines(fixture({ n: 100, atCap: 100, capLen: 200, clippedMidContent: true }));
    expect(lines.join('\n')).toMatch(/100\/100 .*passages clipped at a legacy cap/);
  });

  it('refuses a tiny store where 3 of 4 passages sit at the cap (the minimum count is met and the fraction is large)', () => {
    expect(truncationLines(fixture({ n: 4, atCap: 3 })).join('\n')).toMatch(/3\/4 .*passages clipped at a legacy cap/);
  });
});
