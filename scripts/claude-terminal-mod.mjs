#!/usr/bin/env node
// Materialize the sandboxed native mod and bridge it to the existing reviewed policy engine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify } from '../config/model-router/policy.default.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MOD_SOURCE = path.join(ROOT, 'config/model-router/claude-terminal-mod');
export function terminalModDigest(pluginRoot) {
  const hash = crypto.createHash('sha256');
  for (const relative of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js', 'hooks/routing.js', 'hooks/policy.default.mjs', 'hooks/runtime.js']) {
    hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(path.join(pluginRoot, relative))); hash.update('\0');
  }
  return hash.digest('hex');
}
export function prepareClaudeTerminalMod({ destination, nodePath = process.execPath,
  helperPath = fileURLToPath(import.meta.url), enginePath = path.join(ROOT, 'scripts/model-router-engine.mjs') } = {}) {
  if (!destination || !path.isAbsolute(destination)) throw new Error('Absolute mod destination required');
  for (const file of [nodePath, helperPath, enginePath]) if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('Native mod dependency unavailable');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const part of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js', 'hooks/routing.js']) {
    const dest = path.join(destination, part);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(MOD_SOURCE, part), dest);
  }
  const policyPath = path.join(destination, 'hooks/policy.default.mjs');
  fs.copyFileSync(path.join(ROOT, 'config/model-router/policy.default.mjs'), policyPath);
  fs.writeFileSync(path.join(destination, 'hooks/runtime.js'), `export default ${JSON.stringify({ nodePath, helperPath, enginePath, policyPath })};\n`, { mode: 0o600 });
  return { pluginDir: destination, policyPath, modDigest: terminalModDigest(destination) };
}
export function validateDecision(decision, now = Date.now()) {
  const age = now - Date.parse(decision?.selectionReviewedAt);
  const maxAge = decision?.selectionMaxAgeMs;
  if (decision?.harness !== 'claude-code' || decision.provider !== 'anthropic' || decision.subscriptionCovered !== true ||
      !/^claude-[a-z0-9][a-z0-9.-]*$/.test(decision.model || '') || !['fast', 'medium', 'hard'].includes(decision.taskClass) ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(decision.effort) ||
      !Number.isSafeInteger(maxAge) || maxAge <= 0 || maxAge > 604800000 || !Number.isFinite(age) || age < 0 ||
      !/^[a-f0-9]{64}$/.test(decision.selectionRouteDigest || '')) throw new Error('Native terminal routing decision invalid; no fallback');
  return decision;
}
export function routeNativePrompt({ prompt, turnId, minimumClass, enginePath = path.join(ROOT, 'scripts/model-router-engine.mjs'),
  policyPath = path.join(ROOT, 'config/model-router/policy.default.mjs'), env = process.env } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw new Error('Native routing requires a bounded text prompt');
  if (minimumClass !== undefined && !['fast', 'medium', 'hard'].includes(minimumClass)) throw new Error('Invalid class floor');
  const codeFences = Math.floor((prompt.match(/```/g) || []).length / 2);
  const hasCode = codeFences > 0 || /\b(function|const|let|def|class|import|=>|SELECT|async)\b/.test(prompt) || /[{};]\s*$/m.test(prompt);
  const rank = { fast: 0, medium: 1, hard: 2 };
  const canonicalFloor = classify({ taskHints: prompt, hasCode }, 'claude-code');
  const floor = rank[minimumClass] > rank[canonicalFloor] ? minimumClass : canonicalFloor;
  const classificationPrompt = floor === 'hard' ? 'final substantive review\n' + prompt : prompt;
  // Let the engine honor the user's policy.mjs; the bundled copy is only the
  // deterministic classification floor used by the sandboxed hook.
  const result = spawnSync(process.execPath, [enginePath, '--harness', 'claude-code', '--request-json', '--policy-only', '--json'],
    { input: JSON.stringify({ prompt: classificationPrompt }), encoding: 'utf8', env, timeout: 8000, maxBuffer: 262144 });
  if (result.error || result.status !== 0) throw new Error('Reviewed native routing policy unavailable; no fallback');
  const d = validateDecision(JSON.parse(result.stdout));
  if (rank[d.taskClass] < rank[floor]) throw new Error('Reviewed native routing policy below canonical floor; no fallback');
  // No prompt, reasoning, credentials, or arbitrary engine output crosses back to the sandbox.
  return { schemaVersion: 1, turnId: typeof turnId === 'string' ? turnId : null, model: d.model, effort: d.effort,
    taskClass: d.taskClass, expiresAt: Date.parse(d.selectionReviewedAt) + d.selectionMaxAgeMs,
    subscriptionCovered: true, routeDigest: d.selectionRouteDigest };
}
export function writeReadinessReceipt({ nonce, receiptPath, pluginRoot, version, sessionId, status = 'ready' } = {}) {
  if (!/^[a-f0-9]{64}$/.test(nonce || '') || !path.isAbsolute(receiptPath || '') ||
      !path.isAbsolute(pluginRoot || '') || (!/^2\.1\.\d+$/.test(version || '') || Number(version.split('.')[2]) < 287) || typeof sessionId !== 'string' ||
      !['ready', 'health'].includes(status)) throw new Error('Invalid native mod readiness request');
  const receipt = { schemaVersion: 1, nonce, pluginRoot: fs.realpathSync(pluginRoot), nativeVersion: version,
    sessionId, status, modDigest: terminalModDigest(pluginRoot), observedAt: new Date().toISOString(), pid: process.ppid,
    scope: 'hook activation only; native load failure or worker crash can skip hooks' };
  const parent = path.dirname(receiptPath);
  if (!fs.existsSync(parent)) throw new Error('Readiness directory must be prepared by launcher');
  const temporary = path.join(parent, `.rnb-ready-${crypto.randomBytes(16).toString('hex')}`);
  fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, receiptPath);
  return receipt;
}
async function main() {
  const mode = process.argv[2];
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (mode === '--decision') process.stdout.write(JSON.stringify(routeNativePrompt(request)) + '\n');
  else if (mode === '--ready' || mode === '--health') process.stdout.write(JSON.stringify(writeReadinessReceipt({ ...request, status: mode === '--ready' ? 'ready' : 'health' })) + '\n');
  else if (mode === '--prepare') process.stdout.write(JSON.stringify(prepareClaudeTerminalMod(request)) + '\n');
  else throw new Error('Expected --prepare, --decision, --ready, or --health');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('claude-terminal-mod: routing or activation unavailable; no fallback\n'); process.exitCode = 1;
});
