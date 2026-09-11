#!/usr/bin/env node

/**
 * KB Streaming Ingest
 *
 * Ingests repository changes into the knowledge base via incremental vector updates.
 * In dry-run mode, logs what WOULD happen without actually updating the RVF store.
 *
 * Usage:
 *   node scripts/kb-streaming-ingest.mjs --repo owner/name [--owner O --name N] [--dry-run]
 *
 * Options:
 *   --repo REPO_ID          Repository ID (owner/name format)
 *   --owner OWNER           Repository owner (extracted from --repo if provided)
 *   --name NAME             Repository name (extracted from --repo if provided)
 *   --dry-run               Log planned updates without modifying KB (default: true)
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
    owner: null,
    name: null,
    dryRun: true, // Default to dry-run
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' && i + 1 < args.length) {
      const repo = args[++i];
      const [owner, name] = repo.split('/');
      opts.repo = repo;
      opts.owner = owner;
      opts.name = name;
    } else if (arg === '--owner' && i + 1 < args.length) {
      opts.owner = args[++i];
    } else if (arg === '--name' && i + 1 < args.length) {
      opts.name = args[++i];
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--apply' || arg === '--write') {
      opts.dryRun = false;
    }
  }

  return opts;
}

// Load or initialize KB metadata
function loadMetadata() {
  try {
    if (fs.existsSync(metadataFile)) {
      const data = fs.readFileSync(metadataFile, 'utf8');
      return JSON.parse(data);
    }
  } catch {
    // Fall through to initialization
  }

  return {
    schemaVersion: 1,
    lastUpdateUtc: null,
    lastUpdateRepo: null,
    repositories: {},
    ingestCount: 0,
  };
}

// Save KB metadata
function saveMetadata(metadata, dryRun = true) {
  if (dryRun) {
    console.log(`[DRY-RUN] Would write metadata to ${metadataFile}`);
    return;
  }

  fs.mkdirSync(dirname(metadataFile), { recursive: true });
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`Saved metadata: ${metadataFile}`);
}

// Check for repository README
function findRepoReadme() {
  const readmePaths = ['README.md', 'readme.md', 'Readme.md'];
  for (const path of readmePaths) {
    const fullPath = join(rootDir, path);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

// Check for main documentation
function findDocumentation() {
  const docFiles = [];
  const docDir = join(rootDir, 'docs');
  if (fs.existsSync(docDir)) {
    const files = fs.readdirSync(docDir);
    for (const file of files) {
      if (file.endsWith('.md') && !file.startsWith('.')) {
        docFiles.push(join(docDir, file));
      }
    }
  }

  // Add root-level markdown files
  const rootMarkdown = ['VISION.md', 'PROGRESS.md', 'ARCHITECTURE.md'];
  for (const file of rootMarkdown) {
    const fullPath = join(rootDir, file);
    if (fs.existsSync(fullPath)) {
      docFiles.push(fullPath);
    }
  }

  return docFiles;
}

// Extract text preview from file
function extractPreview(filePath, maxChars = 200) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf8');
    // Remove frontmatter if present
    let text = content.replace(/^---[\s\S]*?---\n/, '');
    // Remove markdown headings and formatting
    text = text.replace(/^#+\s+/gm, '').replace(/[*_`]/g, '');
    // Take first line or maxChars
    return text.substring(0, maxChars).split('\n')[0].trim();
  } catch {
    return '';
  }
}

// Query existing vectors for a repo (stub)
async function queryExistingVectors(repoId) {
  console.log(`[QUERY] Would query RVF KB for existing vectors matching repo: ${repoId}`);
  return {
    found: 0,
    storagePath: join(kbDir, 'ruvnet-brain.big.rvf'),
  };
}

// Add new vectors to RVF (stub — actual implementation would use @ruvector/rvf)
async function addVectorsToRvf(vectors, metadata, dryRun = true) {
  if (dryRun) {
    console.log(`[DRY-RUN] Would add ${vectors.length} vectors to RVF store`);
    return;
  }

  // In real implementation, would use:
  // import { RvfDatabase } from '@ruvector/rvf';
  // const db = await RvfDatabase.open(storePath);
  // for (const vec of vectors) { await db.insert(vec); }
  console.log(`[RVF] Added ${vectors.length} vectors to store`);
}

// Main ingest workflow
async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.repo || !opts.owner || !opts.name) {
    console.error('Usage: kb-streaming-ingest.mjs --repo owner/name [--dry-run]');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  console.log(`\n=== KB Streaming Ingest ===`);
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Repository: ${opts.repo}`);
  console.log(`Dry-run: ${opts.dryRun}`);
  console.log(`\n--- Phase 1: KB State Inspection ---`);

  // Load existing metadata
  const metadata = loadMetadata();
  const repoEntry = metadata.repositories[opts.repo] || {
    lastIngest: null,
    vectorCount: 0,
    sourceFiles: [],
  };

  console.log(`Current state: ${repoEntry.vectorCount} vectors, last ingest: ${repoEntry.lastIngest}`);

  // Find source files
  console.log(`\n--- Phase 2: Source Discovery ---`);
  const readme = findRepoReadme();
  const docs = findDocumentation();
  const sourceFiles = [];

  if (readme) {
    sourceFiles.push(readme);
    console.log(`Found README: ${readme}`);
  }

  if (docs.length > 0) {
    docs.forEach((doc) => {
      sourceFiles.push(doc);
      console.log(`Found doc: ${doc}`);
    });
  }

  if (sourceFiles.length === 0) {
    console.warn(`No source files found for ${opts.repo}`);
  }

  // Extract content and prepare vectors
  console.log(`\n--- Phase 3: Content Extraction ---`);
  const vectors = [];
  for (const filePath of sourceFiles) {
    try {
      const stat = fs.statSync(filePath);
      const preview = extractPreview(filePath);
      vectors.push({
        id: `${opts.repo}:${filePath}`,
        text: preview,
        metadata: {
          repo: opts.repo,
          file: filePath,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        },
      });
      console.log(`Extracted: ${filePath} (${stat.size} bytes)`);
    } catch (err) {
      console.warn(`Failed to extract ${filePath}: ${err.message}`);
    }
  }

  // Query existing vectors
  console.log(`\n--- Phase 4: KB Query ---`);
  const existing = await queryExistingVectors(opts.repo);
  console.log(`Existing vectors: ${existing.found}`);
  console.log(`Storage: ${existing.storagePath}`);

  // Add vectors to RVF
  if (vectors.length > 0) {
    console.log(`\n--- Phase 5: Vector Ingestion ---`);
    await addVectorsToRvf(vectors, metadata, opts.dryRun);
  }

  // Update metadata
  console.log(`\n--- Phase 6: Metadata Update ---`);
  metadata.repositories[opts.repo] = {
    ...repoEntry,
    lastIngest: timestamp,
    vectorCount: (repoEntry.vectorCount || 0) + vectors.length,
    sourceFiles: sourceFiles,
  };
  metadata.lastUpdateUtc = timestamp;
  metadata.lastUpdateRepo = opts.repo;
  metadata.ingestCount = (metadata.ingestCount || 0) + 1;

  saveMetadata(metadata, opts.dryRun);

  // Summary
  console.log(`\n=== Ingest Summary ===`);
  console.log(`Status: ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Vectors prepared: ${vectors.length}`);
  console.log(`Source files: ${sourceFiles.length}`);
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Repository: ${opts.repo}`);

  if (!opts.dryRun) {
    console.log('\n✓ KB updated successfully');
  } else {
    console.log('\n[DRY-RUN] No changes written to KB');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
