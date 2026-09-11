#!/usr/bin/env node
/**
 * memory-store-decisions.mjs — PostEdit hook for decision registry (ADR-076)
 *
 * Triggered when consequential files are edited:
 * - ADR files (docs/adr/*.md)
 * - Version files (package.json, .version, VERSION)
 * - Configuration (config/*.json, settings.json)
 *
 * Stores decision with full context:
 * {
 *   type: "adr" | "version" | "dependency" | "config",
 *   reason: "string",
 *   alternatives: ["option B", "option C"],
 *   chosen: "selected option",
 *   source: "commit hash or file path",
 *   timestamp: number,
 *   tags: ["tag1", "tag2"]
 * }
 *
 * FAILURE MODE: Fails silently (advisory) — decision capture never blocks editing
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * extractADRMetadata — parse ADR file to extract title, status, decision text
 */
function extractADRMetadata(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    const metadata = {
      type: 'adr',
      title: '',
      status: '',
      id: '',
      reason: '',
      alternatives: [],
      chosen: '',
    };

    // Extract frontmatter
    let inFrontmatter = false;
    let frontmatterEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('---')) {
        if (inFrontmatter) {
          frontmatterEnd = i;
          break;
        }
        inFrontmatter = true;
      }
    }

    // Parse YAML frontmatter
    const frontmatter = lines.slice(1, frontmatterEnd).join('\n');
    const titleMatch = /^title:\s*(.+)$/m.exec(frontmatter);
    if (titleMatch) metadata.title = titleMatch[1].trim();

    const statusMatch = /^status:\s*(.+)$/m.exec(frontmatter);
    if (statusMatch) metadata.status = statusMatch[1].trim();

    const idMatch = /^id:\s*(.+)$/m.exec(frontmatter);
    if (idMatch) metadata.id = idMatch[1].trim();

    // Extract decision text from markdown heading "## Decision"
    const decisionIdx = lines.findIndex(l => l.startsWith('## Decision'));
    if (decisionIdx >= 0) {
      const decisionLines = [];
      for (let i = decisionIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('##')) break; // Stop at next section
        decisionLines.push(lines[i]);
      }
      metadata.reason = decisionLines.join('\n').trim().substring(0, 200); // First 200 chars
    }

    // Extract alternatives
    const altIdx = lines.findIndex(l => l.startsWith('## Alternatives'));
    if (altIdx >= 0) {
      for (let i = altIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('##')) break;
        if (lines[i].startsWith('###') || lines[i].startsWith('-')) {
          const alt = lines[i].replace(/^[#\-\s]+/, '').trim();
          if (alt && !alt.startsWith('Considered')) {
            metadata.alternatives.push(alt);
          }
        }
      }
    }

    return metadata;
  } catch {
    return { type: 'adr', reason: 'ADR edit', alternatives: [], chosen: 'see file' };
  }
}

/**
 * extractVersionMetadata — parse version file to get version number and reason
 */
function extractVersionMetadata(filePath, fileName) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();

    if (fileName === 'package.json') {
      const json = JSON.parse(content);
      return {
        type: 'version',
        chosen: json.version || 'unknown',
        reason: `Version bump in package.json`,
        alternatives: [],
      };
    }

    if (fileName === 'VERSION' || fileName === '.version') {
      return {
        type: 'version',
        chosen: content.split('\n')[0],
        reason: `Version update`,
        alternatives: [],
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * determineDecisionType — classify file edit as decision type
 */
function determineDecisionType(filePath) {
  const fileName = path.basename(filePath);
  const dir = path.dirname(filePath);

  if (filePath.includes('/adr/') && fileName.endsWith('.md')) {
    return 'adr';
  }
  if (fileName === 'package.json') {
    return 'version';
  }
  if (fileName === 'VERSION' || fileName === '.version') {
    return 'version';
  }
  if (dir.includes('config') && fileName.endsWith('.json')) {
    return 'config';
  }
  if (fileName === 'settings.json' || fileName === '.env') {
    return 'config';
  }

  return null; // Not a consequential edit
}

/**
 * buildDecisionObject — construct decision record for memory store
 */
function buildDecisionObject(filePath, metadata) {
  const now = Date.now();
  const epochStr = Math.floor(now / 1000).toString().padEnd(13, '0').substring(0, 10);
  const seq = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const slug = metadata.title
    ? metadata.title.toLowerCase().replace(/\s+/g, '-').substring(0, 20)
    : path.basename(filePath).replace(/\..+$/, '');

  const key = `decision:${new Date(now).toISOString().split('T')[0]}:${seq}-${slug}`;

  return {
    key,
    type: metadata.type,
    timestamp: now,
    reason: metadata.reason,
    alternatives: metadata.alternatives || [],
    chosen: metadata.chosen,
    source: filePath,
    approval: 'proposed by system',
    reversal_risk: 'low',
    tags: [metadata.type, 'system-captured'],
  };
}

/**
 * storeDecisionViaRuflo — persist decision using `ruflo memory store`
 */
function storeDecisionViaRuflo(memoryDbPath, decision) {
  try {
    const result = spawnSync('ruflo', [
      'memory', 'store',
      '--path', memoryDbPath,
      '-k', decision.key,
      '--value', JSON.stringify(decision),
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
 * Main export — called on file edit
 * Returns: 0 (always succeeds, never blocks editing)
 */
export function captureDecision({
  editedFilePath = process.argv[2],
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    if (!editedFilePath) {
      return 0; // No file provided
    }

    // Classify the edit
    const decisionType = determineDecisionType(editedFilePath);
    if (!decisionType) {
      return 0; // Not a consequential edit
    }

    // Extract metadata based on type
    let metadata;
    if (decisionType === 'adr') {
      metadata = extractADRMetadata(editedFilePath);
    } else if (decisionType === 'version') {
      metadata = extractVersionMetadata(editedFilePath, path.basename(editedFilePath));
      if (!metadata) return 0;
    } else {
      metadata = { type: decisionType, reason: `${decisionType} edit`, alternatives: [], chosen: '' };
    }

    // Build decision object
    const decision = buildDecisionObject(editedFilePath, metadata);

    // Store in memory
    const memoryDbPath = path.join(cwd, '.swarm', 'memory.db');
    if (fs.existsSync(path.dirname(memoryDbPath))) {
      const stored = storeDecisionViaRuflo(memoryDbPath, decision);

      if (process.env.RUVNET_VERBOSE_HOOKS === '1') {
        if (stored) {
          stdout.write(`[decision-store] ${decision.key} captured\n`);
        }
      }
    }

    return 0; // Always succeed
  } catch (err) {
    if (process.env.RUVNET_VERBOSE_HOOKS === '1') {
      stderr.write(`[decision-store debug] ${err.message}\n`);
    }
    return 0; // Fail open
  }
}

// Direct invocation for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(captureDecision());
}
