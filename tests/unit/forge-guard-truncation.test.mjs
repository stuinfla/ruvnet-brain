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

/**
 * n passages; the first `atCap` have exactly `capLen` chars (ending with a period), the rest 300 chars.
 * `clippedMidContent` reproduces the ORIGINAL bug exactly: the stored text was cut to its own preview
 * (same bytes, same length) mid-word. Only then does the guard's precise clip detector fire — a 60-char
 * preview, as the old fixture always used, never equals the text and left that detector untested.
 */
function fixture({ n, atCap, capLen = 240, clippedMidContent = false }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-trunc-'));
  const entries = {};
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const len = i < atCap ? capLen : 300;
    const body = `passage ${i} `.padEnd(len - 1, 'x');
    const text = (clippedMidContent && i < atCap) ? `${body}x` : `${body}.`;
    entries[String(i)] = { preview: (clippedMidContent && i < atCap) ? text : text.slice(0, 60) };
    lines.push(JSON.stringify({ id: String(i), text }));
  }
  fs.writeFileSync(path.join(dir, 'fx.rvf'), 'placeholder');
  fs.writeFileSync(path.join(dir, 'fx.passages.jsonl'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'fx.meta.json'), JSON.stringify({ entries, model: 'test', dimensions: 4, metric: 'cosine' }));
  return dir;
}
const guardOutput = (kbDir) => {
  const out = spawnSync(process.execPath, [GUARD, '--dir', kbDir, '--name', 'fx', '--variant', 'small'], { encoding: 'utf8', timeout: 60_000 });
  return `${out.stdout}${out.stderr}`;
};
const truncationLines = (kbDir) => guardOutput(kbDir).split('\n').filter((line) => /TRUNCATION/.test(line) && /FAIL/.test(line));

describe('forge-guard TRUNCATION rule', () => {
  it('does NOT refuse a small store where one passage coincidentally has a legacy-cap length (the measured canary failure)', () => {
    // The guard must have RUN the truncation rule: an import crash also yields no FAIL lines.
    const one = guardOutput(fixture({ n: 45, atCap: 1 }));
    expect(one.split('\n').filter((line) => /TRUNCATION/.test(line) && /FAIL/.test(line))).toEqual([]);
    expect(one).toMatch(/truncation OK: 1 at-cap/);
    const two = guardOutput(fixture({ n: 45, atCap: 2, capLen: 200 }));
    expect(two.split('\n').filter((line) => /TRUNCATION/.test(line) && /FAIL/.test(line))).toEqual([]);
    expect(two).toMatch(/truncation OK: 2 at-cap/);
  });

  it('still refuses wholesale clipping at a legacy cap: 10 of 45 at 240 chars', () => {
    const lines = truncationLines(fixture({ n: 45, atCap: 10 }));
    expect(lines.join('\n')).toMatch(/10\/45 .*passages clipped at a legacy cap/);
  });

  it('still refuses a store whose passages are all clipped at a legacy cap — through the PRECISE detector too', () => {
    const lines = truncationLines(fixture({ n: 100, atCap: 100, capLen: 200, clippedMidContent: true })).join('\n');
    expect(lines).toMatch(/100\/100 .*passages clipped at a legacy cap/);
    expect(lines).toMatch(/100 passages equal their preview AND sit at a 200\/240 cap mid-content \(the old bug\)/);
  });

  // 4.3.39 review #3: 13 of 199 real stores hold 1-2 passages, below every minimum count. If the old bug
  // returned, those stores would pass. Every passage clipped exactly like the bug is the bug.
  it.each([[1], [2]])('refuses a %i-passage store whose every passage is clipped to its preview at the cap', (n) => {
    const lines = truncationLines(fixture({ n, atCap: n, capLen: 240, clippedMidContent: true })).join('\n');
    expect(lines).toMatch(new RegExp(`${n} passages equal their preview AND sit at a 200/240 cap mid-content \\(the old bug\\) — every passage in the store`));
  });

  it('a 1-passage store whose single passage merely HAS a cap length (not clipped to its preview) still passes', () => {
    const out = guardOutput(fixture({ n: 1, atCap: 1, capLen: 240 }));
    expect(out.split('\n').filter((line) => /TRUNCATION/.test(line) && /FAIL/.test(line))).toEqual([]);
    expect(out).toMatch(/truncation OK: 1 at-cap/);
  });

  it('refuses a tiny store where 3 of 4 passages sit at the cap (the minimum count is met and the fraction is large)', () => {
    expect(truncationLines(fixture({ n: 4, atCap: 3 })).join('\n')).toMatch(/3\/4 .*passages clipped at a legacy cap/);
  });
});
