#!/usr/bin/env node
const assertModelRoutingText = async text => (await import('./model-routing-defence.mjs')).assertModelRoutingText(text);
// A controlled prompt boundary using native print/SDK controls, not the native terminal UI.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createManagedTerminal } from './managed-terminal-input.mjs';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { decideNativeTurn, appendGatewayReceipt } from './model-routing-gateway.mjs';
import { subscriptionEnvironment, assertSubscriptionAuth, validateDispatchDecision } from './model-router-dispatch.mjs';
import { validateClaudeTerminalSettings } from './model-terminal-launchers.mjs';
import {recordManagedFrontendIntent,managedFrontendOriginalRequest,managedFrontendRecoveryState} from './managed-frontend-intake.mjs';
import { runManagedPrompt } from './model-managed-prompt.mjs';

const REFUSED = 'Controlled Claude turn refused; no fallback.';
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value || '');
const frontendWitnesses=new WeakMap();
const frontendSource=fs.realpathSync(new URL(import.meta.url));
const frontendSourceIdentity={path:frontendSource,digest:crypto.createHash('sha256').update(fs.readFileSync(frontendSource)).digest('hex')};
export const readManagedFrontendWitness=witness=>{const value=frontendWitnesses.get(witness);return value?structuredClone(value):null;};
const cleanText = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const allocationEnv = /^(CLAUDE_CODE_EXTRA_BODY|CLAUDE_CODE_EFFORT_LEVEL|ANTHROPIC_DEFAULT_.*_MODEL|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_PLUGIN_(DIRS|CACHE_DIR|SEED_DIR)|CLAUDE_CODE_USE_COWORK_PLUGINS)$/;

/** Conservative source scan, not native precedence: any persisted plan restricts this invocation. */
export function claudeTerminalReadOnly({ env = process.env, cwd = process.cwd(), readOnly = false } = {}) {
  const files = validateClaudeTerminalSettings({ env, cwd, home: env.HOME || os.homedir() });
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(REFUSED);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (settings.permissions != null && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) throw new Error(REFUSED);
    const mode = settings.permissions?.defaultMode;
    if (mode != null && !['default', 'manual', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'].includes(mode)) throw new Error('Unsupported inherited Claude permission mode');
    if (mode === 'plan') readOnly = true;
  }
  return readOnly;
}

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
export function retireControlledClaudeChild(child, { graceMs = 200, killMs = 200, closeObserved = false } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false, escalation, deadline;
    const settle = confirmed => {
      if (finished) return;
      finished = true; clearTimeout(escalation); clearTimeout(deadline);
      child.removeListener('close', finish);
      for (const stream of [child.stdin, child.stdout, child.stderr]) { stream?.removeAllListeners('data'); stream?.destroy(); }
      child.unref?.();
      const retirementEvidence = { scope: 'owned-direct-child-only', closeObserved: confirmed, retired: confirmed,
        treeVerified: false, pid: child.pid ?? null };
      if (confirmed) resolve(retirementEvidence);
      else reject(Object.assign(new Error(REFUSED + ' Native process retirement not confirmed.'),
        { retirementUnconfirmed: true, retirementEvidence }));
    };
    const finish = () => settle(true);
    child.once('close', finish);
    if (closeObserved) return finish();
    const kill = signal => { try { child.kill(signal); } catch { /* close remains required */ } };
    escalation = setTimeout(() => kill('SIGKILL'), graceMs);
    deadline = setTimeout(() => settle(false), graceMs + killMs);
    kill('SIGTERM');
  });
}

export function controlledClaudeArguments(decision, sessionId, resume = false, responseSchema) {
  if (decision?.harness !== 'claude-code' || decision.provider !== 'anthropic' || decision.subscriptionCovered !== true ||
      !/^claude-[a-z0-9][a-z0-9.-]*$/.test(decision.model || '') ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(decision.effort) || !uuid(sessionId)) throw new Error(REFUSED);
  return [...(responseSchema ? ['--json-schema', JSON.stringify(responseSchema)] : []), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', decision.model, '--effort', decision.effort, '--permission-mode', 'manual', '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'Agent,Task',
    resume ? '--resume' : '--session-id', sessionId];
}

/** One native process per routed turn. Permission requests require an explicit host answer. */
export async function runControlledClaudeTurn({ binary, prompt, decisionPrompt = prompt, sessionId = crypto.randomUUID(), resume = false,
  cwd = process.cwd(), env = process.env, decide = decideNativeTurn, verifyDecision = validateDispatchDecision,
  checkSettings = validateClaudeTerminalSettings, checkAuth = assertSubscriptionAuth, spawnNative = spawn,
  probe = execFileSync, approve = async () => false, scopeTool = permission => ['Read', 'Glob', 'Grep'].includes(permission.tool_name), output = () => {}, receipt = appendGatewayReceipt,
  checkModules = assertClaudeModuleBoundary, responseSchema, validateStructuredOutput, signal, timeoutMs = 900000, handshakeMs = 10000 } = {}) {
  if (!path.isAbsolute(binary || '') || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000 ||
      /^\s*\//.test(prompt) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000 ||
      !Number.isSafeInteger(handshakeMs) || handshakeMs <= 0 || handshakeMs > 30000 || signal?.aborted) throw new Error(REFUSED);
  if (responseSchema && (responseSchema.type !== 'object' || typeof validateStructuredOutput !== 'function'
    || Buffer.byteLength(JSON.stringify(responseSchema)) > 65536)) throw new Error(REFUSED);
  const limit = performance.now() + timeoutMs;
  const expired = () => signal?.aborted || performance.now() >= limit;
  await assertModelRoutingText(prompt);
  if (expired()) throw new Error(REFUSED);
  // Extra body / effort env overrides can bypass the native CLI's requested allocation.
  if (Object.keys(env).some(key => allocationEnv.test(key))) throw new Error(REFUSED);
  const clean = subscriptionEnvironment(env);
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
  if (fs.existsSync(managed)) throw new Error('Managed Claude settings require separate module-boundary qualification.');
  checkSettings({ env: clean, cwd, home: env.HOME || os.homedir() });
  checkAuth('claude-code', { env: clean, probe: (_name, args, options) => probe(binary, args, options) });
  const decision = await decide(decisionPrompt, 'claude-code', { env: clean });
  verifyDecision(decision);
  if (expired()) throw new Error(REFUSED);
  const args = controlledClaudeArguments(decision, sessionId, resume, responseSchema);
  if (expired()) throw new Error(REFUSED);
  const child = spawnNative(binary, args, { cwd, env: clean, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let childClosed = false, done = false, phase = 'initialize', buffer = '', bytes = 0, result, observed = false, pendingPermissions = 0;
    let permissionTail = Promise.resolve();
    const assistantText = [];
    let structuredAnswer;
    const scopeCallback = 'owned-scope', hookRequests = new Set(), scopeDenials = new Map();
    const permissionRequests = new Set();
    let hostApprovalDenied = false;
    const decoder = new StringDecoder('utf8');
    const ids = { initialize: crypto.randomUUID(), before: crypto.randomUUID(), after: crypto.randomUUID() };
    let handshake;
    const timer = setTimeout(() => fail(), Math.max(1, limit - performance.now()));
    const abort = () => fail();
    signal?.addEventListener('abort', abort, { once: true });
    const clear = () => { clearTimeout(timer); clearTimeout(handshake); signal?.removeEventListener('abort', abort); };
    const fail = () => {
      if (done) return;
      done = true; clear();
      void retireControlledClaudeChild(child, { closeObserved: childClosed }).then(
        retirementEvidence => reject(Object.assign(new Error(REFUSED), { retirementEvidence })), reject);
    };
    const send = message => { if (done) return; if (expired()) return fail(); child.stdin.write(JSON.stringify(message) + '\n'); };
    const control = which => {
      phase = which; clearTimeout(handshake); handshake = setTimeout(fail, handshakeMs);
      send({ type: 'control_request', request_id: ids[which], request: { subtype: which === 'initialize' ? 'initialize' : 'get_settings',
        ...(which === 'initialize' ? { hooks: { PreToolUse: [{ hookCallbackIds: [scopeCallback] }] } } : {}) } });
    };
    const settingsMatch = value => value?.applied?.model === decision.model && value.applied.effort === decision.effort && !value.errors?.length &&
      Array.isArray(value.sources) && value.sources.every(source => ['userSettings', 'projectSettings', 'localSettings', 'policySettings'].includes(source.source))
      && !value.sources.some(source => source.source === 'policySettings' && Object.keys(source.settings || {}).length);
    const onMessage = async message => {
      if (done) return;
      if (expired()) return fail();
      if (message.type === 'control_response') {
        const response = message.response;
        if (response?.request_id !== ids[phase] || response.subtype !== 'success') return fail();
        if (phase === 'initialize') {
          if (response.response?.hooks_applied !== true) return fail();
          return control('before');
        }
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
      if (message.type === 'control_request' && message.request?.subtype === 'hook_callback') {
        const request = message.request, input = request.input;
        const toolId = request.tool_use_id ?? input?.tool_use_id;
        if (phase !== 'turn' || request.callback_id !== scopeCallback || typeof message.request_id !== 'string'
          || hookRequests.has(message.request_id) || permissionRequests.has(message.request_id) || hookRequests.size >= 1024
          || input?.hook_event_name !== 'PreToolUse' || input.session_id !== sessionId
          || typeof input.tool_name !== 'string' || !input.tool_name || input.tool_name.length > 256 || typeof toolId !== 'string' || !toolId || toolId.length > 256
          || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)
          || Buffer.byteLength(JSON.stringify(input.tool_input)) > 1024 * 1024) return fail();
        hookRequests.add(message.request_id);
        const permission = { tool_name: input.tool_name, input: input.tool_input };
        let withinScope = false;
        if (permission.tool_name === 'StructuredOutput' && responseSchema && validateStructuredOutput(permission.input) === true
          && Buffer.byteLength(JSON.stringify(permission.input)) <= 1024 * 1024) {
          await assertModelRoutingText(JSON.stringify(permission.input)); withinScope = true;
        } else if (!['Agent', 'Task'].includes(permission.tool_name)) withinScope = await scopeTool(permission) === true;
        if (expired()) return fail();
        if (!withinScope && scopeDenials.has(toolId)) return fail();
        send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: withinScope ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
            permissionDecisionReason: 'Outside the host declared tool scope' } } } });
        if (!withinScope && !done) {
          const inputSha256 = crypto.createHash('sha256').update(JSON.stringify(permission.input)).digest('hex');
          const summary = { status: 'host-scope-denied', sessionId, toolUseId: toolId, toolName: permission.tool_name, inputSha256,
            evidence: 'invocation PreToolUse deny response' };
          scopeDenials.set(toolId, { summary, input: structuredClone(permission.input) });
          receipt({ ts: new Date().toISOString(), harness: 'claude-code', ...summary }, { env: clean });
        }
        return;
      }
      if (message.type === 'control_request') {
        if (phase !== 'turn' || message.request?.subtype !== 'can_use_tool' || typeof message.request_id !== 'string' || !message.request_id
          || permissionRequests.has(message.request_id) || hookRequests.has(message.request_id)
          || permissionRequests.size >= 1024 || pendingPermissions >= 32) return fail();
        if (['Agent', 'Task'].includes(message.request.tool_name)) return fail();
        permissionRequests.add(message.request_id); pendingPermissions++;
        const requestId = message.request_id, request = structuredClone(message.request), originalInput = structuredClone(request.input);
        permissionTail = permissionTail.then(async () => {
          if (done) return;
          if (expired()) return fail();
          let allowed = false;
          try {
            if (request.tool_name === 'StructuredOutput') {
              const value = originalInput;
              const serialized = JSON.stringify(value);
              if (responseSchema && value && typeof value === 'object' && !Array.isArray(value)
                && Buffer.byteLength(serialized) <= 1024 * 1024 && validateStructuredOutput(value) === true) {
                await assertModelRoutingText(serialized);
                allowed = !expired();
              }
            } else allowed = await approve(request) === true;
          } catch { allowed = false; }
          if (done) return;
          if (expired()) return fail();
          if (!allowed) hostApprovalDenied = true;
          pendingPermissions--;
          send({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
            response: allowed ? { behavior: 'allow', updatedInput: originalInput } :
              { behavior: 'deny', message: 'The host did not approve this tool request.' } } });
          if (!allowed) fail();
        }).catch(fail);
        return;
      }
      if (message.session_id && message.session_id !== sessionId) return fail();
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        if (phase !== 'turn' || message.session_id !== sessionId || message.message?.model !== decision.model) return fail();
        observed = true;
        for (const block of message.message.content || []) if (block.type === 'text') assistantText.push(cleanText(block.text));
      }
      if (message.type === 'result') {
        if (phase !== 'turn' || pendingPermissions !== 0 || !observed || message.session_id !== sessionId || message.subtype !== 'success' ||
            message.is_error !== false || hostApprovalDenied || message.errors?.length) return fail();
        if (message.permission_denials !== undefined) {
          if (!Array.isArray(message.permission_denials)) return fail();
          const seen = new Set();
          for (const denial of message.permission_denials) {
            const owned = scopeDenials.get(denial?.tool_use_id);
            if (!denial || typeof denial !== 'object' || Array.isArray(denial) || typeof denial.tool_use_id !== 'string' || !denial.tool_use_id
              || seen.has(denial.tool_use_id) || typeof denial.tool_name !== 'string' || !denial.tool_name
              || !denial.tool_input || typeof denial.tool_input !== 'object' || Array.isArray(denial.tool_input)
              || !owned || owned.summary.sessionId !== sessionId || owned.summary.toolName !== denial.tool_name
              || !isDeepStrictEqual(owned.input, denial.tool_input)) return fail();
            seen.add(denial.tool_use_id);
          }
        }
        if (responseSchema) {
          try {
            const value = message.structured_output;
            if (!value || typeof value !== 'object' || Array.isArray(value) || validateStructuredOutput(value) !== true) return fail();
            structuredAnswer = JSON.stringify(value);
            if (Buffer.byteLength(structuredAnswer) > 1024 * 1024) return fail();
          } catch { return fail(); }
        } else if (typeof message.result !== 'string' || !message.result.trim()) return fail();
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
    child.once('close', async code => {
      childClosed = true;
      if (done) return;
      if (code !== 0 || phase !== 'exit' || !result || buffer.trim() || decoder.end()) return fail();
      try {
        await assertModelRoutingText(assistantText.join('\n'));
        await assertModelRoutingText(responseSchema ? structuredAnswer : result.result);
        if (done || expired()) return fail();
        for (const text of assistantText) { if (expired()) return fail(); output(text); }
        if (expired()) return fail();
        receipt({ ts: new Date().toISOString(), harness: 'claude-code', status: 'completed', model: decision.model,
          effort: decision.effort, taskClass: decision.taskClass, modelObserved: true, outputFormat: responseSchema ? 'json-schema' : 'text',
          nativeSchemaRetries: responseSchema ? 'not-observed' : undefined,
          evidence: 'assistant model observed; get_settings applied effort matched before and after turn; per-request effort not exposed' }, { env: clean });
        done = true; clear(); resolve({ retirementEvidence: { scope: 'owned-direct-child-only', closeObserved: true, retired: true, treeVerified: false, pid: child.pid ?? null }, sessionId, decision, finalAnswer: responseSchema ? structuredAnswer : result.result, structuredOutput: Boolean(responseSchema),
          scopeDenials: [...scopeDenials.values()].map(value => value.summary),
          nativeSchemaRetries: responseSchema ? 'not-observed' : undefined, modelObserved: true, effortSettingsObserved: true, perRequestEffortObserved: false });
      } catch { fail(); }
    });
    control('initialize');
  });
}

/** Native tool approvals are presented by this host; --print supplies no terminal dialogs. */
export async function launchControlledClaudeTerminal({ binary, args = [], input = process.stdin, output = process.stdout,
  diagnostics = process.stderr, env = process.env, cwd = process.cwd(), signalSource = process, runTurn = runControlledClaudeTurn,
  managedPrompt = runManagedPrompt, captureFrontendIntent = recordManagedFrontendIntent } = {}) {
  let sessionId, resume = false, initialPrompt, ownerBypass = false, readOnly = false, permissionMode;
  const remaining = [...args];
  const invalid = () => new Error('Controlled Claude accepts only --resume <session UUID>, --permission-mode manual|plan|bypassPermissions, --dangerously-skip-permissions, and a literal initial prompt.');
  while (remaining[0]?.startsWith('-')) {
    if (remaining[0] === '--resume' && !resume && uuid(remaining[1])) {
      sessionId = remaining[1]; resume = true;
    } else if (remaining[0] === '--dangerously-skip-permissions' && !ownerBypass && permissionMode === undefined) {
      ownerBypass = true; permissionMode = 'bypassPermissions'; remaining.shift(); continue;
    } else if (remaining[0] === '--permission-mode' && permissionMode === undefined && ['manual', 'plan', 'bypassPermissions'].includes(remaining[1])) {
      permissionMode = remaining[1]; ownerBypass = permissionMode === 'bypassPermissions'; readOnly = permissionMode === 'plan';
    } else throw invalid();
    remaining.splice(0, 2);
  }
  if (remaining.some(arg => typeof arg !== 'string' || arg.startsWith('-'))) throw invalid();
  if (remaining.length) initialPrompt = remaining.join(' ');
  if (!input.isTTY || !output.isTTY) throw new Error('Controlled Claude requires a person at a terminal for prompts and approvals.');
  const terminal = createManagedTerminal({ input, output });
  const frontendInstanceId=crypto.randomUUID();let submissionSequence=0;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.on('SIGINT', cancel);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) signalSource.on(name, cancel);
  diagnostics.write('Controlled Claude: one reviewed native allocation per prompt; tool approvals are answered here. Native Agent/Task workers are disabled; use the managed dispatcher for independent child work. /exit closes.\n');
  if (ownerBypass) diagnostics.write('Owner permission intent is active only within guarded workflow scope; native bypass is not forwarded. Agent/Task and commands remain refused.\n');
  try {
    while (!controller.signal.aborted) {
      const before=claudeTerminalReadOnly({env,cwd,readOnly});
      let prompt,frontendIntake,deadline=Date.now()+900000,turnReadOnly=before;
      if(initialPrompt!==undefined){prompt=initialPrompt;initialPrompt=undefined;}
      else await terminal.question('Claude> ',{signal:controller.signal}).then(async value=>{
        prompt=value;if(!value.trim()||value.trim()==='/exit')return;deadline=Date.now()+900000;
        turnReadOnly=before||claudeTerminalReadOnly({env,cwd,readOnly});
        const files=validateClaudeTerminalSettings({env,cwd,home:env.HOME||os.homedir()}).filter(file=>fs.existsSync(file))
          .map(file=>({path:fs.realpathSync(file),digest:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
        const witness=Object.freeze({});
        frontendWitnesses.set(witness,Object.freeze({host:'claude',inputKind:'interactive',frontendInstanceId,submissionSequence:++submissionSequence,
          projectDir:fs.realpathSync(cwd),originalPromptDigest:crypto.createHash('sha256').update(value).digest('hex'),permissions:{apiBilling:false,write:!turnReadOnly},sourceIdentity:frontendSourceIdentity,
          scopeLimits:{allowedWorktrees:[fs.realpathSync(cwd)],maxConcurrent:5,maxAttempts:6,deadline,
            parentContextDigest:crypto.createHash('sha256').update(JSON.stringify({sessionId,resume})).digest('hex')},
          parentPermissionRef:{kind:'actual-claude-settings-manual-scope',digest:crypto.createHash('sha256').update(JSON.stringify({files,turnReadOnly,ownerBypass,permissionMode:permissionMode||'manual'})).digest('hex')}}));
        frontendIntake=await captureFrontendIntent({witness,host:'claude',originalPrompt:value,projectDir:cwd,env,signal:controller.signal});
        if(/^\/resume-frontend /.test(value)&&frontendIntake)prompt=managedFrontendOriginalRequest(frontendIntake);
      });
      if(prompt.trim()==='/exit')break;if(!prompt.trim())continue;
      const recoveryState=managedFrontendRecoveryState(frontendIntake),recoveredScope=recoveryState?.effectiveScope;
      if(recoveredScope){deadline=Math.min(deadline,recoveredScope.deadline);turnReadOnly=turnReadOnly||!recoveredScope.permissions.write;}
      const turn = await managedPrompt({ binary, originalPrompt: prompt, harness: 'claude-code', projectRoot: cwd, deadline,
        ...(recoveredScope?{allowedWorktrees:recoveredScope.allowedWorktrees,maxAttempts:Math.min(6,recoveryState.originalScope.maxAttempts),maxConcurrent:recoveredScope.maxConcurrent}:{}),
        frontendIntake,inputKind:frontendIntake?'interactive':'argv', nativeContext: { sessionId, resume }, permissions: { apiBilling: false, write: !turnReadOnly },
        primaryTurn: runTurn, cwd, env, signal: controller.signal,
        scopeTool: permission => ['Read', 'Glob', 'Grep'].includes(permission.tool_name) || /__search_ruvnet$/.test(permission.tool_name),
        output: text => output.write(text + '\n'), approve: async (request, owned) => {
          if (['Agent', 'Task', 'Bash'].includes(request.tool_name)) return false;
          if (['Write', 'Edit', 'MultiEdit'].includes(request.tool_name) && (turnReadOnly || owned?.ownership?.mode !== 'write')) return false;
          const details = cleanText(JSON.stringify({ tool: request.tool_name, input: request.input, reason: request.decision_reason }));
          output.write(`Native permission request (untrusted tool text):\n${details}\n`);
          if (ownerBypass) return true;
          return (await terminal.question('Approve this tool request? Type yes: ', { signal: controller.signal, approval: true })).trim() === 'yes';
        } });
      sessionId = turn.sessionId; resume = true;
      const actual = turn.modelObserved === true ? turn.decision : undefined;
      const reviewer = turn.managedWorkflow?.executions?.find(item => item.workerId === 'independent-review');
      if (actual?.model && actual?.effort) diagnostics.write(`Completed by ${cleanText(actual.model)} · applied ${cleanText(actual.effort)}${reviewer ? `; review ${cleanText(reviewer.observedModel)} · ${cleanText(reviewer.observedEffort)}` : ''}\n`);
      diagnostics.write(`Native session: ${sessionId} (resume with --resume ${sessionId})\n`);
    }
  } finally { controller.abort(); terminal.close(); for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) signalSource.removeListener(name, cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== '--real-binary' || !args[1] || args[2] !== '--') {
    process.stderr.write('Expected --real-binary /absolute/native/claude -- [--resume UUID]\n'); process.exitCode = 1;
  } else launchControlledClaudeTerminal({ binary: args[1], args: args.slice(3) }).catch(() => {
    process.stderr.write(REFUSED + '\n'); process.exitCode = 1;
  });
}
