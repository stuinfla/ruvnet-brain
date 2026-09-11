#!/usr/bin/env node
/**
 * memory-ensure.mjs — Background session memory recall (non-blocking SessionStart)
 *
 * Spawned as a background task from session-start-core.mjs with NO await.
 * Recalls the 3 most recent project-state checkpoints from AgentDB memory.
 * Results are injected into the next prompt via server.mjs state attachment.
 *
 * PERFORMANCE CONTRACT: completes in <2s even with 10K+ memory entries.
 * Uses indexed SQL queries and minimal object creation.
 *
 * ADR-077: SessionStart deadline inversion fix — parallelization strategy.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DATABASE_PATH = '.swarm/memory.db';
const TIMEOUT_MS = 1500; // Hard timeout: 1.5s (report-and-exit, never hang)

/**
 * Recall the 3 most recent project-state checkpoints from memory.
 * @param {string} cwd - Project working directory (where .swarm/memory.db lives)
 * @param {number} timeoutMs - Max time to wait (default 1500ms)
 * @returns {Promise<{context: string, checkpoints: Array} | null>}
 *   Returns formatted checkpoint context or null on error.
 */
export async function recallProjectState({ cwd = process.cwd(), timeoutMs = TIMEOUT_MS } = {}) {
  const dbPath = path.resolve(cwd, DATABASE_PATH);

  // Check if database exists before attempting query
  if (!fs.existsSync(dbPath)) {
    return null; // No memory database — normal for fresh projects
  }

  try {
    // Query with strict timeout: if sqlite3 takes >1.5s, bail
    const sql = `
      SELECT
        key,
        content,
        created_at as timestamp,
        metadata
      FROM memory_entries
      WHERE key LIKE 'project-state-current%' AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 3
    `;

    const escapedPath = dbPath.replace(/'/g, "'\\''");
    const cmd = `sqlite3 '${escapedPath}' "${sql.replace(/"/g, '\\"')}"`;

    let output = '';
    try {
      // execSync with timeout: if query takes >1.5s, throw ETIMEDOUT
      output = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: timeoutMs,
        maxBuffer: 256 * 1024, // 256KB max output
      });
    } catch (err) {
      if (err.code === 'ETIMEDOUT') {
        // Timeout is not an error for this background task — just return nothing
        return null;
      }
      if (err.code === 127) {
        // sqlite3 not found — this is a real error but non-fatal for the session
        console.error(`[memory-ensure] sqlite3 CLI not found`);
      }
      // Database lock, corruption, or other error — return empty
      return null;
    }

    if (!output.trim()) {
      return null; // No checkpoints found
    }

    // Parse results: key|content|timestamp|metadata (pipe-separated by sqlite3)
    const checkpoints = [];
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const [key, content, timestampStr, metadataStr] = line.split('|');
      if (!key) continue;

      let parsed = null;
      try {
        parsed = content ? JSON.parse(content) : {};
      } catch {
        // Corrupted content — skip this checkpoint
        continue;
      }

      const timestamp = parseInt(timestampStr, 10);
      checkpoints.push({
        key,
        timestamp: new Date(timestamp).toISOString().slice(0, 10),
        branch: parsed.branch || 'unknown',
        nextWork: parsed.nextWork || '',
        openIssues: (parsed.openIssues || []).length,
        completionStatus: parsed.completionStatus || 'unknown',
      });
    }

    if (checkpoints.length === 0) {
      return null;
    }

    // Format for session context injection
    const contextLines = [
      '[RuvNet Brain — Project continuity: last 3 checkpoints]',
      ...checkpoints.map(
        (cp) => `  ${cp.timestamp} ${cp.branch}: ${cp.completionStatus} — ${cp.nextWork || '(no notes)'}`,
      ),
    ];

    return {
      context: contextLines.join('\n'),
      checkpoints,
    };
  } catch (error) {
    // Non-blocking: errors are logged but never thrown from a background task
    if (process.env.RUVNET_SESSION_TRACE === '1') {
      console.error(`[memory-ensure] recall failed: ${error.message}`);
    }
    return null;
  }
}

/**
 * Main entry point when invoked directly.
 * Spawned as a background process from session-start-core.mjs.
 * Writes result to stdout (one JSON line) and exits with code 0.
 */
async function main() {
  const cwd = process.argv[2] || process.cwd();
  try {
    const result = await recallProjectState({ cwd, timeoutMs: TIMEOUT_MS });
    if (result) {
      // Write to stdout for parent to capture
      process.stdout.write(JSON.stringify({
        ok: true,
        context: result.context,
        checkpoints: result.checkpoints,
        elapsedMs: 0, // Timing is outside this process
      }) + '\n');
    }
  } catch (error) {
    // Non-fatal: parent doesn't wait for this anyway
    if (process.env.RUVNET_SESSION_TRACE === '1') {
      console.error(`[memory-ensure] error: ${error.message}`);
    }
  } finally {
    process.exit(0); // Always exit, never hang
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.exit(0);
  });
}
