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
    let calls = 0;
    const url = await serve((request, response) => {
      calls += 1;
      expect(request.headers.range).toBeUndefined();
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
