// console-receipts.test.mjs — the verdict on a click is DERIVED from two independent reads of the
// machine, never asserted by the endpoint that did the work (scripts/console-receipts.mjs, 2026-10-30).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReceipt, diffFacts, fmtBytes, readReceipts, recordReceipt, RECEIPT_LIMIT } from '../../scripts/console-receipts.mjs';

describe('buildReceipt — the verdict comes from before vs after, not from ok', () => {
  it('ok + a real difference is "changed", and the changed row carries both values', () => {
    const r = buildReceipt({ action: 'brain-power', title: 'Turn the brain off', ok: true, before: { Brain: 'on' }, after: { Brain: 'off' } });
    expect(r.verdict).toBe('changed');
    expect(r.facts).toEqual([{ fact: 'Brain', before: 'on', after: 'off', changed: true }]);
    expect(r.headline).toMatch(/1 thing changed/);
  });

  it('ok with NOTHING different on disk is "unverified", never a success', () => {
    // The exact lie the owner reported: a writer said ok, the machine did not move.
    const r = buildReceipt({ action: 'save-config', title: 'Save settings', ok: true, before: { Routing: 'auto' }, after: { Routing: 'auto' } });
    expect(r.verdict).toBe('unverified');
    expect(r.headline).toMatch(/NOT done/);
  });

  it('ok with nothing different is "no-change" only when no change was expected', () => {
    const r = buildReceipt({ action: 'brain-power', title: 'Turn the brain on', ok: true, before: { Brain: 'on' }, after: { Brain: 'on' }, expectChange: false });
    expect(r.verdict).toBe('no-change');
  });

  it('a refused action is "failed" and says when state moved anyway', () => {
    const still = buildReceipt({ action: 'x', title: 'X', ok: false, before: { A: '1' }, after: { A: '1' } });
    expect(still.verdict).toBe('failed');
    expect(still.headline).toMatch(/Nothing on your machine changed/);
    const moved = buildReceipt({ action: 'x', title: 'X', ok: false, before: { A: '1' }, after: { A: '2' } });
    expect(moved.headline).toMatch(/Some state moved anyway/);
  });

  it('unknown is a value, never a blank or a zero', () => {
    expect(diffFacts({ A: null }, { A: undefined })).toEqual([{ fact: 'A', before: 'unknown', after: 'unknown', changed: false }]);
    expect(diffFacts({}, { B: 0 })).toEqual([{ fact: 'B', before: 'unknown', after: '0', changed: true }]);
  });

  it('a small real size never prints as 0 MB', () => {
    expect(fmtBytes(6144)).toBe('6.0 KB');
    expect(fmtBytes(NaN)).toBe('unknown');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});

describe('recordReceipt / readReceipts — history the page cannot lose on a repaint', () => {
  it('reads newest first, bounds the file, and marks a spent undo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
    const file = path.join(dir, 'r.jsonl');
    for (let i = 0; i < RECEIPT_LIMIT + 5; i++) {
      recordReceipt(file, buildReceipt({ action: 'a', title: `T${i}`, ok: true, before: { n: i }, after: { n: i + 1 }, undoToken: i === RECEIPT_LIMIT + 4 ? 'tok' : null }));
    }
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(RECEIPT_LIMIT);
    const rows = readReceipts(file, { consumedTokens: new Set(['tok']), limit: 3 });
    expect(rows.map((r) => r.title)).toEqual([`T${RECEIPT_LIMIT + 4}`, `T${RECEIPT_LIMIT + 3}`, `T${RECEIPT_LIMIT + 2}`]);
    expect(rows[0].undoUsed).toBe(true);
    expect(rows[1].undoUsed).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a missing file is an empty history, not an error', () => {
    expect(readReceipts(path.join(os.tmpdir(), 'no-such-receipts-file.jsonl'))).toEqual([]);
  });
});
