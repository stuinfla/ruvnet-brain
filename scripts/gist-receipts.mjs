#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, digest } from './coverage-integrity.mjs';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst']);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const withoutReceiptDigest = ({ receiptSha256: _receiptSha256, ...payload }) => payload;

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function sealGistReceipt(receipt) {
  const files = [...(receipt.files || [])].sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  const payload = {
    schemaVersion: 3,
    kind: 'ruvnet-brain-gist-source-receipt',
    gistId: String(receipt.gistId || ''),
    versionSha: receipt.versionSha,
    updatedAt: receipt.updatedAt,
    ingestedAt: receipt.ingestedAt,
    fileCount: files.length,
    files,
    contentDigest: digest(files),
    complete: receipt.complete === true,
  };
  return { ...payload, receiptSha256: digest(payload) };
}

export function sealGistReceiptSet(receipt) {
  const ids = Object.keys(receipt.gists || {}).sort();
  const gists = Object.fromEntries(ids.map((id) => [id, receipt.gists[id]]));
  const sourceSet = ids.map((id) => ({ id, receiptSha256: gists[id]?.receiptSha256 }));
  const payload = {
    schemaVersion: 3,
    kind: 'ruvnet-brain-gist-source-receipts',
    owner: receipt.owner,
    generated: receipt.generated,
    observedAt: receipt.observedAt,
    sourceObservationSha256: receipt.sourceObservationSha256,
    gistSet: {
      count: ids.length,
      idsSha256: digest(ids),
      observationSha256: receipt.sourceObservationSha256,
    },
    sourceSetSha256: digest(sourceSet),
    passagesSha256: receipt.passagesSha256 ?? null,
    gists,
  };
  return { ...payload, receiptSha256: digest(payload) };
}

function defaultFetchGist(id) {
  const result = spawnSync('gh', ['api', `gists/${id}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gist ${id} fetch failed: ${String(result.stderr || '').trim()}`);
  return JSON.parse(result.stdout);
}

async function defaultFetchBody(file) {
  if (!file.truncated) return Buffer.from(file.content || '', 'utf8');
  const response = await fetch(file.raw_url, { headers: { 'user-agent': 'ruvnet-brain-gist-receipts' } });
  if (!response.ok) throw new Error(`raw gist fetch failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function listedFileIdentity(gist) {
  return Object.entries(gist?.files || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, file]) => ({
    key, filename: file?.filename, rawUrl: file?.raw_url, size: file?.size, type: file?.type,
    language: file?.language ?? null,
  }));
}

function exactFileIdentity(file) {
  if (!file || typeof file.filename !== 'string' || !file.filename) return false;
  const keys = Object.keys(file).sort();
  if (file.included === true) {
    return canonicalJson(keys) === canonicalJson(['bytes', 'filename', 'included', 'sha256'])
      && HEX64.test(String(file.sha256 || '')) && Number.isSafeInteger(file.bytes) && file.bytes >= 0;
  }
  return file.included === false
    && canonicalJson(keys) === canonicalJson(['filename', 'included', 'reason', 'size'])
    && typeof file.reason === 'string' && Boolean(file.reason)
    && (file.size === null || (Number.isSafeInteger(file.size) && file.size >= 0));
}

function reusableReceipt(row, { gistId, updatedAt }) {
  if (row?.schemaVersion !== 3 || row?.kind !== 'ruvnet-brain-gist-source-receipt'
    || row.gistId !== gistId || row.complete !== true || row.updatedAt !== updatedAt
    || !validDate(row.ingestedAt)
    || !Array.isArray(row.files) || !row.files.length || row.fileCount !== row.files.length
    || row.files.some((file) => !exactFileIdentity(file))) return false;
  const filenames = row.files.map(({ filename }) => filename);
  return new Set(filenames).size === filenames.length
    && canonicalJson(filenames) === canonicalJson([...filenames].sort())
    && canonicalJson(row) === canonicalJson(sealGistReceipt(row));
}

export function validateGistReceiptSet(receipt, observation) {
  const ids = observation?.gists?.rows?.map(({ id }) => String(id)).sort() || [];
  const received = Object.keys(receipt?.gists || {}).sort();
  if (receipt?.schemaVersion !== 3 || receipt?.kind !== 'ruvnet-brain-gist-source-receipts'
    || receipt.owner !== observation?.owner || !validDate(receipt.generated)
    || !validDate(receipt.observedAt)
    || canonicalJson(ids) !== canonicalJson(received)
    || receipt.gistSet?.count !== ids.length || receipt.gistSet?.idsSha256 !== digest(ids)
    || receipt.gistSet?.observationSha256 !== observation?.observationSha256
    || receipt.sourceObservationSha256 !== observation?.observationSha256) {
    throw new Error('gist receipt set does not exactly match the sealed source observation');
  }
  for (const id of ids) {
    const row = receipt.gists[id];
    const stub = observation.gists.rows.find((gist) => String(gist.id) === id);
    if (row?.schemaVersion !== 3 || row?.kind !== 'ruvnet-brain-gist-source-receipt'
      || row?.gistId !== id || row?.complete !== true || row.updatedAt !== stub?.updated_at
      || !HEX40.test(String(row.versionSha || ''))
      || !validDate(row.updatedAt) || !validDate(row.ingestedAt)
      || !Array.isArray(row.files) || row.fileCount !== row.files.length || row.files.length === 0
      || row.files.some((file) => !exactFileIdentity(file))) throw new Error(`gist ${id} receipt is incomplete`);
    const filenames = row.files.map(({ filename }) => filename);
    if (filenames.some((filename) => typeof filename !== 'string' || !filename)
      || new Set(filenames).size !== filenames.length
      || canonicalJson(filenames) !== canonicalJson([...filenames].sort())) {
      throw new Error(`gist ${id} file inventory is not unique and sorted`);
    }
    if (row.contentDigest !== digest(row.files)) throw new Error(`gist ${id} content digest differs`);
    if (row.receiptSha256 !== digest(withoutReceiptDigest(row))) throw new Error(`gist ${id} receipt digest differs`);
  }
  const sourceSet = ids.map((id) => ({ id, receiptSha256: receipt.gists[id].receiptSha256 }));
  if (receipt.sourceSetSha256 !== digest(sourceSet)) throw new Error('gist source set digest differs');
  if (!(receipt.passagesSha256 === null || HEX64.test(String(receipt.passagesSha256 || '')))) {
    throw new Error('gist passage digest is malformed');
  }
  if (receipt.receiptSha256 !== digest(withoutReceiptDigest(receipt))) throw new Error('gist receipt set digest differs');
  return receipt;
}

export async function reconcileGistReceipts({ observation, existing = null, fetchGist = defaultFetchGist,
  fetchBody = defaultFetchBody, now = () => new Date().toISOString() } = {}) {
  const stubs = observation?.gists?.rows;
  if (!Array.isArray(stubs) || stubs.some(({ id }) => !/^[a-f0-9]{20,64}$/.test(String(id || '')))
    || new Set(stubs.map(({ id }) => id)).size !== stubs.length) {
    throw new Error('source observation has missing or duplicate gist ids');
  }
  const gists = {};
  for (const stub of [...stubs].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const prior = existing?.gists?.[stub.id];
    const reusable = reusableReceipt(prior, { gistId: stub.id, updatedAt: stub.updated_at });
    if (reusable) { gists[stub.id] = prior; continue; }
    const full = await fetchGist(stub.id);
    const versionSha = full?.history?.[0]?.version;
    if (full?.id !== stub.id || full.updated_at !== stub.updated_at || !HEX40.test(String(versionSha || ''))
      || canonicalJson(listedFileIdentity(full)) !== canonicalJson(listedFileIdentity(stub))) {
      const error = new Error(`gist ${stub.id} individual identity differs from the list observation`);
      error.code = 'GIST_OBSERVATION_MOVED';
      error.gistId = stub.id;
      throw error;
    }
    const files = [];
    for (const [filename, file] of Object.entries(full.files || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (!TEXT_EXT.has(path.extname(filename).toLowerCase())) {
        files.push({ filename, included: false, reason: 'non-text policy exclusion', size: file.size ?? null });
        continue;
      }
      const fetched = await fetchBody(file);
      const body = Buffer.isBuffer(fetched) ? fetched : Buffer.from(String(fetched), 'utf8');
      try { new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { throw new Error(`gist ${stub.id}/${filename} is not valid UTF-8 text`); }
      files.push({ filename, included: true, sha256: sha256(body), bytes: body.length });
    }
    gists[stub.id] = sealGistReceipt({ gistId: stub.id, versionSha, updatedAt: full.updated_at,
      ingestedAt: now(), files, complete: files.length === Object.keys(full.files || {}).length });
  }
  return validateGistReceiptSet(sealGistReceiptSet({ owner: observation.owner, generated: now(),
    observedAt: observation.observedAt, sourceObservationSha256: observation.observationSha256,
    passagesSha256: null, gists }), observation);
}
