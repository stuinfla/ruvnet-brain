#!/usr/bin/env node
// Per-user PreToolUse boundary for native agent launches. Root owns host registration.
// Codex v2 spawn_agent model/reasoning_effort/fork_turns fields checked in official source and
// installed CLI. Claude's installed Agent schema lacks per-call effort and permits model aliases
// only; do not invent unsupported fields. Actual rewritten dispatch requires host acceptance proof.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readCodexAllowance } from './native-subscription-usage.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TASK_CLASSES = new Set(['fast', 'medium', 'substantial', 'hard', 'exceptional']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_AGENT = /^(?:(?:functions|collaboration|multi_agent_v2)\.)?spawn_agent$/;
const CLAUDE_AGENT = /^(?:Agent|Task)$/;

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function advisory(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason } };
}

export function loadScope(harness, { routerDir = process.env.MODEL_ROUTER_CONFIG_DIR || path.join(os.homedir(), '.claude', 'model-router') } = {}) {
  try {
    const profile = JSON.parse(fs.readFileSync(process.env.MODEL_ROUTER_PROFILE || path.join(routerDir, 'profile.json'), 'utf8'));
    const selection = JSON.parse(fs.readFileSync(process.env.MODEL_ROUTER_SELECTION || path.join(routerDir, 'routing-policy.json'), 'utf8'));
    const user = profile.nativeAgentRouting?.[harness];
    const reviewed = selection.nativeAgentRouting?.[harness];
    return { enabled: user?.enabled === true && reviewed?.enabled === true,
      strict: user?.strict === true && reviewed?.strict === true };
  } catch { return { enabled: false, strict: false }; }
}

export function decideViaEngine(prompt, harness, { engine = process.env.MODEL_ROUTER_ENGINE || path.join(DIR, 'model-router-engine.mjs'),
  run = execFileSync } = {}) {
  return JSON.parse(run(process.execPath, [engine, '--harness', harness, '--policy-only', '--json'], {
    input: prompt, encoding: 'utf8', timeout: 2000, maxBuffer: 131072,
    // No policy errors or raw task text are emitted by this hook on child failure.
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

export function loadNativeModels(file = process.env.MODEL_ROUTER_NATIVE_MODELS ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json')) {
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cache.models)) throw new Error('Native model support cache missing');
  return cache.models;
}

export function routeAgentLaunch(event, { harness, decide = decideViaEngine, nativeModels = loadNativeModels, scope = loadScope, parentState = null } = {}) {
  const tool = event?.tool_name || event?.toolName;
  const isAgent = harness === 'codex' ? CODEX_AGENT.test(tool || '') :
    harness === 'claude-code' ? CLAUDE_AGENT.test(tool || '') : false;
  if (!isAgent || (event.hook_event_name && event.hook_event_name !== 'PreToolUse')) return {};
  const routingScope = scope(harness);
  if (!routingScope.enabled) return {};
  const refuse = (reason) => harness === 'codex' && routingScope.strict ? deny(reason) : advisory(reason);
  const input = event.tool_input || event.toolInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('Agent launch arguments unavailable; use a classified managed worker.');
  const prompt = harness === 'codex' ? input.message : input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return refuse('Agent task unavailable for classification; use a classified managed worker.');
  let decision;
  try { decision = decide(prompt, harness); }
  catch { return refuse('Current reviewed model/effort allocation unavailable; review routing policy before agent dispatch.'); }
  if (!decision?.subscriptionCovered || decision.harness !== harness || !TASK_CLASSES.has(decision.taskClass) ||
      !EFFORTS.has(decision.effort) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(decision.model || '')) {
    return refuse('Agent routing did not produce a qualified native subscription model and effort.');
  }
  if (harness === 'codex' && ['xhigh', 'max'].includes(decision.effort) &&
      (decision.taskClass !== 'exceptional' || decision.effort !== 'xhigh' || !/^[a-z][a-z0-9-]{2,79}$/.test(decision.exceptionalReason || ''))) {
    return refuse('Exceptional native agent effort requires an explicit named reason and qualified xhigh route.');
  }
  if (harness === 'claude-code') {
    return advisory(`Native Claude Agent cannot enforce this reviewed ${decision.taskClass} model and ${decision.effort} effort through its current per-call schema. Use model-router-dispatch.mjs; do not add unsupported effort fields.`);
  }
  // Never convert all-history forks into context-free tasks to make overrides fit.
  if ('fork_context' in input) return refuse('Legacy fork_context dispatch is unsupported by this v2 routing hook; preserve context through a supported launch.');
  const fork = typeof input.fork_turns === 'string' ? input.fork_turns.trim().toLowerCase() : 'all';
  if (fork === 'all' || !fork) {
    // Parent evidence must come from a verified host adapter, never the requested tool arguments.
    // Current native hook has no proven effective-effort field, so main supplies no parent evidence.
    if (parentState?.observed === true && parentState.model === decision.model && parentState.effort === decision.effort) {
      return advisory('Full-history fork already matches the reviewed model and effort; input and inherited context preserved.');
    }
    return refuse('Full-history agent forks inherit parent model and effort; a matching effective parent allocation is not verified. Routing will not discard context; use an explicitly authorized bounded fork or managed worker.');
  }
  if (fork !== 'none' && !/^[1-9]\d*$/.test(fork)) return refuse('Invalid fork_turns; routing will not alter the context boundary.');
  let model;
  try { model = nativeModels().find((m) => m.slug === decision.model); }
  catch { return refuse('Native agent model support unavailable; refresh the host model cache before dispatch.'); }
  if (!model || model.multi_agent_version !== 'v2' ||
      !(model.supported_reasoning_levels || []).some((entry) => entry.effort === decision.effort)) {
    return refuse('Reviewed model/effort is not supported by this native v2 agent host.');
  }
  // updatedInput replaces the COMPLETE object. No context, capabilities, auth, or task fields dropped.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...input, model: decision.model, reasoning_effort: decision.effort },
    ...(decision.exceptionalReason ? { additionalContext: `Qualified exceptional reason: ${decision.exceptionalReason}` } : {}) } };
}

async function main(argv) {
  const at = argv.indexOf('--harness');
  const harness = at < 0 ? null : argv[at + 1];
  if (!['codex', 'claude-code'].includes(harness)) throw new Error('Explicit supported --harness required');
  let event;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch {
    const scope = loadScope(harness);
    const output = !scope.enabled ? {} : harness === 'codex' && scope.strict
      ? deny('Malformed agent hook input; launch was not classified.') : advisory('Malformed agent hook input; launch was not classified.');
    process.stdout.write(JSON.stringify(output) + '\n'); return;
  }
  let output = routeAgentLaunch(event, { harness });
  if (harness === 'codex' && output.hookSpecificOutput?.permissionDecision === 'allow') {
    try { await readCodexAllowance(); }
    catch {
      output = loadScope(harness).strict ? deny('Current native ordinary subscription allowance unavailable; no credit fallback authorized.')
        : advisory('Current native ordinary subscription allowance unavailable; managed dispatch cannot proceed without fresh allowance.');
    }
  }
  // The host's normal transcript records its tool input. This hook persists no task text.
  process.stdout.write(JSON.stringify(output) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    const args = process.argv.slice(2); const harness = args[args.indexOf('--harness') + 1];
    const result = harness === 'codex' && loadScope(harness).strict ? deny('Agent routing hook failed; managed dispatch required.')
      : advisory('Agent routing hook failed; managed dispatch remains the supported enforcement path.');
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
