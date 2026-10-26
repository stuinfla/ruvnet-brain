#!/usr/bin/env node
// model-router-setup.mjs — build THIS user's subscription profile: detect, ASK, verify, record.
//
// Stuart's mandate (2026-07-12): "Just because you verified it for me doesn't mean other people
// have the same setup. For this thing to be useful it needs to be aware of what THEY have — ask
// 'Do you have a Claude account? A ChatGPT/Codex account?', verify, and record it, so routing
// sends work to the right place." The router's whole $0-floor logic is only as true as this
// profile: a catalog that assumes a subscription the user doesn't have quietly bills them, and
// one that misses a subscription they DO have quietly wastes it.
//
// Three layers of truth, recorded with their basis so nobody over-trusts a guess:
//   verified      — machine-checkable proof (e.g. ~/.codex/auth.json carries ChatGPT OAuth tokens)
//   user-attested — the user answered the question (plans aren't reliably probeable)
//   assumed       — --detect-only defaults, explicitly labeled as assumptions
//
// Output: ~/.claude/model-router/profile.json — consumed by model-router-engine.mjs, which strips
// subscription/harness claims the profile doesn't back. No profile file = catalog taken as-is
// (grandfathers pre-profile installs; the session-start hook nudges once to create one).
//
// Usage:
//   node model-router-setup.mjs                 # interactive: detect, ask, verify, record
//   node model-router-setup.mjs --detect-only   # non-interactive (installer): record detections + labeled assumptions
//   node model-router-setup.mjs --show          # print the current profile

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'model-router');
export const PROFILE_PATH = process.env.MODEL_ROUTER_PROFILE || path.join(CONFIG_DIR, 'profile.json');
const TODAY = new Date().toISOString().slice(0, 10);

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

// The one subscription state we can PROVE from disk: Codex's auth mode. OAuth tokens = signed in
// with ChatGPT (Plus/Pro/Business all include Codex → subscription-covered). An API key = metered.
// Shape only — never the secret values.
function detectCodex() {
  const cli = has('codex');
  try {
    const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    if (a.tokens) return { cli, auth: 'chatgpt-subscription' };
    if (a.OPENAI_API_KEY) return { cli, auth: 'api-key-metered' };
  } catch { /* not authed */ }
  return { cli, auth: null };
}

function detectKeys() {
  const names = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
  return Object.fromEntries(names.map((n) => [n, !!process.env[n]]));
}

function buildDetected() {
  const codex = detectCodex();
  return {
    updated: TODAY,
    harnesses: {
      // Claude plan tier (Pro vs Max vs API-billed) is not reliably probeable from disk, so
      // detect-only ASSUMES subscription=true when the CLI is present: right-sizing WITHIN
      // Anthropic (haiku over fable) is correct under every Claude billing mode, whereas a false
      // "no subscription" would push claude-code work to BILLED OpenRouter — the worse error.
      'claude-code': has('claude')
        ? { available: true, subscription: true, plan: 'unknown', basis: `assumed: claude CLI present (${TODAY}); run setup to attest your plan` }
        : { available: false, subscription: false, plan: null, basis: `detected: no claude CLI (${TODAY})` },
      codex: codex.auth === 'chatgpt-subscription'
        ? { available: true, subscription: true, plan: 'chatgpt', basis: `verified: ~/.codex/auth.json ChatGPT OAuth tokens (${TODAY})` }
        : codex.auth === 'api-key-metered'
          ? { available: true, subscription: false, plan: 'api-key', basis: `verified: ~/.codex/auth.json API key — METERED (${TODAY})` }
          : { available: codex.cli, subscription: false, plan: null, basis: `detected: codex ${codex.cli ? 'present, not authed' : 'not installed'} (${TODAY})` },
    },
    keys: detectKeys(),
  };
}

function save(profile) {
  fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2) + '\n');
}

function show(profile) {
  console.log(`Model-router subscription profile (${PROFILE_PATH.replace(os.homedir(), '~')}):`);
  for (const [h, p] of Object.entries(profile.harnesses)) {
    console.log(`  ${h.padEnd(12)} ${p.available ? 'available' : 'not available'}${p.available ? `, subscription: ${p.subscription ? 'YES ($0 marginal)' : 'NO (metered/absent)'}` : ''}`);
    console.log(`  ${''.padEnd(12)} basis: ${p.basis}`);
  }
  const keys = Object.entries(profile.keys || {}).filter(([, v]) => v).map(([k]) => k.replace('_API_KEY', ''));
  console.log(`  API keys present at setup: ${keys.join(', ') || 'none'}`);
}

async function interactive() {
  const detected = buildDetected();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
    return a === '' ? def : a.startsWith('y');
  };

  console.log('Setting up YOUR subscription profile — this decides where the router sends work for $0.\n');

  const cc = detected.harnesses['claude-code'];
  if (cc.available) {
    const sub = await ask('Do you have a Claude subscription (Pro or Max) that covers your Claude Code usage?', cc.subscription);
    detected.harnesses['claude-code'] = { available: true, subscription: sub, plan: sub ? 'pro-or-max' : 'api-billed', basis: `user-attested ${TODAY}` };
  }

  const cx = detected.harnesses.codex;
  if (cx.plan === 'chatgpt') {
    console.log(`\nCodex: VERIFIED signed in with ChatGPT — your ChatGPT plan covers it ($0 marginal). Nothing to ask.`);
  } else if (cx.available) {
    const sub = await ask('\nDo you have a ChatGPT subscription (Plus/Pro/Business) you use to sign into the Codex CLI?', false);
    if (sub) console.log('  Note: run `codex login` and sign in with ChatGPT — until then Codex runs are metered or unavailable.');
    detected.harnesses.codex = { ...cx, subscription: cx.plan === 'chatgpt' ? true : false, basis: `user-attested ${TODAY} (subscription only counts once codex login shows ChatGPT auth)` };
  }

  rl.close();
  save(detected);
  console.log('');
  show(detected);
  console.log('\nSaved. The router now uses THIS profile for every routing decision.');
}

async function main() {
  if (process.argv.includes('--show')) {
    try { show(JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'))); } catch { console.log(`No profile at ${PROFILE_PATH.replace(os.homedir(), '~')} — run: node scripts/model-router-setup.mjs`); process.exit(1); }
    return;
  }
  if (process.argv.includes('--detect-only')) {
    const p = buildDetected();
    save(p);
    show(p);
    return;
  }
  await interactive();
}

const { pathToFileURL } = await import('node:url');
if (isDirectInvocation(import.meta.url)) {
  main().catch((e) => { console.error(`model-router-setup: ${e.message}`); process.exit(1); });
}
