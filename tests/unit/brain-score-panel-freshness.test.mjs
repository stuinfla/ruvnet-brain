import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPanel, staleness } from '../../scripts/brain-score.mjs';

/**
 * `panelStrict`'s freshness must come from the panel's OWN recorded time, never from the grade
 * file's on-disk mtime.
 *
 * Measured 2026-09-06, this container: `data/grade-*.json` mtimes are all today's checkout
 * timestamp (`git log -1` on each shows the real last-touched date is 2026-08-21, 16 days
 * earlier), and `node scripts/brain-score.mjs` reported `panelStrict 52.5 ... 0d old` — a
 * fabricated freshness reading. `git clone`/`checkout` resets every file's mtime to the checkout
 * instant; a panel graded weeks or months ago reads as brand new on any fresh checkout, CI
 * runner, or this very nightly agent's own ephemeral container. That is exactly the "quoted a
 * 34-day-old 100/100 as current" defect this file's own header names as the reason
 * `maxAgeDays`/`staleness()` exist — alive in the one dimension that never consulted them.
 */
const tmpDirs = [];
function makeTmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-score-panel-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeGrade(dir, name, summary) {
  fs.writeFileSync(path.join(dir, `grade-${name}.json`), JSON.stringify({ summary, report: [] }));
}

describe('panelStrict freshness is read from the panel, not the checkout', () => {
  it('TEETH: a grade file whose real recording is 40 days old is NOT current, even with a just-touched mtime', () => {
    const dir = makeTmpDataDir();
    const recordedAt = '2026-07-27T00:00:00.000Z'; // 41 days before the fixed "now" below
    writeGrade(dir, 'old', { avgStrict: 71, recordedAt });
    // Simulate what `git checkout`/`clone` does to every tracked file: mtime = right now,
    // regardless of when the content was actually true.
    const justNow = new Date();
    fs.utimesSync(path.join(dir, 'grade-old.json'), justNow, justNow);

    const panel = readPanel(dir);
    expect(panel.value, 'the panel value itself is unaffected').toBe(71);
    expect(panel.at, 'at must be the recorded time, never the just-touched mtime').toBe(recordedAt);

    const now = Date.parse('2026-09-06T00:00:00.000Z');
    const s = staleness(panel.at, 30, now);
    expect(s.stale, 'a 41-day-old panel past the 30-day budget must read stale').toBe(true);
    expect(s.ageDays).toBeGreaterThan(30);
  });

  it('TEETH: without a recorded field at all, the panel is honestly unmeasured-for-freshness, never fabricated-fresh', () => {
    // Every grade-*.json committed before this fix has no `recordedAt` at all — this is that case.
    const dir = makeTmpDataDir();
    writeGrade(dir, 'legacy', { avgStrict: 90 }); // no recordedAt, as every pre-fix grade file is
    const justNow = new Date();
    fs.utimesSync(path.join(dir, 'grade-legacy.json'), justNow, justNow);

    const panel = readPanel(dir);
    expect(panel.at, 'a file with no recorded timestamp must not borrow the mtime as a fake one').toBeNull();
    expect(staleness(panel.at, 30).stale, 'no timestamp recorded must read stale, never current').toBe(true);
    expect(staleness(panel.at, 30).why).toMatch(/no timestamp recorded/);
  });

  it('a panel recorded inside its budget still reads current', () => {
    const dir = makeTmpDataDir();
    const recordedAt = '2026-08-20T00:00:00.000Z'; // 17 days before "now" below, inside 30d budget
    writeGrade(dir, 'fresh', { avgStrict: 88, recordedAt });
    const now = Date.parse('2026-09-06T00:00:00.000Z');
    const panel = readPanel(dir);
    expect(staleness(panel.at, 30, now).stale, 'a fix that always flags stale protects nothing').toBe(false);
  });

  it('the most recent recordedAt across multiple graded stores wins, same aggregation as before', () => {
    const dir = makeTmpDataDir();
    writeGrade(dir, 'a', { avgStrict: 80, recordedAt: '2026-08-01T00:00:00.000Z' });
    writeGrade(dir, 'b', { avgStrict: 60, recordedAt: '2026-08-20T00:00:00.000Z' });
    const panel = readPanel(dir);
    expect(panel.at).toBe('2026-08-20T00:00:00.000Z');
    expect(panel.detail).toBe('2 store(s) graded');
    expect(panel.value).toBe(70); // mean(80, 60)
  });

  it('an empty data directory is unmeasured, not an error', () => {
    const dir = makeTmpDataDir();
    const panel = readPanel(dir);
    expect(panel).toEqual({ value: null, detail: null, at: null });
  });
});
