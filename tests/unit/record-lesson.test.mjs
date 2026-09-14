// record-lesson.test.mjs — record-lesson.mjs must prove a lesson landed, not infer it from the
// store command's own claimed-success wording, and must not be fooled by a STALE value that happens
// to match what this run intended to write.
//
// WHY THIS EXISTS. ADR-063 documents the incident this repo already paid for: on 2026-08-13
// `ruflo memory store` printed "[OK] Data stored successfully" on every write for three days while
// the write itself left rowcount 0 — three days of memory lost, discovered only because something
// else finally tried to read a key back. The only proof this repo now accepts for a memory write is
// an exact-key round trip through the managed interface (`degradation-watch.mjs`'s
// `proveMemoryDurable()`, `learning-replay-fixture.mjs`'s `retrieveExact()`).
//
// `scripts/record-lesson.mjs` — the one script whose entire purpose is durable lesson capture — was
// never updated to that discipline: it derived its `stored` verdict (which gates the script's exit
// code) from `/OK|stored/i.test(storeStdout)`, the exact wording the 2026-08-13 incident proved
// cannot be trusted. It also hardcoded the bare command `ruflo` instead of the shared
// `resolveRuflo()` (ADR-021 / issues #99, #105), the identical resolver gap already fixed in three
// sibling scripts (`distill-project.mjs`, `learn-flush.mjs`, and `degradation-watch.mjs`'s own
// probe), so it could not even be pointed at a fake binary for a test — which is why this file did
// not exist until the 2026-08-24 Dream Cycle night.
//
// A residual gap that night's own report deferred (docs/dream-cycle/2026-08-29-memory-durability-
// report.md, candidate #2, "not this repo's candidate to re-litigate while #167 awaits review"): the
// round-trip key (`lesson-${slug}`) is deterministic, so a SECOND, IDENTICAL invocation (same
// --task/--tried/--worked/--critique/--outcome — a retried or replayed capture) whose store call
// silently no-ops would still retrieve the FIRST run's value back unchanged, and the original
// `back.includes(value)` check cannot tell "this run wrote it" from "a prior run wrote it and this
// run wrote nothing". Closed with a one-shot per-process nonce "pathway probe" mirroring
// `degradation-watch.mjs`'s `proveMemoryDurable()`.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/record-lesson.mjs');

let tmp;
afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; } });

function sandbox() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-lesson-'));
  fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.swarm', 'memory.db'), 'x');
  return tmp;
}

// Four fake-`ruflo` shapes, one per `mode`, identical behavior on POSIX and win32:
//   - null:          no fake at all (RUFLO_BIN points nowhere real).
//   - 'incident':     the exact 2026-08-13 shape — store claims success, retrieve always reports
//                      the key absent. Caught by the ORIGINAL round-trip check alone.
//   - 'healthy':      store genuinely persists to a per-key file under `<dir>/.fake-ruflo-state/`;
//                      retrieve echoes that file's CURRENT content back — a real round trip, not a
//                      canned string. State persists ACROSS separate `run()` calls in the same dir,
//                      modeling a store the script talks to over multiple invocations.
//   - 'store-noops':  same persistent backing as 'healthy', but `store` never writes — it claims
//                      success without touching the state file. `retrieve` still reads whatever a
//                      PRIOR, genuinely-successful invocation already left there. This is the
//                      ALIASING shape the pathway probe exists to catch: a plain value-match round
//                      trip cannot distinguish "this run wrote it" from "an old identical value is
//                      still sitting there and this run wrote nothing".
//   - 'corrupt':      retrieve always answers a SQL-layer error, never "Key not found" — discriminates
//                      a genuine value comparison from a shallower "not literally Key-not-found" check.
function writeFakeRuflo(dir, mode) {
  const ruflo = path.join(dir, 'fake-ruflo');
  const stateDir = path.join(dir, '.fake-ruflo-state');
  fs.mkdirSync(stateDir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'fake-ruflo.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const mode = ${JSON.stringify(mode)};
const stateDir = ${JSON.stringify(stateDir)};
const argv = process.argv.slice(2);
const op = argv[1];
const key = argv[3];
const value = argv[7];
const statePath = path.join(stateDir, key ?? '_');
if (op === 'store') {
  if (mode === 'healthy') fs.writeFileSync(statePath, value ?? '');
  console.log('[OK] Data stored successfully');
} else if (op === 'retrieve') {
  if (mode === 'corrupt') console.log('[ERROR] no such table: memory_entries');
  else if (mode === 'incident') console.log('[WARN] Key not found: ' + key);
  else if (fs.existsSync(statePath)) console.log(fs.readFileSync(statePath, 'utf8'));
  else console.log('[WARN] Key not found: ' + key);
} else if (op === 'distill') console.log('Episodes | 1');
else if (op === 'search') console.log('lesson-probe');
`);
    fs.writeFileSync(`${ruflo}.cmd`, '@echo off\r\nnode "%~dp0fake-ruflo.mjs" %*\r\n');
    return `${ruflo}.cmd`;
  }
  const storeLine = mode === 'healthy' ? 'printf %s "$8" > "$STATE/$4";' : '';
  const retrieveLine = mode === 'corrupt' ? 'echo "[ERROR] no such table: memory_entries"'
    : mode === 'incident' ? 'echo "[WARN] Key not found: $4"'
    : 'if [ -f "$STATE/$4" ]; then cat "$STATE/$4"; else echo "[WARN] Key not found: $4"; fi';
  fs.writeFileSync(ruflo, '#!/bin/sh\n'
    + `STATE="${stateDir}"\n`
    + 'case "$2" in\n'
    + `  store)    ${storeLine} echo "[OK] Data stored successfully";;\n`
    + `  retrieve) ${retrieveLine};;\n`
    + '  distill)  echo "Episodes | 1";;\n'
    + '  search)   echo "lesson-probe";;\n'
    + 'esac\nexit 0\n', { mode: 0o755 });
  return ruflo;
}

/** Run the script against an isolated project dir with a controllable fake `ruflo` on disk. */
function run(args, { mode = null } = {}) {
  const dir = tmp || sandbox();
  const ruflo = mode ? writeFakeRuflo(dir, mode) : '/nonexistent/ruflo';
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, RUFLO_BIN: ruflo },
  });
}

describe('record-lesson — a lesson is not "stored" until it round-trips', () => {
  it('TEETH: a store that claims success but does not round-trip is reported as FAILED, not stored', () => {
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe'], { mode: 'incident' });
    // Pre-candidate code matched /OK|stored/i against the store command's own stdout and would
    // exit 0 here — the exact false "healthy" verdict the 2026-08-13 incident produced.
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/round-trip verified/);
    // The pathway probe (a disposable key, never `key` itself — see STEP 1a) also never round-trips
    // under this fake's incident shape, so this is the only reachable failure message, not
    // "retrieve did not return the value" (that branch requires pathwayLive=true).
    expect(r.stdout).toMatch(/store pathway unproven this run/);
  });

  it('a write that genuinely round-trips is reported as stored, exit 0', () => {
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe'], { mode: 'healthy' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/round-trip verified/);
  });

  it('a damaged store answering a SQL-layer error (not "Key not found") is still reported as FAILED', () => {
    // Discriminates a genuine `.includes(writtenValue)` comparison from a shallower check that
    // merely looks for the ABSENCE of "Key not found" — that shallower check would misread this
    // response (an ADR-063-documented real failure shape) as success.
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe'], { mode: 'corrupt' });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/round-trip verified/);
  });

  it('fails loudly, not silently, when the resolved ruflo binary does not exist', () => {
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe']); // no mode -> RUFLO_BIN points nowhere real
    // resolveRuflo() treats an explicit RUFLO_BIN as authoritative even when the path does not
    // exist (ruflo-bin.mjs's own contract, kept unchanged by this candidate), so this exercises the
    // store call failing against that path — proof `record-lesson.mjs` now goes THROUGH the shared
    // resolver at all, which the hardcoded `execFileSync('ruflo', ...)` it replaced never did.
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/store FAILED/);
  });

  it('TEETH: a second, IDENTICAL invocation whose store silently no-ops is reported as FAILED, not stored, even though a prior run left the exact same value behind', () => {
    sandbox();
    // Run 1: a genuine, healthy write — the real value lands under the deterministic key.
    const first = run(['--task', 'probe task', '--slug', 'probe'], { mode: 'healthy' });
    expect(first.status).toBe(0);
    // Run 2: SAME --task/--slug (so the identical `key` and `value`), but this invocation's store
    // silently no-ops. Pre-candidate code's `back.includes(value)` would still be satisfied by
    // Run 1's leftover value at that key and wrongly report success; the pathway probe (a fresh
    // nonce that could not possibly pre-exist) proves the store pathway is dead THIS invocation
    // regardless of what the stale value shows.
    const second = run(['--task', 'probe task', '--slug', 'probe'], { mode: 'store-noops' });
    expect(second.status).toBe(1);
    expect(second.stdout).not.toMatch(/round-trip verified/);
    expect(second.stdout).toMatch(/store pathway unproven this run/);
  });
});
