#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './coverage-integrity.mjs';

const HOSTS = new Set(['claude-code', 'codex']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const NATIVE_PROMPT_BUDGET = 1_000_000;

// Validate the transport, not model-authored claims inside its response. All Dual
// stages use this same boundary; modelUsage is an observation, not attestation.
export function readNativeCompletion(nativeHost, stdout, requestedModel) {
  if (!HOSTS.has(nativeHost)) throw new Error('unknown native host');
  let raw, threadId = null, sessionId = null, observedModels = [];
  if (nativeHost === 'claude-code') {
    const envelope = JSON.parse(stdout);
    if (!envelope || envelope.is_error !== false
      || ((envelope.type !== undefined || envelope.subtype !== undefined) && envelope.subtype !== 'success')
      || (envelope.terminal_reason !== undefined && envelope.terminal_reason !== 'completed')) {
      throw new Error('native Claude execution failed');
    }
    sessionId = envelope.session_id;
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('native transport omitted session identity');
    observedModels = Object.keys(envelope.modelUsage || {});
    raw = envelope.structured_output ?? envelope.result;
  } else {
    const events = String(stdout).trim().split('\n').map(line => JSON.parse(line));
    const threads = events.filter(event => event?.type === 'thread.started');
    if (threads.length !== 1 || typeof threads[0].thread_id !== 'string' || !threads[0].thread_id.trim()) {
      throw new Error('native transport omitted unique thread.started');
    }
    threadId = threads[0].thread_id;
    if (events.at(-1)?.type !== 'turn.completed') throw new Error('native transport omitted terminal turn.completed');
    if (events.some(event => ['error', 'turn.failed', 'turn.aborted', 'model.rerouted', 'model_reroute', 'model/rerouted'].includes(event?.type)
      || event?.method === 'model/rerouted' || (event?.fromModel && event?.toModel)
      || (event?.params?.fromModel && event?.params?.toModel))) throw new Error('native transport reported failed or rerouted turn');
    observedModels = [...new Set(events.map(event => event?.model).filter(model => typeof model === 'string'))];
    raw = events.filter(event => event?.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text;
  }
  // Claude reports auxiliary model usage alongside the requested primary model.
  // Retain all observations; neither their presence nor absence is attestation.
  if (nativeHost === 'claude-code' ? observedModels.length && !observedModels.includes(requestedModel)
    : observedModels.some(model => model !== requestedModel)) throw new Error('native execution reported a different model');
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native response is not a complete structured object');
  return { value, threadId, sessionId, observedModels };
}

export function canonicalNativeReviewEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('native evidence must be an object');
  const keys = ['schemaVersion', 'kind', 'nativeHost', 'clientVersion', 'requestedModel', 'modelIdentityClass', 'threadId', 'sessionId', 'completionStatus', 'status', 'signal', 'startedAt', 'completedAt', 'prompt', 'stdout', 'stderr'];
  const unknown = Object.keys(evidence).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`native evidence has unknown field: ${unknown[0]}`);
  for (const key of keys) if (!Object.hasOwn(evidence, key)) throw new Error(`native evidence ${key} is required`);
  if (evidence.schemaVersion !== 1 || evidence.kind !== 'ruvnet-brain-native-review-evidence') throw new Error('native evidence schema is invalid');
  if (!HOSTS.has(evidence.nativeHost)) throw new Error('native evidence host is invalid');
  for (const key of ['clientVersion', 'requestedModel', 'prompt', 'stdout']) if (typeof evidence[key] !== 'string' || !evidence[key].trim()) throw new Error(`native evidence ${key} is required`);
  if (typeof evidence.stderr !== 'string') throw new Error('native evidence stderr is required');
  if (evidence.modelIdentityClass !== 'requested-only' || evidence.completionStatus !== 'completed') throw new Error('native evidence completion or model class is invalid');
  if (evidence.status !== 0 || evidence.signal !== null) throw new Error('native evidence process status is invalid');
  if (![evidence.threadId, evidence.sessionId].every((value) => value === null || (typeof value === 'string' && value.trim()))) throw new Error('native evidence session identity is invalid');
  if (evidence.nativeHost === 'codex' && (!evidence.threadId || evidence.sessionId !== null)) throw new Error('native evidence Codex identity is invalid');
  if (evidence.nativeHost === 'claude-code' && (!evidence.sessionId || evidence.threadId !== null)) throw new Error('native evidence Claude identity is invalid');
  if (![evidence.startedAt, evidence.completedAt].every((value) => typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value))) || Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) throw new Error('native evidence timestamps are invalid');
  if (evidence.stderr.length > 1_000_000 || evidence.stdout.length > 16_000_000 || evidence.prompt.length > NATIVE_PROMPT_BUDGET) throw new Error('native evidence exceeds retention budget');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, evidence[key]])));
}

export function nativeReviewEvidenceDigest(evidence) {
  const canonical = canonicalNativeReviewEvidence(evidence);
  return crypto.createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

export function writeNativeEvidenceSidecar(file, evidence) {
  const target = path.resolve(file);
  const stat = (() => { try { return fs.lstatSync(target); } catch { return null; } })();
  if (stat) throw new Error('native evidence sidecar already exists');
  const canonical = canonicalNativeReviewEvidence(evidence);
  const payload = { ...canonical, evidenceSha256: nativeReviewEvidenceDigest(canonical) };
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); fs.chmodSync(tmp, 0o600); fs.linkSync(tmp, target); fs.unlinkSync(tmp); }
  catch (error) { try { fs.rmSync(tmp, { force: true }); } catch {} throw error; }
  return payload.evidenceSha256;
}
