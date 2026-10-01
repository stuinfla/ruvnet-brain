// hook-qualify-core.mjs — the pure + process-boundary parts of the hook qualification harness.
//
// WHY THIS EXISTS. A hook that writes to stderr, exits non-zero, prints a malformed envelope or
// outlives its timeout is surfaced to the user as a "hook error". That is the failure that makes
// people switch the product off, so every registered hook is qualified against the HOST contract,
// not against its own header comment.
//
// NOTHING IS HAND-LISTED. The hooks come from plugin/hooks/hooks.json (Claude Code, and Grok through
// its Claude-compat layer) and plugin/hooks/codex-hooks.json (Codex); the hook's mode from
// hook-shim.mjs's TABLE (plugin/scripts/hook-registry.mjs parses it); the payload shapes from REAL
// captures of each host (tests/fixtures/hook-payloads/<host>/, provenance recorded inside each file).
//
// What the EXISTING tests already prove (hook-registry-lint, hook-contract, hook-hardening,
// hook-battery, hook-shim*, codex-*-parity, codex-lifecycle-hooks) is registry shape, per-hook unit
// behaviour and Codex envelope translation. What they do not do — and this does — is run EVERY
// registered command, exactly as the host would, through the adverse-input matrix with the host's
// own exit/stdout/stderr/timeout contract as the oracle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { shimIdIn, codexDispatchIdIn, shimTable, matchedTools, REPO } from '../plugin/scripts/hook-registry.mjs';

export const HOSTS = ['claude', 'codex', 'grok'];
/** Hosts clamp some events below the registered timeout (Codex prints "clamping SessionEnd hook timeout to 3s"). */
export const HOST_CAP_SEC = { codex: { SessionEnd: 3 }, claude: {}, grok: {} };
/** A hook must finish inside this fraction of its effective timeout on an idle machine. */
export const TIMEOUT_MARGIN = 0.6;

// ── registry ─────────────────────────────────────────────────────────────────────────────────────
export function registrations(root = REPO, hosts = HOSTS) {
  const table = shimTable(root);
  const out = [];
  for (const host of hosts) {
    const file = path.join(root, 'plugin', 'hooks', host === 'codex' ? 'codex-hooks.json' : 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {};
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of groups) for (const h of g.hooks || []) {
        const hookId = host === 'codex' ? codexDispatchIdIn(h.command) : shimIdIn(h.command);
        const tail = (host === 'codex' ? /"\s+\d+\s+\S+\s*(.*)$/ : /hook-shim\.mjs["'`]?\s+\S+\s*(.*?)(?:\s*\|\|\s*true)?\s*$/).exec(h.command)?.[1]?.trim() || '';
        const mode = table[hookId]?.mode || 'unknown';
        const cap = HOST_CAP_SEC[host]?.[event];
        out.push({ host, event, matcher: g.matcher ?? '*', command: h.command, timeoutSec: h.timeout, effectiveSec: cap ? Math.min(h.timeout, cap) : h.timeout,
          hookId, args: tail, mode, body: table[hookId], label: `${host}/${event}/${hookId}${tail ? ` ${tail}` : ''}` });
      }
    }
  }
  return out;
}

// ── fixtures (REAL host captures, tokenised) ─────────────────────────────────────────────────────
const FIXDIR = (root, host) => path.join(root, 'tests', 'fixtures', 'hook-payloads', host);
// MEASURED (grok 1.0.13, tests: scratch probe 4): a registered matcher written with Claude tool names fires on Grok's
// native `write` tool (matchers `Write` and the plugin's ^(Write|...)$ fired; the native spelling ^write$ did NOT), so Grok
// matches against the Claude-name alias while the payload keeps the native name. Only that one pair was measured.
const GROK_ALIAS = { write: 'Write' };
// Grok sends snake_case event names (`pre_tool_use`); the registry speaks Claude's PascalCase.
const pascal = (e) => String(e).split('_').map((x) => x[0].toUpperCase() + x.slice(1)).join('');
const eventOf = (host, p) => (host === 'grok' ? pascal(p.hook_event_name) : p.hook_event_name);
export function fixturesFor(reg, root = REPO) {
  const dir = FIXDIR(root, reg.host);
  const all = fs.readdirSync(dir).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const ofEvent = all.filter((f) => eventOf(reg.host, f.payload) === reg.event);
  if (!/ToolUse$/.test(reg.event) && ofEvent.length) return ofEvent;
  // DERIVED (labelled) fixtures: an event or tool no capture exercised.
  if (reg.event === 'PreCompact') {
    const base = all.find((f) => eventOf(reg.host, f.payload) === 'SessionEnd');
    return base ? [{ name: 'PreCompact-derived', _provenance: 'DERIVED from the captured SessionEnd payload + the documented PreCompact fields (trigger, custom_instructions); the host was not driven to compact', payload: { ...base.payload, hook_event_name: reg.host === 'grok' ? 'pre_compact' : 'PreCompact', trigger: 'manual', custom_instructions: '' } }] : [];
  }
  if (!/ToolUse$/.test(reg.event)) return [];
  const re = new RegExp(reg.matcher);
  const hits = ofEvent.filter((f) => re.test(reg.host === 'grok' ? (GROK_ALIAS[f.payload.tool_name] || f.payload.tool_name) : f.payload.tool_name));
  if (hits.length) return hits;
  const probe = 'mcp__ruvnet_brain__search_ruvnet';
  if (re.test(probe) && ofEvent[0]) {
    const p = { ...ofEvent[0].payload, tool_name: probe, tool_input: { query: 'what is ruflo' } };
    if (reg.event === 'PostToolUse') p.tool_response = { content: [{ type: 'text', text: 'Searched 1 RuvNet repos (ruflo).\n#1  repo=ruflo\npath : ruflo/docs/x.md' }] };
    return [{ name: `${reg.event}-derived-search_ruvnet`, _provenance: 'DERIVED from the captured shape of the same host/event; matcher selects a tool no capture exercised', payload: p }];
  }
  return [];
}

// ── world: an isolated HOME + cwd + TMPDIR, and (for Codex) an installed wrapper + active generation ─
export function makeWorld(host, { root = REPO, label = 'qual' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hq-${label}-`)));
  const w = { dir, home: path.join(dir, 'home'), cwd: path.join(dir, 'cwd'), tmp: path.join(dir, 'tmp'), host, root, n: 0 };
  for (const d of [w.home, w.cwd, w.tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: w.cwd, env: { ...process.env, HOME: w.home } });
  const brain = path.join(w.home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(path.join(brain, 'versions'), { recursive: true });
  fs.cpSync(path.join(root, 'plugin'), path.join(brain, 'versions', 'qual'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ generation: 'qual', version: 'qual', codeRoot: 'versions/qual' }));
  if (host === 'codex') {
    fs.copyFileSync(path.join(root, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'), path.join(brain, 'codex-hook.mjs'));
    fs.copyFileSync(path.join(root, 'plugin', 'scripts', 'development-maintenance.mjs'), path.join(brain, 'development-maintenance.mjs'));
  }
  return w;
}
export function worldEnv(w, extra = {}) {
  const env = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER']) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || '/usr/bin:/bin'}`;
  Object.assign(env, { HOME: w.home, USERPROFILE: w.home, TMPDIR: w.tmp, CLAUDE_PROJECT_DIR: w.cwd, RUVNET_BRAIN_HOME: path.join(w.home, '.cache', 'ruvnet-brain') });
  if (w.host === 'codex') env.CODEX_HOME = path.join(w.home, '.codex');
  else env.CLAUDE_PLUGIN_ROOT = path.join(w.root, 'plugin');
  if (w.host === 'grok') env.GROK_PLUGIN_ROOT = path.join(w.root, 'plugin');
  return Object.assign(env, extra);
}
export function cleanupWorld(w) {
  try { spawnSync('chmod', ['-R', 'u+rwX', w.dir]); fs.rmSync(w.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
function realise(fix, w) {
  const sid = `qual-${process.pid}-${++w.n}`;
  const transcript = path.join(w.home, '.claude', 'projects', 'p', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const s = JSON.stringify(fix.payload).split('{{TRANSCRIPT_DIR}}').join(transcript.replace(/\.jsonl$/, '')).split('{{TRANSCRIPT}}').join(transcript)
    .split('{{ROOT}}').join(w.cwd).split('{{CWD}}').join(w.cwd).split('{{SESSION_ID}}').join(sid).split('{{PROMPT_ID}}').join('p1').split('{{TURN_ID}}').join('t1')
    .split('{{TOOL_USE_ID}}').join('toolu_1').split('{{HOME}}').join(w.home);
  const p = JSON.parse(s);
  if (p.transcript_path === null) p.transcript_path = null;
  return p;
}

// ── the contract (the ORACLE) ────────────────────────────────────────────────────────────────────
const CLAUDE_TOP = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput']);
const CLAUDE_SPECIFIC = {
  SessionStart: ['additionalContext', 'initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'],
  UserPromptSubmit: ['additionalContext', 'sessionTitle'],
  PreToolUse: ['permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'],
  PostToolUse: ['additionalContext', 'updatedToolOutput', 'updatedMCPToolOutput'],
  Stop: ['additionalContext'], PreCompact: [], SessionEnd: [],
};
// Codex: read out of the host binary's own `<event>.command.output` schemas (codex-hook-adapter.mjs header).
const CODEX_SPECIFIC = { SessionStart: ['additionalContext'], UserPromptSubmit: ['additionalContext'], PreToolUse: ['permissionDecision', 'permissionDecisionReason', 'additionalContext'],
  PostToolUse: ['additionalContext', 'updatedToolOutput', 'updatedMCPToolOutput'] };
const CODEX_TOP = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'terminalSequence', 'decision', 'reason', 'hookSpecificOutput']);

/** Returns a list of contract violations for one stdout on one (host, event). Pure. */
export function checkStdout(host, event, stdout, { eventNameChecked = true } = {}) {
  const errs = [];
  const text = stdout.toString('utf8');
  if (!text.trim()) return errs;
  if (/\u0000/.test(text)) errs.push('stdout contains a NUL byte');
  const codex = host === 'codex';
  if (event === 'SessionEnd' || (codex && event === 'PreCompact')) return [`${event} must write nothing to stdout (host discards or rejects it), wrote ${stdout.length} bytes`];
  // `[RuvNet Brain — ...]` banners are plain text, so only `{` (or a `[` that really parses) is JSON.
  const looksJson = /^\s*\{/.test(text) || (/^\s*\[/.test(text) && (() => { try { JSON.parse(text); return true; } catch { return false; } })());
  if (!looksJson) {
    if (!codex && (event === 'SessionStart' || event === 'UserPromptSubmit')) return errs;   // plain text is added as context
    return [`stdout is plain text on ${host}/${event}, where the host requires a JSON envelope: ${JSON.stringify(text.slice(0, 60))}`];
  }
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return [`stdout is not ONE valid JSON value (${e.message.slice(0, 60)})`]; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['stdout JSON is not an object'];
  const top = codex ? CODEX_TOP : CLAUDE_TOP;
  for (const k of Object.keys(obj)) if (!top.has(k)) errs.push(`unknown top-level field "${k}" for ${host}`);
  if (obj.decision !== undefined) {
    if (obj.decision !== 'block' && !(host !== 'codex' && obj.decision === 'approve')) errs.push(`decision "${obj.decision}" is not accepted on ${host}`);
    if (obj.decision === 'block' && !(typeof obj.reason === 'string' && obj.reason.trim())) errs.push('decision:block without a non-empty reason');
  }
  if (codex && event === 'Stop' && Object.keys(obj).some((k) => k !== 'decision' && k !== 'reason' && k !== 'continue' && k !== 'stopReason' && k !== 'systemMessage' && k !== 'suppressOutput')) errs.push('Codex Stop has no hookSpecificOutput');
  if (obj.hookSpecificOutput !== undefined) {
    const hs = obj.hookSpecificOutput;
    const allowed = (codex ? CODEX_SPECIFIC : CLAUDE_SPECIFIC)[event];
    if (!hs || typeof hs !== 'object' || Array.isArray(hs)) errs.push('hookSpecificOutput is not an object');
    else {
      if (!allowed) errs.push(`${event} has no hookSpecificOutput on ${host}`);
      if (eventNameChecked && hs.hookEventName !== event) errs.push(`hookSpecificOutput.hookEventName ${JSON.stringify(hs.hookEventName)} != ${event}`);
      for (const k of Object.keys(hs)) if (k !== 'hookEventName' && !(allowed || []).includes(k)) errs.push(`unknown hookSpecificOutput field "${k}" for ${host}/${event}`);
      if (codex && hs.permissionDecision !== undefined && hs.permissionDecision !== 'deny') errs.push(`Codex accepts only permissionDecision:"deny", got "${hs.permissionDecision}"`);
      if (hs.additionalContext !== undefined && typeof hs.additionalContext !== 'string') errs.push('additionalContext is not a string');
    }
  }
  return errs;
}

/** All contract violations for one run. Pure — this is what the guard proofs break. */
export function judge(reg, caseName, r, { maxMs = null, mayBlock = false } = {}) {
  const f = [];
  const allowed = new Set([0]);
  if (reg.mode === 'blocking' && mayBlock) allowed.add(2);
  if (r.timedOut) f.push(`TIMEOUT: still running after ${r.ms}ms (registered ${reg.timeoutSec}s, effective ${reg.effectiveSec}s)`);
  else if (r.signal) f.push(`killed by ${r.signal}`);
  else if (!allowed.has(r.status)) f.push(`exit ${r.status} (allowed: ${[...allowed].join(',')}; a non-zero exit is shown to the user as a hook error)`);
  if (r.stderr.length) f.push(`stderr not empty (${r.stderr.length} bytes): ${JSON.stringify(r.stderr.toString('utf8').slice(0, 120))}`);
  if (!r.timedOut) f.push(...checkStdout(reg.host, reg.event, r.stdout, { eventNameChecked: caseName !== 'wrong-event-name' }));
  const budget = maxMs ?? reg.effectiveSec * 1000 * TIMEOUT_MARGIN;
  if (!r.timedOut && r.ms > budget) f.push(`SLOW: ${r.ms}ms > ${Math.round(budget)}ms (${TIMEOUT_MARGIN * 100}% of the ${reg.effectiveSec}s effective timeout)`);
  return f;
}

/** Static contract checks that need no process. */
export function staticFindings(regs) {
  const f = [];
  for (const r of regs) {
    const cap = HOST_CAP_SEC[r.host]?.[r.event];
    if (cap && r.timeoutSec > cap) f.push({ reg: r, msg: `registers timeout ${r.timeoutSec}s but ${r.host} clamps ${r.event} to ${cap}s and prints a warning on every session ("clamping ${r.event} hook timeout to ${cap}s")` });
    if (r.host === 'codex') {
      const inline = Number(/"\s+(\d+)\s+/.exec(r.command)?.[1]);
      if (inline && inline >= r.effectiveSec * 1000) f.push({ reg: r, msg: `inline budget ${inline}ms is not inside the ${r.effectiveSec}s effective host timeout` });
    }
    if (r.mode === 'unknown') f.push({ reg: r, msg: `hook id "${r.hookId}" is not in hook-shim.mjs's TABLE` });
  }
  return f;
}

// ── process runner ───────────────────────────────────────────────────────────────────────────────
const sandboxOk = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
export const sandboxAvailable = () => sandboxOk;
export const NET_DENY = '(version 1)(allow default)(deny network*)';
export const writeProfile = (dir) => `(version 1)(allow default)(deny file-write* (require-all (require-not (subpath "${dir}")) (require-not (subpath "/dev"))) (with send-signal SIGKILL))`;

/** Run one command string through /bin/sh as a host would. */
export function runCommand(command, { cwd, env, stdin = '', stdinMode = 'pipe', timeoutMs, profile = null, argv = null }) {
  return new Promise((resolve) => {
    const [cmd, args] = profile ? ['/usr/bin/sandbox-exec', ['-p', profile, ...(argv || ['/bin/sh', '-c', command])]] : (argv ? [argv[0], argv.slice(1)] : ['/bin/sh', ['-c', command]]);
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: [stdinMode === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    const out = []; const err = []; let bytes = 0; let timedOut = false;
    child.stdout.on('data', (d) => { if (bytes < 16e6) { out.push(d); bytes += d.length; } });
    child.stderr.on('data', (d) => { if (bytes < 16e6) { err.push(d); bytes += d.length; } });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (stdinMode === 'held') child.stdin.write(stdin);          // one complete value, pipe left open
      else child.stdin.end(stdin);
    }
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      resolve({ status, signal: timedOut ? null : signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), ms: Date.now() - t0, timedOut });
    });
  });
}

const json = (o) => JSON.stringify(o);
const promptKey = (p) => ('prompt' in p ? 'prompt' : null);
function deadPid() { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']); return Number(r.stdout.toString()); }
function makeReadOnly(dir) {
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else fs.chmodSync(p, 0o444); } fs.chmodSync(d, 0o555); };
  walk(dir);
}

/** The adverse-input matrix. `stdin(payload)` -> string|Buffer. */
export const CASES = [
  { name: 'baseline-real', stdin: (p) => json(p) },
  { name: 'empty-stdin', stdin: () => '' },
  { name: 'closed-stdin', stdinMode: 'closed' },
  { name: 'held-open-stdin', stdinMode: 'held', stdin: (p) => json(p) },
  { name: 'malformed-json', stdin: () => '{"hook_event_name": nope, "prompt": ' },
  { name: 'truncated-json', stdin: (p) => json(p).slice(0, Math.floor(json(p).length / 2)) },
  { name: '5mb-payload', stdin: (p) => json({ ...p, ...(promptKey(p) ? { prompt: `${p.prompt} ${'x'.repeat(5 * 1024 * 1024)}` } : { padding: 'x'.repeat(5 * 1024 * 1024) }) }) },
  { name: 'unicode-emoji', stdin: (p) => json({ ...p, ...(promptKey(p) ? { prompt: 'héllo 🚀 你好 ñ — ruflo agentdb ‮' } : { last_assistant_message: 'héllo 🚀 你好' }) }) },
  { name: 'nul-bytes', stdin: (p) => Buffer.concat([Buffer.from(json({ ...p, ...(promptKey(p) ? { prompt: 'a\u0000b ruflo' } : {}) })), Buffer.from([0]), Buffer.from('\n')]) },
  { name: 'missing-fields', stdin: () => '{}' },
  { name: 'only-event-name', stdin: (p) => json({ hook_event_name: p.hook_event_name }) },
  { name: 'wrong-types', stdin: (p) => json({ ...p, session_id: 123, prompt: null, cwd: {}, tool_input: 'x', transcript_path: 5, last_assistant_message: [] }) },
  { name: 'wrong-event-name', stdin: (p) => json({ ...p, hook_event_name: p.hook_event_name === 'Stop' ? 'SessionStart' : 'Stop' }) },
  { name: 'home-unset', stdin: (p) => json(p), env: (e) => { delete e.HOME; delete e.USERPROFILE; } },
  { name: 'home-readonly', stdin: (p) => json(p), pre: (w) => makeReadOnly(w.home) },
  { name: 'no-network', stdin: (p) => json(p), profile: NET_DENY, env: (e) => { e.HTTP_PROXY = e.HTTPS_PROXY = 'http://127.0.0.1:9'; e.NO_PROXY = ''; } },
  { name: 'dead-pid-lock', stdin: (p) => json(p), pre: (w) => {
    const pid = deadPid(); const brain = path.join(w.home, '.cache', 'ruvnet-brain'); const at = new Date().toISOString();
    fs.mkdirSync(brain, { recursive: true });
    fs.writeFileSync(path.join(brain, 'auto-update.lock'), JSON.stringify({ pid, at }) + '\n');
    fs.mkdirSync(path.join(brain, '.update.lock'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.update.lock', 'owner.json'), JSON.stringify({ pid, at }));
    fs.writeFileSync(path.join(w.cwd, '.cooldown'), at);
  } },
];

/** Run one (registration, fixture, case). World is fresh per call unless one is supplied. */
export async function runCase(reg, fix, c, { root = REPO, world = null, timeoutMs = null, maxMs = null } = {}) {
  const w = world || makeWorld(reg.host, { root, label: c.name });
  try {
    const payload = realise(fix, w);
    c.pre?.(w);
    const env = worldEnv(w); c.env?.(env);
    const stdin = c.stdin ? c.stdin(payload) : '';
    const r = await runCommand(reg.command, { cwd: w.cwd, env, stdin, stdinMode: c.stdinMode || 'pipe', timeoutMs: timeoutMs ?? (reg.effectiveSec * 1000 + 4000),
      profile: c.profile && sandboxOk ? c.profile : null });
    return { reg, fixture: fix.name, case: c.name, skipped: c.profile && !sandboxOk ? 'sandbox-exec unavailable' : null, ...r, findings: judge(reg, c.name, r, { maxMs }) };
  } finally { if (!world) cleanupWorld(w); }
}

/** 20 concurrent invocations of the same hook in one world. */
export async function runConcurrent(reg, fix, n = 20, opts = {}) {
  const w = makeWorld(reg.host, { root: opts.root || REPO, label: 'conc' });
  try {
    const rs = await Promise.all(Array.from({ length: n }, () => runCase(reg, fix, { name: 'concurrent', stdin: (p) => json(p) }, { ...opts, world: w, timeoutMs: reg.effectiveSec * 1000 * 4 })));
    // Concurrency is a LOAD test: the slow-path budget is checked against the registered timeout, not the idle margin.
    for (const r of rs) r.findings = judge(reg, 'concurrent', r, { maxMs: reg.effectiveSec * 1000 });
    return rs;
  } finally { cleanupWorld(w); }
}

/** N sequential invocations; returns per-call ms and the on-disk growth of HOME. */
export async function runRepeat(reg, fix, n = 50, opts = {}) {
  const w = makeWorld(reg.host, { root: opts.root || REPO, label: 'repeat' });
  const size = () => { let files = 0; let bytes = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { bytes += fs.statSync(p).size; files++; } catch { /* raced */ } } } }; walk(w.home); return { files, bytes }; };
  try {
    const before = size(); const rs = [];
    for (let i = 0; i < n; i++) rs.push(await runCase(reg, fix, { name: 'repeat', stdin: (p) => json(p) }, { ...opts, world: w }));
    const after = size();
    return { runs: rs, growth: { files: after.files - before.files, bytes: after.bytes - before.bytes }, firstMs: rs[0].ms, lastMs: rs.at(-1).ms };
  } finally { cleanupWorld(w); }
}

/** Run the hook BODY directly under a write-containment sandbox; a write outside the world kills it. */
export async function auditWrites(reg, fix, { root = REPO } = {}) {
  if (!sandboxOk) return { skipped: 'sandbox-exec unavailable on this platform' };
  if (!reg.body?.file) return { skipped: 'no body in hook-shim TABLE' };
  const w = makeWorld(reg.host, { root, label: 'wr' });
  try {
    const payload = realise(fix, w);
    const env = worldEnv(w); if (reg.host === 'codex') env.RUVNET_HOOK_HOST = 'codex';
    const file = path.join(root, 'plugin', 'scripts', reg.body.file);
    const interp = reg.body.interpreter === 'node' ? process.execPath : '/bin/bash';
    const extra = reg.args ? reg.args.split(/\s+/) : [];
    const r = await runCommand('', { cwd: w.cwd, env, stdin: json(payload), timeoutMs: reg.effectiveSec * 1000 + 4000, profile: writeProfile(w.dir), argv: [interp, file, ...extra] });
    return { violated: r.signal === 'SIGKILL', status: r.status, signal: r.signal, ms: r.ms };
  } finally { cleanupWorld(w); }
}

// ── overload measurement ─────────────────────────────────────────────────────────────────────────
export const PROMPTS = ['ok', 'what is ruflo?', 'build a REST API service with agentdb memory', 'Fix the failing test in src/foo.test.ts',
  'can ruflo do swarm consensus? check the architecture and plan the refactor'];
/** Bytes every SessionStart + UserPromptSubmit hook injects, per prompt, for one host. */
export async function measureInjection(host, { root = REPO } = {}) {
  const regs = registrations(root, [host]).filter((r) => r.event === 'SessionStart' || r.event === 'UserPromptSubmit');
  const rows = [];
  for (const prompt of PROMPTS) {
    const per = [];
    for (const reg of regs) {
      if (reg.event === 'SessionStart' && prompt !== PROMPTS[0]) continue;
      const fix = fixturesFor(reg, root)[0];
      const fx = reg.event === 'UserPromptSubmit' ? { ...fix, payload: { ...fix.payload, prompt } } : fix;
      const r = await runCase(reg, fx, { name: 'measure', stdin: (p) => json(p) }, { root });
      per.push({ hook: reg.label, bytes: r.stdout.length, ms: r.ms });
    }
    rows.push({ prompt, perHook: per, totalBytes: per.reduce((a, b) => a + b.bytes, 0) });
  }
  return rows;
}
export { matchedTools };
