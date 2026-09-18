import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../scripts/native-host-process.mjs';
import { createSearchProcess } from '../../scripts/oracle/search-process.mjs';

const dirs = []; afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture(body) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'search-process-')); dirs.push(d); const f = path.join(d, 'entry.mjs'); fs.writeFileSync(f, body); return f; }

describe('isolated search process', () => {
  it('returns results and strips timeoutMs from the worker request', async () => {
    const entry = fixture("export async function searchAll(r){ return {echo:r,results:[{repo:r.repos[0],path:'README.md'}]}; }");
    const proc = createSearchProcess({ entryFile: entry });
    await expect(proc.searchAll({ dir: '/kb', query: 'q', k: 5, repos: ['repo'], timeoutMs: 1000 })).resolves.toEqual({ echo: { dir: '/kb', query: 'q', k: 5, repos: ['repo'] }, results: [{ repo: 'repo', path: 'README.md' }] });
    await proc.close();
  });
  it('hard-kills a nonresponsive synchronous call, then restarts with a new child', async () => {
    const pidFile = path.join(path.dirname(fixture('export const value = 1;')), 'pid');
    const hanging = fixture(`import fs from 'node:fs'; export function searchAll(r){ fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); if(r.query !== 'ok') while(true){} return {pid:process.pid,results:[{repo:'r',path:'ok'}]}; }`); const proc = createSearchProcess({ entryFile: hanging });
    await expect(proc.searchAll({ query: 'hang', timeoutMs: 20 })).rejects.toThrow(/timed out/);
    const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(oldPid, 0)).toThrow();
    const result = await proc.searchAll({ query: 'ok', timeoutMs: 1000 });
    expect(result).toEqual({ pid: expect.any(Number), results: [{ repo: 'r', path: 'ok' }] });
    expect(result.pid).not.toBe(oldPid); await proc.close();
  });
  it('rejects concurrent calls and settles close', async () => {
    const entry = fixture("export async function searchAll(){ await new Promise(r=>setTimeout(r,100)); return {results:[]}; }"); const proc = createSearchProcess({ entryFile: entry });
    const first = proc.searchAll({ timeoutMs: 1000 }); await expect(proc.searchAll({ timeoutMs: 100 })).rejects.toThrow(/concurrent/); const closing = proc.close(); await expect(first).rejects.toThrow(/closed|exited/); await closing;
  });
  it('reserves the request slot even after readiness is already fulfilled', async () => {
    const entry = fixture("export async function searchAll(){ await new Promise(r=>setTimeout(r,30)); return {results:[]}; }");
    const proc = createSearchProcess({ entryFile: entry });
    await proc.ready();
    const first = proc.searchAll({ timeoutMs: 1000 });
    await expect(proc.searchAll({ timeoutMs: 1000 })).rejects.toThrow(/concurrent/);
    await expect(first).resolves.toEqual({ results: [] });
    await proc.close();
  });
  it('keeps startup deadline terminal when the module initializes late', async () => {
    const entry = fixture("await new Promise(r=>setTimeout(r,100)); export async function searchAll(){return {results:[]}};");
    const proc = createSearchProcess({ entryFile: entry, readyTimeoutMs: 10 });
    await expect(proc.ready()).rejects.toThrow(/readiness timeout/);
    await proc.close();
  });

  it('rejects a child whose entry module has no searchAll export', async () => {
    const entry = fixture('export const value = 1;'); const proc = createSearchProcess({ entryFile: entry });
    await expect(proc.searchAll({ timeoutMs: 1000 })).rejects.toThrow(/search entry|export|startup/); await proc.close();
  });

  it('settles when startup exits before ready', async () => {
    const entry = fixture('process.exit(1);'); const proc = createSearchProcess({ entryFile: entry });
    await expect(proc.searchAll({ timeoutMs: 1000 })).rejects.toThrow(/startup|exited|unavailable/);
    await proc.close();
  });
  it('bounds a failed kill and refuses to restart while the old worker is alive', async () => {
    const entry = fixture("export function searchAll(){while(true){}}");
    let liveChild;
    const proc = createSearchProcess({ entryFile: entry, cleanupTimeoutMs: 50,
      terminateTree(child) { liveChild = child; throw new Error('injected kill denial'); } });
    try {
      await proc.ready();
      const started = Date.now();
      await expect(proc.searchAll({ timeoutMs: 20 })).rejects.toThrow(/cleanup failed: injected kill denial/);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(() => process.kill(liveChild.pid, 0)).not.toThrow();
      await expect(proc.searchAll({ timeoutMs: 20 })).rejects.toThrow(/closed|concurrent/);
      await expect(proc.close()).rejects.toThrow(/injected kill denial/);
    } finally {
      if (liveChild) {
        const joined = new Promise(resolve => liveChild.once('close', resolve));
        killProcessTree(liveChild);
        await joined;
      }
    }
  });

  it('settles failed warmup before accepting a query', async () => {
    const entry = fixture("export async function warmQueryEmbedder(){throw new Error('warmup broken')} export function searchAll(){return {results:[]}}");
    const proc = createSearchProcess({ entryFile: entry, warmup: true });
    await expect(proc.searchAll({ timeoutMs: 1000 })).rejects.toThrow(/warmup broken/);
    await proc.close();
  });

});
