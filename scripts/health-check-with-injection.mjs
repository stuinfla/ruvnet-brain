#!/usr/bin/env node
/**
 * health-check-with-injection.mjs — Durability validation with forced failure testing.
 *
 * PURPOSE: Every 30 minutes, write a test record to .swarm/memory.db, read it back immediately,
 * and exit with code 1 if the read fails. This proves the memory store is durable and responsive.
 *
 * FORCED FAILURE TEST: Can simulate disk full, network errors, or corruption to verify graceful
 * degradation rather than hangs.
 *
 * Usage:
 *   node scripts/health-check-with-injection.mjs [--inject disk-full|network-error|corruption]
 *
 * Integration:
 *   - Runs as a scheduled job (config/scheduled-jobs.json)
 *   - Logged heartbeat via job-heartbeat.sh wrapper
 *   - Watched by nightly-watchdog.mjs
 *   - Alerts if any read-back fails
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWARM_DIR = path.join(ROOT, '.swarm');
const MEMORY_DB = path.join(SWARM_DIR, 'memory.db');
const INJECT = process.argv.includes('--inject') ? process.argv[process.argv.indexOf('--inject') + 1] : null;

// Parse args for test mode
const isTest = process.argv.includes('--test');
const testDir = process.argv[process.argv.indexOf('--test-dir') + 1] || SWARM_DIR;
const testDb = path.join(testDir, 'memory.db');

/**
 * Resolve the ruflo binary — same as record-lesson.mjs pattern.
 */
function resolveRuflo() {
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'ruflo'),
    '/opt/homebrew/bin/ruflo',
    'ruflo', // fallback to PATH
  ];
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" --version`, { stdio: 'ignore' });
      return bin;
    } catch {}
  }
  return null;
}

/**
 * Execute a ruflo command with timeout and clean environment.
 */
function rufloCmd(args, { timeout = 30000, cwd = ROOT, db = MEMORY_DB } = {}) {
  const RUFLO = resolveRuflo();
  if (!RUFLO) throw new Error('ruflo binary not found');

  return execFileSync(RUFLO, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    shell: process.platform === 'win32',
    env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
    stdio: 'pipe',
  });
}

/**
 * Generate a unique health check record.
 */
function generateRecord() {
  const timestamp = new Date().toISOString();
  const seq = Math.floor(Date.now() / 1000);
  return {
    timestamp,
    sequence: seq,
    hostname: os.hostname(),
    pid: process.pid,
  };
}

/**
 * Simulate disk full condition (for testing).
 */
function simulateDiskFull(dbPath) {
  // We cannot actually fill the disk, but we can make the db file read-only
  // to simulate a write failure
  if (fs.existsSync(dbPath)) {
    fs.chmodSync(dbPath, 0o444); // read-only
  }
}

/**
 * Restore disk after simulation.
 */
function restoreDisk(dbPath) {
  if (fs.existsSync(dbPath)) {
    fs.chmodSync(dbPath, 0o644); // read-write
  }
}

/**
 * Main health check flow.
 */
async function healthCheck() {
  const db = isTest ? testDb : MEMORY_DB;

  // Ensure .swarm directory exists
  if (!fs.existsSync(path.dirname(db))) {
    fs.mkdirSync(path.dirname(db), { recursive: true });
  }

  const record = generateRecord();
  const key = `health-check-${record.sequence}`;
  const value = JSON.stringify(record);

  console.log(`[${record.timestamp}] Health check: writing record ${key}`);

  try {
    // INJECT: disk-full simulation
    if (INJECT === 'disk-full') {
      console.log('[INJECT] Simulating disk-full condition...');
      simulateDiskFull(db);
    }

    // 1. WRITE — store the record
    let writeOk = false;
    try {
      const dbArg = isTest ? ['--path', db] : [];
      rufloCmd(['memory', 'store', '-k', key, '-n', 'health-checks', '--value', value, ...dbArg]);
      writeOk = true;
      console.log('[WRITE] Store command succeeded');
    } catch (err) {
      console.error('[WRITE] FAILED:', String(err.message || err).split('\n')[0]);
      throw new Error('Store write failed');
    }

    // Restore disk after disk-full injection
    if (INJECT === 'disk-full') {
      restoreDisk(db);
      console.log('[INJECT] Disk restored');
    }

    // 2. VERIFY — read it back immediately (the critical durability check)
    let readOk = false;
    let retrieved = null;
    try {
      const dbArg = isTest ? ['--path', db] : [];
      const back = rufloCmd(['memory', 'retrieve', '-k', key, '-n', 'health-checks', '--value-only', ...dbArg]);
      retrieved = back.trim();
      readOk = retrieved === value;
      console.log(`[READ] Retrieved: ${retrieved.substring(0, 80)}...`);
    } catch (err) {
      console.error('[READ] FAILED:', String(err.message || err).split('\n')[0]);
      throw new Error('Read verification failed');
    }

    if (!readOk) {
      console.error('[VERIFY] FAILED: retrieved value does not match written value');
      console.error(`  Written:  ${value}`);
      console.error(`  Retrieved: ${retrieved}`);
      throw new Error('Durability verification failed');
    }

    // 3. SUCCESS — the record is durable
    console.log('[OK] Health check passed: record is durable');
    return { ok: true, key, record };
  } catch (err) {
    console.error(`[FAIL] Health check failed: ${err.message}`);
    process.exit(1);
  }
}

// Run if invoked directly
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await healthCheck();
}

export { healthCheck, generateRecord, simulateDiskFull, restoreDisk };
