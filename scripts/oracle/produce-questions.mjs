#!/usr/bin/env node
/**
 * scripts/oracle/produce-questions.mjs — Step 14 (ADR-086 C3) SUBSCRIPTION-ONLY semantic label producer.
 *
 * Two independent passes over the units selected by source-units.mjs, both on subscription-billed
 * native hosts and NEVER on a provider API key:
 *
 *   1. the GENERATOR sees the exact upstream bytes of the units in a batch and must emit, per unit, one
 *      direct question, one meaning-preserving paraphrase, and the VERBATIM supporting span (plus its
 *      line range inside the unit) as strict structured output;
 *   2. the JUDGE — a DIFFERENT vendor — sees ONLY question + candidate span (never the unit, path or
 *      repo) and answers whether the span alone answers each question, and separately whether the
 *      direct question and its paraphrase mean the same thing.
 *
 * Roles default to claude generates / codex judges (the configuration the Step 14 spike measured).
 * Path B — codex generates / claude judges — was approved by an Astra-only Dual deliberation on
 * 2026-09-14 and must qualify on its own pilot; host details live in ./producer-hosts.mjs.
 *
 * Fence (owner mandate): the child environment is scripts/subscription-hosts.mjs#subscriptionOnlyEnv,
 * which deletes every API_BILLING_ENV name; this module never reads those names itself (the unit test
 * greps this file for them). `--bare` is never used — see producer-hosts.mjs.
 *
 * The producer sees upstream bytes only. Nothing here reads a candidate corpus, RVF, passage sidecar
 * or retrieval output — by construction, not by promise (inputs: inventory JSON + snapshot dir).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BILLING_ENV, subscriptionOnlyEnv } from '../subscription-hosts.mjs';
import { gitBlobSha, sha256Hex, unitText } from './source-units.mjs';
import {
  DEFAULT_ROLES, LABEL_SCHEMA, PRODUCER_MODELS, VERDICT_SCHEMA, generatorPrompt, hostAdapters, isQuotaRefusal,
  judgePrompt, spawnHost,
} from './producer-hosts.mjs';

export {
  CLAUDE_SYSTEM_PROMPT, CLAUDE_TIMEOUT_MS, CODEX_TIMEOUT_MS, DEFAULT_ROLES, JUDGE_SYSTEM_PROMPT, LABEL_SCHEMA,
  PRODUCER_MODELS, VERDICT_SCHEMA, claudeArgs, claudePrompt, codexArgs, codexPrompt, hostAdapters, isQuotaRefusal,
  parseClaudeEnvelope, parseClaudeVerdicts, parseCodexJsonl, parseCodexLabels, spawnHost,
} from './producer-hosts.mjs';

export const PRODUCER_VERSION = 'oracle-producer/2';
export const DEFAULT_BATCH = 20;
export const MAX_UNIT_CHARS = 6000;

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

function billingNamesPresent(env) { return API_BILLING_ENV.filter((name) => name in env); }

/**
 * A checkpoint is reusable only under the SAME producer configuration. blobSha alone is not enough
 * (Dual): the key binds source, rules, roles, models, effort, batch size and the exact prompt text.
 */
export function checkpointKey({ inventory, roles, adapters, effort, batchSize }) {
  return sha256Hex(Buffer.from(JSON.stringify({
    producerVersion: PRODUCER_VERSION, repo: inventory.repo, commit: inventory.commit, rulesVersion: inventory.rulesVersion,
    roles, generatorModel: adapters.generator.model, judgeModel: adapters.judge.model, effort, batchSize,
    generatorPromptSha256: sha256Hex(Buffer.from(generatorPrompt([]), 'utf8')),
    judgePromptSha256: sha256Hex(Buffer.from(judgePrompt([{ id: 'x', questionA: 'a', questionB: 'b' }]), 'utf8')),
  }), 'utf8'));
}

export async function produceQuestions({
  inventory, snapshotDir, batchSize = DEFAULT_BATCH, maxClaudeCalls = 8, maxCodexCalls = 8, maxGeneratorCalls, maxJudgeCalls,
  effort = 'medium', models = PRODUCER_MODELS, roles = DEFAULT_ROLES, allowSameVendor = false, retries = 0,
  checkpointFile = null, spawnImpl = spawnHost, workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-producer-')),
  log = () => {},
}) {
  const env = subscriptionOnlyEnv();
  const envAudit = { parentHadBillingKeys: billingNamesPresent(process.env), childHadBillingKeys: billingNamesPresent(env) };
  if (envAudit.childHadBillingKeys.length) throw new Error(`fence violated: child env still carries ${envAudit.childHadBillingKeys.join(',')}`);
  fs.mkdirSync(workDir, { recursive: true }); // an explicitly-supplied workDir may not exist yet
  const schemaFiles = { labels: path.join(workDir, 'label-schema.json'), verdicts: path.join(workDir, 'verdict-schema.json') };
  fs.writeFileSync(schemaFiles.labels, JSON.stringify(LABEL_SCHEMA));
  fs.writeFileSync(schemaFiles.verdicts, JSON.stringify(VERDICT_SCHEMA));
  const codexCwd = path.join(workDir, 'codex-empty-cwd');
  fs.mkdirSync(codexCwd, { recursive: true });
  const adapters = hostAdapters({ roles, models, effort, schemaFiles, workDir, codexCwd, allowSameVendor });
  const { generator, judge } = adapters;
  const budgetFor = (host, explicit) => explicit ?? (host === 'claude' ? maxClaudeCalls : maxCodexCalls);
  const generatorBudget = budgetFor(generator.host, maxGeneratorCalls);
  const judgeBudget = budgetFor(judge.host, maxJudgeCalls);

  const key = checkpointKey({ inventory, roles, adapters, effort, batchSize });
  const reused = new Map();
  if (checkpointFile && fs.existsSync(checkpointFile)) {
    const saved = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    if (saved.key === key) {
      for (const l of saved.labels || []) if (!l.producerError) reused.set(l.unitId, l);
    }
  }

  const loaded = loadUnitTexts(snapshotDir, inventory.selected);
  const byUnit = new Map();
  for (const { unit } of loaded) {
    const prior = reused.get(unit.unitId);
    if (prior && prior.path === unit.path && prior.blobSha === unit.blobSha && prior.bytesSha256 === unit.bytesSha256) byUnit.set(unit.unitId, prior);
  }
  const reusedUnits = byUnit.size;
  const calls = [];
  let suspended = null;
  const ordered = () => loaded.map(({ unit }) => byUnit.get(unit.unitId)).filter(Boolean);
  const saveCheckpoint = () => {
    if (checkpointFile) fs.writeFileSync(checkpointFile, `${JSON.stringify({ key, producerVersion: PRODUCER_VERSION, labels: ordered(), suspended })}\n`);
  };

  const runCall = async (adapter, batchIndex, items, input) => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await spawnImpl(adapter.binary, adapter.args, { cwd: adapter.cwd, env, timeoutMs: adapter.timeoutMs }, input);
      const parsed = result.status === 0 && !result.timedOut
        ? adapter.parse(result.stdout)
        : { error: result.timedOut ? 'timeout' : `exit ${result.status}: ${String(result.stderr || '').slice(0, 300)}` };
      const quotaRefusal = Boolean(parsed.error) && isQuotaRefusal(`${result.stderr}\n${parsed.error}`);
      calls.push(callRecord(adapter, batchIndex, items, result, parsed, attempt, quotaRefusal));
      if (quotaRefusal) {
        // Suspend: no further calls to ANY host. Remaining work is recorded as unproduced, never dropped.
        suspended = { host: adapter.host, stage: adapter.stage, batchIndex, reason: String(result.stderr || parsed.error).slice(-300) };
        return parsed;
      }
      if (!parsed.error || attempt >= retries) return parsed;
      log(`[producer] ${adapter.host} ${adapter.stage} batch ${batchIndex + 1} retry ${attempt + 1}/${retries} after: ${parsed.error}`);
    }
  };

  const pending = loaded.filter(({ unit }) => !byUnit.has(unit.unitId));
  for (const [index, batch] of batchUnits(pending, batchSize).entries()) {
    const stop = suspended ? `suspended: ${suspended.host} refused for capacity`
      : index >= generatorBudget ? `${generator.host} call budget exhausted` : null;
    if (stop) { for (const { unit } of batch) byUnit.set(unit.unitId, baseLabel(unit, { producerError: stop })); continue; }
    log(`[producer] ${generator.host} generator batch ${index + 1} (${batch.length} units)`);
    const parsed = await runCall(generator, index, batch.length, generator.prompt(batch));
    if (parsed.error) {
      for (const { unit } of batch) byUnit.set(unit.unitId, baseLabel(unit, { producerError: parsed.error }));
    } else {
      const returned = new Map(parsed.structured.labels.map((l) => [l.unitId, l]));
      for (const { unit, truncated } of batch) {
        const l = returned.get(unit.unitId);
        byUnit.set(unit.unitId, l ? baseLabel(unit, {
          direct: l.direct, paraphrase: l.paraphrase, span: l.span, spanStartLine: l.spanStartLine, spanEndLine: l.spanEndLine,
          skip: l.skip === true, skipReason: l.skip ? l.reason : '', truncatedForProducer: truncated,
        }) : baseLabel(unit, { producerError: `unit missing from ${generator.host} output` }));
      }
    }
    saveCheckpoint();
  }

  const unjudged = ordered().filter((l) => !l.producerError && !l.skip && !l.judge);
  for (const [index, batch] of batchUnits(unjudged, batchSize).entries()) {
    const stop = suspended ? 'suspended' : index >= judgeBudget ? `${judge.host} call budget exhausted` : null;
    if (stop) { for (const l of batch) setVerdicts(l, judge, { error: stop }); continue; }
    const items = batch.flatMap((l) => [
      { id: `${l.unitId}:d`, question: l.direct, span: l.span },
      { id: `${l.unitId}:p`, question: l.paraphrase, span: l.span },
      { id: `${l.unitId}:e`, questionA: l.direct, questionB: l.paraphrase },
    ]);
    log(`[producer] ${judge.host} judge batch ${index + 1} (${items.length} items)`);
    const parsed = await runCall(judge, index, items.length, judge.prompt(items));
    const verdicts = new Map((parsed.structured?.verdicts || []).map((v) => [v.id, v]));
    for (const l of batch) setVerdicts(l, judge, parsed.error ? { error: parsed.error } : { verdicts });
    saveCheckpoint();
  }

  const shown = (adapter) => ({
    host: adapter.host, binary: adapter.binary, requestedModel: adapter.model, effort,
    args: adapter.args.filter((a) => !a.startsWith('{')).map((a) => (a.startsWith(workDir) ? '<schema>' : a)),
  });
  return {
    schemaVersion: 1, kind: 'oracle-labels', repo: inventory.repo, commit: inventory.commit, rulesVersion: inventory.rulesVersion,
    producerVersion: PRODUCER_VERSION, roles,
    producer: {
      generator: shown(generator), judge: shown(judge),
      claude: { binary: 'claude', requestedModel: models.claude, effort },
      codex: { binary: 'codex', requestedModel: models.codex, effort },
      batchSize, retries,
      note: 'total_cost_usd is the host\'s at-list-price estimate; both hosts were verified subscription-authenticated (claude.ai/max, ChatGPT) and no provider key was present in the child env.',
    },
    checkpoint: checkpointFile ? { file: checkpointFile, key, reusedUnits } : null,
    suspended, envAudit, calls, labels: ordered(),
  };
}

/** Role-neutral verdicts on `judge`; the historical `codex` shape is kept exactly when codex judged. */
function setVerdicts(label, judge, { error, verdicts }) {
  const pick = (suffix) => {
    if (error) return { error };
    const v = verdicts.get(`${label.unitId}:${suffix}`);
    return v ? { answers: v.answers, reason: v.reason } : { error: 'missing verdict' };
  };
  label.judge = { host: judge.host, model: judge.model, direct: pick('d'), paraphrase: pick('p'), equivalent: pick('e') };
  if (judge.host === 'codex') label.codex = error ? { error } : { direct: label.judge.direct, paraphrase: label.judge.paraphrase };
}

function baseLabel(unit, extra) {
  return {
    unitId: unit.unitId, path: unit.path, blobSha: unit.blobSha, startLine: unit.startLine, endLine: unit.endLine,
    bytesSha256: unit.bytesSha256, kind: unit.kind, language: unit.language, ...extra,
  };
}

function callRecord(adapter, batchIndex, items, result, parsed, attempt, quotaRefusal) {
  const rec = {
    host: adapter.host, stage: adapter.stage, batchIndex, attempt, items, requestedModel: adapter.model,
    status: result.status, timedOut: result.timedOut, durationMs: result.durationMs, ok: !parsed.error, error: parsed.error, quotaRefusal,
  };
  if (adapter.host === 'claude' && parsed.envelope) {
    const e = parsed.envelope;
    rec.modelUsage = Object.keys(e.modelUsage || {});
    rec.numTurns = e.num_turns;
    rec.reportedCostEstimateUsd = e.total_cost_usd;
    rec.usage = e.usage && { input: e.usage.input_tokens, cacheCreate: e.usage.cache_creation_input_tokens, cacheRead: e.usage.cache_read_input_tokens, output: e.usage.output_tokens };
  }
  if (adapter.host === 'codex') rec.hostErrors = parsed.errors || [];
  rec.returnedLabels = parsed.structured?.labels?.length;
  rec.returnedVerdicts = parsed.structured?.verdicts?.length;
  if (parsed.error) rec.stderrTail = String(result.stderr || '').slice(-400);
  return rec;
}

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }
const optionalNumber = (value) => (value == null ? undefined : Number(value));

export async function main(argv = process.argv.slice(2)) {
  const inventoryFile = arg(argv, '--inventory');
  const snapshotDir = arg(argv, '--dir');
  const out = arg(argv, '--out');
  if (!inventoryFile || !snapshotDir || !out) {
    process.stderr.write('Usage: produce-questions.mjs --inventory <inventory.json> --dir <snapshot> --out <labels.json> '
      + '[--generator claude|codex] [--judge codex|claude] [--claude-model id] [--codex-model id] [--batch 20] '
      + '[--max-generator-calls n] [--max-judge-calls n] [--max-claude-calls 8] [--max-codex-calls 8] [--retries 0] '
      + '[--checkpoint <file>] [--effort medium]\n');
    return 64;
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  const labels = await produceQuestions({
    inventory, snapshotDir: path.resolve(snapshotDir),
    roles: { generator: arg(argv, '--generator') || DEFAULT_ROLES.generator, judge: arg(argv, '--judge') || DEFAULT_ROLES.judge },
    models: { claude: arg(argv, '--claude-model') || PRODUCER_MODELS.claude, codex: arg(argv, '--codex-model') || PRODUCER_MODELS.codex },
    batchSize: Number(arg(argv, '--batch') || DEFAULT_BATCH),
    maxClaudeCalls: Number(arg(argv, '--max-claude-calls') || 8),
    maxCodexCalls: Number(arg(argv, '--max-codex-calls') || 8),
    maxGeneratorCalls: optionalNumber(arg(argv, '--max-generator-calls')),
    maxJudgeCalls: optionalNumber(arg(argv, '--max-judge-calls')),
    retries: Number(arg(argv, '--retries') || 0),
    checkpointFile: arg(argv, '--checkpoint') || null,
    effort: arg(argv, '--effort') || 'medium',
    log: (line) => process.stderr.write(`${line}\n`),
  });
  fs.writeFileSync(out, `${JSON.stringify(labels, null, 2)}\n`);
  const okCalls = labels.calls.filter((c) => c.ok).length;
  process.stderr.write(`[producer] ${labels.repo}: ${labels.labels.length} labels, ${labels.calls.length} calls (${okCalls} ok)`
    + `${labels.suspended ? ` — SUSPENDED on ${labels.suspended.host} capacity refusal` : ''}\n`);
  return labels.suspended ? 75 : 0;
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = await main();
