// kb/zip-extract.mjs — extract a .zip using ONLY Node built-ins. No `unzip` binary, no shell.
//
// WHY THIS EXISTS (a real, measured stranger-machine failure, not a hypothetical):
// The stranger-machine CI matrix (.github/workflows/stranger-matrix.yml) ran the PACKED installer on
// a virgin windows-latest runner and the install aborted:
//
//   ✗ install stopped: extraction failed
//     (`unzip -q -o D:\a\_temp\proj\node_modules\ruvnet-brain\dist\ruvnet-brain.zip
//        -d D:\a\_temp\home-healthy\.cache\ruvnet-brain\kb` exited with code 1).
//
// Shelling out to `unzip` is fragile on Windows for two INDEPENDENT reasons, and a stranger hits
// whichever one their machine hands them:
//   1. PowerShell has no `unzip` at all — nothing named `unzip` is on a stock Windows PATH.
//   2. Git Bash DOES put an MSYS2 `unzip` on PATH, and bin/install.mjs spawns with `shell: true` on
//      Windows (it must, for .cmd shims), so the command line goes through cmd.exe carrying native
//      `D:\a\...` paths into a POSIX-ish tool that treats `\` as an escape character. Same class of
//      bug this repo already fixed once for ESM specifiers (raw `C:\` paths -> pathToFileURL).
// A path handed to a shell must be correct for THAT shell. The most reliable way to get that right
// is to never involve a shell: read the archive in-process.
//
// WHY NOT A LIBRARY: `npm ls --omit=dev --all` on this repo shows exactly two production deps
// (@metaharness/flywheel, @metaharness/router) and NO zip library anywhere in the tree — measured,
// not assumed. Node ships no archive reader either, so there was nothing already present to reuse:
// adding yauzl/adm-zip/fflate would put a new third-party package (and its transitive tree) in the
// path of `npx ruvnet-brain`, which bin/install.mjs's own header rule forbids ("dependency-free —
// Node built-ins only"). node:zlib's inflateRawSync/createInflateRaw is the deflate half of a zip;
// what is written below is only the container parsing around it.
//
// SCOPE, stated honestly: this reads the zip features our own bundles actually use — stored (0) and
// deflate (8), ZIP64, data descriptors, unix modes, symlinks. It refuses, LOUDLY and by name,
// anything it does not implement (encryption, other compression methods). It never guesses.
//
// FAIL LOUD. Every failure path throws an Error naming the archive, the entry, and what was wrong.
// A silent partial extraction that leaves an empty directory behind is worse than the original bug,
// so entry bytes are counted and (on Node >= 20.15 / 22.2, where zlib.crc32 exists) CRC-checked
// against the archive's own central-directory values.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export const ZIP_LIMITS = Object.freeze({
  archiveBytes: 2 * 1024 ** 3,
  entries: 100_000,
  centralDirectoryBytes: 128 * 1024 ** 2,
  entryBytes: 2 * 1024 ** 3,
  totalBytes: 8 * 1024 ** 3,
  compressionRatio: 1_000,
});

// zlib.crc32 landed in Node 20.15.0 / 22.2.0. package.json engines allow >=18, so it is OPTIONAL —
// present it is used, absent the size check still stands and the caller is told which happened.
// Reimplementing CRC-32 here would be hand-rolling something the runtime ships.
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

class Tally extends Transform {
  constructor(maxBytes) { super(); this.bytes = 0; this.crc = 0; this.maxBytes = maxBytes; }
  _transform(chunk, _enc, cb) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(new Error(`uncompressed entry exceeded the ${this.maxBytes}-byte safety limit`));
      return;
    }
    if (crc32) this.crc = crc32(chunk, this.crc);
    this.push(chunk);
    cb();
  }
}

function readAt(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  if (got !== length) throw new Error(`truncated archive: wanted ${length} bytes at offset ${position}, got ${got}`);
  return buf;
}

/** Locate the End Of Central Directory record, tolerating a trailing zip comment (<=64KB). */
function findEocd(fd, size) {
  const window = Math.min(size, 0xffff + 22);
  const buf = readAt(fd, window, size - window);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    return { buf, i, absolute: size - window + i };
  }
  throw new Error('not a zip archive (no End Of Central Directory record found)');
}

/**
 * Where the central directory lives, honoring ZIP64 when the 32-bit fields are saturated.
 * Bundles built by `zip -r` cross into ZIP64 on size or entry count without announcing it, so this
 * is not optional defensive coding — a 4GB/65535-entry brain bundle is a realistic shape.
 */
function centralDirectoryLocation(fd, size) {
  const { buf, i, absolute } = findEocd(fd, size);
  let entries = buf.readUInt16LE(i + 10);
  let cdSize = buf.readUInt32LE(i + 12);
  let cdOffset = buf.readUInt32LE(i + 16);

  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = absolute - 20;
    if (locAt < 0) throw new Error('archive claims ZIP64 but has no ZIP64 locator');
    const loc = readAt(fd, 20, locAt);
    if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new Error('archive claims ZIP64 but the ZIP64 locator signature is wrong');
    const eocd64At = Number(loc.readBigUInt64LE(8));
    const rec = readAt(fd, 56, eocd64At);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error('ZIP64 End Of Central Directory signature is wrong');
    entries = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  return { entries, cdSize, cdOffset };
}

/** ZIP64 extra field (0x0001): only the fields whose 32-bit form is saturated are present, in order. */
function applyZip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + len);
    if (id === 0x0001) {
      let q = 0;
      if (entry.uncompSize === 0xffffffff && q + 8 <= body.length) { entry.uncompSize = Number(body.readBigUInt64LE(q)); q += 8; }
      if (entry.compSize === 0xffffffff && q + 8 <= body.length) { entry.compSize = Number(body.readBigUInt64LE(q)); q += 8; }
      if (entry.localOffset === 0xffffffff && q + 8 <= body.length) { entry.localOffset = Number(body.readBigUInt64LE(q)); q += 8; }
      return;
    }
    p += 4 + len;
  }
}

function parseCentralDirectory(cd) {
  const out = [];
  let p = 0;
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const entry = {
      versionMadeBy: cd.readUInt16LE(p + 4),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      compSize: cd.readUInt32LE(p + 20),
      uncompSize: cd.readUInt32LE(p + 24),
      externalAttrs: cd.readUInt32LE(p + 38),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    };
    applyZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry);
    out.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Reject anything that would write outside destDir. A downloaded archive is untrusted input, and
 * `unzip` itself refuses `../` traversal — so this is parity with the tool being replaced, not an
 * extra. Backslash is normalized to `/` first: a zip written on Windows may legitimately use it,
 * and treating `a\..\..\b` as one opaque segment is exactly how traversal guards get bypassed.
 */
function safeJoin(destDir, name) {
  const rel = name.replace(/\\/g, '/');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  if (rel.split('/').some((seg) => seg === '..')) return null;
  const target = path.resolve(destDir, rel);
  const root = path.resolve(destDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Extract `zipPath` into `destDir`, overwriting existing files (idempotent — the `-o` of
 * `unzip -q -o`). Returns { entries, entryNames, files, bytes, crcChecked }.
 * Throws an Error naming the archive and the offending entry on ANY problem.
 */
export async function extractZip(zipPath, destDir) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) throw new Error('archive is empty (0 bytes)');
    if (size > ZIP_LIMITS.archiveBytes) {
      throw new Error(`archive is ${size} bytes, above the ${ZIP_LIMITS.archiveBytes}-byte safety limit`);
    }
    const { cdSize, cdOffset } = centralDirectoryLocation(fd, size);
    if (cdSize > ZIP_LIMITS.centralDirectoryBytes) {
      throw new Error(`central directory is ${cdSize} bytes, above the ${ZIP_LIMITS.centralDirectoryBytes}-byte safety limit`);
    }
    if (cdOffset + cdSize > size) throw new Error(`central directory runs past end of file (offset ${cdOffset} + ${cdSize} > ${size})`);
    const entries = parseCentralDirectory(readAt(fd, cdSize, cdOffset));
    if (entries.length === 0) throw new Error('central directory contains no entries');
    if (entries.length > ZIP_LIMITS.entries) {
      throw new Error(`archive has ${entries.length} entries, above the ${ZIP_LIMITS.entries}-entry safety limit`);
    }
    let declaredTotal = 0;
    for (const entry of entries) {
      const unixType = (entry.externalAttrs >>> 16) & 0xf000;
      if ((entry.versionMadeBy >> 8) === 3 && unixType === 0xa000) {
        throw new Error(`entry "${entry.name}" is a symbolic link — downloaded bundles may contain regular files and directories only`);
      }
      if (!Number.isSafeInteger(entry.uncompSize) || entry.uncompSize < 0) {
        throw new Error(`entry "${entry.name}" has an unsafe uncompressed size`);
      }
      if (entry.uncompSize > ZIP_LIMITS.entryBytes) {
        throw new Error(`entry "${entry.name}" claims ${entry.uncompSize} bytes, above the ${ZIP_LIMITS.entryBytes}-byte safety limit`);
      }
      declaredTotal += entry.uncompSize;
      if (!Number.isSafeInteger(declaredTotal) || declaredTotal > ZIP_LIMITS.totalBytes) {
        throw new Error(`archive claims ${declaredTotal} uncompressed bytes, above the ${ZIP_LIMITS.totalBytes}-byte safety limit`);
      }
      const ratio = entry.uncompSize / Math.max(entry.compSize, 1);
      if (ratio > ZIP_LIMITS.compressionRatio) {
        throw new Error(`entry "${entry.name}" has compression ratio ${ratio.toFixed(1)}, above the ${ZIP_LIMITS.compressionRatio}:1 safety limit`);
      }
    }

    fs.mkdirSync(destDir, { recursive: true });
    let files = 0;
    let bytes = 0;

    const normalizedEntryNames = entries.map((entry) => entry.name.replace(/\\/g, '/'));
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const e = entries[entryIndex];
      if (e.flags & 0x1) throw new Error(`entry "${e.name}" is encrypted — this archive cannot be extracted without a password`);
      const target = safeJoin(destDir, e.name);
      if (target === null) throw new Error(`entry "${e.name}" would escape the destination directory — refusing to extract (possible zip-slip)`);

      // PowerShell Compress-Archive can encode directories without a trailing slash and marks them
      // inconsistently across PowerShell/.NET versions: some archives carry the DOS directory bit,
      // while others carry neither that bit nor a trailing slash. A zero-byte entry that is an
      // ancestor of another central-directory entry is unambiguously a directory, so use the
      // archive's own tree as the final signal. Treating it as a file poisons the next nested entry
      // (`vendor` file, then `vendor/package.json` → ENOTDIR).
      const unixType = (e.externalAttrs >>> 16) & 0xf000;
      const normalizedName = normalizedEntryNames[entryIndex].replace(/\/+$/, '');
      const hasDescendant = e.uncompSize === 0 && normalizedEntryNames.some(
        (candidate, candidateIndex) => candidateIndex !== entryIndex
          && candidate.startsWith(`${normalizedName}/`),
      );
      const isDirectory = e.name.endsWith('/')
        || (e.externalAttrs & 0x10) !== 0
        || ((e.versionMadeBy >> 8) === 3 && unixType === 0x4000)
        || hasDescendant;
      if (isDirectory) {
        try {
          if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) {
            fs.rmSync(target, { recursive: true, force: true });
          }
        } catch { /* mkdir below reports any unrecoverable collision with the exact path */ }
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });

      // Sizes/offsets come from the CENTRAL directory, never the local header: with a data
      // descriptor (flag bit 3, what streaming zippers emit) the local header's sizes are zeros.
      const local = readAt(fd, 30, e.localOffset);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`entry "${e.name}" has a bad local header signature at offset ${e.localOffset}`);
      const dataStart = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

      if (e.method !== 0 && e.method !== 8) {
        throw new Error(`entry "${e.name}" uses unsupported compression method ${e.method} (only stored=0 and deflate=8 are implemented)`);
      }

      // A zero-length entry has no data range to stream (start > end would be a nonsense read), so
      // it is written directly. Its size/CRC assertions below still apply.
      if (e.compSize === 0) {
        fs.writeFileSync(target, Buffer.alloc(0));
        if (e.uncompSize !== 0) throw new Error(`entry "${e.name}" is corrupt: 0 compressed bytes but claims ${e.uncompSize} uncompressed`);
        files++;
        continue;
      }

      const tally = new Tally(Math.min(e.uncompSize, ZIP_LIMITS.entryBytes));
      const partial = path.join(path.dirname(target), `.ruvnet-extract-${process.pid}-${entryIndex}.tmp`);
      try { fs.rmSync(partial, { force: true }); } catch { /* absent */ }
      const stages = [fs.createReadStream(zipPath, { start: dataStart, end: dataStart + e.compSize - 1 })];
      if (e.method === 8) stages.push(zlib.createInflateRaw());
      stages.push(tally, fs.createWriteStream(partial, { flags: 'wx' }));

      try {
        await pipeline(...stages);
      } catch (err) {
        try { fs.rmSync(partial, { force: true }); } catch { /* best effort */ }
        throw new Error(`entry "${e.name}" failed to inflate (${err && err.code ? err.code : ''}${err && err.message ? ` ${err.message}` : ''}) — the archive is corrupt or truncated`);
      }
      if (tally.bytes !== e.uncompSize) {
        fs.rmSync(partial, { force: true });
        throw new Error(`entry "${e.name}" is corrupt: expected ${e.uncompSize} bytes, extracted ${tally.bytes}`);
      }
      if (crc32 && (tally.crc >>> 0) !== (e.crc >>> 0)) {
        fs.rmSync(partial, { force: true });
        // Zero-padded to 8 hex digits so the value is directly comparable to the one Info-ZIP's
        // own `unzip` prints for the same damaged entry ("bad CRC 811e0dd1 (should be 0f6994e4)").
        const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
        throw new Error(`entry "${e.name}" failed its CRC-32 check (expected ${hex(e.crc)}, got ${hex(tally.crc)}) — the archive is corrupt`);
      }
      if (process.platform === 'win32') fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(partial, target);

      // Unix permission bits, when the archive carries them. Skipped on Windows, which has no
      // POSIX mode and where chmod is a no-op at best.
      if (process.platform !== 'win32' && (e.versionMadeBy >> 8) === 3) {
        const mode = (e.externalAttrs >>> 16) & 0o7777;
        if (mode) { try { fs.chmodSync(target, mode); } catch { /* mode is a nicety, not the payload */ } }
      }
      files++;
      bytes += tally.bytes;
    }
    return {
      entries: entries.length,
      entryNames: entries.map((entry) => entry.name),
      files,
      bytes,
      crcChecked: Boolean(crc32),
    };
  } catch (err) {
    // Always name the archive: "extraction failed" without the file is the message this whole
    // change exists to stop shipping.
    err.message = `${zipPath}: ${err.message}`;
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

export default { extractZip };
