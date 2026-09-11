#!/usr/bin/env node
/**
 * memory-ensure.mjs — SessionStart hook for ADR-076
 * Auto-recalls last 3 checkpoints from .swarm/memory.db at session start
 *
 * ROLE: Surfaces decision ledger and checkpoint continuity without manual recall
 * TIMELINE: Must complete in <2s (session-start-budget.mjs STAGE_BUDGETS_MS)
 * FAILURE MODE: Fails open (advisory mode) — missing memory never blocks session start
 * MECHANISM: Uses `ruflo memory search` CLI (per Rule 19, CLAUDE.md)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * queryCheckpointsViaRuflo — call `ruflo memory search` with checkpoint query
 * Returns: array of parsed checkpoint objects, last 3 ordered by recency
 */
function queryCheckpointsViaRuflo(memoryDbPath, maxWaitMs = 1800) {
  if (!fs.existsSync(memoryDbPath)) {
    return []; // Silent exit — no memory yet
  }

  try {
    // Use ruflo memory search to find checkpoints
    // Keys are checkpoint-<epochms> format
    const result = spawnSync('ruflo', [
      'memory', 'search',
      '--path', memoryDbPath,
      '--query', 'checkpoint-',
      '--namespace', 'default',
    ], {
      encoding: 'utf8',
      timeout: maxWaitMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
      return [];
    }

    // Parse the output (format varies, but contains key + metadata)
    // For now, collect lines that look like checkpoint keys
    const checkpoints = [];
    if (result.stdout) {
      const lines = result.stdout.split('\n').filter(l => l.includes('checkpoint-'));
      // Extract last 3 unique checkpoints
      const unique = new Set();
      for (const line of lines) {
        if (unique.size >= 3) break;
        const match = line.match(/checkpoint-(\d+)/);
        if (match) {
          unique.add(match[0]);
        }
      }
      // Return as array of key strings (caller formats display)
      return Array.from(unique).slice(0, 3);
    }

    return [];
  } catch {
    return []; // Fail open
  }
}

/**
 * formatCheckpoint — format a checkpoint key for display
 * Example output: "Last: 2026-09-11 14:22:03 | release/4.3.19 | 2 decisions | Next: merge ADRs"
 */
function formatCheckpoint(checkpointKey) {
  try {
    // Extract timestamp from key (checkpoint-<epochms>)
    const match = checkpointKey.match(/checkpoint-(\d+)/);
    if (!match) return checkpointKey;

    const epochMs = parseInt(match[1], 10);
    const timestamp = new Date(epochMs).toISOString()
      .split('T')[0] + ' ' + new Date(epochMs).toISOString()
      .split('T')[1].split('.')[0];

    return `${timestamp} | (checkpoint stored)`;
  } catch {
    return checkpointKey;
  }
}

/**
 * surfaceRecall — emit memory recall to stdout if checkpoints found
 */
function surfaceRecall(memoryPath) {
  const checkpoints = queryCheckpointsViaRuflo(memoryPath);
  if (checkpoints.length === 0) {
    return null; // Silent exit — no checkpoints yet
  }

  const lines = [];
  lines.push(`[MEMORY] ${checkpoints.length} checkpoint(s) found.`);
  checkpoints.forEach((cp, i) => {
    const prefix = i === 0 ? '  Last: ' : '  Prior: ';
    lines.push(prefix + formatCheckpoint(cp));
  });

  return lines.join('\n');
}

/**
 * Main entry point — called by hook-shim.mjs session-start
 * Exported for testing; also runs standalone if invoked directly
 */
export function memoryEnsure({
  cwd = process.cwd(),
  homeDir = os.homedir(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const memoryDbPath = path.join(cwd, '.swarm', 'memory.db');
    const recall = surfaceRecall(memoryDbPath);

    if (recall) {
      stdout.write(recall + '\n');
      return 0;
    }

    return 0; // Silent exit if no memory found
  } catch (err) {
    // Fail open — never let memory ensure block a session start
    if (process.env.RUVNET_VERBOSE_HOOKS === '1') {
      stderr.write(`[memory-ensure debug] ${err.message}\n`);
    }
    return 0;
  }
}

// Direct invocation for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(memoryEnsure());
}
