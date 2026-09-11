#!/usr/bin/env node
/**
 * memory-snapshot-threads.mjs — Captures open GitHub issues/PRs for session continuity
 *
 * Part of ADR-076 memory integration. Runs at SessionEnd to snapshot:
 * - Open issues with title/state/last-comment
 * - Open PRs with title/branch/review-state
 * - Active task queues from PROGRESS.md
 *
 * Stores in .swarm/memory.db as "thread-snapshot-<epochms>"
 * FAILURE MODE: Fails silently (advisory hook) — network/GitHub errors never block session end
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * queryGitHubIssues — fetch open issues via GitHub CLI
 * Requires: gh CLI installed and authenticated
 * Returns: array of { number, title, state, updatedAt }
 */
function queryGitHubIssues() {
  try {
    const result = spawnSync('gh', [
      'issue', 'list',
      '--state', 'open',
      '--limit', '10',
      '--json', 'number,title,state,updatedAt',
    ], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
      return [];
    }

    try {
      return JSON.parse(result.stdout || '[]');
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/**
 * queryGitHubPRs — fetch open pull requests via GitHub CLI
 * Returns: array of { number, title, state, headRefName, isDraft }
 */
function queryGitHubPRs() {
  try {
    const result = spawnSync('gh', [
      'pr', 'list',
      '--state', 'open',
      '--limit', '10',
      '--json', 'number,title,state,headRefName,isDraft,reviewDecision',
    ], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
      return [];
    }

    try {
      return JSON.parse(result.stdout || '[]');
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/**
 * readProgressMD — extract active tasks from PROGRESS.md
 * Looks for lines starting with "- [ ]" (unchecked tasks)
 * Returns: array of task strings
 */
function readProgressMD(cwd) {
  try {
    const progressPath = path.join(cwd, 'PROGRESS.md');
    if (!fs.existsSync(progressPath)) {
      return [];
    }

    const content = fs.readFileSync(progressPath, 'utf8');
    const lines = content.split('\n');
    const tasks = [];

    for (const line of lines) {
      // Match unchecked task: "- [ ] description"
      if (line.match(/^\s*-\s+\[\s*\]\s+/)) {
        const task = line.replace(/^\s*-\s+\[\s*\]\s+/, '').trim();
        if (task) tasks.push(task);
        if (tasks.length >= 5) break; // Limit to top 5 tasks
      }
    }

    return tasks;
  } catch {
    return [];
  }
}

/**
 * buildThreadSnapshot — assemble snapshot object from GitHub/PROGRESS data
 */
function buildThreadSnapshot() {
  const snapshot = {
    timestamp: Date.now(),
    epochMs: Date.now(),
    capturedAt: new Date().toISOString(),
    issues: queryGitHubIssues(),
    prs: queryGitHubPRs(),
    activeTasks: readProgressMD(process.cwd()),
    threadCount: 0,
  };

  snapshot.threadCount = (snapshot.issues?.length || 0) + (snapshot.prs?.length || 0);

  return snapshot;
}

/**
 * storeSnapshotViaRuflo — store thread snapshot using `ruflo memory store`
 */
function storeSnapshotViaRuflo(memoryDbPath, snapshot) {
  const key = `thread-snapshot-${snapshot.epochMs}`;
  const valueJson = JSON.stringify(snapshot);

  try {
    const result = spawnSync('ruflo', [
      'memory', 'store',
      '--path', memoryDbPath,
      '-k', key,
      '--value', valueJson,
    ], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Main export — called by SessionEnd hook
 * Returns: 0 (always succeeds, never blocks)
 */
export function captureThreadSnapshot({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const memoryDbPath = path.join(cwd, '.swarm', 'memory.db');

    // Guard against missing .swarm dir
    if (!fs.existsSync(path.dirname(memoryDbPath))) {
      return 0; // Silent exit
    }

    // Build snapshot
    const snapshot = buildThreadSnapshot();

    // Store via ruflo CLI
    const stored = storeSnapshotViaRuflo(memoryDbPath, snapshot);

    if (process.env.RUVNET_VERBOSE_HOOKS === '1') {
      if (stored) {
        stdout.write(`[thread-snapshot] ${snapshot.threadCount} threads captured\n`);
      }
    }

    return 0; // Always succeed
  } catch (err) {
    if (process.env.RUVNET_VERBOSE_HOOKS === '1') {
      stderr.write(`[thread-snapshot debug] ${err.message}\n`);
    }
    return 0; // Fail open
  }
}

// Direct invocation for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(captureThreadSnapshot());
}
