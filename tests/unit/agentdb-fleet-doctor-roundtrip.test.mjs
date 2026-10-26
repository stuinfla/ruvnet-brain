// agentdb-fleet-doctor-roundtrip.test.mjs — the doctor's own round-trip VERIFY step must prove
// THIS run's write landed, not that a semantically similar canary exists somewhere in the store.
//
// WHY THIS EXISTS. `scripts/agentdb-fleet-doctor.mjs`'s header promises "VERIFY: a real round-trip
// through the ruflo CLI", but the check it shipped with called `ruflo memory search` and matched a
// SUBSTRING every canary this project has ever written shares (`fleet-doctor-cana...` / `round-trip
// canary`), never this run's unique key or value. A project whose CURRENT canary write silently
// failed (ADR-063's documented incident shape: `memory store` claims success, the write never
// lands) but which still has an OLDER canary from a prior run ranking in `memory search`'s top 3
// would report `roundtrip: PASS` anyway — exactly the false-positive class this repo's own
// `ground-ruvnet.sh` names ("never infer a broken write from... semantic-search misses... exact-key
// retrieve and read the returned VALUE"), already fixed this same way in `record-lesson.mjs`,
// `distill-project.mjs`, and `health-repair.mjs`'s fleet receipt — but never carried to this
// sibling verifier.
//
// This test drives the real CLI entrypoint against a fake `ruflo` resolved the same way the
// production code resolves it (`os.homedir()` + `.npm-global/bin/ruflo`), using `HOME` to point
// that resolution at a sandboxed binary — no production resolution logic is touched to make this
// testable.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/agentdb-fleet-doctor.mjs');

let fakeHome;
let projDir;
afterEach(() => {
  for (const d of [fakeHome, projDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  fakeHome = null;
  projDir = null;
});

const FAKE_RUFLO = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const op = args[1];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const SIDE = process.env.FAKE_RUFLO_SIDE;
const MODE = process.env.FAKE_RUFLO_MODE;
let map = {};
try { map = JSON.parse(fs.readFileSync(SIDE, 'utf8')); } catch {}

if (op === 'store') {
  const key = flag('-k');
  const value = flag('--value');
  // 'silent-fail' reproduces the ADR-063 incident shape: the CLI claims success but the write
  // never actually lands in the managed store.
  if (MODE !== 'silent-fail') { map[key] = value; fs.writeFileSync(SIDE, JSON.stringify(map)); }
  console.log('[OK] Data stored successfully');
  process.exit(0);
} else if (op === 'retrieve') {
  const key = flag('-k');
  const value = map[key];
  if (value === undefined) { console.log('[WARN] Key not found: ' + key); process.exit(0); }
  process.stdout.write(value);
  process.exit(0);
} else if (op === 'search') {
  // A STALE canary from a prior run, still semantically similar enough to rank — present
  // regardless of whether THIS run's write actually landed. This is the exact shape that fooled
  // the pre-fix substring check.
  console.log('1. fleet-doctor-cana...   round-trip canary 2026-09-01T00:00:00.000Z   score=0.91');
  process.exit(0);
} else if (op === 'distill') {
  console.log('Episodes | 0');
  process.exit(0);
}
process.exit(0);
`;

function sandbox({ mode } = {}) {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-doctor-home-'));
  const bin = path.join(fakeHome, '.npm-global', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const rufloPath = path.join(bin, 'ruflo');
  fs.writeFileSync(rufloPath, FAKE_RUFLO);
  fs.chmodSync(rufloPath, 0o755);

  projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-doctor-proj-'));
  fs.mkdirSync(path.join(projDir, '.swarm'), { recursive: true });
  const db = path.join(projDir, '.swarm', 'memory.db');
  // No real `sqlite3` CLI in this container (same pre-existing, already-documented environmental
  // gap every prior Dream Cycle night has hit) — a dummy file is enough: `fs.existsSync(db)` is all
  // the doctor needs to proceed, and every `sql()` query against it fails closed to `null`/0,
  // exactly like a schemaless store. That drives FIX 1 (checkpoint seeding) through the SAME fake
  // `ruflo`, which is harmless here — it uses a different key prefix than the canary this test
  // actually verifies, and the unconditional VERIFY/round-trip step below still runs identically.
  fs.writeFileSync(db, 'x');

  const side = path.join(fakeHome, 'side.json');
  fs.writeFileSync(side, '{}');

  const r = spawnSync(process.execPath, [SCRIPT, projDir], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: fakeHome, FAKE_RUFLO_SIDE: side, ...(mode ? { FAKE_RUFLO_MODE: mode } : {}) },
  });
  return r;
}

describe('agentdb-fleet-doctor — round-trip VERIFY proves THIS write, not a stale canary', () => {
  it('TEETH: a write that silently fails to land is reported as round-trip FAIL, even with a stale canary present', () => {
    const r = sandbox({ mode: 'silent-fail' });
    // Pre-candidate code called `memory search` and matched the generic "fleet-doctor-cana"/
    // "round-trip canary" substring the stale canary above always supplies — it would report PASS
    // here even though this run's own write never landed (map stays empty, retrieve would find
    // nothing). The candidate's exact-key retrieve must see the miss and report FAIL.
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\|\s*FAIL\s*\|/);
    expect(r.stdout).not.toMatch(/\|\s*PASS\s*\|/);
    expect(r.stdout).toMatch(/NEEDS ATTENTION/);
  });

  it('a write that genuinely round-trips is reported as round-trip PASS', () => {
    const r = sandbox();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\|\s*PASS\s*\|/);
    expect(r.stdout).not.toMatch(/\|\s*FAIL\s*\|/);
    expect(r.stdout).toMatch(/1\/1 projects fully verified/);
  });
});
