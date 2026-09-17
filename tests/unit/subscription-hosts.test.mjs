import { describe, expect, it } from 'vitest';
import {
  API_BILLING_ENV,
  PRIVATE_SIGNING_ENV,
  probeClaudeSubscription,
  probeCodexSubscription,
  subscriptionOnlyEnv,
} from '../../scripts/subscription-hosts.mjs';

const result = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });

describe('subscriptionOnlyEnv', () => {
  it('removes every API-billing credential without mutating the parent environment', () => {
    const parent = { PATH: '/bin', HOME: '/tmp/home' };
    for (const name of API_BILLING_ENV) parent[name] = `canary-${name}`;
    for (const name of PRIVATE_SIGNING_ENV) parent[name] = `private-${name}`;
    const child = subscriptionOnlyEnv(parent);

    expect(child.PATH).toBe('/bin');
    expect(child.HOME).toBe('/tmp/home');
    expect(child.RUVNET_SUBSCRIPTION_ONLY).toBe('1');
    for (const name of API_BILLING_ENV) {
      expect(child).not.toHaveProperty(name);
      expect(parent[name]).toBe(`canary-${name}`);
    }
    for (const name of PRIVATE_SIGNING_ENV) {
      expect(child).not.toHaveProperty(name);
      expect(parent[name]).toBe(`private-${name}`);
    }
  });
});

describe('public subscription probes', () => {
  it('accepts a Claude claude.ai subscription and returns no account identity', () => {
    const run = (_bin, args, options) => {
      expect(args).toEqual(['auth', 'status', '--json']);
      for (const name of API_BILLING_ENV) expect(options.env).not.toHaveProperty(name);
      return result(0, JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
        email: 'must-not-leak@example.com',
        orgId: 'must-not-leak',
      }));
    };
    expect(probeClaudeSubscription({ run })).toEqual({
      host: 'claude-code',
      eligible: true,
      auth: 'claude.ai-subscription',
      plan: 'max',
      reason: 'verified by claude auth status',
    });
  });

  it('rejects Claude API-key auth even when logged in', () => {
    const run = () => result(0, JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
    }));
    expect(probeClaudeSubscription({ run })).toMatchObject({
      eligible: false,
      auth: 'metered-or-unknown',
    });
  });

  it('accepts only Codex ChatGPT login, never an API-key login', () => {
    expect(probeCodexSubscription({
      run: () => result(0, '', 'Logged in using ChatGPT\n'),
    })).toMatchObject({
      host: 'codex',
      eligible: true,
      auth: 'chatgpt-subscription',
    });
    expect(probeCodexSubscription({
      run: () => result(0, 'Logged in using an API key\n'),
    })).toMatchObject({
      eligible: false,
      auth: 'metered-or-unknown',
    });
  });

  it('treats malformed and failed probes as unknown instead of guessing', () => {
    expect(probeClaudeSubscription({
      run: () => result(0, 'not-json'),
    })).toMatchObject({ eligible: false, auth: 'unknown' });
    expect(probeCodexSubscription({
      run: () => result(1, '', 'not logged in'),
    })).toMatchObject({ eligible: false, auth: 'unknown' });
  });
});
