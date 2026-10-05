#!/usr/bin/env node
// Deterministic prompt classification + reviewed per-user native model/effort allocation.
// This selects only; model-router-dispatch.mjs enforces a managed worker launch. Parent chat
// model selection is controlled by the host, not a UserPromptSubmit recommendation hook.
// ~/.claude/model-router: catalog.json, profile.json, routing-policy.json, optional policy.mjs.
// Learned routes are constrained to the reviewed policy pick, never given first refusal.
// Usage: node model-router-engine.mjs --harness codex --policy-only --json < prompt.txt
// Decision receipts retain model/effort/class metadata only; no raw prompt or policy reason.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { estTokens } from './route-cheap.mjs'; // reuse the verified char/4 estimator (DRY)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = process.env.MODEL_ROUTER_CONFIG_DIR || path.join(os.homedir(), '.claude', 'model-router');
// Overridable for hermetic tests + CI (runners have no ~/.claude): the 2026-07-12 CI redness was
// exactly this — tests that silently depended on one developer's machine state.
const CATALOG_PATH = process.env.MODEL_ROUTER_CATALOG || path.join(CONFIG_DIR, 'catalog.json');
const POLICY_USER = path.join(CONFIG_DIR, 'policy.mjs');
const POLICY_DEFAULT = path.join(CONFIG_DIR, 'policy.default.mjs');
const POLICY_SHIPPED = path.join(__dirname, '..', 'config', 'model-router', 'policy.default.mjs');
export const TASK_CLASSES = ['fast', 'medium', 'substantial', 'hard', 'exceptional'];
const DECISIONS_LOG =
  process.env.MODEL_ROUTER_DECISIONS ||
  path.join(os.homedir(), '.claude', 'metaharness', 'routing-decisions.jsonl');

// ─── feature extraction: this is "based on what the prompt is" ────────────────────────────────
// Pure and deterministic. Emits SIGNALS only — it never decides. Policies consume these; extend
// this object as your research identifies new predictive features (it is the documented surface).
export function extractFeatures(prompt, harness, taskFacts) {
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
    taskHints: text, // policies may regex over the actual prompt head
    harness,
    taskFacts,
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

// Catalog absence is not permission to use stale built-in identities.
export function catalogSource(file = CATALOG_PATH) {
  try { loadCatalog(file); return 'catalog'; }
  catch { return 'unavailable'; }
}

export function loadCatalog(file = CATALOG_PATH) {
  try {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(catalog.candidates) && catalog.candidates.length) return catalog.candidates;
  } catch { /* report one bounded configuration error, never substitute old models */ }
  throw new Error('Current per-user model catalog missing or invalid; no built-in model fallback');
}

export async function loadPolicy(explicit) {
  if (explicit && !fs.existsSync(explicit)) throw new Error(`Explicit routing policy missing: ${explicit}`);
  const candidatePaths = [explicit, POLICY_USER, POLICY_DEFAULT, POLICY_SHIPPED].filter(Boolean);
  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      if (typeof mod.choose === 'function') return { choose: mod.choose, source: p };
      throw new Error('Policy must export choose()');
    } catch (e) {
      if (p === explicit || p === POLICY_USER) throw new Error(`User routing policy failed to load: ${e.message}`);
      process.stderr.write(`[model-router] policy at ${p} failed to load: ${e.message}\n`);
    }
  }
  return null;
}

function parseArgs(argv) {
  const a = { harness: null, prompt: null, policy: null, mode: 'json', policyOnly: false, requestJson: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--harness') a.harness = argv[++i];
    else if (k === '--policy') a.policy = argv[++i];
    else if (k === '--request-json') a.requestJson = true;
    else if (k === '--policy-only') a.policyOnly = true;
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

export function loadSelection(file = process.env.MODEL_ROUTER_SELECTION || path.join(CONFIG_DIR, 'routing-policy.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('No reviewed per-user routing-policy.json available'); }
}

export function assertCurrentSelection(selection, now = Date.now()) {
  const age = now - Date.parse(selection?.reviewedAt);
  const configuredMaxAge = selection?.maxAgeMs === undefined ? 604800000 : selection.maxAgeMs;
  if (!Number.isSafeInteger(configuredMaxAge) || configuredMaxAge <= 0) {
    throw new Error('Routing allocation maxAgeMs must be a finite positive integer');
  }
  const reviewedAt = selection?.reviewedAt;
  const isoDate = typeof reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(reviewedAt);
  const calendarDate = isoDate && Date.parse(reviewedAt.slice(0, 10));
  const validCalendar = Number.isFinite(calendarDate) && new Date(calendarDate).toISOString().slice(0, 10) === reviewedAt.slice(0, 10);
  if (selection?.schemaVersion !== 1 || !isoDate || !validCalendar || !Number.isFinite(age) || age < 0) {
    throw new Error('Routing allocation missing, invalid or future-dated; owner-reviewed policy required');
  }
  // Evidence age is not revocation of an approved allocation. Retain the original reviewedAt;
  // every managed launch still rechecks allocation integrity, native support, auth and allowance.
  return selection;
}

function normalizedRoutes(value) {
  if (Array.isArray(value)) return value.map(normalizedRoutes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, normalizedRoutes(value[key])]));
  return value;
}

export function selectionEvidenceStatus(selection, now = Date.now()) {
  assertCurrentSelection(selection, now);
  const maxAgeMs = Math.min(selection.maxAgeMs ?? 604800000, 604800000);
  const ageMs = now - Date.parse(selection.reviewedAt);
  const routeDigest = selection.routes && typeof selection.routes === 'object' && !Array.isArray(selection.routes)
    ? crypto.createHash('sha256').update(JSON.stringify(normalizedRoutes(selection.routes))).digest('hex') : null;
  return { reviewedAt: selection.reviewedAt, maxAgeMs, ageMs, stale: ageMs > maxAgeMs, routeDigest };
}

// Eligibility is independent of policy and learning: catalog pricing is never spend permission.
export function eligibleCandidates(candidates, profile, harness) {
  const host = profile?.harnesses?.[harness];
  if (host?.available !== true || host?.subscription !== true) return [];
  const provider = { codex: 'openai', 'claude-code': 'anthropic' }[harness];
  return candidates.filter((m) => m.provider === provider &&
    (m.harness || []).includes(harness) && (m.subscription || []).includes(harness));
}

export async function selectDecision({ prompt, harness, candidates, profile, policy,
  features = extractFeatures(prompt, harness), learnedRoute, selection = loadSelection(), now = Date.now() } = {}) {
  const evidence = selectionEvidenceStatus(selection, now);
  const pool = eligibleCandidates(candidates, profile, harness);
  if (!pool.length) throw new Error(`No available native subscription candidates for ${harness}; no metered fallback`);
  if (!policy?.choose) throw new Error('No routing policy available');
  const classifierFile = fs.existsSync(POLICY_SHIPPED) ? POLICY_SHIPPED : POLICY_DEFAULT;
  const classifier = await import(pathToFileURL(classifierFile).href);
  if (typeof classifier.classify !== 'function' || typeof classifier.validateTaskFacts !== 'function') {
    throw new Error('Managed routing classifier missing required exports; update installed policy.default.mjs before dispatch');
  }
  classifier.validateTaskFacts(features.taskFacts);
  const assessedClass = classifier.classify(features, harness);
  const decision = await policy.choose({ features, candidates: pool, harness, profile, selection });
  if (harness === 'codex' && ['substantial', 'exceptional', 'hard'].includes(assessedClass) && decision?.taskClass !== assessedClass) {
    throw new Error(`Task requires explicit qualified ${assessedClass} route; legacy policy cannot silently use medium`);
  }
  const chosen = pool.find((m) => m.id === decision?.model);
  if (!chosen) throw new Error(`Policy model unavailable or unauthorized: ${decision?.model || 'none'}`);
  const taskClass = decision.taskClass;
  if (!TASK_CLASSES.includes(taskClass)) {
    throw new Error('Routing policy must return an explicit qualified taskClass; update legacy policy');
  }
  const effort = decision.effort || selection.routes?.[harness]?.[taskClass]?.effort;
  if (!TASK_CLASSES.includes(taskClass) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error('Policy must specify a supported task class and effort');
  }
  const approved = selection.routes?.[harness]?.[taskClass];
  const codingEffort = selection.routes?.[harness]?.codingEffort;
  const coding = features.hasCode || /\b(implement|code|coding|debug|refactor|test|endpoint|API|repository|module|function)\b/i.test(features.taskHints || '');
  const approvedEffort = harness === 'claude-code' && taskClass === 'medium' && coding
    ? codingEffort || approved?.effort : approved?.effort;
  if (harness === 'codex' && ['xhigh', 'max'].includes(effort) &&
      (taskClass !== 'exceptional' || effort !== 'xhigh' || !approved?.requiresNamedReason ||
       !/^[a-z][a-z0-9-]{2,79}$/.test(decision.exceptionalReason || ''))) {
    throw new Error('Exceptional xhigh requires an explicit qualified route and named reason; no automatic max effort');
  }
  if (approved?.model !== chosen.id || approvedEffort !== effort) {
    throw new Error('Custom policy decision exceeds reviewed model/effort allocation; update per-user routing-policy.json');
  }
  if (chosen.supportedEfforts && !chosen.supportedEfforts.includes(effort)) {
    throw new Error(`Policy effort unavailable for ${chosen.id}: ${effort}`);
  }
  let routedBy = 'user-policy';
  try {
    const route = learnedRoute || (await import('./metaharness-router.mjs')).route;
    // Explicit allocation is authoritative. A learned model outside it never gets first refusal.
    const learned = await route(prompt, [chosen], profile);
    routedBy = learned.routedBy === '@metaharness/router' && learned.model === chosen.id
      ? '@metaharness/router (policy constrained)'
      : `user-policy (${learned.routedBy || 'learned decision rejected'})`;
  } catch (e) { routedBy = `user-policy (learned router unavailable: ${e.message})`; }
  return { ...decision, provider: chosen.provider, tier: chosen.tier, taskClass, effort,
    subscriptionCovered: true, selectionReviewedAt: selection.reviewedAt, selectionMaxAgeMs: evidence.maxAgeMs,
    selectionRouteDigest: evidence.routeDigest, selectionEvidence: evidence, routedBy };
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
  const raw = args.prompt || readStdin();
  const request = args.requestJson ? JSON.parse(raw) : { prompt: raw };
  const prompt = request.prompt;
  if (typeof prompt !== 'string') throw new Error('Request prompt must be a string');
  if (!prompt || !prompt.trim()) {
    process.stderr.write('model-router-engine: no prompt (use --prompt "..." or pipe text on stdin)\n');
    process.exit(2);
  }

  const profile = loadProfile();
  const candidates = applyProfile(loadCatalog(), profile);
  const policy = await loadPolicy(args.policy);
  const features = extractFeatures(prompt, harness, request.taskFacts);

  const decision = await selectDecision({ prompt, harness, candidates, profile, policy, features,
    learnedRoute: args.policyOnly ? async () => ({ routedBy: 'SKIPPED (policy-only)' }) : undefined });
  const routedBy = decision.routedBy;

  const chosen = candidates.find((m) => m.id === decision.model) || null;
  const out = {
    ts: new Date().toISOString(),
    harness,
    model: decision.model,
    provider: decision.provider,
    tier: decision.tier,
    taskClass: decision.taskClass,
    exceptionalReason: decision.exceptionalReason,
    classificationSource: decision.classificationSource,
    effort: decision.effort,
    subscriptionCovered: decision.subscriptionCovered,
    selectionReviewedAt: decision.selectionReviewedAt,
    selectionMaxAgeMs: decision.selectionMaxAgeMs,
    selectionRouteDigest: decision.selectionRouteDigest,
    selectionEvidence: decision.selectionEvidence,
    reason: decision.reason,
    confidence: decision.confidence,
    // WHO decided. Never let a caller assume the learned router made a call the heuristic made.
    routedBy,
    policy_source: policy ? policy.source.replace(os.homedir(), '~') : 'none',
    profile: profile ? PROFILE_PATH.replace(os.homedir(), '~') : 'none (catalog taken as-is — run model-router-setup.mjs)',
    price_verified: chosen ? chosen.verified : null,
    est_input_cost_usd: decision.subscriptionCovered ? 0 : estInputCost(chosen, features.estTokens),
    api_list_input_cost_usd: estInputCost(chosen, features.estTokens), // API sticker estimate, not subscription billing
    features: { estTokens: features.estTokens, hasCode: features.hasCode, codeFences: features.codeFences, fileTypes: features.fileTypes, questionCount: features.questionCount },
  };

  // Durable decision log (append-only; separate from route-cheap's execution/savings ledger).
  try {
    fs.mkdirSync(path.dirname(DECISIONS_LOG), { recursive: true });
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify({ ts: out.ts, harness, model: out.model, effort: out.effort, taskClass: out.taskClass, exceptionalReason: out.exceptionalReason, subscriptionCovered: out.subscriptionCovered, policy_source: out.policy_source }) + '\n');
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
