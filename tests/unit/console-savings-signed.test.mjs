// console-savings-signed.test.mjs — the Savings card shows time saved with its SIGN, and says how
// many receipt rows carried no measurement at all.
//
// THE LIE (console audit 2026-09-11): the receipts on the owner's machine summed to msSaved −46,737
// (23 of 25 timed routes were slower than baseline) and 6,111 rows had neither a $ nor a time; the
// server computed both and the page rendered neither — `totals.msSaved >= 0 ? fmtMs(…) : '—'`
// turned a negative finding into a dash, and skippedUnmeasured was never read by app.js at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APP_JS, IMPORT, makeRunner, scratch } from './helpers/console-child.mjs';

let tmp, runJSON;
beforeEach(() => { tmp = scratch('console-savings-'); ({ runJSON } = makeRunner(tmp)); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeReceipts(rows) {
  const dir = path.join(tmp, '.claude', 'metaharness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routing-receipts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('Fix 7 — savings totals keep the sign and count the unmeasured', () => {
  it('a net-slower ledger sums to a NEGATIVE msSaved, with the timed-route count alongside', () => {
    writeReceipts([
      { at: '2026-09-10T00:00:00Z', measuredUsd: 0.5, measuredMs: -2000 },
      { at: '2026-09-10T00:01:00Z', measuredUsd: 0.1, measuredMs: 500 },
      { at: '2026-09-10T00:02:00Z', measuredUsd: 0.2 },            // $ only — not a timed route
      { note: 'no numbers at all' },
      { foo: 1 },
    ]);
    const s = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.gatherSavings()));`);
    expect(s.totals.count).toBe(3);
    expect(s.totals.msSaved).toBe(-1500);
    expect(s.totals.timedCount).toBe(2);
    expect(s.skippedUnmeasured).toBe(2);
  });

  it('the page never hides a negative time behind a dash, and prints the unmeasured count', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    expect(src).not.toContain("totals.msSaved >= 0 ? fmtMs(totals.msSaved) : '—'");
    expect(src).toContain('skippedUnmeasured');
    expect(src).toContain('timedCount');
  });
});
