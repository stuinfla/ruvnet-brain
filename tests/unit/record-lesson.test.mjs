// record-lesson.test.mjs — record-lesson.mjs must prove a lesson landed, not infer it from the
// store command's own claimed-success wording.
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
// not exist until tonight.
//
// This test proves the fix with a controllable fake `ruflo` that reproduces the exact 2026-08-13
// shape: `memory store` claims success, `memory retrieve` on that same key reports the key absent.
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

/** Run the script against an isolated project dir with a controllable fake `ruflo` on disk. */
function run(args, { rufloBody = null } = {}) {
  const dir = tmp || sandbox();
  let ruflo = '/nonexistent/ruflo';
  if (rufloBody) {
    if (process.platform === 'win32') {
      // No shebang execution on Windows: keep the POSIX body as-is and shim it through the
      // Git Bash the windows CI job already relies on -- same pattern distill-project.test.mjs
      // uses for this exact binary, and record-lesson.mjs's own `shell: win32` guard now expects.
      const sh = path.join(dir, 'fake-ruflo.sh');
      fs.writeFileSync(sh, rufloBody);
      ruflo = path.join(dir, 'fake-ruflo.cmd');
      fs.writeFileSync(ruflo, `@bash "${sh}" %*\r\n`);
    } else {
      ruflo = path.join(dir, 'fake-ruflo');
      fs.writeFileSync(ruflo, rufloBody, { mode: 0o755 });
    }
  }
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, RUFLO_BIN: ruflo },
  });
}

// A fake CLI shaped exactly like the 2026-08-13 incident: `memory store` prints the real success
// line and exits 0; `memory retrieve` on that identical key answers "Key not found", exit 0 (the
// CLI does not fail loudly on a lost write — that is the whole reason the incident went unnoticed
// for three days). `distill` and `search` are no-ops so only the store/retrieve behavior is probed.
const INCIDENT_SHAPE_RUFLO = '#!/bin/sh\n'
  + 'case "$2" in\n'
  + '  store)    echo "[OK] Data stored successfully"; exit 0;;\n'
  + '  retrieve) echo "[WARN] Key not found: lesson-probe"; exit 0;;\n'
  + '  distill)  echo "Episodes | 0"; exit 0;;\n'
  + '  search)   echo "[WARN] No results found"; exit 0;;\n'
  + 'esac\nexit 0\n';

// A fake CLI where the write genuinely lands: retrieve echoes the exact value back.
const HEALTHY_RUFLO = '#!/bin/sh\n'
  + 'case "$2" in\n'
  + '  store)    echo "[OK] Data stored successfully"; exit 0;;\n'
  + '  retrieve) echo "TASK: probe task OUTCOME: success"; exit 0;;\n'
  + '  distill)  echo "Episodes | 1"; exit 0;;\n'
  + '  search)   echo "lesson-probe"; exit 0;;\n'
  + 'esac\nexit 0\n';

// A THIRD shape, distinct from both of the above: the store is damaged and `retrieve` returns a
// SQL-layer error rather than "Key not found". This discriminates a genuine value comparison from
// a shallower "not literally Key-not-found" check — the latter would wrongly call this a success.
const CORRUPT_STORE_RUFLO = '#!/bin/sh\n'
  + 'case "$2" in\n'
  + '  store)    echo "[OK] Data stored successfully"; exit 0;;\n'
  + '  retrieve) echo "[ERROR] no such table: memory_entries"; exit 0;;\n'
  + '  distill)  echo "Episodes | 0"; exit 0;;\n'
  + '  search)   echo "[WARN] No results found"; exit 0;;\n'
  + 'esac\nexit 0\n';

describe('record-lesson — a lesson is not "stored" until it round-trips', () => {
  it('TEETH: a store that claims success but does not round-trip is reported as FAILED, not stored', () => {
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe'], { rufloBody: INCIDENT_SHAPE_RUFLO });
    // Pre-candidate code matched /OK|stored/i against the store command's own stdout and would
    // exit 0 here — the exact false "healthy" verdict the 2026-08-13 incident produced.
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/round-trip verified/);
    expect(r.stdout).toMatch(/retrieve did not return the value/);
  });

  it('a write that genuinely round-trips is reported as stored, exit 0', () => {
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe'], { rufloBody: HEALTHY_RUFLO });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/round-trip verified/);
  });

  it('a damaged store answering a SQL-layer error (not "Key not found") is still reported as FAILED', () => {
    // Discriminates a genuine `.includes(writtenValue)` comparison from a shallower check that
    // merely looks for the ABSENCE of "Key not found" — that shallower check would misread this
    // response (an ADR-063-documented real failure shape) as success.
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe'], { rufloBody: CORRUPT_STORE_RUFLO });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/round-trip verified/);
  });

  it('fails loudly, not silently, when the resolved ruflo binary does not exist', () => {
    sandbox();
    const r = run(['--task', 'probe task', '--slug', 'probe']); // no rufloBody -> RUFLO_BIN points nowhere real
    // resolveRuflo() treats an explicit RUFLO_BIN as authoritative even when the path does not
    // exist (ruflo-bin.mjs's own contract, kept unchanged by this candidate), so this exercises the
    // store call failing against that path — proof `record-lesson.mjs` now goes THROUGH the shared
    // resolver at all, which the hardcoded `execFileSync('ruflo', ...)` it replaced never did.
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/store FAILED/);
  });
});
