// HTTP Range census of a published corpus generation (scripts/generation-census.mjs), against a
// hand-built zip served by a fake fetch: no network. Each refusal is proven by building the bad archive.
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseEocd, rangeCensus } from '../../scripts/generation-census.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-census-')); dirs.push(dir); return dir; };

const idmap = (n) => Buffer.from(JSON.stringify({ idToLabel: Object.fromEntries(Array.from({ length: n }, (_, i) => [`id${i}`, i])) }));

/** A minimal PKZIP writer: local headers, central directory, end record. */
function buildZip(members, { zip64Locator = false, zip64Marker = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const m of members) {
    const name = Buffer.from(m.name);
    const method = m.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(m.data) : m.data;
    const crc = m.crc ?? zlib.crc32(m.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(m.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(m.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(zip64Marker ? 0xffffffff : offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const locator = Buffer.alloc(zip64Locator ? 20 : 0);
  if (zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([...locals, cd, locator, eocd]);
}

/** A fake fetch: the release API plus a redirecting, Range-honouring asset host. */
function server(zip, { id = 42 } = {}) {
  const calls = { api: 0, ranges: 0 };
  const fetch = async (url, { headers = {} } = {}) => {
    if (url.startsWith('https://api.github.com/')) {
      calls.api += 1;
      return { ok: true, status: 200, json: async () => ({ assets: [{ id, name: 'ruvnet-brain.zip', size: zip.length, browser_download_url: 'https://dl.test/zip' }] }) };
    }
    calls.ranges += 1;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    const body = zip.subarray(Number(a), Number(b) + 1);
    return { status: 206, url: 'https://signed.test/zip', headers: { get: () => `bytes ${a}-${b}/${zip.length}` }, arrayBuffer: async () => body };
  };
  return { fetch, calls };
}

function privateFence(dir, stores = ['secret']) {
  const file = path.join(dir, 'PRIVATE-STORES.json');
  fs.writeFileSync(file, JSON.stringify({ privateStores: stores }));
  return file;
}

const census = (zip, dir, extra = {}) => rangeCensus({ repo: 'o/r', tag: 'corpus-sha256-abc', fetch: server(zip).fetch, cacheDir: dir,
  privateStoresFile: privateFence(dir), token: null, ...extra });

it('counts public idmap chunks over Range reads, skipping private, __MACOSX and resource-fork members', async () => {
  const dir = tmp();
  const zip = buildZip([
    { name: 'ruvnet-brain/kb/alpha.big.rvf.idmap.json', data: idmap(3) },
    { name: 'ruvnet-brain/kb/beta.big.rvf.idmap.json', data: idmap(5), method: 0 },
    { name: 'ruvnet-brain/kb/secret.big.rvf.idmap.json', data: idmap(100) },
    { name: '__MACOSX/ruvnet-brain/kb/alpha.big.rvf.idmap.json', data: idmap(7) },
    { name: 'ruvnet-brain/kb/._gamma.big.rvf.idmap.json', data: idmap(9) },
    { name: 'ruvnet-brain/kb/alpha.big.rvf', data: Buffer.alloc(2 * 1048576, 1), method: 0 },
  ]);
  const result = await census(zip, dir);
  expect(result).toMatchObject({ publicStores: 2, chunks: 8, builtStores: 2, entries: 6, cached: false, assetId: 42 });
  // Only the tail, the central directory and the idmap members travel — never the 2 MB store body.
  expect(result.fetchedBytes).toBeLessThan(80_000);
});

it('caches by tag and asset identity outside the repository, and refuses a size the caller did not expect', async () => {
  const dir = tmp();
  const zip = buildZip([{ name: 'kb/alpha.big.rvf.idmap.json', data: idmap(4) }]);
  const fence = privateFence(dir);
  const first = server(zip);
  await rangeCensus({ repo: 'o/r', tag: 't1', fetch: first.fetch, cacheDir: dir, privateStoresFile: fence, token: null });
  const second = server(zip);
  const again = await rangeCensus({ repo: 'o/r', tag: 't1', fetch: second.fetch, cacheDir: dir, privateStoresFile: fence, token: null });
  expect(again).toMatchObject({ chunks: 4, cached: true });
  expect(second.calls.ranges).toBe(0);
  expect(fs.readdirSync(path.join(dir, 'ruvnet-brain-generation-census'))).toHaveLength(1);
  await expect(rangeCensus({ repo: 'o/r', tag: 't1', bytes: zip.length + 1, fetch: server(zip).fetch, cacheDir: tmp(),
    privateStoresFile: fence, token: null })).rejects.toThrow(/expected/);
});

it('fails loudly on a CRC mismatch', async () => {
  const zip = buildZip([{ name: 'kb/alpha.big.rvf.idmap.json', data: idmap(4), crc: 0x12345678 }]);
  await expect(census(zip, tmp())).rejects.toThrow(/CRC-32/);
});

it('refuses zip64 archives: a locator before the end record, or a 0xffffffff offset', async () => {
  await expect(census(buildZip([{ name: 'kb/a.big.rvf.idmap.json', data: idmap(1) }], { zip64Locator: true }), tmp())).rejects.toThrow(/zip64/);
  await expect(census(buildZip([{ name: 'kb/a.big.rvf.idmap.json', data: idmap(1) }], { zip64Marker: true }), tmp())).rejects.toThrow(/zip64/);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0xffff, 10); eocd.writeUInt16LE(0xffff, 8);
  expect(() => parseEocd(eocd)).toThrow(/zip64/);
});

it('refuses a compression method other than stored or deflate, a missing fence, and an archive with no public idmap', async () => {
  const bzip = buildZip([{ name: 'kb/a.big.rvf.idmap.json', data: idmap(1), method: 12 }]);
  await expect(census(bzip, tmp())).rejects.toThrow(/method 12/);
  const dir = tmp();
  await expect(rangeCensus({ repo: 'o/r', tag: 't', fetch: server(bzip).fetch, cacheDir: dir, privateStoresFile: path.join(dir, 'none.json') }))
    .rejects.toThrow();
  await expect(census(buildZip([{ name: 'kb/secret.big.rvf.idmap.json', data: idmap(2) }]), tmp())).rejects.toThrow(/no public/);
});
