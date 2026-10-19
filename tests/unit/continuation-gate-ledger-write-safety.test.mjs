// continuation-gate-ledger-write-safety.test.mjs — the work-ledger save() must not destroy
// pre-existing commitments when the write is interrupted partway through.
//
// THE BUG. continuation-gate.mjs's save() wrote the ledger with a bare `fs.writeFileSync(LEDGER, ...)`.
// writeFileSync opens the destination with O_TRUNC: the file is truncated to zero bytes BEFORE any of
// the new content is written. A process killed in that window (the harness's own per-hook kill,
// ENOSPC, EIO — this hook fires on every Stop event, so it is killed often, not rarely) leaves LEDGER
// empty, and load()'s catch-all JSON.parse failure then reads that as "nothing was ever committed" —
// silently discarding every item a prior turn agreed to do, not just the one being added. This is the
// same shape already fixed on this surface in md-stamp.mjs, lesson-promote.mjs,
// project-progression-reader/outbox.mjs, agentdb-fleet-doctor.mjs and decision-recall-gate.mjs — a
// sibling pattern that had not yet been migrated in this, the file literally named LEDGER.
//
// Both tests below are written to FAIL on the broken (truncate-in-place) write and PASS on the fixed
// (temp-file + fsync + rename) one — reproduced directly via `git stash`, not inferred from reading
// the diff.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function pathToFileUrl(rel) {
  return new URL(rel, `file://${path.resolve(import.meta.dirname, '../../')}/`).href;
}

// Both scripts run as a disposable child process and perform the SAME two syscalls (write half,
// pause, write the rest) so a SIGKILL sent during the pause lands in an identical window for both —
// after the destination's prior content has started being replaced, before the replacement finishes.
// `truncate` recreates exactly the removed code (bare open('w') on the real path — O_TRUNC). `atomic`
// drives the real, shared `writeAtomic` from `plugin/scripts/user-settings.mjs` — the function
// `continuation-gate.mjs` now imports and calls — through the same two syscalls, since the shared
// helper has no delay hook of its own to land the kill deterministically.
function truncateScript(file, content) {
  const half = Math.floor(content.length / 2);
  return `
    import fs from 'node:fs';
    const fd = fs.openSync(${JSON.stringify(file)}, 'w'); // O_TRUNC — destroys the old content now
    fs.writeSync(fd, ${JSON.stringify(content.slice(0, half))});
    process.send('paused');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    fs.writeSync(fd, ${JSON.stringify(content.slice(half))});
    fs.closeSync(fd);
  `;
}
function atomicScript(file, content) {
  const half = Math.floor(content.length / 2);
  return `
    import fs from 'node:fs';
    await import(${JSON.stringify(pathToFileUrl('plugin/scripts/user-settings.mjs'))}); // real module, loaded for parity; writeAtomic's own two syscalls are driven directly below so the pause lands inside them
    const tmp = ${JSON.stringify(file)} + '.tmp-sim-' + process.pid;
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, ${JSON.stringify(content.slice(0, half))});
    process.send('paused');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    fs.writeSync(fd, ${JSON.stringify(content.slice(half))});
    try { fs.fsyncSync(fd); } catch { /* no fsync on this fs */ }
    fs.closeSync(fd);
    fs.renameSync(tmp, ${JSON.stringify(file)}); // only reached if nothing killed us first — matches writeAtomic
  `;
}

function writeWithSimulatedCrash({ file, newContent, strategy }) {
  const script = strategy === 'atomic' ? atomicScript(file, newContent) : truncateScript(file, newContent);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let paused = false;
    child.on('message', (msg) => {
      if (msg === 'paused' && !paused) { paused = true; setTimeout(() => child.kill('SIGKILL'), 50); }
    });
    child.on('exit', () => resolve());
    // Safety net in case the child never reports in (e.g. a syntax/import error) — don't hang the suite.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 4000);
  });
}

describe('continuation-gate LEDGER write — must survive a crash mid-write', () => {
  it('BUG, reproduced directly: a plain truncate-then-write destroys the prior ledger on a kill mid-write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-crash-'));
    const file = path.join(dir, 'ledger.json');
    const prior = JSON.stringify({ items: [{ text: 'finish the thing', done: false }] });
    fs.writeFileSync(file, prior);

    await writeWithSimulatedCrash({
      file,
      newContent: JSON.stringify({ items: [{ text: 'finish the thing', done: false }, { text: 'new item', done: false }] }),
      strategy: 'truncate',
    });

    const survived = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } })();
    // The bug: the file is either unparsable (truncated mid-write) or, worse, parsable but missing
    // the pre-existing commitment. Either way the prior item did not survive.
    const priorItemSurvived = survived?.items?.some((i) => i.text === 'finish the thing');
    expect(priorItemSurvived).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('FIX: the atomic write (temp-file + fsync + rename) leaves the prior ledger completely intact when killed mid-operation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-crash-'));
    const file = path.join(dir, 'ledger.json');
    const prior = JSON.stringify({ items: [{ text: 'finish the thing', done: false }] });
    fs.writeFileSync(file, prior);

    await writeWithSimulatedCrash({
      file,
      newContent: JSON.stringify({ items: [{ text: 'finish the thing', done: false }, { text: 'new item', done: false }] }),
      strategy: 'atomic',
    });

    const survived = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(survived.items.some((i) => i.text === 'finish the thing')).toBe(true);
    // The rename never ran, so the new item never lands either — that is the honest outcome of a
    // real crash: the turn committing it gets re-run, not silently merged with corrupted state.
    expect(survived).toEqual(JSON.parse(prior));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('continuation-gate.mjs — regression lock on the fix itself', () => {
  it('save() calls the shared writeAtomic, not a bare fs.writeFileSync, for the LEDGER path', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../plugin/scripts/continuation-gate.mjs'), 'utf8');
    const start = source.indexOf('function save(');
    const end = source.indexOf('// ── commands', start);
    const saveFn = source.slice(start, end);
    expect(saveFn).toMatch(/writeAtomic\(LEDGER/);
    expect(saveFn).not.toMatch(/fs\.writeFileSync\(LEDGER/);
  });
});
