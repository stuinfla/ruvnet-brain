// scripts/issue-autofix-agents.mjs — how the daily autofix job (ADR-107) spawns `claude -p`.
//
// Four LLM stages (plan / build / verify / note) with no git, gh or network access: the orchestrator does every
// push and API call itself. This module only decides WHAT is spawned (exact argv, tool allowlist, model alias,
// stripped environment, wall clock) and PROVES what answered (the model named in the result, not the one we asked
// for). It never asks the CLI to bypass permissions: least-privilege --allowedTools instead.
//
// Verified live against claude 2.1.312 (2026-10-29): --max-turns (undocumented in --help but accepted),
// --json-schema with --output-format json returns the object in `structured_output` and the models that served the
// call as the keys of `modelUsage`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AutofixAbort } from './issue-autofix-policy.mjs';

// NO stage can run a command: Bash is absent from every tool list, and --restricted removes every code-running tool
// that --tools does not name. Code a model wrote runs only in the orchestrator, under the macOS sandbox
// (issue-autofix-sandbox.mjs), after the static security scan. The note and red-team stages get no tools at all and
// run in an empty temporary directory: they see only what the prompt hands them.
export const STAGE_CONFIG = Object.freeze({
  plan:    { model: 'opus',   maxTurns: 40, timeoutMs: 20 * 60_000, tools: ['Read', 'Glob', 'Grep'], schema: 'config/issue-autofix/plan.schema.json', family: /opus/ },
  build:   { model: 'sonnet', maxTurns: 80, timeoutMs: 45 * 60_000, tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], schema: null, family: /sonnet|opus/ },
  verify:  { model: 'opus',   maxTurns: 60, timeoutMs: 30 * 60_000, tools: ['Read', 'Glob', 'Grep'], schema: 'config/issue-autofix/verify.schema.json', family: /opus/ },
  redteam: { model: 'opus',   maxTurns: 4,  timeoutMs: 15 * 60_000, tools: [], schema: 'config/issue-autofix/redteam.schema.json', family: /opus/ },
  note:    { model: 'opus',   maxTurns: 4,  timeoutMs: 5 * 60_000,  tools: [], schema: 'config/issue-autofix/note.schema.json', family: /opus/ },
});
export const GRACE_MS = 20_000;
const MAX_STDOUT = 32 * 1024 * 1024;
const NO_MCP = 'config/issue-autofix/no-mcp.json';

// BILLING SAFETY (issue-fix.mjs): an ambient API key either fails the run (stale key) or bills it. The git/gh
// credentials go too, so an LLM stage that somehow got a shell still cannot push or comment.
export const STRIPPED_ENV = [/^ANTHROPIC_/, /^CLAUDE_API_KEY$/, /^CLAUDE_CODE_USE_/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^GH_ENTERPRISE_TOKEN$/, /^SSH_AUTH_SOCK$/];

// SUBSCRIPTION LOGIN UNDER LAUNCHD (measured 2026-10-30). Under launchd the login keychain is readable, and the
// "Claude Code-credentials" item there was an EXPIRED OAuth session that could not refresh: `claude auth status`
// said loggedIn false. Claude Code's file login (~/.claude/.credentials.json), which the owner's own sessions keep
// fresh, is the one that works; claude uses it when the keychain cannot be reached. So on macOS every stage runs
// with keychain lookups denied: measured under a test LaunchAgent, loggedIn true (max) and served by opus. It also
// means no stage can read any other keychain item. No API key is ever used (BILLING SAFETY above).
export const KEYCHAIN_DENY_PROFILE = '(version 1)(allow default)(deny mach-lookup (global-name "com.apple.SecurityServer") '
  + '(global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.secd"))';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** [command, args] that start claude without keychain access on macOS (the real spawn only; an injected spawn is not wrapped). */
export function claudeCommand(claudeBin, args, { platform = process.platform, exists = fs.existsSync } = {}) {
  return platform === 'darwin' && exists(SANDBOX_EXEC) ? [SANDBOX_EXEC, ['-p', KEYCHAIN_DENY_PROFILE, claudeBin, ...args]] : [claudeBin, args];
}

export function sanitizedEnv(baseEnv, { ghConfigDir }) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (STRIPPED_ENV.some((re) => re.test(k)) || /^GIT_CONFIG_/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, GH_CONFIG_DIR: ghConfigDir, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };
}

const stageOf = (stage) => { const c = STAGE_CONFIG[stage]; if (!c) throw new Error(`unknown stage: ${stage}`); return c; };

export function buildClaudeArgs(stage, prompt, { root }) {
  const c = stageOf(stage);
  const schema = c.schema ? ['--json-schema', JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, c.schema), 'utf8')))] : [];
  // --restricted: no code-running tool, user/project/local settings ignored (so a hook or permission the build stage
  //   writes into the worktree never loads), file tools confined to the cwd, writes to settings/git files refused.
  // --safe-mode: no CLAUDE.md, skills, plugins, hooks or MCP from anywhere. Both measured live on claude 2.1.314
  //   (2026-10-30): planted .claude/settings.json hook and CLAUDE.md inert; reads/writes outside the cwd refused.
  // --permission-prompts none: anything that would ask is denied. Subscription OAuth still works (no API key used).
  const tools = c.tools.length ? c.tools.join(',') : '';
  const allow = c.tools.length ? ['--allowedTools', ...c.tools] : [];
  return ['-p', prompt, '--model', c.model, '--max-turns', String(c.maxTurns), '--output-format', 'json', ...schema,
    '--restricted', '--safe-mode', '--tools', tools, ...allow, '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Task',
    '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', path.join(root, NO_MCP),
    '--no-session-persistence', '--max-budget-usd', '5'];
}

export { buildPrompt } from './issue-autofix-prompts.mjs';
import { buildPrompt } from './issue-autofix-prompts.mjs';

// ── minimal JSON-schema check (type/enum/const/required/additionalProperties/items/min/max). The claude CLI
//    validates too; this keeps a hallucinated shape from ever reaching the policy code. ──
function check(schema, v, at, errs) {
  if ('const' in schema && v !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: not one of ${schema.enum.join('|')}`);
  const t = schema.type;
  const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
  if (t && !(t === actual || (t === 'number' && actual === 'integer'))) { errs.push(`${at}: expected ${t}, got ${actual}`); return; }
  if (t === 'string') {
    if (schema.maxLength != null && v.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (t === 'integer' && schema.minimum != null && v < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
  if (t === 'array') {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, `${at}[${i}]`, errs));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${at}.${k}: missing`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties?.[k]) check(schema.properties[k], x, `${at}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
    }
  }
}

// The model that served the call: the key of `modelUsage` that cost the most (helper calls to a smaller model do
// not count), else the `model` field.
function resolveModel(out) {
  const usage = out?.modelUsage && typeof out.modelUsage === 'object' ? Object.entries(out.modelUsage) : [];
  if (usage.length) return usage.sort((a, b) => (Number(b[1]?.costUSD) || 0) - (Number(a[1]?.costUSD) || 0))[0][0];
  return typeof out?.model === 'string' && out.model ? out.model : null;
}

export function assertModelFamily(stage, resolvedModel) {
  const c = stageOf(stage);
  if (!resolvedModel || !c.family.test(resolvedModel)) {
    throw new AutofixAbort(stage, 'model-downgrade', `asked for ${c.model}; ${resolvedModel ? `served by ${resolvedModel}` : 'the result names no model'}`);
  }
}

export async function runAgent({ stage, cwd, input, claudeBin, logPath, root, ghConfigDir, timeoutMs, graceMs, spawnImpl = spawn }) {
  const c = stageOf(stage);
  const limit = timeoutMs ?? STAGE_CONFIG[stage].timeoutMs;
  const grace = graceMs ?? GRACE_MS;
  const t0 = Date.now();
  const ownDir = ghConfigDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-gh-'));
  const finish = (r) => ({ ok: false, stage, exitCode: null, signal: null, timedOut: false, resolvedModel: null, result: null, error: null, logPath, ...r, durationMs: Date.now() - t0 });
  try {
    // Behind sandbox-exec a missing binary would only show as an exit code: say what is wrong plainly.
    if (path.isAbsolute(claudeBin) && !fs.existsSync(claudeBin)) return finish({ error: `spawn failed: ENOENT ${claudeBin}` });
    const args = buildClaudeArgs(stage, buildPrompt(stage, input), { root });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `===== autofix ${stage} — started ${new Date().toISOString()} (model ${c.model}, max-turns ${c.maxTurns}, timeout ${limit}ms) =====\n`);
    const env = sanitizedEnv(process.env, { ghConfigDir: ghConfigDir || ownDir });
    const res = await new Promise((resolve) => {
      let stdout = ''; let timedOut = false; let killTimer; let graceTimer; let child;
      const [cmd, argv] = spawnImpl === spawn ? claudeCommand(claudeBin, args) : [claudeBin, args];
      try { child = spawnImpl(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ spawnError: e }); return; }
      child.on('error', (e) => { clearTimeout(killTimer); clearTimeout(graceTimer); resolve({ spawnError: e }); });
      child.stdout.on('data', (d) => { if (stdout.length < MAX_STDOUT) stdout += d; fs.writeSync(logFd, d); });
      child.stderr.on('data', (d) => fs.writeSync(logFd, d));
      killTimer = setTimeout(() => {
        timedOut = true;
        fs.writeSync(logFd, `\n===== WALL-CLOCK TIMEOUT (${limit}ms) — SIGTERM =====\n`);
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, grace);
      }, limit);
      child.on('close', (code, signal) => { clearTimeout(killTimer); clearTimeout(graceTimer); resolve({ code, signal, timedOut, stdout }); });
    });
    try { fs.writeSync(logFd, `\n===== autofix ${stage} — ended ${new Date().toISOString()} =====\n`); fs.closeSync(logFd); } catch { /* log only */ }
    if (res.spawnError) return finish({ error: `spawn failed: ${res.spawnError.message}` });
    const base = { exitCode: res.code, signal: res.signal, timedOut: res.timedOut };
    if (res.timedOut) return finish({ ...base, error: `${stage} timed out after ${limit}ms` });
    let out;
    try { out = JSON.parse(res.stdout); } catch { out = null; }
    const resolvedModel = resolveModel(out);
    if (res.code !== 0) return finish({ ...base, resolvedModel, error: `claude exited with exit ${res.code}${res.signal ? ` (${res.signal})` : ''}` });
    if (!out || typeof out !== 'object') return finish({ ...base, error: 'claude output was not JSON' });
    if (out.is_error || (out.subtype && out.subtype !== 'success')) return finish({ ...base, resolvedModel, error: `claude reported ${out.subtype || 'error'}` });
    assertModelFamily(stage, resolvedModel); // fail closed: never accept work from a model we did not ask for
    if (!c.schema) return finish({ ...base, ok: true, resolvedModel });
    let result = out.structured_output;
    if (result === undefined && typeof out.result === 'string') { try { result = JSON.parse(out.result); } catch { /* handled below */ } }
    if (!result || typeof result !== 'object') return finish({ ...base, resolvedModel, error: 'no structured output in the result' });
    const errs = []; check(JSON.parse(fs.readFileSync(path.join(root, c.schema), 'utf8')), result, '$', errs);
    if (errs.length) return finish({ ...base, resolvedModel, error: `structured output failed the schema: ${errs.slice(0, 5).join('; ')}` });
    return finish({ ...base, ok: true, resolvedModel, result });
  } finally { if (ownDir) fs.rmSync(ownDir, { recursive: true, force: true }); }
}
