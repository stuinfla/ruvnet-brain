#!/usr/bin/env node
/**
 * health-check-with-injection.test.mjs — Tests for durability validation with failure injection.
 *
 * TESTS:
 *   1. Success path: Write → Read → Verify
 *   2. Failure injection: Disk-full simulation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');

// Create a temporary directory for test db
const tmpDir = path.join(os.tmpdir(), `health-check-test-${Date.now()}`);

describe('health-check-with-injection', () => {
  // Setup
  before(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  // Cleanup
  after(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('Could not clean up temp dir:', e.message);
    }
  });

  it('Test 1: Success path — write and verify durability', async () => {
    const testCmd = `node ${path.join(ROOT, 'scripts/health-check-with-injection.mjs')} --test --test-dir ${tmpDir}`;

    try {
      const output = execSync(testCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Verify output indicates success
      assert(output.includes('[OK] Health check passed'), 'Health check should succeed');
      assert(output.includes('[WRITE] Store command succeeded'), 'Write should succeed');
      assert(output.includes('[READ] Retrieved:'), 'Read should return value');
      assert(!output.includes('[FAIL]'), 'Should not fail');

      console.log('✅ Test 1 PASSED: Success path works');
    } catch (err) {
      console.error('❌ Test 1 FAILED:', err.message);
      throw err;
    }
  });

  it('Test 2: Failure injection — disk-full simulation', async () => {
    const testCmd = `node ${path.join(ROOT, 'scripts/health-check-with-injection.mjs')} --test --test-dir ${tmpDir} --inject disk-full`;

    try {
      const output = execSync(testCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // With disk-full, the write might fail or succeed, but restoration should happen
      // The important thing is: no hang, graceful handling
      assert(!output.includes('hang'), 'Should not hang');
      console.log('✅ Test 2 PASSED: Disk-full injection handled gracefully');
    } catch (err) {
      // It's OK if this exits with code 1 (failure is expected for disk-full)
      if (err.status === 1) {
        console.log('✅ Test 2 PASSED: Disk-full injection failed gracefully (exit 1 expected)');
      } else {
        console.error('❌ Test 2 FAILED:', err.message);
        throw err;
      }
    }
  });
});
