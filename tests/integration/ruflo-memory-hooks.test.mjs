// Owner ruling 2026-10-12: lifecycle memory only CALLS ruflo. Measured on a live-size clone, the old
// hand-rolled progression path read every cumulative snapshot (751 MB) and a 3.38 GB outbox at
// Stop/PreCompact/SessionEnd and ran into the 8.5 s watchdog. These tests hold the new contract:
// the boundaries never read the outbox (a FIFO there would block any reader forever), PreCompact
// stores one checkpoint through ruflo and reads it back by exact key, and SessionStart restores the
// newest project-state-current-* by exact key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo, tmp } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugin/scripts/session-snapshot-hook.mjs');
afterEach(() => cleanup());

describe('lifecycle boundaries call ruflo and never read the hand-rolled outbox', () => {
  it('PreCompact returns fast with a FIFO at the outbox path and stores + reads back one checkpoint', () => {
    if (process.platform === 'win32') return;
    const p = adoptedProject();
    const outbox = path.join(p.dir, '.swarm', 'project-progression-outbox.jsonl');
    try { fs.rmSync(outbox, { force: true }); } catch { /* absent */ }
    spawnSync('mkfifo', [outbox]);
    const ruflo = fakeRuflo();
    // No transcript: the turn is trivial and stores nothing, so the one store is the checkpoint. (Capture is
    // NOT switched off here: RUVNET_TURN_CAPTURE=off now stops the checkpoint too — see the next test.)
    const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: tmp('rmh-bh-'), RUVNET_BRAIN_STATE_DIR: tmp('rmh-st-'),
      RUVNET_TURN_CAPTURE: 'on', RUVNET_CONTINUITY_CAPTURE: 'off' };
    const t = performance.now();
    const r = spawnSync(process.execPath, [HOOK, 'PreCompact'], { cwd: p.dir, env, encoding: 'utf8', timeout: 6000,
      input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'rmh', cwd: p.dir }) });
    const ms = performance.now() - t;
    expect(r.error, 'the boundary blocked: something read the outbox').toBeUndefined();
    expect(ms).toBeLessThan(5000);
    const calls = ruflo.calls();
    const stored = calls.filter((c) => c.argv[1] === 'store' && /^project-state-auto-\d+-[0-9a-f]{8}$/.test(c.key || ''));
    expect(stored.length).toBe(1);
    expect(calls.some((c) => c.argv[1] === 'retrieve' && c.key === stored[0].key)).toBe(true);
  }, 20_000);

  it('RUVNET_TURN_CAPTURE=off stops the checkpoint write too (review m4)', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: tmp('rmh-bh-'), RUVNET_BRAIN_STATE_DIR: tmp('rmh-st-'),
      RUVNET_TURN_CAPTURE: 'off', RUVNET_CONTINUITY_CAPTURE: 'off' };
    const r = spawnSync(process.execPath, [HOOK, 'SessionEnd'], { cwd: p.dir, env, encoding: 'utf8', timeout: 6000,
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'rmh-off', cwd: p.dir }) });
    expect(r.status).toBe(0);
    expect(ruflo.calls().filter((c) => c.argv[1] === 'store')).toEqual([]);
  }, 20_000);
});

describe('SessionStart restore reads the newest checkpoint by exact key', () => {
  it('lists, picks the newest project-state-current-*, and retrieves exactly that key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-restore-'));
    fs.mkdirSync(path.join(dir, '.swarm'));
    fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), '');
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'ruflo');
    fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[1] === 'list') { const n = a[a.indexOf('-n') + 1];
  console.log(JSON.stringify(n === 'lessons' ? [{ key: 'lesson-a', createdAt: 1 }] : [
    { key: 'project-state-current-1791000000100', createdAt: 100 }, { key: 'project-state-current-1791000000300', createdAt: 300 }, { key: 'other', createdAt: 900 }])); }
if (a[1] === 'retrieve') console.log('VALUE-OF-' + a[a.indexOf('--key') + 1]);
`, { mode: 0o755 });
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const r = await restore({ cwd: dir, bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('restored');
    expect(r.context).toContain('VALUE-OF-project-state-current-1791000000300');
    expect(r.context).toContain('lesson-a');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.filter((c) => c[1] === 'retrieve').map((c) => c[c.indexOf('--key') + 1])).toEqual(['project-state-current-1791000000300']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Measured on the owner's store: namespace ruvnet-brain holds 2,828 rows and `ruflo memory list` answers
  // newest-first by createdAt; restore() then took 3.1-4.0 s against a 3.5 s budget. Order is verified from
  // createdAt on a 100-row page, never assumed, and a larger page is read only when that page cannot prove it.
  const restoreWith = async (dirName, rowsByNamespace, { delayMs = 0, budgetMs = 5000, withCheckpoint = false } = {}) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-order-')), dirName);
    fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), '');
    const rowsFile = path.join(dir, 'rows.json'); fs.writeFileSync(rowsFile, JSON.stringify(rowsByNamespace));
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'ruflo');
    // Honors --limit exactly like ruflo: the first <limit> rows in the order given (list order is the fixture's).
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
fs.appendFileSync(${JSON.stringify(log)} + '.spawn', JSON.stringify({ op: a[1], cwd: fs.realpathSync(process.cwd()), autostart: process.env.RUFLO_DAEMON_AUTOSTART ?? null }) + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});
const rows = JSON.parse(fs.readFileSync(${JSON.stringify(rowsFile)}, 'utf8'));
if (a[1] === 'list') console.log(JSON.stringify((rows[a[a.indexOf('-n') + 1]] || []).slice(0, Number(a[a.indexOf('--limit') + 1]))));
if (a[1] === 'retrieve') console.log('VALUE-OF-' + a[a.indexOf('-n') + 1] + '/' + a[a.indexOf('--key') + 1]);
`, { mode: 0o755 });
    const { restore, checkpoint } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const t = performance.now();
    const scratchRoot = path.join(path.dirname(dir), 'ruflo-cwd');
    const env = { ...process.env, RUVNET_RUFLO_CWD_ROOT: scratchRoot };
    const r = await restore({ cwd: dir, env, bin, deadlineAt: Date.now() + budgetMs });
    const ms = performance.now() - t;
    if (withCheckpoint) await checkpoint({ projectDir: dir, event: 'PreCompact', payload: { session_id: 's' }, env: { ...env, RUVNET_TURN_CAPTURE: 'on' }, bin });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const spawns = fs.readFileSync(log + '.spawn', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const projectDir = fs.realpathSync(dir);
    const scratch = fs.realpathSync(scratchRoot);
    const leftover = fs.readdirSync(scratch).flatMap((k) => fs.readdirSync(path.join(scratch, k)));
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    const lists = calls.filter((c) => c[1] === 'list').map((c) => `${c[c.indexOf('-n') + 1]}:${c[c.indexOf('--limit') + 1]}`);
    return { r, ms, lists, spawns, projectDir, scratch, leftover, retrieved: calls.filter((c) => c[1] === 'retrieve').map((c) => c[c.indexOf('--key') + 1]) };
  };
  const NEWEST = 'project-state-current-1791912547000';
  const OLD = 'project-state-current-1786376123058';
  const filler = (n, from = 1791999000000) => Array.from({ length: n }, (_, i) => ({ key: `turn-${i}`, createdAt: from - i }));
  // Newest-first like live ruflo: 150 rows, the newest checkpoint 6th, an older one beyond the first page.
  const liveLike = () => [...filler(5), { key: NEWEST, createdAt: 1791912547000 }, ...filler(140, 1791900000000), { key: OLD, createdAt: 1786376123058 }];

  it('verified newest-first page: exactly one list per namespace and one retrieve, no larger page', async () => {
    const { r, lists, retrieved } = await restoreWith('proj', { proj: liveLike(), default: [{ key: OLD, createdAt: 1786376123058 }] });
    expect(r.route).toBe('fast');
    expect(lists.sort()).toEqual(['default:100', 'lessons:20', 'proj:100']);
    expect(retrieved).toEqual([NEWEST]);
    expect(r.context).toContain(`VALUE-OF-proj/${NEWEST}`); expect(r.context).not.toMatch(/Fast path not|Not proven/);
  });

  it('a reversed (oldest-first) list fails verification, falls back to a larger page, and still returns the newest', async () => {
    const { r, lists, retrieved } = await restoreWith('proj', { proj: liveLike().reverse() });
    expect(r.route).toBe('fallback');
    expect(lists.sort()).toEqual(['default:100', 'lessons:20', 'proj:100', 'proj:5000']);
    expect(retrieved).toEqual([NEWEST]);
    expect(r.context).toMatch(/Fast path not used: .*proj/); expect(r.context).not.toContain('Not proven');
  });

  it('finds the newest checkpoint behind more than 1000 newer rows in the project namespace', async () => {
    const rows = [...filler(1500), { key: NEWEST, createdAt: 1791912547000 }, { key: OLD, createdAt: 1786376123058 }];
    const { r, retrieved } = await restoreWith('proj', { proj: rows });
    expect(r.route).toBe('fallback');
    expect(retrieved).toEqual([NEWEST]);
    expect(r.context).toContain(`VALUE-OF-proj/${NEWEST}`);
  });

  it('a namespace whose verified page is older than the best checkpoint is not read further', async () => {
    const { r, lists } = await restoreWith('proj', { proj: liveLike(), default: filler(300, 1700000000000) });
    expect(r.route).toBe('fast'); expect(lists).not.toContain('default:5000');
  });

  it('with a slow ruflo the fast path costs two call rounds (lists, then retrieve), not three', async () => {
    const rows = { proj: liveLike(), default: [] };
    const base = await restoreWith('proj', rows); // process-spawn and git overhead at this machine's load
    const slow = await restoreWith('proj', rows, { delayMs: 600 });
    expect(slow.r.route).toBe('fast');
    const added = slow.ms - base.ms; // each round of parallel calls adds one 600 ms delay
    expect(added, `600 ms ruflo added ${added.toFixed(0)} ms`).toBeGreaterThanOrEqual(1100);
    expect(added, `600 ms ruflo added ${added.toFixed(0)} ms`).toBeLessThan(1600);
  }, 20_000);

  it('every restore and checkpoint ruflo call runs outside the project with daemon autostart off', async () => {
    const { spawns, projectDir, scratch, leftover } = await restoreWith('proj', { proj: liveLike() }, { withCheckpoint: true });
    expect(leftover, 'each call removes its own scratch run dir').toEqual([]);
    expect(new Set(spawns.map((x) => x.op))).toEqual(new Set(['list', 'retrieve', 'store']));
    for (const x of spawns) {
      expect(x.cwd, `${x.op} ran in the project dir`).not.toBe(projectDir);
      expect(x.cwd.startsWith(projectDir + path.sep), `${x.op} ran inside the project`).toBe(false);
      expect(x.cwd.startsWith(scratch + path.sep), `${x.op} ran in ${x.cwd}, not a private scratch run dir`).toBe(true);
      expect(x.autostart, `${x.op} could start the daemon`).toBe('0');
    }
  });

  it('picks by the epoch-ms in the key across namespace spellings', async () => {
    const { r, retrieved } = await restoreWith('AppealArmor', {
      AppealArmor: [{ key: OLD, createdAt: 9e12 }],
      appealarmor: [{ key: 'project-state-current-20260802193600', createdAt: 1 }, { key: 'project-state-current-1791813555000', createdAt: 2 }, { key: NEWEST, createdAt: 3 }],
      default: [{ key: 'project-state-auto-1791000000000-abcdef12', createdAt: 9e12 }],
    });
    expect(retrieved).toEqual([NEWEST]); // the older auto checkpoint is not newer, so it is not restored
    expect(r.context).toContain(`VALUE-OF-appealarmor/${NEWEST}`);
  });

  it('adds a newer automatic checkpoint after the curated one, ordered by key epoch-ms', async () => {
    const { retrieved } = await restoreWith('proj', { proj: [{ key: 'project-state-auto-1791999999000-abcdef12', createdAt: 1 }, { key: NEWEST, createdAt: 2 }] });
    expect(retrieved.sort()).toEqual(['project-state-auto-1791999999000-abcdef12', NEWEST]);
  });
});

// #501 / #502 / #503 — refusal is not permission, a list is not a read, a deadline is absolute.
describe('refusal, exact-read honesty and deadlines (#501 #502 #503)', () => {
  const POSIX = process.platform !== 'win32';
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const project = ({ store = true } = {}) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-refuse-'))); dirs.push(dir);
    if (store) { fs.mkdirSync(path.join(dir, '.swarm')); fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), ''); }
    return dir;
  };
  const refusing = () => { throw new Error('Git project identity unavailable: invalid Git marker'); };
  // A ruflo that logs every launch; `readFails` makes retrieve exit 1 for the listed keys.
  const loggingRuflo = (dir, { rows, readFails = [], listFails = [] }) => {
    const log = path.join(dir, 'launches.log'); const bin = path.join(dir, 'ruflo-fake');
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, a[1] + '\\n');
const rows = ${JSON.stringify(rows)}; const bad = ${JSON.stringify(readFails)}; const badList = ${JSON.stringify(listFails)};
if (a[1] === 'list' && badList.includes(a[a.indexOf('-n') + 1])) process.exit(1);
if (a[1] === 'list') console.log(JSON.stringify(rows[a[a.indexOf('-n') + 1]] || []));
if (a[1] === 'retrieve') { const k = a[a.indexOf('--key') + 1]; if (bad.includes(k)) process.exit(1); console.log('VALUE-OF-' + k); }
`, { mode: 0o755 });
    return { bin, launches: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
  };

  it('a refusing resolver with a local .swarm/memory.db is NOT adopted and names the refusal', async () => {
    const { projectStore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project();
    const s = projectStore(dir, { resolve: refusing });
    expect(s).toMatchObject({ adopted: false, db: null });
    expect(s.refused).toMatch(/invalid Git marker/); expect(s.withheld).toBe(true);
  });

  it('a valid non-Git project is still adopted through the real resolver', async () => {
    const { projectStore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project();
    const s = projectStore(dir);
    expect(s.adopted).toBe(true); expect(s.refused).toBeUndefined(); expect(s.db).toBe(path.join(dir, '.swarm', 'memory.db'));
  });

  it.skipIf(!POSIX)('checkpoint() through the real resolver on an invalid .git marker launches nothing', async () => {
    const { checkpoint } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project(); fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir pointer\n');
    const fake = loggingRuflo(dir, { rows: {} });
    const r = await checkpoint({ projectDir: dir, event: 'PreCompact', payload: { session_id: 's' }, env: { ...process.env, RUVNET_TURN_CAPTURE: 'on' }, bin: fake.bin });
    expect(r.stored).toBe(false); expect(r.skipped).toMatch(/refused/); expect(fake.launches()).toEqual([]);
  });

  it('refusal with no local store is quiet', async () => {
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const r = await restore({ cwd: project({ store: false }), resolve: refusing, bin: '/nonexistent/ruflo' });
    expect(r).toEqual({ status: 'unavailable', context: '' });
  });

  it('refusal with a local store says refused and reads nothing; a resolver timeout says unknown', async () => {
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project(); const fake = loggingRuflo(dir, { rows: {} });
    const refused = await restore({ cwd: dir, resolve: refusing, bin: fake.bin });
    expect(refused.status).toBe('refused'); expect(refused.context).toContain('CONTINUITY UNKNOWN');
    const timeout = () => { throw new Error('Git project identity timed out'); };
    expect((await restore({ cwd: dir, resolve: timeout, bin: fake.bin })).status).toBe('unknown');
    expect(fake.launches()).toEqual([]);
  });

  const KEY = 'project-state-current-1791000000300';
  it.skipIf(!POSIX)('list ok + exact retrieve fails => unknown, restoredKeys empty', async () => {
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project(); const fake = loggingRuflo(dir, { rows: { [path.basename(dir)]: [{ key: KEY, createdAt: 300 }] }, readFails: [KEY] });
    const r = await restore({ cwd: dir, bin: fake.bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('unknown'); expect(r.restoredKeys).toEqual([]); expect(r.context).toContain('(exact read failed)');
  });

  it.skipIf(!POSIX)('1 of 2 exact reads ok => partial', async () => {
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project(); const AUTO = 'project-state-auto-1791000000900-abcd1234';
    const fake = loggingRuflo(dir, { rows: { [path.basename(dir)]: [{ key: KEY, createdAt: 300 }, { key: AUTO, createdAt: 900 }] }, readFails: [AUTO] });
    const r = await restore({ cwd: dir, bin: fake.bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('partial'); expect(r.restoredKeys).toEqual([KEY]);
  });

  it.skipIf(!POSIX)('one namespace list fails but another yields a checkpoint => partial, naming the unreadable namespace', async () => {
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project(); const name = path.basename(dir);
    const failing = name.toLowerCase() === name ? 'default' : name.toLowerCase();   // a checkpoint namespace other than the one with the row
    const fake = loggingRuflo(dir, { rows: { [name]: [{ key: KEY, createdAt: 300 }] }, listFails: [failing] });
    const r = await restore({ cwd: dir, bin: fake.bin, deadlineAt: Date.now() + 5000 });
    expect(r.restoredKeys).toEqual([KEY]);
    expect(r.status).toBe('partial');
    expect(r.context).toContain('CONTINUITY INCOMPLETE');
    expect(r.context).toContain(`did not answer for ${failing}`);
    // control: the same row with every list answering is a genuine `restored`
    const ok = await restore({ cwd: dir, bin: loggingRuflo(dir, { rows: { [name]: [{ key: KEY, createdAt: 300 }] } }).bin, deadlineAt: Date.now() + 5000 });
    expect(ok.status).toBe('restored');
    expect(ok.context).not.toContain('INCOMPLETE');
  });

  it.skipIf(!POSIX)('some namespace lists fail and the rest are empty => unknown, never empty', async () => {
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = project();
    const fake = loggingRuflo(dir, { rows: {}, listFails: [path.basename(dir)] });
    const r = await restore({ cwd: dir, bin: fake.bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('unknown');
    expect(r.context).toContain('PROJECT CONTINUITY UNKNOWN');
    expect(r.context).not.toContain('No project-state-current-* checkpoint stored yet');
    // control: every list answered empty is a genuine empty
    const ok = await restore({ cwd: dir, bin: loggingRuflo(dir, { rows: {} }).bin, deadlineAt: Date.now() + 5000 });
    expect(ok.status).toBe('empty');
  });

  it('a blocking invoke that outlasts the deadline launches nothing', async () => {
    const { rufloMemory } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    let ran = 0;
    const r = await rufloMemory(['list'], { db: '/x/memory.db', bin: '/x/ruflo', deadlineAt: Date.now() + 30,
      invoke: () => { const end = Date.now() + 100; while (Date.now() < end); return { executable: 'x', args: [] }; },
      run: () => { ran += 1; } });
    expect(ran).toBe(0); expect(r).toMatchObject({ ok: false, error: 'deadline exceeded before launch' });
  });

  it('an already-aborted signal launches nothing', async () => {
    const { rufloMemory } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    let ran = 0; const c = new AbortController(); c.abort();
    const r = await rufloMemory(['list'], { db: '/x/memory.db', bin: '/x/ruflo', signal: c.signal, run: () => { ran += 1; } });
    expect(ran).toBe(0); expect(r.error).toBe('cancelled');
  });

  it.skipIf(!POSIX)('a mid-run abort SIGKILLs a SIGTERM-ignoring child and resolves only after it exits', async () => {
    const { rufloMemory } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const { execFile } = await import('node:child_process');
    const dir = project({ store: false }); const pidFile = path.join(dir, 'pid');
    const body = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;
    const c = new AbortController(); let closed = false;
    const run = (exe, args, opts, cb) => { const ch = execFile(process.execPath, ['-e', body], opts, cb); ch.on('close', () => { closed = true; }); return ch; };
    const pending = rufloMemory(['list'], { db: path.join(dir, 'memory.db'), bin: '/x/ruflo', deadlineAt: Date.now() + 20_000, signal: c.signal,
      invoke: () => ({ executable: 'x', args: [] }), run });
    const t = Date.now();
    while (!fs.existsSync(pidFile) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    c.abort();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, error: 'cancelled' });
    expect(closed).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(); // child is really gone
  }, 15_000);

  // #501: sh is killed but its grandchild `sleep` keeps stdout open, so execFile's callback (which waits for
  // the pipes to close) did not fire until the deadline: measured 5006 ms. Abort must destroy the pipes.
  it.skipIf(!POSIX)('a mid-run abort resolves promptly even when a grandchild still holds the child stdout', async () => {
    const { rufloMemory } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const { execFile } = await import('node:child_process');
    const c = new AbortController();
    const run = (exe, args, opts, cb) => execFile('sh', ['-c', 'sleep 6; echo done'], opts, cb);
    const pending = rufloMemory(['list'], { db: '/x/memory.db', bin: '/x/ruflo', deadlineAt: Date.now() + 5000, signal: c.signal,
      invoke: () => ({ executable: 'x', args: [] }), run });
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    c.abort();
    const r = await pending;
    const took = Date.now() - t;
    expect(r).toMatchObject({ ok: false, error: 'cancelled' });
    expect(took).toBeLessThan(1500); // sync-version-ignore: a latency bound on a test fixture, not a product fact
  }, 15_000);

  // Abort and timeout must end the whole process group: two `sleep` grandchildren outlived the abort (their cwd was
  // deleted under them).
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const grandchildren = async (how) => {
    const { rufloMemory, spawnDetached } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-grand-')); const pids = path.join(dir, 'pids');
    const c = new AbortController();
    const run = (exe, args, opts, cb) => spawnDetached('sh', ['-c', `sleep 30 & echo $! >> ${pids}; sleep 30 & echo $! >> ${pids}; wait`], opts, cb);
    const pending = rufloMemory(['list'], { db: path.join(dir, 'memory.db'), bin: '/x/ruflo', deadlineAt: Date.now() + (how === 'timeout' ? 1200 : 20_000),
      signal: c.signal, invoke: () => ({ executable: 'x', args: [] }), run });
    const t = Date.now();
    while ((!fs.existsSync(pids) || fs.readFileSync(pids, 'utf8').trim().split('\n').length < 2) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 20));
    const list = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    if (how === 'abort') c.abort();
    const r = await pending;
    await new Promise((res) => setTimeout(res, 300));
    const survivors = list.filter(alive);
    survivors.forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
    fs.rmSync(dir, { recursive: true, force: true });
    return { r, list, survivors };
  };
  // SHOULD-1 (round-2 gate): a hook killed by its host (SIGKILL of its process group) must not leave the ruflo child or its
  // grandchildren behind, and a child needs a deadline of its own. The parent below is a real separate node process.
  const orphanProbe = async (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-orphan-')); const pids = path.join(dir, 'pids'); const script = path.join(dir, 'parent.mjs');
    const hooks = path.join(ROOT, 'plugin/scripts/ruflo-memory-hooks.mjs');
    fs.writeFileSync(script, `import { spawnDetached } from ${JSON.stringify(hooks)};
spawnDetached('sh', ['-c', 'echo $$ >> ${pids}; sleep 60 & echo $! >> ${pids}; wait'], { cwd: ${JSON.stringify(dir)}, env: process.env, timeout: ${mode === 'frozen' ? 600 : 50_000} }, () => {});
${mode === 'frozen' ? "setTimeout(() => process.kill(process.pid, 'SIGSTOP'), 300);" : ''}
setInterval(() => {}, 1000);\n`);
    const parent = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    const t = Date.now();
    while ((!fs.existsSync(pids) || fs.readFileSync(pids, 'utf8').trim().split('\n').length < 2) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 20));
    const list = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    if (mode === 'kill-parent') process.kill(-parent.pid, 'SIGKILL');   // the host kills the hook's group
    const until = Date.now() + (mode === 'frozen' ? 9000 : 5000);
    let survivors = list.filter(alive);
    while (survivors.length && Date.now() < until) { await new Promise((r) => setTimeout(r, 100)); survivors = list.filter(alive); }
    const after = Date.now() - t;
    try { process.kill(-parent.pid, 'SIGKILL'); } catch { /* gone */ }
    list.forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
    fs.rmSync(dir, { recursive: true, force: true });
    return { list, survivors, after };
  };
  it.skipIf(!POSIX)('SIGKILL of the hook process group leaves no ruflo child or grandchild', async () => {
    const { list, survivors } = await orphanProbe('kill-parent');
    expect(list).toHaveLength(2); expect(survivors).toEqual([]);
  }, 20_000);
  it.skipIf(!POSIX)('a child enforces its own deadline when its parent is frozen (no parent timer can fire)', async () => {
    const { list, survivors, after } = await orphanProbe('frozen');
    expect(list).toHaveLength(2); expect(survivors).toEqual([]);
    expect(after).toBeLessThan(8000); // timeout 600 + 2000 grace + startup; a bound, not a product number // sync-version-ignore: latency bound on a test fixture
  }, 20_000);

  it.skipIf(!POSIX)('abort kills the whole process group: no grandchild survives', async () => {
    const { r, list, survivors } = await grandchildren('abort');
    expect(list).toHaveLength(2); expect(r.error).toBe('cancelled'); expect(survivors).toEqual([]);
  }, 20_000);
  it.skipIf(!POSIX)('timeout kills the whole process group: no grandchild survives', async () => {
    const { r, list, survivors } = await grandchildren('timeout');
    expect(list).toHaveLength(2); expect(r.error).toBe('timed out'); expect(survivors).toEqual([]);
  }, 20_000);
});
