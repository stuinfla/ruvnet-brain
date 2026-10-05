#!/usr/bin/env node
// DISTINCT-FROM: scripts/model-router-catalog.mjs — per-user evidence currency, never candidate/default mutation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildWeeklyAssessment } from './model-weekly-assessment.mjs';
import { fileURLToPath } from 'node:url';
import { WEEK_MS, digest, parseInventory, parseArtificialAnalysis, parseCodingAgentEvidence, currencyStatus } from './model-currency-evidence.mjs';

export const DEFAULT_ROUTER_DIR = path.join(os.homedir(), '.claude', 'model-router');
export const AA_URLS = [
  'https://artificialanalysis.ai/models/comparisons',
  'https://artificialanalysis.ai/models/comparisons/claude-fable-5-1-medium-vs-claude-opus-5-medium',
  'https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-sol-vs-claude-sonnet-5-5',
  'https://artificialanalysis.ai/models/releases/comparisons/gpt-6-luna-vs-gpt-6-astra',
  'https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-gpt-6-astra',
];
export const OFFICIAL_SOURCES = [
  { provider: 'openai', url: 'https://developers.openai.com/api/docs/models' },
  { provider: 'anthropic', url: 'https://platform.claude.com/docs/en/models/overview' },
];
export const AGENT_SOURCE_URLS = [
  'https://artificialanalysis.ai/agents/coding-agents',
  'https://artificialanalysis.ai/methodology/coding-agents-benchmarking',
];
export const CODING_BENCHMARK_SOURCES = [
  { suite: 'vulcanbench', url: 'https://vulcanbench.com/' },
  { suite: 'vulcanbench-swe-v4', url: 'https://vulcanbench.com/benchmarks/swe-v4-gpt61-sol-v318.html' },
  { suite: 'terminal-bench', url: 'https://www.tbench.ai/' },
  { suite: 'swe-bench', url: 'https://www.swebench.com/' },
];
const INVENTORY_URL = 'https://openrouter.ai/api/v1/models';
const LOCK_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const SELF = fileURLToPath(import.meta.url);
function readRecord(routerDir) {
  try {
    const target = path.join(routerDir, 'currency.json');
    if (fs.statSync(target).size > 8 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch { return null; }
}
export function readCurrencyStatus({ routerDir = DEFAULT_ROUTER_DIR, now = Date.now() } = {}) {
  return currencyStatus(readRecord(routerDir), now);
}
function atomicWrite(target, bytes, beforeCommit = () => {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    beforeCommit();
    fs.renameSync(tmp, target);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
// This guard is held only for synchronous filesystem transactions, never during fetches.
// Never reap it: a crash inside this tiny transaction must fail closed rather than overlap writers.
function transaction(routerDir, operation) {
  fs.mkdirSync(routerDir, { recursive: true, mode: 0o700 });
  const guard = path.join(routerDir, 'currency-mutation.lock');
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try { return operation(); } finally { fs.rmdirSync(guard); }
}
function ownerPath(routerDir) { return path.join(routerDir, 'currency-refresh-owner.json'); }
function readOwner(routerDir) {
  try { return JSON.parse(fs.readFileSync(ownerPath(routerDir), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function claim(routerDir, now) {
  return transaction(routerDir, () => {
    const owner = readOwner(routerDir);
    if (owner && (!Number.isFinite(owner.claimedAt) || now - owner.claimedAt <= LOCK_MS)) return null;
    const next = { token: randomUUID(), claimedAt: now };
    atomicWrite(ownerPath(routerDir), JSON.stringify(next));
    return next.token;
  });
}
function release(routerDir, token) {
  return transaction(routerDir, () => {
    if (readOwner(routerDir)?.token !== token) return false;
    fs.unlinkSync(ownerPath(routerDir)); return true;
  });
}
function fencedWrite(routerDir, token, target, bytes) {
  const written = transaction(routerDir, () => {
    if (readOwner(routerDir)?.token !== token) throw new Error('refresh superseded: ownership token changed');
    atomicWrite(target, bytes, () => {
      if (readOwner(routerDir)?.token !== token) throw new Error('refresh superseded before commit');
    }); return true;
  });
  if (!written) throw new Error('refresh transaction busy; no write committed');
}

/** Prompt path: local bounded read and one detached worker; never await a network request. */
export function maybeLaunchCurrencyRefresh({ routerDir = DEFAULT_ROUTER_DIR, now = Date.now(), launch = spawn } = {}) {
  const record = readRecord(routerDir); const status = currencyStatus(record, now);
  if (status.status === 'current') return { ...status, launched: false };
  const attempted = Date.parse(record?.lastAttempt?.checkedAt);
  if (Number.isFinite(attempted) && attempted <= now && now - attempted < RETRY_MS) return { ...status, launched: false, deferred: 'retry cooldown' };
  const lock = claim(routerDir, now);
  if (!lock) return { ...status, launched: false, deferred: fs.existsSync(path.join(routerDir, 'currency-mutation.lock'))
    ? 'refresh transaction blocked; inspect mutation guard before recovery' : 'refresh already running' };
  try {
    const child = launch(process.execPath, [SELF, '--refresh', '--claim-token', lock, '--router-dir', routerDir], { detached: true, stdio: 'ignore' });
    child.once?.('error', () => release(routerDir, lock));
    child.unref();
    return { ...status, launched: true };
  } catch (error) { release(routerDir, lock); return { ...status, launched: false, errors: [error.message] }; }
}

export async function refreshModelCurrency({ routerDir = DEFAULT_ROUTER_DIR, now = Date.now(), fetchImpl = fetch,
  identityBindings, aaUrls = AA_URLS, officialSources = OFFICIAL_SOURCES, agentSourceUrls = AGENT_SOURCE_URLS, codingBenchmarkSources = CODING_BENCHMARK_SOURCES, claimToken = null } = {}) {
  const lock = claimToken ?? claim(routerDir, now);
  if (!lock) return { action: 'busy', status: 'stale', reason: 'refresh ownership or transaction guard unavailable' };
  try {
    const prior = readRecord(routerDir) ?? { schemaVersion: 1 };
    const checkedAt = new Date(now).toISOString(); const errors = [];
    let bindings = identityBindings;
    if (!bindings) {
      try { bindings = JSON.parse(fs.readFileSync(path.join(routerDir, 'identity-bindings.json'), 'utf8')); }
      catch { bindings = {}; }
    }
    const collect = async (url) => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.text();
      if (bytes.length > 6 * 1024 * 1024) throw new Error('source exceeds 6 MiB limit');
      const source = { url, checkedAt, sha256: digest(bytes) };
      fencedWrite(routerDir, lock, path.join(routerDir, 'evidence', `${source.sha256}.${url === INVENTORY_URL ? 'json' : 'html'}`), bytes);
      return { source, bytes };
    };
    const results = await Promise.allSettled([INVENTORY_URL, ...aaUrls, ...officialSources.map((s) => s.url), ...agentSourceUrls, ...codingBenchmarkSources.map((s) => s.url)].map(collect));
    let inventory = prior.inventory; let evaluations = prior.evaluations;
    if (results[0].status === 'fulfilled') {
      try { inventory = parseInventory(results[0].value.bytes, results[0].value.source); }
      catch (error) { errors.push(`inventory: ${error.message}`); }
    } else errors.push(`inventory: ${results[0].reason.message}`);
    const parsed = [];
    for (let i = 1; i <= aaUrls.length; i++) {
      const result = results[i];
      try {
        if (result.status !== 'fulfilled') throw result.reason;
        parsed.push(parseArtificialAnalysis(result.value.bytes, { ...result.value.source, identityBindings: bindings }));
      } catch (error) { errors.push(`evaluations ${aaUrls[i - 1]}: ${error.message}`); }
    }
    // All requested pages must parse before certifying a new matrix; partial pages are evidence only.
    if (parsed.length === aaUrls.length && parsed.length > 0) {
      const records = new Map();
      for (const page of parsed) for (const record of page.records) records.set(record.sourceModelId, record);
      evaluations = { checkedAt, sources: parsed.map((p) => p.source), records: [...records.values()],
        selectionQualified: false, limitation: 'Independent benchmark evidence; native access and supported effort require separate verification. Arena is not collected.' };
    }
    let official = prior.officialSources;
    const publicDocs = [];
    for (let i = 0; i < officialSources.length; i++) {
      const result = results[1 + aaUrls.length + i];
      if (result.status === 'fulfilled') publicDocs.push({ ...result.value.source, provider: officialSources[i].provider,
        scope: 'official public/API documentation; not native subscription access', semanticallyQualified: false });
      else errors.push(`official ${officialSources[i].url}: ${result.reason.message}`);
    }
    if (publicDocs.length === officialSources.length) official = { checkedAt, sources: publicDocs };
    let agents = prior.agentSources;
    if (agentSourceUrls.length) {
      const agentResults = results.slice(1 + aaUrls.length + officialSources.length, 1 + aaUrls.length + officialSources.length + agentSourceUrls.length);
      try {
        if (agentResults.length !== 2) throw new Error('coding-agent source and methodology pair required');
        for (const result of agentResults) if (result.status !== 'fulfilled') throw result.reason;
        const parsedAgents = parseCodingAgentEvidence(agentResults[0].value.bytes, agentResults[1].value.bytes,
          { ...agentResults[0].value.source, identityBindings: bindings });
        agents = { checkedAt, sources: agentResults.map((r) => r.value.source), ...parsedAgents };
      } catch (error) { errors.push(`coding agents: ${error.message}`); }
    }
    const additional = [];
    for (let i = 0; i < codingBenchmarkSources.length; i++) {
      const result = results[1 + aaUrls.length + officialSources.length + agentSourceUrls.length + i];
      if (result.status === 'fulfilled' && result.value.bytes.trim().length >= 100) {
        additional.push({ ...result.value.source, suite: codingBenchmarkSources[i].suite,
          scope: 'raw source archive; independent suite, score parsing and semantic qualification not implemented' });
      } else errors.push(`coding benchmark ${codingBenchmarkSources[i].url}: ${result.status === 'rejected' ? result.reason.message : 'empty or truncated source'}`);
    }
    if (additional.length === codingBenchmarkSources.length && agents && agents !== prior.agentSources) agents = { ...agents, additionalSources: additional };
    else if (additional.length !== codingBenchmarkSources.length) agents = prior.agentSources;
    const instructionPath = path.join(routerDir, 'weekly-analyst-instruction.md');
    let instruction; let instructionSource = 'packaged-fallback';
    try {
      const fd = fs.openSync(instructionPath, 'r');
      try {
        const buffer = Buffer.alloc(128 * 1024 + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > 128 * 1024) throw new Error('effective weekly instruction exceeds 128 KiB');
        instruction = buffer.subarray(0, size).toString('utf8');
        if (!instruction.trim()) throw new Error('effective weekly instruction is empty');
        instructionSource = 'effective-per-user-file';
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code !== 'ENOENT') { errors.push(`instruction: ${error.message}`); instruction = undefined; instructionSource = 'fallback-after-read-error'; }
    }
    const next = { schemaVersion: 1, maxAgeMs: WEEK_MS, inventory, evaluations, officialSources: official, agentSources: agents,
      lastAttempt: { checkedAt, status: errors.length ? (inventory === prior.inventory && evaluations === prior.evaluations ? 'failed' : 'partial') : 'complete', errors } };
    let priorPolicyBytes = null; let policy = null;
    try { priorPolicyBytes = fs.readFileSync(path.join(routerDir, 'routing-policy.json'), 'utf8'); policy = JSON.parse(priorPolicyBytes); }
    catch { /* no policy: report missing allocation, never synthesize one */ }
    const assessment = buildWeeklyAssessment({ currency: next, policy, priorPolicyBytes, now, previousAssessment: prior.assessment, instruction, instructionSource });
    const assessmentDir = path.join(routerDir, 'assessments', `${checkedAt.replaceAll(':', '-')}-${lock}`);
    for (const [name, bytes] of [['report.json', JSON.stringify(assessment.report, null, 2)],
      ['proposal.json', JSON.stringify(assessment.proposal, null, 2)], ['report.md', assessment.markdown],
      ['instruction.md', assessment.instruction], ['prior-policy.json', priorPolicyBytes ?? 'null']]) {
      fencedWrite(routerDir, lock, path.join(assessmentDir, name), bytes);
    }
    if (!fs.existsSync(instructionPath)) fencedWrite(routerDir, lock, instructionPath, assessment.instruction);
    next.assessment = { instructionPath, instructionSha256: assessment.report.instructionSha256, instructionSource, checkedAt, signature: assessment.report.signature, reportPath: path.join(assessmentDir, 'report.json'),
      proposalPath: path.join(assessmentDir, 'proposal.json'), status: 'complete-unqualified', analystExecuted: false,
      notification: assessment.report.notification };
    fencedWrite(routerDir, lock, path.join(routerDir, 'currency.json'), `${JSON.stringify(next, null, 2)}\n`);
    return { action: 'refreshed', ...currencyStatus(next, now), lastAttempt: next.lastAttempt };
  } finally { release(routerDir, lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const dirIndex = process.argv.indexOf('--router-dir');
  const routerDir = dirIndex >= 0 ? process.argv[dirIndex + 1] : DEFAULT_ROUTER_DIR;
  if (!routerDir || !path.isAbsolute(routerDir)) throw new Error('--router-dir must be absolute');
  if (process.argv.includes('--refresh')) {
    refreshModelCurrency({ routerDir, claimToken: process.argv.includes('--claim-token') ? process.argv[process.argv.indexOf('--claim-token') + 1] : null }).then((result) => {
      console.log(JSON.stringify(result)); if (result.status === 'stale') process.exitCode = 1;
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } else console.log(JSON.stringify(process.argv.includes('--catch-up') ? maybeLaunchCurrencyRefresh({ routerDir }) : readCurrencyStatus({ routerDir })));
}
