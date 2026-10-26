#!/usr/bin/env node
// PostToolUse Task/Agent observer. It records the host's terminal status after an explicitly routed
// dispatch. Host completion is an observation, not a quality grade, so these rows are always marked
// verified:false and intentionally contain neither embeddings nor scores.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parseHookEvent,
  rawToolResponse,
  readStdinBounded,
  toolName,
} from './hook-input.mjs';
import { isDirectInvocation } from './entrypoint.mjs';

const SUCCESS = new Set(['completed', 'success', 'succeeded']);
const FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'timeout']);

export function outcomesPath() {
  return process.env.MODEL_ROUTER_OUTCOMES
    || path.join(os.homedir(), '.claude', 'metaharness', 'routing-outcomes.jsonl');
}

export function dispatchLogPath() {
  return process.env.MODEL_ROUTER_DISPATCH_LOG
    || path.join(os.homedir(), '.claude', 'metaharness', 'dispatch-log.jsonl');
}

export function findDispatchDecision(toolUseId, file = dispatchLogPath()) {
  if (!toolUseId) return null;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row?.event === 'dispatch' && row.toolUseId === toolUseId) return row;
  }
  return null;
}

export function observationFrom(event, now = new Date().toISOString(), decision = null) {
  if (!['Task', 'Agent'].includes(toolName(event))) return null;
  const model = event?.tool_input?.model;
  if (typeof model !== 'string' || !model.trim()) return null;
  const response = rawToolResponse(event);
  const status = typeof response?.status === 'string' ? response.status.toLowerCase() : '';
  if (!SUCCESS.has(status) && !FAILURE.has(status)) return null;
  const task = String(event?.tool_input?.prompt || event?.tool_input?.description || '');
  return {
    schema: 'dispatch-observation-v1',
    ts: now,
    source: 'PostToolUse',
    model,
    success: SUCCESS.has(status),
    hostStatus: status,
    verified: false,
    taskHash: createHash('sha256').update(task).digest('hex').slice(0, 24),
    toolUseId: event.tool_use_id || null,
    sessionId: event.session_id || null,
    decisionLinked: !!decision,
    decisionModel: typeof decision?.model === 'string' ? decision.model : null,
    decisionModelMatch: decision ? decision.model === model : null,
  };
}

export function appendObservation(row, file = outcomesPath()) {
  if (!row) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.stdin.isTTY) return;
  let event = null;
  try { event = parseHookEvent((await readStdinBounded()).toString('utf8')); } catch { return; }
  const decision = findDispatchDecision(event?.tool_use_id);
  appendObservation(observationFrom(event, new Date().toISOString(), decision));
}

if (isDirectInvocation(import.meta.url)) {
  try { await main(); } catch { /* advisory observer: fail open */ }
}
