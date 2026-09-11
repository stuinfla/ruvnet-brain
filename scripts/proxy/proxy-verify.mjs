#!/usr/bin/env node
/**
 * proxy-verify.mjs — trial-specific verification for the Meta LLM Proxy.
 *
 * DELIBERATELY THIN. rUv already ships the health check:
 *
 *     ruflo doctor --component proxy
 *
 * which covers binary signature, version, process liveness (via the proxy's
 * own /status), bind address, and sponsored-consent state (ADR-307/313).
 * This script SHELLS OUT to that rather than reimplementing it — an earlier
 * draft of this file hand-rolled all of it before the grounding gate caught
 * that the real tool existed.
 *
 * It adds exactly two things rUv's doctor does not do, both specific to this
 * trial rather than to the proxy in general:
 *
 *   1. A real end-to-end completion through /v1/messages, checked against the
 *      PASSTHROUGH ORACLE. Per ADR-313's addendum, a genuine Anthropic
 *      response carries `service_tier` and `cache_creation` in usage; Cognitum's
 *      gateway never returns them. Their presence proves the request reached
 *      real Anthropic on the user's own subscription rather than being quietly
 *      served by a cheap-tier substitute. The doctor confirms the process is
 *      healthy; only this proves the round-trip is real.
 *
 *   2. That the trial has NOT been wired globally. This trial is opt-in per
 *      session by design; an ANTHROPIC_BASE_URL in ~/.claude/settings.json
 *      would put the proxy in the hot path of every Claude Code window on the
 *      machine, which is exactly what this trial promised not to do.
 *
 * Exit 0 only if every check passes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:11435';
const TOKEN_PATH = path.join(os.homedir(), '.ruflo', 'proxy-token');
const PROBE_MODEL = process.env.PROXY_VERIFY_MODEL || 'claude-haiku-4-5-20251001';

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('Meta LLM Proxy — trial verification\n');

// ---------------------------------------------------------------------------
// 1. rUv's shipped health check. We do not reimplement any of it.
// ---------------------------------------------------------------------------
console.log('[1] ruflo doctor --component proxy (rUv\'s own check)');
let doctorOut = '';
let doctorOk = false;
try {
  doctorOut = execFileSync('ruflo', ['doctor', '--component', 'proxy'], {
    encoding: 'utf8',
    timeout: 60_000,
    // Every `ruflo` invocation auto-starts a project background daemon unless this is set
    // (verified live: ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/
    // services/daemon-autostart.js:85) — a health-check probe must not leave one running.
    env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
  });
  doctorOk = /Summary:.*passed/.test(doctorOut) && !/\b\d+ failed/.test(doctorOut);
} catch (err) {
  doctorOut = err.stdout || String(err);
}
for (const line of doctorOut.split('\n')) {
  if (/^[✓✗⚠]/.test(line.trim())) console.log(`    ${line.trim()}`);
}
record('ruflo proxy doctor reports healthy', doctorOk);

// The doctor prints the resolved plane; surface it as its own assertion so a
// silent flip away from passthrough can never pass unnoticed.
record('data plane is passthrough', /data plane:\s*passthrough/i.test(doctorOut));

// ---------------------------------------------------------------------------
// 2. The round-trip the doctor does not perform.
// ---------------------------------------------------------------------------
console.log('\n[2] live round-trip + passthrough oracle');
let token = '';
try {
  token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
} catch {
  /* handled below */
}

if (!token) {
  record('live round-trip returns correct content', false, 'no proxy token');
  record('response proves REAL Anthropic', false, 'skipped');
} else {
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: PROXY_OK' }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json();
    const text = body?.content?.[0]?.text ?? '';
    record('live round-trip returns correct content', res.ok && text.includes('PROXY_OK'), `HTTP ${res.status}`);

    const usage = body?.usage ?? {};
    const oracleOk = 'service_tier' in usage && 'cache_creation' in usage;
    record(
      'response proves REAL Anthropic (service_tier + cache_creation)',
      oracleOk,
      oracleOk ? `service_tier=${usage.service_tier}` : 'oracle fields ABSENT — did not reach Anthropic',
    );
  } catch (err) {
    record('live round-trip returns correct content', false, String(err?.message || err));
    record('response proves REAL Anthropic', false, 'no response');
  }
}

// ---------------------------------------------------------------------------
// 3. Trial safety: opt-in per session, never global.
// ---------------------------------------------------------------------------
console.log('\n[3] trial safety');
let noGlobalWiring = true;
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
try {
  if (fs.existsSync(settingsPath)) {
    noGlobalWiring = !fs.readFileSync(settingsPath, 'utf8').includes('ANTHROPIC_BASE_URL');
  }
} catch {
  /* absent file is fine */
}
record('NOT wired globally (~/.claude/settings.json clean)', noGlobalWiring);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
console.log('Verified: proxy healthy, passthrough, real Anthropic round-trip, not wired globally.');
