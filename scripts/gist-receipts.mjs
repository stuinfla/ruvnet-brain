#!/usr/bin/env node
// gist-receipts.mjs — the ONE canonical gist capture/render/vector-build path.
//
// Step 2 of the corpus-seed/release pipeline consolidation (2026-09-13). Before this, gist "truth"
// (whether a gist is reconciled, current, and what its passages hash to) was written and/or read in
// at least 5 disagreeing places: this file, corpus-aggregates.mjs, rebuild-gists-from-receipts.mjs,
// release-projection.mjs, and build-bundle.mjs. Every one of those now either calls into
// `buildGistAggregate` (the single producer) or `validateGistReceipt` (the single validator), or has
// been deleted outright.
//
// THE THREE-STAGE PIPELINE:
//   1. captureGistSources  — fetch (or reuse from an exact, body-verified cache) every gist's exact
//      per-file identity and raw UTF-8 body content. Returns an UNBOUND, unsealed CapturedGistSet —
//      internal working state, never written to disk as if it were a receipt.
//   2. renderGistPassages  — the ONE banner/chunk/JSONL-escaping implementation. Pure function of a
//      CapturedGistSet; no I/O, no network.
//   3. buildGistAggregate  — orchestrates capture -> render -> write -> embed -> seal -> validate,
//      atomically (via a fresh stage directory + promoteArtifactSet), and returns a StoreResult. This
//      is the fix for the 2026-09-12 bug where a reconciled receipt was always sealed with
//      passagesSha256:null: passages are now rendered and hashed from the SAME call that seals the
//      receipt, so a receipt can never be sealed unbound.
//
// `validateGistReceipt` is the one shared validator for capture-cache reuse, producer output, and
// archive verification. It wraps (never reimplements) `validateGistAggregateReceipt` from
// plugin/scripts/coverage-integrity.mjs, which every other consumer of this receipt schema already
// uses (source-coverage.mjs, corpus-candidate.mjs) — so the byte-binding contract lives in one place.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest, validateGistAggregateReceipt } from './coverage-integrity.mjs';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';
import { writeRvfGeneration } from './rvf-generation.mjs';
import { fetchPublicGistGit } from './gist-git-source.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst']);
export const isIncludedGistFile = (filename) => TEXT_EXT.has(path.extname(filename).toLowerCase());
const EMBED_MODEL = 'Xenova/bge-base-en-v1.5';
const EMBED_DIMENSIONS = 768;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX_GIST = /^[a-f0-9]{20,64}$/;
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const compareCanonicalText = (left, right) => String(left) < String(right) ? -1
  : String(left) > String(right) ? 1 : 0;

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateFilename(filename) {
  return typeof filename === 'string' && Boolean(filename) && !filename.includes('\0')
    && !filename.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..');
}

// ── per-gist receipt sealing (schema 3) ──────────────────────────────────────────────────────────
export function sealGistReceipt(receipt) {
  const files = [...(receipt.files || [])].sort((a, b) => compareCanonicalText(a.filename, b.filename));
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

// ── aggregate receipt sealing (schema 3). The ONLY sealing point: passagesSha256 is always bound
// here from the actually-written passage bytes — never sealed null, never bound in a second step.
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

// ── transport: per-gist detail + rendering primitives ────────────────────────────────────────────
//
// Actions' default GITHUB_TOKEN is a GitHub App token with no gist scope ("Resource not accessible
// by integration", HTTP 403). corpus-seed.yml exports GH_TOKEN from a narrowly-scoped
// RUVNET_GISTS_TOKEN secret for the reconcile step, but a nightly/ad-hoc invocation may still hit an
// unscoped token. `gh` itself already reads GH_TOKEN/GITHUB_TOKEN from the environment (verified
// live: `gh help environment`, 2026-09-13), so no code here chooses a token.
//
// Failures observed against the real API fall into four shapes, each handled differently:
//   - a moved/deleted gist (404)                 -> thrown immediately as a typed, non-retryable
//                                                    GistFetchError. Never returned as null.
//   - "resource not accessible by integration"   -> thrown non-retryably BY defaultFetchGist, then
//     (still-missing gist scope, 403)                caught ONE layer up by defaultFetchDetail and
//                                                    captured via PUBLIC Git when a frozen list
//                                                    observation is supplied. Its complete tree must
//                                                    independently match the observed blob inventory.
//                                                    Legacy callers without a stub use public REST.
//   - a rate limit (primary or secondary, 403)    -> retried with backoff, bounded by `retries`.
//   - any other transient failure (timeouts,      -> retried with backoff, bounded by `retries`.
//     TLS/connection resets, 5xx, 429)
const RATE_LIMIT_RE = /rate limit/i;
const NOT_FOUND_RE = /\bnot found\b|HTTP 404/i;
const FORBIDDEN_INTEGRATION_RE = /resource not accessible by integration/i;
const TRANSIENT_RE = /timeout|timed out|TLS handshake|ECONNRESET|ECONNREFUSED|EAI_AGAIN|temporary failure|HTTP 5\d\d|HTTP 429|socket hang up/i;

export class GistFetchError extends Error {
  constructor(message, { code, gistId, status, retryable = false } = {}) {
    super(message);
    this.name = 'GistFetchError';
    this.code = code;
    this.gistId = gistId;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}

function classifyGistFetchFailure(stderr, gistId) {
  const message = String(stderr || '').trim();
  if (NOT_FOUND_RE.test(message)) {
    return new GistFetchError(`gist ${gistId} was moved or deleted: ${message}`,
      { code: 'GIST_NOT_FOUND', gistId, retryable: false });
  }
  if (FORBIDDEN_INTEGRATION_RE.test(message)) {
    return new GistFetchError(`gist ${gistId} fetch rejected -- token lacks gist scope: ${message}`,
      { code: 'GIST_FORBIDDEN', gistId, retryable: false });
  }
  if (RATE_LIMIT_RE.test(message)) {
    return new GistFetchError(`gist ${gistId} fetch rate-limited: ${message}`,
      { code: 'GIST_RATE_LIMITED', gistId, retryable: true });
  }
  if (TRANSIENT_RE.test(message)) {
    return new GistFetchError(`gist ${gistId} fetch failed transiently: ${message}`,
      { code: 'GIST_TRANSIENT_FAILURE', gistId, retryable: true });
  }
  return new GistFetchError(`gist ${gistId} fetch failed: ${message}`,
    { code: 'GIST_FETCH_FAILED', gistId, retryable: false });
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('gist fetch aborted', 'AbortError');
}

// UNCHANGED from Step 0 -- retry/error-classification logic here is already correct and tested.
// `defaultFetchDetail` (below) wraps this rather than duplicating or modifying its behavior.
export async function defaultFetchGist(id, { spawn = spawnSync, retries = 3, retryDelayMs = 300,
  sleep = defaultSleep, signal } = {}) {
  if (signal?.aborted) throw abortError(signal);
  const attempts = Math.max(1, retries);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawn('gh', ['api', `gists/${id}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status === 0) return JSON.parse(result.stdout);
    lastError = classifyGistFetchFailure(result.stderr, id);
    if (!lastError.retryable || attempt === attempts) throw lastError;
    await sleep(retryDelayMs * attempt);
    if (signal?.aborted) throw abortError(signal);
  }
  throw lastError;
}

// The unauthenticated fallback used ONLY for the specific 403 "no gist scope" rejection. Mirrors
// source-coverage.mjs's listGistsUnauthenticated: same env var, same accept header, same
// unauthenticated-quota reasoning. `fetchImpl` is a test seam (default: global fetch).
async function fetchPublicGistDetail(id, { fetchImpl = globalThis.fetch, signal } = {}) {
  const apiBase = process.env.RUVNET_GISTS_API || 'https://api.github.com';
  const response = await fetchImpl(`${apiBase}/gists/${id}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ruvnet-brain-gist-receipts' },
    signal,
  });
  if (!response.ok) {
    throw new GistFetchError(`gist ${id} public detail fetch failed: HTTP ${response.status}`,
      { code: 'GIST_FETCH_FAILED', gistId: id, status: response.status, retryable: false });
  }
  return response.json();
}

// The transport `captureGistSources` uses by default for per-gist DETAIL. Wraps `defaultFetchGist`
// without duplicating its retry logic: on any OTHER classified failure (not found, rate-limited,
// transient, or a plain non-retryable failure) the original error propagates untouched -- only the
// specific integration-token rejection falls back. No-login, 404, exhausted rate limits and other
// failures retain their existing behavior. The Git fixture executor is never forwarded here.
export async function defaultFetchDetail(id, options = {}) {
  try {
    return await defaultFetchGist(id, options);
  } catch (error) {
    if (error?.code !== 'GIST_FORBIDDEN') throw error;
    if (options.stub && !OWNER_RE.test(String(options.owner || ''))) {
      throw new GistFetchError(`gist ${id} has an invalid observation owner`,
        { code: 'GIST_OBSERVATION_INVALID', gistId: id });
    }
    if (options.stub && options.owner) return fetchPublicGistGit(id, {
      stub: options.stub, owner: options.owner, signal: options.signal, includeFile: isIncludedGistFile,
    });
    return fetchPublicGistDetail(id, options);
  }
}

const RAW_TRANSIENT_RE = /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|HTTP 5\d\d|HTTP 429/i;

// RAW-CONTENT transport, kept on its own retry/backoff budget from `defaultFetchDetail` above --
// per-gist API detail requests and raw-content requests are different quotas on GitHub's side and
// must never share one guessed retry count. Non-truncated files never hit the network at all (the
// detail response already carries their content).
export async function defaultFetchRaw(file, { fetchImpl = globalThis.fetch, retries = 3,
  retryDelayMs = 300, sleep = defaultSleep, signal } = {}) {
  if (!file?.truncated) return Buffer.from(file?.content || '', 'utf8');
  if (signal?.aborted) throw abortError(signal);
  const attempts = Math.max(1, retries);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(file.raw_url, {
        headers: { 'user-agent': 'ruvnet-brain-gist-receipts' }, signal,
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      const transient = response.status === 429 || (response.status >= 500 && response.status < 600);
      lastError = new GistFetchError(`raw gist fetch failed: HTTP ${response.status}`,
        { code: transient ? 'GIST_RAW_TRANSIENT_FAILURE' : 'GIST_RAW_FETCH_FAILED', status: response.status, retryable: transient });
      if (!transient) throw lastError;
    } catch (error) {
      if (error instanceof GistFetchError) { lastError = error; if (!error.retryable) throw error; }
      else {
        const transient = RAW_TRANSIENT_RE.test(String(error?.message || ''));
        lastError = new GistFetchError(`raw gist fetch failed: ${error.message}`,
          { code: transient ? 'GIST_RAW_TRANSIENT_FAILURE' : 'GIST_RAW_FETCH_FAILED', retryable: transient });
        if (!transient) throw lastError;
      }
    }
    if (attempt === attempts) throw lastError;
    await sleep(retryDelayMs * attempt);
    if (signal?.aborted) throw abortError(signal);
  }
  throw lastError;
}

function listedFileIdentity(gist) {
  return Object.entries(gist?.files || {}).sort(([a], [b]) => compareCanonicalText(a, b)).map(([key, file]) => ({
    key, filename: file?.filename, rawUrl: file?.raw_url, size: file?.size, type: file?.type,
    language: file?.language ?? null,
  }));
}

// ── rendering primitives -- the ONE banner/chunk/JSONL implementation. Moved here from
// rebuild-gists-from-receipts.mjs, which now imports (never reimplements) these.
export function rawUrlFor({ owner, gistId, versionSha, filename }) {
  if (!OWNER_RE.test(String(owner || '')) || !HEX_GIST.test(String(gistId || ''))
    || !HEX40.test(String(versionSha || ''))) throw new Error('cannot construct raw URL from malformed source identity');
  if (!validateFilename(filename)) throw new Error(`gist ${gistId} has an unsafe or missing filename`);
  const encodedFile = filename.split('/').map(encodeURIComponent).join('/');
  return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/${versionSha}/${encodedFile}`;
}

export function paragraphChunks(text, size = 3200) {
  if (typeof text !== 'string') throw new Error('passage content must be text');
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('chunk size must be a positive integer');
  const out = [];
  let buffer = '';
  for (const paragraph of text.split(/\n\n+/)) {
    if (buffer && buffer.length + paragraph.length + 2 > size) {
      out.push(buffer);
      buffer = '';
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}

export function provenanceBanner({ owner, gistId, filename, updatedAt }) {
  return `SOURCE: GitHub gist by @${owner} — "${filename.replace(/\s+/g, ' ').trim().slice(0, 160)}"\n`
    + `GIST STATUS: rUv's own notes / release announcement — may describe PROPOSED or UNRELEASED work.\n`
    + `Treat as intent, not as confirmed shipped behavior: verify against repo source before asserting.\n`
    + `updated: ${updatedAt.slice(0, 10)} · https://gist.github.com/${owner}/${gistId}\n\n`;
}

const jsonLine = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// ── stage 1: capture ─────────────────────────────────────────────────────────────────────────────
//
// `cache`, when supplied, is a PRIOR CapturedGistSet (this function's own return shape, including
// raw body text) -- never the published, body-free receipt (a receipt alone can never supply
// missing body bytes, which is exactly the bug this whole consolidation fixes). A cached gist is
// reused ONLY when its identity (id/updatedAt/complete) matches AND every included file's body
// re-hashes to its recorded sha256/bytes. Identity that legitimately changed (a different
// updatedAt) is an ordinary cache MISS and triggers a fresh fetch; identity that CLAIMS to be
// current but whose body hash does not verify is treated as a CORRUPTED/TAMPERED cache entry and
// throws rather than silently trusting or silently refetching it.
function reusableCachedGist(cached, stub) {
  if (!cached || cached.gistId !== stub.id || cached.updatedAt !== stub.updated_at
    || cached.complete !== true || !Array.isArray(cached.files) || !cached.files.length) {
    return 'miss';
  }
  // A matching gistId/updatedAt/complete and verified body hashes for the files the cache HAPPENS TO
  // CARRY prove nothing about whether the gist's file set itself has changed since capture -- the
  // cache could be missing a file that was added, or still carrying one that was removed, with
  // updated_at untouched in between (Dual's 2026-09-13 pass proved this exact gap: a stale cache with
  // a matching updatedAt and valid, correctly-hashed bodies for its OWN recorded files still returned
  // 'reuse' even though the stub's current file listing had already diverged). `stub.files` (the
  // current list-observation) is compared against the cache's own recorded filenames -- the one piece
  // of per-file identity the cache actually stores for every file, included or excluded alike (the
  // richer per-file identity `listedFileIdentity` compares -- rawUrl/size/type/language -- is captured
  // fresh from `full` at fetch time via the GIST_OBSERVATION_MOVED check below and is NEVER persisted
  // into the cache record itself, so it is not available here without a live fetch; a name-identical
  // but otherwise-altered file is still caught downstream by that same check once this cache entry is
  // correctly treated as a miss and refetched). A mismatch here is an ordinary MISS -- the gist
  // genuinely changed -- never 'tampered', which is reserved for a body-hash failure on content the
  // cache claims is still current.
  const cachedFilenames = cached.files.map((file) => file.filename).sort(compareCanonicalText);
  const stubFilenames = Object.keys(stub?.files || {}).sort(compareCanonicalText);
  if (cachedFilenames.length !== stubFilenames.length
    || cachedFilenames.some((name, index) => name !== stubFilenames[index])) {
    return 'miss';
  }
  // A body-free cache entry (e.g. a caller naively handing in the PUBLISHED, body-free receipt) can
  // never supply reuse -- "a receipt or timestamp alone can never supply missing body bytes" is the
  // whole reason capture-cache reuse now requires real bytes. That is an ordinary miss, not tampering:
  // tampering is specifically a cache that CLAIMS to carry a body whose hash does not verify.
  if (cached.files.some((file) => file.included === true && typeof file.body !== 'string')) return 'miss';
  for (const file of cached.files) {
    if (file.included !== true) continue;
    const bodyBuffer = Buffer.from(file.body, 'utf8');
    if (bodyBuffer.length !== file.bytes || sha256(bodyBuffer) !== file.sha256) return 'tampered';
  }
  return 'reuse';
}

export async function captureGistSources({ observation, cache = null, fetchDetail = defaultFetchDetail,
  fetchRaw = defaultFetchRaw, signal, now = () => new Date().toISOString() } = {}) {
  const stubs = observation?.gists?.rows;
  if (!Array.isArray(stubs) || stubs.some(({ id }) => !HEX_GIST.test(String(id || '')))
    || new Set(stubs.map(({ id }) => id)).size !== stubs.length) {
    throw new Error('source observation has missing or duplicate gist ids');
  }
  const gists = {};
  const reused = [];
  const fetched = [];
  for (const stub of [...stubs].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (signal?.aborted) throw abortError(signal);
    const cached = cache?.gists?.[stub.id];
    const verdict = cached ? reusableCachedGist(cached, stub) : 'miss';
    if (verdict === 'tampered') {
      throw new Error(`capture cache for gist ${stub.id} failed body-hash verification -- refusing `
        + 'to reuse a tampered or corrupted cache entry');
    }
    if (verdict === 'reuse') { gists[stub.id] = cached; reused.push(stub.id); continue; }

    const full = await fetchDetail(stub.id, { signal, stub, owner: observation.owner });
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
      if (!isIncludedGistFile(filename)) {
        files.push({ filename, included: false, reason: 'non-text policy exclusion', size: file.size ?? null });
        continue;
      }
      const rawBody = await fetchRaw(file, { signal });
      const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); }
      catch { throw new Error(`gist ${stub.id}/${filename} is not valid UTF-8 text`); }
      files.push({ filename, included: true, sha256: sha256(body), bytes: body.length, body: text });
    }
    // Git snapshots already proved the actual tree against the list in gist-git-source; the
    // comparison above is an additional shape check, not a synthetic REST verification.
    gists[stub.id] = { gistId: stub.id, versionSha, updatedAt: full.updated_at, ingestedAt: now(),
      ...(full.captureEvidence ? { captureEvidence: full.captureEvidence } : {}),
      complete: files.length === Object.keys(full.files || {}).length, files };
    fetched.push(stub.id);
  }
  return {
    owner: observation.owner,
    observedAt: observation.observedAt,
    sourceObservationSha256: observation.observationSha256,
    generatedAt: now(),
    gists,
    reuseEvidence: { reused, fetched },
  };
}

// ── stage 2: render ──────────────────────────────────────────────────────────────────────────────
export function renderGistPassages({ captured, generatedAt } = {}) {
  if (!captured?.gists || typeof captured.gists !== 'object') throw new Error('renderGistPassages requires a captured gist set');
  const owner = captured.owner;
  const passages = [];
  const entries = {};
  const gistRecords = {};
  let id = 0;
  for (const gistId of Object.keys(captured.gists).sort()) {
    const gist = captured.gists[gistId];
    for (const file of [...(gist.files || [])].sort((a, b) => compareCanonicalText(a.filename, b.filename))) {
      if (!file.included) continue;
      const chunks = paragraphChunks(file.body);
      const title = file.filename.replace(/\s+/g, ' ').trim().slice(0, 180) || file.filename;
      const banner = provenanceBanner({ owner, gistId, filename: file.filename, updatedAt: gist.updatedAt });
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const passageId = String(id++);
        const passagePath = `${gistId.slice(0, 8)}/${file.filename}${chunks.length > 1 ? `#${chunkIndex}` : ''}`;
        const text = banner + chunk;
        passages.push({ id: passageId, text, path: passagePath, title });
        entries[passageId] = { path: passagePath, kind: 'doc', title, chunk: chunkIndex, preview: text.slice(0, 200) };
      }
    }
    // The publishable per-gist receipt row never carries raw body text -- strip it here, once, at
    // the render boundary, rather than trusting every caller to remember to drop it.
    gistRecords[gistId] = sealGistReceipt({
      ...gist, files: (gist.files || []).map(({ body: _body, ...rest }) => rest),
    });
  }
  const passageBytes = Buffer.from(`${passages.map(jsonLine).join('\n')}\n`, 'utf8');
  const metadata = {
    model: 'ruv-gists', dimensions: 0, metric: 'cosine', name: 'ruv-gists', generated: generatedAt,
    repo: `gists/${owner}`,
    note: "rUv's public gists — announcements and thinking, PROPOSED unless confirmed in repo source.",
    entries,
  };
  return { passageBytes, metadata, gistRecords };
}

// ── the one shared validator: capture-cache reuse, producer output, and archive verification all
// go through this. Wraps (never reimplements) coverage-integrity.mjs's validateGistAggregateReceipt
// for schema/digest/passage-binding, and adds the checks that validator does not already cover:
// owner shape, date validity, and safe (non-path-traversal) filenames.
//
// `mode` controls only how strictly the receipt is tied to a live `observation`:
//   'produce' (default) — a freshly built receipt MUST match the exact supplied observation
//                          (gist id set + sourceObservationSha256).
//   'reuse'              — an existing on-disk receipt is being checked as a candidate for capture
//                          reuse against the CURRENT observation; same strictness as 'produce'.
//   'archive'            — a shipped/published receipt is being independently verified and no live
//                          observation is available; id-set/observation binding is not enforced.
// In every mode the receipt must bind its ACTUAL on-disk passage bytes (`passagesFile`) — that
// binding is never optional, which is the direct fix for the passagesSha256:null bug.
export function validateGistReceipt({ receipt, observation = null, passagesFile,
  expectedOwner = null, mode = 'produce' } = {}) {
  if (!passagesFile) throw new Error('gist receipt validation requires the receipt\'s passages file');
  const owner = expectedOwner ?? observation?.owner ?? receipt?.owner;
  if (!OWNER_RE.test(String(owner || ''))) throw new Error('gist receipt owner is missing or malformed');
  if (receipt?.owner !== owner) throw new Error('gist receipt owner does not match the expected owner');
  if (!validDate(receipt?.generated) || !validDate(receipt?.observedAt)) {
    throw new Error('gist receipt has an invalid generated/observedAt timestamp');
  }
  for (const [gistId, row] of Object.entries(receipt?.gists || {})) {
    if (!validDate(row?.updatedAt) || !validDate(row?.ingestedAt)) {
      throw new Error(`gist ${gistId} has an invalid updatedAt/ingestedAt timestamp`);
    }
    for (const file of row?.files || []) {
      if (!validateFilename(file?.filename)) throw new Error(`gist ${gistId} has an unsafe or missing filename`);
    }
  }
  const bindObservation = mode !== 'archive';
  const expectedIds = bindObservation && observation?.gists?.rows
    ? observation.gists.rows.map(({ id }) => String(id)) : null;
  const sourceObservationSha256 = bindObservation ? (observation?.observationSha256 ?? null) : null;
  validateGistAggregateReceipt({ receipt, passagesFile, expectedIds, sourceObservationSha256 });
  return receipt;
}

// ── stage 3: build ───────────────────────────────────────────────────────────────────────────────
function defaultBuildVector({ root, assetsDir, store }) {
  const script = path.join(path.resolve(root), 'kb', 'forge-big.mjs');
  const result = spawnSync(process.execPath, [script, 'both', '--dir', assetsDir, '--name', store], {
    encoding: 'utf8', stdio: 'inherit', env: { ...process.env },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${store} vector build failed (${result.error?.message || `exit ${result.status}`})`);
  }
}

function writeFileAtomic(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, content, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

/**
 * buildGistAggregate — capture + render + write + (optionally) embed + seal + validate, atomically.
 *
 * `outDir` is the LIVE directory the result is published into. All work happens in a FRESH stage
 * directory first; nothing is written into `outDir` until the complete result (passages, receipt,
 * and — when `buildVector` is supplied — the RVF family) validates. A failed vector build therefore
 * never exposes a finalized receipt: the stage directory is discarded and `outDir` is untouched.
 *
 * `buildVector`: defaults to the real forge-big.mjs embed. Pass `null` to skip embedding entirely
 * (e.g. a cheap nightly content refresh that defers embedding to a separate sharded job) — in that
 * case `generation` on the returned StoreResult is null and RVF-GENERATIONS.json is left untouched.
 *
 * An empty observed gist set (owner currently has zero gists) OMITS the aggregate entirely: no
 * ruv-gists.sources.json, no ruv-gists store, nothing written or promoted. A nonempty observed set
 * that yields zero usable passages after non-text exclusions FAILS EXPLICITLY -- no known,
 * independently-defined policy in this repo permits shipping a zero-passage nonempty aggregate.
 */
export async function buildGistAggregate({ observation, cache = null, outDir, root = DEFAULT_ROOT, transport = {},
  buildVector = defaultBuildVector, sourceCommit = null, signal, now = () => new Date().toISOString() } = {}) {
  const live = path.resolve(outDir || '');
  const stubs = observation?.gists?.rows || [];
  if (!stubs.length) {
    return { store: 'ruv-gists', kind: 'gist-aggregate', omitted: true, generation: null,
      sourceMetadata: null, files: [], sourceReceipt: null, reuseEvidence: { reused: [], fetched: [] } };
  }

  const captured = await captureGistSources({
    observation, cache, fetchDetail: transport.fetchDetail, fetchRaw: transport.fetchRaw, signal, now,
  });
  const { passageBytes, metadata, gistRecords } = renderGistPassages({ captured, generatedAt: captured.generatedAt });
  const includedFileCount = Object.values(captured.gists)
    .reduce((total, gist) => total + gist.files.filter((file) => file.included).length, 0);
  if (includedFileCount === 0) {
    throw new Error('ruv-gists aggregate: observed gist set is nonempty but produced zero usable '
      + 'passages after non-text exclusions -- refusing to seal a degenerate aggregate');
  }

  fs.mkdirSync(path.dirname(live), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(live), '.gist-aggregate-'));
  try {
    const passagesFile = path.join(stage, 'ruv-gists.passages.jsonl');
    const metaFile = path.join(stage, 'ruv-gists.meta.json');
    const sourcesFile = path.join(stage, 'ruv-gists.sources.json');
    writeFileAtomic(passagesFile, passageBytes);
    writeFileAtomic(metaFile, `${JSON.stringify(metadata, null, 2)}\n`);

    // Hash the ACTUALLY WRITTEN bytes on disk -- never the in-memory buffer or a claimed value.
    const passagesSha256 = crypto.createHash('sha256').update(fs.readFileSync(passagesFile)).digest('hex');
    const sourceReceipt = sealGistReceiptSet({
      owner: captured.owner, generated: captured.generatedAt, observedAt: captured.observedAt,
      sourceObservationSha256: captured.sourceObservationSha256, passagesSha256, gists: gistRecords,
    });
    writeFileAtomic(sourcesFile, `${JSON.stringify(sourceReceipt, null, 2)}\n`);

    let generation = null;
    const promoted = ['ruv-gists.passages.jsonl', 'ruv-gists.meta.json', 'ruv-gists.sources.json'];
    if (buildVector) {
      await buildVector({ root, assetsDir: stage, store: 'ruv-gists' });
      generation = writeRvfGeneration({
        dir: stage, previousDir: fs.existsSync(live) ? live : stage, store: 'ruv-gists',
        model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS, sourceCommit, builtUtc: now(),
      });
      promoted.push('ruv-gists.big.rvf', 'ruv-gists.big.rvf.idmap.json', 'ruv-gists.big.rvf.embed.json', 'RVF-GENERATIONS.json');
    }

    // Validate the complete, staged result against the real observation and the produced passage
    // bytes BEFORE it is ever exposed via promotion -- an unvalidated result is never returned.
    validateGistReceipt({ receipt: sourceReceipt, observation, passagesFile, expectedOwner: observation.owner, mode: 'produce' });

    fs.mkdirSync(live, { recursive: true });
    promoteArtifactSet({ liveDir: live, candidateDir: stage, files: promoted });

    const files = promoted.filter((name) => name !== 'RVF-GENERATIONS.json')
      .map((name) => {
        const filePath = path.join(live, name);
        return { name, sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), bytes: fs.statSync(filePath).size };
      });
    return {
      store: 'ruv-gists', kind: 'gist-aggregate', generation,
      sourceMetadata: metadata, files, sourceReceipt, reuseEvidence: captured.reuseEvidence,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
