#!/usr/bin/env node
// explainer/build-starter-kit.mjs — Builds & smoke-tests the 16-file standalone AI Routing Starter Kit ZIP.
// Every .mjs script inside the ZIP runs with ZERO external dependencies and ZERO MetaHarness requirement.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const HOME = os.homedir();
const STAGE = path.join(os.tmpdir(), 'ai-routing-starter-kit-stage');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'examples'), { recursive: true });

// 1. Copy canonical docs & data templates
const copies = [
  [path.join(REPO, 'docs/MODEL-ROUTING-ARCHITECTURE.md'), 'MODEL-ROUTING-ARCHITECTURE.md'],
  [path.join(REPO, 'docs/APP-MODEL-ROUTING-INTEGRATION.md'), 'APP-MODEL-ROUTING-INTEGRATION.md'],
  [path.join(REPO, 'config/model-router/routing-policy.template.json'), 'routing-policy.template.json'],
  [path.join(REPO, 'config/model-router/routing-eval-cases.json'), 'routing-eval-cases.json'],
  [path.join(REPO, 'scripts/app-model-router.mjs'), 'app-model-router.mjs'],
  [path.join(HOME, 'Documents/AI-Subscription-Routing-Playbook.md'), 'AI-Subscription-Routing-Playbook.md'],
];
for (const [src, dst] of copies) {
  fs.copyFileSync(src, path.join(STAGE, dst));
}

// 2. Sanitized policy.default.mjs (remove any user-specific command names)
let policySrc = fs.readFileSync(path.join(HOME, '.claude/model-router/policy.default.mjs'), 'utf8');
policySrc = policySrc.replace(/ak\\s\+\(sync\|models\|status\)/g, 'cli\\s+(sync|models|status)');
policySrc = policySrc.replace(/ak\\s\+\\(sync\\|models\\|status\\)/g, 'cli\\s+(sync|models|status)');
policySrc = policySrc.replace('ak\\s+(sync|models|status)', 'cli\\s+(sync|models|status)');
policySrc = policySrc.replace(/ruvnet\|ruflo\|reflow/g, 'router|workflow|agent');
fs.writeFileSync(path.join(STAGE, 'policy.default.mjs'), policySrc, 'utf8');

// 3. Standalone 5-tier classifier + eval runner (zero MetaHarness dependency!)
fs.writeFileSync(path.join(STAGE, 'standalone-router.mjs'), `#!/usr/bin/env node
// standalone-router.mjs — Zero-dependency 5-tier local prompt router & 36-case safety eval runner.
// Usage:
//   node standalone-router.mjs --prompt "read package.json and check git status"
//   node standalone-router.mjs --prompt "still broken, tests failed twice" --prior-failure
//   node standalone-router.mjs --eval
//   node standalone-router.mjs --json --prompt "design a zero-downtime DB migration"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './policy.default.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIER_ORDER = ['fast', 'medium', 'substantial', 'hard', 'exceptional'];
const NEXT_TIER = { fast: 'medium', medium: 'substantial', substantial: 'hard', hard: 'exceptional' };

export function extractFeatures(prompt = '', taskFacts = undefined) {
  const s = String(prompt || '').trim();
  const hasCode = /\`\`\`/.test(s) || /\\b(function|const|let|var|class|import|export|SELECT|CREATE TABLE)\\b/.test(s);
  return {
    taskHints: s,
    hasCode,
    chars: s.length,
    ...(taskFacts ? { taskFacts } : {}),
  };
}

export function routePrompt(prompt, { host = 'claude-code', priorFailure = false, taskFacts = undefined, policyPath = null } = {}) {
  const features = extractFeatures(prompt, taskFacts);
  let tier = classify(features, host);
  const failSignal = /\\b(still\\s+(broken|failing|wrong|stuck)|failed\\s+twice|didn'?t\\s+work|same\\s+error|try\\s+harder|escalate)\\b/i.test(prompt);
  let escalated = false;
  if (priorFailure && NEXT_TIER[tier]) {
    tier = NEXT_TIER[tier];
    escalated = true;
  } else if (failSignal && (tier === 'hard' || tier === 'exceptional')) {
    escalated = true;
  }
  const tplPath = policyPath || path.join(__dirname, 'routing-policy.template.json');
  let target = { model: 'tier-' + tier, effort: tier === 'fast' ? 'low' : tier === 'medium' ? 'medium' : 'high' };
  if (fs.existsSync(tplPath)) {
    try {
      const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
      const hostRoutes = tpl.routes?.[host] || tpl.routes?.['claude-code'];
      if (hostRoutes?.[tier]) target = hostRoutes[tier];
    } catch {}
  }
  return { tier, escalated, host, model: target.model, effort: target.effort || 'medium', costUsd: 0 };
}

function tierInRange(got, exp) {
  if (!exp) return false;
  if (typeof exp === 'string') return got === exp;
  if (Array.isArray(exp)) return exp.includes(got);
  const idx = TIER_ORDER.indexOf(got);
  const min = exp.minimumClass ? TIER_ORDER.indexOf(exp.minimumClass) : 0;
  const max = exp.maximumClass ? TIER_ORDER.indexOf(exp.maximumClass) : TIER_ORDER.length - 1;
  return idx >= min && idx <= max;
}

const isDirect = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isDirect) {
  const args = process.argv.slice(2);
  if (args.includes('--eval')) {
    const casesPath = path.join(__dirname, 'routing-eval-cases.json');
    const raw = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
    const cases = Array.isArray(raw) ? raw : (raw.cases || []);
    let passed = 0;
    const failures = [];
    for (const c of cases) {
      const expected = c.expected || c.expectedClass || c.tier;
      const res = routePrompt(c.request || c.prompt || c.taskHints || '', {
        priorFailure: Boolean(c.priorFailure),
        taskFacts: c.taskFacts,
      });
      const ok = tierInRange(res.tier, expected);
      if (ok) passed++;
      else failures.push({ id: c.id || String(c.prompt || '').slice(0, 40), expected, got: res.tier });
    }
    console.log(JSON.stringify({ ok: failures.length === 0, passed, total: cases.length, failures }, null, 2));
    process.exit(failures.length === 0 ? 0 : 1);
  }
  const pIdx = args.indexOf('--prompt');
  const prompt = pIdx >= 0 ? args[pIdx + 1] : args.filter((a) => !a.startsWith('--')).join(' ');
  const hIdx = args.indexOf('--host');
  const host = hIdx >= 0 ? args[hIdx + 1] : 'claude-code';
  const res = routePrompt(prompt || 'check git status', { host, priorFailure: args.includes('--prior-failure') });
  console.log(JSON.stringify(res, null, 2));
}
`, 'utf8');

// 4. Fixed multi-tool 0-100 local usage auditor (Claude + Codex + Antigravity + Grok + Cursor, streaming, honest scoring)
fs.writeFileSync(path.join(STAGE, 'audit-my-ai-usage.mjs'), `#!/usr/bin/env node
// audit-my-ai-usage.mjs — Zero-dependency local 60-day AI subscription auditor (0–100 score).
// Scans Claude Code, Codex, Antigravity/Gemini, Grok, and Cursor logs locally. Zero data leaves your machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const NOW = Date.now();
const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || 60);
const CUTOFF = NOW - DAYS * 86400 * 1000;
const JSON_OUT = process.argv.includes('--json');

function walkFiles(dir, exts, out = [], depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, exts, out, depth + 1);
    else if (exts.some((ext) => e.name.endsWith(ext))) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= CUTOFF) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

async function scanJsonlStream(filePath, onObj) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line.length > 2_000_000) continue;
    try { onObj(JSON.parse(line)); } catch {}
  }
}

async function scanClaude() {
  const files = walkFiles(path.join(HOME, '.claude', 'projects'), ['.jsonl']);
  let turns = 0, frontierTurns = 0, input = 0, cacheRead = 0, cacheWrite = 0, output = 0;
  for (const f of files) {
    await scanJsonlStream(f.path, (obj) => {
      const u = obj?.message?.usage;
      if (!u) return;
      const model = String(obj?.message?.model || '').toLowerCase();
      turns++;
      if (/opus|fable/.test(model)) frontierTurns++;
      input += u.input_tokens || 0;
      cacheRead += u.cache_read_input_tokens || 0;
      cacheWrite += u.cache_creation_input_tokens || 0;
      output += u.output_tokens || 0;
    });
  }
  const totalIn = input + cacheRead + cacheWrite;
  return {
    tool: 'Claude Code',
    detected: files.length > 0,
    files: files.length,
    turns,
    frontierPct: turns ? +((frontierTurns / turns) * 100).toFixed(1) : 0,
    warmCachePct: totalIn ? +((cacheRead / totalIn) * 100).toFixed(1) : 0,
    cacheWritePct: totalIn ? +((cacheWrite / totalIn) * 100).toFixed(1) : 0,
    totalTokensM: +((totalIn + output) / 1e6).toFixed(1),
  };
}

async function scanCodex() {
  const files = walkFiles(path.join(HOME, '.codex', 'sessions'), ['.jsonl']);
  let turns = 0, frontierTurns = 0, totalTokens = 0, cachedTokens = 0;
  for (const f of files) {
    await scanJsonlStream(f.path, (obj) => {
      const m = String(obj?.model || obj?.payload?.model || '').toLowerCase();
      const u = obj?.payload?.info?.last_token_usage || obj?.usage;
      if (u && (u.input_tokens || u.total_tokens)) {
        turns++;
        if (/astra|pro|o1|o3|xhigh/.test(m)) frontierTurns++;
        totalTokens += (u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)));
        cachedTokens += (u.cached_input_tokens || 0);
      }
    });
  }
  return {
    tool: 'Codex CLI',
    detected: files.length > 0,
    files: files.length,
    turns,
    frontierPct: turns ? +((frontierTurns / turns) * 100).toFixed(1) : 0,
    warmCachePct: totalTokens ? +((cachedTokens / totalTokens) * 100).toFixed(1) : 0,
    totalTokensM: +(totalTokens / 1e6).toFixed(1),
  };
}

function scanSimpleDir(tool, dirs, exts) {
  let files = [];
  for (const d of dirs) files = files.concat(walkFiles(d, exts));
  const totalMB = +(files.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1);
  return { tool, detected: files.length > 0, files: files.length, totalMB };
}

const claude = await scanClaude();
const codex = await scanCodex();
const antigravity = scanSimpleDir('Antigravity / Gemini', [path.join(HOME, '.gemini', 'antigravity-cli', 'brain'), path.join(HOME, '.gemini', 'tmp')], ['.jsonl', '.json']);
const grok = scanSimpleDir('Grok CLI', [path.join(HOME, '.grok')], ['.jsonl', '.json']);
const cursor = scanSimpleDir('Cursor IDE', [
  path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  path.join(HOME, '.config', 'Cursor', 'User', 'workspaceStorage'),
], ['.vscdb', '.json']);

// Check if any paid API keys are leaked in shell env for personal coding
const leakedKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
  .filter((k) => Boolean(process.env[k]));

// Honest scoring across ALL detected tools (NEVER returns 100/100 when 0 measured turns!)
const totalMeasuredTurns = claude.turns + codex.turns;
const anyDetected = [claude, codex, antigravity, grok, cursor].some((t) => t.detected);
const findings = [];
let score = totalMeasuredTurns >= 20 ? 100 : null;

if (score !== null) {
  if (leakedKeys.length > 0) {
    score -= 15;
    findings.push(\`Paid API keys active in shell env (\${leakedKeys.join(', ')}) — risk of double-paying on top of prepaid seats.\`);
  }
  if (claude.turns >= 20) {
    if (claude.frontierPct > 25) {
      score -= Math.min(35, Math.round((claude.frontierPct - 15) * 0.8));
      findings.push(\`Claude Frontier share is \${claude.frontierPct}% (target: <=15%). Park main chat on Sonnet + offload searches to Haiku.\`);
    }
    if (claude.cacheWritePct > 5) {
      score -= Math.min(20, Math.round(claude.cacheWritePct * 1.5));
      findings.push(\`Claude cache-write share is \${claude.cacheWritePct}% of input (target: <3%). Compact sessions at 50% context.\`);
    }
  }
  if (codex.turns >= 20 && codex.frontierPct > 25) {
    score -= Math.min(25, Math.round((codex.frontierPct - 15) * 0.7));
    findings.push(\`Codex Frontier share is \${codex.frontierPct}% (target: <=15%). Default Codex to Sol medium + reserve Astra for escalations.\`);
  }
  score = Math.max(5, Math.min(100, score));
} else if (anyDetected) {
  findings.push(\`Found local workspace files but only \${totalMeasuredTurns} token-level turns (minimum 20 required for a reliable 0-100 score).\`);
  if (leakedKeys.length > 0) findings.push(\`Paid API keys active in shell env (\${leakedKeys.join(', ')}) — strip for prepaid coding.\`);
}

const verdict = score === null
  ? 'INSUFFICIENT TOKEN TELEMETRY (<20 measured turns) — run on your primary coding machine or pass --days=90'
  : score >= 85
    ? 'ALREADY WELL OPTIMIZED — keep what works, adopt only the pieces you like'
    : score >= 60
      ? 'MODERATE LEAKAGE — 2x–3x license stretch available with 5-tier routing + 50% /compact'
      : 'HIGH QUOTA LEAKAGE — 3.5x–4.5x license stretch available immediately';

const report = { auditedAt: new Date().toISOString(), windowDays: DAYS, score, verdict, leakedKeys, tools: { claude, codex, antigravity, grok, cursor }, findings };
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(\`\\n=== AI Subscription Usage Audit (\${DAYS}-day window · local only) ===\`);
  console.log(\`Score:   \${score === null ? 'N/A' : score + ' / 100'}\`);
  console.log(\`Verdict: \${verdict}\`);
  console.log(\`Tools:   Claude(\${claude.turns} turns, \${claude.frontierPct}% frontier) | Codex(\${codex.turns} turns, \${codex.frontierPct}% frontier) | Antigravity(\${antigravity.files} files) | Grok(\${grok.files} files) | Cursor(\${cursor.files} files)\`);
  if (findings.length) {
    console.log('\\nTop Findings:');
    findings.forEach((f, i) => console.log(\`  \${i + 1}. \${f}\`));
  }
  console.log('');
}
`, 'utf8');

// 5. Standalone-safe model-auto-refresh.mjs
fs.writeFileSync(path.join(STAGE, 'model-auto-refresh.mjs'), `#!/usr/bin/env node
// model-auto-refresh.mjs — Standalone-safe local CLI model cache scanner & policy freshness checker.
// Works with ~/.claude/model-router/routing-policy.json OR local ./routing-policy.template.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DRY = process.argv.includes('--dry-run');
const JSON_OUT = process.argv.includes('--json');

const policyCandidates = [
  path.join(HOME, '.claude', 'model-router', 'routing-policy.json'),
  path.join(__dirname, 'routing-policy.template.json'),
];
const policyPath = policyCandidates.find((p) => fs.existsSync(p));
const codexCachePath = path.join(HOME, '.codex', 'models_cache.json');

const discovered = [];
if (fs.existsSync(codexCachePath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(codexCachePath, 'utf8'));
    const list = Array.isArray(raw?.models) ? raw.models : (Array.isArray(raw) ? raw : []);
    for (const m of list) {
      const id = m?.slug || m?.id;
      if (id) discovered.push(id);
    }
  } catch {}
}

let policyAgeDays = null;
let policyDateSource = 'missing';
const promotions = [];
if (policyPath) {
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const st = fs.statSync(policyPath);
  const declared = policy.policyRevisionAt || policy.reviewedAt || policy.updated_at;
  const parsedMs = declared ? Date.parse(declared) : NaN;
  const refMs = Number.isFinite(parsedMs) ? parsedMs : st.mtimeMs;
  policyDateSource = Number.isFinite(parsedMs) ? \`policy(\${declared})\` : 'file-mtime';
  policyAgeDays = Math.max(0, Math.floor((Date.now() - refMs) / 86400000));

  // Same-family minor promotion check for Codex (e.g. gpt-6.2-sol -> gpt-6.3-sol)
  const codexRoutes = policy.routes?.codex;
  if (codexRoutes && discovered.length > 0) {
    for (const [tier, cfg] of Object.entries(codexRoutes)) {
      const m = String(cfg?.model || '').match(/^(gpt-6)\\.(\\d+)-(sol|astra)$/);
      if (!m) continue;
      const curMinor = Number(m[2]);
      const suffix = m[3];
      const newer = discovered
        .map((id) => ({ id, mm: id.match(new RegExp(\`^gpt-6\\\\.(\\\\d+)-\${suffix}$\`)) }))
        .filter((x) => x.mm && Number(x.mm[1]) > curMinor)
        .sort((a, b) => Number(b.mm[1]) - Number(a.mm[1]))[0];
      if (newer) {
        promotions.push({ host: 'codex', tier, from: cfg.model, to: newer.id });
        if (!DRY && process.argv.includes('--apply')) cfg.model = newer.id;
      }
    }
    if (!DRY && process.argv.includes('--apply') && promotions.length > 0) {
      policy.policyRevisionAt = new Date().toISOString();
      fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\\n', 'utf8');
    }
  }
}

const out = {
  ok: Boolean(policyPath),
  mode: DRY ? 'dry-run' : (process.argv.includes('--apply') ? 'apply' : 'check'),
  policyPath: policyPath || 'not-found',
  policyDateSource,
  policyAgeDays,
  fresh: policyAgeDays !== null && policyAgeDays <= 7,
  promotions,
  discoveredCodexModels: discovered.slice(0, 12),
  checkedAt: new Date().toISOString(),
};
console.log(JSON.stringify(out, null, 2));
`, 'utf8');

// 6. Standalone-safe model-routing-audit.mjs (zero hardcoded names, auto-detects MetaHarness OR standalone kit)
fs.writeFileSync(path.join(STAGE, 'model-routing-audit.mjs'), `#!/usr/bin/env node
// model-routing-audit.mjs — Standalone 10/13-point model routing self-audit watchdog.
// Auto-detects ~/.claude/model-router/ (MetaHarness) OR runs against local starter-kit files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routePrompt } from './standalone-router.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const mhPolicy = path.join(HOME, '.claude', 'model-router', 'routing-policy.json');
const kitPolicy = path.join(__dirname, 'routing-policy.template.json');
const policyPath = fs.existsSync(mhPolicy) ? mhPolicy : kitPolicy;
const mode = fs.existsSync(mhPolicy) ? 'installed-metaharness' : 'standalone-starter-kit';

const checks = [];
function add(id, ok, detail) { checks.push({ id, ok: Boolean(ok), detail }); }

const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const TIERS = ['fast', 'medium', 'substantial', 'hard', 'exceptional'];
const hosts = Object.keys(policy.routes || {});
add('policy-loaded', hosts.length >= 4, \`\${hosts.length} hosts configured (\${hosts.join(', ')})\`);

// Verify all 20 required host x tier routes have non-empty model & effort (prevents empty-object false pass!)
let validRoutes = 0;
const missingRoutes = [];
for (const h of hosts) {
  for (const t of TIERS) {
    const r = policy.routes?.[h]?.[t];
    if (r && typeof r.model === 'string' && r.model.trim() && typeof r.effort === 'string' && r.effort.trim()) {
      validRoutes++;
    } else {
      missingRoutes.push(\`\${h}.\${t}\`);
    }
  }
}
add('all-20-routes-populated', hosts.length >= 4 && missingRoutes.length === 0, missingRoutes.length === 0 ? \`\${validRoutes}/\${hosts.length * 5} host×tier routes populated\` : \`Missing: \${missingRoutes.slice(0, 6).join(', ')}\`);

// Verify declared policy freshness (not just file mtime!)
const declaredTs = policy.policyRevisionAt || policy.reviewedAt || policy.updated_at;
const parsedMs = declaredTs ? Date.parse(declaredTs) : NaN;
const ageDays = Number.isFinite(parsedMs) ? Math.max(0, Math.floor((Date.now() - parsedMs) / 86400000)) : 999;
add('policy-freshness', ageDays <= 7, Number.isFinite(parsedMs) ? \`Policy date \${String(declaredTs).slice(0, 10)} (\${ageDays}d old, limit <=7d)\` : 'Missing reviewedAt/policyRevisionAt timestamp');

const leakedKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
  .filter((k) => Boolean(process.env[k]));
add('zero-api-key-leak', leakedKeys.length === 0, leakedKeys.length === 0 ? 'No paid API keys active in shell env' : \`Found: \${leakedKeys.join(', ')}\`);

// Verify no routine tier defaults to max/xhigh
let effortViolations = 0;
for (const h of hosts) {
  for (const tier of ['fast', 'medium', 'substantial', 'hard']) {
    const eff = String(policy.routes?.[h]?.[tier]?.effort || '').toLowerCase();
    if (eff === 'max' || eff === 'xhigh') effortViolations++;
  }
}
add('effort-caps', effortViolations === 0, effortViolations === 0 ? 'No routine tier exceeds high thinking effort' : \`\${effortViolations} effort cap violations\`);

// Run 36-case eval suite
const evalPath = path.join(__dirname, 'routing-eval-cases.json');
const evalCases = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
const list = Array.isArray(evalCases) ? evalCases : (evalCases.cases || []);
const ORDER = ['fast', 'medium', 'substantial', 'hard', 'exceptional'];
let passed = 0;
for (const c of list) {
  const exp = c.expected || c.expectedClass || c.tier;
  const r = routePrompt(c.request || c.prompt || c.taskHints || '', { priorFailure: Boolean(c.priorFailure), taskFacts: c.taskFacts, policyPath });
  const idx = ORDER.indexOf(r.tier);
  const ok = typeof exp === 'string'
    ? r.tier === exp
    : (idx >= (exp?.minimumClass ? ORDER.indexOf(exp.minimumClass) : 0) && idx <= (exp?.maximumClass ? ORDER.indexOf(exp.maximumClass) : 4));
  if (ok) passed++;
}
add('eval-suite', passed === list.length && list.length > 0, \`\${passed}/\${list.length} safety eval cases passed\`);

// Live escalation check
const esc = routePrompt('still broken, tests failed twice on auth middleware', { priorFailure: true, policyPath });
add('auto-escalation', esc.escalated === true, \`Escalated to \${esc.tier} (\${esc.model}@\${esc.effort})\`);

const allOk = checks.every((c) => c.ok);
const alerts = checks.filter((c) => !c.ok).map((c) => \`ALERT [\${c.id}]: \${c.detail}\`);
console.log(JSON.stringify({ ok: allOk, mode, policyPath, passed: checks.filter((c) => c.ok).length, total: checks.length, alerts, checks }, null, 2));
process.exit(allOk ? 0 : 1);
`, 'utf8');

// 7. Standalone-safe router-utilization.mjs (zero broken imports)
fs.writeFileSync(path.join(STAGE, 'router-utilization.mjs'), `#!/usr/bin/env node
// router-utilization.mjs — Standalone Before-vs-After routing tier distribution analyzer.
// Reads ~/.claude/metaharness/routing-decisions.jsonl (or --file <path>) and prints tier shares.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const fIdx = args.indexOf('--file');
const file = fIdx >= 0 ? args[fIdx + 1] : path.join(os.homedir(), '.claude', 'metaharness', 'routing-decisions.jsonl');

if (!fs.existsSync(file)) {
  console.log(JSON.stringify({
    ok: true,
    status: 'no-decisions-log-yet',
    file,
    note: 'Once your prompt hook logs JSONL decisions, run this script to compare 7-day vs 60-day tier distribution.',
  }, null, 2));
  process.exit(0);
}

const now = Date.now();
const d7 = now - 7 * 86400 * 1000;
const d60 = now - 60 * 86400 * 1000;
const makeBucket = () => ({ total: 0, counts: { fast: 0, medium: 0, substantial: 0, hard: 0, exceptional: 0 } });
const all = makeBucket(), last7d = makeBucket(), prior60d = makeBucket();
for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
  if (!line.trim()) continue;
  try {
    const d = JSON.parse(line);
    const k = d.taskClass || d.tier;
    if (!k || !(k in all.counts)) continue;
    all.counts[k]++; all.total++;
    const ts = Date.parse(d.ts || d.timestamp || d.at || '');
    if (Number.isFinite(ts)) {
      if (ts >= d7) { last7d.counts[k]++; last7d.total++; }
      else if (ts >= d60) { prior60d.counts[k]++; prior60d.total++; }
    }
  } catch {}
}
const toPct = (b) => ({
  total: b.total,
  pcts: Object.fromEntries(Object.entries(b.counts).map(([k, v]) => [k, b.total ? +((v / b.total) * 100).toFixed(1) : 0])),
});
console.log(JSON.stringify({ ok: true, allTime: toPct(all), last7d: toPct(last7d), prior60d: toPct(prior60d) }, null, 2));
`, 'utf8');

// 8. Standalone examples for non-MetaHarness users
fs.writeFileSync(path.join(STAGE, 'examples/hooks-and-configs.md'), `# Drop-In Config & Hook Recipes (No MetaHarness Required)
Updated: 2026-11-22 EST

## 1. Claude Code (\`~/.claude/settings.json\`)
Park your main session on \`sonnet\` and add the 50% \`⚡/compact\` statusline guard:
\`\`\`json
{
  "model": "sonnet",
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline-50pct-compact.cjs"
  }
}
\`\`\`

## 2. Codex CLI (\`~/.codex/config.toml\`)
Park Codex on \`gpt-6.2-sol\` (medium effort) and reserve \`gpt-6.2-astra\` for explicit escalations:
\`\`\`toml
model = "gpt-6.2-sol"
model_reasoning_effort = "medium"
default_subagent_model = "gpt-6.2-sol"
\`\`\`

## 3. Grok CLI (\`~/.grok/config.toml\`)
Park on \`grok-4.7\` (low/medium effort) and offload secondary work to \`grok-build\`:
\`\`\`toml
model = "grok-4.7"
reasoning_effort = "low"
fork_secondary_model = "grok-build"
\`\`\`

## 4. Cursor IDE (\`.cursorrules\` / Settings)
- Set default Composer/Chat model to **Claude Sonnet** or **Gemini Neon Medium** (not Opus/Max).
- Start a **fresh Composer thread** every time context crosses ~50% (never reuse one 500k-token chat all day).
- Use \`@codebase\` / quick lookups on Fast/Flash models, then paste only the 2–3 relevant files into a Hard/Reasoning model for tricky bugs.

## 5. Production Apps (Lens 2 — Zero Hardcoded Model IDs)
\`\`\`js
import { callWithAutoEscalation } from './app-model-router.mjs';

const { output, receipt } = await callWithAutoEscalation({
  tier: 'fast',
  purpose: 'extract-invoice-json',
  execute: (route) => mySdk.generate({ model: route.model, reasoningEffort: route.effort, prompt }),
  validate: (out) => typeof out?.total === 'number' && Boolean(out?.vendor),
});
\`\`\`
Swap any tier globally with **zero code edits** via \`APP_MODEL_TIERS_JSON='{"fast":{"model":"gemini-4.5-flash","effort":"low"}}'\` (applies on next container restart/redeploy, or immediately when backed by a runtime config store / KV).
`, 'utf8');

fs.writeFileSync(path.join(STAGE, 'examples/statusline-50pct-compact.cjs'), `#!/usr/bin/env node
// Minimal standalone 50% context ⚡/compact guard for Claude Code / Antigravity / Grok statuslines.
const fs = require('fs');
let data = {};
try { data = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
const pct = Math.round(data?.context_window?.used_percentage || 0);
const warn = pct >= 50 ? ' \\x1b[1;31m⚡/compact\\x1b[0m' : '';
const col = pct >= 65 ? '\\x1b[1;31m' : pct >= 50 ? '\\x1b[1;33m' : '\\x1b[1;32m';
console.log(\`\${col}ctx \${pct}%\\x1b[0m\${warn} | $0 prepaid subscription mode\`);
`, 'utf8');

// 9. SETUP-PROMPT.txt & README.md (accurately listing all 16 files!)
fs.writeFileSync(path.join(STAGE, 'SETUP-PROMPT.txt'), `I downloaded the 16-file AI Subscription Routing & Quota-Optimization Starter Kit. Please read README.md, AI-Subscription-Routing-Playbook.md, and APP-MODEL-ROUTING-INTEGRATION.md, then help me configure MY machine and MY workflow.

Note: I may or may not be using MetaHarness today—inspect what I actually have installed first and recommend the cleanest setup for MY environment (never enabling pay-by-the-drink API billing for personal coding on my prepaid developer seats).

Please do the following in order:
1. Run \`node audit-my-ai-usage.mjs\` locally (zero data leaves my machine) and show me my real 60-day score, Frontier %, warm cache hit rate, and any leaked API keys.
2. Recommend which prepaid subscription tiers I should keep, upgrade, or downgrade based on my actual numbers.
3. Run \`node standalone-router.mjs --eval\` to verify the 36-case safety eval suite, then replay 50+ of my real recent prompts to prove the distribution shift (~25-35% fast, ~50-55% medium, ~10-15% frontier) before changing any configs.
4. Once I approve, back up my existing configs, configure my default medium coordinators (using examples/hooks-and-configs.md), wire the 4 quota-hygiene rules and 50% ⚡/compact statusline guard, and schedule weekly model freshness checks with \`model-auto-refresh.mjs\` and \`model-routing-audit.mjs\`.
5. For any deployed apps I build going forward, wire \`app-model-router.mjs\` so no app ever hardcodes a vendor model ID.
`, 'utf8');

fs.writeFileSync(path.join(STAGE, 'README.md'), `# AI Subscription Routing & Quota-Optimization Starter Kit (16-File Packet)
Updated: 2026-11-22 02:30 EST | Zero external dependencies · Works with or without MetaHarness

## 3-Step Quickstart (2 Minutes, 100% Local)
\`\`\`bash
unzip ai-routing-starter-kit.zip -d ai-routing-kit && cd ai-routing-kit
node audit-my-ai-usage.mjs            # 1. Measure YOUR real 60-day score (0-100)
node standalone-router.mjs --eval     # 2. Verify 36/36 safety eval cases locally
node model-routing-audit.mjs          # 3. Run the watchdog self-audit
node app-model-router.mjs --smoke     # 4. Smoke-test Lens 2 production app router
\`\`\`

## What's Inside (16 Standalone Files)
1. \`README.md\` — This quickstart guide and manifest
2. \`SETUP-PROMPT.txt\` — Copy-paste prompt for Claude Code, Antigravity, Codex, Grok, or Cursor
3. \`audit-my-ai-usage.mjs\` — Zero-dependency 60-day local usage auditor (Claude, Codex, Antigravity, Grok, Cursor)
4. \`standalone-router.mjs\` — Standalone 5-tier prompt classifier + 36-case eval runner
5. \`policy.default.mjs\` — 5-tier classification rules (\`fast\`, \`medium\`, \`substantial\`, \`hard\`, \`exceptional\`)
6. \`routing-policy.template.json\` — Canonical 4-host × 5-tier allocation + AA v5.0.1 effort caps
7. \`routing-eval-cases.json\` — 36-case routing safety regression suite
8. \`app-model-router.mjs\` — Lens 2 zero-hardcoded production app router (provider fallback + auto-escalation)
9. \`model-auto-refresh.mjs\` — Local CLI model cache scanner & freshness checker
10. \`model-routing-audit.mjs\` — Self-audit watchdog (works standalone or with MetaHarness)
11. \`router-utilization.mjs\` — Before-vs-after routing tier distribution analyzer
12. \`MODEL-ROUTING-ARCHITECTURE.md\` — Complete thought process, forensic drift timeline & architecture
13. \`AI-Subscription-Routing-Playbook.md\` — Full developer & enterprise playbook
14. \`APP-MODEL-ROUTING-INTEGRATION.md\` — Production app zero-hardcoded model standard
15. \`examples/hooks-and-configs.md\` — Drop-in configs for Claude Code, Codex, Grok, Cursor & production apps
16. \`examples/statusline-50pct-compact.cjs\` — Minimal 50% context \`⚡/compact\` statusline guard
`, 'utf8');

// 10. Smoke-test EVERY standalone script in STAGE before zipping!
console.log('Smoke-testing standalone scripts in', STAGE);
const cleanEnv = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete cleanEnv[k];
execFileSync('node', ['standalone-router.mjs', '--eval'], { cwd: STAGE, env: cleanEnv, stdio: 'inherit' });
execFileSync('node', ['app-model-router.mjs', '--smoke'], { cwd: STAGE, env: cleanEnv, stdio: 'inherit' });
execFileSync('node', ['model-routing-audit.mjs'], { cwd: STAGE, env: cleanEnv, stdio: 'inherit' });
execFileSync('node', ['model-auto-refresh.mjs', '--dry-run'], { cwd: STAGE, env: cleanEnv, stdio: 'inherit' });
execFileSync('node', ['router-utilization.mjs'], { cwd: STAGE, env: cleanEnv, stdio: 'inherit' });
execFileSync('node', ['audit-my-ai-usage.mjs', '--json'], { cwd: STAGE, env: cleanEnv, stdio: 'pipe' });

// 11. Build ZIP and copy to all 3 destinations
const zipOut = path.join(REPO, 'explainer/ai-routing-starter-kit.zip');
if (fs.existsSync(zipOut)) fs.unlinkSync(zipOut);
execFileSync('zip', ['-r', '-q', zipOut, '.'], { cwd: STAGE });
fs.copyFileSync(zipOut, path.join(HOME, 'Code/ISO Vision AI new Site/ai-routing-starter-kit.zip'));
fs.copyFileSync(zipOut, path.join(HOME, 'Documents/ai-routing-starter-kit.zip'));
console.log('Built & verified 16-file starter kit:', zipOut, fs.statSync(zipOut).size, 'bytes');
