// tests/integration/ruflo-daemon-autostart.test.mjs — acceptance probe for RUFLO_DAEMON_AUTOSTART=0.
//
// WHY THIS EXISTS (2026-09-11 review correction): "every `ruflo` invocation auto-starts a project
// background daemon unless RUFLO_DAEMON_AUTOSTART=0" was a claim in this repo's own docs — never
// verified against the ACTUAL installed CLI. Verified live, not recalled, against the real global
// install before writing this test:
//
//   $ cat ~/.npm-global/lib/node_modules/ruflo/package.json | grep version
//   "version": "3.41.2"
//   $ grep -n RUFLO_DAEMON_AUTOSTART \
//       ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/daemon-autostart.js
//   85:    if (/^(0|false|no|off)$/i.test(process.env.RUFLO_DAEMON_AUTOSTART ?? ''))
//   184:        return { started: false, reason: 'disabled (RUFLO_DAEMON_AUTOSTART=0 or project config)' };
//
// So the variable IS honored by the installed CLI — this test is the acceptance probe proving the
// REPO'S usage of it actually prevents a daemon, not a re-statement of the source read above.
//
// isRufloProject() (same file) requires a durable marker — a bare tmp dir would never be eligible
// for a daemon regardless of the flag, which would make this test pass for the wrong reason (a
// "test that cannot fail on broken code is not a test"). `.swarm/memory.db` is itself one of the
// CLI's own direct markers, so the fixture runs a real `memory init` + `memory store` first (both
// ALSO under the flag, to avoid a chicken-and-egg daemon during setup) to make this tmp project
// genuinely qualify — by the CLI's own rule, not a marker this test invented — before running the
// actual PROBED command, `memory list`, and asserting no daemon evidence exists anywhere.
//
// `cwd` is pinned to the fixture project dir for every invocation: `memory init` was observed
// (live, this same probe) to also sync a copy to `<cwd>/.claude/memory.db` regardless of --path —
// without pinning cwd that write lands in whatever directory happens to be the test runner's cwd.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveRufloBin() {
  const preferred = path.join(os.homedir(), '.npm-global', 'bin', 'ruflo');
  if (fs.existsSync(preferred)) return preferred;
  const found = spawnSync('sh', ['-c', 'command -v ruflo'], { encoding: 'utf8' }).stdout.trim();
  return found || null;
}
const RUFLO = resolveRufloBin();

describe.skipIf(!RUFLO)('RUFLO_DAEMON_AUTOSTART=0 acceptance probe (against the REAL installed ruflo CLI)', () => {
  let projectDir, fixtureHome, dbPath;
  const env = () => ({ PATH: process.env.PATH, HOME: fixtureHome, USERPROFILE: fixtureHome, RUFLO_DAEMON_AUTOSTART: '0' });
  const ruflo = (args) => spawnSync(RUFLO, args, { cwd: projectDir, encoding: 'utf8', timeout: 30_000, env: env() });

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-autostart-probe-'));
    fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-autostart-home-'));
    dbPath = path.join(projectDir, '.swarm', 'memory.db');
    // Setup only — makes the fixture a genuine Ruflo project (`.swarm/memory.db` existing is itself
    // one of isRufloProject()'s direct markers). Also run under the flag: setup must not be the
    // thing that leaves a daemon behind either.
    const init = ruflo(['memory', 'init', '-p', dbPath]);
    if (init.status !== 0) throw new Error(`fixture setup failed (memory init): ${init.stderr || init.stdout}`);
    const store = ruflo(['memory', 'store', '-k', 'probe', '--value', 'probe', '--path', dbPath]);
    if (store.status !== 0) throw new Error(`fixture setup failed (memory store): ${store.stderr || store.stdout}`);
  });

  afterAll(() => {
    for (const dir of [projectDir, fixtureHome]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  it('reports the version this probe is actually running against (VERIFY-FIRST, shown in the open)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.npm-global/lib/node_modules/ruflo/package.json'), 'utf8'));
    console.log(`[ruflo-daemon-autostart probe] installed ruflo version: ${pkg.version}`);
    expect(typeof pkg.version).toBe('string');
  });

  it('the fixture genuinely qualifies as a Ruflo project before the probed command ever runs', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('`ruflo memory list` under RUFLO_DAEMON_AUTOSTART=0 spawns ZERO daemon processes', () => {
    const r = ruflo(['memory', 'list', '--path', dbPath]);
    expect(r.error).toBeFalsy();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/probe/); // proves it actually read the fixture DB, not a no-op
    const daemonPidFile = path.join(projectDir, '.claude-flow', 'daemon.pid');
    expect(fs.existsSync(daemonPidFile)).toBe(false);
    // Belt-and-braces: scan for any live process whose command line references this exact project
    // dir as a daemon — not just the pidfile's absence, in case something wrote the file late.
    const psOut = spawnSync('ps', ['-e', '-o', 'command='], { encoding: 'utf8' }).stdout || '';
    const strayDaemon = psOut.split('\n').some((line) => line.includes(projectDir) && /daemon/i.test(line));
    expect(strayDaemon).toBe(false);
  });
});

describe.skipIf(!!RUFLO)('RUFLO_DAEMON_AUTOSTART probe skipped', () => {
  it('honestly reports why, rather than inventing a pass', () => {
    console.log('[ruflo-daemon-autostart probe] SKIPPED — ruflo not found on this machine (not ~/.npm-global/bin/ruflo, not on PATH)');
    expect(true).toBe(true);
  });
});
