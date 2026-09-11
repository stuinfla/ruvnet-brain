#!/usr/bin/env node
// plugin/mcp/decisions-endpoint.mjs — Retrieve recent project decisions from memory store.
//
// This module queries the project's `.swarm/memory.db` for entries with keys matching the
// 'decision-*' pattern, formats them for display, and provides sorting/filtering utilities.
//
// Used by: session-start-core.mjs (ProjectStart decision surface)

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const DATABASE_PATH_FALLBACK = '.swarm/memory.db';

/**
 * Query decisions from the AgentDB memory store using sqlite3 CLI.
 * @param {Object} opts - Configuration
 * @param {string} opts.dbPath - Path to .swarm/memory.db (defaults to cwd-relative)
 * @param {number} opts.limit - Max decisions to return (default: 5)
 * @param {boolean} opts.deduplicate - Deduplicate by key (default: true)
 * @returns {Promise<Array>} Array of decisions [{timestamp, key, adrs_linked, type, outcome}]
 */
export async function getRecentDecisions({
  dbPath = DATABASE_PATH_FALLBACK,
  limit = 5,
  deduplicate = true,
} = {}) {
  // Resolve path (support both absolute and relative)
  const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);

  // Check if database exists
  if (!fs.existsSync(resolvedPath)) {
    return []; // Database doesn't exist — normal for fresh projects
  }

  try {
    const sql = `
      SELECT
        key,
        content,
        created_at as timestamp,
        metadata
      FROM memory_entries
      WHERE key LIKE 'decision-%' AND status = 'active'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    // Execute via sqlite3 CLI; escape path for shell safety
    const escapedPath = resolvedPath.replace(/'/g, "'\\''");
    const cmd = `sqlite3 '${escapedPath}' "${sql.replace(/"/g, '\\"')}"`;

    let output = '';
    try {
      output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      // sqlite3 command failed (DB locked, corrupted, etc.) — return empty
      if (err.code === 127) throw new Error('sqlite3 CLI not found'); // Command not found
      return [];
    }

    if (!output.trim()) return [];

    // Parse results: key|content|timestamp|metadata (pipe-separated by sqlite3)
    const decisions = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, content, timestampStr, metadataStr] = line.split('|');
        if (!key) return null;

        let metadata = {};
        try {
          metadata = metadataStr ? JSON.parse(metadataStr) : {};
        } catch {
          // Metadata is optional
        }

        const timestamp = parseInt(timestampStr, 10);
        return {
          timestamp: Math.floor(timestamp / 1000), // Convert ms to seconds (epoch)
          key,
          adrs_linked: metadata.adrs_linked || [],
          type: metadata.type || 'general',
          outcome: extractOutcome(content),
        };
      })
      .filter(Boolean);

    // Deduplicate by key if requested (keep first occurrence by recency)
    const dedup = deduplicate
      ? Array.from(new Map(decisions.map((d) => [d.key, d])).values())
      : decisions;

    return dedup;
  } catch (error) {
    if (error.message?.includes('sqlite3 CLI not found')) {
      throw error; // Rethrow this specific error
    }
    // Other errors (e.g., database corruption) — return empty silently
    return [];
  }
}

/**
 * Extract a short outcome summary from decision content.
 * @param {string} content - Full decision content
 * @returns {string} First 120 characters or full content if shorter
 */
function extractOutcome(content) {
  if (!content) return '';
  const trimmed = String(content).trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

/**
 * Format decisions for console display.
 * @param {Array} decisions - Decision objects from getRecentDecisions()
 * @returns {string} Formatted multi-line string for console
 */
export function formatDecisionsForConsole(decisions) {
  if (!decisions || decisions.length === 0) {
    return '';
  }

  const lines = ['Recent decisions in this project:'];
  decisions.forEach((d) => {
    const ts = new Date(d.timestamp * 1000);
    const dateStr = ts.toISOString().slice(0, 10); // YYYY-MM-DD
    const typeTag = d.type && d.type !== 'general' ? ` [${d.type}]` : '';
    const adrTag = d.adrs_linked && d.adrs_linked.length > 0
      ? ` → ${d.adrs_linked.slice(0, 2).join(', ')}`
      : '';

    lines.push(`  ${dateStr}${typeTag}${adrTag}: ${d.outcome}`);
  });

  return lines.join('\n');
}

/**
 * Check if a recent decision matches context keywords.
 * Simple keyword matching for hint generation.
 * @param {Array} decisions - Decision objects
 * @param {Array} keywords - Keywords to match (["refactor", "performance"])
 * @param {number} maxAgeDays - Only match decisions from last N days (default: 7)
 * @returns {Array} Matching decisions
 */
export function findMatchingDecisions(decisions, keywords = [], maxAgeDays = 7) {
  if (!keywords || keywords.length === 0) return [];

  const cutoff = Date.now() / 1000 - (maxAgeDays * 86400);
  const keywordLower = keywords.map((k) => String(k).toLowerCase());

  return decisions.filter((d) => {
    if (d.timestamp < cutoff) return false; // Outside age window

    const contentLower = d.outcome.toLowerCase();
    return keywordLower.some((kw) => contentLower.includes(kw));
  });
}

// Test exports for unit tests
export const __testHelpers = {
  extractOutcome,
};
