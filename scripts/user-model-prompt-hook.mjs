#!/usr/bin/env node
// Per-user prompt guidance. Execution is enforced separately by the managed dispatcher.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { maybeLaunchWeeklyCycle } from './model-weekly-cycle.mjs';

export const PRESENTATION = 'For terminal briefings: give concise executive status; use narrow padded ASCII tables with borders, plain cell text, aligned columns and short rows. Never send pipe-delimited Markdown tables to this terminal. Use short lists when a table would wrap. Do not flood the response with commands or technical logs.';

export function promptContext(payload, { routerDir = path.join(os.homedir(), '.claude/model-router'), run = spawnSync, now = Date.now(), cycle = maybeLaunchWeeklyCycle } = {}) {
  const lines = [PRESENTATION];
  const weekly = cycle({ routerDir, now });
  if (weekly.status === 'current' && weekly.reviewRequired === false) lines.push(`Weekly model-release check current (${weekly.checkedAt}); retain the approved policy. Full assessment runs only for newly discovered OpenAI or Anthropic models. This is not a semantic-review or promotion claim.`);
  else if (weekly.launched) lines.push(weekly.reviewRequired
    ? 'A new model release requires assessment; the bounded review is pending and the approved policy remains active.'
    : 'A lightweight weekly model-release check started; no full assessment is required unless a new relevant model is found.');
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
  lines.push(current ? `Model routing policy reviewed ${policy.reviewedAt}; consult this user's policy for every delegated launch.` : 'Model routing policy is missing or invalid. Establish a valid approved policy before managed dispatch.');
  if (current && prompt && prompt.length <= 65536) {
    const engine = path.join(routerDir, 'bin/model-router-engine.mjs');
    const result = run(process.execPath, [engine, '--harness', harness, '--policy-only', '--json'], {
      input: prompt, encoding: 'utf8', timeout: 1500, maxBuffer: 16384,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const route = JSON.parse(result.stdout || '');
      if (result.status === 0 && /^[a-zA-Z0-9._-]+$/.test(route.model || '') && ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)) {
        lines.push(`This prompt's managed route: ${route.model}, effort ${route.effort}. Use the managed dispatcher for actual launch enforcement. This hook supplies context; it does not switch the active parent model.`);
      } else lines.push('Prompt routing was not verified; do not infer an automatic model switch.');
    } catch { lines.push('Prompt routing was not verified; do not infer an automatic model switch.'); }
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
