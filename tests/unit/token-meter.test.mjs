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

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GROUND_HOOK = path.join(REPO_ROOT, 'plugin/scripts/ground-ruvnet.sh');
const SESSION_HOOK = path.join(REPO_ROOT, 'plugin/scripts/session-start.sh');
const REPORT = path.join(REPO_ROOT, 'scripts/token-report.mjs');
const MCP_SERVER = path.join(REPO_ROOT, 'kb/forge-mcp-all.mjs');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');

let tmp; // the fake project dir (cwd of every hook fire — where the ledger lands)
let tmpHome; // isolated HOME so machine-global caches/stamps never leak in

const ledgerPath = () => path.join(tmp, '.ruvnet-brain', 'token-ledger.jsonl');
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
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function runGroundHook(prompt, { env = {} } = {}) {
  const r = spawnSync('bash', [GROUND_HOOK], {
    cwd: tmp,
    input: JSON.stringify({ prompt }),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: tmpHome, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, RUVNET_AUTONOMOUS: '', ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runSessionHook({ env = {} } = {}) {
  const r = spawnSync('bash', [SESSION_HOOK], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: tmpHome, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('ground-ruvnet.sh — every fire appends one honest ledger line', () => {
  it('a build+ruvnet prompt logs valid JSON with the required fields, class from the gates that fired, and bytes = the EXACT byte size of what was emitted', () => {
    const out = runGroundHook('implement the retry policy for ruflo swarms');
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
    const out = runGroundHook('implement the retry policy for ruflo swarms');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/APPLY THE PLAYBOOK/);
    expect(out.stdout).toMatch(/ground before you assert/);
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
    const out = runGroundHook('implement the retry policy', { env: { RUVNET_BRAIN_METER: '0' } });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/APPLY THE PLAYBOOK/);
    expect(fs.existsSync(path.join(tmp, '.ruvnet-brain'))).toBe(false);
  });

  it('a read-only cwd cannot break the hook: still exit 0, directives still emitted, just no ledger', () => {
    fs.chmodSync(tmp, 0o555);
    const out = runGroundHook('implement the retry policy');
    fs.chmodSync(tmp, 0o755);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/APPLY THE PLAYBOOK/);
    expect(fs.existsSync(ledgerPath())).toBe(false);
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
      env: { ...process.env, KB_DIR: kbEmpty, ...env },
    });
    fs.rmSync(kbEmpty, { recursive: true, force: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('logs {source:"mcp", tool:"search_ruvnet", k, bytes} where bytes = the response text\'s char count', () => {
    const out = callMcp();
    expect(out.status).toBe(0);
    const rpc = JSON.parse(out.stdout.trim().split('\n')[0]);
    const responseText = rpc.result.content[0].text;
    const entry = JSON.parse(readLedgerLines()[0]);
    expect(entry).toMatchObject({ source: 'mcp', tool: 'search_ruvnet', k: 3 });
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
    expect(entry.bytes).toBe(responseText.length);
  }, 60000);

  it('RUVNET_BRAIN_METER=0: the query still answers, nothing is written', () => {
    const out = callMcp({ env: { RUVNET_BRAIN_METER: '0' } });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/no results/);
    expect(fs.existsSync(path.join(tmp, '.ruvnet-brain'))).toBe(false);
  }, 60000);
});

describe('token-report.mjs — aggregates the ledger into per-class count / p50 / p95 / est tokens', () => {
  function runReport(args) {
    const r = spawnSync('node', [REPORT, ...args], { cwd: tmp, encoding: 'utf8', timeout: 15000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('computes nearest-rank p50/p95, per-class token estimates (bytes/4), the session total, and skips malformed lines without dying', () => {
    fs.mkdirSync(path.join(tmp, '.ruvnet-brain'), { recursive: true });
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
    const out = runReport([]); // no --ledger: reads cwd's .ruvnet-brain/token-ledger.jsonl, like a user would
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
