#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

export const API_BILLING_ENV = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
]);
export const PRIVATE_SIGNING_ENV = Object.freeze([
  'RUVNET_SIGNING_KEY', 'RUVNET_FABLE_REVIEW_SIGNING_KEY', 'RUVNET_ASTRA_REVIEW_SIGNING_KEY',
  'RUVNET_MEASUREMENT_SIGNING_KEY', 'RUVNET_ORACLE_REPORT_SIGNING_KEY', 'RUVNET_ORACLE_PRODUCTION_SIGNING_KEY',
]);

export function subscriptionOnlyEnv(parent = process.env) {
  const child = { ...parent, RUVNET_SUBSCRIPTION_ONLY: '1' };
  for (const name of API_BILLING_ENV) delete child[name];
  for (const name of PRIVATE_SIGNING_ENV) delete child[name];
  return child;
}

function execute(run, binary, args) {
  return run(binary, args, {
    encoding: 'utf8',
    env: subscriptionOnlyEnv(),
    timeout: 15_000,
  });
}

function unavailable(host, auth = 'unknown', reason = 'subscription login not verified') {
  return { host, eligible: false, auth, reason };
}

export function probeClaudeSubscription({ run = spawnSync } = {}) {
  let result;
  try {
    result = execute(run, 'claude', ['auth', 'status', '--json']);
  } catch {
    return unavailable('claude-code');
  }
  if (result?.status !== 0) return unavailable('claude-code');

  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    return unavailable('claude-code');
  }

  if (
    status.loggedIn === true
    && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty'
    && typeof status.subscriptionType === 'string'
    && status.subscriptionType.length > 0
  ) {
    return {
      host: 'claude-code',
      eligible: true,
      auth: 'claude.ai-subscription',
      plan: status.subscriptionType,
      reason: 'verified by claude auth status',
    };
  }

  return unavailable(
    'claude-code',
    status.loggedIn ? 'metered-or-unknown' : 'unknown',
    'Claude is not using a verified claude.ai subscription',
  );
}

export function probeCodexSubscription({ run = spawnSync } = {}) {
  let result;
  try {
    result = execute(run, 'codex', ['login', 'status']);
  } catch {
    return unavailable('codex');
  }
  if (result?.status !== 0) return unavailable('codex');

  const status = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim();
  if (/(?:^|\n)Logged in using ChatGPT(?:\n|$)/i.test(status)) {
    return {
      host: 'codex',
      eligible: true,
      auth: 'chatgpt-subscription',
      reason: 'verified by codex login status',
    };
  }
  return unavailable(
    'codex',
    /api key/i.test(status) ? 'metered-or-unknown' : 'unknown',
    'Codex is not using a verified ChatGPT login',
  );
}

export function probeSubscriptionHosts(options = {}) {
  return {
    claude: probeClaudeSubscription(options),
    codex: probeCodexSubscription(options),
  };
}
