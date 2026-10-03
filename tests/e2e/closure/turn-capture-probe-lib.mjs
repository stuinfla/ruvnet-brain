// turn-capture-probe-lib.mjs — the shared harness of the ADR-0102 turn-capture closure probes (G-001,
// G-002, G-053, G-014). REAL processes only: the plugin's own hook-shim runs `session-snapshot Stop` in an
// isolated HOME, its detached worker runs, and the REAL ruflo writes a REAL store. Nothing is mocked; the
// one stub is G-014's deliberately failing ruflo. Each probe prints one JSON receipt and exits 0 (PASS),
// 1 (FAIL) or 2 (UNKNOWN: a prerequisite such as ruflo is absent — never a pass).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOK_SHIM = path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs');

/** A token-shaped string built at runtime (never a literal in source) and a person name. */
export const plant = () => ({
  token: ['gh', 'p_'].join('') + Array.from({ length: 36 }, (_, i) => 'Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk'[(i * 7 + Date.now()) % 32]).join(''),
  name: `Wilhelmina Strathcarron-${Math.random().toString(36).slice(2, 8)}`,
  phrase: `outcome-nonce-${Math.random().toString(36).slice(2, 10)}`,
});

export const OUTCOME = 'Concluded the closure probe turn: the deployment notes were reconciled with the release checklist '
  + 'and the remaining follow-up was written down in the project tracker for the next working session to pick up.';

export function realRuflo() {
  const candidates = [process.env.RUFLO_BIN, path.join(os.homedir(), '.npm-global', 'bin', 'ruflo')];
  try { candidates.push(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ruflo'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()); } catch { /* not on PATH */ }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

export function sandbox(prefix) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const emptyGit = path.join(root, 'empty-gitconfig');
  fs.writeFileSync(emptyGit, '');
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: emptyGit, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'Probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' };
  return { root, home, gitEnv, brainHome: path.join(home, '.cache', 'ruvnet-brain'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export const git = (cwd, env, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

/** A git repository that adopted a store initialised by the real ruflo (in a scratch cwd, never the repo). */
export function adoptedRepo(box, ruflo, name = 'probe-repo') {
  const dir = path.join(box.root, name);
  fs.mkdirSync(dir);
  git(dir, box.gitEnv, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n');
  git(dir, box.gitEnv, 'add', 'README.md');
  git(dir, box.gitEnv, 'commit', '-q', '-m', 'init');
  initStore(box, ruflo, path.join(dir, '.swarm', 'memory.db'));
  return dir;
}

export function initStore(box, ruflo, db) {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const cwd = fs.mkdtempSync(path.join(box.root, 'init-cwd-'));
  const r = spawnSync(ruflo, ['memory', 'init', '--path', db], { cwd, env: { ...box.gitEnv, RUFLO_DAEMON_AUTOSTART: '0' }, encoding: 'utf8', timeout: 120_000 });
  fs.rmSync(cwd, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`ruflo memory init failed: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
}

/** argv of every process on the machine, one sample (POSIX ps; Windows: wmic is not sampled → []). */
function argvSample() {
  if (process.platform === 'win32') return [];
  const r = spawnSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n') : [];
}

/**
 * The real ruflo behind a recorder: every invocation's full argv is appended to a log, then the real binary
 * runs with the same stdio and its exit code is returned. Deterministic proof of what reached ruflo's argv.
 */
export function recordingRuflo(box, ruflo) {
  const log = path.join(box.root, 'ruflo-argv.jsonl');
  const bin = path.join(box.root, 'ruflo-recorder');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const r = require('node:child_process').spawnSync(${JSON.stringify(ruflo)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  return { bin, argv: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Fire the real hook-shim `session-snapshot Stop` from `cwd` and wait for the detached worker's receipt,
 * sampling every process argv on the machine CONCURRENTLY (the hook and its worker are both running).
 */
export async function fireStop(box, { cwd, ruflo, text, session = `probe-${Date.now()}`, needles = [], env = {}, timeoutMs = 90_000 }) {
  const receipts = path.join(box.brainHome, 'turn-capture', 'receipts.jsonl');
  const read = () => (fs.existsSync(receipts) ? fs.readFileSync(receipts, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const before = read().length;
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: session, cwd, stop_hook_active: false, last_assistant_message: text });
  const hookEnv = { ...box.gitEnv, CLAUDE_PROJECT_DIR: cwd, RUFLO_BIN: ruflo, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_HOOK_HOST: 'claude', ...env };
  delete hookEnv.RUVNET_TURN_CAPTURE; delete hookEnv.RUVNET_RUFLO_CWD_ROOT; delete hookEnv.RUVNET_BRAIN_HOME;
  const leaks = new Set();
  let samples = 0;
  const scan = () => { samples += 1; for (const line of argvSample()) if (needles.some((n) => n && line.includes(n))) leaks.add(line.slice(0, 200)); };
  const child = spawn(process.execPath, [HOOK_SHIM, 'session-snapshot', 'Stop'], { cwd, env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdin.end(payload);
  let status = null;
  exited.then((code) => { status = code; });
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    scan();
    rows = read().slice(before);
    if (status !== null && rows.some((r) => r.kind === 'store')) break;
    await sleep(20);
  }
  await exited;
  scan();
  return { hook: { status, stderr: stderr.slice(0, 500) }, receipts: rows, argvLeaks: [...leaks], argvSamples: samples };
}

/** Every regular file under the given roots whose bytes contain `needle`. */
export function filesContaining(roots, needle) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { if (fs.readFileSync(p).includes(needle)) hits.push(p); } catch { /* unreadable */ } }
    }
  };
  for (const r of roots) walk(r);
  return hits;
}

export function rowsIn(db, namespace = 'turns') {
  if (!fs.existsSync(db)) return [];
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(db, { readOnly: true });
  try { return d.prepare('SELECT key, content FROM memory_entries WHERE namespace=?').all(namespace); } finally { d.close(); }
}

/** Run the checks, print one receipt, exit 0/1/2. */
export async function report(id, fn) {
  const out = { id, at: new Date().toISOString(), platform: process.platform, checks: [] };
  let code = 0;
  try {
    const result = await fn((name, ok, detail) => { out.checks.push({ name, ok: Boolean(ok), detail }); if (!ok) code = 1; });
    if (result?.unknown) { out.unknown = result.unknown; code = 2; }
  } catch (error) { out.error = String(error?.stack || error).slice(0, 800); code = 1; }
  if (!out.checks.length && code === 0) { out.error = 'vacuous: zero assertions executed'; code = 1; }
  out.status = code === 0 ? 'PASS' : code === 2 ? 'UNKNOWN' : 'FAIL';
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(code);
}
