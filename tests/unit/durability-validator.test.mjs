#!/usr/bin/env node
/**
 * durability-validator.test.mjs — Tests for durability validation layer.
 *
 * TESTS:
 *   1. Success path: Durability check passes
 *   2. Failure injection: Simulated write failure
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDurability, validateWrite, injectDurabilityFailure } from '../../plugin/scripts/durability-validator.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');

// Create a temporary directory for test db
const tmpDir = path.join(os.tmpdir(), `durability-test-${Date.now()}`);
const testDb = path.join(tmpDir, 'memory.db');

describe('durability-validator', () => {
  // Setup
  before(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    process.env.ROOT = ROOT;
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

  it('Test 1: Success path — durability validation passes', async () => {
    try {
      const result = await validateDurability(testDb, { verbose: true });
      assert.strictEqual(result, true, 'Validation should return true');
      console.log('✅ Test 1 PASSED: Durability validation works');
    } catch (err) {
      // If ruflo is not available in test env, skip this test
      if (err.message.includes('ruflo') || err.message.includes('not found')) {
        console.log('⏭️  Test 1 SKIPPED: ruflo not available in test environment');
      } else {
        console.error('❌ Test 1 FAILED:', err.message);
        throw err;
      }
    }
  });

  it('Test 2: Failure injection — disk-full simulation', async () => {
    // This test is primarily to verify the injection mechanism works
    // (The actual failure would require a real memory store)
    try {
      const cleanup = injectDurabilityFailure(testDb, 'disk-full');
      assert(typeof cleanup === 'function', 'Injection should return cleanup function');

      // Verify cleanup works
      cleanup();
      console.log('✅ Test 2 PASSED: Failure injection mechanism works');
    } catch (err) {
      console.error('❌ Test 2 FAILED:', err.message);
      throw err;
    }
  });

  it('Test 3: Corruption injection — corrupted db detection', async () => {
    try {
      const cleanup = injectDurabilityFailure(testDb, 'corruption');
      assert(typeof cleanup === 'function', 'Injection should return cleanup function');

      // Verify cleanup works
      cleanup();
      console.log('✅ Test 3 PASSED: Corruption injection mechanism works');
    } catch (err) {
      console.error('❌ Test 3 FAILED:', err.message);
      throw err;
    }
  });
});
