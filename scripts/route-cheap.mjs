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
const isDirectInvocation = (metaUrl) => Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// $/Mtok, verified live from the OpenRouter API 2026-07-07 (SKILL.md "Cost-optimal model routing").
export const PRICING = {
  'deepseek/deepseek-chat': { in: 0.20, out: 0.80 },
  'z-ai/glm-4.6': { in: 0.43, out: 1.74 },
  'z-ai/glm-5': { in: 0.60, out: 1.92 },
  'deepseek/deepseek-v4-flash': { in: 0.077, out: 0.154 }, // verified 2026-07-12 OpenRouter /models live; successor to deepseek-chat (which resolves to legacy V3)
  'x-ai/grok-4.5': { in: 2.0, out: 6.0 }, // verified 2026-07-12 OpenRouter /models live; mid-priced frontier-adjacent
};
// Named handles for the Claude tier ids below, so every OTHER file that needs one of these ids
// imports it by NAME instead of retyping the literal a second time (single-source contract B7 —
// calibrate-router.mjs, dispatch-receipt.mjs, router-utilization.mjs and metaharness-receipts.mjs
// all used to hard-code their own copies of these same strings).
export const CLAUDE_MODEL_IDS = Object.freeze({
  haiku: 'claude-haiku-4.5',
  haiku55: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5',
  sonnet55: 'claude-sonnet-5-5',
  opus: 'claude-opus-4.8',
  opus55: 'claude-opus-5-5',
  fable: 'claude-fable-5',
  fable51: 'claude-fable-5-1',
  fable52: 'claude-fable-5-2',
  opus5: 'claude-opus-5',
  opus5Fast: 'claude-opus-5-fast',
});

// Frontier = the most capable model you'd otherwise reach for. Fable 5.2 leads the Claude 5 family
// (and Artificial Analysis v5.0.1 / Vals v2.2), so it is the honest "instead of" baseline.
export const FRONTIER = { name: CLAUDE_MODEL_IDS.fable52, in: 8.0, out: 40.0 };

export const CLAUDE_TIERS = {
  [CLAUDE_MODEL_IDS.haiku]: { in: 1.0, out: 5.0 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  [CLAUDE_MODEL_IDS.haiku55]: { in: 0.8, out: 4.0 },
  [CLAUDE_MODEL_IDS.sonnet]: { in: 2.0, out: 10.0 },
  [CLAUDE_MODEL_IDS.sonnet55]: { in: 2.0, out: 10.0 },
  [CLAUDE_MODEL_IDS.opus]: { in: 5.0, out: 25.0 },
  [CLAUDE_MODEL_IDS.opus55]: { in: 4.0, out: 20.0 },
  [CLAUDE_MODEL_IDS.fable]: { in: 10.0, out: 50.0 },
  [CLAUDE_MODEL_IDS.fable51]: { in: 8.0, out: 40.0 },
  [CLAUDE_MODEL_IDS.fable52]: { in: 8.0, out: 40.0 },
  [CLAUDE_MODEL_IDS.opus5]: { in: 5.0, out: 25.0 },
  [CLAUDE_MODEL_IDS.opus5Fast]: { in: 10.0, out: 50.0 },
  // OpenAI Codex subscription models (API list equivalent $/Mtok for quota-value accounting)
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-6-sol': { in: 2.0, out: 10.0 },
  'gpt-6.1-sol': { in: 2.0, out: 10.0 },
  'gpt-6.2-sol': { in: 2.0, out: 10.0 },
  'gpt-6-astra': { in: 4.0, out: 20.0 },
  'gpt-6.2-astra': { in: 4.0, out: 20.0 },
  // Google Antigravity Gemini 4 subscription models (Artificial Analysis v5.0.1 list $/Mtok)
  'gemini-4-flash': { in: 0.15, out: 0.6 },
  'gemini-4-argon': { in: 1.25, out: 5.0 },
  'gemini-4-neon': { in: 3.0, out: 15.0 },
  // xAI Grok subscription models (equivalent $/Mtok)
  'grok-4.7': { in: 2.0, out: 6.0 },
  'grok-build': { in: 4.0, out: 15.0 },
};

function catalogPriceOf(model) {
  try {
    const catPath = path.join(os.homedir(), '.claude', 'model-router', 'catalog.json');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    const c = (cat.candidates || []).find((x) => x.id === model);
    if (c?.costPerMTok && typeof c.costPerMTok.in === 'number' && typeof c.costPerMTok.out === 'number') {
      return c.costPerMTok;
    }
  } catch { /* ignore */ }
  return null;
}

/** Price lookup across static tables + live catalog.json fallback. */
export const priceOf = (model) => PRICING[model] || CLAUDE_TIERS[model] || catalogPriceOf(model) || null;

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

if (isDirectInvocation(import.meta.url)) main();
