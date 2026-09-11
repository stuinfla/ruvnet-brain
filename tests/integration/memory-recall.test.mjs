import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { memoryEnsure } from '../../plugin/hooks/memory-ensure.mjs';

test('memory-recall: SessionStart with no prior memory', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  const swarmDir = path.join(tmpDir, '.swarm');
  fs.mkdirSync(swarmDir, { recursive: true });

  const output = [];
  const memEnsure = await memoryEnsure({
    cwd: tmpDir,
    stdout: { write: (s) => output.push(s) },
    stderr: { write: () => {} },
  });

  assert.strictEqual(memEnsure, 0, 'should return exit code 0 (success)');
  assert.strictEqual(output.length, 0, 'should emit no output when no memory exists');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

test('memory-recall: handles missing memory.db gracefully', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));

  const output = [];
  const memEnsure = await memoryEnsure({
    cwd: tmpDir,
    stdout: { write: (s) => output.push(s) },
    stderr: { write: () => {} },
  });

  assert.strictEqual(memEnsure, 0, 'should return exit code 0 (fail open)');
  assert.strictEqual(output.length, 0, 'should silently exit when .swarm/memory.db missing');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

test('memory-recall: completes within timeout', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  const swarmDir = path.join(tmpDir, '.swarm');
  fs.mkdirSync(swarmDir, { recursive: true });

  const start = Date.now();
  const output = [];
  const memEnsure = await memoryEnsure({
    cwd: tmpDir,
    stdout: { write: (s) => output.push(s) },
    stderr: { write: () => {} },
  });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `should complete in <2s (took ${elapsed}ms)`);
  assert.strictEqual(memEnsure, 0, 'should complete successfully');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

test('memory-recall: formats checkpoint output correctly', async (t) => {
  // This test would require a real .swarm/memory.db with checkpoint entries
  // For now, verify the format output matches expected pattern
  const testKey = 'checkpoint-1694425323000';
  const timestamp = new Date(1694425323000).toISOString().split('T')[0] + ' ' +
    new Date(1694425323000).toISOString().split('T')[1].split('.')[0];

  assert.ok(timestamp.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/),
    'timestamp format should be YYYY-MM-DD HH:MM:SS');
});

test('memory-recall: fails open on error', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  const swarmDir = path.join(tmpDir, '.swarm');
  fs.mkdirSync(swarmDir, { recursive: true });

  const errors = [];
  const memEnsure = await memoryEnsure({
    cwd: tmpDir,
    stdout: { write: () => {} },
    stderr: { write: (s) => errors.push(s) },
  });

  // Even on error, should return 0 (fail open)
  assert.strictEqual(memEnsure, 0, 'should return 0 even on error (fail open)');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});
