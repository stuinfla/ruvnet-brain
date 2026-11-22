#!/usr/bin/env node
// Per-user prompt routing & automatic tier/effort/escalation directive across all 4 subscription hosts:
// antigravity (Google Gemini 4), claude-code (Anthropic Claude Max/TeamClaude), codex (OpenAI ChatGPT), grok (xAI).
// Never charges by the drink: 100% locked to subscription-covered models ($0 marginal cost).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { weeklyCycleStatus } from './model-weekly-cycle.mjs';
const isDirectInvocation = (metaUrl) => Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl));

export const PRESENTATION = 'For terminal briefings: give concise executive status; use narrow padded ASCII tables with borders, plain cell text, aligned columns and short rows. Never send pipe-delimited Markdown tables to this terminal. Use short lists when a table would wrap. Do not flood the response with commands or technical logs.';

const NEXT_TIER = {
  fast: 'medium',
  medium: 'substantial',
  substantial: 'hard',
  hard: 'exceptional',
  exceptional: 'exceptional',
};

function detectHarness(payload, argv = process.argv) {
  if (argv.includes('--claude')) return 'claude-code';
  if (argv.includes('--codex')) return 'codex';
  if (argv.includes('--antigravity')) return 'antigravity';
  if (argv.includes('--grok')) return 'grok';
  const h = String(payload?.host || payload?.harness || '').toLowerCase();
  if (['claude-code', 'claude'].includes(h)) return 'claude-code';
  if (['antigravity', 'agy', 'gemini'].includes(h)) return 'antigravity';
  if (['grok', 'xai'].includes(h)) return 'grok';
  if (['codex', 'openai'].includes(h)) return 'codex';
  if (process.env.ANTIGRAVITY_CLI || process.env.AGY_SESSION) return 'antigravity';
  if (process.env.GROK_CLI || process.env.GROK_HOME) return 'grok';
  if (process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDECODE) return 'claude-code';
  return 'codex';
}

function delegationInstruction(harness, taskClass, model, effort, nextRoute) {
  const esc = nextRoute ? `${nextRoute.model} @ ${nextRoute.effort}` : `${model} @ xhigh`;
  if (taskClass === 'fast') {
    const fastSub = {
      antigravity: 'invoke_subagent(Model="flash")',
      'claude-code': 'Task(model="haiku")',
      codex: 'spawn_agent(model="gpt-6-luna", reasoning_effort="low")',
      grok: 'grok-4.7 (low)',
    }[harness];
    return `EXECUTION RULE (FAST TIER): Answer directly with minimal thinking overhead (${model} @ ${effort}). For multi-file/log scans, offload to ${fastSub}. If anything fails verification twice, auto-escalate to ${esc}.`;
  }
  if (taskClass === 'medium') {
    return `EXECUTION RULE (MEDIUM WORKHORSE TIER): Handle directly in the active coordinator session (${model} @ ${effort}) to preserve the warm prompt cache. Offload broad file/log searches to fast subagents. Run QA verification before finishing; if a fix or test fails twice, auto-escalate to ${esc}.`;
  }
  if (taskClass === 'substantial') {
    const subCmd = {
      antigravity: 'invoke_subagent(Model="pro") / gemini-4-neon @ high',
      'claude-code': 'Task(model="opus") / claude-opus-5-5 @ medium (or Sonnet 5.5 @ high)',
      codex: 'spawn_agent(model="gpt-6.2-sol", reasoning_effort="high")',
      grok: 'grok-4.7 @ high',
    }[harness];
    return `EXECUTION RULE (SUBSTANTIAL IMPLEMENTATION TIER): Target allocation is ${model} @ ${effort}. Coordinate multi-file implementation via ${subCmd}. Verify all changed surfaces; if verification fails twice, auto-escalate to ${esc}.`;
  }
  if (taskClass === 'hard') {
    const hardCmd = {
      antigravity: 'invoke_subagent(Model="pro") or swarm(action="add", model="gemini-4-neon-high")',
      'claude-code': 'Task(model="opus") (claude-opus-5-5 @ high; never use Opus max)',
      codex: 'spawn_agent(model="gpt-6.2-astra", reasoning_effort="high")',
      grok: 'grok-build @ high subagent/fork',
    }[harness];
    return `EXECUTION RULE (HARD REASONING TIER): Target allocation is ${model} @ ${effort}. Do NOT burn frontier quota on routine file discovery—gather context first, then delegate the core architecture/debugging/security/review reasoning to ${hardCmd}. If it stalls or fails verification, auto-escalate to surgical frontier tier (${esc}).`;
  }
  // exceptional
  const excCmd = {
    antigravity: 'invoke_subagent(Model="pro") / gemini-4-neon @ xhigh with pre-distilled context',
    'claude-code': 'claude-fable-5-2 @ high via model-router-dispatch.mjs (or Task(model="opus") with distilled context; never open-ended repo scanning)',
    codex: 'spawn_agent(model="gpt-6.2-astra", reasoning_effort="xhigh") with pre-distilled context',
    grok: 'grok-build @ xhigh with pre-distilled context',
  }[harness];
  return `EXECUTION RULE (EXCEPTIONAL / SURGICAL ESCALATION TIER): Target allocation is ${model} @ ${effort}. Feed pre-distilled context only to ${excCmd}; never run open-ended repo scanning at this tier. For critical architecture/security decisions, you may also run dual-host-deliberation.mjs for cross-vendor verification ($0 subscription).`;
}

export function promptContext(payload, { routerDir = path.join(os.homedir(), '.claude/model-router'), run = spawnSync, now = Date.now(), cycle = weeklyCycleStatus } = {}) {
  const lines = [PRESENTATION];
  const weekly = cycle({ routerDir, now });
  if (weekly.status === 'current' && weekly.reviewRequired === false) lines.push(`Weekly model-release check current (${weekly.checkedAt}); retain the approved policy.`);
  else if (weekly.status === 'review-pending') lines.push('A new model release requires assessment; the scheduled weekly LaunchAgent runs that review, not this prompt. The approved policy remains active.');
  else if (weekly.status === 'due') lines.push('The weekly model-release check is due; it runs from the scheduled LaunchAgent, not from this prompt. Retain the approved policy.');
  else if (weekly.status === 'blocked') lines.push(`Weekly model-release check note: ${weekly.reason || 'verification unavailable'}. Retain the approved policy.`);

  const harness = detectHarness(payload);
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  let policy;
  try { policy = JSON.parse(fs.readFileSync(path.join(routerDir, 'routing-policy.json'), 'utf8')); } catch { /* report absence below */ }
  const reviewed = Date.parse(policy?.reviewedAt);
  const age = now - reviewed;
  const configuredMaxAge = policy?.maxAgeMs ?? 604800000;
  const maxAge = Math.min(configuredMaxAge, 604800000);
  const current = policy?.schemaVersion === 1 && Number.isSafeInteger(configuredMaxAge) && configuredMaxAge > 0 && Number.isFinite(reviewed) && age >= 0;
  if (current && age > maxAge) lines.push('Policy approval is older than seven days. Retain the owner-approved allocation and its original date.');

  if (current && prompt && prompt.length <= 65536) {
    const engine = path.join(routerDir, 'bin/model-router-engine.mjs');
    const result = run(process.execPath, [engine, '--harness', harness, '--policy-only', '--json'], {
      input: prompt, encoding: 'utf8', timeout: 1500, maxBuffer: 16384,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const route = JSON.parse(result.stdout || '');
      if (result.status === 0 && /^[a-zA-Z0-9._-]+$/.test(route.model || '') && ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)) {
        const nextClass = NEXT_TIER[route.taskClass] || 'exceptional';
        const nextRoute = policy?.routes?.[harness]?.[nextClass] || null;
        lines.push(`METAHARNESS AUTO-ROUTE (${harness}): taskClass=${route.taskClass} -> model=${route.model}, thinking/effort=${route.effort} ($0 prepaid subscription).`);
        lines.push(`VISIBILITY RULE: Start your response with this exact 1-line badge: [Routed: ${route.taskClass} -> ${route.model} (${route.effort} thinking) · $0 subscription]`);
        lines.push(delegationInstruction(harness, route.taskClass, route.model, route.effort, nextRoute));
        if (route.taskClass !== 'fast') {
          lines.push('QUOTA HYGIENE (4 MANDATORY TOKEN SAVERS): (1) SUBAGENT ISOLATION: Never dump >5 raw files or large logs into the main chat context—offload repo/log searches to a fast subagent (Haiku 5.5 / Gemini Flash / GPT-6 Luna) and return a short summary; (2) 50% CONTEXT COMPACT: Once session context reaches ~50% (yellow in statusline), proactively suggest /compact or a fresh chat before continuing so every reply stops re-sending 500k+ tokens; (3) PRE-DISTILLED ESCALATION: Never let Frontier models (Fable 5.2 / Neon xhigh / Astra xhigh / Grok-Build xhigh) do open-ended repo discovery—distill the relevant files/errors first; (4) CROSS-VENDOR LOAD-SHEDDING: Keep interactive turns in-vendor for warm cache, but if this subscription window is running hot (>80%) or for cold heavy multi-file refactors, recommend shifting to Antigravity (Gemini 4 Neon @ high, $0 implicit cache writes) or an under-utilized prepaid pool.');
        }
      } else {
        lines.push('No routing decision was computed for this prompt; use the default medium coordinator.');
      }
    } catch {
      lines.push('No routing decision was computed for this prompt; use the default medium coordinator.');
    }
  }
  return lines.join('\n');
}

export function envelope(context) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}

async function main() {
  let input = '';
  const timer = setTimeout(() => process.stdin.destroy(), 1000);
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) { input = ''; break; }
    }
  } catch { /* fail open with presentation guidance */ }
  clearTimeout(timer);
  let payload = {};
  try { payload = JSON.parse(input); } catch { /* malformed input never launches a model */ }
  payload.host = detectHarness(payload, process.argv);
  process.stdout.write(JSON.stringify(envelope(promptContext(payload))) + '\n');
}

if (isDirectInvocation(import.meta.url)) {
  main().catch(() => process.stdout.write(JSON.stringify(envelope(PRESENTATION)) + '\n'));
}
