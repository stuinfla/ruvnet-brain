#!/usr/bin/env node
// model-auto-refresh.mjs — Automated subscription model discovery + same-family generation sync
// across all 4 prepaid subscription hosts (antigravity, claude-code, codex, grok).
// Runs weekly via goldie-weekly.sh AND nightly via developer-maintenance.mjs.
// Never enables API billing: all candidates remain subscription-only ($0 marginal cost) and effort
// levels remain locked to Artificial Analysis v5.0.1 / Vals v2.2 / KingBench 4 optimal caps.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROUTER_DIR = process.env.MODEL_ROUTER_CONFIG_DIR || path.join(os.homedir(), '.claude', 'model-router');

// Canonical subscription models across all 4 prepaid hosts with AA v5.0.1 / Vals v2.2 pricing & effort caps
const CANONICAL_SUBSCRIPTION_MODELS = [
  {
    id: 'gemini-4-flash',
    provider: 'google',
    harness: ['antigravity'],
    subscription: ['antigravity'],
    tier: 'cheap',
    supportedEfforts: ['low', 'medium'],
    costPerMTok: { in: 0.15, out: 0.6 },
    verified: '2026-11-22 Antigravity Ultra subscription ($0 marginal) + Artificial Analysis v5.0.1',
    note: 'Fast subagent scan tier (Model="flash" / flash_lite) under Antigravity Ultra subscription.',
  },
  {
    id: 'gemini-4-argon',
    provider: 'google',
    harness: ['antigravity'],
    subscription: ['antigravity'],
    tier: 'mid',
    supportedEfforts: ['low', 'medium', 'high'],
    costPerMTok: { in: 1.25, out: 5.0 },
    verified: '2026-11-22 Antigravity Ultra subscription ($0 marginal)',
    note: 'Spritely coordinator model in Antigravity Ultra subscription.',
  },
  {
    id: 'gemini-4-neon',
    provider: 'google',
    harness: ['antigravity'],
    subscription: ['antigravity'],
    tier: 'frontier',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    costPerMTok: { in: 3.0, out: 15.0 },
    verified: '2026-11-22 Artificial Analysis v5.0.1 (44@low $0.75, 55@medium $1.90, 60@high $3.74, 61@xhigh $6.44); Vals v2.2 70.9%; KingBench 4 37.9/60',
    note: 'Highest intelligence-per-dollar efficiency frontier ($0 under Antigravity Ultra). Default high (score 60) beats Opus 5.5 max (59); reserve xhigh for failure escalation.',
  },
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    harness: ['claude-code'],
    subscription: ['claude-code'],
    tier: 'cheap',
    supportedEfforts: ['low', 'medium', 'high'],
    costPerMTok: { in: 0.8, out: 4.0 },
    verified: '2026-11-22 native Claude Max subscription + 16,285 verified session turns',
    note: 'Fast triage & repo discovery subagent tier ($0 under Claude Max). Keeps Opus/Fable out of open-ended discovery.',
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    harness: ['claude-code'],
    subscription: ['claude-code'],
    tier: 'mid',
    supportedEfforts: ['low', 'medium', 'high'],
    costPerMTok: { in: 2.0, out: 10.0 },
    verified: '2026-11-22 native Claude Max subscription + 93,330 verified session turns',
    note: 'Default Claude Code coordinator ($0 under Claude Max). Medium effort for chat, high effort for routine coding.',
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    harness: ['claude-code'],
    subscription: ['claude-code'],
    tier: 'frontier',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    costPerMTok: { in: 4.0, out: 20.0 },
    verified: '2026-11-22 Artificial Analysis v5.0.1 (35@low $0.98, 48@medium $2.45, 52@high $3.46, 57@xhigh $6.05, 59@max $10.04); Terminal-Bench 4.1 65.8%',
    note: 'Terminal-heavy loops, explicit 5-min prompt caching, and security-critical code ($0 under Claude Max). Cap at medium/high; never use max ($10.04/task).',
  },
  {
    id: 'claude-fable-5-2',
    provider: 'anthropic',
    harness: ['claude-code'],
    subscription: ['claude-code'],
    tier: 'frontier',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    costPerMTok: { in: 8.0, out: 40.0 },
    verified: '2026-11-22 Artificial Analysis v5.0.1 (54@low $3.10, 56@medium $3.80, 62@high $9.08, 65@max $26.54); Vals v2.2 #1 (71.3%); KingBench 4 #1 (42.0/60)',
    note: 'Surgical frontier escalation (<5% of tasks: initial architecture, novel algorithms, adversarial review, or prior-attempt failure escalation) at high effort with pre-distilled context ($0 under Claude Max).',
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    harness: ['codex'],
    subscription: ['codex'],
    tier: 'cheap',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    costPerMTok: { in: 0.1, out: 0.5 },
    verified: '2026-11-22 ~/.codex/models_cache.json native ChatGPT subscription',
    note: 'Fast mechanical and scan tier ($0 under ChatGPT/Codex subscription).',
  },
  {
    id: 'gpt-6.2-sol',
    provider: 'openai',
    harness: ['codex'],
    subscription: ['codex'],
    tier: 'mid',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    costPerMTok: { in: 2.0, out: 10.0 },
    verified: '2026-11-22 ~/.codex/models_cache.json + native-availability.json ($0 under ChatGPT/Codex subscription)',
    note: 'Default Codex coordinator and substantial implementation workhorse ($0 under ChatGPT/Codex subscription).',
  },
  {
    id: 'gpt-6.2-astra',
    provider: 'openai',
    harness: ['codex'],
    subscription: ['codex'],
    tier: 'frontier',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    costPerMTok: { in: 4.0, out: 20.0 },
    verified: '2026-11-22 ~/.codex/models_cache.json + native-availability.json ($0 under ChatGPT/Codex subscription)',
    note: 'Bounded hard reasoning (high) and failure-escalation (xhigh) tier in Codex ($0 under ChatGPT/Codex subscription).',
  },
  {
    id: 'grok-4.7',
    provider: 'xai',
    harness: ['grok'],
    subscription: ['grok'],
    tier: 'mid',
    supportedEfforts: ['low', 'medium', 'high'],
    costPerMTok: null,
    verified: '2026-11-22 ~/.grok/config.toml native xAI subscription ($0 marginal)',
    note: 'Default Grok coordinator (low/medium/high effort) under xAI subscription.',
  },
  {
    id: 'grok-build',
    provider: 'xai',
    harness: ['grok'],
    subscription: ['grok'],
    tier: 'frontier',
    supportedEfforts: ['medium', 'high', 'xhigh'],
    costPerMTok: null,
    verified: '2026-11-22 ~/.grok/config.toml fork_secondary_model native xAI subscription ($0 marginal)',
    note: 'Hard reasoning and surgical build escalation model in Grok CLI under xAI subscription.',
  },
];

function parseVer(id, regex) {
  const m = regex.exec(id);
  if (!m) return null;
  return m[1].split(/[.-]/).map((n) => parseInt(n, 10) || 0);
}

function compareVer(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function highestMatching(ids, regex) {
  let best = null;
  let bestVer = null;
  for (const id of ids) {
    const v = parseVer(id, regex);
    if (!v) continue;
    if (!bestVer || compareVer(v, bestVer) > 0) {
      best = id;
      bestVer = v;
    }
  }
  return best;
}

export function refreshCatalogAndPolicy({ routerDir = ROUTER_DIR, apply = true, now = Date.now() } = {}) {
  const catalogPath = path.join(routerDir, 'catalog.json');
  const policyPath = path.join(routerDir, 'routing-policy.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

  let catalogChanges = 0;
  const byId = new Map(catalog.candidates.map((c) => [c.id, c]));

  // 1. Merge canonical subscription models and update missing tier/supportedEfforts
  for (const canon of CANONICAL_SUBSCRIPTION_MODELS) {
    const existing = byId.get(canon.id);
    if (!existing) {
      catalog.candidates.push({ ...canon });
      byId.set(canon.id, canon);
      catalogChanges++;
    } else {
      let touched = false;
      for (const k of ['provider', 'tier', 'supportedEfforts', 'harness', 'subscription', 'costPerMTok', 'verified', 'note']) {
        if (canon[k] !== undefined && JSON.stringify(existing[k]) !== JSON.stringify(canon[k])) {
          existing[k] = canon[k];
          touched = true;
        }
      }
      if (touched) catalogChanges++;
    }
  }

  // 2. Discover any newer native models in ~/.codex/models_cache.json
  const codexCachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (fs.existsSync(codexCachePath)) {
    try {
      const codexCache = JSON.parse(fs.readFileSync(codexCachePath, 'utf8'));
      for (const m of codexCache.models || []) {
        if (!m.slug || !/^[a-zA-Z0-9._-]+$/.test(m.slug)) continue;
        const efforts = (m.supported_reasoning_levels || [])
          .map((e) => e.effort)
          .filter((e) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e));
        if (!efforts.length) continue;
        if (!byId.has(m.slug)) {
          const tier = /luna|mini/i.test(m.slug) ? 'cheap' : /astra|pro/i.test(m.slug) ? 'frontier' : 'mid';
          const entry = {
            id: m.slug,
            provider: 'openai',
            harness: ['codex'],
            subscription: ['codex'],
            tier,
            supportedEfforts: [...new Set(efforts)].sort(),
            costPerMTok: null,
            verified: `${new Date(now).toISOString()} ~/.codex/models_cache.json live discovery`,
            note: 'Auto-discovered from local Codex subscription cache.',
          };
          catalog.candidates.push(entry);
          byId.set(m.slug, entry);
          catalogChanges++;
        }
      }
    } catch { /* ignore unreadable cache */ }
  }

  // 3. Auto-promote newer verified minor versions within the same family in routing-policy.json
  const codexIds = catalog.candidates
    .filter((c) => c.provider === 'openai' && (c.subscription || []).includes('codex') && (c.harness || []).includes('codex'))
    .map((c) => c.id);
  const claudeIds = catalog.candidates
    .filter((c) => c.provider === 'anthropic' && (c.subscription || []).includes('claude-code') && (c.harness || []).includes('claude-code'))
    .map((c) => c.id);
  const agyIds = catalog.candidates
    .filter((c) => c.provider === 'google' && (c.subscription || []).includes('antigravity') && (c.harness || []).includes('antigravity'))
    .map((c) => c.id);
  const grokIds = catalog.candidates
    .filter((c) => c.provider === 'xai' && (c.subscription || []).includes('grok') && (c.harness || []).includes('grok'))
    .map((c) => c.id);

  const bestSol = highestMatching(codexIds, /^gpt-(\d+(?:\.\d+)*)-sol$/);
  const bestAstra = highestMatching(codexIds, /^gpt-(\d+(?:\.\d+)*)-astra$/);
  const bestLuna = highestMatching(codexIds, /^gpt-(\d+(?:\.\d+)*)-luna$/);

  const bestHaiku = highestMatching(claudeIds, /^claude-haiku-(\d+(?:-\d+)*)$/);
  const bestSonnet = highestMatching(claudeIds, /^claude-sonnet-(\d+(?:-\d+)*)$/);
  const bestOpus = highestMatching(claudeIds, /^claude-opus-(\d+(?:-\d+)*)$/);
  const bestFable = highestMatching(claudeIds, /^claude-fable-(\d+(?:-\d+)*)$/);

  const bestNeon = highestMatching(agyIds, /^gemini-(\d+(?:-\d+)*)-neon$/);
  const bestGrok = highestMatching(grokIds, /^grok-(\d+(?:\.\d+)*)$/);

  const promotions = [];
  const promote = (harness, role, newModel) => {
    if (!newModel || !policy.routes?.[harness]?.[role]) return;
    const cur = policy.routes[harness][role].model;
    if (cur !== newModel) {
      promotions.push({ harness, role, from: cur, to: newModel });
      policy.routes[harness][role].model = newModel;
    }
  };

  promote('codex', 'fast', bestLuna);
  promote('codex', 'medium', bestSol);
  promote('codex', 'substantial', bestSol);
  promote('codex', 'hard', bestAstra);
  promote('codex', 'exceptional', bestAstra);

  promote('claude-code', 'fast', bestHaiku);
  promote('claude-code', 'medium', bestSonnet);
  promote('claude-code', 'substantial', bestOpus);
  promote('claude-code', 'hard', bestOpus);
  promote('claude-code', 'exceptional', bestFable);

  promote('antigravity', 'fast', bestNeon);
  promote('antigravity', 'medium', bestNeon);
  promote('antigravity', 'substantial', bestNeon);
  promote('antigravity', 'hard', bestNeon);
  promote('antigravity', 'exceptional', bestNeon);

  promote('grok', 'fast', bestGrok);
  promote('grok', 'medium', bestGrok);
  promote('grok', 'substantial', bestGrok);

  if (apply && (catalogChanges > 0 || promotions.length > 0)) {
    catalog.updated = new Date(now).toISOString().slice(0, 10);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    if (promotions.length > 0) {
      policy.reviewedAt = new Date(now).toISOString();
      policy.policyRevisionAt = new Date(now).toISOString();
      fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n');
    }
  }

  return {
    ok: true,
    checkedAt: new Date(now).toISOString(),
    applied: apply,
    catalogChanges,
    promotions,
    activeRoutes: {
      antigravity: policy.routes?.antigravity,
      'claude-code': policy.routes?.['claude-code'],
      codex: policy.routes?.codex,
      grok: policy.routes?.grok,
    },
  };
}

if (isDirectInvocation(import.meta.url)) {
  const apply = !process.argv.includes('--check');
  const res = refreshCatalogAndPolicy({ apply });
  console.log(JSON.stringify(res, null, 2));
}
