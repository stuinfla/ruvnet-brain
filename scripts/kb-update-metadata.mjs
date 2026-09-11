#!/usr/bin/env node

/**
 * KB Metadata Updater
 *
 * Updates the KB metadata file with the latest ingest status.
 * Called by the workflow after ingest completion.
 *
 * Usage:
 *   node scripts/kb-update-metadata.mjs --repo owner/name --timestamp ISO_DATE --status success|failure
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const kbDir = join(rootDir, 'kb');
const metadataFile = join(kbDir, '.kb-metadata.json');

// Parse CLI arguments
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    repo: null,
    timestamp: null,
    status: 'unknown',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' && i + 1 < args.length) {
      opts.repo = args[++i];
    } else if (arg === '--timestamp' && i + 1 < args.length) {
      opts.timestamp = args[++i];
    } else if (arg === '--status' && i + 1 < args.length) {
      opts.status = args[++i];
    }
  }

  return opts;
}

// Load existing metadata
function loadMetadata() {
  try {
    if (fs.existsSync(metadataFile)) {
      const data = fs.readFileSync(metadataFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn(`Failed to load metadata: ${err.message}`);
  }

  return {
    schemaVersion: 1,
    lastUpdateUtc: null,
    lastUpdateRepo: null,
    lastUpdateStatus: null,
    repositories: {},
    ingestCount: 0,
    ingestLog: [],
  };
}

// Save metadata
function saveMetadata(metadata) {
  fs.mkdirSync(dirname(metadataFile), { recursive: true });
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`Updated metadata: ${metadataFile}`);
}

// Main function
function main() {
  const opts = parseArgs(process.argv);

  if (!opts.repo || !opts.timestamp) {
    console.error('Usage: kb-update-metadata.mjs --repo REPO --timestamp ISO_DATE --status success|failure');
    process.exit(1);
  }

  const metadata = loadMetadata();

  // Update global state
  metadata.lastUpdateUtc = opts.timestamp;
  metadata.lastUpdateRepo = opts.repo;
  metadata.lastUpdateStatus = opts.status;

  // Initialize repository entry if needed
  if (!metadata.repositories[opts.repo]) {
    metadata.repositories[opts.repo] = {
      firstIngest: opts.timestamp,
      ingestCount: 0,
      lastIngestUtc: null,
      lastIngestStatus: null,
    };
  }

  // Update repository-specific state
  metadata.repositories[opts.repo].lastIngestUtc = opts.timestamp;
  metadata.repositories[opts.repo].lastIngestStatus = opts.status;
  metadata.repositories[opts.repo].ingestCount =
    (metadata.repositories[opts.repo].ingestCount || 0) + 1;

  // Append to ingest log (keep last 100)
  if (!metadata.ingestLog) {
    metadata.ingestLog = [];
  }
  metadata.ingestLog.push({
    timestamp: opts.timestamp,
    repo: opts.repo,
    status: opts.status,
  });
  if (metadata.ingestLog.length > 100) {
    metadata.ingestLog = metadata.ingestLog.slice(-100);
  }

  metadata.ingestCount = (metadata.ingestCount || 0) + 1;

  // Save updated metadata
  saveMetadata(metadata);

  console.log(`Status: ${opts.status}`);
  console.log(`Repository: ${opts.repo}`);
  console.log(`Total ingests: ${metadata.ingestCount}`);
}

main();
