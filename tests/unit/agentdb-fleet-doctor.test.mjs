import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ADR-063 / 2026-08-13 incident, applied to a second file. `scripts/agentdb-fleet-doctor.mjs`'s
// FIX 1 (checkpoint seeding) derived its `seeded` verdict solely from `ruflo memory store`'s exit
// status plus a regex match on its stdout wording ("stored successfully") — the exact shape that
// let three days of memory writes evaporate behind an `[OK]` line. The file's OWN separate FIX-2
// canary round-trips a *different*, freshly-generated key later in the same run; it proves the
// namespace is writable in general, and cannot tell "this specific checkpoint write persisted"
// apart from "the namespace happens to still accept writes while this one silently dropped."

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DOCTOR = path.join(ROOT, 'scripts', 'agentdb-fleet-doctor.mjs');

let home;
let proj;
let statePath;

/** A fake `ruflo` binary at the HOME this test controls, so agentdb-fleet-doctor.mjs's hardcoded
 * `path.join(os.homedir(), '.npm-global/bin/ruflo')` resolves here instead of a real install. State
 * (what has actually been "stored") persists in a JSON file across the multiple ruflo invocations a
 * single doctor run makes, mirroring how a real managed store would behave. */
function installFakeRuflo(fakeHome, { noopKeyPrefix } = {}) {
  const bin = path.join(fakeHome, '.npm-global', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.FAKE_RUFLO_STATE;
const noopPrefix = process.env.FAKE_RUFLO_NOOP_KEY_PREFIX || '';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] === 'memory' && args[1] === 'store') {
  const key = flag('-k'); const value = flag('--value'); const ns = flag('-n');
  // Reproduce the 2026-08-13 incident shape: claim success on stdout, exit 0, but for a key under
  // the configured noop prefix, do not actually persist it.
  if (!(noopPrefix && key && key.startsWith(noopPrefix))) {
    state[\`\${ns}::\${key}\`] = value;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  console.log('[OK] Data stored successfully');
  process.exit(0);
}
if (args[0] === 'memory' && args[1] === 'retrieve') {
  const key = flag('-k'); const ns = flag('-n');
  const v = state[\`\${ns}::\${key}\`];
  if (v === undefined) { console.error('[ERROR] Key not found'); process.exit(1); }
  console.log(v);
  process.exit(0);
}
if (args[0] === 'memory' && args[1] === 'search') {
  const ns = flag('-n');
  const hits = Object.keys(state).filter((k) => k.startsWith(\`\${ns}::\`) && k.includes('fleet-doctor-cana'));
  console.log(hits.length ? hits.join('\\n') : 'no results');
  process.exit(0);
}
if (args[0] === 'memory' && args[1] === 'distill') {
  console.log('Episodes | 1');
  process.exit(0);
}
console.error('unknown fake ruflo invocation: ' + args.join(' '));
process.exit(2);
`;
  const binPath = path.join(bin, 'ruflo');
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

function seedDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stmts = [
    'CREATE TABLE memory_entries(key TEXT, value TEXT, namespace TEXT, updated_at INTEGER, embedding BLOB);',
    'CREATE TABLE episodes(id INTEGER);',
  ];
  const r = spawnSync('sqlite3', [file, stmts.join(' ')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${r.stderr}`);
}

function runDoctor(fakeHome, extraEnv = {}) {
  const r = spawnSync(process.execPath, [DOCTOR, proj], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      FAKE_RUFLO_STATE: statePath,
      ...extraEnv,
    },
  });
  return r;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-doctor-home-')));
  const projRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-doctor-proj-')));
  proj = path.join(projRoot, 'demo-project');
  fs.mkdirSync(proj, { recursive: true });
  seedDb(path.join(proj, '.swarm', 'memory.db'));
  statePath = path.join(home, 'fake-ruflo-state.json');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(path.dirname(proj), { recursive: true, force: true });
});

describe('agentdb-fleet-doctor — checkpoint seeding must round-trip the key it actually wrote', () => {
  it('a genuinely healthy seed is reported SEEDED', () => {
    installFakeRuflo(home);
    const r = runDoctor(home);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/SEEDED/);
    expect(r.stdout).not.toMatch(/NEEDS ATTENTION/);
  });

  it('TEETH: a store that claims success but silently drops the checkpoint key is NOT reported SEEDED', () => {
    // The checkpoint key is `project-state-current-<epochms>`; the canary key used by the file's own
    // separate FIX-2 round-trip check is `fleet-doctor-canary-<epochms>` — a different prefix, so
    // this noops ONLY the checkpoint write. The namespace remains writable in general (the canary
    // still succeeds), which is exactly the case the pre-fix code could not distinguish from a real
    // checkpoint write.
    installFakeRuflo(home);
    const r = runDoctor(home, { FAKE_RUFLO_NOOP_KEY_PREFIX: 'project-state-current-' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/SEEDED/);
    expect(r.stdout).toMatch(/NEEDS ATTENTION/);
    // The canary's own independent round-trip (a different key) still passes — confirming this
    // failure is specific to the checkpoint key, not a total namespace outage the old canary-only
    // signal would already have caught.
    expect(r.stdout).toMatch(/PASS/);
  });

  it('a store call that fails outright (non-zero exit) is still NOT reported SEEDED', () => {
    installFakeRuflo(home);
    // Force every store call to fail via a bogus namespace flag our fake doesn't special-case; simpler
    // to just point RUFLO at a script that always exits 1 for `store`.
    const bin = path.join(home, '.npm-global', 'bin', 'ruflo');
    const broken = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'memory' && args[1] === 'store') { console.error('[ERROR] no such table: memory_entries'); process.exit(1); }
console.log('Episodes | 0');
process.exit(0);
`;
    fs.writeFileSync(bin, broken, { mode: 0o755 });
    const r = runDoctor(home);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/SEEDED/);
  });
});
