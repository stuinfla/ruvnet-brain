#!/usr/bin/env node
// DISTINCT-FROM: kb/zip-extract.mjs — that extracts a whole local archive from a file descriptor; this reads only the idmap sidecars of a REMOTE release asset over HTTP Range and never fetches the ~750 MB body.
//
// scripts/generation-census.mjs — the public census (public stores, chunks) of a published corpus
// generation, read straight from its release asset without downloading it.
//
// Release QE requires the committed claim surfaces (README, explainer/*) to quote the exact census of
// the NEWEST corpus generation, and the corpus republishes nightly. Assembling a candidate to learn
// two numbers costs ~750 MB and a minute; the numbers live in ~200 small `*.big.rvf.idmap.json`
// members of the zip. So: Range-read the end-of-central-directory, the central directory, and each
// idmap member; inflate, CRC-check, count `idToLabel` keys; exclude the private fence exactly as
// scripts/claims-verify.mjs computePublicChunkTotal does. Anything unexpected (zip64, another
// compression method, a CRC mismatch, a short read) fails loudly — a wrong census is worse than none.
//
//   node scripts/generation-census.mjs --repo owner/name --tag corpus-sha256-<digest>

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE_ASSET = 'ruvnet-brain.zip';
export const IDMAP_SUFFIX = '.big.rvf.idmap.json';
const TAIL_BYTES = 66_000; // EOCD (22) + the largest possible comment (65,535) + the zip64 locator (20)
const SIG = { eocd: 0x06054b50, zip64Locator: 0x07064b50, central: 0x02014b50, local: 0x04034b50 };
const U16 = 0xffff;
const U32 = 0xffffffff;
const CONCURRENCY = 8;

const zip64 = (what) => new Error(`zip64 ${what}: this reader refuses zip64 archives rather than guess at their layout`);

/** End-of-central-directory from the archive's last bytes. */
export function parseEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG.eocd) continue;
    if (i >= 20 && tail.readUInt32LE(i - 20) === SIG.zip64Locator) throw zip64('end-of-central-directory locator');
    const disk = tail.readUInt16LE(i + 4), cdDisk = tail.readUInt16LE(i + 6);
    const onDisk = tail.readUInt16LE(i + 8), total = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12), cdOffset = tail.readUInt32LE(i + 16);
    if (total === U16 || onDisk === U16 || cdSize === U32 || cdOffset === U32) throw zip64('marker in the end-of-central-directory');
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new Error('multi-disk zip archives are not supported');
    return { total, cdSize, cdOffset };
  }
  throw new Error('no end-of-central-directory record in the archive tail');
}

/** Every central-directory entry: name, method, flags, crc, sizes, local-header offset. */
export function parseCentralDirectory(cd, expected) {
  const entries = [];
  let p = 0;
  while (p < cd.length) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG.central) throw new Error(`malformed central directory at byte ${p}`);
    const nameLength = cd.readUInt16LE(p + 28), extraLength = cd.readUInt16LE(p + 30), commentLength = cd.readUInt16LE(p + 32);
    const entry = {
      name: cd.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42),
      extraLength,
    };
    if (entry.compressedSize === U32 || entry.size === U32 || entry.offset === U32) throw zip64(`marker on entry ${entry.name}`);
    const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    for (let q = 0; q + 4 <= extra.length; q += 4 + extra.readUInt16LE(q + 2)) {
      if (extra.readUInt16LE(q) === 0x0001) throw zip64(`extra field on entry ${entry.name}`);
    }
    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (Number.isInteger(expected) && entries.length !== expected) {
    throw new Error(`central directory lists ${entries.length} entries; the end record says ${expected}`);
  }
  return entries;
}

/** The public idmap members: no resource forks, no private store, no store counted twice. */
export function selectIdmapEntries(entries, privateStores = []) {
  const fence = new Set(privateStores);
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.name.endsWith(IDMAP_SUFFIX) || entry.name.split('/').includes('__MACOSX')) continue;
    const base = path.posix.basename(entry.name);
    if (base.startsWith('._')) continue;
    const store = base.slice(0, -IDMAP_SUFFIX.length);
    if (fence.has(store)) continue;
    if (seen.has(store)) throw new Error(`store ${store} has two idmap members (${seen.get(store).name}, ${entry.name})`);
    seen.set(store, { ...entry, store });
  }
  return [...seen.values()];
}

/** One member's bytes from a buffer that starts at its local header; null when the buffer is too short. */
export function decodeEntry(entry, local) {
  if (local.length < 30 || local.readUInt32LE(0) !== SIG.local) throw new Error(`no local header for ${entry.name}`);
  const start = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (local.length < start + entry.compressedSize) return { need: start + entry.compressedSize };
  const raw = local.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`${entry.name} uses compression method ${entry.method}; only stored (0) and deflate (8) are read`);
  if (typeof zlib.crc32 !== 'function') throw new Error('zlib.crc32 is unavailable (Node >= 20.15 / 22.2 required) — cannot verify members');
  if (data.length !== entry.size) throw new Error(`${entry.name} inflated to ${data.length} bytes; the directory says ${entry.size}`);
  const crc = zlib.crc32(data) >>> 0;
  if (crc !== entry.crc >>> 0) throw new Error(`${entry.name} failed its CRC-32 check (expected ${entry.crc.toString(16)}, got ${crc.toString(16)})`);
  return { data };
}

export function countIdmap(buffer, name) {
  const { idToLabel } = JSON.parse(buffer.toString('utf8'));
  if (!idToLabel || typeof idToLabel !== 'object' || Array.isArray(idToLabel)) throw new Error(`${name} has no idToLabel object`);
  return Object.keys(idToLabel).length;
}

export function readPrivateStores(file = path.join(ROOT, 'kb', 'PRIVATE-STORES.json')) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed?.privateStores)) throw new Error(`${file} lacks a privateStores array`);
  return [...parsed.privateStores].sort();
}

/** The release asset row (id, size, url) from the GitHub API. */
async function resolveAsset({ repo, tag, fetch, token }) {
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (!response.ok) throw new Error(`release ${tag}: GitHub API answered HTTP ${response.status}`);
  const assets = ((await response.json())?.assets || []).filter((asset) => asset?.name === ARCHIVE_ASSET);
  if (assets.length !== 1) throw new Error(`release ${tag} has ${assets.length} ${ARCHIVE_ASSET} assets; expected exactly one`);
  return { id: assets[0].id, size: assets[0].size, url: assets[0].browser_download_url };
}

/** Range reads against the asset; the redirect is resolved once and re-resolved if the signed URL lapses. */
function rangeReader({ url, size, fetch }) {
  let target = url;
  let fetched = 0;
  const read = async (start, end, retried = false) => {
    const response = await fetch(target, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
    if (response.status !== 206) {
      if (!retried && target !== url) { target = url; return read(start, end, true); }
      throw new Error(`range ${start}-${end} of ${url}: expected HTTP 206, got ${response.status}`);
    }
    const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') || '')?.[1]);
    if (total !== size) throw new Error(`asset is ${total} bytes; the release says ${size}`);
    if (response.url) target = response.url;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== end - start + 1) throw new Error(`short range read ${start}-${end}: ${buffer.length} bytes`);
    fetched += buffer.length;
    return buffer;
  };
  return { read, fetched: () => fetched };
}

async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i]); }
  }));
  return out;
}

export async function rangeCensus({ repo, tag, bytes = null, privateStoresFile, fetch = globalThis.fetch,
  cacheDir = os.tmpdir(), token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null, asset = null,
  concurrency = CONCURRENCY } = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo || ''))) throw new Error('repo must be owner/name');
  if (!/^[A-Za-z0-9._-]+$/.test(String(tag || ''))) throw new Error(`invalid release tag: ${tag}`);
  const privateStores = readPrivateStores(privateStoresFile);
  const resolved = asset || await resolveAsset({ repo, tag, fetch, token });
  if (!Number.isSafeInteger(resolved.size) || resolved.size < 22) throw new Error(`release ${tag} asset has no usable size`);
  if (bytes !== null && bytes !== resolved.size) throw new Error(`release ${tag} asset is ${resolved.size} bytes; expected ${bytes}`);

  const key = crypto.createHash('sha256').update(JSON.stringify({ repo, tag, assetId: resolved.id, size: resolved.size, privateStores }))
    .digest('hex').slice(0, 32);
  const cacheFile = path.join(cacheDir, 'ruvnet-brain-generation-census', `${key}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached?.tag === tag && Number.isSafeInteger(cached.chunks)) return { ...cached, cached: true };
  } catch { /* no usable cache entry: measure */ }

  const started = Date.now();
  const { read, fetched } = rangeReader({ url: resolved.url || `https://github.com/${repo}/releases/download/${tag}/${ARCHIVE_ASSET}`,
    size: resolved.size, fetch });
  const tailStart = Math.max(0, resolved.size - TAIL_BYTES);
  const eocd = parseEocd(await read(tailStart, resolved.size - 1));
  if (eocd.cdOffset + eocd.cdSize > resolved.size) throw new Error('central directory lies outside the archive');
  const entries = parseCentralDirectory(await read(eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1), eocd.total);
  const selected = selectIdmapEntries(entries, privateStores);
  if (!selected.length) throw new Error(`release ${tag} contains no public *${IDMAP_SUFFIX} members`);
  const counts = await pool(selected, concurrency, async (entry) => {
    const guess = 30 + Buffer.byteLength(entry.name) + entry.extraLength + entry.compressedSize + 256;
    let local = await read(entry.offset, Math.min(resolved.size, entry.offset + guess) - 1);
    let decoded = decodeEntry(entry, local);
    if (decoded.need) {
      local = await read(entry.offset, entry.offset + decoded.need - 1);
      decoded = decodeEntry(entry, local);
      if (decoded.need) throw new Error(`${entry.name}: local header disagrees with the central directory`);
    }
    return countIdmap(decoded.data, entry.name);
  });
  const result = { tag, publicStores: selected.length, chunks: counts.reduce((a, b) => a + b, 0), builtStores: selected.length,
    assetId: resolved.id ?? null, archiveBytes: resolved.size, fetchedBytes: fetched(), entries: entries.length,
    seconds: Math.round((Date.now() - started) / 100) / 10 };
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
    fs.renameSync(temp, cacheFile);
  } catch { /* a cache is an optimisation; the measured result stands */ }
  return { ...result, cached: false };
}

const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (isDirectInvocation(import.meta.url)) {
  const argv = process.argv.slice(2);
  rangeCensus({ repo: arg(argv, '--repo') || process.env.GITHUB_REPOSITORY, tag: arg(argv, '--tag') })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => { console.error(`[generation-census] ${error.message}`); process.exitCode = 1; });
}
