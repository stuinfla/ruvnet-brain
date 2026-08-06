// tests/unit/token-meter.test.mjs — the token meter (ADR-0011 token_cost_efficiency).
//
// Scorecard evidence said: "Nothing in the stack measures Claude Code spend." The meter fixes that
// with one append per fire: ground-ruvnet.sh / session-start.sh log the REAL byte size of what they
// injected, forge-mcp-all.mjs logs the char size of every search_ruvnet response, and
// scripts/token-report.mjs aggregates the shared ledger (.ruvnet-brain/token-ledger.jsonl, per
// project cwd). Everything here is subprocess-level, matching autonomy-loop.test.mjs: the hook is a
// shell script fed prompt JSON on stdin and the MCP server is a stdio JSON-RPC process — testing
// exported functions would not prove the contract across the process boundary.
//
// The hook runs with HOME pointed at a per-test temp dir with the rate-limit stamps PRE-SEEDED to
// "just checked", so the once-per-20h background npm-registry fetch never fires during tests (no
// network, no machine-global cache state leaking into assertions).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmHome } from '../helpers/reap-detached.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GROUND_HOOK = path.join(REPO_ROOT, 'plugin/scripts/ground-ruvnet.sh');
const SESSION_HOOK = path.join(REPO_ROOT, 'plugin/scripts/session-start.sh');
const REPORT = path.join(REPO_ROOT, 'scripts/token-report.mjs');
const MCP_SERVER = path.join(REPO_ROOT, 'kb/forge-mcp-all.mjs');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');

let tmp; // the fake project dir (cwd of every hook fire — where the ledger must NOT land)
let tmpHome; // isolated HOME so machine-global caches/stamps never leak in

// The ledger is USER-LEVEL, not per-CWD (issue #36, mamd69, 2026-07-21). Writing it relative to the
// shell's working directory scattered hidden .ruvnet-brain/ folders into users' project trees —
// three on one machine, including inside an unrelated git repo and a deep docs subdirectory, each
// showing up as untracked and dirtying `git status`. These tests previously asserted that broken
// behaviour, so they had to change with it: the ledger now lands in ONE place, and `noStrayDirs()`
// pins the property the issue was actually about.
const ledgerPath = () => path.join(tmpHome, '.cache', 'ruvnet-brain', 'token-ledger.jsonl');
/** Nothing may ever create a .ruvnet-brain directory inside a project tree. */
const noStrayDirs = () => !fs.existsSync(path.join(tmp, '.ruvnet-brain'));
const readLedgerLines = () =>
  fs.readFileSync(ledgerPath(), 'utf8').split('\n').filter((l) => l.trim());

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-meter-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-meter-home-')));
  // Pre-seed both rate-limit stamps to NOW so neither hook starts a network check mid-test.
  const cache = path.join(tmpHome, '.cache', 'ruvnet-brain');
  fs.mkdirSync(cache, { recursive: true });
  const now = String(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(cache, '.stack-versions-checked'), now); // ground-ruvnet.sh
  fs.writeFileSync(path.join(cache, '.last-update-check'), now); // session-start.sh
});

afterEach(() => {
  try { fs.chmodSync(tmp, 0o755); } catch { /* only matters for the read-only-cwd test */ }
  rmHome(tmpHome, tmp);
});

function runGroundHook(prompt, { env = {} } = {}) {
  const r = spawnSync('bash', [GROUND_HOOK], {
    cwd: tmp,
    input: JSON.stringify({ prompt }),
    encoding: 'utf8',
    timeout: 15000,
    // USERPROFILE as well as HOME, in every one of these env literals (25cda46's class, measured
    // here). XDG_CACHE_HOME is NOT enough: kb/telemetry-ping.mjs's defaultStateDir() and
    // kb/brain-alarm.mjs's STATE_DIR are both `path.join(os.homedir(), '.cache', 'ruvnet-brain')`,
    // which consults neither XDG_CACHE_HOME nor HOME — and os.homedir() reads USERPROFILE on
    // Windows. MEASURED under Windows homedir semantics before this line: still GREEN, but
    // `.cache/ruvnet-brain/.grounded-once` was written into the runner's real profile, so the
    // "PRE-SEEDED stamps" this file's header relies on described a directory nothing was reading.
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, XDG_CACHE_HOME: path.join(tmpHome, '.cache'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, RUVNET_AUTONOMOUS: '', ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runSessionHook({ env = {} } = {}) {
  const r = spawnSync('bash', [SESSION_HOOK], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, XDG_CACHE_HOME: path.join(tmpHome, '.cache'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('ground-ruvnet.sh — every fire appends one honest ledger line', () => {
  it('a build+ruvnet prompt logs valid JSON with the required fields, class from the gates that fired, and bytes = the EXACT byte size of what was emitted', () => {
    const out = runGroundHook('implement the retry workflow for ruflo swarms');
    expect(out.status).toBe(0);

    const lines = readLedgerLines();
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]); // throws (fails the test) if not valid JSON
    expect(entry).toMatchObject({ source: 'hook', class: 'ruvnet+build' });
    expect(typeof entry.ts).toBe('string');
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
    // The core honesty claim: measured from the real output string, not an estimate.
    expect(entry.bytes).toBe(Buffer.byteLength(out.stdout, 'utf8'));
    expect(entry.bytes).toBeGreaterThan(0);
  });

  it('metering changes NOTHING about what the hook emits — the directives still reach stdout, exit 0', () => {
    const out = runGroundHook('implement the retry workflow for ruflo swarms');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/APPLY THE PLAYBOOK/);
    expect(out.stdout).toMatch(/ground before you assert/);
  });

  it('a build VERB without project scale does NOT fire BUILD (PR #8 two-signal gate — small edits stay cheap)', () => {
    const out = runGroundHook('add my email address to the contact page footer');
    expect(out.status).toBe(0);
    const entry = JSON.parse(readLedgerLines()[0]);
    expect(entry.class).not.toMatch(/build/);
    expect(out.stdout).not.toMatch(/APPLY THE PLAYBOOK/);
  });

  it('a prompt matching no gate logs class:"none" (the always-on Gate 0 bytes still count)', () => {
    const out = runGroundHook('what is the capital of France?');
    expect(out.status).toBe(0);
    const entry = JSON.parse(readLedgerLines()[0]);
    expect(entry.class).toBe('none');
    expect(entry.bytes).toBe(Buffer.byteLength(out.stdout, 'utf8'));
  });

  it('two fires append two lines — the ledger accumulates, never truncates', () => {
    runGroundHook('implement retries');
    runGroundHook('fix the flaky test');
    expect(readLedgerLines().length).toBe(2);
  });

  it('RUVNET_BRAIN_METER=0 suppresses the write entirely, while the directives still emit', () => {
    const out = runGroundHook('implement the retry workflow', { env: { RUVNET_BRAIN_METER: '0' } });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/APPLY THE PLAYBOOK/);
    expect(fs.existsSync(path.join(tmp, '.ruvnet-brain'))).toBe(false);
  });

  // win32: chmod cannot revoke write permission on a Windows directory, so the read-only-cwd
  // scenario is unconstructible there — the ledger write succeeds and the test asserts a fiction.
  // Premise updated with issue #36's fix, and the outcome got BETTER. This used to assert that a
  // read-only project directory silently cost you the ledger line — an unavoidable consequence of
  // writing into the project. Now nothing is written there at all, so a read-only cwd costs nothing:
  // the hook still runs, still emits, still meters, and still creates no directory in the project.
  it.skipIf(process.platform === 'win32')('a read-only cwd cannot break the hook — and no longer costs the ledger line either', () => {
    fs.chmodSync(tmp, 0o555);
    const out = runGroundHook('implement the retry workflow');
    fs.chmodSync(tmp, 0o755);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/APPLY THE PLAYBOOK/);
    expect(noStrayDirs()).toBe(true);          // nothing written into the project, read-only or not
    expect(fs.existsSync(ledgerPath())).toBe(true); // and metering survives, because it lives elsewhere
  });
});

describe('session-start.sh — logs class:"session-start" with the same exact-bytes contract', () => {
  it('one fire = one valid ledger line, bytes = exact stdout size, and the banner still emits', () => {
    const out = runSessionHook();
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/RuvNet Brain/);
    const lines = readLedgerLines();
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ source: 'hook', class: 'session-start' });
    expect(entry.bytes).toBe(Buffer.byteLength(out.stdout, 'utf8'));
    expect(entry.bytes).toBeGreaterThan(0);
  });

  it('RUVNET_BRAIN_METER=0 suppresses the write; the session banner still emits', () => {
    const out = runSessionHook({ env: { RUVNET_BRAIN_METER: '0' } });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/RuvNet Brain/);
    expect(fs.existsSync(path.join(tmp, '.ruvnet-brain'))).toBe(false);
  });
});

describe('forge-mcp-all.mjs — one mcp ledger line per search_ruvnet call (empty KB: no models, no network)', () => {
  // Empty KB dir → discoverRepos()=[] → rerankPairs short-circuits → "(no results)" comes back
  // fast with zero model downloads, while still exercising the REAL server + REAL meterLog path.
  function callMcp({ env = {} } = {}) {
    const kbEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'token-meter-kb-'));
    const req = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search_ruvnet', arguments: { query: 'what is rvf', k: 3 } },
    });
    const r = spawnSync('node', [MCP_SERVER], {
      cwd: tmp,
      input: req + '\n',
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, XDG_CACHE_HOME: path.join(tmpHome, '.cache'), KB_DIR: kbEmpty, ...env },
    });
    fs.rmSync(kbEmpty, { recursive: true, force: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('logs {source:"mcp", tool:"search_ruvnet", k, bytes} where bytes = the response text\'s char count', () => {
    const out = callMcp();
    // These two subtests fail ONLY on CI runners (never reproduced locally — tried Node 20, the
    // exact single-line input, kb/node_modules removed, and coverage on; 2026-07-12). Carry the
    // child's stderr in the failure message so the runner itself reports the root cause instead
    // of a bare exit code we then can't reproduce.
    expect(out.status, `server stderr:\n${out.stderr}\nstdout head:\n${out.stdout.slice(0, 400)}`).toBe(0);
    const rpc = JSON.parse(out.stdout.trim().split('\n')[0]);
    const responseText = rpc.result.content[0].text;
    const entry = JSON.parse(readLedgerLines()[0]);
    expect(noStrayDirs(), 'the MCP server wrote a .ruvnet-brain/ dir into the project (issue #36)').toBe(true);
    expect(entry).toMatchObject({ source: 'mcp', tool: 'search_ruvnet', k: 3 });
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
    expect(entry.bytes).toBe(responseText.length);
  }, 60000);

  it('RUVNET_BRAIN_METER=0: the query still answers, nothing is written', () => {
    const out = callMcp({ env: { RUVNET_BRAIN_METER: '0' } });
    expect(out.status, `server stderr:\n${out.stderr}\nstdout head:\n${out.stdout.slice(0, 400)}`).toBe(0);
    expect(out.stdout).toMatch(/no results/);
    expect(fs.existsSync(path.join(tmp, '.ruvnet-brain'))).toBe(false);
  }, 60000);
});

describe('token-report.mjs — aggregates the ledger into per-class count / p50 / p95 / est tokens', () => {
  function runReport(args) {
    const r = spawnSync('node', [REPORT, ...args], {
      cwd: tmp, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, XDG_CACHE_HOME: path.join(tmpHome, '.cache') },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('computes nearest-rank p50/p95, per-class token estimates (bytes/4), the session total, and skips malformed lines without dying', () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      [
        '{"ts":"2026-07-10T05:00:00Z","source":"hook","class":"build","bytes":100}',
        '{"ts":"2026-07-10T05:01:00Z","source":"hook","class":"build","bytes":200}',
        '{"ts":"2026-07-10T05:02:00Z","source":"hook","class":"build","bytes":300}',
        '{"ts":"2026-07-10T05:03:00Z","source":"hook","class":"build","bytes":400}',
        '{"ts":"2026-07-10T05:04:00Z","source":"mcp","tool":"search_ruvnet","k":6,"bytes":2000}',
        'this line is not json',
        '',
      ].join('\n'),
    );
    const out = runReport([]); // no --ledger: reads the canonical user-level ledger, like a user would
    expect(out.status).toBe(0);
    // hook:build — 4 fires, p50 of [100,200,300,400] = 200 (nearest-rank), p95 = 400, 1000 bytes ≈ 250 tokens
    expect(out.stdout).toMatch(/hook:build\s+4\s+200\s+400\s+1000\s+250/);
    // mcp:search_ruvnet — 1 call, 2000 bytes ≈ 500 tokens
    expect(out.stdout).toMatch(/mcp:search_ruvnet\s+1\s+2000\s+2000\s+2000\s+500/);
    // session total across everything valid: 5 injections, 3000 bytes ≈ 750 tokens
    expect(out.stdout).toMatch(/session total: 5 injections, 3000 bytes ≈ 750 tokens/);
    expect(out.stdout).toMatch(/1 malformed line\(s\) skipped/);
  });

  it('a missing ledger reports "no data yet" and exits 0 — never an error for a brand-new project', () => {
    const out = runReport(['--ledger', path.join(tmp, 'does-not-exist.jsonl')]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/meter: no data yet/);
  });
});

// ── issue #36 regression (mamd69, 2026-07-21) ────────────────────────────────────────────────────
// "Hooks write .ruvnet-brain/token-ledger.jsonl into the shell CWD, scattering into project subdirs
// and dirtying git repos." They found three strays on one machine — one in an unrelated git repo,
// one in a deep docs subdirectory. The property that was violated is simple and worth pinning
// directly rather than inferring it from the ledger assertions above: NO writer may ever create a
// directory inside a project tree, no matter what the CWD happens to be when it fires.
describe('issue #36 — no writer may create .ruvnet-brain/ in a project tree', () => {
  it('a hook firing from a deep subdirectory leaves the tree completely untouched', () => {
    const deep = path.join(tmp, 'repo', 'docs', 'guides', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    const r = spawnSync('bash', [GROUND_HOOK], {
      cwd: deep, // the exact repro: a step that cd'd into a subfolder before the hook fired
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'implement the retry workflow' }),
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, XDG_CACHE_HOME: path.join(tmpHome, '.cache'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, RUVNET_AUTONOMOUS: '' },
    });
    expect(r.status).toBe(0);
    // Not one stray directory anywhere beneath the project — not at the root, not in the subdir.
    const strays = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name === '.ruvnet-brain') strays.push(path.join(d, e.name));
        else walk(path.join(d, e.name));
      }
    };
    walk(tmp);
    expect(strays, `stray directories created in the project tree: ${strays.join(', ')}`).toEqual([]);
    // …and the measurement still happened, in the one place it belongs.
    expect(fs.existsSync(ledgerPath())).toBe(true);
    // The cwd is preserved as a field, so per-project reporting survives the move.
    const last = JSON.parse(readLedgerLines().pop());
    // Git Bash's `pwd -W` prints C:/forward/slash while realpathSync prints C:\backslash —
    // compare separator- and case-insensitively; on POSIX normalize() changes nothing real.
    const normalize = (p) => p.replace(/\\/g, '/').toLowerCase();
    expect(normalize(last.cwd)).toBe(normalize(fs.realpathSync(deep)));
  });
});
