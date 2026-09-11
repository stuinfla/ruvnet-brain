#!/usr/bin/env node
/**
 * durability-validator.mjs — Validates AgentDB durability before writes.
 *
 * PURPOSE: Ensure every write to .swarm/memory.db is verifiable before and after.
 * This prevents silent data loss: if a write succeeds but the read-back fails,
 * the validation layer rejects the whole operation.
 *
 * INTEGRATION: Called by any script that needs to ensure durability guarantees.
 * Returns true (write is safe) or throws (write rejected).
 *
 * Usage:
 *   import { validateDurability } from './plugin/scripts/durability-validator.mjs';
 *   await validateDurability();  // Check health before write
 *   // ... perform write ...
 *   await validateDurabilityAfter();  // Verify write succeeded
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DB = path.join(process.env.ROOT || process.cwd(), '.swarm', 'memory.db');
const HEALTH_CHECK_TIMEOUT = 30000; // 30 seconds for health check

/**
 * Resolve the ruflo binary path.
 */
function resolveRuflo() {
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'ruflo'),
    '/opt/homebrew/bin/ruflo',
    'ruflo',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(`"${bin}" --version`, { stdio: 'ignore', shell: true });
      return bin;
    } catch {}
  }
  throw new Error('ruflo binary not found in PATH or ~/.npm-global/bin');
}

/**
 * Execute a ruflo command with error handling.
 */
function rufloCmd(args, { timeout = 30000, cwd = process.cwd() } = {}) {
  const RUFLO = resolveRuflo();
  try {
    return execFileSync(RUFLO, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      shell: process.platform === 'win32',
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`ruflo command failed: ${err.message}`);
  }
}

/**
 * Pre-write validation: Verify the memory store is responsive.
 * Performs a test write/read cycle to catch issues early.
 *
 * Returns true if durable, throws otherwise.
 */
export async function validateDurability(dbPath = DEFAULT_DB, options = {}) {
  const { timeout = HEALTH_CHECK_TIMEOUT, verbose = false } = options;

  if (verbose) console.log('[VALIDATE] Pre-write durability check...');

  // Ensure db dir exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const testKey = `durability-check-${Date.now()}`;
  const testValue = JSON.stringify({ check: 'pre-write-validation', timestamp: new Date().toISOString() });

  try {
    // Write test record
    if (verbose) console.log(`[VALIDATE] Writing test record: ${testKey}`);
    rufloCmd(['memory', 'store', '-k', testKey, '-n', 'durability-checks', '--value', testValue], { timeout });

    // Read back immediately
    if (verbose) console.log(`[VALIDATE] Reading back test record...`);
    const retrieved = rufloCmd(
      ['memory', 'retrieve', '-k', testKey, '-n', 'durability-checks', '--value-only'],
      { timeout }
    ).trim();

    // Verify
    if (retrieved !== testValue) {
      throw new Error(`Read-back mismatch: expected "${testValue}", got "${retrieved}"`);
    }

    if (verbose) console.log('[VALIDATE] ✅ Durability check PASSED');
    return true;
  } catch (err) {
    const msg = `[VALIDATE] ❌ Durability check FAILED: ${err.message}`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Post-write validation: Verify a specific write succeeded.
 *
 * @param {string} key - The key that was written
 * @param {string} expectedValue - The value that should be readable
 * @param {string} dbPath - Path to memory.db
 */
export async function validateWrite(key, expectedValue, dbPath = DEFAULT_DB, options = {}) {
  const { timeout = HEALTH_CHECK_TIMEOUT, verbose = false } = options;

  if (verbose) console.log(`[VALIDATE-WRITE] Checking write: ${key}`);

  try {
    const retrieved = rufloCmd(
      ['memory', 'retrieve', '-k', key, '-n', 'durability-checks', '--value-only'],
      { timeout }
    ).trim();

    if (retrieved !== expectedValue) {
      throw new Error(`Read-back mismatch: expected "${expectedValue}", got "${retrieved}"`);
    }

    if (verbose) console.log(`[VALIDATE-WRITE] ✅ Write verified: ${key}`);
    return true;
  } catch (err) {
    const msg = `[VALIDATE-WRITE] ❌ Write verification FAILED: ${err.message}`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Simulate durability failure (for testing/injection).
 *
 * Can simulate: disk-full, permission-denied, or corruption.
 */
export function injectDurabilityFailure(dbPath = DEFAULT_DB, type = 'disk-full') {
  if (type === 'disk-full') {
    // Make db file read-only to simulate write failure
    if (fs.existsSync(dbPath)) {
      fs.chmodSync(dbPath, 0o444);
      return () => fs.chmodSync(dbPath, 0o644); // Return cleanup function
    }
  } else if (type === 'corruption') {
    // Truncate db file to simulate corruption
    if (fs.existsSync(dbPath)) {
      const backup = dbPath + '.backup';
      fs.copyFileSync(dbPath, backup);
      fs.truncateSync(dbPath, 100); // Truncate to 100 bytes (corrupted)
      return () => fs.copyFileSync(backup, dbPath); // Return restore function
    }
  }
  return () => {}; // No-op cleanup
}

// Export for testing
export { rufloCmd, resolveRuflo };
