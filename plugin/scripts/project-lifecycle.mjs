#!/usr/bin/env node
/**
 * project-lifecycle.mjs — Cross-Host AgentDB Project Lifecycle Engine (RuvNet Brain v5.0 / ruPro on-ramp).
 *
 * Maintains ONE continuous, provider-agnostic project lifecycle record in `<project>/.swarm/memory.db`
 * so switching between Antigravity (Gemini), Claude Code, Codex (OpenAI), and Grok mid-build NEVER
 * starts over. Every host writes structured lifecycle checkpoints and reads the latest handoff context
 * at session start.
 *
 * Uses SQLite (`better-sqlite3` via `node:sqlite` or fallback JSONL sidecar if sqlite is unavailable)
 * matching AgentDB's `memory_entries` schema so `ruflo memory search` and `memory-doctor.mjs` see the
 * exact same entries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDirectInvocation } from './entrypoint.mjs';

export const LIFECYCLE_NAMESPACE = 'project-lifecycle';
export const LIFECYCLE_SCHEMA_VERSION = 1;

function detectHost(explicit) {
  if (explicit) return String(explicit).toLowerCase();
  if (process.env.ANTIGRAVITY_SESSION || process.env.AGY_SESSION) return 'antigravity';
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) return 'codex';
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (process.env.GROK_CLI) return 'grok';
  return 'cli';
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

function sidecarPath(cwd) {
  return path.join(path.resolve(cwd), '.swarm', 'lifecycle-checkpoints.jsonl');
}

function dbPath(cwd) {
  return path.join(path.resolve(cwd), '.swarm', 'memory.db');
}

/**
 * Best-effort write into `<project>/.swarm/memory.db` via Node's built-in `node:sqlite` (Node 22/24)
 * when `memory_entries` exists or can be initialized, plus atomic append to the portable JSONL sidecar
 * `.swarm/lifecycle-checkpoints.jsonl` so reads are always O(1) and lock-free.
 */
async function persistToAgentDb(cwd, key, record) {
  const dbFile = dbPath(cwd);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  let sqliteWritten = false;
  let sqliteError = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 3000;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT 'default',
          content TEXT NOT NULL,
          type TEXT DEFAULT 'semantic',
          tags TEXT DEFAULT '[]',
          metadata TEXT DEFAULT '{}',
          created_at INTEGER,
          updated_at INTEGER
        );
      `);
      const now = Date.now();
      const id = `lifecycle:${key}`;
      const content = JSON.stringify(record);
      const tags = JSON.stringify(['lifecycle', record.host, record.event || 'checkpoint']);
      const metadata = JSON.stringify({
        host: record.host,
        branch: record.git?.branch || null,
        sha: record.git?.sha || null,
        schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      });
      const cols = db.prepare('PRAGMA table_info(memory_entries)').all().map((c) => c.name);
      if (cols.includes('id') && cols.includes('key') && cols.includes('namespace') && cols.includes('content')) {
        const hasUpdatedAt = cols.includes('updated_at');
        const hasCreatedAt = cols.includes('created_at');
        const hasMetadata = cols.includes('metadata');
        const hasTags = cols.includes('tags');
        const fields = ['id', 'key', 'namespace', 'content'];
        const vals = [id, key, LIFECYCLE_NAMESPACE, content];
        if (hasTags) { fields.push('tags'); vals.push(tags); }
        if (hasMetadata) { fields.push('metadata'); vals.push(metadata); }
        if (hasCreatedAt) { fields.push('created_at'); vals.push(now); }
        if (hasUpdatedAt) { fields.push('updated_at'); vals.push(now); }
        const placeholders = fields.map(() => '?').join(', ');
        db.prepare(`INSERT OR REPLACE INTO memory_entries (${fields.join(', ')}) VALUES (${placeholders})`).run(...vals);
        sqliteWritten = true;
      }
    } finally {
      db.close();
    }
  } catch (e) {
    sqliteError = String(e?.message || e);
  }

  // Always write to the lock-free JSONL sidecar so multi-host handoffs never block on SQLite WAL locks
  const sc = sidecarPath(cwd);
  fs.appendFileSync(sc, `${JSON.stringify(record)}\n`, 'utf8');
  return { sqliteWritten, sqliteError, dbFile, sidecar: sc };
}

/**
 * Record a cross-host project lifecycle checkpoint.
 */
export async function recordLifecycleCheckpoint({
  cwd = process.cwd(),
  host,
  event = 'checkpoint',
  summary = '',
  decisions = [],
  nextSteps = [],
  architecture = '',
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
  const stored = await persistToAgentDb(cwd, key, record);
  return { ok: true, key, record, ...stored };
}

/**
 * Read the continuous project lifecycle history across all AI hosts that have worked on `cwd`.
 */
export function readLifecycleState(cwd = process.cwd(), { limit = 10 } = {}) {
  const abs = path.resolve(cwd);
  const identity = projectIdentity(abs);
  const git = gitSnapshot(abs);
  const sc = sidecarPath(abs);
  const dbFile = dbPath(abs);
  const checkpoints = [];

  if (fs.existsSync(sc)) {
    try {
      const lines = fs.readFileSync(sc, 'utf8').split('\n').filter(Boolean);
      for (const l of lines.slice(-Math.max(1, limit * 2))) {
        try { checkpoints.push(JSON.parse(l)); } catch { /* skip malformed line */ }
      }
    } catch { /* unreadable sidecar */ }
  }

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
