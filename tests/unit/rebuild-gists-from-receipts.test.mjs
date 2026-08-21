import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  paragraphChunks,
  provenanceBanner,
  rawUrlFor,
  reconstructGists,
  validateSourceReceipts,
  writeReconstruction,
} from '../../scripts/rebuild-gists-from-receipts.mjs';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-gists-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileReceipt = (filename, body) => ({
  filename,
  included: true,
  sha256: sha256(Buffer.from(body)),
  bytes: Buffer.byteLength(body),
});
const sourceReceipt = ({ body = 'First paragraph.\n\nSecond paragraph.', filename = 'notes.md' } = {}) => {
  const files = [fileReceipt(filename, body)];
  return {
    versionSha: 'b'.repeat(40),
    updatedAt: '2026-08-19T19:34:25Z',
    ingestedAt: '2026-08-21T10:07:27.229Z',
    files,
    contentDigest: sha256(JSON.stringify(files)),
    complete: true,
  };
};
const sources = (gists) => ({
  schemaVersion: 1,
  owner: 'ruvnet',
  generated: '2026-08-21T10:07:27.229Z',
  gists,
});

describe('receipt validation and deterministic shaping', () => {
  it('uses the exact versioned raw URL and the ingestion banner/chunk rules', () => {
    expect(rawUrlFor({ owner: 'ruvnet', gistId: 'a'.repeat(32), versionSha: 'b'.repeat(40), filename: 'folder/a note.md' }))
      .toBe(`https://gist.githubusercontent.com/ruvnet/${'a'.repeat(32)}/raw/${'b'.repeat(40)}/folder/a%20note.md`);
    expect(paragraphChunks('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc']);
    expect(paragraphChunks('x'.repeat(20), 10)).toEqual(['x'.repeat(20)]);
    expect(provenanceBanner({ owner: 'ruvnet', gistId: 'a'.repeat(32), filename: 'notes.md', updatedAt: '2026-08-19T19:34:25Z' }))
      .toBe(`SOURCE: GitHub gist by @ruvnet — "notes.md"\nGIST STATUS: rUv's own notes / release announcement — may describe PROPOSED or UNRELEASED work.\nTreat as intent, not as confirmed shipped behavior: verify against repo source before asserting.\nupdated: 2026-08-19 · https://gist.github.com/ruvnet/${'a'.repeat(32)}\n\n`);
  });

  it('fails closed on incomplete, malformed, duplicate, or internally drifted receipts', () => {
    const gistId = 'a'.repeat(32);
    expect(() => validateSourceReceipts(sources({}))).toThrow(/no gist receipts/i);
    expect(() => validateSourceReceipts(sources({ [gistId]: { ...sourceReceipt(), complete: false } })))
      .toThrow(/incomplete/i);
    expect(() => validateSourceReceipts(sources({ [gistId]: { ...sourceReceipt(), versionSha: 'main' } })))
      .toThrow(/versionSha/i);
    const duplicate = sourceReceipt();
    duplicate.files.push({ ...duplicate.files[0] });
    duplicate.contentDigest = sha256(JSON.stringify(duplicate.files));
    expect(() => validateSourceReceipts(sources({ [gistId]: duplicate }))).toThrow(/duplicate filename/i);
    expect(() => validateSourceReceipts(sources({ [gistId]: { ...sourceReceipt(), contentDigest: '0'.repeat(64) } })))
      .toThrow(/contentDigest/i);
    const excluded = sourceReceipt();
    excluded.files = [{ filename: 'code.mjs', included: false, reason: 'non-text policy exclusion', size: -1 }];
    excluded.contentDigest = sha256(JSON.stringify(excluded.files));
    expect(() => validateSourceReceipts(sources({ [gistId]: excluded }))).toThrow(/exclusion evidence/i);
  });
});

describe('raw receipt reconstruction', () => {
  it('fetches with bounded concurrency while preserving receipt order and exact per-gist identities', async () => {
    const firstId = 'a'.repeat(32);
    const secondId = 'c'.repeat(32);
    const first = sourceReceipt({ body: 'Alpha body.', filename: 'alpha.md' });
    const second = sourceReceipt({ body: 'Beta body.', filename: 'beta note.txt' });
    const input = sources({ [firstId]: first, [secondId]: second });
    const bodies = new Map([
      [rawUrlFor({ owner: input.owner, gistId: firstId, versionSha: first.versionSha, filename: 'alpha.md' }), 'Alpha body.'],
      [rawUrlFor({ owner: input.owner, gistId: secondId, versionSha: second.versionSha, filename: 'beta note.txt' }), 'Beta body.'],
    ]);
    let active = 0;
    let peak = 0;
    const fetchFn = async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, url.includes('alpha') ? 8 : 1));
      active--;
      const body = Buffer.from(bodies.get(url));
      return { ok: true, status: 200, arrayBuffer: async () => body };
    };

    const result = await reconstructGists(input, { fetchFn, concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.passages.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: '0', path: `${firstId.slice(0, 8)}/alpha.md` },
      { id: '1', path: `${secondId.slice(0, 8)}/beta note.txt` },
    ]);
    expect(result.passages[0].text).toMatch(/^SOURCE: GitHub gist by @ruvnet — "alpha\.md"/);
    expect(result.passages[0].text).toMatch(/Alpha body\.$/);
    expect(result.meta.generated).toBe(input.generated);
    expect(result.meta.entries['1'].title).toBe('beta note.txt');
    expect(result.sources.schemaVersion).toBe(2);
    expect(result.sources.passagesSha256).toBe(sha256(result.passageBody));
    expect(result.sources.gists).toEqual(input.gists);
  });

  it('rejects HTTP failure, byte drift, and digest drift', async () => {
    const gistId = 'a'.repeat(32);
    const input = sources({ [gistId]: sourceReceipt({ body: 'expected' }) });
    await expect(reconstructGists(input, {
      fetchFn: async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) }),
    })).rejects.toThrow(/HTTP 404/i);
    await expect(reconstructGists(input, {
      fetchFn: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('longer-than-expected') }),
    })).rejects.toThrow(/byte count/i);
    const sameBytes = Buffer.from('drifted!');
    expect(sameBytes.length).toBe(Buffer.byteLength('expected'));
    await expect(reconstructGists(input, {
      fetchFn: async () => ({ ok: true, status: 200, arrayBuffer: async () => sameBytes }),
    })).rejects.toThrow(/sha256/i);
  });

  it('writes only passages, metadata, and the schema-2 receipt projection', async () => {
    const root = temp();
    const gistId = 'a'.repeat(32);
    const input = sources({ [gistId]: sourceReceipt({ body: 'line\u2028separator' }) });
    const result = await reconstructGists(input, {
      fetchFn: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('line\u2028separator') }),
    });
    const written = writeReconstruction(result, { outDir: root });
    expect(written).toEqual({
      passagesFile: path.join(root, 'ruv-gists.passages.jsonl'),
      metaFile: path.join(root, 'ruv-gists.meta.json'),
      sourcesFile: path.join(root, 'ruv-gists.sources.json'),
    });
    expect(fs.readFileSync(written.passagesFile, 'utf8')).toContain('\\u2028');
    expect(JSON.parse(fs.readFileSync(written.sourcesFile, 'utf8')).passagesSha256).toBe(sha256(result.passageBody));
    expect(fs.readdirSync(root).sort()).toEqual([
      'ruv-gists.meta.json', 'ruv-gists.passages.jsonl', 'ruv-gists.sources.json',
    ]);
  });
});
