import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { download } from '../../bin/install.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'download-retry-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
const dest = () => path.join(scratch, `asset-${++sequence}`);
const fast = { get: http.get, wait: async () => {} };

describe('installer asset download retry', () => {
  it('restarts an aborted response, discards partial bytes, and follows a relative redirect again', async () => {
    let requests = 0; const waits = []; const target = dest();
    await withServer((req, res) => {
      if (req.url === '/') { res.writeHead(302, { location: '/asset' }); res.end(); return; }
      requests++;
      if (requests === 1) {
        res.writeHead(200, { 'content-length': 100 }); res.write('partial');
        setImmediate(() => res.destroy());
      } else res.end('verified-complete-body');
    }, async (url) => {
      await download(url, target, { get: http.get, baseDelayMs: 10, wait: async (ms) => waits.push(ms) });
      expect(fs.readFileSync(target, 'utf8')).toBe('verified-complete-body');
    });
    expect(requests).toBe(2); expect(waits).toEqual([10]);
  });

  it('limits repeated response resets to three attempts and removes the final partial file', async () => {
    let requests = 0; const waits = []; const target = dest();
    await withServer((req, res) => {
      requests++; res.writeHead(200, { 'content-length': 100 }); res.write('partial');
      setImmediate(() => res.destroy());
    }, async (url) => {
      await expect(download(url, target, { get: http.get, baseDelayMs: 10,
        wait: async (ms) => waits.push(ms) })).rejects.toMatchObject({ code: 'ECONNRESET' });
    });
    expect(requests).toBe(3); expect(waits).toEqual([10, 20]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('waits for a delayed writer close after a request error before a zero-delay retry', async () => {
    let requests = 0; let firstClosed = false; let closedBeforeRetry = false;
    const target = dest(); const originalWriter = fs.createWriteStream;
    const writer = vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => new Writable({
      write(chunk, encoding, done) { done(); },
      destroy(error, done) { setTimeout(() => { firstClosed = true; done(error); }, 20); },
    })).mockImplementation(originalWriter);
    const get = (url, options, callback) => {
      requests++; if (requests === 2) closedBeforeRetry = firstClosed;
      const attempt = requests; const req = new EventEmitter();
      setImmediate(() => {
        const res = new PassThrough(); res.statusCode = 200; res.headers = {};
        callback(res);
        if (attempt === 1) {
          res.write('partial');
          req.emit('error', Object.assign(new Error('reset after headers'), { code: 'ECONNRESET' }));
        } else res.end('complete');
      });
      return req;
    };
    try {
      await download('https://fixture.invalid', target, { ...fast, get, baseDelayMs: 0 });
      expect(requests).toBe(2); expect(closedBeforeRetry).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('complete');
    } finally { writer.mockRestore(); }
  });

  it('rejects invalid retry bounds before issuing a request', async () => {
    const get = vi.fn();
    for (const attempts of [0, -1, 1.5, 4, Infinity]) {
      await expect(download('https://fixture.invalid', dest(), { attempts, get })).rejects.toThrow('attempts');
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('times out a stalled response, retries within the bound, and leaves no partial file', async () => {
    let requests = 0; const target = dest();
    await withServer((req, res) => {
      requests++; res.writeHead(200, { 'content-length': 100 }); res.write('partial');
    }, async (url) => {
      const get = (address, options, callback) => http.get(address, { ...options, timeout: 15 }, callback);
      await expect(download(url, target, { ...fast, get })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });
    expect(requests).toBe(3); expect(fs.existsSync(target)).toBe(false);
  });

  it('retries a transient HTTP 503 then succeeds', async () => {
    let requests = 0; const target = dest();
    await withServer((req, res) => {
      requests++; if (requests < 3) res.writeHead(503); res.end(requests < 3 ? 'busy' : 'body');
    }, async (url) => { await download(url, target, fast); });
    expect(requests).toBe(3); expect(fs.readFileSync(target, 'utf8')).toBe('body');
  });

  it('closes endless HTTP 503 bodies before retrying and after the final refusal', async () => {
    let requests = 0; let active = 0; let maximumActive = 0;
    const target = dest(); const closed = [];
    await withServer((req, res) => {
      requests++; active++; maximumActive = Math.max(maximumActive, active);
      closed.push(new Promise((resolve) => res.once('close', () => { active--; resolve(); })));
      res.writeHead(503); res.write('busy');
      const timer = setInterval(() => res.write('still busy'), 20);
      res.once('close', () => clearInterval(timer));
    }, async (url) => {
      await expect(download(url, target, { ...fast, baseDelayMs: 0 })).rejects.toThrow('HTTP 503');
      // The peer observes closure on its own event loop. The client must actually close every
      // response; merely draining a continually streaming error body leaves sockets alive.
      const allClosed = await Promise.race([
        Promise.all(closed).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(allClosed).toBe(true);
      expect(active).toBe(0);
    });
    expect(requests).toBe(3); expect(maximumActive).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('closes endless redirect bodies before following and exhausting the redirect limit', async () => {
    let requests = 0; let active = 0; let maximumActive = 0;
    const closed = []; const target = dest();
    await withServer((req, res) => {
      requests++; active++; maximumActive = Math.max(maximumActive, active);
      closed.push(new Promise((resolve) => res.once('close', () => { active--; resolve(); })));
      res.writeHead(302, { location: '/again' }); res.write('redirecting');
      const timer = setInterval(() => res.write('still redirecting'), 20);
      res.once('close', () => clearInterval(timer));
    }, async (url) => {
      await expect(download(url, target, { ...fast, baseDelayMs: 0 })).rejects.toThrow('too many redirects');
      const allClosed = await Promise.race([
        Promise.all(closed).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(allClosed).toBe(true); expect(active).toBe(0);
    });
    expect(requests).toBe(11); expect(maximumActive).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('fails a permanent HTTP 404 immediately', async () => {
    let requests = 0; const target = dest();
    await withServer((req, res) => { requests++; res.writeHead(404); res.end(); }, async (url) => {
      await expect(download(url, target, fast)).rejects.toThrow('HTTP 404');
    });
    expect(requests).toBe(1); expect(fs.existsSync(target)).toBe(false);
  });

  it('fails a local write error immediately instead of retrying the network', async () => {
    let requests = 0;
    await withServer((req, res) => { requests++; res.end('body'); }, async (url) => {
      await expect(download(url, path.join(scratch, 'absent', 'asset'), fast)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect(requests).toBe(1);
  });
});
