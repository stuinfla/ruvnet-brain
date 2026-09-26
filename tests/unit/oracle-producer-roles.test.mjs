// tests/unit/oracle-producer-roles.test.mjs
//
// PATH B for the ADR-086 C3 oracle producer: codex (gpt-6-astra) GENERATES and claude JUDGES.
//
// Approved 2026-09-14 by an Astra-only Dual deliberation (verifier ACCEPT_WITH_CORRECTIONS) because the
// Fable weekly quota is exhausted and C3 requires source-grounded generation plus INDEPENDENT validation,
// not Claude as the generator. The same deliberation attached conditions, and each one is a case here:
//   - same-vendor production is not independent validation and must be refused;
//   - the judge must also rule on whether the paraphrase preserves the direct question's meaning;
//   - a host capacity refusal is an ordinary outcome: SUSPEND, never silently shrink the denominator;
//   - no automatic retries on refusal; checkpoint reuse only under the identical configuration.
//
// NO MODEL IS EVER CALLED HERE. Every host invocation goes through an injected spawn stub.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexPrompt, hostAdapters, isQuotaRefusal, produceQuestions,
} from '../../scripts/oracle/produce-questions.mjs';
import { API_BILLING_ENV } from '../../scripts/subscription-hosts.mjs';
import { gitBlobSha, sha256Hex } from '../../scripts/oracle/source-units.mjs';

const HOSTS_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/oracle/producer-hosts.mjs');
const UNIT_BODY = ['## Retry policy', '', 'The client retries a failed request up to three times before giving up entirely.'].join('\n');
const PATH_B = Object.freeze({ generator: 'codex', judge: 'claude' });

const idsIn = (input, re) => [...String(input).matchAll(re)].map((m) => m[1]);
const reply = (binary, structured) => (binary === 'claude'
  ? { status: 0, timedOut: false, durationMs: 1, stderr: '', stdout: JSON.stringify({ structured_output: structured, modelUsage: { 'claude-opus-5': {} } }) }
  : { status: 0, timedOut: false, durationMs: 1, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(structured) } }) });

/** Answers generation and judging for whichever host is asked; `failGenerator(n, binary)` can intercept the nth generation call. */
function hostStub(calls, { failGenerator = () => null } = {}) {
  return async (binary, args, options, input) => {
    calls.push({ binary, args, input, env: options.env, cwd: options.cwd });
    if (String(input).includes('===UNIT')) {
      const failure = failGenerator(calls.filter((c) => String(c.input).includes('===UNIT')).length, binary);
      if (failure) return failure;
      return reply(binary, {
        labels: idsIn(input, /unitId=(\S+)/g).map((unitId) => ({
          unitId, direct: `How many retries does the client make for ${unitId}?`, paraphrase: `What is the retry ceiling applied to ${unitId}?`,
          span: 'up to three times', spanStartLine: 3, spanEndLine: 3, skip: false, reason: '',
        })),
      });
    }
    return reply(binary, { verdicts: idsIn(input, /--- id=(\S+)/g).map((id) => ({ id, answers: 'yes', reason: 'ok' })) });
  };
}

describe('the hard fence also covers the host module, where invocation code now lives', () => {
  it('producer-hosts.mjs CODE never names a provider API key or a network endpoint', () => {
    const code = fs.readFileSync(HOSTS_MODULE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .split('\n').filter((l) => !l.includes('API_BILLING_ENV')).join('\n');
    for (const name of API_BILLING_ENV) expect(code).not.toContain(name);
    expect(code).not.toMatch(/api\.openai\.com|openrouter\.ai|api\.anthropic\.com/);
    expect(code).not.toMatch(/\bfetch\s*\(|node-fetch|axios|https?:\/\//);
    expect(code).not.toContain("'--bare'");
  });
});

describe('path B: codex generates, claude judges', () => {
  let root;
  let blobSha;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-roles-'));
    fs.writeFileSync(path.join(root, 'doc.md'), `# T\n\n${UNIT_BODY}\n`);
    blobSha = gitBlobSha(fs.readFileSync(path.join(root, 'doc.md')));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const inventory = (count = 1) => ({
    repo: 'r', commit: 'c', rulesVersion: 'v1',
    selected: Array.from({ length: count }, (_, i) => ({
      unitId: `u${i}`, path: 'doc.md', blobSha, startLine: 3, endLine: 5,
      bytesSha256: sha256Hex(Buffer.from(UNIT_BODY, 'utf8')), kind: 'md-section', language: 'markdown',
    })),
  });
  const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-roles-work-'));

  it('runs codex then claude, the judge sees no unit text or path, and verdicts land on `judge`', async () => {
    const calls = [];
    const out = await produceQuestions({ inventory: inventory(), snapshotDir: root, roles: PATH_B, spawnImpl: hostStub(calls), workDir: workDir() });
    expect(calls.map((c) => c.binary)).toEqual(['codex', 'claude']);
    for (const name of API_BILLING_ENV) for (const c of calls) expect(c.env[name]).toBeUndefined();
    const judgeInput = calls[1].input;
    expect(judgeInput).toContain('up to three times');
    expect(judgeInput).not.toContain('## Retry policy');
    expect(judgeInput).not.toContain('doc.md');
    expect(calls[1].args).toContain('--json-schema');
    expect(calls[1].args.join(' ')).toContain('verdicts');
    const [label] = out.labels;
    expect(label.judge).toMatchObject({ host: 'claude', direct: { answers: 'yes' }, paraphrase: { answers: 'yes' }, equivalent: { answers: 'yes' } });
    expect(label.codex).toBeUndefined(); // the historical codex-shaped record exists only when codex judged
    expect(out.roles).toEqual(PATH_B);
    expect(out.producer.generator.host).toBe('codex');
    expect(out.producer.judge.host).toBe('claude');
  });

  it('asks the judge whether the paraphrase MEANS the same thing, as questions only', () => {
    const prompt = codexPrompt([{ id: 'u0:e', questionA: 'How many retries?', questionB: 'What is the retry ceiling?' }]);
    expect(prompt).toContain('QUESTION A: How many retries?');
    expect(prompt).toContain('QUESTION B: What is the retry ceiling?');
    expect(prompt).not.toContain('SPAN:');
  });

  it('MUST REFUSE same-vendor production: it is not independent validation', async () => {
    const minimal = { schemaFiles: { labels: 'l.json', verdicts: 'v.json' }, workDir: os.tmpdir(), codexCwd: os.tmpdir() };
    expect(() => hostAdapters({ ...minimal, roles: { generator: 'codex', judge: 'codex' } })).toThrow(/same-vendor production/);
    expect(() => hostAdapters({ ...minimal, roles: { generator: 'claude', judge: 'claude' } })).toThrow(/same-vendor production/);
    await expect(produceQuestions({
      inventory: inventory(), snapshotDir: root, roles: { generator: 'codex', judge: 'codex' }, spawnImpl: hostStub([]), workDir: workDir(),
    })).rejects.toThrow(/same-vendor production/);
  });

  it('MUST SUSPEND on a capacity refusal: no further calls to ANY host, remaining units recorded unproduced', async () => {
    const calls = [];
    const refusal = { status: 1, timedOut: false, durationMs: 1, stdout: '', stderr: 'Error: usage limit reached, try again later' };
    const out = await produceQuestions({
      inventory: inventory(3), snapshotDir: root, roles: PATH_B, batchSize: 1,
      spawnImpl: hostStub(calls, { failGenerator: (n) => (n === 2 ? refusal : null) }), workDir: workDir(),
    });
    expect(calls.map((c) => c.binary)).toEqual(['codex', 'codex']); // the judge is never reached once suspended
    expect(out.suspended).toMatchObject({ host: 'codex', stage: 'generator', batchIndex: 1 });
    const [u0, u1, u2] = out.labels;
    expect(u0.direct).toBeTruthy();
    expect(u0.judge.direct).toEqual({ error: 'suspended' });
    expect(u1.producerError).toMatch(/exit 1: .*usage limit reached/);
    expect(u2.producerError).toBe('suspended: codex refused for capacity');
    expect(out.labels).toHaveLength(3); // nothing silently dropped
    expect(out.calls.find((c) => c.quotaRefusal)).toBeTruthy();
  });

  it('retries a malformed reply when asked to, but NEVER retries a capacity refusal', async () => {
    const malformedCalls = [];
    const garbage = { status: 0, timedOut: false, durationMs: 1, stdout: 'garbage', stderr: '' };
    const recovered = await produceQuestions({
      inventory: inventory(), snapshotDir: root, roles: PATH_B, retries: 1,
      spawnImpl: hostStub(malformedCalls, { failGenerator: (n) => (n === 1 ? garbage : null) }), workDir: workDir(),
    });
    expect(malformedCalls.filter((c) => c.binary === 'codex')).toHaveLength(2);
    expect(recovered.labels[0].producerError).toBeUndefined();

    const refusedCalls = [];
    const refusal = { status: 1, timedOut: false, durationMs: 1, stdout: '', stderr: '429 Too Many Requests' };
    const refused = await produceQuestions({
      inventory: inventory(), snapshotDir: root, roles: PATH_B, retries: 3,
      spawnImpl: hostStub(refusedCalls, { failGenerator: () => refusal }), workDir: workDir(),
    });
    expect(refusedCalls).toHaveLength(1);
    expect(refused.suspended).toBeTruthy();
  });

  it('reuses a checkpoint ONLY under the identical producer configuration', async () => {
    const dir = workDir();
    const checkpointFile = path.join(dir, 'checkpoint.json');
    const first = await produceQuestions({ inventory: inventory(2), snapshotDir: root, roles: PATH_B, checkpointFile, spawnImpl: hostStub([]), workDir: dir });
    expect(fs.existsSync(checkpointFile)).toBe(true);
    expect(first.checkpoint.reusedUnits).toBe(0);

    // Same configuration: every unit is reused, so NO host is called at all.
    const resumedCalls = [];
    const resumed = await produceQuestions({ inventory: inventory(2), snapshotDir: root, roles: PATH_B, checkpointFile, spawnImpl: hostStub(resumedCalls), workDir: dir });
    expect(resumedCalls).toHaveLength(0);
    expect(resumed.checkpoint.reusedUnits).toBe(2);
    expect(resumed.labels.map((l) => l.judge?.equivalent?.answers)).toEqual(['yes', 'yes']);

    // A different configuration (effort) must NOT reuse labels produced under another prompt/model setup.
    const changedCalls = [];
    const changed = await produceQuestions({ inventory: inventory(2), snapshotDir: root, roles: PATH_B, effort: 'high', checkpointFile, spawnImpl: hostStub(changedCalls), workDir: dir });
    expect(changed.checkpoint.reusedUnits).toBe(0);
    expect(changedCalls.some((c) => c.binary === 'codex')).toBe(true);
  });

  it('recognizes capacity refusals without mistaking ordinary malformed output for one', () => {
    expect(isQuotaRefusal('Error: usage limit reached')).toBe(true);
    expect(isQuotaRefusal('HTTP 429 Too Many Requests')).toBe(true);
    expect(isQuotaRefusal('claude result is not JSON')).toBe(false);
    expect(isQuotaRefusal('codex emitted no agent_message')).toBe(false);
  });
});
