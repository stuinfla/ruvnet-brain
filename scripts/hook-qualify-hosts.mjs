// hook-qualify-hosts.mjs — LAYER 2: one short REAL turn per host binary, plugin hooks live, scanned for
// any hook error. Never loops; cwd is a throwaway git-init'ed temp dir so no real project state is
// touched. The host binaries use the owner's real HOME (auth lives there), so host-level state such as
// ~/.cache/ruvnet-brain is exercised exactly as in use — that is the point of the layer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from '../plugin/scripts/hook-registry.mjs';

const BIN = {
  claude: process.env.HOOK_QUALIFY_CLAUDE || path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  codex: process.env.HOOK_QUALIFY_CODEX || path.join(os.homedir(), '.local', 'bin', 'codex'),
  grok: process.env.HOOK_QUALIFY_GROK || path.join(os.homedir(), '.local', 'bin', 'grok'),
};
const PROMPT = 'Reply with exactly: ok';

export async function waitForLoad(maxLoad, waitMs, log = () => {}) {
  const until = Date.now() + waitMs;
  while (os.loadavg()[0] >= maxLoad) {
    if (Date.now() > until) return false;
    log(`load ${os.loadavg()[0].toFixed(0)} >= ${maxLoad}; waiting`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return true;
}
function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hq-l2-${name}-`));
  const cwd = path.join(dir, 'cwd'); fs.mkdirSync(cwd);
  spawnSync('git', ['init', '-q', '.'], { cwd });
  return { dir, cwd };
}
const cleanEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$/.test(k) && k !== 'CLAUDE_CODE_EXECPATH') delete e[k]; return e; };
const lines = (s) => String(s || '').split('\n').filter(Boolean);
const jsonl = (s) => lines(s).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/** Pure: scan a real `claude -p --output-format stream-json --verbose --include-hook-events` run. */
export function scanClaude({ stdout, stderr, debug = '' }) {
  const f = []; const ev = jsonl(stdout);
  for (const o of ev) {
    if (o.type !== 'system' || o.subtype !== 'hook_response') continue;
    const who = `${o.hook_event}:${o.hook_name}`;
    if (o.exit_code !== 0) f.push(`${who} exit ${o.exit_code} (${o.outcome})`);
    else if (o.outcome && o.outcome !== 'success') f.push(`${who} outcome ${o.outcome}`);
    if (o.stderr) f.push(`${who} wrote stderr: ${JSON.stringify(String(o.stderr).slice(0, 120))}`);
    if (/^\s*\{/.test(o.stdout || '')) { try { JSON.parse(o.stdout); } catch { f.push(`${who} stdout is not valid JSON`); } }
  }
  if (stderr.trim()) f.push(`process stderr: ${JSON.stringify(stderr.trim().slice(0, 300))}`);
  for (const l of lines(debug)) if (/\] (?:Hook|SessionEnd|SessionStart|PreToolUse|PostToolUse|Stop|UserPromptSubmit)\b.*(?:timed out|cancelled|failed|invalid)/i.test(l)) f.push(`debug: ${l.replace(/^\S+ \[DEBUG\] /, '').slice(0, 220)}`);
  return { findings: [...new Set(f)], hookResponses: ev.filter((o) => o.subtype === 'hook_response').length };
}
/** Pure: scan a real `codex exec --json` run. */
export function scanCodex({ stdout, stderr }) {
  const f = [];
  for (const o of jsonl(stdout)) {
    if (o.item?.type === 'error' || o.type === 'error') { const m = o.item?.message || o.message || ''; if (/hook|clamp/i.test(m)) f.push(`host reports: ${m.slice(0, 200)}`); }
  }
  for (const l of lines(stderr)) if (/hook/i.test(l)) f.push(`stderr: ${l.slice(0, 200)}`);
  return { findings: [...new Set(f)], unrelatedStderr: lines(stderr).filter((l) => !/hook/i.test(l)).slice(0, 3) };
}
/** Pure: scan a real `grok -p --debug-file` run. */
export function scanGrok({ stdout, stderr, debug = '' }) {
  const f = []; let loaded = null; const pluginHooks = /plugin discovered name=ruvnet-brain .*has_hooks=true/.test(debug);
  for (const l of lines(debug)) {
    const m = /loaded hooks hook_count=(\d+)/.exec(l); if (m) loaded = Number(m[1]);
    if (/xai_grok_hooks/.test(l) && /\b(WARN|ERROR)\b/.test(l)) f.push(`grok hooks: ${l.replace(/^\S+\s+/, '').slice(0, 240)}`);
    if (/hook (failed|timed out|error)|hook_error|hook.*(exit code|invalid)/i.test(l) && /xai_grok_hooks|dispatcher/.test(l)) f.push(`grok hooks: ${l.replace(/^\S+\s+/, '').slice(0, 240)}`);
  }
  if (stderr.trim()) f.push(`process stderr: ${JSON.stringify(stderr.trim().slice(0, 300))}`);
  if (/hook/i.test(stdout) && /(error|failed)/i.test(stdout.match(/.{0,80}hook.{0,120}/i)?.[0] || '')) f.push('hook error text in the output stream');
  return { findings: [...new Set(f)], hooksLoaded: loaded, pluginHasHooks: pluginHooks, pluginHooksRan: /hook_name=plugin|hook_name=ruvnet/.test(debug) };
}

async function runClaude(root, dbgDir) {
  const { dir, cwd } = scratch('claude'); const debugFile = path.join(dbgDir, 'claude-debug.log');
  const r = spawnSync(BIN.claude, ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence',
    '--setting-sources', 'project', '--plugin-dir', path.join(root, 'plugin'), '--debug-file', debugFile, '--max-turns', '2'],
  { cwd, env: cleanEnv(), encoding: 'utf8', timeout: 240_000, maxBuffer: 64e6 });
  const debug = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, 'utf8') : '';
  const s = scanClaude({ stdout: r.stdout || '', stderr: r.stderr || '', debug });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status === 0 && !s.findings.length ? 'PASS' : 'FAIL', exit: r.status, ...s, note: 'plugin loaded from this checkout via --plugin-dir; user/local settings not loaded' };
}
async function runCodex(root, dbgDir) {
  const { dir, cwd } = scratch('codex');
  const r = spawnSync(BIN.codex, ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', cwd, PROMPT], { cwd, env: process.env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64e6 });
  fs.writeFileSync(path.join(dbgDir, 'codex-out.jsonl'), r.stdout || '');
  const s = scanCodex({ stdout: r.stdout || '', stderr: r.stderr || '' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status === 0 && !s.findings.length ? 'PASS' : 'FAIL', exit: r.status, ...s, note: 'runs the hooks INSTALLED in ~/.codex (the owner\'s real configuration), not this checkout' };
}
async function runGrok(root, dbgDir) {
  const { dir, cwd } = scratch('grok'); const debugFile = path.join(dbgDir, 'grok-debug.log');
  const r = spawnSync(BIN.grok, ['-p', PROMPT, '--output-format', 'streaming-json', '--debug-file', debugFile, '--always-approve', '--max-turns', '2', '--cwd', cwd],
    { cwd, env: process.env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64e6 });
  const blob = `${r.stdout || ''}${r.stderr || ''}`;
  if (/not signed in|grok login/i.test(blob)) { fs.rmSync(dir, { recursive: true, force: true }); return { status: 'BLOCKED', reason: 'Grok is not signed in (owner action: grok login --device-code)' }; }
  const debug = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, 'utf8') : '';
  const s = scanGrok({ stdout: r.stdout || '', stderr: r.stderr || '', debug });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status === 0 && !s.findings.length ? 'PASS' : 'FAIL', exit: r.status, ...s, note: 'throwaway cwd is untrusted by Grok, so project/plugin hook loading there is part of what is measured' };
}

export async function layer2(hosts, { maxLoad = 40, waitMs = 15 * 60_000, log = () => {}, root = REPO } = {}) {
  const dbgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-l2-logs-'));
  const out = [];
  for (const host of hosts) {
    if (!(await waitForLoad(maxLoad, waitMs, log))) { out.push({ host, status: 'BLOCKED', reason: `machine load stayed >= ${maxLoad}` }); continue; }
    if (!fs.existsSync(BIN[host])) { out.push({ host, status: 'BLOCKED', reason: `${BIN[host]} not found` }); continue; }
    const fn = { claude: runClaude, codex: runCodex, grok: runGrok }[host];
    const t0 = Date.now();
    out.push({ host, ...(await fn(root, dbgDir)), ms: Date.now() - t0, logs: dbgDir });
  }
  return out;
}
