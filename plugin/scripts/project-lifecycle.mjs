#!/usr/bin/env node
/**
 * project-lifecycle.mjs — Cross-Host AgentDB Project Lifecycle Engine (RuvNet Brain v5.0 / ruPro on-ramp).
 *
 * Maintains ONE continuous, provider-agnostic project lifecycle record in `<project>/.swarm/memory.db`
 * via the ONE global `ruflo memory store` CLI (zero hand-rolled SQLite writes, zero unbounded JSONL
 * journals) so switching between Antigravity (Gemini), Claude Code, Codex (OpenAI), and Grok mid-build
 * NEVER starts over.
 *
 * Bounded snapshot file `.swarm/lifecycle-latest.json` (max MAX_CHECKPOINTS = 20 entries, overwritten
 * atomically) provides O(1) synchronous handoff reads at SessionStart without ever spawning a daemon.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDirectInvocation } from './entrypoint.mjs';

export const LIFECYCLE_NAMESPACE = 'project-lifecycle';
export const LIFECYCLE_SCHEMA_VERSION = 1;
export const MAX_CHECKPOINTS = 20;

function detectHost(explicit) {
  if (explicit) return String(explicit).toLowerCase();
  if (process.env.ANTIGRAVITY_SESSION || process.env.AGY_SESSION) return 'antigravity';
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) return 'codex';
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (process.env.GROK_CLI) return 'grok';
  return 'cli';
}

function resolveRufloBin() {
  const globalBin = path.join(os.homedir(), '.npm-global', 'bin', 'ruflo');
  if (fs.existsSync(globalBin)) return globalBin;
  return null;
}

function gitSnapshot(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = run(['rev-parse', '--short', 'HEAD']);
  const status = run(['status', '--short']);
  const recentCommits = run(['log', '--oneline', '-5']);
  const dirtyFiles = status
    ? status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 25)
    : [];
  return {
    isGit: Boolean(branch || sha),
    branch: branch || null,
    sha: sha || null,
    dirtyCount: dirtyFiles.length,
    dirtyFiles,
    recentCommits: recentCommits ? recentCommits.split('\n').filter(Boolean) : [],
  };
}

function projectIdentity(cwd) {
  const abs = path.resolve(cwd);
  let name = path.basename(abs);
  let version = null;
  let description = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    if (pkg.name) name = pkg.name;
    if (pkg.version) version = pkg.version;
    if (pkg.description) description = pkg.description;
  } catch { /* non-node project */ }
  return { name, version, description, root: abs };
}

function snapshotFilePath(cwd) {
  return path.join(path.resolve(cwd), '.swarm', 'lifecycle-latest.json');
}

function agentDbPath(cwd) {
  return path.join(path.resolve(cwd), '.swarm', 'memory.db');
}

function readSnapshotRecords(cwd) {
  const f = snapshotFilePath(cwd);
  if (!fs.existsSync(f)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(j?.checkpoints) ? j.checkpoints : [];
  } catch {
    return [];
  }
}

function saveBoundedSnapshot(cwd, record) {
  const f = snapshotFilePath(cwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const existing = readSnapshotRecords(cwd);
  const next = [...existing, record].slice(-MAX_CHECKPOINTS);
  const payload = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    updatedAt: record.ts,
    checkpoints: next,
  };
  fs.writeFileSync(f, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return f;
}

/**
 * Store the checkpoint into `<project>/.swarm/memory.db` using the real `ruflo memory store` CLI
 * (never hand-rolling SQLite tables), and update the bounded `.swarm/lifecycle-latest.json` snapshot.
 */
export async function recordLifecycleCheckpoint({
  cwd = process.cwd(),
  host,
  event = 'checkpoint',
  summary = '',
  decisions = [],
  nextSteps = [],
  architecture = '',
  skipRuflo = process.env.RUVNET_LIFECYCLE_SKIP_RUFLO === '1',
} = {}) {
  const resolvedHost = detectHost(host);
  const identity = projectIdentity(cwd);
  const git = gitSnapshot(cwd);
  const now = new Date().toISOString();
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ name: identity.name, sha: git.sha, dirty: git.dirtyFiles, summary, decisions, nextSteps }))
    .digest('hex')
    .slice(0, 12);

  const record = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    ts: now,
    host: resolvedHost,
    event,
    project: identity.name,
    version: identity.version,
    summary: String(summary || '').trim(),
    architecture: String(architecture || '').trim(),
    decisions: Array.isArray(decisions) ? decisions.filter(Boolean).slice(0, 12) : [],
    nextSteps: Array.isArray(nextSteps) ? nextSteps.filter(Boolean).slice(0, 12) : [],
    git,
    digest,
  };

  const key = 'project-state-current';
  const dbFile = agentDbPath(cwd);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  let rufloStored = false;
  let rufloError = null;
  const rufloBin = skipRuflo ? null : resolveRufloBin();
  if (rufloBin) {
    try {
      const value = JSON.stringify(record);
      const r = spawnSync(
        rufloBin,
        ['memory', 'store', '--key', key, '--value', value, '--namespace', LIFECYCLE_NAMESPACE, '--path', dbFile],
        { cwd: path.resolve(cwd), encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      rufloStored = r.status === 0;
      if (!rufloStored) rufloError = (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200);
    } catch (e) {
      rufloError = String(e?.message || e).slice(0, 200);
    }
  }

  const snapshot = saveBoundedSnapshot(cwd, record);
  return { ok: true, key, record, rufloStored, rufloError, dbFile, snapshot };
}

/**
 * Read the continuous project lifecycle history across all AI hosts that have worked on `cwd`.
 */
export function readLifecycleState(cwd = process.cwd(), { limit = 10 } = {}) {
  const abs = path.resolve(cwd);
  const identity = projectIdentity(abs);
  const git = gitSnapshot(abs);
  const dbFile = agentDbPath(abs);
  const checkpoints = readSnapshotRecords(abs);

  const hostsSeen = [...new Set(checkpoints.map((c) => c.host).filter(Boolean))];
  const latest = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
  const recentDecisions = [];
  for (const cp of [...checkpoints].reverse()) {
    for (const d of cp.decisions || []) {
      if (!recentDecisions.includes(d)) recentDecisions.push(d);
      if (recentDecisions.length >= 8) break;
    }
    if (recentDecisions.length >= 8) break;
  }

  return {
    ok: true,
    project: identity.name,
    version: identity.version,
    root: abs,
    dbPresent: fs.existsSync(dbFile),
    dbPath: dbFile.replace(os.homedir(), '~'),
    checkpointCount: checkpoints.length,
    hostsSeen,
    crossHostReady: fs.existsSync(dbFile) || checkpoints.length > 0,
    latest,
    recentDecisions,
    recentCheckpoints: checkpoints.slice(-limit).reverse(),
    currentGit: git,
  };
}

/**
 * Format a compact, provider-agnostic handoff brief for SessionStart / PreInvocation injection.
 */
export function formatHandoffBrief(state) {
  if (!state || !state.latest) return '';
  const l = state.latest;
  const lines = [
    `[RuvNet Brain — Cross-Host Project Lifecycle (${state.project})]`,
    `Last active host: ${l.host} at ${l.ts} (branch: ${l.git?.branch || 'n/a'} @ ${l.git?.sha || 'n/a'}; hosts seen: ${state.hostsSeen.join(', ') || l.host}).`,
  ];
  if (l.summary) lines.push(`Latest state: ${l.summary}`);
  if (state.recentDecisions.length) lines.push(`Key decisions: ${state.recentDecisions.slice(0, 4).join(' | ')}`);
  if (l.nextSteps?.length) lines.push(`Open next steps: ${l.nextSteps.slice(0, 3).join(' | ')}`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d = '') => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const cwd = get('--dir', process.cwd());

  if (args.includes('--record')) {
    const res = await recordLifecycleCheckpoint({
      cwd,
      host: get('--host', ''),
      event: get('--event', 'checkpoint'),
      summary: get('--summary', ''),
      decisions: get('--decisions', '').split('||').map((s) => s.trim()).filter(Boolean),
      nextSteps: get('--next', '').split('||').map((s) => s.trim()).filter(Boolean),
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  const state = readLifecycleState(cwd);
  if (args.includes('--brief')) {
    const brief = formatHandoffBrief(state);
    if (brief) process.stdout.write(`${brief}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
