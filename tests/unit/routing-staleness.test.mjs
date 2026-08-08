import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatTable, loadReceipts } from '../../scripts/metaharness-receipts.mjs';

/**
 * ROUTING SAVINGS MUST DECLARE WHETHER THEY ARE STILL HAPPENING.
 *
 * Measured 2026-08-08: the `/savings` card reported "SAVED ~61% · 43 routed tasks" for FOURTEEN
 * DAYS after routing had entirely stopped. Every figure was true and every figure was history —
 * newest receipt 2026-07-24, and in the fortnight since, including three days of heavy work, not a
 * single task was routed. The card read as a live dashboard and was a museum plaque.
 *
 * SKILL.md already records this failure once: "after two days, the receipts log held 3 entries, all
 * test pings, $0.018 saved — while real work was done inline in the most expensive model." The
 * answer then was to make the routing rule a floor rather than advice. It did not hold, because
 * nothing MEASURED whether the floor was honoured, and a silent zero is indistinguishable from a
 * healthy system.
 *
 * That is the same disease as every other defect fixed this week — a surface reporting something
 * other than what it measured — so it gets the same treatment: a test that fails when the surface
 * goes quiet about its own staleness.
 */
const withReceipts = (rows, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-receipts-'));
  const file = path.join(dir, 'routing-receipts.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

// The REAL receipt shape, read from ~/.claude/metaharness/routing-receipts.jsonl rather than
// guessed. loadReceipts admits a row only when `typeof saved === 'number' && model` — my first
// fixture invented `est_cost_usd`/`baseline_model`, so every row was silently skipped and the card
// rendered "No routing receipts yet", which the test then read as a missing staleness banner.
// Fixtures must match the producer, or the test measures the fixture.
const receipt = (daysAgo, extra = {}) => ({
  ts: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  task_class: 'mechanical',
  task: 'inventory sweep',
  model: 'claude-haiku-4.5',
  agent: 'general-purpose',
  est_in_tokens: 1200,
  est_out_tokens: 400,
  est_cost: 0.0002,
  est_frontier_cost: 0.0051,
  saved: 0.0049,
  frontier_ref: 'claude-opus-4.8',
  token_source: 'estimated',
  duration_ms: 6900,
  source: 'subagent',
  ...extra,
});

describe('routing savings card — stale figures must announce themselves', () => {
  it('SAYS STALE when nothing has been routed for days', () => {
    const out = withReceipts([receipt(14), receipt(15)], (f) => formatTable(loadReceipts(f).rows));
    expect(out, 'a fortnight of silence must be stated, not implied').toMatch(/STALE: nothing has been routed in 14 days/);
    expect(out, 'and it must say the numbers are history').toMatch(/HISTORY, not current performance/);
  });

  it('STAYS QUIET when routing is current — a warning on every run is noise', () => {
    // The teeth on the other side: a banner that always fires teaches people to scroll past it,
    // which is how the original silent-zero survived fourteen days in the first place.
    const out = withReceipts([receipt(0), receipt(1)], (f) => formatTable(loadReceipts(f).rows));
    expect(out, 'fresh routing must not be flagged as stale').not.toMatch(/STALE/);
    expect(out, 'the savings line still renders').toMatch(/SAVED ~/);
  });

  it('is explicit when there are NO receipts at all', () => {
    // "0 routed tasks, 0% saved" is technically true and reads as a working system with nothing to
    // do. It must instead say the figures describe nothing.
    const out = withReceipts([], (f) => formatTable(loadReceipts(f).rows));
    expect(out, 'an empty ledger must say it is empty, not render 0% as a result')
      .toMatch(/No routing receipts yet/);
  });

  it('the boundary is a real threshold, not a coincidence', () => {
    const fresh = withReceipts([receipt(2)], (f) => formatTable(loadReceipts(f).rows));
    const stale = withReceipts([receipt(4)], (f) => formatTable(loadReceipts(f).rows));
    expect(fresh, '2 days idle is normal working rhythm').not.toMatch(/STALE/);
    expect(stale, '4 days idle means the floor is not being honoured').toMatch(/STALE/);
  });
});
