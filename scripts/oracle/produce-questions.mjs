#!/usr/bin/env node
/**
 * scripts/oracle/produce-questions.mjs — Step 14 (ADR-086 C3) SUBSCRIPTION-ONLY semantic label producer.
 *
 * Two independent passes over the units selected by source-units.mjs, both on subscription-billed
 * native hosts and NEVER on a provider API key:
 *
 *   1. `claude -p` (Claude Max) sees the exact upstream bytes of 15–25 units per call and must emit,
 *      per unit, one direct question, one meaning-preserving paraphrase, and the VERBATIM supporting
 *      span (plus the span's line range inside the unit) as strict structured output (--json-schema).
 *   2. `codex exec` (ChatGPT subscription, different vendor) sees ONLY question + candidate span —
 *      never the unit, path or repo — and answers whether the span alone answers the question.
 *
 * Fence (owner mandate): the child environment is scripts/subscription-hosts.mjs#subscriptionOnlyEnv,
 * which deletes every API_BILLING_ENV name; this module never reads those names itself (the unit
 * test greps this file for them). `--bare` is deliberately NOT used: its help text says auth then
 * becomes "strictly ANTHROPIC_API_KEY ... OAuth and keychain are never read" — the opposite of the
 * fence. Context is minimised instead with --system-prompt, --tools "", --strict-mcp-config,
 * --disable-slash-commands and --setting-sources "" (measured 2026-09-13: 1,009 prompt tokens vs
 * ~100k with the defaults; both shapes authenticated as claude.ai / max).
 *
 * The producer sees upstream bytes only. Nothing here reads a candidate corpus, RVF, passage sidecar
 * or retrieval output — by construction, not by promise (inputs: inventory JSON + snapshot dir).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API_BILLING_ENV, subscriptionOnlyEnv } from '../subscription-hosts.mjs';
import { gitBlobSha, sha256Hex, unitText } from './source-units.mjs';

// Pinned on 2026-09-13 against the native hosts (same ids scripts/dual-host-deliberation.mjs pins).
export const PRODUCER_MODELS = Object.freeze({ claude: 'claude-fable-5-1', codex: 'gpt-6-astra' });
export const DEFAULT_BATCH = 20;
export const MAX_UNIT_CHARS = 6000;
export const CLAUDE_TIMEOUT_MS = 900_000;
export const CODEX_TIMEOUT_MS = 600_000;

const labelItem = {
  type: 'object', additionalProperties: false,
  properties: {
    unitId: { type: 'string' }, direct: { type: 'string' }, paraphrase: { type: 'string' }, span: { type: 'string' },
    spanStartLine: { type: 'integer' }, spanEndLine: { type: 'integer' }, skip: { type: 'boolean' }, reason: { type: 'string' },
  },
  required: ['unitId', 'direct', 'paraphrase', 'span', 'spanStartLine', 'spanEndLine', 'skip', 'reason'],
};
export const LABEL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, properties: { labels: { type: 'array', items: labelItem } }, required: ['labels'],
});
export const VERDICT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, answers: { type: 'string', enum: ['yes', 'no'] }, reason: { type: 'string' } },
        required: ['id', 'answers', 'reason'],
      },
    },
  },
  required: ['verdicts'],
});

export const CLAUDE_SYSTEM_PROMPT = 'You write retrieval-benchmark labels for source text. You see only the units in the message, '
  + 'you have no tools, and you must not use anything outside them. Return only the structured output.';

export function batchUnits(units, size = DEFAULT_BATCH) {
  const out = [];
  for (let i = 0; i < units.length; i += size) out.push(units.slice(i, i + size));
  return out;
}

/** Re-read every selected unit from disk and refuse drift: blob and unit hashes must match the inventory. */
export function loadUnitTexts(snapshotDir, units) {
  const cache = new Map();
  return units.map((unit) => {
    if (!cache.has(unit.path)) {
      const buf = fs.readFileSync(path.join(snapshotDir, unit.path));
      cache.set(unit.path, { blobSha: gitBlobSha(buf), lines: buf.toString('utf8').split('\n') });
    }
    const file = cache.get(unit.path);
    if (file.blobSha !== unit.blobSha) throw new Error(`blob drift: ${unit.path} is ${file.blobSha}, inventory says ${unit.blobSha}`);
    const text = unitText(file.lines, unit.startLine, unit.endLine);
    if (sha256Hex(Buffer.from(text, 'utf8')) !== unit.bytesSha256) throw new Error(`unit drift: ${unit.unitId} ${unit.path}:${unit.startLine}-${unit.endLine}`);
    const truncated = text.length > MAX_UNIT_CHARS;
    return { unit, text: truncated ? text.slice(0, MAX_UNIT_CHARS) : text, truncated };
  });
}

export function claudePrompt(batch) {
  const head = [
    'Write labels for each UNIT below. Return exactly one object per unit, in order:',
    '- unitId: copy exactly.',
    '- direct: one specific question (8-30 words) answerable ONLY from this unit\'s text. Do not reuse more than 4 consecutive words of the answer text inside the question.',
    '- paraphrase: reword the direct question so it keeps the same meaning and the same answer but uses different words and a different sentence structure.',
    '- span: the EXACT contiguous substring of the unit text that answers the question. Copy it character-for-character: same spelling, casing, punctuation, whitespace and line breaks. 1-4 sentences of prose or 1-12 lines of code. Never the heading line alone; never the whole unit.',
    '- spanStartLine, spanEndLine: 1-based line numbers of that span INSIDE the unit text (line 1 is the first line after the ===UNIT marker).',
    '- skip: true only if the unit has no askable factual content; then set direct/paraphrase/span to "" and the line numbers to 0 and explain in reason. Otherwise reason is "".',
    'Do not invent facts. The text between ===UNIT and ===END is verbatim source.',
    '',
  ];
  const body = batch.map(({ unit, text, truncated }) => [
    `===UNIT unitId=${unit.unitId} path=${unit.path} kind=${unit.kind} lines=${text.split('\n').length}${truncated ? ' truncated=true' : ''}`,
    text,
    '===END',
  ].join('\n'));
  return head.concat(body).join('\n');
}

export function claudeArgs({ model = PRODUCER_MODELS.claude, effort = 'medium', schema = LABEL_SCHEMA } = {}) {
  return [
    '-p', '--output-format', 'json', '--model', model, '--effort', effort, '--tools', '', '--no-session-persistence',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--system-prompt', CLAUDE_SYSTEM_PROMPT, '--json-schema', JSON.stringify(schema),
  ];
}

export function codexPrompt(pairs) {
  const head = [
    'You are an independent verifier. For each item you receive a QUESTION and a SPAN of text.',
    'Decide whether the SPAN ALONE contains information sufficient to answer the QUESTION correctly and specifically.',
    'Use no outside knowledge. Do not read files or run commands. Return one verdict per item with the same id.',
    '',
  ];
  const body = pairs.map(({ id, question, span }) => `--- id=${id}\nQUESTION: ${question}\nSPAN:\n${span}\n`);
  return head.concat(body).join('\n');
}

export function codexArgs({ model = PRODUCER_MODELS.codex, effort = 'medium', schemaFile } = {}) {
  return [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--json',
    '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--output-schema', schemaFile,
  ];
}

export function parseClaudeEnvelope(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { return { error: 'claude stdout is not a JSON envelope' }; }
  if (envelope.is_error) return { error: `claude reported is_error (${envelope.subtype})`, envelope };
  let structured = envelope.structured_output;
  if (structured === undefined && typeof envelope.result === 'string') {
    try { structured = JSON.parse(envelope.result); } catch { return { error: 'claude result is not JSON', envelope }; }
  }
  if (!structured || !Array.isArray(structured.labels)) return { error: 'claude output lacks labels[]', envelope };
  return { structured, envelope };
}

/** Codex emits JSONL; hooks on this machine inject unrelated agent_messages first, so only the LAST one counts. */
export function parseCodexJsonl(stdout) {
  const messages = [];
  const errors = [];
  for (const line of String(stdout).split('\n')) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value.type !== 'item.completed') continue;
    if (value.item?.type === 'agent_message') messages.push(value.item.text);
    if (value.item?.type === 'error') errors.push(value.item.message);
  }
  const last = messages.at(-1);
  if (last === undefined) return { error: 'codex emitted no agent_message', errors };
  try {
    const structured = JSON.parse(last);
    if (!Array.isArray(structured.verdicts)) return { error: 'codex output lacks verdicts[]', errors };
    return { structured, errors };
  } catch {
    return { error: 'codex final message is not JSON', errors };
  }
}

export function spawnHost(binary, args, { cwd, env, timeoutMs }, input) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr: error ? `${stderr}\n${error.message}` : stderr, timedOut, durationMs: Date.now() - started });
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => { /* host closed stdin early; the close event still settles */ });
    child.on('error', (error) => finish(null, error));
    child.on('close', (status) => finish(status));
    child.stdin.end(input);
  });
}

function billingNamesPresent(env) { return API_BILLING_ENV.filter((name) => name in env); }

export async function produceQuestions({
  inventory, snapshotDir, batchSize = DEFAULT_BATCH, maxClaudeCalls = 8, maxCodexCalls = 8, effort = 'medium',
  models = PRODUCER_MODELS, spawnImpl = spawnHost, workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-producer-')),
  log = () => {},
}) {
  const env = subscriptionOnlyEnv();
  const envAudit = { parentHadBillingKeys: billingNamesPresent(process.env), childHadBillingKeys: billingNamesPresent(env) };
  if (envAudit.childHadBillingKeys.length) throw new Error(`fence violated: child env still carries ${envAudit.childHadBillingKeys.join(',')}`);
  fs.mkdirSync(workDir, { recursive: true }); // an explicitly-supplied workDir may not exist yet
  const schemaFile = path.join(workDir, 'verdict-schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(VERDICT_SCHEMA));
  const codexCwd = path.join(workDir, 'codex-empty-cwd');
  fs.mkdirSync(codexCwd, { recursive: true });

  const loaded = loadUnitTexts(snapshotDir, inventory.selected);
  const batches = batchUnits(loaded, batchSize);
  const calls = [];
  const labels = [];
  const byId = new Map(loaded.map((l) => [l.unit.unitId, l]));

  for (const [index, batch] of batches.entries()) {
    if (index >= maxClaudeCalls) {
      for (const { unit } of batch) labels.push(baseLabel(unit, { producerError: 'claude call budget exhausted' }));
      continue;
    }
    log(`[producer] claude batch ${index + 1}/${batches.length} (${batch.length} units)`);
    const result = await spawnImpl('claude', claudeArgs({ model: models.claude, effort }), { cwd: workDir, env, timeoutMs: CLAUDE_TIMEOUT_MS }, claudePrompt(batch));
    const parsed = result.status === 0 && !result.timedOut ? parseClaudeEnvelope(result.stdout) : { error: result.timedOut ? 'timeout' : `exit ${result.status}: ${result.stderr.slice(0, 300)}` };
    calls.push(callRecord('claude', index, batch.length, result, parsed, models.claude));
    if (parsed.error) {
      for (const { unit } of batch) labels.push(baseLabel(unit, { producerError: parsed.error }));
      continue;
    }
    const returned = new Map(parsed.structured.labels.map((l) => [l.unitId, l]));
    for (const { unit, truncated } of batch) {
      const l = returned.get(unit.unitId);
      if (!l) { labels.push(baseLabel(unit, { producerError: 'unit missing from claude output' })); continue; }
      labels.push(baseLabel(unit, {
        direct: l.direct, paraphrase: l.paraphrase, span: l.span, spanStartLine: l.spanStartLine, spanEndLine: l.spanEndLine,
        skip: l.skip === true, skipReason: l.skip ? l.reason : '', truncatedForProducer: truncated,
      }));
    }
  }

  const verifiable = labels.filter((l) => !l.producerError && !l.skip);
  const codexBatches = batchUnits(verifiable, batchSize);
  for (const [index, batch] of codexBatches.entries()) {
    if (index >= maxCodexCalls) { for (const l of batch) l.codex = { error: 'codex call budget exhausted' }; continue; }
    log(`[producer] codex batch ${index + 1}/${codexBatches.length} (${batch.length * 2} pairs)`);
    const pairs = batch.flatMap((l) => [
      { id: `${l.unitId}:d`, question: l.direct, span: l.span },
      { id: `${l.unitId}:p`, question: l.paraphrase, span: l.span },
    ]);
    const result = await spawnImpl('codex', codexArgs({ model: models.codex, effort, schemaFile }), { cwd: codexCwd, env, timeoutMs: CODEX_TIMEOUT_MS }, codexPrompt(pairs));
    const parsed = result.status === 0 && !result.timedOut ? parseCodexJsonl(result.stdout) : { error: result.timedOut ? 'timeout' : `exit ${result.status}: ${result.stderr.slice(0, 300)}` };
    calls.push(callRecord('codex', index, pairs.length, result, parsed, models.codex));
    const verdicts = new Map((parsed.structured?.verdicts || []).map((v) => [v.id, v]));
    for (const l of batch) {
      const d = verdicts.get(`${l.unitId}:d`);
      const p = verdicts.get(`${l.unitId}:p`);
      l.codex = parsed.error ? { error: parsed.error } : {
        direct: d ? { answers: d.answers, reason: d.reason } : { error: 'missing verdict' },
        paraphrase: p ? { answers: p.answers, reason: p.reason } : { error: 'missing verdict' },
      };
    }
  }
  void byId;
  return {
    schemaVersion: 1, kind: 'oracle-labels', repo: inventory.repo, commit: inventory.commit, rulesVersion: inventory.rulesVersion,
    producer: {
      claude: { binary: 'claude', requestedModel: models.claude, args: claudeArgs({ model: models.claude, effort }).filter((a) => !a.startsWith('{')), effort },
      codex: { binary: 'codex', requestedModel: models.codex, args: codexArgs({ model: models.codex, effort, schemaFile: '<schema>' }), effort },
      batchSize, note: 'total_cost_usd is the host\'s at-list-price estimate; both hosts were verified subscription-authenticated (claude.ai/max, ChatGPT) and no provider key was present in the child env.',
    },
    envAudit, calls, labels,
  };
}

function baseLabel(unit, extra) {
  return {
    unitId: unit.unitId, path: unit.path, blobSha: unit.blobSha, startLine: unit.startLine, endLine: unit.endLine,
    bytesSha256: unit.bytesSha256, kind: unit.kind, language: unit.language, ...extra,
  };
}

function callRecord(host, batchIndex, items, result, parsed, requestedModel) {
  const rec = {
    host, batchIndex, items, requestedModel, status: result.status, timedOut: result.timedOut, durationMs: result.durationMs,
    ok: !parsed.error, error: parsed.error,
  };
  if (host === 'claude' && parsed.envelope) {
    const e = parsed.envelope;
    rec.modelUsage = Object.keys(e.modelUsage || {});
    rec.numTurns = e.num_turns;
    rec.reportedCostEstimateUsd = e.total_cost_usd;
    rec.usage = e.usage && { input: e.usage.input_tokens, cacheCreate: e.usage.cache_creation_input_tokens, cacheRead: e.usage.cache_read_input_tokens, output: e.usage.output_tokens };
    rec.returnedLabels = parsed.structured?.labels?.length;
  }
  if (host === 'codex') {
    rec.hostErrors = parsed.errors || [];
    rec.returnedVerdicts = parsed.structured?.verdicts?.length;
  }
  if (parsed.error) rec.stderrTail = String(result.stderr || '').slice(-400);
  return rec;
}

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv = process.argv.slice(2)) {
  const inventoryFile = arg(argv, '--inventory');
  const snapshotDir = arg(argv, '--dir');
  const out = arg(argv, '--out');
  if (!inventoryFile || !snapshotDir || !out) {
    process.stderr.write('Usage: produce-questions.mjs --inventory <inventory.json> --dir <snapshot> --out <labels.json> [--batch 20] [--max-claude-calls 8] [--max-codex-calls 8] [--effort medium]\n');
    return 64;
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  const labels = await produceQuestions({
    inventory, snapshotDir: path.resolve(snapshotDir),
    batchSize: Number(arg(argv, '--batch') || DEFAULT_BATCH),
    maxClaudeCalls: Number(arg(argv, '--max-claude-calls') || 8),
    maxCodexCalls: Number(arg(argv, '--max-codex-calls') || 8),
    effort: arg(argv, '--effort') || 'medium',
    log: (line) => process.stderr.write(`${line}\n`),
  });
  fs.writeFileSync(out, `${JSON.stringify(labels, null, 2)}\n`);
  const okCalls = labels.calls.filter((c) => c.ok).length;
  process.stderr.write(`[producer] ${labels.repo}: ${labels.labels.length} labels, ${labels.calls.length} calls (${okCalls} ok)\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
