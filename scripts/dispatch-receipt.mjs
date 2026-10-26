#!/usr/bin/env node
// scripts/dispatch-receipt.mjs — make SUBAGENT routing visible.
//
// WHY THIS EXISTS (2026-07-13, Stuart: "the meta harness isn't really doing anything for me").
// He was right, and the receipts log proved it: 3 entries, all of them test pings, $0.018 saved in
// the router's entire life. Two separate faults hid behind that number:
//   1. BEHAVIOR — mechanical work was being done inline in the main loop instead of dispatched.
//   2. MEASUREMENT — the biggest lever wrote no receipt AT ALL. A Claude Code subagent INHERITS the
//      main-loop model unless explicitly overridden, so a fan-out of five agents on a Fable session
//      is five Fable agents. Overriding them to haiku is the single largest saving available — and
//      route-cheap.mjs only logged OpenRouter calls, so that saving was invisible even when it happened.
// This closes #2 so #1 becomes auditable: the receipts file either grows with real work, or the
// hard rule in SKILL.md is being ignored and the log says so.
//
// The baseline is the INHERITED model, not "frontier" — that is the honest counterfactual. An
// un-overridden subagent genuinely would have run on the session's model.
//
// Usage (call it right after the Agent/Task returns, with the REAL text sizes):
//   node scripts/dispatch-receipt.mjs --model claude-haiku-4.5 --inherited claude-fable-5 \
//        --task "sweep tests/ for machine-state deps" --in-chars 2400 --out-chars 9100
//
// Costs are estimates (chars/4 tokens x live-verified $/Mtok) and are labeled "est." everywhere.
// Unknown model or unknown baseline → NO receipt, non-zero exit. Never invent a savings number.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAUDE_MODEL_IDS, CLAUDE_TIERS, PRICING, estTokens, estimateCosts, receiptLine, receiptsPath, priceOf } from './route-cheap.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

// Default input share when only a MEASURED TOTAL is known. A subagent's tokens are dominated by input
// (it re-reads files and tool output on every turn); its final report is small. 0.9 is an assumption,
// not a measurement, so it is NAMED in the receipt's token_source and overridable with --split.
const DEFAULT_INPUT_SHARE = 0.9;

export function parseArgs(argv) {
  const args = { model: CLAUDE_MODEL_IDS.haiku, inherited: CLAUDE_MODEL_IDS.opus, class: 'mechanical' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (['--model', '--inherited', '--task', '--class', '--in-chars', '--out-chars', '--label', '--total-tokens', '--split'].includes(k)) {
      args[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    }
  }
  return args;
}

/**
 * Token sizing, in descending order of honesty:
 *   1. --total-tokens N  → the harness REPORTED this agent's real usage. Split by --split (named).
 *   2. --in-chars/--out-chars → chars/4 estimate of the text we actually sent/received.
 *   3. the task text alone → weakest; use only when nothing else is known.
 * Why this matters: a subagent that reads 40 files burns ~20x the tokens its prompt+report suggest.
 * Sizing it from the prompt alone would UNDERSTATE the saving by that factor and make real routing
 * look pointless — the same "it isn't doing anything" trap, just with the error flipped.
 */
export function sizeTokens(args) {
  const total = Number(args.totalTokens);
  if (total > 0) {
    const share = Number(args.split) > 0 && Number(args.split) < 1 ? Number(args.split) : DEFAULT_INPUT_SHARE;
    return {
      inTok: Math.round(total * share),
      outTok: Math.round(total * (1 - share)),
      source: `measured total ${total} tok, assumed ${Math.round(share * 100)}/${Math.round((1 - share) * 100)} in/out split`,
    };
  }
  if (Number(args.inChars) || Number(args.outChars)) {
    return {
      inTok: Number(args.inChars) ? estTokens('x'.repeat(Number(args.inChars))) : 0,
      outTok: Number(args.outChars) ? estTokens('x'.repeat(Number(args.outChars))) : 0,
      source: 'chars/4 est',
    };
  }
  return { inTok: estTokens(args.task || ''), outTok: 0, source: 'chars/4 est (prompt only — likely an undercount)' };
}

/** Build the receipt row. Returns null when either model is unpriced — caller must not fabricate. */
export function buildReceipt(args, now) {
  if (!priceOf(args.model) || !priceOf(args.inherited)) return null;
  const { inTok, outTok, source } = sizeTokens(args);
  const costs = estimateCosts(args.model, inTok, outTok, args.inherited);
  if (!costs) return null;
  return {
    ts: now,
    task_class: args.class,
    task: (args.task || args.label || '(unlabeled subagent dispatch)').slice(0, 200),
    model: args.model,
    inherited: args.inherited,
    est_in_tokens: inTok,
    est_out_tokens: outTok,
    est_cost: costs.cost,
    est_frontier_cost: costs.frontier, // same schema key as route-cheap receipts; here = inherited-model cost
    saved: costs.saved,
    frontier_ref: args.inherited,
    token_source: source,
    source: 'claude-subagent',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const known = [...Object.keys(CLAUDE_TIERS), ...Object.keys(PRICING)].join(', ');
  const receipt = buildReceipt(args, new Date().toISOString());
  if (!receipt) {
    console.error(`dispatch-receipt: unpriced model ("${args.model}") or baseline ("${args.inherited}") — refusing to invent savings. Known: ${known}`);
    process.exit(2);
  }
  const file = receiptsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
  console.log(receiptLine(receipt.model, { cost: receipt.est_cost, frontier: receipt.est_frontier_cost, saved: receipt.saved, ref: receipt.inherited }));
}

if (isDirectInvocation(import.meta.url)) main();
