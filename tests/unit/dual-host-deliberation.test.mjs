import { describe, expect, it } from 'vitest';
import {
  chooseRoles,
  deliberate,
  hardProblem,
  main,
  persistDeliberationReceipt,
  runSubscriptionHost,
} from '../../scripts/dual-host-deliberation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const eligible = {
  claude: { host: 'claude-code', eligible: true, auth: 'claude.ai-subscription' },
  codex: { host: 'codex', eligible: true, auth: 'chatgpt-subscription' },
};

describe('hardProblem', () => {
  it.each([
    'Create an ADR for the storage migration',
    'Model the authentication bounded context and DDD aggregates',
    'Design a holistic Agentic-QE test suite for the user experience',
    'Review the security boundary before production migration',
  ])('detects consequential work: %s', (task) => {
    expect(hardProblem(task)).toBe(true);
  });

  it('does not turn an ordinary typo into a costly duel', () => {
    expect(hardProblem('fix the typo in the footer')).toBe(false);
  });
});

describe('chooseRoles', () => {
  it('is deterministic and gives both hosts the scribe role across tasks', () => {
    expect(chooseRoles('same task')).toEqual(chooseRoles('same task'));
    const scribes = new Set(Array.from({ length: 100 }, (_, i) => chooseRoles(`task-${i}`).scribe));
    expect(scribes).toEqual(new Set(['claude-code', 'codex']));
  });
});

describe('deliberate', () => {
  it('runs proposal, cross-critique, synthesis and verification through both hosts', async () => {
    const calls = [];
    const runHost = async (host, stage, payload) => {
      calls.push({ host, stage, payload });
      if (stage === 'proposal') return { ok: true, value: { host, plan: `${host}-plan` } };
      if (stage === 'critique') return { ok: true, value: { host, findings: [`review-${host}`] } };
      if (stage === 'synthesis') return { ok: true, value: { adr: {}, ddd: {}, qe: {}, unresolved: [] } };
      return { ok: true, value: { verdict: 'accept', corrections: [] } };
    };

    const out = await deliberate('Design the security architecture ADR', {
      cwd: '/tmp/project',
      probes: eligible,
      runHost,
      persist: async () => true,
    });

    expect(out.status).toBe('accepted');
    expect(out.dual).toBe(true);
    expect(out.learningPersisted).toBe(true);
    expect(calls.filter((c) => c.stage === 'proposal')).toHaveLength(2);
    expect(calls.filter((c) => c.stage === 'critique')).toHaveLength(2);
    expect(calls.filter((c) => c.stage === 'synthesis')).toHaveLength(1);
    expect(calls.filter((c) => c.stage === 'verify')).toHaveLength(1);
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(['claude-code', 'codex']));
  });

  it('returns an honestly labeled draft when one subscription is unavailable', async () => {
    const out = await deliberate('Create an ADR for the migration', {
      probes: {
        claude: { host: 'claude-code', eligible: false, auth: 'capacity-limited' },
        codex: eligible.codex,
      },
      runHost: async (host, stage) => ({
        ok: true,
        value: { host, stage, adr: {}, ddd: {}, qe: {} },
      }),
      persist: async () => false,
    });

    expect(out.status).toBe('degraded');
    expect(out.dual).toBe(false);
    expect(out.missing).toContain('claude-code');
    expect(out.learningPersisted).toBe(false);
    expect(out).not.toHaveProperty('verification');
  });

  it('never calls a model when neither subscription is eligible', async () => {
    let called = false;
    const out = await deliberate('Create an ADR', {
      probes: {
        claude: { host: 'claude-code', eligible: false, auth: 'unknown' },
        codex: { host: 'codex', eligible: false, auth: 'unknown' },
      },
      runHost: async () => { called = true; },
    });
    expect(called).toBe(false);
    expect(out.status).toBe('unavailable');
  });

  it('does not promote host completion into an accepted quality outcome', async () => {
    const runHost = async (host, stage) => {
      if (stage === 'verify') return { ok: true, value: { verdict: 'changes', corrections: ['missing oracle'] } };
      if (stage === 'revise') return { ok: true, value: { adr: {}, ddd: {}, qe: {} } };
      if (stage === 'reverify') return { ok: true, value: { verdict: 'block', corrections: ['still incomplete'] } };
      return { ok: true, value: { host, stage } };
    };
    const out = await deliberate('Build an Agentic-QE architecture', {
      probes: eligible,
      runHost,
    });
    expect(out.status).toBe('unresolved');
    expect(out.verifiedOutcome).toBe(false);
  });
});

describe('persistDeliberationReceipt', () => {
  it('returns the exact MCP memory_store request without invoking a local Ruflo process', async () => {
    const request = await persistDeliberationReceipt({
      protocol: 'dual-host-deliberation-v1',
      taskHash: 'abc123',
      hosts: ['claude-code', 'codex'],
      roles: { scribe: 'codex', verifier: 'claude-code' },
      accepted: true,
      rawPrompt: 'must not persist',
      transcript: 'must not persist',
      email: 'must-not-leak@example.com',
    }, {
      now: () => 1_785_240_000_000,
    });

    expect(request.name).toBe('memory_store');
    expect(request.tool).toBe('memory_store');
    expect(request.arguments.key).toBe('dual-deliberation-1785240000000-abc123');
    const value = JSON.parse(request.arguments.value);
    expect(value).toEqual({
      protocol: 'dual-host-deliberation-v1',
      taskHash: 'abc123',
      hosts: ['claude-code', 'codex'],
      roles: { scribe: 'codex', verifier: 'claude-code' },
      accepted: true,
      verifiedOutcome: true,
      recordedAt: '2026-07-28T12:00:00.000Z',
    });
    expect(request.arguments.value).not.toContain('must not persist');
    expect(request.arguments.value).not.toContain('must-not-leak');
  });

  it('accepts persistence only when the transport callback proves storage, verification, and exact key', async () => {
    const calls = [];
    const result = await persistDeliberationReceipt({ protocol: 'p', taskHash: 'abc123', hosts: [], roles: {}, accepted: true }, {
      now: () => 1_785_240_000_000,
      memoryStore: async (request) => {
        calls.push(request);
        return { stored: true, verified: true, key: request.arguments.key };
      },
    });
    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('memory_store');
  });

  it('rejects a transport result that does not prove the exact key', async () => {
    await expect(persistDeliberationReceipt({ protocol: 'p', taskHash: 'abc123', hosts: [], roles: {}, accepted: true }, {
      memoryStore: async () => ({ stored: true, verified: true, key: 'wrong-key' }),
    })).resolves.toBe(false);
  });
});

describe('deliberate persistence boundary', () => {
  it('returns a pending MCP request when no structured persistence callback is provided', async () => {
    const out = await deliberate('Design the security architecture ADR', {
      probes: eligible,
      now: () => 1_785_240_000_000,
      runHost: async (host, stage) => {
        if (stage === 'verify') return { ok: true, value: { verdict: 'accept' } };
        return { ok: true, value: { host, stage } };
      },
    });
    expect(out.status).toBe('accepted');
    expect(out.learningPersisted).toBe(false);
    expect(out.learningPersistenceRequest).toMatchObject({
      tool: 'memory_store',
      name: 'memory_store',
      arguments: { namespace: 'ruvnet-brain', key: expect.stringMatching(/^dual-deliberation-1785240000000-[0-9a-f]{12}$/) },
    });
  });

  it('passes the exact request to a structured callback and requires its proof', async () => {
    let request;
    const out = await deliberate('Design the security architecture ADR', {
      probes: eligible,
      now: () => 1_785_240_000_000,
      runHost: async (host, stage) => {
        if (stage === 'verify') return { ok: true, value: { verdict: 'accept' } };
        return { ok: true, value: { host, stage } };
      },
      persist: async (value) => {
        request = value;
        return { stored: true, verified: true, key: value.arguments.key };
      },
    });
    expect(out.learningPersisted).toBe(true);
    expect(request).toEqual(out.learningPersistenceRequest);
  });
});

describe('runSubscriptionHost prompt transport', () => {
  it('sends prompts over stdin, including prompts larger than 256 KiB, while retaining host flags', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-host-stdin-'));
    const bin = path.join(root, 'codex');
    fs.writeFileSync(bin, '#!/usr/bin/env node\nlet data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({length:data.length, argv:process.argv.slice(2)})}})));\n');
    fs.chmodSync(bin, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${previousPath}`;
    try {
      const result = await runSubscriptionHost('codex', 'proposal', { task: 'x'.repeat(300 * 1024) });
      expect(result.ok).toBe(true);
      expect(result.value.length).toBeGreaterThan(256 * 1024);
      expect(result.value.argv).toContain('--json');
      expect(result.value.argv).toContain('gpt-6-astra');
      expect(result.value.argv).not.toContain('x'.repeat(300 * 1024));
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('command entrypoint', () => {
  it('prints the deliberation result and returns a nonzero code unless both hosts accept', async () => {
    let output = '';
    const code = await main(['Create an ADR'], {
      deliberateFn: async () => ({ status: 'degraded', dual: false }),
      stdout: { write: (value) => { output += value; } },
      stderr: { write: () => {} },
    });
    expect(code).toBe(2);
    expect(JSON.parse(output)).toEqual({ status: 'degraded', dual: false });
  });

  it('refuses an empty task without invoking either host', async () => {
    let invoked = false;
    let error = '';
    const code = await main([], {
      deliberateFn: async () => { invoked = true; },
      stdout: { write: () => {} },
      stderr: { write: (value) => { error += value; } },
    });
    expect(code).toBe(64);
    expect(invoked).toBe(false);
    expect(error).toContain('Usage:');
  });
});
