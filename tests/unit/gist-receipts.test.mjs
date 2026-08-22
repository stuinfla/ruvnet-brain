import { describe, expect, it } from 'vitest';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { reconcileGistReceipts, sealGistReceipt, validateGistReceiptSet } from '../../scripts/gist-receipts.mjs';
import { sourceObservationDigest } from '../../scripts/source-coverage.mjs';

const id = (char) => char.repeat(32);
const listedFiles = (gistId) => gistId === id('a') ? {
  'old.md': { filename: 'old.md', raw_url: `https://gist.example/${gistId}/raw/${'c'.repeat(40)}/old.md`,
    size: 3, type: 'text/plain', language: 'Markdown' },
} : {
  'code.js': { filename: 'code.js', raw_url: `https://gist.example/${gistId}/raw/${'d'.repeat(40)}/code.js`,
    size: 1, type: 'application/javascript', language: 'JavaScript' },
  'new.md': { filename: 'new.md', raw_url: `https://gist.example/${gistId}/raw/${'d'.repeat(40)}/new.md`,
    size: 8, type: 'text/plain', language: 'Markdown' },
};
const fetchedGist = (gistId) => ({
  id: gistId,
  updated_at: gistId === id('a') ? '2026-08-22T00:00:00Z' : '2026-08-22T01:00:00Z',
  history: [{ version: gistId === id('a') ? 'c'.repeat(40) : 'd'.repeat(40) }],
  files: Object.fromEntries(Object.entries(listedFiles(gistId)).map(([name, file]) => [name, {
    ...file,
    content: name === 'old.md' ? 'old' : name === 'new.md' ? 'new text' : 'x',
    truncated: false,
  }])),
});
const observation = () => {
  const base = { schemaVersion: 1, kind: 'ruvnet-brain-source-observation', owner: 'ruvnet',
    observedAt: '2026-08-22T01:30:00Z',
    gists: { rows: [
      { id: id('a'), updated_at: '2026-08-22T00:00:00Z', files: listedFiles(id('a')) },
      { id: id('b'), updated_at: '2026-08-22T01:00:00Z', files: listedFiles(id('b')) },
    ] } };
  return { ...base, observationSha256: sourceObservationDigest(base) };
};

describe('exact live gist receipt reconciliation', () => {
  it('reuses only unchanged exact receipts and fetches every changed or missing gist', async () => {
    const seen = [];
    const existingFile = { filename: 'old.md', included: true, sha256: digest('old'), bytes: 3 };
    const existingReceipt = sealGistReceipt({ gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-22T00:00:00Z', ingestedAt: '2026-08-22T00:30:00Z',
      files: [existingFile], complete: true });
    const existing = { gists: { [id('a')]: existingReceipt } };
    const receipt = await reconcileGistReceipts({ observation: observation(), existing,
      fetchGist: async (gistId) => { seen.push(gistId); return fetchedGist(gistId); },
      now: () => '2026-08-22T02:00:00Z' });
    expect(seen).toEqual([id('b')]);
    expect(receipt).toMatchObject({ schemaVersion: 3, gistSet: { count: 2 }, gists: {
      [id('a')]: existingReceipt, [id('b')]: { complete: true, versionSha: 'd'.repeat(40) } } });
    expect(receipt.gists[id('b')].files).toEqual([
      { filename: 'code.js', included: false, reason: 'non-text policy exclusion', size: 1 },
      { filename: 'new.md', included: true, sha256: digest('new text'), bytes: 8 },
    ]);
    expect(validateGistReceiptSet(receipt, observation())).toBe(receipt);

    const staleReceipt = sealGistReceipt({ ...existingReceipt, updatedAt: '2026-08-21T23:59:59Z' });
    const refetched = [];
    await reconcileGistReceipts({ observation: observation(),
      existing: { gists: { [id('a')]: staleReceipt } },
      fetchGist: async (gistId) => { refetched.push(gistId); return fetchedGist(gistId); } });
    expect(refetched).toEqual([id('a'), id('b')]);
  });

  it('fails closed when the exact list and fetch observations move', async () => {
    const moved = fetchedGist(id('a'));
    moved.files['old.md'].raw_url = 'https://gist.example/moved/old.md';
    await expect(reconcileGistReceipts({ observation: observation(),
      fetchGist: async (gistId) => gistId === id('a') ? moved : fetchedGist(gistId) }))
      .rejects.toMatchObject({ code: 'GIST_OBSERVATION_MOVED', gistId: id('a') });
  });

  it('rejects missing and extra receipt ids', async () => {
    const valid = await reconcileGistReceipts({ observation: observation(), fetchGist: fetchedGist });
    const missing = structuredClone(valid);
    delete missing.gists[id('a')];
    expect(() => validateGistReceiptSet(missing, observation())).toThrow(/exactly match/);
    const extra = structuredClone(valid);
    extra.gists[id('e')] = extra.gists[id('a')];
    expect(() => validateGistReceiptSet(extra, observation())).toThrow(/exactly match/);
  });

  it('binds canonical per-gist, exact-id-set, source-set, and top-level receipt digests', async () => {
    const valid = await reconcileGistReceipts({ observation: observation(), fetchGist: fetchedGist,
      now: () => '2026-08-22T02:00:00Z' });
    expect(valid.gistSet).toMatchObject({ count: 2, observationSha256: observation().observationSha256 });
    for (const mutate of [
      (copy) => { copy.gists[id('a')].receiptSha256 = '0'.repeat(64); },
      (copy) => { copy.sourceSetSha256 = '0'.repeat(64); },
      (copy) => { copy.gistSet.idsSha256 = '0'.repeat(64); },
      (copy) => { copy.sourceObservationSha256 = '0'.repeat(64); },
      (copy) => { copy.receiptSha256 = '0'.repeat(64); },
    ]) {
      const copy = structuredClone(valid);
      mutate(copy);
      expect(() => validateGistReceiptSet(copy, observation())).toThrow();
    }
  });

  it('rejects invalid UTF-8 instead of sealing a text receipt', async () => {
    await expect(reconcileGistReceipts({
      observation: observation(),
      fetchGist: fetchedGist,
      fetchBody: async (file) => file.filename === 'new.md' ? Buffer.from([0xc3, 0x28]) : Buffer.from('old'),
    })).rejects.toThrow(/not valid UTF-8/);
  });
});
