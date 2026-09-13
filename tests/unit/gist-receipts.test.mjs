import { describe, expect, it, vi } from 'vitest';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { GistFetchError, bindPassagesSha256, defaultFetchGist, reconcileGistReceipts, sealGistReceipt,
  sealGistReceiptSet, validateGistReceiptSet } from '../../scripts/gist-receipts.mjs';
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
  it('seals mixed-case filenames in the canonical order required by validation', () => {
    const gistId = id('f');
    const observed = {
      owner: 'ruvnet', observedAt: '2026-08-22T01:30:00Z', observationSha256: 'e'.repeat(64),
      gists: { rows: [{ id: gistId, updated_at: '2026-08-22T01:00:00Z' }] },
    };
    const gist = sealGistReceipt({ gistId, versionSha: 'd'.repeat(40),
      updatedAt: '2026-08-22T01:00:00Z', ingestedAt: '2026-08-22T02:00:00Z', complete: true,
      files: [
        { filename: 'backtest.mjs', included: true, sha256: digest('backtest'), bytes: 8 },
        { filename: 'HammerStarSweep.mq5', included: false, reason: 'non-text policy exclusion', size: 1 },
      ] });
    const receipt = sealGistReceiptSet({ owner: observed.owner, generated: '2026-08-22T02:00:00Z',
      observedAt: observed.observedAt, sourceObservationSha256: observed.observationSha256,
      passagesSha256: null, gists: { [gistId]: gist } });

    expect(receipt.gists[gistId].files.map(({ filename }) => filename))
      .toEqual(['HammerStarSweep.mq5', 'backtest.mjs']);
    expect(validateGistReceiptSet(receipt, observed)).toBe(receipt);
  });

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

describe('bindPassagesSha256 — closing the 2026-09-12 gap (reconcileGistReceipts seals passagesSha256:null)', () => {
  it('a freshly-reconciled receipt has passagesSha256 null and fails validation against any real passages file', async () => {
    const receipt = await reconcileGistReceipts({ observation: observation(), fetchGist: fetchedGist,
      now: () => '2026-08-22T02:00:00Z' });
    expect(receipt.passagesSha256).toBeNull();
  });

  it('binds the real passages sha256 and the result still validates as an exact receipt set', async () => {
    const receipt = await reconcileGistReceipts({ observation: observation(), fetchGist: fetchedGist,
      now: () => '2026-08-22T02:00:00Z' });
    const bound = bindPassagesSha256(receipt, '1'.repeat(64));
    expect(bound.passagesSha256).toBe('1'.repeat(64));
    // Binding must not disturb any field validateGistReceiptSet checks other than passagesSha256/receiptSha256.
    expect(bound.gists).toEqual(receipt.gists);
    expect(bound.sourceSetSha256).toBe(receipt.sourceSetSha256);
    expect(bound.gistSet).toEqual(receipt.gistSet);
    expect(() => validateGistReceiptSet(bound, observation())).not.toThrow();
  });

  it('rejects a non-hex64 hash rather than sealing a malformed binding', () => {
    const receipt = sealGistReceiptSet({ owner: 'ruvnet', generated: '2026-08-22T02:00:00Z',
      observedAt: '2026-08-22T01:30:00Z', sourceObservationSha256: observation().observationSha256,
      passagesSha256: null, gists: {} });
    expect(() => bindPassagesSha256(receipt, 'not-a-hash')).toThrow(/passages sha256/);
    expect(() => bindPassagesSha256(receipt, null)).toThrow(/passages sha256/);
  });

  it('re-binding is idempotent — binding the same hash twice yields byte-identical output', async () => {
    const receipt = await reconcileGistReceipts({ observation: observation(), fetchGist: fetchedGist,
      now: () => '2026-08-22T02:00:00Z' });
    const once = bindPassagesSha256(receipt, '2'.repeat(64));
    const twice = bindPassagesSha256(once, '2'.repeat(64));
    expect(twice).toEqual(once);
  });
});

// defaultFetchGist — the transport `reconcileGistReceipts` falls back to for per-gist detail when the
// caller supplies no `fetchGist`. Actions' default GITHUB_TOKEN is a GitHub App token with no gist
// scope (403 "Resource not accessible by integration"); RUVNET_GISTS_TOKEN (corpus-seed.yml) fixes
// that at the workflow layer — `gh` itself already reads GH_TOKEN/GITHUB_TOKEN from the environment
// (verified live: `gh help environment`, 2026-09-13), so no code here decides which token is used.
// This suite covers what IS this module's job: classifying `gh api gists/<id>` failures instead of
// letting every non-zero exit collapse into one opaque Error, bounding retries for transient/rate-limit
// failures, never silently returning null for a moved/deleted gist, and honoring an AbortSignal when
// one is supplied (no caller in this repo threads one through today — see corpus-reconcile.mjs).
describe('defaultFetchGist — per-gist transport: retry, typed errors, cancellation', () => {
  const gistId = 'f'.repeat(32);
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr) => ({ status: 1, stdout: '', stderr });
  const noSleep = async () => {};

  it('gh-token-present success path: returns the parsed gist on the first attempt', async () => {
    const spawn = vi.fn().mockReturnValue(ok(JSON.stringify({ id: gistId, files: {} })));
    const result = await defaultFetchGist(gistId, { spawn, sleep: noSleep });
    expect(result).toEqual({ id: gistId, files: {} });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('gh', ['api', `gists/${gistId}`], expect.any(Object));
  });

  it('integration rejection (403, no gist-scoped token) throws a typed, non-retryable error on the first attempt', async () => {
    const spawn = vi.fn().mockReturnValue(fail('gh: Resource not accessible by integration (HTTP 403)'));
    await expect(defaultFetchGist(gistId, { spawn, sleep: noSleep }))
      .rejects.toMatchObject({ name: 'GistFetchError', code: 'GIST_FORBIDDEN', gistId, retryable: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('an ordinary transient failure retries with backoff, then succeeds', async () => {
    const spawn = vi.fn()
      .mockReturnValueOnce(fail('gh: TLS handshake timeout'))
      .mockReturnValueOnce(fail('gh: TLS handshake timeout'))
      .mockReturnValueOnce(ok(JSON.stringify({ id: gistId, files: {} })));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await defaultFetchGist(gistId, { spawn, sleep, retries: 3 });
    expect(result).toEqual({ id: gistId, files: {} });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('a transient failure that never recovers throws the typed error once retries are exhausted', async () => {
    const spawn = vi.fn().mockReturnValue(fail('gh: TLS handshake timeout'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(defaultFetchGist(gistId, { spawn, sleep, retries: 2 }))
      .rejects.toMatchObject({ code: 'GIST_TRANSIENT_FAILURE', retryable: true });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('a rate-limit response is retried and can still succeed within the bound', async () => {
    const spawn = vi.fn()
      .mockReturnValueOnce(fail('gh: API rate limit exceeded for installation ID 123. (HTTP 403)'))
      .mockReturnValueOnce(ok(JSON.stringify({ id: gistId, files: {} })));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await defaultFetchGist(gistId, { spawn, sleep, retries: 3 });
    expect(result).toEqual({ id: gistId, files: {} });
    expect(spawn).toHaveBeenCalledTimes(2);
    const firstCall = sleep.mock.calls[0];
    expect(firstCall[0]).toBeGreaterThan(0);
  });

  it('a moved/deleted gist (404) produces a clear typed error, never a silent null, and is not retried', async () => {
    const spawn = vi.fn().mockReturnValue(fail('gh: Not Found (HTTP 404)'));
    let result;
    try {
      result = await defaultFetchGist(gistId, { spawn, sleep: noSleep });
    } catch (error) {
      expect(error).toMatchObject({ name: 'GistFetchError', code: 'GIST_NOT_FOUND', gistId, retryable: false });
      expect(error).toBeInstanceOf(GistFetchError);
      expect(spawn).toHaveBeenCalledTimes(1);
      return;
    }
    throw new Error(`expected defaultFetchGist to reject, got a resolved value instead: ${JSON.stringify(result)}`);
  });

  it('an already-aborted signal rejects immediately without ever invoking the transport', async () => {
    const controller = new AbortController();
    controller.abort(new Error('operator cancelled the reconcile run'));
    const spawn = vi.fn();
    await expect(defaultFetchGist(gistId, { spawn, sleep: noSleep, signal: controller.signal }))
      .rejects.toThrow(/cancelled the reconcile run/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a signal aborted between retry attempts stops further attempts', async () => {
    const controller = new AbortController();
    const spawn = vi.fn().mockReturnValue(fail('gh: TLS handshake timeout'));
    const sleep = vi.fn().mockImplementation(async () => { controller.abort(new Error('cancelled mid-retry')); });
    await expect(defaultFetchGist(gistId, { spawn, sleep, retries: 5, signal: controller.signal }))
      .rejects.toThrow(/cancelled mid-retry/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
