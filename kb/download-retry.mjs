// Retry transport failures only. Parsing, signature and corpus validation remain caller-owned.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const TRANSIENT = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function retryable(error) {
  for (let current = error; current; current = current.cause) {
    if (TRANSIENT.has(current.code)) return true;
  }
  return [408, 429, 500, 502, 503, 504].includes(error.status);
}
function httpError(status) {
  return Object.assign(new Error(`server returned HTTP ${status}`), { status });
}

// `attemptMs` is a NO-PROGRESS window, not a cap on the whole attempt: an operation that reports
// progress (ctx.progress) keeps its attempt alive for as long as bytes keep arriving. A whole-attempt
// cap of 5 min against a 745 MB asset meant links under ~2.5 MB/s could never finish (4.7.21 RC2.2).
// Operations that never report progress (the small JSON reads) keep the old meaning: a hard cap.
// `deadlineMs` bounds all attempts together; ctx.expectBytes(n) raises it to n / minBytesPerSec once
// the body size is known, so a large body on a slow-but-steady link is not cut off by the floor.
export async function retryDownload(operation, { deadlineMs = 90 * 60_000,
  attemptMs = 60_000, minBytesPerSec = 256 * 1024, delays = [250, 1000], onRetry = () => {} } = {}) {
  const started = Date.now();
  let deadline = started + deadlineMs;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('download deadline exceeded');
    const controller = new AbortController();
    const abort = (message) => () => controller.abort(Object.assign(new Error(message), { code: 'ETIMEDOUT' }));
    let idleTimer = setTimeout(abort('download stalled: no bytes received'), Math.min(attemptMs, remaining));
    let deadlineTimer = setTimeout(abort('download deadline exceeded'), remaining);
    const progress = () => {
      if (controller.signal.aborted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(abort('download stalled: no bytes received'), attemptMs);
    };
    const expectBytes = (bytes) => {
      const needed = started + Math.ceil(Number(bytes) / minBytesPerSec * 1000);
      if (!Number.isFinite(needed) || needed <= deadline || controller.signal.aborted) return;
      deadline = needed;
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(abort('download deadline exceeded'), Math.max(0, deadline - Date.now()));
    };
    try { return await operation({ signal: controller.signal, attempt, progress, expectBytes }); }
    catch (caught) {
      const error = controller.signal.aborted ? controller.signal.reason : caught;
      const delay = delays[attempt - 1] ?? 0;
      if (attempt === 3 || !retryable(error) || Date.now() + delay >= deadline) throw error;
      onRetry({ attempt, error });
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally { clearTimeout(idleTimer); clearTimeout(deadlineTimer); }
  }
}

export async function fetchBytesWithRetry(url, { fetchImpl = globalThis.fetch, ...options } = {}) {
  return retryDownload(async ({ signal }) => {
    const response = await fetchImpl(url, { redirect: 'follow', signal });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* preserve the permanent HTTP refusal */ }
      throw httpError(response.status);
    }
    return Buffer.from(await response.arrayBuffer());
  }, options);
}

export async function fetchJsonWithRetry(url, options = {}) {
  // Parse AFTER transport succeeds: malformed JSON must never be re-requested or accepted.
  const bytes = await fetchBytesWithRetry(url, { deadlineMs: 45_000, attemptMs: 15_000, ...options });
  return JSON.parse(bytes.toString('utf8'));
}

function get(url, { signal, headers }, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) { reject(new Error('too many redirects')); return; }
    // The release host is https; a plain-http URL (a local mirror, the test servers) is fetched as such.
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const request = transport.get(url, { signal, headers }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        resolve(get(new URL(response.headers.location, url).toString(), { signal, headers }, redirects + 1));
      } else if (response.statusCode !== 200 && !([206, 416].includes(response.statusCode) && headers.Range)) {
        // With Range: 206 continues the stage, 416 (unsatisfiable) restarts it; the caller decides.
        response.destroy(); reject(httpError(response.statusCode));
      } else resolve(response);
    });
    request.on('error', reject);
  });
}

function stagedBytes(file) {
  try { return fs.statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

// A resumed body is appended ONLY when the server proves it is the continuation of the bytes already
// staged: HTTP 206 with a Content-Range that starts exactly at the staged size. Anything else (a 200 for
// the whole body, a mirror that ignores Range, a different start) restarts the stage from zero.
// Returns the declared total, 0 for an unknown total ('*'), or null when the response is not a continuation.
function resumedTotal(response, offset) {
  if (response.statusCode !== 206) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(response.headers['content-range'] || '').trim());
  if (!match || Number(match[1]) !== offset) return null;
  return match[3] === '*' ? 0 : Number(match[3]);
}

// What the staged bytes are a prefix of, taken from the response that started the stage: its validator
// (a strong ETag, else Last-Modified) for If-Range, and its full size. An asset replaced at the same URL
// between attempts must restart from zero, never be stitched onto the old prefix (which only the signature
// check would catch, as exit 4 and a full reinstall).
function bodyIdentity(response, total) {
  const etag = response.headers.etag || null;
  const strong = etag && !/^W\//.test(etag) ? etag : null;
  return { etag, validator: strong || response.headers['last-modified'] || null, total: total || 0 };
}

export async function downloadFileWithRetry(url, destination, { headers = {}, onProgress = () => {}, ...options } = {}) {
  // One stage for the whole call: a retry continues it (Range) instead of discarding every byte received.
  const staged = `${destination}.part-${process.pid}-${randomUUID()}`;
  let identity = null;
  try {
    await retryDownload(async ({ signal, progress, expectBytes }) => {
      let offset = stagedBytes(staged);
      const resume = { ...headers, Range: `bytes=${offset}-`, ...(identity?.validator ? { 'If-Range': identity.validator } : {}) };
      let response = await get(url, { signal, headers: offset ? resume : headers });
      let total = offset ? resumedTotal(response, offset) : null;
      if (total !== null) {
        // '*' (unknown total) keeps the size the stage was started with, so the final size check still runs.
        if (total === 0) total = identity?.total || 0;
        const etag = response.headers.etag || null;
        if ((identity?.etag && etag && etag !== identity.etag) || (identity?.total && total !== identity.total)) {
          total = null; // a continuation of a DIFFERENT body: the asset changed under the stage
        }
      }
      if (total === null) {
        if (offset) { // the server did not continue the stage: restart from byte zero
          offset = 0;
          // A 200 already carries the whole body; a 206 for other bytes (or another body) or a 416 needs a fresh request.
          if (response.statusCode !== 200) { response.destroy(); response = await get(url, { signal, headers }); }
        }
        total = Number(response.headers['content-length'] || 0);
        identity = bodyIdentity(response, total);
      }
      if (total) expectBytes(total);
      let received = offset;
      response.on('data', bytes => { received += bytes.length; progress(); onProgress({ received, total }); });
      const flags = offset ? 'a' : fs.existsSync(staged) ? 'w' : 'wx';
      await pipeline(response, fs.createWriteStream(staged, { flags, mode: 0o600 }), { signal });
      if (!response.complete || (total && stagedBytes(staged) !== total)) {
        throw Object.assign(new Error('download body ended prematurely'), { code: 'ECONNRESET' });
      }
    }, options);
    fs.renameSync(staged, destination);
  } finally { fs.rmSync(staged, { force: true }); }
}

export async function httpsJsonWithRetry(url, { headers = {}, ...options } = {}) {
  const bytes = await retryDownload(async ({ signal }) => {
    const response = await get(url, { signal, headers });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    if (!response.complete) throw Object.assign(new Error('response body ended prematurely'), { code: 'ECONNRESET' });
    return Buffer.concat(chunks);
  }, { deadlineMs: 45_000, attemptMs: 15_000, ...options });
  return JSON.parse(bytes.toString('utf8'));
}
