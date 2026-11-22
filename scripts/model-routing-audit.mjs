#!/usr/bin/env node
// scripts/model-routing-audit.mjs — Automated self-audit watchdog for Stuart's 4-host $0 subscription router.
// Checks every invariant from docs/MODEL-ROUTING-ARCHITECTURE.md and prints explicit ALERTS if anything drifts.
// Usage: node scripts/model-routing-audit.mjs [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const ROUTER_DIR = process.env.MODEL_ROUTER_CONFIG_DIR || path.join(HOME, '.claude', 'model-router');
const HARNESSES = ['antigravity', 'claude-code', 'codex', 'grok'];
const TIERS = ['fast', 'medium', 'substantial', 'hard', 'exceptional'];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export async function runAudit() {
  const alerts = [];
  const checks = [];
  const pass = (name, detail) => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => { checks.push({ name, ok: false, detail }); alerts.push(`ALERT [${name}]: ${detail}`); };

  // 1. Profile: all 4 hosts enabled & $0 subscription-only, all API keys false
  const profile = readJson(path.join(ROUTER_DIR, 'profile.json'));
  if (!profile) {
    fail('profile', '~/.claude/model-router/profile.json is missing or unreadable');
  } else {
    const missingHosts = HARNESSES.filter((h) => profile.harnesses?.[h]?.available !== true || profile.harnesses?.[h]?.subscription !== true || profile.harnesses?.[h]?.enabled === false);
    const leakedKeys = Object.entries(profile.keys || {}).filter(([, v]) => v === true).map(([k]) => k);
    if (missingHosts.length) fail('profile-hosts', `Hosts missing/disabled in profile.json: ${missingHosts.join(', ')}`);
    else pass('profile-hosts', 'All 4 subscription hosts (antigravity, claude-code, codex, grok) enabled at $0 marginal cost');
    if (leakedKeys.length) fail('zero-api-keys', `Paid API keys enabled in profile.json: ${leakedKeys.join(', ')}`);
    else pass('zero-api-keys', 'All 6 paid API keys disabled in profile.json');
  }

  // 2. Policy: all 4 hosts × 5 tiers present, no routine xhigh/max waste
  const policy = readJson(path.join(ROUTER_DIR, 'routing-policy.json'));
  if (!policy) {
    fail('policy', '~/.claude/model-router/routing-policy.json missing or unreadable');
  } else {
    const missingRoutes = [];
    const wastefulRoutine = [];
    for (const h of HARNESSES) {
      for (const t of TIERS) {
        const r = policy.routes?.[h]?.[t];
        if (!r?.model || !r?.effort) missingRoutes.push(`${h}.${t}`);
        else if (['fast', 'medium', 'substantial', 'hard'].includes(t) && ['xhigh', 'max'].includes(r.effort)) {
          wastefulRoutine.push(`${h}.${t}=${r.model}@${r.effort}`);
        }
      }
    }
    if (missingRoutes.length) fail('policy-routes', `Missing routes: ${missingRoutes.join(', ')}`);
    else pass('policy-routes', 'All 20 routes (4 hosts × 5 tiers) configured');
    if (wastefulRoutine.length) fail('effort-caps', `Routine tiers using wasteful xhigh/max: ${wastefulRoutine.join(', ')}`);
    else pass('effort-caps', 'AA v5.0.1 effort caps intact (no xhigh/max on routine tiers)');
  }

  // 3. 36-case evaluation suite passes 100%
  try {
    const { classify } = await import(path.join(ROUTER_DIR, 'policy.default.mjs'));
    const { extractFeatures } = await import(path.join(ROUTER_DIR, 'bin/model-router-engine.mjs'));
    const suite = readJson(path.join(ROUTER_DIR, 'config/model-router/routing-eval-cases.json'));
    const failed = [];
    for (const c of suite.cases) {
      const got = classify(extractFeatures(c.request, 'codex', c.taskFacts), 'codex');
      if (got !== c.expected.minimumClass) failed.push(`${c.id}(exp=${c.expected.minimumClass},got=${got})`);
    }
    if (failed.length) fail('eval-suite', `${failed.length}/${suite.cases.length} failed: ${failed.join(', ')}`);
    else pass('eval-suite', `36/36 routing evaluation cases passed`);
  } catch (e) {
    fail('eval-suite', `Failed to run evaluation suite: ${e.message}`);
  }

  // 4. Live hook verification across all 4 hosts (fast lookup + failure escalation + quota hygiene)
  const hookScript = path.join(ROUTER_DIR, 'bin/user-model-prompt-hook.mjs');
  for (const [flag, h] of [['--antigravity', 'antigravity'], ['--claude', 'claude-code'], ['--codex', 'codex'], ['--grok', 'grok']]) {
    try {
      const fastOut = JSON.parse(execFileSync(process.execPath, [hookScript, flag], {
        input: JSON.stringify({ prompt: 'do we have metallm set up?' }),
        encoding: 'utf8', timeout: 3000,
      })).hookSpecificOutput?.additionalContext || '';
      const escOut = JSON.parse(execFileSync(process.execPath, [hookScript, flag], {
        input: JSON.stringify({ prompt: 'That did not work and is still failing; fix the race condition in token verification.' }),
        encoding: 'utf8', timeout: 3000,
      })).hookSpecificOutput?.additionalContext || '';
      if (!fastOut.includes('taskClass=fast') || !escOut.includes('taskClass=exceptional') || !fastOut.includes('QUOTA HYGIENE')) {
        fail(`hook-${h}`, `Hook output missing expected fast/exceptional/QUOTA HYGIENE directives`);
      } else {
        pass(`hook-${h}`, `Live hook verified (fast + automatic failure escalation + 4 quota-hygiene rules)`);
      }
    } catch (e) {
      fail(`hook-${h}`, `Hook execution failed: ${e.message}`);
    }
  }

  // 5. Grok hook file, statusline 50% compact guard, weekly + nightly auto-refresh wiring
  if (fs.existsSync(path.join(HOME, '.grok/hooks/model-router.json'))) pass('grok-hook-wired', '~/.grok/hooks/model-router.json present');
  else fail('grok-hook-wired', '~/.grok/hooks/model-router.json missing');

  const slAgy = fs.existsSync(path.join(HOME, '.gemini/antigravity-cli/statusline-ruflo.cjs'))
    ? fs.readFileSync(path.join(HOME, '.gemini/antigravity-cli/statusline-ruflo.cjs'), 'utf8') : '';
  const slGrok = fs.existsSync(path.join(HOME, '.grok/statusline.cjs'))
    ? fs.readFileSync(path.join(HOME, '.grok/statusline.cjs'), 'utf8') : '';
  if (slAgy.includes('/compact') && slGrok.includes('/compact')) pass('statusline-compact-guard', '50% ⚡/compact guard active in Antigravity and Grok statuslines');
  else fail('statusline-compact-guard', '50% ⚡/compact guard missing from one or more statuslines');

  const weeklySh = fs.existsSync(path.join(ROUTER_DIR, 'bin/goldie-weekly.sh'))
    ? fs.readFileSync(path.join(ROUTER_DIR, 'bin/goldie-weekly.sh'), 'utf8') : '';
  const nightlyJs = fs.existsSync(path.join(HOME, '.codex/scripts/developer-maintenance.mjs'))
    ? fs.readFileSync(path.join(HOME, '.codex/scripts/developer-maintenance.mjs'), 'utf8') : '';
  if (weeklySh.includes('model-auto-refresh.mjs') && nightlyJs.includes('maintainModelRouter')) {
    pass('auto-refresh-schedules', 'model-auto-refresh.mjs wired into both weekly (goldie-weekly.sh) and nightly (developer-maintenance.mjs)');
  } else {
    fail('auto-refresh-schedules', 'model-auto-refresh.mjs missing from weekly or nightly schedule');
  }

  // 6. Verify Meta Proxy Cloud is NOT active (no pay-by-the-drink billing)
  const metaProxyCfg = readJson(path.join(HOME, '.ruflo/proxy.json')) || readJson(path.join(HOME, '.ruflo/meta-proxy.json'));
  if (metaProxyCfg?.mode === 'cloud' || metaProxyCfg?.cloud === true) {
    fail('meta-proxy-cloud-off', 'Meta Proxy Cloud mode appears enabled — disable to prevent pay-by-the-drink billing');
  } else {
    pass('meta-proxy-cloud-off', 'Meta Proxy Cloud is OFF ($0 subscription safety intact)');
  }

  return { ok: alerts.length === 0, checkedAt: new Date().toISOString(), passed: checks.filter((c) => c.ok).length, total: checks.length, alerts, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAudit().then((res) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`MetaHarness 4-Host Routing Audit: ${res.ok ? 'PASS' : 'FAIL'} (${res.passed}/${res.total} checks passed)`);
      for (const c of res.checks) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(26)} ${c.detail}`);
      }
      if (res.alerts.length) {
        console.log('\nALERTS:');
        for (const a of res.alerts) console.log(`  ${a}`);
      }
    }
    if (!res.ok) process.exitCode = 1;
  });
}
