#!/usr/bin/env node
// scripts/model-router-outcome.mjs — the LABELED-DATA pipeline for a future learned routing policy.
//
// WHY THIS EXISTS: both ADR-040/DRACO (verified via search_ruvnet: a hand-built self-signal threshold
// routed WORSE than always-cheapest; a learned map from a real feature beat the best fixed model) and
// ruflo's own ADR-149 point the same direction — learned routing beats hand-tuned routing, but ONLY
// once there are labeled outcomes to learn from. model-router-engine.mjs's placeholder policy
// (policy.default.mjs) is a 3-tier heuristic precisely because there is no such label set yet. This
// file is where those labels accumulate, one JSON line at a time, so that placeholder can eventually
// be replaced by something trained on real outcomes instead of a guess.
//
// A label is not just "did the task succeed" — an OVERRIDE (an operator escalating past whatever the
// engine picked) is itself a label: it says the engine's choice was wrong for that prompt shape, even
// if no downstream failure was ever observed. Log overrides the same way you log pass/fail outcomes;
// don't wait for a hard failure to record that the router under- or over-shot.
//
// Usage:
//   node model-router-outcome.mjs --model <id> --success true|false [--note "..."] [--task-hash <h>]
//   node model-router-outcome.mjs --summary
//
// Storage: ~/.claude/metaharness/routing-outcomes.jsonl (append-only; sibling to routing-decisions.jsonl
// and routing-receipts.jsonl — decisions record what was CHOSEN, outcomes record what HAPPENED).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const OUTCOMES_LOG =
  process.env.MODEL_ROUTER_OUTCOMES ||
  path.join(os.homedir(), '.claude', 'metaharness', 'routing-outcomes.jsonl');

function parseArgs(argv) {
  const a = { model: null, success: null, note: null, taskHash: null, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--model') a.model = argv[++i];
    else if (k === '--success') a.success = argv[++i];
    else if (k === '--note') a.note = argv[++i];
    else if (k === '--task-hash') a.taskHash = argv[++i];
    else if (k === '--summary') a.summary = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function appendOutcome({ model, success, note, taskHash }) {
  if (!model) throw new Error('--model is required');
  if (success !== 'true' && success !== 'false') throw new Error('--success must be "true" or "false"');
  const entry = { ts: new Date().toISOString(), model, success: success === 'true' };
  if (note) entry.note = note;
  if (taskHash) entry.taskHash = taskHash;
  fs.mkdirSync(path.dirname(OUTCOMES_LOG), { recursive: true });
  fs.appendFileSync(OUTCOMES_LOG, JSON.stringify(entry) + '\n');
  return entry;
}

export function summarize(file = OUTCOMES_LOG) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return { total: 0, outcomes: 0, trainingRows: 0, invalid: 0, byModel: {} };
  }
  const byModel = {};
  let outcomes = 0;
  let trainingRows = 0;
  let invalid = 0;
  for (const l of lines) {
    let d;
    try { d = JSON.parse(l); } catch { invalid++; continue; }
    if (Array.isArray(d.embedding) && d.embedding.length && d.scores && typeof d.scores === 'object') {
      trainingRows++;
      continue;
    }
    if (typeof d.model !== 'string' || typeof d.success !== 'boolean') {
      invalid++;
      continue;
    }
    const m = byModel[d.model] || (byModel[d.model] = { total: 0, successes: 0, failures: 0 });
    outcomes++;
    m.total++;
    if (d.success) m.successes++; else m.failures++;
  }
  return { total: lines.length, outcomes, trainingRows, invalid, byModel };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 24).join('\n') + '\n');
    return;
  }

  if (args.summary) {
    const { total, outcomes, trainingRows, invalid, byModel } = summarize();
    console.log(`Routing data: ${total} row(s) — ${outcomes} observed outcome(s), ${trainingRows} k-NN training row(s), ${invalid} invalid (${OUTCOMES_LOG.replace(os.homedir(), '~')})`);
    for (const [model, s] of Object.entries(byModel)) {
      console.log(`  ${model.padEnd(32)} total:${s.total}  successes:${s.successes}  failures:${s.failures}`);
    }
    return;
  }

  const entry = appendOutcome(args);
  console.log(`[model-router-outcome] logged: ${JSON.stringify(entry)}`);
}

if (isDirectInvocation(import.meta.url)) {
  try { main(); } catch (e) { process.stderr.write(`model-router-outcome: ${e.message}\n`); process.exit(1); }
}
