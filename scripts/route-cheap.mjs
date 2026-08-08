#!/usr/bin/env node
// scripts/route-cheap.mjs — THE place cheap-model routing happens, so the visibility line is earned.
//
// Grounding (verified, not recalled):
//   - The real cheap-routing path is agentic-flow's CLI: any --model containing "/" auto-routes
//     through OpenRouter (agentic-flow/src/router/index.ts exports OpenRouterProvider; verified
//     live 2026-07-07 — see plugin/skills/ruvnet-brain/SKILL.md "Cost-optimal model routing").
//   - NOT mcp__ruflo__agent_execute (Anthropic-only), NOT the neural router (chance-level per
//     rUv's own ROUTER-PILOT.md benchmark).
//   - Pricing below was pulled live from the OpenRouter API on 2026-07-07 (same SKILL.md table).
//
// What it does, visibly (Stuart directive: "invisible value = no value"):
//   1. Runs the task on a cheap model via `npx agentic-flow@latest`.
//   2. Appends a receipt to ~/.claude/metaharness/routing-receipts.jsonl (machine-wide).
//   3. Prints ONE dim line: "⚡ MetaHarness: routed to <model> (est. $X vs $Y frontier — saved ~$Z)".
//
// Usage:
//   node scripts/route-cheap.mjs --task "summarize X" [--model deepseek/deepseek-chat]
//                                [--agent researcher] [--class research]
//
// Scope guard: read-only text work ONLY (research / summarize / classify / transform). This path
// has no file-write capability and no native tool calling — code edits stay on Claude Code.
// The OPENROUTER_API_KEY value is read from env or ruvnet-brain/.env and NEVER printed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRuntimePreferences, runtimeChildEnv } from '../plugin/scripts/runtime-preferences.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// $/Mtok, verified live from the OpenRouter API 2026-07-07 (SKILL.md "Cost-optimal model routing").
export const PRICING = {
  'deepseek/deepseek-chat': { in: 0.20, out: 0.80 },
  'z-ai/glm-4.6': { in: 0.43, out: 1.74 },
  'z-ai/glm-5': { in: 0.60, out: 1.92 },
  'deepseek/deepseek-v4-flash': { in: 0.077, out: 0.154 }, // verified 2026-07-12 OpenRouter /models live; successor to deepseek-chat (which resolves to legacy V3)
  'x-ai/grok-4.5': { in: 2.0, out: 6.0 }, // verified 2026-07-12 OpenRouter /models live; mid-priced frontier-adjacent
};
// Frontier = the most capable model you'd otherwise reach for. Fable 5 leads the Claude 5 family
// (2× Opus 4.8 per token — see CLAUDE_TIERS below), so it is the honest "instead of" baseline: every
// $ the cascade saves is measured against what Fable 5 would have cost on the same tokens.
export const FRONTIER = { name: 'claude-fable-5', in: 10.0, out: 50.0 };

// Claude tiers — $/Mtok, verified live from the OpenRouter /models API 2026-07-13.
// These are NOT routed through here (Claude Code's own Agent/Task tool spawns them). They are priced
// so a SUBAGENT dispatch can get a real receipt: until 2026-07-13 the single biggest routing lever —
// every subagent inherits the main-loop model unless told otherwise — wrote no receipt at all, so the
// whole router looked unused. It WAS unused; it was also unmeasurable. Both had to be fixed.
// The spread is the whole argument: fable-5 costs 10x haiku-4.5 for identical mechanical work.
export const CLAUDE_TIERS = {
  'claude-haiku-4.5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 },
  'claude-opus-4.8': { in: 5.0, out: 25.0 },
  'claude-fable-5': { in: 10.0, out: 50.0 },
  // OPUS 5 ADDED 2026-08-08, and its absence was silently costing every receipt.
  //
  // dispatch-receipt refuses to price an unknown model ("refusing to invent savings"), which is the
  // right call — but it means a session running on a model this table does not know can NEVER record
  // a dispatch. Opus 5 is the current main-loop model, so every subagent routed from one of those
  // sessions produced no receipt at all, and `/savings` read as "routing stopped" when what actually
  // stopped was RECORDING. That is why the ledger sat unchanged for 14 days.
  //
  // Prices verified LIVE against the OpenRouter /models API on 2026-08-08, per this file's own
  // standing rule — never recalled, never inferred from the 4.8 row:
  //     anthropic/claude-opus-5        in $5.00/Mtok  out $25.00/Mtok
  //     anthropic/claude-opus-5-fast   in $10.00/Mtok out $50.00/Mtok
  'claude-opus-5': { in: 5.0, out: 25.0 },
  'claude-opus-5-fast': { in: 10.0, out: 50.0 },
};

/** Price lookup across both tables. Unknown model → null (never invent a savings number). */
export const priceOf = (model) => PRICING[model] || CLAUDE_TIERS[model] || null;

export function receiptsPath() {
  return (
    process.env.METAHARNESS_RECEIPTS ||
    path.join(os.homedir(), '.claude', 'metaharness', 'routing-receipts.jsonl')
  );
}

// Honest token estimate: ~4 chars/token. Labeled "est." everywhere — never presented as measured.
export const estTokens = (text) => Math.max(1, Math.ceil((text || '').length / 4));

// `ref` = what this task WOULD have run on. For a cheap OpenRouter call that's the frontier default;
// for a subagent it's the model the agent would have INHERITED (i.e. the main-loop model), which is
// the only honest baseline — an un-overridden subagent really does run on whatever the session is on.
export function estimateCosts(model, inTokens, outTokens, ref = FRONTIER.name) {
  const p = priceOf(model);
  const r = priceOf(ref);
  if (!p || !r) return null; // unknown model → no receipt rather than an invented number
  const cost = (inTokens * p.in + outTokens * p.out) / 1e6;
  const frontier = (inTokens * r.in + outTokens * r.out) / 1e6;
  return { cost, frontier, saved: frontier - cost, ref };
}

const fmt$ = (n) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;

export function receiptLine(model, costs) {
  const ref = costs.ref && costs.ref !== FRONTIER.name ? costs.ref : 'frontier';
  // Percentage leads — "saved ~$0.005" reads as noise, "~97% cheaper" is the message (Stuart, 2026-07-13).
  const pct = costs.frontier > 0 ? Math.round((costs.saved / costs.frontier) * 100) : 0;
  return `\x1b[2m⚡ MetaHarness: routed to ${model} — ~${pct}% cheaper (est. ${fmt$(costs.cost)} vs ${fmt$(costs.frontier)} ${ref}, saved ~${fmt$(costs.saved)})\x1b[0m`;
}

function agenticFlowExecutable(env) {
  const home = env.HOME || os.homedir();
  const global = path.join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'agentic-flow.cmd' : 'agentic-flow');
  try {
    fs.accessSync(global, fs.constants.X_OK);
    return global;
  } catch {
    return 'agentic-flow';
  }
}

function parseArgs(argv) {
  const args = { model: 'deepseek/deepseek-chat', agent: 'researcher', class: 'research' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--task' || k === '--model' || k === '--agent' || k === '--class') args[k.slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('Usage: node scripts/route-cheap.mjs --task "<text>" [--model deepseek/deepseek-chat] [--agent researcher] [--class research]');
    process.exit(2);
  }
  if (!PRICING[args.model]) {
    console.error(`Unknown model "${args.model}" — no verified pricing, refusing to invent savings. Known: ${Object.keys(PRICING).join(', ')}`);
    process.exit(2);
  }
  const policy = loadRuntimePreferences();
  if (policy.values.routing !== 'auto') {
    console.error(policy.values.routing === 'off'
      ? 'Token-smart routing is off in RuvNet Brain Console — nothing was dispatched.'
      : 'Token-smart routing has not been enabled in RuvNet Brain Console — nothing was dispatched.');
    process.exit(1);
  }
  const childEnv = runtimeChildEnv();
  if (!childEnv.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not configured in the environment or encrypted Brain credential store — cannot route. (Key value is never printed.)');
    process.exit(1);
  }

  const started = Date.now();
  const run = spawnSync(agenticFlowExecutable(childEnv), ['--agent', args.agent, '--model', args.model, '--task', args.task], {
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv,
    shell: false,
  });

  if (run.error || run.status !== 0) {
    // Honest failure: no receipt, no savings claim.
    console.error(`route-cheap: agentic-flow failed (exit ${run.status ?? 'spawn-error'}). No receipt written.`);
    if (run.stderr) console.error(run.stderr.slice(-2000));
    if (run.stdout) console.error(run.stdout.slice(-1000));
    process.exit(run.status || 1);
  }

  const output = (run.stdout || '').trim();
  console.log(output);

  const inTok = estTokens(args.task);
  const outTok = estTokens(output);
  const costs = estimateCosts(args.model, inTok, outTok);
  const receipt = {
    ts: new Date().toISOString(),
    task_class: args.class,
    task: args.task.slice(0, 120),
    model: args.model,
    agent: args.agent,
    est_in_tokens: inTok,
    est_out_tokens: outTok,
    est_cost: +costs.cost.toFixed(6),
    est_frontier_cost: +costs.frontier.toFixed(6),
    saved: +costs.saved.toFixed(6),
    frontier_ref: FRONTIER.name,
    token_source: 'chars/4 est',
    duration_ms: Date.now() - started,
    source: 'agentic-flow',
  };
  const file = receiptsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');

  console.log('');
  console.log(receiptLine(args.model, costs));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
