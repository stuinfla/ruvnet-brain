#!/usr/bin/env node
// Transport only: signatures and acceptance remain owned by independent-review-receipt.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';

export const MAX_DISPATCH_BYTES = 60000;
export const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const FIELDS = ['fable_receipt_b64', 'astra_receipt_b64', 'release_identity_b64'];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validateEnvelope(envelope) {
  if (!/^[a-f0-9]{40}$/.test(envelope.candidate_sha || '')) throw new Error('invalid candidate SHA');
  const values = [envelope.candidate_sha, ...FIELDS.map((field) => envelope[field])];
  if (values.some((value) => typeof value !== 'string' || !value.length)) throw new Error('missing grading input');
  if (values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > MAX_DISPATCH_BYTES) {
    throw new Error('dispatch payload exceeds GitHub workflow input budget');
  }
}

function validateJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_REVIEW_BYTES) throw new Error('review exceeds decoded byte limit');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review input must be a JSON object');
}

export function encodeGradingInputs(candidateSha, documents) {
  const envelope = { candidate_sha: candidateSha };
  for (const field of FIELDS) {
    const bytes = documents[field];
    validateJson(bytes);
    envelope[field] = gzipSync(bytes, { level: 9 }).toString('base64');
  }
  validateEnvelope(envelope);
  return envelope;
}

export function decodeGradingInputs(envelope) {
  validateEnvelope(envelope); // Bound encoded input before allocating decoded buffers.
  return Object.fromEntries(FIELDS.map((field) => {
    const encoded = envelope[field];
    if (!BASE64.test(encoded)) throw new Error('grading input is not canonical base64');
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) throw new Error('grading input is not canonical base64');
    // The shared encoder emits a plain ten-byte header, never optional header fields.
    if (compressed.length < 18 || !compressed.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0]))) {
      throw new Error('grading input must be plain-header gzip');
    }
    const options = { maxOutputLength: MAX_REVIEW_BYTES };
    const bytes = gunzipSync(compressed, options); // Verifies CRC and trailer, with an allocation cap.
    const single = inflateRawSync(compressed.subarray(10), { ...options, info: true });
    if (single.engine.bytesWritten + 18 !== compressed.length) throw new Error('grading input must contain exactly one gzip member');
    validateJson(bytes);
    return [field, bytes];
  }));
}

export function decodeGradingEnvironment(env = process.env, cwd = process.cwd()) {
  const documents = decodeGradingInputs({ candidate_sha: env.CANDIDATE_SHA,
    fable_receipt_b64: env.FABLE_B64, astra_receipt_b64: env.ASTRA_B64, release_identity_b64: env.IDENTITY_B64 });
  fs.mkdirSync(path.join(cwd, 'reviews'), { recursive: true });
  for (const [field, relative] of [
    ['fable_receipt_b64', 'reviews/claude-fable-5-1.json'],
    ['astra_receipt_b64', 'reviews/gpt-6-astra.json'],
    ['release_identity_b64', 'release-identity.json'],
  ]) fs.writeFileSync(path.join(cwd, relative), documents[field], { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { decodeGradingEnvironment(); }
  catch (error) { console.error(`machine-grading-transport: ${error.message}`); process.exitCode = 1; }
}
