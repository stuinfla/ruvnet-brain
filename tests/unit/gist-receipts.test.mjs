import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../../scripts/coverage-integrity.mjs';
import {
  GistFetchError,
  buildGistAggregate,
  captureGistSources,
  defaultFetchDetail,
  defaultFetchGist,
  defaultFetchRaw,
  renderGistPassages,
  sealGistReceipt,
  sealGistReceiptSet,
  validateGistReceipt,
} from '../../scripts/gist-receipts.mjs';

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
const observation = () => ({
  owner: 'ruvnet', observedAt: '2026-08-22T01:30:00Z', observationSha256: 'e'.repeat(64),
  gists: { rows: [
    { id: id('a'), updated_at: '2026-08-22T00:00:00Z', files: listedFiles(id('a')) },
    { id: id('b'), updated_at: '2026-08-22T01:00:00Z', files: listedFiles(id('b')) },
  ] },
});
const fakeFetchDetail = async (gistId) => fetchedGist(gistId);
const fakeFetchRaw = async (file) => Buffer.from(file.content || '', 'utf8');

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-receipts-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

async function fakeBuildVector({ assetsDir, store }) {
  fs.writeFileSync(path.join(assetsDir, `${store}.big.rvf`), `fake-rvf-bytes-for-${store}`);
  fs.writeFileSync(path.join(assetsDir, `${store}.big.rvf.idmap.json`), '{}');
  fs.writeFileSync(path.join(assetsDir, `${store}.big.rvf.embed.json`), '{}');
}

describe('sealGistReceipt / sealGistReceiptSet — canonical ordering', () => {
  it('seals mixed-case filenames in the canonical sorted order', () => {
    const gistId = id('f');
    const gist = sealGistReceipt({ gistId, versionSha: 'd'.repeat(40),
      updatedAt: '2026-08-22T01:00:00Z', ingestedAt: '2026-08-22T02:00:00Z', complete: true,
      files: [
        { filename: 'backtest.mjs', included: true, sha256: digest('backtest'), bytes: 8 },
        { filename: 'HammerStarSweep.mq5', included: false, reason: 'non-text policy exclusion', size: 1 },
      ] });
    expect(gist.files.map(({ filename }) => filename)).toEqual(['HammerStarSweep.mq5', 'backtest.mjs']);
    const receipt = sealGistReceiptSet({ owner: 'ruvnet', generated: '2026-08-22T02:00:00Z',
      observedAt: '2026-08-22T01:30:00Z', sourceObservationSha256: 'e'.repeat(64),
      passagesSha256: null, gists: { [gistId]: gist } });
    expect(receipt).toMatchObject({ schemaVersion: 3, kind: 'ruvnet-brain-gist-source-receipts', passagesSha256: null });
  });
});

describe('captureGistSources — cache reuse, fetch, tamper detection, and observation drift', () => {
  it('reuses only unchanged exact cache entries (with bodies) and fetches every changed or missing gist', async () => {
    const seen = [];
    const cache = { gists: { [id('a')]: { gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-22T00:00:00Z', complete: true,
      files: [{ filename: 'old.md', included: true, sha256: digest('old'), bytes: 3, body: 'old' }] } } };
    const captured = await captureGistSources({ observation: observation(), cache,
      fetchDetail: async (gistId) => { seen.push(gistId); return fetchedGist(gistId); },
      fetchRaw: fakeFetchRaw, now: () => '2026-08-22T02:00:00Z' });
    expect(seen).toEqual([id('b')]);
    expect(captured.reuseEvidence).toEqual({ reused: [id('a')], fetched: [id('b')] });
    expect(captured.gists[id('a')].files[0].body).toBe('old');
    expect(captured.gists[id('b')].files.map(({ filename, included }) => ({ filename, included }))).toEqual([
      { filename: 'code.js', included: false },
      { filename: 'new.md', included: true },
    ]);
  });

  it('a changed updatedAt is an ordinary cache MISS, not tampering', async () => {
    const stale = { gists: { [id('a')]: { gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-21T23:59:59Z', complete: true,
      files: [{ filename: 'old.md', included: true, sha256: digest('old'), bytes: 3, body: 'old' }] } } };
    const refetched = [];
    await captureGistSources({ observation: observation(), cache: stale,
      fetchDetail: async (gistId) => { refetched.push(gistId); return fetchedGist(gistId); },
      fetchRaw: fakeFetchRaw });
    expect(refetched).toEqual([id('a'), id('b')]);
  });

  it('a body-free cache entry (e.g. the published receipt) can never supply reuse and is treated as a miss', async () => {
    const bodyFree = { gists: { [id('a')]: { gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-22T00:00:00Z', complete: true,
      files: [{ filename: 'old.md', included: true, sha256: digest('old'), bytes: 3 }] } } };
    const fetched = [];
    await captureGistSources({ observation: observation(), cache: bodyFree,
      fetchDetail: async (gistId) => { fetched.push(gistId); return fetchedGist(gistId); },
      fetchRaw: fakeFetchRaw });
    expect(fetched).toEqual([id('a'), id('b')]);
  });

  // PROOF 3: a tampered cache (body hash mismatch) fails rather than silently accepting stale content.
  it('PROOF: a tampered cache entry (body hash mismatch) throws rather than silently reusing it', async () => {
    const tampered = { gists: { [id('a')]: { gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-22T00:00:00Z', complete: true,
      files: [{ filename: 'old.md', included: true, sha256: digest('old'), bytes: 3, body: 'TAMPERED' }] } } };
    const fetchDetail = vi.fn(async (gistId) => fetchedGist(gistId));
    await expect(captureGistSources({ observation: observation(), cache: tampered, fetchDetail, fetchRaw: fakeFetchRaw }))
      .rejects.toThrow(/tampered or corrupted cache entry/);
    // Fails BEFORE silently accepting the stale/tampered content -- and never quietly refetches
    // around it either, which would mask the corruption just as effectively as trusting it.
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('a real bit-flip against the recorded sha256 is caught even when byte length is unchanged', async () => {
    const flipped = Buffer.from('old', 'utf8');
    flipped[0] ^= 0xff;
    const tampered = { gists: { [id('a')]: { gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-22T00:00:00Z', complete: true,
      files: [{ filename: 'old.md', included: true, sha256: digest('old'), bytes: 3, body: flipped.toString('utf8') }] } } };
    await expect(captureGistSources({ observation: observation(), cache: tampered, fetchDetail: fakeFetchDetail, fetchRaw: fakeFetchRaw }))
      .rejects.toThrow(/tampered or corrupted cache entry/);
  });

  it('fails closed with GIST_OBSERVATION_MOVED when the exact detail fetch disagrees with the list', async () => {
    const moved = fetchedGist(id('a'));
    moved.files['old.md'].raw_url = 'https://gist.example/moved/old.md';
    await expect(captureGistSources({ observation: observation(),
      fetchDetail: async (gistId) => gistId === id('a') ? moved : fetchedGist(gistId), fetchRaw: fakeFetchRaw }))
      .rejects.toMatchObject({ code: 'GIST_OBSERVATION_MOVED', gistId: id('a') });
  });

  it('rejects invalid UTF-8 instead of capturing a broken body', async () => {
    await expect(captureGistSources({
      observation: observation(), fetchDetail: fakeFetchDetail,
      fetchRaw: async (file) => file.filename === 'new.md' ? Buffer.from([0xc3, 0x28]) : Buffer.from('old'),
    })).rejects.toThrow(/not valid UTF-8/);
  });

  // PROOF 4: a removed gist (present in a stale cache, absent from a fresh observation) disappears.
  it('PROOF: a gist removed from the observation is absent from a fresh capture, even if the cache still has it', async () => {
    const cacheWithRemoved = { gists: { [id('a')]: { gistId: id('a'), versionSha: 'c'.repeat(40),
      updatedAt: '2026-08-22T00:00:00Z', complete: true,
      files: [{ filename: 'old.md', included: true, sha256: digest('old'), bytes: 3, body: 'old' }] },
      [id('z')]: { gistId: id('z'), versionSha: 'c'.repeat(40), updatedAt: '2020-01-01T00:00:00Z', complete: true,
        files: [{ filename: 'gone.md', included: true, sha256: digest('gone'), bytes: 4, body: 'gone' }] } } };
    const captured = await captureGistSources({ observation: observation(), cache: cacheWithRemoved,
      fetchDetail: fakeFetchDetail, fetchRaw: fakeFetchRaw });
    expect(Object.keys(captured.gists).sort()).toEqual([id('a'), id('b')].sort());
    expect(captured.gists[id('z')]).toBeUndefined();
  });
});

describe('renderGistPassages — the one banner/chunk/JSONL implementation', () => {
  it('renders a banner-prefixed, sorted, gist-id-truncated passage path per included file', () => {
    const captured = {
      owner: 'ruvnet',
      gists: {
        [id('a')]: { gistId: id('a'), updatedAt: '2026-08-22T00:00:00Z',
          files: [{ filename: 'old.md', included: true, body: 'First paragraph.\n\nSecond paragraph.' }] },
      },
    };
    const { passageBytes, metadata, gistRecords } = renderGistPassages({ captured, generatedAt: '2026-08-22T02:00:00Z' });
    const passages = passageBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(passages).toHaveLength(1);
    expect(passages[0].path).toBe(`${id('a').slice(0, 8)}/old.md`);
    expect(passages[0].text).toMatch(/^SOURCE: GitHub gist by @ruvnet — "old\.md"/);
    expect(passages[0].text).toMatch(/Second paragraph\.$/);
    expect(metadata.name).toBe('ruv-gists');
    expect(metadata.entries['0'].path).toBe(passages[0].path);
    expect(gistRecords[id('a')]).toMatchObject({ schemaVersion: 3, gistId: id('a') });
    // The publishable per-gist record never carries raw body text.
    expect(gistRecords[id('a')].files[0].body).toBeUndefined();
  });

  it('splits a file into #N-suffixed chunks only when more than one chunk results', () => {
    const big = `${'x'.repeat(3100)}\n\n${'y'.repeat(300)}`;
    const captured = { owner: 'ruvnet', gists: { [id('a')]: { gistId: id('a'), updatedAt: '2026-08-22T00:00:00Z',
      files: [{ filename: 'big.md', included: true, body: big }] } } };
    const { passageBytes } = renderGistPassages({ captured, generatedAt: '2026-08-22T02:00:00Z' });
    const passages = passageBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(passages).toHaveLength(2);
    expect(passages[0].path).toBe(`${id('a').slice(0, 8)}/big.md#0`);
    expect(passages[1].path).toBe(`${id('a').slice(0, 8)}/big.md#1`);
  });

  it('escapes U+2028/U+2029 so JSONL stays one physical line per passage', () => {
    const captured = { owner: 'ruvnet', gists: { [id('a')]: { gistId: id('a'), updatedAt: '2026-08-22T00:00:00Z',
      files: [{ filename: 'line.md', included: true, body: 'before after' }] } } };
    const { passageBytes } = renderGistPassages({ captured, generatedAt: '2026-08-22T02:00:00Z' });
    const raw = passageBytes.toString('utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    expect(raw).toContain('\\u2028');
  });
});

describe('validateGistReceipt — the one shared validator (reuse / produce / archive)', () => {
  it('requires a real passages file in every mode', () => {
    expect(() => validateGistReceipt({ receipt: {}, passagesFile: null })).toThrow(/passages file/);
  });

  it('rejects an owner mismatch, unsafe filename, or malformed timestamp before delegating to the shared aggregate validator', () => {
    const root = temp();
    const passagesFile = path.join(root, 'ruv-gists.passages.jsonl');
    fs.writeFileSync(passagesFile, '');
    const base = { owner: 'ruvnet', generated: '2026-08-22T02:00:00Z', observedAt: '2026-08-22T01:30:00Z', gists: {} };
    expect(() => validateGistReceipt({ receipt: { ...base, owner: 'someone-else' }, passagesFile, expectedOwner: 'ruvnet' }))
      .toThrow(/owner/);
    expect(() => validateGistReceipt({ receipt: { ...base, generated: 'not-a-date' }, passagesFile, expectedOwner: 'ruvnet' }))
      .toThrow(/timestamp/);
    expect(() => validateGistReceipt({
      receipt: { ...base, gists: { [id('a')]: { updatedAt: '2026-08-22T00:00:00Z', ingestedAt: '2026-08-22T00:30:00Z',
        files: [{ filename: '../../escape.md' }] } } },
      passagesFile, expectedOwner: 'ruvnet',
    })).toThrow(/unsafe or missing filename/);
  });
});

describe('buildGistAggregate — capture + render + write + embed + seal + validate, atomically', () => {
  it('builds, embeds, and seals a complete schema-3 aggregate with a bound, non-null passagesSha256', async () => {
    const root = temp();
    const outDir = path.join(root, 'kb');
    fs.mkdirSync(outDir, { recursive: true });
    const result = await buildGistAggregate({
      observation: observation(), outDir, transport: { fetchDetail: fakeFetchDetail, fetchRaw: fakeFetchRaw },
      buildVector: fakeBuildVector, now: () => '2026-08-22T02:00:00Z',
    });
    expect(result.omitted).toBeUndefined();
    expect(result.kind).toBe('gist-aggregate');
    expect(result.sourceReceipt.passagesSha256).not.toBeNull();
    expect(result.sourceReceipt.passagesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.passages.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.sources.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.big.rvf'))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'ruv-gists.sources.json'), 'utf8'));
    expect(onDisk).toEqual(result.sourceReceipt);
    // The receipt binds the bytes ACTUALLY written to disk.
    const actualPassages = fs.readFileSync(path.join(outDir, 'ruv-gists.passages.jsonl'));
    const crypto = await import('node:crypto');
    expect(onDisk.passagesSha256).toBe(crypto.createHash('sha256').update(actualPassages).digest('hex'));
  });

  // PROOF 1: unchanged observation leaves finalized bytes untouched (idempotency; the destructive
  // re-observation bug — re-running against an identical gist set no longer destroys the binding).
  it('PROOF: a second build over an identical gist set produces byte-identical passages and receipt', async () => {
    const root = temp();
    const outDir = path.join(root, 'kb');
    fs.mkdirSync(outDir, { recursive: true });
    const opts = { observation: observation(), outDir, transport: { fetchDetail: fakeFetchDetail, fetchRaw: fakeFetchRaw },
      buildVector: fakeBuildVector, now: () => '2026-08-22T02:00:00Z' };
    const first = await buildGistAggregate(opts);
    const firstPassages = fs.readFileSync(path.join(outDir, 'ruv-gists.passages.jsonl'), 'utf8');
    const second = await buildGistAggregate({ ...opts, cache: { gists: {} } }); // fresh, unrelated cache -> full refetch again
    const secondPassages = fs.readFileSync(path.join(outDir, 'ruv-gists.passages.jsonl'), 'utf8');
    expect(secondPassages).toBe(firstPassages);
    expect(second.sourceReceipt).toEqual(first.sourceReceipt);
  });

  // PROOF 2: a changed detail fetch takes a bounded retry (not infinite, not zero).
  it('PROOF: a transient detail-fetch failure is retried a bounded number of times, then surfaces', async () => {
    let attempts = 0;
    const flaky = async (gistId, options) => {
      attempts += 1;
      if (attempts < 3) throw new GistFetchError('flaky', { code: 'GIST_TRANSIENT_FAILURE', retryable: true, gistId });
      return fetchedGist(gistId);
    };
    // captureGistSources itself does not retry (that is defaultFetchGist's job) -- prove the BOUND by
    // exercising defaultFetchGist directly through the same transport seam buildGistAggregate uses.
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'gh: TLS handshake timeout' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'gh: TLS handshake timeout' })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(fetchedGist(id('a'))), stderr: '' });
    const detail = await defaultFetchGist(id('a'), { spawn, sleep: async () => {}, retries: 3 });
    expect(detail.id).toBe(id('a'));
    expect(spawn).toHaveBeenCalledTimes(3); // bounded: not 1 (no retry), not unbounded
    const alwaysFails = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'gh: TLS handshake timeout' });
    await expect(defaultFetchGist(id('a'), { spawn: alwaysFails, sleep: async () => {}, retries: 2 }))
      .rejects.toMatchObject({ code: 'GIST_TRANSIENT_FAILURE' });
    expect(alwaysFails).toHaveBeenCalledTimes(2);
    void flaky; // documents the higher-level shape captureGistSources sees; the bound itself lives one layer down
  });

  // PROOF 5: a failed vector build exposes NO finalized receipt.
  it('PROOF: a failed vector build leaves outDir completely untouched -- no receipt, no passages', async () => {
    const root = temp();
    const outDir = path.join(root, 'kb');
    fs.mkdirSync(outDir, { recursive: true });
    const failingBuildVector = async () => { throw new Error('embedding blew up'); };
    await expect(buildGistAggregate({
      observation: observation(), outDir, transport: { fetchDetail: fakeFetchDetail, fetchRaw: fakeFetchRaw },
      buildVector: failingBuildVector, now: () => '2026-08-22T02:00:00Z',
    })).rejects.toThrow(/embedding blew up/);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.sources.json'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.passages.jsonl'))).toBe(false);
    expect(fs.readdirSync(outDir)).toEqual([]); // the fresh stage directory was cleaned up too
  });

  it('an empty observed gist set OMITS the aggregate entirely -- no receipt, no store, no error', async () => {
    const root = temp();
    const outDir = path.join(root, 'kb');
    fs.mkdirSync(outDir, { recursive: true });
    const result = await buildGistAggregate({
      observation: { owner: 'ruvnet', observedAt: '2026-08-22T01:30:00Z', observationSha256: 'e'.repeat(64), gists: { rows: [] } },
      outDir, buildVector: fakeBuildVector,
    });
    expect(result.omitted).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.sources.json'))).toBe(false);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('a nonempty observed set with zero usable passages after exclusions fails explicitly', async () => {
    const root = temp();
    const outDir = path.join(root, 'kb');
    fs.mkdirSync(outDir, { recursive: true });
    const onlyCode = () => ({
      owner: 'ruvnet', observedAt: '2026-08-22T01:30:00Z', observationSha256: 'e'.repeat(64),
      gists: { rows: [{ id: id('a'), updated_at: '2026-08-22T00:00:00Z',
        files: { 'run.mjs': { filename: 'run.mjs', raw_url: 'https://x/run.mjs', size: 1, type: 'application/javascript', language: 'JavaScript' } } }] },
    });
    const fetchDetail = async (gistId) => ({ id: gistId, updated_at: '2026-08-22T00:00:00Z', history: [{ version: 'c'.repeat(40) }],
      files: { 'run.mjs': { filename: 'run.mjs', raw_url: 'https://x/run.mjs', size: 1, type: 'application/javascript', language: 'JavaScript',
        content: 'console.log(1)', truncated: false } } });
    await expect(buildGistAggregate({ observation: onlyCode(), outDir, transport: { fetchDetail, fetchRaw: fakeFetchRaw }, buildVector: fakeBuildVector }))
      .rejects.toThrow(/zero usable passages/);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('buildVector: null skips embedding entirely and leaves generation null / RVF-GENERATIONS.json untouched', async () => {
    const root = temp();
    const outDir = path.join(root, 'kb');
    fs.mkdirSync(outDir, { recursive: true });
    const result = await buildGistAggregate({
      observation: observation(), outDir, transport: { fetchDetail: fakeFetchDetail, fetchRaw: fakeFetchRaw },
      buildVector: null, now: () => '2026-08-22T02:00:00Z',
    });
    expect(result.generation).toBeNull();
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.big.rvf'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'RVF-GENERATIONS.json'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'ruv-gists.sources.json'))).toBe(true);
  });
});

// defaultFetchGist — UNCHANGED from Step 0 (its retry/error-classification logic is not modified by
// Step 2). Kept here to prove `defaultFetchDetail`'s wrapper genuinely does not duplicate it.
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
  });

  it('integration rejection (403, no gist-scoped token) throws a typed, non-retryable error on the first attempt', async () => {
    const spawn = vi.fn().mockReturnValue(fail('gh: Resource not accessible by integration (HTTP 403)'));
    await expect(defaultFetchGist(gistId, { spawn, sleep: noSleep }))
      .rejects.toMatchObject({ name: 'GistFetchError', code: 'GIST_FORBIDDEN', gistId, retryable: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a moved/deleted gist (404) produces a clear typed error, never a silent null, and is not retried', async () => {
    const spawn = vi.fn().mockReturnValue(fail('gh: Not Found (HTTP 404)'));
    await expect(defaultFetchGist(gistId, { spawn, sleep: noSleep }))
      .rejects.toMatchObject({ name: 'GistFetchError', code: 'GIST_NOT_FOUND', gistId, retryable: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal rejects immediately without ever invoking the transport', async () => {
    const controller = new AbortController();
    controller.abort(new Error('operator cancelled the reconcile run'));
    const spawn = vi.fn();
    await expect(defaultFetchGist(gistId, { spawn, sleep: noSleep, signal: controller.signal }))
      .rejects.toThrow(/cancelled the reconcile run/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('defaultFetchDetail — falls back to the PUBLIC detail endpoint ONLY on the integration rejection', () => {
  const gistId = 'f'.repeat(32);

  it('on GIST_FORBIDDEN, retries the public endpoint with no Authorization header and succeeds', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' });
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`https://api.github.com/gists/${gistId}`);
      expect(init.headers.authorization).toBeUndefined();
      return { ok: true, status: 200, json: async () => ({ id: gistId, files: {} }) };
    });
    const result = await defaultFetchDetail(gistId, { spawn, sleep: async () => {}, fetchImpl });
    expect(result).toEqual({ id: gistId, files: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on other failures (e.g. not found) -- those propagate untouched', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
    const fetchImpl = vi.fn();
    await expect(defaultFetchDetail(gistId, { spawn, sleep: async () => {}, fetchImpl }))
      .rejects.toMatchObject({ code: 'GIST_NOT_FOUND' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a dead public fallback surfaces its own failure, never swallowed', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(defaultFetchDetail(gistId, { spawn, sleep: async () => {}, fetchImpl }))
      .rejects.toMatchObject({ code: 'GIST_FETCH_FAILED', status: 404 });
  });
});

describe('defaultFetchRaw — raw-content transport on its own retry/quota budget', () => {
  it('a non-truncated file never touches the network', async () => {
    const fetchImpl = vi.fn();
    const body = await defaultFetchRaw({ truncated: false, content: 'inline body' }, { fetchImpl });
    expect(body.toString('utf8')).toBe('inline body');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a truncated file fetches raw_url and retries a bounded number of times on a transient failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('full body') });
    const body = await defaultFetchRaw({ truncated: true, raw_url: 'https://x/y' },
      { fetchImpl, sleep: async () => {}, retries: 3 });
    expect(body.toString('utf8')).toBe('full body');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('exhausts its bound and throws rather than retrying forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(defaultFetchRaw({ truncated: true, raw_url: 'https://x/y' },
      { fetchImpl, sleep: async () => {}, retries: 2 })).rejects.toMatchObject({ code: 'GIST_RAW_TRANSIENT_FAILURE' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a non-transient failure (404) is not retried', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(defaultFetchRaw({ truncated: true, raw_url: 'https://x/y' },
      { fetchImpl, sleep: async () => {}, retries: 3 })).rejects.toMatchObject({ code: 'GIST_RAW_FETCH_FAILED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
