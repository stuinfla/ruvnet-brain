// rvf-wire.mjs — read-only readers for the RVF on-disk format, used by the C2 store audit
// (scripts/rvf-index-audit.mjs) to recover the vectors the engine actually stores so exact
// nearest neighbours can be computed without trusting the index under test.
//
// Why this exists: the installed engine (@ruvector/rvf 0.3.4 over @ruvector/rvf-node 0.2.3)
// exposes no read-vector-by-id or scan API on either layer — verified by enumerating
// `Object.getOwnPropertyNames(RvfDatabase.prototype)` on both (see rvf-index-audit.mjs). The only
// way to obtain the stored vectors is to read VEC_SEG payloads directly.
//
// Every layout below is transcribed from rUv's source (ruvector monorepo, crates/rvf):
//   segment header (64 B, LE) ......... rvf-types/src/segment.rs:10-42; constants.rs:4 (magic), :19 (size)
//   header byte positions ............. rvf-runtime/src/write_path.rs:472-490 (header_to_bytes)
//   segment type ids .................. rvf-types/src/segment_type.rs (Vec 0x01, Index 0x02, Journal 0x04,
//                                       Manifest 0x05, Witness 0x0A) — NOT the 0x00-based table in the npm README
//   content hash ...................... rvf-runtime/src/hashing.rs:22-33 (IEEE CRC32 rotated 0/8/16/24 bits
//                                       into four LE lanes; checksum_algo 0)
//   VEC_SEG payload ................... rvf-runtime/src/write_path.rs:48-70, read_path.rs:289-330
//                                       (dim u16, count u32, then [id u64, f32 x dim])
//   manifest payload .................. rvf-runtime/src/read_path.rs:150-256 (epoch u32, dim u16, total u64,
//                                       seg_count u32, profile u8, metric u8, pad u16, dir entries 25 B each,
//                                       del_count u32, deleted ids u64 each)
//   journal payload ................... rvf-runtime/src/write_path.rs:88-108 (entry_count u32, epoch u32,
//                                       prev u64, entries [type u8, pad u8, len u16, id u64])
//   metric ids ........................ rvf-runtime/src/options.rs:42-48 (1 inner_product, 2 cosine, else l2)
//   deletion authority ................ rvf-runtime/src/store.rs:2484 (deletion bitmap = manifest.deleted_ids)
// Empirically confirmed against the installed binary (2026-09-13): header walk agrees with
// segments(), VEC payload round-trips ingested vectors bit-exactly, re-ingesting an existing id
// appends a second entry with the SAME label and the engine serves the LAST one, and
// status().totalVectors === (distinct VEC labels) - (manifest deleted ids) on stores with deletes.
import fs from 'node:fs';

export const SEGMENT_MAGIC = 0x52564653;
export const SEGMENT_HEADER_SIZE = 64;
export const SEG_TYPE = Object.freeze({ VEC: 0x01, INDEX: 0x02, JOURNAL: 0x04, MANIFEST: 0x05, WITNESS: 0x0a });
const SEG_TYPE_NAME = Object.freeze({ 0x01: 'vec', 0x02: 'index', 0x04: 'journal', 0x05: 'manifest', 0x0a: 'witness' });
const MAX_SAFE_LABEL = Number.MAX_SAFE_INTEGER;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** IEEE CRC32 (poly 0xEDB88320, init 0xFFFFFFFF, final XOR) — hashing.rs:39-54's reference. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** hashing.rs:25-33 — the CRC rotated left by 0/8/16/24 bits, each written as a LE u32 lane. */
export function legacyContentHash(payload) {
  const crc = crc32(payload);
  const out = Buffer.alloc(16);
  for (let lane = 0; lane < 4; lane++) {
    const shift = lane * 8;
    const rotated = shift ? ((crc << shift) | (crc >>> (32 - shift))) >>> 0 : crc;
    out.writeUInt32LE(rotated, lane * 4);
  }
  return out;
}

export function metricFromId(id) {
  return id === 1 ? 'dotproduct' : id === 2 ? 'cosine' : 'l2';
}

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) throw new Error(`unexpected end of file at ${position + done}`);
    done += n;
  }
  return buffer;
}

function readSegmentHeader(fd, offset) {
  const h = readExact(fd, SEGMENT_HEADER_SIZE, offset);
  return {
    magic: h.readUInt32LE(0),
    version: h.readUInt8(4),
    segType: h.readUInt8(5),
    flags: h.readUInt16LE(6),
    segmentId: Number(h.readBigUInt64LE(8)),
    payloadLength: Number(h.readBigUInt64LE(16)),
    checksumAlgo: h.readUInt8(32),
    compression: h.readUInt8(33),
    contentHash: h.subarray(40, 56),
  };
}

function readLabel(buffer, offset) {
  const label = buffer.readBigUInt64LE(offset);
  if (label > BigInt(MAX_SAFE_LABEL)) throw new Error(`vector label ${label} exceeds Number.MAX_SAFE_INTEGER`);
  return Number(label);
}

function parseVecPayload(payload) {
  if (payload.length < 6) throw new Error('VEC_SEG payload shorter than its 6-byte header');
  const dimension = payload.readUInt16LE(0);
  const count = payload.readUInt32LE(2);
  const bytesPerVector = 8 + dimension * 4;
  if (payload.length < 6 + count * bytesPerVector) throw new Error(`VEC_SEG payload truncated: ${payload.length} < ${6 + count * bytesPerVector}`);
  const rows = new Array(count);
  let offset = 6;
  for (let i = 0; i < count; i++) {
    const label = readLabel(payload, offset);
    offset += 8;
    // Float32Array needs 4-byte alignment; entry payloads sit at 6 + 8 (mod 4 = 2), so copy.
    const aligned = new ArrayBuffer(dimension * 4);
    new Uint8Array(aligned).set(payload.subarray(offset, offset + dimension * 4));
    offset += dimension * 4;
    rows[i] = { label, vector: new Float32Array(aligned) };
  }
  return { dimension, count, rows };
}

function parseManifestPayload(payload) {
  if (payload.length < 22) throw new Error('manifest payload shorter than 22 bytes');
  const segCount = payload.readUInt32LE(14);
  if (segCount > Math.floor((payload.length - 22) / 25)) throw new Error('manifest segment directory exceeds payload');
  const directory = [];
  let offset = 22;
  for (let i = 0; i < segCount; i++) {
    directory.push({
      segmentId: Number(payload.readBigUInt64LE(offset)),
      offset: Number(payload.readBigUInt64LE(offset + 8)),
      payloadLength: Number(payload.readBigUInt64LE(offset + 16)),
      segType: payload.readUInt8(offset + 24),
    });
    offset += 25;
  }
  const deletedIds = [];
  if (offset + 4 <= payload.length) {
    const deletedCount = payload.readUInt32LE(offset);
    offset += 4;
    for (let i = 0; i < deletedCount && offset + 8 <= payload.length; i++) {
      deletedIds.push(readLabel(payload, offset));
      offset += 8;
    }
  }
  return {
    epoch: payload.readUInt32LE(0),
    dimension: payload.readUInt16LE(4),
    profileId: payload.readUInt8(18),
    metricId: payload.readUInt8(19),
    metric: metricFromId(payload.readUInt8(19)),
    directory,
    deletedIds,
  };
}

function parseJournalPayload(payload) {
  if (payload.length < 16) throw new Error('journal payload shorter than 16 bytes');
  const entryCount = payload.readUInt32LE(0);
  const deletedIds = [];
  let offset = 16;
  for (let i = 0; i < entryCount && offset + 12 <= payload.length; i++) {
    const entryType = payload.readUInt8(offset);
    if (entryType === 0x01) deletedIds.push(readLabel(payload, offset + 4));
    offset += 12;
  }
  return { epoch: payload.readUInt32LE(4), deletedIds };
}

/**
 * Read every segment the engine lists (`RvfDatabase#segments()` — the authoritative directory, since
 * segments are NOT 64-byte aligned on disk) and return the live stored vectors plus structural failures.
 *
 * Live set = last VEC entry per label (engine behaviour, see header) minus the latest manifest's
 * deleted ids (store.rs:2484) unioned with any JOURNAL tombstones. Callers compare
 * `vectors.size` with `status().totalVectors`.
 */
export function readRvfStoredVectors(rvfPath, listedSegments) {
  const failures = [];
  const vectors = new Map();
  const deleted = new Set();
  let dimension = null;
  let entries = 0;
  let duplicateLabels = 0;
  let manifest = null;
  let hashesVerified = 0;
  const fd = fs.openSync(rvfPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    for (const listed of listedSegments) {
      const where = `${listed.segType}#${listed.id}@${listed.offset}`;
      if (listed.offset + SEGMENT_HEADER_SIZE + listed.payloadLength > fileSize) {
        failures.push({ kind: 'segment-beyond-eof', segment: where, detail: `file is ${fileSize} bytes` });
        continue;
      }
      const header = readSegmentHeader(fd, listed.offset);
      const expectedName = SEG_TYPE_NAME[header.segType];
      if (header.magic !== SEGMENT_MAGIC || header.payloadLength !== listed.payloadLength
        || (expectedName && expectedName !== listed.segType)) {
        failures.push({ kind: 'segment-header-mismatch', segment: where, detail: `magic=0x${header.magic.toString(16)} type=${header.segType} payloadLength=${header.payloadLength}` });
        continue;
      }
      if (header.compression !== 0) {
        failures.push({ kind: 'compressed-segment-unsupported', segment: where, detail: `compression=${header.compression}` });
        continue;
      }
      const payload = readExact(fd, header.payloadLength, listed.offset + SEGMENT_HEADER_SIZE);
      if (!legacyContentHash(payload).equals(header.contentHash)) {
        failures.push({ kind: 'segment-content-hash-mismatch', segment: where, detail: 'payload bytes do not hash to the header content_hash (hashing.rs:22-33)' });
        continue;
      }
      hashesVerified++;
      try {
        if (header.segType === SEG_TYPE.VEC) {
          const vec = parseVecPayload(payload);
          if (dimension === null) dimension = vec.dimension;
          else if (vec.dimension !== dimension) failures.push({ kind: 'dimension-mismatch', segment: where, detail: `${vec.dimension} != ${dimension}` });
          for (const row of vec.rows) {
            entries++;
            if (vectors.has(row.label)) duplicateLabels++;
            vectors.set(row.label, row.vector);
          }
        } else if (header.segType === SEG_TYPE.MANIFEST) {
          manifest = parseManifestPayload(payload);
        } else if (header.segType === SEG_TYPE.JOURNAL) {
          for (const id of parseJournalPayload(payload).deletedIds) deleted.add(id);
        }
      } catch (error) {
        failures.push({ kind: 'segment-payload-malformed', segment: where, detail: error.message });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  let supersededSegments = 0;
  if (manifest) {
    for (const id of manifest.deletedIds) deleted.add(id);
    // A manifest directory is a point-in-time snapshot, so a directory entry the engine no longer
    // lists is normal: rebuilding the HNSW appends a new INDEX_SEG and supersedes the old one, which
    // stays on disk as dead space (measured on the live corpus: ruvector's last manifest still points
    // at index seg 331 @87206459 while segments() serves index 338 @96475134, deadSpaceRatio 0.0245).
    // What is NOT acceptable is a DANGLING entry — one whose bytes are gone, truncated, or no longer
    // a well-formed segment of the declared type. Only that is reported as a failure.
    const listedByOffset = new Map(listedSegments.map((segment) => [segment.offset, segment]));
    const fd2 = fs.openSync(rvfPath, 'r');
    try {
      const fileSize = fs.fstatSync(fd2).size;
      for (const entry of manifest.directory) {
        const seen = listedByOffset.get(entry.offset);
        if (seen && seen.payloadLength === entry.payloadLength) continue;
        if (entry.offset + SEGMENT_HEADER_SIZE + entry.payloadLength > fileSize) {
          failures.push({ kind: 'manifest-directory-dangling', detail: `manifest points at segment type=${entry.segType} offset=${entry.offset} length=${entry.payloadLength}, past the ${fileSize}-byte end of file` });
          continue;
        }
        const header = readSegmentHeader(fd2, entry.offset);
        if (header.magic !== SEGMENT_MAGIC || header.segType !== entry.segType || header.payloadLength !== entry.payloadLength) {
          failures.push({ kind: 'manifest-directory-dangling', detail: `manifest points at segment type=${entry.segType} offset=${entry.offset} length=${entry.payloadLength}, but those bytes are magic=0x${header.magic.toString(16)} type=${header.segType} length=${header.payloadLength}` });
          continue;
        }
        supersededSegments++;
      }
    } finally {
      fs.closeSync(fd2);
    }
  }
  for (const id of deleted) vectors.delete(id);
  return { dimension, vectors, entries, duplicateLabels, deleted, manifest, hashesVerified, supersededSegments, segmentCount: listedSegments.length, failures };
}
