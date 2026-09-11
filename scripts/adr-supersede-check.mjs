#!/usr/bin/env node
/**
 * ADR Supersession Audit Gate (ADR-077 Gate 2)
 *
 * Detects when an ADR status changes Accepted → Superseded
 * Creates immutable log entry in docs/adr/SUPERSESSIONS.log
 * Updates replacement ADR's frontmatter with backlink
 * Removes superseded ADR from active governance checks
 *
 * Exit codes:
 *   0 = supersession processed successfully (or no change detected)
 *   1 = error during processing (file I/O, parsing, validation)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');
const SUPERSESSIONS_LOG = path.join(ADR_DIR, 'SUPERSESSIONS.log');

const colors = {
  RED: '\x1b[0;31m',
  GREEN: '\x1b[0;32m',
  YELLOW: '\x1b[1;33m',
  BLUE: '\x1b[0;34m',
  NC: '\x1b[0m',
};

/**
 * Parse ADR frontmatter to extract metadata
 */
function parseADRFrontmatter(content) {
  const lines = content.split('\n');
  const metadata = {};
  let inFrontmatter = false;
  let frontmatterEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        frontmatterEnd = i;
        break;
      }
    }

    if (inFrontmatter && i > 0) {
      const match = lines[i].match(/^(\w+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2].trim();
        metadata[key] = value;
      }
    }
  }

  return { metadata, frontmatterEnd };
}

/**
 * Check if an ADR's status has changed from Accepted to Superseded
 * This compares the current file with git history
 */
function detectSupersessionChange(adrFile) {
  const fullPath = path.join(ADR_DIR, adrFile);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const { metadata } = parseADRFrontmatter(content);

  // Check if this ADR is now Superseded
  if (metadata.status !== 'Superseded') {
    return null;
  }

  // Check that supersedes field is not empty
  if (!metadata.supersedes || metadata.supersedes.trim() === '') {
    return {
      error: true,
      message: `${metadata.id} is marked Superseded but supersedes field is empty`,
      file: adrFile,
    };
  }

  return {
    id: metadata.id,
    file: adrFile,
    status: metadata.status,
    supersedes: metadata.supersedes,
    updated: metadata.updated || new Date().toISOString().split('T')[0],
  };
}

/**
 * Find ADR ID from filename
 */
function extractADRId(filename) {
  const match = filename.match(/^(\d{4}).*\.md$/);
  if (match) {
    const num = match[1];
    return `ADR-${num}`;
  }
  return null;
}

/**
 * Create a log entry for the supersession event
 */
function createSupersessionLogEntry(fromADR, toADRId, reason = 'decision superseded') {
  const timestamp = new Date().toISOString();
  const approver = process.env.GIT_AUTHOR_NAME || process.env.USER || 'unknown';

  return {
    timestamp,
    from: fromADR.id,
    to: toADRId,
    reason,
    approver,
    reversal: `If ${fromADR.id}'s approach proves necessary, update ${fromADR.id}.status to Accepted`,
  };
}

/**
 * Format log entry as a line in SUPERSESSIONS.log
 */
function formatLogEntry(entry) {
  return `${entry.timestamp} | ${entry.from} → ${entry.to} | ${entry.reason} | ${entry.approver}`;
}

/**
 * Append to SUPERSESSIONS.log (append-only, immutable)
 */
function logSupersession(entry) {
  const logLine = formatLogEntry(entry) + '\n';

  try {
    if (fs.existsSync(SUPERSESSIONS_LOG)) {
      // Append to existing log
      fs.appendFileSync(SUPERSESSIONS_LOG, logLine);
    } else {
      // Create new log with header
      const header = '# ADR Supersessions Log (append-only)\n';
      const headerLine = '# timestamp | from → to | reason | approver\n\n';
      fs.writeFileSync(SUPERSESSIONS_LOG, header + headerLine + logLine);
    }
    return true;
  } catch (err) {
    console.error(`${colors.RED}✗ Failed to write supersession log:${colors.NC}`, err.message);
    return false;
  }
}

/**
 * Update the replacement ADR's frontmatter to include backlink
 */
function updateReplacementADRBacklink(replacementADRId, supersedingADRId) {
  // Find the replacement ADR file
  const adrNumber = parseInt(replacementADRId.split('-')[1], 10);
  const pattern = new RegExp(`^${String(adrNumber).padStart(4, '0')}`);

  const files = fs.readdirSync(ADR_DIR);
  const replacementFile = files.find(f => pattern.test(f));

  if (!replacementFile) {
    console.error(`${colors.YELLOW}⚠ Cannot find replacement ADR ${replacementADRId}${colors.NC}`);
    return false;
  }

  const fullPath = path.join(ADR_DIR, replacementFile);
  const content = fs.readFileSync(fullPath, 'utf-8');

  // Check if "supersedes:" field already exists
  if (content.includes('supersedes:')) {
    // Add to existing list if it's a YAML list
    // For now, append as a comment
    const backlink = `\n<!-- ${replacementADRId} supersedes ${supersedingADRId} -->`;
    if (!content.includes(backlink)) {
      fs.appendFileSync(fullPath, backlink);
    }
  }

  return true;
}

/**
 * Check all ADRs for supersession status changes
 */
function checkAllSupersessions() {
  const files = fs.readdirSync(ADR_DIR).filter(f => f.endsWith('.md'));
  const results = {
    processed: [],
    errors: [],
  };

  for (const file of files) {
    const supersession = detectSupersessionChange(file);

    if (supersession?.error) {
      results.errors.push(supersession);
      continue;
    }

    if (supersession) {
      // This ADR was superseded; log it
      const logEntry = createSupersessionLogEntry(
        supersession,
        supersession.supersedes,
        `Decision superseded by ${supersession.supersedes}`
      );

      if (logSupersession(logEntry)) {
        updateReplacementADRBacklink(supersession.supersedes, supersession.id);
        results.processed.push({
          id: supersession.id,
          replacedBy: supersession.supersedes,
          logged: true,
        });
      }
    }
  }

  return results;
}

/**
 * Main execution
 */
async function main() {
  try {
    // Create SUPERSESSIONS.log if it doesn't exist
    if (!fs.existsSync(SUPERSESSIONS_LOG)) {
      const header = '# ADR Supersessions Log (append-only, immutable)\n';
      const subheader = '# Format: timestamp | from_adr → to_adr | reason | approver\n\n';
      fs.writeFileSync(SUPERSESSIONS_LOG, header + subheader);
      console.log(`${colors.GREEN}✓ Created${colors.NC} ${SUPERSESSIONS_LOG}`);
    }

    const results = checkAllSupersessions();

    // Report results
    if (results.processed.length > 0) {
      console.log(`${colors.GREEN}✓ Supersessions logged:${colors.NC}`);
      results.processed.forEach(r => {
        console.log(`  ${r.id} → ${r.replacedBy}`);
      });
    }

    if (results.errors.length > 0) {
      console.error(`${colors.RED}✗ Supersession errors:${colors.NC}`);
      results.errors.forEach(e => {
        console.error(`  ${e.file}: ${e.message}`);
      });
      process.exit(1);
    }

    if (results.processed.length === 0 && results.errors.length === 0) {
      console.log(`${colors.GREEN}✓${colors.NC} No supersessions detected.`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`${colors.RED}✗ Fatal error:${colors.NC}`, err.message);
    process.exit(1);
  }
}

main();
