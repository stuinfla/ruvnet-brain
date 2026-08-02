#!/usr/bin/env node
// scripts/model-router-engine.mjs — the harness-neutral MODEL SELECTION engine.
//
// WHAT THIS IS (and is NOT):
//   • IS: a pure `prompt -> {model, provider, reason, cost}` DECISION engine. It extracts features
//     from the prompt and hands them to a PLUGGABLE POLICY that decides which model to use. The
//     policy is the swappable part — drop your researched heuristics (or a learned router) into
//     ~/.claude/model-router/policy.mjs and the engine picks them up. NO heuristics are baked in
//     here. (ADR-040 / DRACO, verified via search_ruvnet: a hand-built self-signal threshold routed
//     WORSE than always-cheapest; a learned map from a real feature beat the best fixed model. So
//     the SIGNAL/policy is everything and must never be hard-coded into the engine.)
//   • IS harness-neutral: the SAME CLI is consulted by Claude Code AND Codex. It only DECIDES; it
//     does not launch a model. The caller acts on the JSON. (Codex has no native routing surface —
//     ~/.codex/config.toml launches one model per run — so a consulted CLI is the only way to make
//     selection work for Codex too. That is the fix for "only partially OK for Codex.")
//   • Is NOT an executor. Running a task on a cheap model is route-cheap.mjs's job (OpenRouter).
//     This answers only "which model should handle this prompt?"
//
// INTEGRATION:
//   Claude Code : call from a hook/skill, parse the JSON, use .model.
//                   node model-router-engine.mjs --harness claude-code --prompt "$PROMPT" --json
//   Codex       : wrap the codex launch —
//                   M=$(node model-router-engine.mjs --harness codex --prompt "$TASK" --json | jq -r .model)
//                   codex --model "$M"  ...
//
// Config (edit freely):  ~/.claude/model-router/catalog.json   (candidates + verified pricing)
//                        ~/.claude/model-router/policy.mjs      (YOUR policy; falls back to policy.default.mjs)
// Decision log:          ~/.claude/metaharness/routing-decisions.jsonl  (sibling to route-cheap's execution receipts)
//
// Usage:
//   node model-router-engine.mjs --prompt "..." [--harness claude-code|codex] [--policy <path>] [--json|--line]
//   echo "the prompt text" | node model-router-engine.mjs --harness codex

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { estTokens } from './route-cheap.mjs'; // reuse the verified char/4 estimator (DRY)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = path.join(os.homedir(), '.claude', 'model-router');
// Overridable for hermetic tests + CI (runners have no ~/.claude): the 2026-07-12 CI redness was
// exactly this — tests that silently depended on one developer's machine state.
const CATALOG_PATH = process.env.MODEL_ROUTER_CATALOG || path.join(CONFIG_DIR, 'catalog.json');
const POLICY_USER = path.join(CONFIG_DIR, 'policy.mjs');
const POLICY_DEFAULT = path.join(CONFIG_DIR, 'policy.default.mjs');
const DECISIONS_LOG =
  process.env.MODEL_ROUTER_DECISIONS ||
  path.join(os.homedir(), '.claude', 'metaharness', 'routing-decisions.jsonl');

// ─── feature extraction: this is "based on what the prompt is" ────────────────────────────────
// Pure and deterministic. Emits SIGNALS only — it never decides. Policies consume these; extend
// this object as your research identifies new predictive features (it is the documented surface).
export function extractFeatures(prompt, harness) {
  const text = prompt || '';
  const codeFences = Math.floor((text.match(/```/g) || []).length / 2);
  const fileTypes = [...new Set((text.match(/\.[a-z0-9]{1,5}\b/gi) || []).map((s) => s.toLowerCase()))].slice(0, 12);
  const hasCode =
    codeFences > 0 || /\b(function|const|let|def|class|import|=>|SELECT|async)\b/.test(text) || /[{};]\s*$/m.test(text);
  return {
    chars: text.length,
    estTokens: estTokens(text),
    codeFences,
    hasCode,
    fileTypes,
    questionCount: (text.match(/\?/g) || []).length,
    taskHints: text.slice(0, 4000), // policies may regex over the actual prompt head
    harness,
  };
}

// ── PER-USER SUBSCRIPTION PROFILE (2026-07-12) ─────────────────────────────────────────────────
// The catalog states facts about MODELS; the profile states facts about THIS USER (which harnesses
// they have, which are subscription-covered — detected/asked/verified by model-router-setup.mjs).
// The overlay strips any subscription or harness claim the profile doesn't back, so the $0 floor
// can never assume a plan the user doesn't have (silently billing them) or miss one they do
// (silently wasting it). No profile file = catalog taken as-is (pre-profile installs keep working).
export const PROFILE_PATH =
  process.env.MODEL_ROUTER_PROFILE || path.join(CONFIG_DIR, 'profile.json');

export function loadProfile() {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')); } catch { return null; }
}

export function applyProfile(candidates, profile) {
  const h = profile?.harnesses;
  if (!h) return candidates;
  return candidates.map((c) => ({
    ...c,
    // A harness the user doesn't have can never launch anything — remove it from the pool filter.
    harness: (c.harness || []).filter((x) => h[x] === undefined || h[x].available !== false),
    // A subscription claim only survives if THIS user's profile confirms that harness is covered.
    subscription: (c.subscription || []).filter((x) => h[x]?.subscription === true),
  }));
}

// Honest provenance of the catalog the engine is actually using, so no surface can pass the
// built-in stub off as a real personal catalog (trust rule: never present a fallback as the thing).
// Returns 'catalog' when a real ~/.claude/model-router/catalog.json is present + valid, else
// 'built-in-fallback'. Same check loadCatalog() uses — kept in lockstep.
export function catalogSource() {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    if (Array.isArray(j.candidates) && j.candidates.length) return 'catalog';
  } catch { /* fall through */ }
  return 'built-in-fallback';
}

export function loadCatalog() {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    if (Array.isArray(j.candidates) && j.candidates.length) return j.candidates;
  } catch {
    /* fall through to a minimal built-in so the engine still answers */
  }
  // Built-in fallback. Claude launchability was verified against Claude Code 2.1.220 on 2026-08-02;
  // prices remain null where the subscription host, rather than a metered API, is authoritative.
  return [
    { id: 'deepseek/deepseek-chat', provider: 'openrouter', harness: ['claude-code', 'codex'], tier: 'cheap', costPerMTok: { in: 0.2, out: 0.8 }, verified: '2026-07-07' },
    { id: 'claude-opus-4-8', provider: 'anthropic', harness: ['claude-code'], tier: 'frontier', costPerMTok: { in: 5.0, out: 25.0 }, verified: '2026-07-07' },
    { id: 'claude-opus-5', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier', costPerMTok: null, verified: '2026-08-02 Claude Code 2.1.220 launch' },
    { id: 'claude-fable-5', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier', costPerMTok: null, verified: '2026-08-02 Claude Code 2.1.220 launch' },
    { id: 'gpt-5.5', provider: 'openai', harness: ['codex'], tier: 'frontier', costPerMTok: null, verified: null },
  ];
}

export async function loadPolicy(explicit) {
  const candidatePaths = [explicit, POLICY_USER, POLICY_DEFAULT].filter(Boolean);
  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      if (typeof mod.choose === 'function') return { choose: mod.choose, source: p };
    } catch (e) {
      process.stderr.write(`[model-router] policy at ${p} failed to load: ${e.message}\n`);
    }
  }
  return null;
}

function parseArgs(argv) {
  const a = { harness: null, prompt: null, policy: null, mode: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--harness') a.harness = argv[++i];
    else if (k === '--policy') a.policy = argv[++i];
    else if (k === '--line') a.mode = 'line';
    else if (k === '--json') a.mode = 'json';
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Selection-time cost is INPUT-only and clearly labeled: at selection we don't know output length,
// so we never fabricate one. Returns null when the chosen model has no verified price.
function estInputCost(candidate, inTokens) {
  const p = candidate && candidate.costPerMTok;
  if (!p || typeof p.in !== 'number') return null;
  return +((inTokens * p.in) / 1e6).toFixed(6);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 33).join('\n') + '\n');
    return;
  }
  // Harness: explicit flag wins; else detect Codex by its env/dir; else default claude-code.
  const harness =
    args.harness ||
    (process.env.CODEX_SANDBOX || fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml')) && process.env.CODEX ? 'codex' : null) ||
    'claude-code';
  const prompt = args.prompt || readStdin();
  if (!prompt || !prompt.trim()) {
    process.stderr.write('model-router-engine: no prompt (use --prompt "..." or pipe text on stdin)\n');
    process.exit(2);
  }

  const profile = loadProfile();
  const candidates = applyProfile(loadCatalog(), profile);
  const policy = await loadPolicy(args.policy);
  const features = extractFeatures(prompt, harness);

  // ── rUv's REAL router gets FIRST REFUSAL. ────────────────────────────────────────────────────────
  // 2026-07-13: this is the fix for a lie I shipped. v2.5's headline was "it uses @metaharness/router",
  // I wrote the wrapper, tested it, gated CI against faking — and NEVER WIRED IT INTO THIS FILE. The
  // engine users actually run stayed 100% hand-rolled while the README said otherwise. An honest
  // artifact sitting next to a lying claim is still a lie. The decision now comes from rUv's code
  // whenever it CAN decide, and the local heuristic is a fallback that must ANNOUNCE ITSELF.
  let decision;
  let routedBy;
  const pool = candidates.filter((m) => (m.harness || []).includes(harness));
  try {
    const mh = await import('./metaharness-router.mjs');
    const r = await mh.route(prompt, pool.length ? pool : candidates, profile);
    if (r.routedBy === '@metaharness/router') {
      const pick = candidates.find((m) => m.id === r.model);
      decision = {
        model: r.model,
        provider: pick?.provider ?? null,
        tier: pick?.tier ?? null,
        reason: `@metaharness/router (rUv's learned cost-optimal router): predicted quality ${r.predictedQuality?.toFixed(2)}, ${r.metBar ? 'clears' : 'BELOW'} the bar, ${r.subscriptionCovered ? '$0 (your subscription)' : `$${r.costPerMTok}/Mtok`}, from ${r.labels} labelled example(s)`,
        confidence: r.predictedQuality ?? 0,
      };
      routedBy = '@metaharness/router';
    } else {
      // COLD-START or the package is absent. Say which, out loud — never pass the fallback off as the
      // learned router. That substitution is the entire sin this wiring exists to end.
      routedBy = `local-heuristic (${r.routedBy}: ${r.reason})`;
    }
  } catch (e) {
    routedBy = `local-heuristic (@metaharness/router unavailable: ${e.message})`;
  }

  if (!decision) {
    if (!policy) {
      const pick = pool.slice().sort((x, y) => (x.costPerMTok?.out ?? Infinity) - (y.costPerMTok?.out ?? Infinity))[0] || candidates[0];
      decision = { model: pick?.id ?? null, provider: pick?.provider ?? null, tier: pick?.tier ?? null, reason: 'NO POLICY FOUND — fell back to cheapest priced candidate for the harness', confidence: 0 };
    } else {
      decision = policy.choose({ features, candidates, harness });
    }
  }

  const chosen = candidates.find((m) => m.id === decision.model) || null;
  const out = {
    ts: new Date().toISOString(),
    harness,
    model: decision.model,
    provider: decision.provider,
    tier: decision.tier,
    reason: decision.reason,
    confidence: decision.confidence,
    // WHO decided. Never let a caller assume the learned router made a call the heuristic made.
    routedBy,
    policy_source: policy ? policy.source.replace(os.homedir(), '~') : 'none',
    profile: profile ? PROFILE_PATH.replace(os.homedir(), '~') : 'none (catalog taken as-is — run model-router-setup.mjs)',
    price_verified: chosen ? chosen.verified : null,
    est_input_cost_usd: estInputCost(chosen, features.estTokens), // null if price unknown — never invented
    features: { estTokens: features.estTokens, hasCode: features.hasCode, codeFences: features.codeFences, fileTypes: features.fileTypes, questionCount: features.questionCount },
  };

  // Durable decision log (append-only; separate from route-cheap's execution/savings ledger).
  try {
    fs.mkdirSync(path.dirname(DECISIONS_LOG), { recursive: true });
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify({ ...out, features: undefined, prompt_head: prompt.slice(0, 120) }) + '\n');
  } catch { /* logging must never break selection */ }

  if (args.mode === 'line') {
    const cost = out.est_input_cost_usd == null ? 'cost:unpriced' : `est-in:$${out.est_input_cost_usd}`;
    process.stdout.write(`\x1b[2m🧭 model-router → ${out.model} (${out.harness}, ${out.tier}, ${cost}) — ${out.reason}\x1b[0m\n`);
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`model-router-engine: ${e.stack || e.message}\n`); process.exit(1); });
}
