// #429: hook-path reads go through ONE owned child that calls the installed Ruflo package's public
// `@claude-flow/cli/memory` export (listEntries / getEntry / resolveDbPath), not one `ruflo memory ...` CLI
// process per key or namespace. The fake below is a `ruflo` PACKAGE TREE (bin -> package entry, nested
// @claude-flow/cli with a ./memory export). The CLI entry logs `cli <subcommand>`; the memory module logs
// `batch <pid>` when a process loads it, so both routes are countable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restore } from '../../plugin/scripts/ruflo-memory-hooks.mjs';
import { recall } from '../../plugin/scripts/agentdb-recall.mjs';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const CLI = (log, data) => `#!${process.execPath}
import fs from 'node:fs';
const a = process.argv.slice(2), get = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
fs.appendFileSync(${JSON.stringify(log)}, 'cli ' + a[1] + '\\n');
if (a[1] === 'search') fs.appendFileSync(${JSON.stringify(log)}, 'pid ' + process.pid + '\\n');
if (process.env.FAKE_MODE === 'hang-search' && a[1] === 'search') await new Promise(() => setTimeout(() => {}, 60000));
const data = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
const ns = get('--namespace') ?? get('-n'), rows = data[ns] ?? [];
if (process.env.FAKE_MODE === 'fail-list' && a[1] === 'list') { console.error('[ERROR] Failed to list'); process.exit(1); }
if (process.env.FAKE_MODE === 'hang-list' && a[1] === 'list') await new Promise(() => setTimeout(() => {}, 60000));
if (a[1] === 'list') console.log(JSON.stringify(rows.map(({ key, createdAt }) => ({ key, createdAt }))));
else if (a[1] === 'retrieve') { const r = rows.find((x) => x.key === get('--key')); if (!r) process.exit(1); process.stdout.write(r.value); }
else if (a[1] === 'search') console.log(JSON.stringify({ results: rows.map((r) => ({ key: r.key, namespace: ns, score: 0.8, preview: r.value.slice(0, 60) })) }));
`;
const MEMORY = (log, data) => `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, 'batch ' + process.pid + '\\n');
const load = () => JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
export const resolveDbPath = (flag) => flag;
export async function listEntries({ namespace, limit }) {
  if (process.env.FAKE_MODE === 'hang-list') await new Promise(() => {});
  if (process.env.FAKE_MODE === 'fail-list') return { success: false, entries: [], total: 0, error: 'no' };
  if (['slow-list', 'hang-search'].includes(process.env.FAKE_MODE)) await new Promise((r) => setTimeout(r, 700));
  const rows = load()[namespace] ?? [];
  if (process.env.FAKE_MODE === 'renamed-key') return { success: true, entries: rows.map(({ key, createdAt }) => ({ name: key, createdAt })), total: rows.length };
  return { success: true, entries: rows.slice(0, limit).map(({ key, createdAt }) => ({ key, createdAt })), total: rows.length };
}
export async function getEntry({ key, namespace }) {
  const r = (load()[namespace] ?? []).find((x) => x.key === key);
  return r ? { success: true, found: true, entry: { content: r.value } } : { success: true, found: false };
}
`;

function world({ withExport = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rms-')));
  roots.push(dir);
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.swarm', 'memory.db'), '');
  const log = path.join(dir, 'calls.log'), data = path.join(dir, 'data.json');
  const pkg = path.join(dir, 'lib', 'node_modules', 'ruflo');
  const cli = path.join(pkg, 'node_modules', '@claude-flow', 'cli');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(cli, 'dist', 'src', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ruflo', version: '0.0.0', type: 'module', bin: { ruflo: 'bin/ruflo.js' } }));
  fs.writeFileSync(path.join(pkg, 'bin', 'ruflo.js'), CLI(log, data), { mode: 0o755 });
  fs.writeFileSync(path.join(cli, 'dist', 'src', 'memory', 'memory-initializer.js'), MEMORY(log, data));
  const setExport = (on) => fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@claude-flow/cli', version: '0.0.0', type: 'module',
    exports: on ? { './memory': { import: './dist/src/memory/memory-initializer.js' } } : { '.': './dist/index.js' } }));
  setExport(withExport);
  fs.mkdirSync(path.join(dir, 'bin'));
  const bin = path.join(dir, 'bin', 'ruflo');
  fs.symlinkSync(path.join(pkg, 'bin', 'ruflo.js'), bin);
  fs.writeFileSync(data, JSON.stringify({
    proj: [{ key: 'project-state-current-1791000000300', createdAt: 300, value: 'STATE-NEW decision requirement parser recall' },
      { key: 'project-state-current-1791000000100', createdAt: 100, value: 'STATE-OLD' }, { key: 'other', createdAt: 50, value: 'x' }],
    lessons: [{ key: 'lesson-a', createdAt: 1, value: 'L' }] }));
  const env = { ...process.env, HOME: path.join(dir, 'home'), RUFLO_BIN: bin, RUVNET_BRAIN_HOME: path.join(dir, 'brain'), RUVNET_BRAIN_METER: '0' };
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, proj, bin, env, setExport,
    cliCalls: () => lines().filter((l) => l.startsWith('cli ')).map((l) => l.slice(4)),
    batchPids: () => lines().filter((l) => l.startsWith('batch ')).map((l) => Number(l.slice(6))),
    searchPids: () => lines().filter((l) => l.startsWith('pid ')).map((l) => Number(l.slice(4))) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

describe('#429 one owned child answers list/get through the Ruflo package\'s public memory export', () => {
  it('restore() makes 0 CLI calls and at most 2 batch processes, and restores the newest checkpoint', async () => {
    const w = world();
    const r = await restore({ cwd: w.proj, env: w.env, bin: w.bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('restored');
    expect(r.context).toContain('STATE-NEW');
    expect(r.context).toContain('lesson-a');
    expect(w.cliCalls()).toEqual([]);
    expect(w.batchPids().length).toBeGreaterThanOrEqual(1);
    expect(w.batchPids().length).toBeLessThanOrEqual(2);
  }, 20_000);

  it('recall() makes exactly one CLI call (the ranked search) and still delivers the records', async () => {
    const w = world();
    const r = await recall({ prompt: 'Fix the parser: recall the requirement decision', projectDir: w.proj, env: w.env, deadlineMs: 1900 });
    expect(r.outcome).toBe('ok-with-results');
    expect(r.block).toContain('STATE-NEW');
    expect(w.cliCalls()).toEqual(['search']);
    expect(new Set(w.batchPids()).size).toBe(1);
  }, 20_000);

  it('a package without the ./memory export falls back to the per-read CLI route with byte-identical values', async () => {
    const w = world();
    const batch = await restore({ cwd: w.proj, env: w.env, bin: w.bin, deadlineAt: Date.now() + 5000 });
    expect(w.cliCalls()).toEqual([]);
    w.setExport(false);
    const cli = await restore({ cwd: w.proj, env: w.env, bin: w.bin, deadlineAt: Date.now() + 5000 });
    expect(w.cliCalls().sort()).toEqual(["list", "list", "list", "retrieve"]);
    expect(w.batchPids().length).toBeLessThanOrEqual(2); // only the earlier batch run loaded the module
    expect(cli).toEqual(batch);
  }, 30_000);

  it('Ruflo answering {success:false} for every list is unknown, never empty', async () => {
    const w = world();
    const r = await restore({ cwd: w.proj, env: { ...w.env, FAKE_MODE: 'fail-list' }, bin: w.bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('unknown');
    expect(w.batchPids().length).toBeGreaterThanOrEqual(1); // the answer came from the batch route, not a CLI retry
    expect(w.cliCalls()).toEqual([]);
  }, 20_000);

  it('a hung listEntries returns within deadline + 200 ms and leaves no process behind', async () => {
    const w = world();
    const started = Date.now();
    const r = await restore({ cwd: w.proj, env: { ...w.env, FAKE_MODE: 'hang-list' }, bin: w.bin, deadlineAt: started + 1500 });
    const ms = Date.now() - started;
    expect(r.status).toBe('unknown');
    expect(ms).toBeLessThan(1500 + 200);
    const pids = w.batchPids();
    expect(pids.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 20 && pids.some(alive); i += 1) await new Promise((res) => setTimeout(res, 25));
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);

  it('a list whose entries lack a string key (Ruflo renamed the field) is not an empty namespace: the CLI route answers', async () => {
    const w = world();
    const r = await restore({ cwd: w.proj, env: { ...w.env, FAKE_MODE: 'renamed-key' }, bin: w.bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('restored');
    expect(r.context).toContain('STATE-NEW');
    expect(w.cliCalls()).toContain('list');
  }, 20_000);

  it('a throw after the speculative search started aborts that search instead of leaving it running', async () => {
    const w = world();
    const log = path.join(w.dir, 'calls.log');
    const real = Date.now.bind(Date);
    let armed = false; let thrown = false;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (!armed && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('pid ')) armed = true;
      // Only the recall orchestrator's own clock reads fail (every one after the search started), never a timer inside a child-process helper.
      // Judged by the DIRECT caller frame: an abort listener that merely runs beneath recall()'s `finally` must not throw (that was an unhandled error).
      if (armed && /plugin\/scripts\/agentdb-recall\.mjs/.test((String(new Error().stack).split('\n').slice(1).find((l) => !/tinyspy|vitest|ruflo-memory-session\.test/.test(l)) || ''))) { thrown = true; throw new Error('injected failure after the speculative search started'); }
      return real();
    });
    const r = await recall({ prompt: 'Fix the parser: recall the requirement decision', projectDir: w.proj,
      env: { ...w.env, FAKE_MODE: 'hang-search' }, deadlineMs: 1900 });
    vi.restoreAllMocks();
    expect(thrown).toBe(true);
    expect(['ok-with-results', 'ok-empty']).not.toContain(r.outcome);
    const pids = w.searchPids();
    expect(pids.length).toBe(1);
    // Aborted at the throw, not retired later by its own deadline: it must be gone within 250 ms of recall returning.
    for (let i = 0; i < 10 && pids.some(alive); i += 1) await new Promise((res) => setTimeout(res, 25));
    expect(pids.filter(alive)).toEqual([]);
  }, 20_000);
});
