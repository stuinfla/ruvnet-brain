#!/usr/bin/env node
// DISTINCT-FROM: model-weekly-analyst.mjs — bounded scheduler coordinator; metadata first, semantic work only when due.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, currencyStatus, WEEK_MS } from './model-currency-evidence.mjs';
import { subscriptionOnlyEnv } from './subscription-hosts.mjs';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const RETRY_MS = 3600000;
function read(file, limit) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(limit + 1); const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n > limit) throw new Error('Weekly cycle input exceeds bounded limit'); return b.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function json(dir, file, limit = 65536) { try { return JSON.parse(read(path.join(dir, file), limit)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
// The short commit guard is never automatically reaped. A crash within it fails closed.
function transaction(dir, fn) { const guard = path.join(dir, 'weekly-cycle-mutation.lock');
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { return fn(); } finally { fs.rmdirSync(guard); }
}
const ownerFile = 'weekly-cycle-owner.json';
function atomic(file, body) { const temp = `${file}.${randomUUID()}.tmp`; try { const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file);
} finally { try { fs.unlinkSync(temp); } catch { /* committed */ } } }
function claim(dir, now) { return transaction(dir, () => { const old = json(dir, ownerFile, 4096);
  if (old && (!Number.isFinite(old.expiresAt) || old.expiresAt > now)) return null;
  const token = randomUUID(); atomic(path.join(dir, ownerFile), JSON.stringify({ token, expiresAt: now + 1200000 })); return token;
}); }
function assertOwner(dir, token) { if (json(dir, ownerFile, 4096)?.token !== token) throw new Error('Weekly cycle superseded'); }
function writeOwned(dir, token, file, value) { const committed = transaction(dir, () => { assertOwner(dir, token); atomic(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return true; });
  if (!committed) throw new Error('Weekly cycle mutation guard unavailable'); }
function release(dir, token) { transaction(dir, () => { if (json(dir, ownerFile, 4096)?.token === token) fs.unlinkSync(path.join(dir, ownerFile)); }); }
export function runCycleStage({ script, args, timeoutMs, env, spawnHost = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnHost(process.execPath, [path.join(DIR, script), ...args], { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', timedOut = false, killTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, timeoutMs);
    child.stderr.on('data', () => {}); child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 262144) { timedOut = true; child.kill('SIGKILL'); } });
    child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error('Weekly cycle child host unavailable')); });
    child.once('exit', (code) => { clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) return reject(new Error('Weekly cycle child exceeded bounded deadline or output limit'));
      let result; try { result = JSON.parse(stdout.trim().split('\n').at(-1)); } catch { return reject(new Error('Weekly cycle child receipt missing')); }
      resolve({ code, result });
    });
  });
}
const INVENTORY_URL = 'https://openrouter.ai/api/v1/models';
const STATE_FILE = 'weekly-model-discovery.json';
export function canonicalTextReleases(bytes) {
  const rows = JSON.parse(bytes)?.data;
  if (!Array.isArray(rows) || rows.length < 50) throw new Error('Public inventory incomplete; release status unknown');
  const releases = new Map();
  for (const r of rows) {
    if (!/^(openai|anthropic)\//.test(r.id ?? '') || !r.architecture?.output_modalities?.includes('text')) continue;
    if (!/^(openai|anthropic)\//.test(r.canonical_slug ?? '')) throw new Error('Canonical release identity missing; discovery unknown');
    const entry = releases.get(r.canonical_slug) ?? { id: r.canonical_slug, provider: r.canonical_slug.split('/')[0], aliases: [] };
    entry.aliases.push(r.id); releases.set(entry.id, entry);
  }
  if (![...releases.values()].some((r) => r.provider === 'openai') || ![...releases.values()].some((r) => r.provider === 'anthropic')) throw new Error('Provider discovery coverage incomplete');
  return [...releases.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function discoveryDue(state, now) { const checked = Date.parse(state?.checkedAt);
  return !Number.isFinite(checked) || checked > now || now - checked >= WEEK_MS;
}
export function maybeLaunchWeeklyCycle({ routerDir = path.join(os.homedir(), '.claude', 'model-router'), now = Date.now(), launch = spawn, env = process.env } = {}) {
  try {
    if (env.MODEL_ROUTER_WEEKLY_ANALYST === '1') return { status: 'recursive-worker', launched: false, reviewRequired: false };
    fs.mkdirSync(routerDir, { recursive: true, mode: 0o700 }); const state = json(routerDir, STATE_FILE, 1048576);
    const reviewRequired = !!state?.pendingReleases?.length;
    if (!reviewRequired && !discoveryDue(state, now) && state?.removedPublicReleases?.length) return { status: 'blocked', launched: false, checkedAt: state.checkedAt, reviewRequired: false, reason: 'Public release removal requires native access verification; policy retained' };
    if (!reviewRequired && !discoveryDue(state, now)) return { status: 'current', launched: false, checkedAt: state.checkedAt, reviewRequired: false };
    const last = json(routerDir, 'weekly-cycle-last-attempt.json'); const tried = Date.parse(last?.checkedAt);
    if (['failed', 'qualification-pending'].includes(last?.status) && Number.isFinite(tried) && tried <= now && now - tried < RETRY_MS) return { status: 'blocked', launched: false, reason: 'weekly retry cooldown', checkedAt: state?.checkedAt, reviewRequired };
    const token = claim(routerDir, now); if (!token) return { status: 'busy', launched: false, reviewRequired };
    try { const child = launch(process.execPath, [fileURLToPath(import.meta.url), '--router-dir', routerDir, '--claim-token', token], { detached: true, stdio: 'ignore' });
      child.once?.('error', () => release(routerDir, token)); child.unref(); return { status: 'launched', launched: true, checkedAt: state?.checkedAt, reviewRequired };
    } catch (e) { release(routerDir, token); throw e; }
  } catch (e) { return { status: 'blocked', launched: false, reason: e.message.slice(0, 240), reviewRequired: false }; }
}
export async function runWeeklyCycle({ routerDir = path.join(os.homedir(), '.claude', 'model-router'), now = Date.now(), stage = runCycleStage,
  env = process.env, maxMs = 900000, fetchImpl = fetch, claimToken = null } = {}) {
  if (!path.isAbsolute(routerDir) || !Number.isFinite(maxMs) || maxMs <= 0 || maxMs > 900000) throw new Error('Invalid weekly cycle directory or deadline');
  if (env.MODEL_ROUTER_WEEKLY_ANALYST === '1') return { status: 'recursive-worker', changed: false, reviewExecuted: false };
  fs.mkdirSync(routerDir, { recursive: true, mode: 0o700 }); const token = claimToken ?? claim(routerDir, now);
  if (!token) return { status: 'busy', changed: false, reviewExecuted: false };
  const deadline = Date.now() + maxMs; const cleanEnv = subscriptionOnlyEnv(env);
  const record = { schemaVersion: 1, checkedAt: new Date(now).toISOString(), policyApplied: false, changed: false, reviewExecuted: false, stages: [] };
  const save = (file, value) => writeOwned(routerDir, token, file, value);
  const execute = async (script, stageArgs, cap) => {
    assertOwner(routerDir, token); const remaining = Math.min(cap, deadline - Date.now()); if (remaining <= 0) throw new Error('Weekly cycle deadline exhausted');
    const result = await stage({ script, args: [...stageArgs, '--router-dir', routerDir], timeoutMs: remaining, env: cleanEnv }); assertOwner(routerDir, token); return result;
  };
  try {
    assertOwner(routerDir, token); let state = json(routerDir, STATE_FILE, 1048576);
    const last = json(routerDir, 'weekly-cycle-last-attempt.json'); const tried = Date.parse(last?.checkedAt);
    if (['failed', 'qualification-pending'].includes(last?.status) && Number.isFinite(tried) && tried <= now && now - tried < RETRY_MS) { record.status = 'deferred'; record.reason = 'weekly retry cooldown'; return record; }
    if (discoveryDue(state, now)) {
      let bytes, source;
      // Initial owner-authorized baseline may reuse a recent digest-verified inventory. No semantic review is asserted.
      if (!state) {
        const prior = json(routerDir, 'currency.json', 8388608); const checked = Date.parse(prior?.inventory?.source?.checkedAt);
        if (Number.isFinite(checked) && checked <= now && now - checked < WEEK_MS) {
          source = prior.inventory.source; if (!/^[a-f0-9]{64}$/.test(source.sha256 ?? '') || source.url !== INVENTORY_URL) throw new Error('Initial inventory binding invalid');
          bytes = read(path.join(routerDir, 'evidence', source.sha256 + '.json'), 6291456); if (digest(bytes) !== source.sha256) throw new Error('Initial inventory digest mismatch');
        }
      }
      if (!bytes) {
        const remaining = Math.min(20000, deadline - Date.now()); if (remaining <= 0) throw new Error('Discovery deadline exhausted');
        const response = await fetchImpl(INVENTORY_URL, { signal: AbortSignal.timeout(remaining) }); if (!response.ok) throw new Error('Public inventory fetch failed; release status unknown');
        bytes = await response.text(); if (bytes.length > 6291456) throw new Error('Public inventory exceeds bounded limit');
        source = { url: INVENTORY_URL, checkedAt: new Date(Math.max(now, Date.now())).toISOString(), sha256: digest(bytes) };
      }
      const releases = canonicalTextReleases(bytes); const ids = releases.map((r) => r.id);
      let nativeNewIds = [];
      const profile = json(routerDir, 'profile.json', 131072);
      if (profile?.automaticModelRoutingUpdates === true && Object.values(profile.harnesses ?? {}).some(h => h.available === true && h.subscription === true)) {
        const native = await execute('model-native-catalog.mjs', ['--deadline', String(deadline)], 30000);
        record.stages.push({ component: 'native-catalog', status: native.result.status, exitCode: native.code });
        if (native.code !== 0 || native.result.status !== 'current') throw new Error('Native account model catalog refresh unavailable; approved policy retained');
        nativeNewIds = native.result.newNativeModelIds ?? [];
        if (!Array.isArray(nativeNewIds) || nativeNewIds.some(id => typeof id !== 'string' || !/^(openai|anthropic)\//.test(id))) throw new Error('Invalid native discovery receipt');
      }

      fs.mkdirSync(path.join(routerDir, 'evidence'), { recursive: true, mode: 0o700 });
      save(path.join('evidence', source.sha256 + '.json'), bytes);
      if (!state) {
        state = { schemaVersion: 1, checkedAt: source.checkedAt, source, releases, baselineReleaseIds: ids, pendingReleases: [],
          initialPolicySha256: digest(read(path.join(routerDir, 'routing-policy.json'), 131072)), baselineStatus: 'baseline-established-policy-retained', semanticReviewClaimed: false };
        save(STATE_FILE, state); record.status = state.baselineStatus; record.releaseCount = ids.length; save('weekly-cycle-last-attempt.json', record); return record;
      }
      const baseline = new Set(state.baselineReleaseIds); const removed = (state.releases ?? []).filter((r) => !ids.includes(r.id)).map((r) => r.id);
      const pending = new Map((state.pendingReleases ?? []).map((r) => [r.id, r])); for (const r of releases) if (!baseline.has(r.id)) pending.set(r.id, r);
      for (const id of nativeNewIds) if (!baseline.has(id)) pending.set(id, { id, provider: id.split('/')[0], source: 'native-account-catalog' });
      state = { ...state, checkedAt: source.checkedAt, source, releases, pendingReleases: [...pending.values()], removedPublicReleases: removed };
      save(STATE_FILE, state);
      if (removed.length) { record.publicAvailabilityAlert = { removed, nativeAvailability: 'unknown; public registry removal does not prove subscription revocation', policyRetained: true }; }
    }
    if (state.removedPublicReleases?.length) record.publicAvailabilityAlert = { removed: state.removedPublicReleases, nativeAvailability: 'unknown; public registry removal does not prove subscription revocation', policyRetained: true };
    if (!state.pendingReleases.length) { record.status = record.publicAvailabilityAlert ? 'availability-alert-policy-retained' : 'unchanged'; save('weekly-cycle-last-attempt.json', record); return record; }
    record.reviewRequired = true; record.pendingReleaseIds = state.pendingReleases.map((r) => r.id);
    // Resume qualification from the same bound review; never repeat paid analysis merely because adoption was deferred.
    const releaseIds = state.pendingReleases.map(r => r.id).sort();
    let semantic = state.pendingSemanticReceipt;
    const semanticAt = Date.parse(semantic?.completedAt);
    const semanticFresh = Number.isFinite(semanticAt) && semanticAt <= now && now - semanticAt <= WEEK_MS;
    if (!semanticFresh || JSON.stringify(state.pendingSemanticReleaseIds) !== JSON.stringify(releaseIds)) {
      const collected = await execute('model-currency.mjs', ['--refresh'], 60000);
      record.stages.push({ component: 'metadata', status: collected.result.status, exitCode: collected.code });
      if (collected.code !== 0 || currencyStatus(json(routerDir, 'currency.json', 8388608), Math.max(now, Date.now())).status !== 'current') throw new Error('Full evidence refresh failed; new-release review remains pending');
      const analysisBudget = Math.min(450000, deadline - Date.now() - 180000);
      if (analysisBudget < 1000) throw new Error('Insufficient shared deadline for analysis and independent qualification');
      const analysed = await execute('model-weekly-analyst.mjs', ['--run', '--timeout-ms', String(analysisBudget)], analysisBudget + 2000);
      record.stages.push({ component: 'semantic', status: analysed.result.status, exitCode: analysed.code });
      if (analysed.code !== 0 || analysed.result.status !== 'validated-semantic-report') throw new Error('Native semantic review did not complete; new releases remain pending and policy retained');
      semantic = analysed.result; state.pendingSemanticReceipt = semantic; state.pendingSemanticReleaseIds = releaseIds;
      state.lastCompletedNewReleaseReviewAt = semantic.completedAt; state.semanticReceipt = semantic.runDir;
      save(STATE_FILE, state); record.reviewExecuted = true;
    }
    const qualified = await execute('model-weekly-qualification.mjs', ['--semantic-receipt', path.join(semantic.runDir, 'receipt.json'), '--deadline', String(deadline)], deadline - Date.now());
    record.stages.push({ component: 'qualification', status: qualified.result.status, exitCode: qualified.code });
    record.semanticReceipt = semantic.runDir; record.qualification = qualified.result;
    record.policyApplied = qualified.result.status === 'promoted'; record.changed = record.policyApplied;
    if (qualified.code !== 0 || qualified.result.terminal !== true || !['promoted', 'unchanged', 'rejected'].includes(qualified.result.status)) {
      record.status = 'qualification-pending'; record.reason = qualified.result.reason ?? 'Qualification incomplete; reviewed proposal retained for retry';
      save('weekly-cycle-last-attempt.json', record); return record;
    }
    state.baselineReleaseIds = [...new Set([...state.baselineReleaseIds, ...releaseIds])]; state.pendingReleases = [];
    delete state.pendingSemanticReceipt; delete state.pendingSemanticReleaseIds;
    state.lastQualification = qualified.result; save(STATE_FILE, state); record.status = 'complete';
    save('weekly-cycle-last-attempt.json', record); return record;
  } catch (error) { record.status = 'failed'; record.releaseStatus = 'unknown-or-pending'; record.reason = error.message.slice(0, 240); try { save('weekly-cycle-last-attempt.json', record); } catch { /* superseded cannot write */ } return record;
  } finally { release(routerDir, token); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--router-dir'); const t = process.argv.indexOf('--claim-token'); runWeeklyCycle({ routerDir: i >= 0 ? process.argv[i + 1] : undefined, claimToken: t >= 0 ? process.argv[t + 1] : null }).then((r) => {
    if (r.status !== 'unchanged' || process.argv.includes('--json')) console.log(JSON.stringify(r));
    if (['failed', 'deferred', 'qualification-pending'].includes(r.status)) process.exitCode = 1;
  }).catch(() => { console.error('Weekly cycle could not start'); process.exitCode = 1; });
}
