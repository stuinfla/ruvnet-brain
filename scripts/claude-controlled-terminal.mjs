#!/usr/bin/env node
// A controlled prompt boundary using native print/SDK controls, not the native terminal UI.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { decideNativeTurn, appendGatewayReceipt } from './model-routing-gateway.mjs';
import { subscriptionEnvironment, assertSubscriptionAuth, validateDispatchDecision } from './model-router-dispatch.mjs';
import { validateClaudeTerminalSettings } from './model-terminal-launchers.mjs';

const REFUSED = 'Controlled Claude turn refused; no fallback.';
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value || '');
const cleanText = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const allocationEnv = /^(CLAUDE_CODE_EXTRA_BODY|CLAUDE_CODE_EFFORT_LEVEL|ANTHROPIC_DEFAULT_.*_MODEL|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_PLUGIN_(DIRS|CACHE_DIR|SEED_DIR)|CLAUDE_CODE_USE_COWORK_PLUGINS)$/;

/** Classic Brain hooks/MCP/skills remain loaded; native request-rewriting modules are refused. */
export function assertClaudeModuleBoundary(settings, { env = process.env, sessionId, read = fs.readFileSync } = {}) {
  if (!settings || typeof settings !== 'object' || Object.keys(settings.env || {}).some(key => allocationEnv.test(key))) throw new Error(REFUSED);
  const modules = value => value && typeof value === 'object' && Object.entries(value).some(([key, entry]) =>
    key === 'modules' && (Array.isArray(entry) ? entry.length > 0 : Boolean(entry)) || modules(entry));
  if (modules(settings.hooks)) throw new Error(REFUSED);
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  const json = file => JSON.parse(read(file, 'utf8'));
  const enabled = Object.entries(settings.enabledPlugins || {}).filter(([, value]) => value !== false).map(([key]) => key);
  let registry;
  if (enabled.length) registry = json(path.join(config, 'plugins', 'installed_plugins.json'));
  for (const id of enabled) {
    const installations = registry.plugins?.[id];
    if (!Array.isArray(installations) || !installations.length) throw new Error(REFUSED);
    const at = id.lastIndexOf('@'), name = id.slice(0, at), marketplace = id.slice(at + 1);
    if (at < 1) throw new Error(REFUSED);
    const known = json(path.join(config, 'plugins', 'known_marketplaces.json'));
    const marketplaceRoot = known[marketplace]?.installLocation;
    if (!path.isAbsolute(marketplaceRoot || '')) throw new Error(REFUSED);
    const entry = json(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')).plugins?.find(plugin => plugin.name === name);
    if (!entry || modules(entry)) throw new Error(REFUSED);
    // Refuse any registered module-bearing installation of an enabled ID; never guess scope precedence.
    for (const installation of installations) {
      const root = installation.installPath;
      if (!path.isAbsolute(root || '')) throw new Error(REFUSED);
      const manifestFiles = [path.join(root, '.claude-plugin', 'plugin.json'), path.join(root, 'plugin.json')];
      // Native strict:false marketplace entries may supply the entire manifest (e.g. LSP plugins).
      const manifests = manifestFiles.filter(file => fs.existsSync(file)).map(json);
      if (!manifests.length && entry.strict === false) manifests.push(entry);
      if (!manifests.length || manifests.some(modules)) throw new Error(REFUSED);
      const hooks = [path.join(root, 'hooks', 'hooks.json')];
      for (const relative of [...manifests.map(manifest => manifest.hooks), entry.hooks].flat().filter(value => typeof value === 'string')) {
        const resolved = path.resolve(root, relative);
        if (!resolved.startsWith(root + path.sep)) throw new Error(REFUSED);
        hooks.push(resolved);
      }
      for (const file of hooks) if (fs.existsSync(file) && modules(json(file))) throw new Error(REFUSED);
    }
  }
  const nonempty = folder => fs.existsSync(folder) && fs.readdirSync(folder).length > 0;
  // Native 2.1.289 rft()/b(sessionId): <config-dir>/dev-mods/<session-id>.
  if (nonempty(path.join(config, 'dev-mods', sessionId))) throw new Error(REFUSED);
  const projects = path.join(config, 'projects');
  if (fs.existsSync(projects)) for (const directory of fs.readdirSync(projects)) {
    const transcript = path.join(projects, directory, `${sessionId}.jsonl`);
    if (!fs.existsSync(transcript)) continue;
    // A resumed transcript may restore a different dev-mods folder (native last-wins record).
    for (const line of read(transcript, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.type === 'dev-mods' && record.folder && nonempty(record.folder)) throw new Error(REFUSED);
    }
  }
}

/** Retire only the directly owned process; never infer descendant cleanup from its exit. */
export function retireControlledClaudeChild(child, { graceMs = 200, killMs = 200 } = {}) {
  return new Promise(resolve => {
    let finished = false, escalation, deadline;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(escalation); clearTimeout(deadline);
      child.removeListener('close', finish);
      for (const stream of [child.stdin, child.stdout, child.stderr]) { stream?.removeAllListeners('data'); stream?.destroy(); }
      child.unref?.(); resolve();
    };
    child.once('close', finish);
    const kill = signal => { try { child.kill(signal); } catch { /* bounded cleanup still proceeds */ } };
    escalation = setTimeout(() => kill('SIGKILL'), graceMs);
    deadline = setTimeout(finish, graceMs + killMs);
    kill('SIGTERM');
    if (child.exitCode != null || child.signalCode != null) finish();
  });
}

export function controlledClaudeArguments(decision, sessionId, resume = false) {
  if (decision?.harness !== 'claude-code' || decision.provider !== 'anthropic' || decision.subscriptionCovered !== true ||
      !/^claude-[a-z0-9][a-z0-9.-]*$/.test(decision.model || '') ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(decision.effort) || !uuid(sessionId)) throw new Error(REFUSED);
  return ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', decision.model, '--effort', decision.effort, '--permission-mode', 'manual', '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'Agent,Task',
    resume ? '--resume' : '--session-id', sessionId];
}

/** One native process per routed turn. Permission requests require an explicit host answer. */
export async function runControlledClaudeTurn({ binary, prompt, sessionId = crypto.randomUUID(), resume = false,
  cwd = process.cwd(), env = process.env, decide = decideNativeTurn, verifyDecision = validateDispatchDecision,
  checkSettings = validateClaudeTerminalSettings, checkAuth = assertSubscriptionAuth, spawnNative = spawn,
  probe = execFileSync, approve = async () => false, output = () => {}, receipt = appendGatewayReceipt,
  checkModules = assertClaudeModuleBoundary, signal, timeoutMs = 900000, handshakeMs = 10000 } = {}) {
  if (!path.isAbsolute(binary || '') || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000 ||
      /^\s*\//.test(prompt) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000 ||
      !Number.isSafeInteger(handshakeMs) || handshakeMs <= 0 || handshakeMs > 30000 || signal?.aborted) throw new Error(REFUSED);
  // Extra body / effort env overrides can bypass the native CLI's requested allocation.
  if (Object.keys(env).some(key => allocationEnv.test(key))) throw new Error(REFUSED);
  const clean = subscriptionEnvironment(env);
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
  if (fs.existsSync(managed)) throw new Error('Managed Claude settings require separate module-boundary qualification.');
  checkSettings({ env: clean, cwd, home: env.HOME || os.homedir() });
  checkAuth('claude-code', { env: clean, probe: (_name, args, options) => probe(binary, args, options) });
  const decision = await decide(prompt, 'claude-code', { env: clean });
  verifyDecision(decision);
  const args = controlledClaudeArguments(decision, sessionId, resume);
  if (signal?.aborted) throw new Error(REFUSED);
  const child = spawnNative(binary, args, { cwd, env: clean, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let done = false, phase = 'initialize', buffer = '', bytes = 0, result, observed = false, permissions = false;
    const decoder = new StringDecoder('utf8');
    const ids = { initialize: crypto.randomUUID(), before: crypto.randomUUID(), after: crypto.randomUUID() };
    let handshake;
    const timer = setTimeout(() => fail(), timeoutMs);
    const abort = () => fail();
    signal?.addEventListener('abort', abort, { once: true });
    const clear = () => { clearTimeout(timer); clearTimeout(handshake); signal?.removeEventListener('abort', abort); };
    const fail = () => {
      if (done) return;
      done = true; clear();
      void retireControlledClaudeChild(child).then(() => reject(new Error(REFUSED)));
    };
    const send = message => { if (!done) child.stdin.write(JSON.stringify(message) + '\n'); };
    const control = which => {
      phase = which; clearTimeout(handshake); handshake = setTimeout(fail, handshakeMs);
      send({ type: 'control_request', request_id: ids[which], request: { subtype: which === 'initialize' ? 'initialize' : 'get_settings' } });
    };
    const settingsMatch = value => value?.applied?.model === decision.model && value.applied.effort === decision.effort && !value.errors?.length &&
      Array.isArray(value.sources) && !value.sources.some(source => source.source === 'policySettings' && Object.keys(source.settings || {}).length);
    const onMessage = async message => {
      if (done) return;
      if (message.type === 'control_response') {
        const response = message.response;
        if (response?.request_id !== ids[phase] || response.subtype !== 'success') return fail();
        if (phase === 'initialize') return control('before');
        if (!settingsMatch(response.response)) return fail();
        if (phase === 'before') {
          clearTimeout(handshake); phase = 'turn';
          checkModules(response.response.effective, { env: clean, sessionId });
          verifyDecision(decision); // Allocation may have changed while native startup was running.
          receipt({ ts: new Date().toISOString(), harness: 'claude-code', status: 'native-settings-observed',
            model: decision.model, effort: decision.effort, taskClass: decision.taskClass, modelObserved: false,
            evidence: 'get_settings applied model and effort before prompt; execution identity pending' }, { env: clean });
          send({ type: 'user', session_id: sessionId, message: { role: 'user', content: prompt } });
        } else if (phase === 'after') { checkModules(response.response.effective, { env: clean, sessionId }); phase = 'exit'; clearTimeout(handshake); child.stdin.end(); }
        else fail();
        return;
      }
      if (message.type === 'control_request') {
        if (phase !== 'turn' || permissions || message.request?.subtype !== 'can_use_tool' || typeof message.request_id !== 'string') return fail();
        if (['Agent', 'Task'].includes(message.request.tool_name)) return fail();
        permissions = true;
        let allowed = false;
        try { allowed = await approve(message.request) === true; } catch { allowed = false; }
        permissions = false;
        send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: allowed ? { behavior: 'allow', updatedInput: message.request.input } :
            { behavior: 'deny', message: 'The host did not approve this tool request.' } } });
        return;
      }
      if (message.session_id && message.session_id !== sessionId) return fail();
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        if (phase !== 'turn' || message.message?.model !== decision.model) return fail();
        observed = true;
        for (const block of message.message.content || []) if (block.type === 'text') output(cleanText(block.text));
      }
      if (message.type === 'result') {
        if (phase !== 'turn' || permissions || !observed || message.session_id !== sessionId || message.subtype !== 'success' ||
            message.is_error || message.permission_denials?.length || message.errors?.length) return fail();
        result = message; control('after');
      }
    };
    child.stdout.on('data', chunk => {
      if (done) return;
      bytes += chunk.length; if (bytes > 16 * 1024 * 1024) return fail();
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1 && !done) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { void onMessage(JSON.parse(line)).catch(fail); } catch { fail(); }
      }
    });
    child.stderr.on('data', () => {}); // Native diagnostics may contain credentials or prompt text.
    child.stdin.on('error', fail); child.once('error', fail);
    child.once('close', code => {
      if (done) return;
      if (code !== 0 || phase !== 'exit' || !result || buffer.trim() || decoder.end()) return fail();
      try {
        receipt({ ts: new Date().toISOString(), harness: 'claude-code', status: 'completed', model: decision.model,
          effort: decision.effort, taskClass: decision.taskClass, modelObserved: true,
          evidence: 'assistant model observed; get_settings applied effort matched before and after turn; per-request effort not exposed' }, { env: clean });
        done = true; clear(); resolve({ sessionId, decision, modelObserved: true, effortSettingsObserved: true, perRequestEffortObserved: false });
      } catch { fail(); }
    });
    control('initialize');
  });
}

/** Native tool approvals are presented by this host; --print supplies no terminal dialogs. */
export async function launchControlledClaudeTerminal({ binary, args = [], input = process.stdin, output = process.stdout,
  diagnostics = process.stderr, env = process.env, cwd = process.cwd(), runTurn = runControlledClaudeTurn } = {}) {
  let sessionId, resume = false, initialPrompt, ownerBypass = false;
  const remaining = [...args];
  const invalid = () => new Error('Controlled Claude accepts only --resume <session UUID>, --permission-mode bypassPermissions, and a literal initial prompt.');
  while (remaining[0]?.startsWith('-')) {
    if (remaining[0] === '--resume' && !resume && uuid(remaining[1])) {
      sessionId = remaining[1]; resume = true;
    } else if (remaining[0] === '--permission-mode' && !ownerBypass && remaining[1] === 'bypassPermissions') {
      ownerBypass = true;
    } else throw invalid();
    remaining.splice(0, 2);
  }
  if (remaining.some(arg => typeof arg !== 'string' || arg.startsWith('-'))) throw invalid();
  if (remaining.length) initialPrompt = remaining.join(' ');
  if (!input.isTTY || !output.isTTY) throw new Error('Controlled Claude requires a person at a terminal for prompts and approvals.');
  const terminal = createInterface({ input, output });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.on('SIGINT', cancel);
  diagnostics.write('Controlled Claude: one reviewed native allocation per prompt; tool approvals are answered here. Native Agent/Task workers are disabled; use the managed dispatcher for independent child work. /exit closes.\n');
  if (ownerBypass) diagnostics.write('Owner permission bypass is active: native tool requests are approved by this host automatically. Agent/Task remain refused; routing and subscription guards remain active.\n');
  try {
    while (!controller.signal.aborted) {
      const prompt = initialPrompt ?? await terminal.question('Claude> '); initialPrompt = undefined;
      if (prompt.trim() === '/exit') break;
      if (!prompt.trim()) continue;
      const turn = await runTurn({ binary, prompt, sessionId, resume, cwd, env, signal: controller.signal,
        output: text => output.write(text + '\n'), approve: async request => {
          if (['Agent', 'Task'].includes(request.tool_name)) return false;
          const details = cleanText(JSON.stringify({ tool: request.tool_name, input: request.input, reason: request.decision_reason }));
          output.write(`Native permission request (untrusted tool text):\n${details}\n`);
          if (ownerBypass) return true;
          return (await terminal.question('Approve this tool request? Type yes: ')).trim() === 'yes';
        } });
      sessionId = turn.sessionId; resume = true;
      diagnostics.write(`Native session: ${sessionId} (resume with --resume ${sessionId})\n`);
    }
  } finally { terminal.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== '--real-binary' || !args[1] || args[2] !== '--') {
    process.stderr.write('Expected --real-binary /absolute/native/claude -- [--resume UUID]\n'); process.exitCode = 1;
  } else launchControlledClaudeTerminal({ binary: args[1], args: args.slice(3) }).catch(() => {
    process.stderr.write(REFUSED + '\n'); process.exitCode = 1;
  });
}
