#!/usr/bin/env node
// scripts/model-router-status.mjs — "what is MetaHarness's current plan?", answered plainly.
//
// Shows, for each subscription harness (antigravity, claude-code, codex, grok): the live catalog,
// which policy is active, and what model + thinking/effort level it picks across all 5 tiers
// (fast, medium, substantial, hard, exceptional) by calling the REAL engine CLI.
//
// Usage: node scripts/model-router-status.mjs [--json]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadPolicy, loadProfile, applyProfile, CONFIG_DIR } from './model-router-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, 'model-router-engine.mjs');
const HARNESSES = ['antigravity', 'claude-code', 'codex', 'grok'];

const SAMPLE_PROMPTS = {
  fast: "Fix only the typo in 'The pakage arrived today'.",
  medium: 'Add a new API endpoint that validates input and returns paginated results.',
  substantial: 'Add team invitations with storage, expiration, acceptance endpoints, permissions, UI states, and integration coverage.',
  hard: 'Refactor this auth module to fix a security vulnerability and prove correctness under concurrent access.',
  exceptional: 'That didn\'t work and is still failing; design the initial system architecture and formal verification proof for leader failover.',
};

function sampleDecision(harness, prompt) {
  try {
    const out = execFileSync('node', [ENGINE, '--harness', harness, '--prompt', prompt, '--policy-only', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MODEL_ROUTER_DECISIONS: path.join(os.tmpdir(), 'model-router-status-preview.jsonl') },
    });
    return JSON.parse(out);
  } catch (e) {
    return { model: null, effort: null, tier: null, taskClass: null, reason: `engine call failed: ${e.message}` };
  }
}

function codexAuthMode() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    if (a.tokens) return 'chatgpt-subscription';
    if (a.OPENAI_API_KEY) return 'api-key-metered';
  } catch { /* absent or unreadable */ }
  return null;
}

function detectInventory() {
  const has = (cmd) => {
    try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
  };
  return {
    agyCli: has('agy') || fs.existsSync(path.join(os.homedir(), '.gemini/bin/agy')),
    claudeCli: has('claude'),
    codexCli: has('codex'),
    grokCli: has('grok') || fs.existsSync(path.join(os.homedir(), '.grok/bin/grok')),
    codexAuthed: fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json')),
    codexAuthMode: codexAuthMode(),
    grokAuthed: fs.existsSync(path.join(os.homedir(), '.grok', 'auth.json')),
  };
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const candidates = applyProfile(loadCatalog(), loadProfile());
  const policy = await loadPolicy();
  const catalogRaw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'catalog.json'), 'utf8'));
  const inventory = detectInventory();

  const selectable = candidates.filter((c) => Array.isArray(c.harness) && c.harness.length > 0);
  const landscapeOnly = candidates.filter((c) => !Array.isArray(c.harness) || c.harness.length === 0);

  const plan = {};
  for (const harness of HARNESSES) {
    plan[harness] = {};
    for (const [tierLabel, prompt] of Object.entries(SAMPLE_PROMPTS)) {
      const d = sampleDecision(harness, prompt);
      plan[harness][tierLabel] = {
        model: d.model,
        effort: d.effort,
        taskClass: d.taskClass,
        actualTier: d.tier,
        cost: d.est_input_cost_usd,
        subscriptionCovered: d.subscriptionCovered,
        reason: d.reason,
      };
    }
  }

  const result = {
    catalogUpdated: catalogRaw.updated,
    activePolicy: policy ? policy.source.replace(os.homedir(), '~') : 'NONE',
    inventory,
    plan,
    selectableCandidateCount: selectable.length,
    landscapeOnlyCandidates: landscapeOnly.map((c) => ({ id: c.id, provider: c.provider, note: c.note })),
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('Recommended path ($0 prepaid subscriptions only — never pay-by-the-drink):');
  for (const harness of HARNESSES) {
    const p = plan[harness];
    const zero = Object.keys(SAMPLE_PROMPTS)
      .map((t) => ({ t, m: p[t].model, e: p[t].effort, free: (p[t].cost == null || p[t].cost === 0) && p[t].model }))
      .filter((x) => x.free);
    if (zero.length) {
      const parts = zero.map((x) => `${x.t}→${x.m}@${x.e}`);
      console.log(`  ${harness.padEnd(13)} ${parts.join(' · ')}`);
    } else {
      console.log(`  ${harness.padEnd(13)} (no subscription-covered models for this user — see profile)`);
    }
  }
  console.log('');
  console.log(`MetaHarness Router — 4-Host Subscription Plan (AA v5.0.1 / Vals v2.2 / KingBench 4 optimized)`);
  console.log(`Catalog last updated: ${result.catalogUpdated}`);
  console.log(`Active policy: ${result.activePolicy}`);
  console.log('');
  for (const harness of HARNESSES) {
    console.log(`${harness}:`);
    for (const tierLabel of Object.keys(SAMPLE_PROMPTS)) {
      const p = plan[harness][tierLabel];
      const modelEffort = p.model ? `${p.model} (${p.effort})` : '(none)';
      const costStr = (p.cost === 0 || p.cost == null) && p.model ? '$0 subscription' : `est $${p.cost}`;
      console.log(`  ${tierLabel.padEnd(12)} -> ${modelEffort.padEnd(34)} ${costStr}`);
    }
  }
}

main().catch((e) => { process.stderr.write(`model-router-status: ${e.stack || e.message}\n`); process.exit(1); });
