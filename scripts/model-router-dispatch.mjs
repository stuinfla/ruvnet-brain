#!/usr/bin/env node
// Managed native worker launcher. A prompt hook advises; this boundary enforces launch arguments.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertCurrentSelection, selectionEvidenceStatus, loadSelection, loadCatalog, loadProfile, applyProfile, eligibleCandidates, TASK_CLASSES } from './model-router-engine.mjs';

import { readCodexAllowance } from './native-subscription-usage.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BILLING_ENV = /^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CODEX_API_KEY)$/;

export function subscriptionEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !BILLING_ENV.test(key)));
}

export function assertSubscriptionAuth(harness, { env = subscriptionEnvironment(), read = fs.readFileSync,
  probe = execFileSync } = {}) {
  if (harness === 'codex') {
    let auth;
    try { auth = JSON.parse(read(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8')); }
    catch { throw new Error('Native Codex subscription authentication unreadable; dispatch blocked'); }
    if (!auth.tokens || auth.OPENAI_API_KEY || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) {
      throw new Error('Codex subscription OAuth authentication required; no API-key fallback');
    }
  } else if (harness === 'claude-code') {
    let status;
    try { status = JSON.parse(probe('claude', ['auth', 'status', '--json'], {
      env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    })); } catch { throw new Error('Native Claude subscription authentication unavailable; dispatch blocked'); }
    if (!status.loggedIn || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty' || !status.subscriptionType) {
      throw new Error('Claude native subscription authentication required; no API fallback');
    }
  } else throw new Error(`Unsupported harness: ${harness}`);
}

export function loadNativeCodexModels() {
  const file = process.env.MODEL_ROUTER_NATIVE_MODELS || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(cache.models)) return cache.models;
  } catch { /* no inferred capability from API or catalog pricing */ }
  throw new Error('Native Codex model support cache unavailable; refresh host metadata before dispatch');
}

export function validateDispatchDecision(decision, { selection = loadSelection(), profile = loadProfile(),
  candidates = applyProfile(loadCatalog(), profile), nativeModels } = {}) {
  const evidence = selectionEvidenceStatus(selection);
  if (selection.reviewedAt !== decision.selectionReviewedAt || !evidence.routeDigest || evidence.routeDigest !== decision.selectionRouteDigest) throw new Error('Allocation changed since selection; reclassify prompt');
  const approved = selection.routes?.[decision.harness]?.[decision.taskClass];
  const efforts = [approved?.effort];
  if (decision.harness === 'claude-code' && decision.taskClass === 'medium') {
    efforts.push(selection.routes?.[decision.harness]?.codingEffort);
  }
  if (decision.harness === 'codex' && ['xhigh', 'max'].includes(decision.effort) &&
      (decision.taskClass !== 'exceptional' || decision.effort !== 'xhigh' || !approved?.requiresNamedReason ||
       !/^[a-z][a-z0-9-]{2,79}$/.test(decision.exceptionalReason || ''))) {
    throw new Error('Exceptional xhigh dispatch requires explicit qualified route and named reason');
  }
  if (approved?.model !== decision.model || !efforts.includes(decision.effort) ||
      !eligibleCandidates(candidates, profile, decision.harness).some((m) => m.id === decision.model)) {
    throw new Error('Launch no longer satisfies reviewed native subscription allocation');
  }
  if (decision.harness === 'codex') {
    const native = (nativeModels || loadNativeCodexModels()).find((m) => m.slug === decision.model);
    if (!native || !(native.supported_reasoning_levels || []).some((m) => m.effort === decision.effort)) {
      throw new Error('Native Codex host does not support the reviewed model/effort dispatch');
    }
  }
  return evidence;
}

export function buildLaunch(decision, { cwd = process.cwd(), interactive = false } = {}) {
  if (interactive) throw new Error('Interactive host cannot keep managed-worker prompts on stdin; use managed worker launch');
  assertCurrentSelection({ schemaVersion: 1, reviewedAt: decision.selectionReviewedAt, maxAgeMs: decision.selectionMaxAgeMs });
  if (!decision.subscriptionCovered || !TASK_CLASSES.includes(decision.taskClass) ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(decision.effort) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(decision.model || '')) {
    throw new Error('Invalid or unauthorized routing decision');
  }
  if (decision.harness === 'codex' && decision.provider === 'openai') {
    return { command: 'codex', args: ['exec', '--ignore-user-config',
      '--model', decision.model, '-c', `model_reasoning_effort="${decision.effort}"`,
      '-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false', '--cd', cwd, '-'] };
  }
  if (decision.harness === 'claude-code' && decision.provider === 'anthropic') {
    // Ignore user/project API-key helpers and provider redirects. Native OAuth remains readable.
    return { command: 'claude', args: ['--print', '--model', decision.model,
      '--effort', decision.effort, '--setting-sources', '', '--settings', '{"apiKeyHelper":""}'] };
  }
  throw new Error('Decision does not target a supported native subscription host');
}

export async function dispatch(decision, prompt, { spawnWorker = spawn, checkAuth = assertSubscriptionAuth, verifyDecision = validateDispatchDecision,
  env = process.env, cwd = process.cwd(), interactive = false, checkAllowance = readCodexAllowance,
  receiptFile = process.env.MODEL_ROUTER_DISPATCH_RECEIPTS || path.join(os.homedir(), '.claude', 'metaharness', 'dispatch-decisions.jsonl') } = {}) {
  const evidence = verifyDecision(decision) || selectionEvidenceStatus({ schemaVersion: 1,
    reviewedAt: decision.selectionReviewedAt, maxAgeMs: decision.selectionMaxAgeMs });
  const launch = buildLaunch(decision, { cwd, interactive });
  const cleanEnv = subscriptionEnvironment(env);
  checkAuth(decision.harness, { env: cleanEnv });
  const allowance = decision.harness === 'codex' ? await checkAllowance({ env: cleanEnv })
    : { checkedAt: null, ordinaryUsageAllowed: null, status: 'native-claude-allowance-not-verified' };
  const receipt = { ts: new Date().toISOString(), harness: decision.harness, model: decision.model,
    effort: decision.effort, taskClass: decision.taskClass, exceptionalReason: decision.exceptionalReason, subscriptionCovered: true,
    selectionReviewedAt: evidence.reviewedAt, selectionRouteDigest: evidence.routeDigest || decision.selectionRouteDigest,
    selectionEvidenceStale: evidence.stale,
    status: 'launch-requested', modelObserved: false, serviceMode: decision.harness === 'codex' ? 'standard' : 'existing-claude-policy',
    allowance: { checkedAt: allowance.checkedAt, ordinaryUsageAllowed: allowance.ordinaryUsageAllowed, reservation: false, raceSafe: false } };
  // Durable receipt is required. It never contains the prompt or policy-supplied reason.
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.appendFileSync(receiptFile, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  const child = spawnWorker(launch.command, launch.args, {
    cwd, env: cleanEnv, shell: false, stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.end(prompt);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      fs.appendFileSync(receiptFile, JSON.stringify({ ...receipt, ts: new Date().toISOString(),
        status: code === 0 ? 'process-completed' : 'process-failed', exitCode: code, signal }) + '\n');
      resolve(code ?? 1);
    });
  });
}

async function main(argv) {
  let harness = 'codex', policy, interactive = false, dryRun = false, requestJson = false;
  const promptParts = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--harness') harness = argv[++i];
    else if (argv[i] === '--policy') policy = argv[++i];
    else if (argv[i] === '--request-json') requestJson = true;
    else if (argv[i] === '--interactive') interactive = true;
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--') { promptParts.push(...argv.slice(i + 1)); break; }
    else if (argv[i].startsWith('-')) throw new Error(`Unsupported launch option: ${argv[i]}`);
    else promptParts.push(argv[i]);
  }
  const raw = promptParts.length ? promptParts.join(' ') : fs.readFileSync(0, 'utf8');
  const request = requestJson ? JSON.parse(raw) : { prompt: raw };
  const prompt = request.prompt;
  if (typeof prompt !== 'string') throw new Error('Request prompt must be a string');
  const args = [path.join(DIR, 'model-router-engine.mjs'), '--harness', harness, '--json'];
  if (policy) args.push('--policy', policy);
  if (requestJson) args.push('--request-json');
  const decision = JSON.parse(execFileSync(process.execPath, args, {
    input: requestJson ? JSON.stringify(request) : prompt, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  }));
  if (dryRun) {
    validateDispatchDecision(decision);
    const launch = buildLaunch(decision, { interactive });
    process.stdout.write(JSON.stringify({ ...launch, model: decision.model, effort: decision.effort,
      taskClass: decision.taskClass, executed: false }) + '\n');
  } else process.exitCode = await dispatch(decision, prompt, { interactive });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`model-router-dispatch: ${e.message}\n`); process.exitCode = 1; });
}
