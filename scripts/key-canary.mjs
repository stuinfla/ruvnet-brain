#!/usr/bin/env node
// key-canary.mjs — live-probe every provider API key the environment delivers, and GONG on death.
//
// Built 2026-07-12, the day two dead keys were found by accident months after they died
// (ANTHROPIC_API_KEY and the machine-wide OPENAI_API_KEY, both 401). Stuart's mandate: staleness
// must be a monitoring problem, not a memory problem — "I'm just trying to find a way to not keep
// dealing with stale keys project to project."
//
// WHAT IT DOES: for each known provider key PRESENT in the environment, makes the cheapest
// possible authenticated call (list-models class — $0, no tokens billed) and classifies:
//   alive   — HTTP 2xx
//   DEAD    — HTTP 401/403 (the key itself is rejected)
//   unknown — network error / timeout / 5xx (NOT a key problem; never alarms)
// Absent keys are reported as absent (informational — many machines won't have every provider).
//
// GONG DISCIPLINE (same transition model as kb/brain-alarm.mjs): --notify sends ONE urgent push
// when a key TRANSITIONS to dead, and one recovery push when it comes back — not a re-alarm every
// night for a key you already know about (state: ~/.claude/metaharness/key-canary-state.json).
// Exit code: 1 if any key is DEAD (so wrappers/CI can react), else 0.
//
// RUN IT THROUGH THE REAL DELIVERY CHAIN: `zsh -lc 'node scripts/key-canary.mjs'` — a login shell
// sources ~/.zshrc -> env.global + the openclaw SOPS secrets, so the canary tests the exact env
// every real shell and script inherits, not a hand-fed copy. Never prints a key value.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STATE = path.join(os.homedir(), '.claude', 'metaharness', 'key-canary-state.json');
const NOTIFY = process.argv.includes('--notify');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROBES = [
  { env: 'ANTHROPIC_API_KEY', provider: 'Anthropic', url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  { env: 'OPENAI_API_KEY', provider: 'OpenAI', url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'OPENROUTER_API_KEY', provider: 'OpenRouter', url: 'https://openrouter.ai/api/v1/key', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'GOOGLE_API_KEY', provider: 'Google/Gemini', url: null, headers: null }, // key goes in query string, built below
  { env: 'GEMINI_API_KEY', provider: 'Google/Gemini (GEMINI_API_KEY)', url: null, headers: null },
  { env: 'XAI_API_KEY', provider: 'xAI', url: 'https://api.x.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
];

async function probe(p, key) {
  const url = p.url || `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { headers: p.headers ? p.headers(key) : {}, signal: AbortSignal.timeout(12000) });
    if (res.ok) return 'alive';
    if (res.status === 401 || res.status === 403) return 'DEAD';
    return `unknown(HTTP ${res.status})`;
  } catch (e) {
    return `unknown(${e.name === 'TimeoutError' ? 'timeout' : 'network'})`;
  }
}

/** true only when notify.sh reports a delivered page (exit 0). A failed or opted-out page (NTFY_TOPIC="") is not
 *  delivered, so the key's previous state is kept and the transition fires again next run (4.7.21). Titles are
 *  plain ASCII; the emoji rides in Tags. */
function notify(title, message, priority, tags) {
  try {
    execFileSync('sh', [path.join(REPO, 'scripts', 'notify.sh'), title, message, priority, tags], { cwd: REPO, stdio: 'ignore', timeout: 15000 });
    return true;
  } catch { return false; /* notification failure must not break the canary */ }
}

const prev = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const now = {};
let anyDead = false;

for (const p of PROBES) {
  const key = process.env[p.env];
  if (!key) { console.log(`  ${p.env.padEnd(20)} absent`); continue; }
  const status = await probe(p, key);
  now[p.env] = { status, ts: new Date().toISOString() };
  const mark = status === 'alive' ? '✅' : status === 'DEAD' ? '🚨' : '❓';
  console.log(`  ${p.env.padEnd(20)} ${mark} ${status}  (${p.provider}, key len ${key.length})`);
  if (status === 'DEAD') {
    anyDead = true;
    if (NOTIFY && prev[p.env]?.status !== 'DEAD') {
      const sent = notify(`${p.provider} API key is DEAD`,
        `${p.env} was rejected (401/403) by ${p.provider} just now. Every script using it is silently failing. `
        + `Rotate it: edit ~/Code/openclaw-stack/secrets.env, then run secrets-sync.sh seal.`,
        'urgent', 'rotating_light,key');
      if (!sent) now[p.env] = prev[p.env] ?? { status: 'unpaged', ts: now[p.env].ts };
    }
  } else if (status === 'alive' && NOTIFY && prev[p.env]?.status === 'DEAD') {
    const sent = notify(`${p.provider} API key recovered`, `${p.env} is working again.`, 'default', 'white_check_mark,key');
    if (!sent) now[p.env] = prev[p.env];
  }
}

try {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(now, null, 2) + '\n');
} catch { /* state persistence is best-effort */ }

process.exit(anyDead ? 1 : 0);
