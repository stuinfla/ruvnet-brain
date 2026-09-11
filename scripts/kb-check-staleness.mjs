#!/usr/bin/env node

/**
 * KB Staleness Checker
 *
 * Checks if the KB has been updated within the configured interval (default: 6 hours).
 * Returns exit code 0 if fresh, 1 if stale.
 *
 * Usage:
 *   node scripts/kb-check-staleness.mjs [--check-only] [--max-age-hours 6]
 *
 * Options:
 *   --check-only           Only check, do not report exit code
 *   --max-age-hours N      Maximum age in hours (default: 6)
 *   --verbose              Show detailed staleness info
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const kbDir = join(rootDir, 'kb');
const metadataFile = join(kbDir, '.kb-metadata.json');
const rvfGenerationsFile = join(kbDir, 'RVF-GENERATIONS.json');

// Parse CLI arguments
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    checkOnly: false,
    maxAgeHours: 6,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check-only') {
      opts.checkOnly = true;
    } else if (arg === '--max-age-hours' && i + 1 < args.length) {
      opts.maxAgeHours = parseInt(args[++i], 10);
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    }
  }

  return opts;
}

// Load metadata files
function loadMetadata() {
  const files = {
    custom: null,
    rvfGenerations: null,
  };

  try {
    if (fs.existsSync(metadataFile)) {
      const data = fs.readFileSync(metadataFile, 'utf8');
      files.custom = JSON.parse(data);
    }
  } catch (err) {
    console.warn(`Failed to load custom metadata: ${err.message}`);
  }

  try {
    if (fs.existsSync(rvfGenerationsFile)) {
      const data = fs.readFileSync(rvfGenerationsFile, 'utf8');
      files.rvfGenerations = JSON.parse(data);
    }
  } catch (err) {
    console.warn(`Failed to load RVF generations: ${err.message}`);
  }

  return files;
}

// Get the most recent KB update timestamp
function getLastUpdateTimestamp(metadata) {
  let lastTimestamp = null;

  // Check custom metadata
  if (metadata.custom?.lastUpdateUtc) {
    lastTimestamp = new Date(metadata.custom.lastUpdateUtc);
  }

  // Check RVF generations for the most recent store
  if (metadata.rvfGenerations?.stores) {
    for (const [, store] of Object.entries(metadata.rvfGenerations.stores)) {
      if (store.builtUtc) {
        const storeTime = new Date(store.builtUtc);
        if (!lastTimestamp || storeTime > lastTimestamp) {
          lastTimestamp = storeTime;
        }
      }
    }
  }

  return lastTimestamp;
}

// Calculate age in hours
function getAgeInHours(timestamp) {
  if (!timestamp) return Infinity;
  const now = new Date();
  const ageMs = now.getTime() - timestamp.getTime();
  return ageMs / (1000 * 60 * 60);
}

// Check if KB is stale
function checkStaleness(lastUpdate, maxAgeHours, verbose = false) {
  if (!lastUpdate) {
    if (verbose) {
      console.log('KB: No update timestamp found (KB not yet built)');
    }
    return {
      stale: true,
      reason: 'KB not yet built',
      age: null,
      lastUpdate: null,
    };
  }

  const ageHours = getAgeInHours(lastUpdate);
  const isStale = ageHours > maxAgeHours;

  if (verbose) {
    console.log(`KB Age: ${ageHours.toFixed(1)} hours`);
    console.log(`Max Age: ${maxAgeHours} hours`);
    console.log(`Status: ${isStale ? 'STALE' : 'FRESH'}`);
    console.log(`Last Update: ${lastUpdate.toISOString()}`);
  }

  return {
    stale: isStale,
    reason: isStale ? `KB is ${ageHours.toFixed(1)}h old (max: ${maxAgeHours}h)` : 'KB is fresh',
    age: ageHours,
    lastUpdate: lastUpdate.toISOString(),
  };
}

// Format report
function formatReport(result, maxAge, checkOnly) {
  const lines = [];
  lines.push(`KB Staleness Report`);
  lines.push(`---`);
  lines.push(`Status: ${result.stale ? '⚠️  STALE' : '✓ FRESH'}`);
  lines.push(`Reason: ${result.reason}`);

  if (result.lastUpdate) {
    lines.push(`Last Update: ${result.lastUpdate}`);
  }
  if (result.age !== null) {
    lines.push(`Age: ${result.age.toFixed(1)} hours`);
    lines.push(`Threshold: ${maxAge} hours`);
  }

  if (checkOnly) {
    lines.push(`Mode: check-only (no action taken)`);
  }

  return lines.join('\n');
}

// Main function
function main() {
  const opts = parseArgs(process.argv);
  const metadata = loadMetadata();
  const lastUpdate = getLastUpdateTimestamp(metadata);
  const result = checkStaleness(lastUpdate, opts.maxAgeHours, opts.verbose);

  console.log(formatReport(result, opts.maxAgeHours, opts.checkOnly));

  // Exit codes
  if (opts.checkOnly) {
    process.exit(0);
  }

  // 0 = fresh, 1 = stale
  process.exit(result.stale ? 1 : 0);
}

main();
