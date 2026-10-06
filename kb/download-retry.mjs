// Retry transport failures only. Parsing, signature and corpus validation remain caller-owned.
import fs from 'node:fs';
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

export async function retryDownload(operation, { deadlineMs = 20 * 60_000,
  attemptMs = 5 * 60_000, delays = [250, 1000], onRetry = () => {} } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('download deadline exceeded');
    const controller = new AbortController();
    const timeout = Object.assign(new Error('download request timed out'), { code: 'ETIMEDOUT' });
    const timer = setTimeout(() => controller.abort(timeout), Math.min(attemptMs, remaining));
    try { return await operation({ signal: controller.signal, attempt }); }
    catch (caught) {
      const error = controller.signal.aborted ? controller.signal.reason : caught;
      const delay = delays[attempt - 1] ?? 0;
      if (attempt === 3 || !retryable(error) || Date.now() + delay >= deadline) throw error;
      onRetry({ attempt, error });
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally { clearTimeout(timer); }
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
    const request = https.get(url, { signal, headers }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        resolve(get(new URL(response.headers.location, url).toString(), { signal, headers }, redirects + 1));
      } else if (response.statusCode !== 200) {
        response.destroy(); reject(httpError(response.statusCode));
      } else resolve(response);
    });
    request.on('error', reject);
  });
}

export async function downloadFileWithRetry(url, destination, { headers = {}, onProgress = () => {}, ...options } = {}) {
  return retryDownload(async ({ signal }) => {
    const staged = `${destination}.part-${process.pid}-${randomUUID()}`;
    try {
      const response = await get(url, { signal, headers });
      let received = 0;
      const total = Number(response.headers['content-length'] || 0);
      response.on('data', bytes => { received += bytes.length; onProgress({ received, total }); });
      await pipeline(response, fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }), { signal });
      if (!response.complete || (total && received !== total)) {
        throw Object.assign(new Error('download body ended prematurely'), { code: 'ECONNRESET' });
      }
      fs.renameSync(staged, destination);
    } finally { fs.rmSync(staged, { force: true }); }
  }, options);
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
