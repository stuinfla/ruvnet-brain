import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { downloadFileWithRetry, fetchBytesWithRetry, fetchJsonWithRetry, retryDownload } from '../../kb/download-retry.mjs';

const roots = []; const servers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function serve(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/bundle`;
}
const options = { delays: [0, 0], deadlineMs: 3000, attemptMs: 1000 };

describe('bounded fresh-stage transport retries', () => {
  it('recovers the original socket reset and a truncated body, without appending partial bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-download-')); roots.push(root);
    const target = path.join(root, 'bundle.zip'); fs.writeFileSync(target, 'previous');
    let calls = 0; const ranges = [];
    const url = await serve((request, response) => {
      calls += 1;
      ranges.push(request.headers.range);
      if (calls === 1) { request.socket.destroy(); return; }
      if (calls === 2) {
        response.writeHead(200, { 'content-length': 50 }); response.write('PARTIAL');
        setTimeout(() => response.destroy(), 5); return;
      }
      response.writeHead(200, { 'content-length': 8 }); response.end('complete');
    });
    // Exercise the real HTTPS adapter and streams against an actual owned HTTP transport.
    vi.spyOn(https, 'get').mockImplementation((_url, requestOptions, callback) => http.get(url, requestOptions, callback));
    await downloadFileWithRetry('https://release.invalid/bundle', target, options);
    expect(calls).toBe(3);
    // The third request asks to continue the 7 staged bytes; this server ignores Range (200), so the
    // stage restarts from zero instead of appending the whole body after the partial prefix.
    expect(ranges).toEqual([undefined, undefined, 'bytes=7-']);
    expect(fs.readFileSync(target, 'utf8')).toBe('complete');
    expect(fs.readdirSync(root)).toEqual(['bundle.zip']);
  });

  it('fetch retries the response body read, not only request establishment', async () => {
    let calls = 0;
    const url = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-length': calls === 1 ? 100 : 5 });
      if (calls === 1) { response.write('part'); setTimeout(() => response.destroy(), 5); }
      else response.end('whole');
    });
    expect((await fetchBytesWithRetry(url, options)).toString()).toBe('whole');
    expect(calls).toBe(2);
  });

  it('three failures preserve the old destination and remove every failed stage', async () => {
    let calls = 0;
    const url = await serve(request => { calls += 1; request.socket.destroy(); });
    vi.spyOn(https, 'get').mockImplementation((_url, requestOptions, callback) => http.get(url, requestOptions, callback));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-download-')); roots.push(root);
    const target = path.join(root, 'bundle'); fs.writeFileSync(target, 'old');
    await expect(downloadFileWithRetry('https://release.invalid', target, options)).rejects.toThrow();
    expect(calls).toBe(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(root)).toEqual(['bundle']);
  });

  it.each([401, 403, 404])('HTTP %s is permanent and never retried', async status => {
    let calls = 0;
    const url = await serve((_request, response) => { calls += 1; response.writeHead(status).end(); });
    await expect(fetchBytesWithRetry(url, options)).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
  });

  it('malformed JSON is permanent; a later valid body cannot replace the failed metadata', async () => {
    let calls = 0;
    const url = await serve((_request, response) => { calls += 1; response.end(calls === 1 ? '{' : '{}'); });
    await expect(fetchJsonWithRetry(url, options)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('TLS trust rejection is not converted into a transient fetch error', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('untrusted cert'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) }); });
    await expect(fetchBytesWithRetry('https://release.invalid', { ...options, fetchImpl })).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retrieved corrupt signature bytes remain a failed cryptographic check, with no refetch', async () => {
    let calls = 0;
    const url = await serve((_request, response) => { calls += 1; response.end(Buffer.alloc(64)); });
    const signature = await fetchBytesWithRetry(url, options);
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    expect(crypto.verify(null, Buffer.from('archive digest'), publicKey, signature)).toBe(false);
    expect(calls).toBe(1);
  });

  it('the cumulative deadline bounds a stalled body and permits no fourth attempt', async () => {
    let calls = 0;
    const url = await serve((_request, response) => { calls += 1; response.writeHead(200); response.write('stalled'); });
    const started = Date.now();
    await expect(fetchBytesWithRetry(url, { delays: [0, 0], deadlineMs: 90, attemptMs: 30 })).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a permanent disk error is not retried', async () => {
    const operation = vi.fn(async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
    await expect(retryDownload(operation, options)).rejects.toThrow('disk full');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

// 4.7.21 (RC2.2): the bundle is 744,732,329 bytes. A 5-minute cap on the WHOLE attempt, three attempts each
// from byte zero, meant any link slower than ~2.5 MB/s could never update or fresh-install.
describe('large-body transport: idle timeout, Range resume, size-scaled deadline', () => {
  const BODY = Buffer.from(Array.from({ length: 3000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join(''));
  const viaHttp = (url) => vi.spyOn(https, 'get').mockImplementation((_url, requestOptions, callback) => http.get(url, requestOptions, callback));
  const target = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-download-')); roots.push(root); return path.join(root, 'bundle.zip'); };
  // Writes `bytes` in 30 equal chunks spread over `ms`, then ends (or hands control to `after`).
  const trickle = (response, bytes, ms, after = () => response.end()) => {
    const step = Math.ceil(bytes.length / 30); let offset = 0;
    const timer = setInterval(() => {
      if (response.destroyed) { clearInterval(timer); return; }
      response.write(bytes.subarray(offset, offset + step)); offset += step;
      if (offset >= bytes.length) { clearInterval(timer); after(); }
    }, ms / 30);
  };

  it('a body that streams steadily for 3 s completes with a 1 s idle window, in ONE request', async () => {
    let calls = 0;
    const url = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-length': BODY.length });
      trickle(response, BODY, 3000);
    });
    viaHttp(url);
    const file = target(); const started = Date.now();
    await downloadFileWithRetry('https://release.invalid/bundle', file, { delays: [0, 0], deadlineMs: 20_000, attemptMs: 1000 });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500); // it really was slower than the idle window
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
  }, 30_000);

  it('a reset at 50% resumes with Range from the staged size, and the prefix is never downloaded twice', async () => {
    const half = BODY.length / 2; const requests = []; let bytesServed = 0;
    const url = await serve((request, response) => {
      requests.push(request.headers.range);
      const match = /^bytes=(\d+)-$/.exec(request.headers.range || '');
      if (!match) {
        response.writeHead(200, { 'content-length': BODY.length });
        response.write(BODY.subarray(0, half)); bytesServed += half;
        setTimeout(() => response.destroy(), 50);
        return;
      }
      const start = Number(match[1]);
      response.writeHead(206, { 'content-length': BODY.length - start, 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
      response.end(BODY.subarray(start)); bytesServed += BODY.length - start;
    });
    viaHttp(url);
    const file = target();
    await downloadFileWithRetry('https://release.invalid/bundle', file, options);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBeUndefined();
    const resumedAt = Number(/^bytes=(\d+)-$/.exec(requests[1])?.[1]);
    expect(resumedAt).toBe(half); // n > 0, and exactly what was staged
    expect(bytesServed).toBe(BODY.length); // 1500 + 1500, not 1500 + 3000
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['bundle.zip']);
  });

  it('a 206 whose Content-Range does not start at the staged size is not appended: the stage restarts', async () => {
    let calls = 0; const ranges = [];
    const url = await serve((request, response) => {
      calls += 1; ranges.push(request.headers.range);
      if (calls === 1) { response.writeHead(200, { 'content-length': BODY.length }); response.write(BODY.subarray(0, 100)); setTimeout(() => response.destroy(), 50); return; }
      if (request.headers.range) { // claims a continuation but from the wrong offset
        response.writeHead(206, { 'content-length': 10, 'content-range': `bytes 0-9/${BODY.length}` });
        response.end(BODY.subarray(0, 10)); return;
      }
      response.writeHead(200, { 'content-length': BODY.length }); response.end(BODY);
    });
    viaHttp(url);
    const file = target();
    await downloadFileWithRetry('https://release.invalid/bundle', file, options);
    expect(ranges).toEqual([undefined, 'bytes=100-', undefined]); // the mismatched 206 is discarded, then one fresh request
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
  });

  // Fable review #1 (4.7.21): an asset replaced at the same URL between attempts was stitched onto the old prefix,
  // which only the signature caught (exit 4, then a full reinstall). Two servers: one that honours If-Range (RFC 9110
  // 13.1.5: a stale validator gets the whole new body as 200), one that ignores it but labels the 206 with its ETag.
  const OLD = Buffer.alloc(BODY.length, 'a'); const NEW = Buffer.alloc(BODY.length, 'b');
  const replacedMidDownload = ({ honoursIfRange }) => {
    const seen = []; let current = OLD; let calls = 0;
    const handler = (request, response) => {
      calls += 1; seen.push({ range: request.headers.range, ifRange: request.headers['if-range'] });
      const etag = current === OLD ? '"v1"' : '"v2"';
      const match = /^bytes=(\d+)-$/.exec(request.headers.range || '');
      const stale = request.headers['if-range'] && request.headers['if-range'] !== etag;
      if (!match || (honoursIfRange && stale)) {
        response.writeHead(200, { 'content-length': current.length, etag });
        if (calls === 1) { response.write(current.subarray(0, 1000)); current = NEW; setTimeout(() => response.destroy(), 50); return; }
        response.end(current); return;
      }
      const start = Number(match[1]);
      response.writeHead(206, { 'content-length': current.length - start, etag, 'content-range': `bytes ${start}-${current.length - 1}/${current.length}` });
      response.end(current.subarray(start));
    };
    return { seen, handler };
  };

  it.each([true, false])('an asset replaced between attempts restarts from zero, never stitched (server honours If-Range: %s)', async (honoursIfRange) => {
    const { seen, handler } = replacedMidDownload({ honoursIfRange });
    viaHttp(await serve(handler));
    const file = target();
    await downloadFileWithRetry('https://release.invalid/bundle', file, options);
    const bytes = fs.readFileSync(file);
    expect(bytes.length).toBe(BODY.length);
    expect(bytes.equals(NEW)).toBe(true); // before: 1000 bytes of 'a' then 2000 of 'b'
    expect(bytes.subarray(0, 1000).includes('a'.charCodeAt(0))).toBe(false);
    expect(seen).toHaveLength(honoursIfRange ? 2 : 3); // the ignoring server's 206 is discarded, then one fresh 200
    expect(seen[1]).toEqual({ range: 'bytes=1000-', ifRange: '"v1"' }); // the resume names what the stage holds
  });

  // Fable review #2 (4.7.21): a resumed 206 whose Content-Range total is '*' disabled the final size check, so a short
  // body that ended cleanly was accepted. The size from the response that started the stage is the bound.
  it("a resumed 206 with an unknown total ('*') is still held to the stage's original size", async () => {
    let calls = 0;
    const url = await serve((request, response) => {
      calls += 1;
      const match = /^bytes=(\d+)-$/.exec(request.headers.range || '');
      if (!match) { response.writeHead(200, { 'content-length': BODY.length }); response.write(BODY.subarray(0, 1000)); setTimeout(() => response.destroy(), 50); return; }
      const start = Number(match[1]);
      // Second request: a clean but SHORT continuation (500 of the 2000 remaining bytes); third: the rest.
      const end = calls === 2 ? start + 500 : BODY.length;
      response.writeHead(206, { 'content-range': `bytes ${start}-${end - 1}/*` });
      response.end(BODY.subarray(start, end));
    });
    viaHttp(url);
    const file = target();
    await downloadFileWithRetry('https://release.invalid/bundle', file, options);
    expect(calls).toBe(3); // before: 2, and a 1500-byte file was accepted as the bundle
    expect(fs.statSync(file).size).toBe(BODY.length);
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
  });

  it('a server that stops sending for 2x the idle window is aborted as ETIMEDOUT and retried', async () => {
    let calls = 0; const retries = [];
    const url = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-length': BODY.length });
      if (calls === 1) { response.write(BODY.subarray(0, 10)); return; } // then silence, never ends
      response.end(BODY);
    });
    viaHttp(url);
    const file = target(); const started = Date.now();
    await downloadFileWithRetry('https://release.invalid/bundle', file, { delays: [0, 0], deadlineMs: 20_000, attemptMs: 300,
      onRetry: ({ error }) => retries.push(error.code) });
    const elapsed = Date.now() - started;
    expect(retries).toEqual(['ETIMEDOUT']);
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5000); // bounded by the idle window, not by the 20 s deadline
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
  }, 30_000);

  it('the overall deadline grows with the declared size (bytes / minBytesPerSec) instead of cutting off a steady body', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': BODY.length });
      trickle(response, BODY, 1500);
    });
    viaHttp(url);
    const file = target();
    // 3000 bytes at a 1000 B/s floor allows 3 s, although the configured floor deadline is 500 ms.
    await downloadFileWithRetry('https://release.invalid/bundle', file, { delays: [0, 0], deadlineMs: 500, attemptMs: 1000, minBytesPerSec: 1000 });
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
  }, 30_000);

  it('a stalled body without a declared size is still bounded by the overall deadline', async () => {
    let calls = 0;
    const url = await serve((_request, response) => { calls += 1; response.writeHead(200); response.write('x'); setInterval(() => { if (!response.destroyed) response.write('x'); }, 20); });
    viaHttp(url);
    const started = Date.now();
    await expect(downloadFileWithRetry('https://release.invalid/bundle', target(), { delays: [0, 0], deadlineMs: 600, attemptMs: 1000 }))
      .rejects.toThrow(/deadline exceeded/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(calls).toBe(1);
  }, 30_000);
});
