#!/usr/bin/env node
// Per-user prompt guidance. Routing is ADVICE ONLY: the managed dispatcher is retired and nothing
// enforces a route. This hook only reads state (4.7.1): it never claims or launches the weekly cycle,
// which runs from the scheduled LaunchAgent (com.ruvnet.goldie-weekly).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { weeklyCycleStatus } from './model-weekly-cycle.mjs';

export const PRESENTATION = 'For terminal briefings: give concise executive status; use narrow padded ASCII tables with borders, plain cell text, aligned columns and short rows. Never send pipe-delimited Markdown tables to this terminal. Use short lists when a table would wrap. Do not flood the response with commands or technical logs.';

export function promptContext(payload, { routerDir = path.join(os.homedir(), '.claude/model-router'), run = spawnSync, now = Date.now(), cycle = weeklyCycleStatus } = {}) {
  const lines = [PRESENTATION];
  const weekly = cycle({ routerDir, now });
  if (weekly.status === 'current' && weekly.reviewRequired === false) lines.push(`Weekly model-release check current (${weekly.checkedAt}); retain the approved policy. Full assessment runs only for newly discovered OpenAI or Anthropic models. This is not a semantic-review or promotion claim.`);
  else if (weekly.status === 'review-pending') lines.push('A new model release requires assessment; the scheduled weekly LaunchAgent runs that review, not this prompt. The approved policy remains active.');
  else if (weekly.status === 'due') lines.push('The weekly model-release check is due; it runs from the scheduled LaunchAgent, not from this prompt. Retain the approved policy; do not claim no changes.');
  else if (weekly.status === 'blocked') lines.push(`Weekly model-release check needs attention: ${weekly.reason || 'verification unavailable'}. Retain the approved policy; do not claim no changes or a completed review.`);
  const harness = payload?.host === 'claude-code' ? 'claude-code' : 'codex';
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  let policy;
  try { policy = JSON.parse(fs.readFileSync(path.join(routerDir, 'routing-policy.json'), 'utf8')); } catch { /* report absence below */ }
  const reviewed = Date.parse(policy?.reviewedAt);
  const age = now - reviewed;
  const configuredMaxAge = policy?.maxAgeMs ?? 604800000;
  const maxAge = Math.min(configuredMaxAge, 604800000);
  const current = policy?.schemaVersion === 1 && Number.isSafeInteger(configuredMaxAge) && configuredMaxAge > 0 && Number.isFinite(reviewed) && age >= 0;
  if (current && age > maxAge) lines.push('Policy approval is older than seven days. Retain the owner-approved allocation and its original date; verify native availability before every launch. Age alone does not trigger reassessment.');
  lines.push(current ? `Model routing policy reviewed ${policy.reviewedAt}. Its routes are advice only; nothing enforces them.` : 'Model routing policy is missing or invalid, so no routing advice is available. Routing is advice only; nothing enforces it.');
  if (current && prompt && prompt.length <= 65536) {
    const engine = path.join(routerDir, 'bin/model-router-engine.mjs');
    const result = run(process.execPath, [engine, '--harness', harness, '--policy-only', '--json'], {
      input: prompt, encoding: 'utf8', timeout: 1500, maxBuffer: 16384,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const route = JSON.parse(result.stdout || '');
      if (result.status === 0 && /^[a-zA-Z0-9._-]+$/.test(route.model || '') && ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)) {
        lines.push(`Routing advice for this prompt (advice only, not enforced): ${route.model}, effort ${route.effort}. This hook does not switch the active parent model or launch anything.`);
      } else lines.push('No routing advice was computed for this prompt; do not infer an automatic model switch.');
    } catch { lines.push('No routing advice was computed for this prompt; do not infer an automatic model switch.'); }
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
  if (process.argv.includes('--claude')) payload.host = 'claude-code';
  process.stdout.write(JSON.stringify(envelope(promptContext(payload))) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => process.stdout.write(JSON.stringify(envelope(PRESENTATION)) + '\n'));
}
