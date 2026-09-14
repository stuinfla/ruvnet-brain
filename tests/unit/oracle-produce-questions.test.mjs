import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BATCH, PRODUCER_MODELS, batchUnits, claudeArgs, claudePrompt, codexArgs, codexPrompt,
  loadUnitTexts, parseClaudeEnvelope, parseCodexJsonl, produceQuestions,
} from '../../scripts/oracle/produce-questions.mjs';
import { API_BILLING_ENV, subscriptionOnlyEnv } from '../../scripts/subscription-hosts.mjs';
import { gitBlobSha, sha256Hex } from '../../scripts/oracle/source-units.mjs';

/** NO MODEL IS EVER CALLED HERE. Every host invocation goes through an injected spawn stub. */

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/oracle/produce-questions.mjs');
const UNIT_BODY = ['## Retry policy', '', 'The client retries a failed request up to three times before giving up entirely.'].join('\n');

describe('the hard fence (owner mandate: zero out-of-pocket spend)', () => {
  it('the producer CODE never names a provider API key (comments may explain the fence; code may not read one)', () => {
    const src = fs.readFileSync(MODULE, 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments — where the --bare rationale lives
      .replace(/^\s*\/\/.*$/gm, '')           // line comments
      .split('\n').filter((l) => !l.includes('API_BILLING_ENV')) // the fence is applied, never read
      .join('\n');
    for (const name of API_BILLING_ENV) expect(code).not.toContain(name);
    expect(code).not.toMatch(/process\.env\.(OPENROUTER|OPENAI|ANTHROPIC|GOOGLE|GEMINI|XAI)_API_KEY/);
    expect(code).not.toMatch(/api\.openai\.com|openrouter\.ai|api\.anthropic\.com/);
    expect(code).not.toMatch(/\bfetch\s*\(|node-fetch|axios|https?:\/\//); // no direct network path at all
  });

  it('refuses to run if a billing key somehow survives into the child environment', async () => {
    const inventory = { repo: 'r', commit: 'c', selected: [] };
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-should-be-stripped';
    try {
      // subscriptionOnlyEnv strips it, so this MUST succeed and record the parent/child asymmetry.
      const out = await produceQuestions({ inventory, snapshotDir: os.tmpdir(), spawnImpl: async () => { throw new Error('no host should be spawned for zero units'); }, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fence-')) });
      expect(out.envAudit.parentHadBillingKeys).toContain('OPENROUTER_API_KEY');
      expect(out.envAudit.childHadBillingKeys).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('pins subscription-billed host invocations only — never an API-key flag or a third-party base URL', () => {
    const claude = claudeArgs();
    expect(claude).toContain('-p');
    expect(claude).toContain('--output-format');
    expect(claude).toContain('--json-schema');
    expect(claude[claude.indexOf('--model') + 1]).toBe(PRODUCER_MODELS.claude);
    expect(claude).not.toContain('--api-key');
    // `--bare` would force ANTHROPIC_API_KEY auth (its own help text) — the opposite of the fence.
    expect(claude).not.toContain('--bare');
    const codex = codexArgs({ schemaFile: '/tmp/s.json' });
    expect(codex.slice(0, 2)).toEqual(['exec', '--ephemeral']);
    expect(codex).toContain('--sandbox');
    expect(codex[codex.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(codex[codex.indexOf('-m') + 1]).toBe(PRODUCER_MODELS.codex);
  });
});

describe('batching and prompt construction', () => {
  it('batches to the requested size and keeps every unit exactly once', () => {
    const units = Array.from({ length: 47 }, (_, i) => i);
    const batches = batchUnits(units, DEFAULT_BATCH);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 7]);
    expect(batches.flat()).toEqual(units);
  });

  it('the claude prompt carries verbatim unit bytes and the unit id, and nothing from any candidate corpus', () => {
    const prompt = claudePrompt([{ unit: { unitId: 'abc123', path: 'docs/x.md', kind: 'md-section' }, text: UNIT_BODY, truncated: false }]);
    expect(prompt).toContain('===UNIT unitId=abc123 path=docs/x.md kind=md-section');
    expect(prompt).toContain(UNIT_BODY);
    expect(prompt).toContain('===END');
    expect(prompt).not.toMatch(/rvf|passage|retriev|candidate|corpus/i);
  });

  it('the codex prompt shows ONLY question and span — never the unit, path or repo', () => {
    const prompt = codexPrompt([{ id: 'abc123:d', question: 'How many retries?', span: 'up to three times' }]);
    expect(prompt).toContain('id=abc123:d');
    expect(prompt).toContain('How many retries?');
    expect(prompt).toContain('up to three times');
    expect(prompt).not.toContain('## Retry policy');
    expect(prompt).not.toContain('docs/x.md');
  });
});

describe('host envelope parsing', () => {
  it('reads claude structured output, and falls back to parsing result when absent', () => {
    expect(parseClaudeEnvelope(JSON.stringify({ structured_output: { labels: [{ unitId: 'a' }] } })).structured.labels).toHaveLength(1);
    expect(parseClaudeEnvelope(JSON.stringify({ result: '{"labels":[]}' })).structured.labels).toEqual([]);
    expect(parseClaudeEnvelope('not json').error).toMatch(/not a JSON envelope/);
    expect(parseClaudeEnvelope(JSON.stringify({ is_error: true, subtype: 'error_max_turns' })).error).toMatch(/is_error/);
    expect(parseClaudeEnvelope(JSON.stringify({ structured_output: { nope: 1 } })).error).toMatch(/lacks labels/);
  });

  it('takes the LAST codex agent_message, so an unrelated hook message cannot be mistaken for the answer', () => {
    const jsonl = [
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Exceeded skills context budget.' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RuvNet Brain reports retrieval is down.' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"verdicts":[{"id":"x:d","answers":"yes","reason":"r"}]}' } }),
    ].join('\n');
    const parsed = parseCodexJsonl(jsonl);
    expect(parsed.structured.verdicts).toHaveLength(1);
    expect(parsed.errors).toEqual(['Exceeded skills context budget.']);
    expect(parseCodexJsonl('').error).toMatch(/no agent_message/);
    expect(parseCodexJsonl(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'plain prose' } })).error).toMatch(/not JSON/);
  });
});

describe('unit texts are re-read from disk and pinned', () => {
  let root;
  let blobSha;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-producer-'));
    fs.writeFileSync(path.join(root, 'doc.md'), `# T\n\n${UNIT_BODY}\n`);
    blobSha = gitBlobSha(fs.readFileSync(path.join(root, 'doc.md')));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const unit = () => ({ unitId: 'u1', path: 'doc.md', blobSha, startLine: 3, endLine: 5, bytesSha256: sha256Hex(Buffer.from(UNIT_BODY, 'utf8')) });

  it('loads the exact unit text', () => {
    expect(loadUnitTexts(root, [unit()])[0].text).toBe(UNIT_BODY);
  });
  it('RED: refuses when the file on disk no longer matches the pinned blob sha', () => {
    expect(() => loadUnitTexts(root, [{ ...unit(), blobSha: 'f'.repeat(40) }])).toThrow(/blob drift/);
  });
  it('RED: refuses when the line span no longer hashes to the pinned unit bytes', () => {
    expect(() => loadUnitTexts(root, [{ ...unit(), bytesSha256: 'f'.repeat(64) }])).toThrow(/unit drift/);
  });
});

describe('produceQuestions with a stubbed spawn (no model, no network)', () => {
  let root;
  let blobSha;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-producer2-'));
    fs.writeFileSync(path.join(root, 'doc.md'), `# T\n\n${UNIT_BODY}\n`);
    blobSha = gitBlobSha(fs.readFileSync(path.join(root, 'doc.md')));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const inventory = () => ({
    repo: 'r', commit: 'c', rulesVersion: 'v1',
    selected: [{ unitId: 'u1', path: 'doc.md', blobSha, startLine: 3, endLine: 5, bytesSha256: sha256Hex(Buffer.from(UNIT_BODY, 'utf8')), kind: 'md-section', language: 'markdown' }],
  });
  const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-work-'));

  const stub = (calls) => async (binary, args, options, input) => {
    calls.push({ binary, args, input, cwd: options.cwd, env: options.env });
    if (binary === 'claude') {
      return { status: 0, timedOut: false, durationMs: 5, stderr: '', stdout: JSON.stringify({
        structured_output: { labels: [{ unitId: 'u1', direct: 'How many retries?', paraphrase: 'What is the retry ceiling?', span: 'up to three times', spanStartLine: 3, spanEndLine: 3, skip: false, reason: '' }] },
        num_turns: 2, total_cost_usd: 0.07, modelUsage: { 'claude-fable-5-1': {} }, usage: { input_tokens: 2, output_tokens: 40 },
      }) };
    }
    return { status: 0, timedOut: false, durationMs: 7, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdicts: [
      { id: 'u1:d', answers: 'yes', reason: 'ok' }, { id: 'u1:p', answers: 'no', reason: 'insufficient' },
    ] }) } }) };
  };

  it('runs both passes, records both verdicts, and strips billing keys from the child env', async () => {
    const calls = [];
    const out = await produceQuestions({ inventory: inventory(), snapshotDir: root, spawnImpl: stub(calls), workDir: workDir() });
    expect(calls.map((c) => c.binary)).toEqual(['claude', 'codex']);
    for (const name of API_BILLING_ENV) for (const c of calls) expect(c.env[name]).toBeUndefined();
    // Derived, never restated: the child must carry the SAME marker the shared helper produces,
    // which is what proves the producer built its env through subscriptionOnlyEnv() rather than by hand.
    expect(calls[0].env.RUVNET_SUBSCRIPTION_ONLY).toBe(subscriptionOnlyEnv().RUVNET_SUBSCRIPTION_ONLY);
    expect(out.labels[0]).toMatchObject({ unitId: 'u1', direct: 'How many retries?', span: 'up to three times' });
    expect(out.labels[0].codex).toEqual({ direct: { answers: 'yes', reason: 'ok' }, paraphrase: { answers: 'no', reason: 'insufficient' } });
    expect(out.calls.map((c) => [c.host, c.ok])).toEqual([['claude', true], ['codex', true]]);
    expect(out.calls[0].reportedCostEstimateUsd).toBe(0.07);
  });

  it('the codex pass receives the span but NEVER the unit text', async () => {
    const calls = [];
    await produceQuestions({ inventory: inventory(), snapshotDir: root, spawnImpl: stub(calls), workDir: workDir() });
    const codexInput = calls.find((c) => c.binary === 'codex').input;
    expect(codexInput).toContain('up to three times');
    expect(codexInput).not.toContain('## Retry policy');
    expect(codexInput).not.toContain('doc.md');
  });

  it('RED: a non-zero host exit becomes a per-label producerError, never a silent drop', async () => {
    const failing = async (binary) => (binary === 'claude'
      ? { status: 1, timedOut: false, durationMs: 3, stdout: '', stderr: 'usage limit reached' }
      : { status: 0, timedOut: false, durationMs: 1, stdout: '', stderr: '' });
    const out = await produceQuestions({ inventory: inventory(), snapshotDir: root, spawnImpl: failing, workDir: workDir() });
    expect(out.labels).toHaveLength(1);
    expect(out.labels[0].producerError).toMatch(/exit 1.*usage limit reached/);
    expect(out.calls[0]).toMatchObject({ host: 'claude', ok: false });
  });

  it('RED: a timeout becomes a producerError', async () => {
    const timing = async () => ({ status: null, timedOut: true, durationMs: 99, stdout: '', stderr: '' });
    const out = await produceQuestions({ inventory: inventory(), snapshotDir: root, spawnImpl: timing, workDir: workDir() });
    expect(out.labels[0].producerError).toBe('timeout');
  });

  it('RED: a unit the host omits from its reply is marked missing, not silently lost', async () => {
    const omitting = async (binary) => (binary === 'claude'
      ? { status: 0, timedOut: false, durationMs: 4, stderr: '', stdout: JSON.stringify({ structured_output: { labels: [] } }) }
      : { status: 0, timedOut: false, durationMs: 1, stdout: '', stderr: '' });
    const out = await produceQuestions({ inventory: inventory(), snapshotDir: root, spawnImpl: omitting, workDir: workDir() });
    expect(out.labels[0].producerError).toBe('unit missing from claude output');
  });

  it('respects the call budget instead of spending unbounded subscription calls', async () => {
    const many = { ...inventory(), selected: Array.from({ length: 5 }, (_, i) => ({ ...inventory().selected[0], unitId: `u${i}` })) };
    const calls = [];
    const out = await produceQuestions({ inventory: many, snapshotDir: root, spawnImpl: stub(calls), workDir: workDir(), batchSize: 1, maxClaudeCalls: 2, maxCodexCalls: 1 });
    expect(calls.filter((c) => c.binary === 'claude')).toHaveLength(2);
    expect(out.labels.filter((l) => l.producerError === 'claude call budget exhausted')).toHaveLength(3);
  });
});
