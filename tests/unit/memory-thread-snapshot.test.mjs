import { describe, test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { captureThreadSnapshot } from '../../scripts/memory-snapshot-threads.mjs';

describe('memory-thread-snapshot', () => {
  test('creates snapshot with valid structure', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    // Create a minimal PROGRESS.md
    const progressPath = path.join(tmpDir, 'PROGRESS.md');
    fs.writeFileSync(progressPath, `# Project Progress

- [ ] Task 1: Implement feature X
- [ ] Task 2: Write tests
- [x] Task 3: Deploy
`);

    const output = [];
    const result = captureThreadSnapshot({
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return exit code 0');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('handles missing .swarm directory', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));

    const output = [];
    const result = captureThreadSnapshot({
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 (fail open) when .swarm missing');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('extracts unchecked tasks from PROGRESS.md', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const progressPath = path.join(tmpDir, 'PROGRESS.md');
    fs.writeFileSync(progressPath, `# Progress

- [ ] First unchecked task
- [x] Checked task (should be skipped)
- [ ] Second unchecked task
- [ ] Third unchecked task
- [ ] Fourth unchecked task
- [ ] Fifth unchecked task
- [ ] Sixth unchecked task (should be limited to 5)
`);

    const result = captureThreadSnapshot({
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should process PROGRESS.md successfully');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('handles missing PROGRESS.md gracefully', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const output = [];
    const result = captureThreadSnapshot({
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 even when PROGRESS.md missing');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('completes within timeout', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const start = Date.now();
    const result = captureThreadSnapshot({
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `should complete in <5s (took ${elapsed}ms)`);
    assert.strictEqual(result, 0, 'should complete successfully');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('fails open on errors', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    // Set an unreadable file to trigger an error
    const progressPath = path.join(tmpDir, 'PROGRESS.md');
    fs.writeFileSync(progressPath, 'test');
    fs.chmodSync(progressPath, 0o000);

    const result = captureThreadSnapshot({
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    // Even on error, should return 0 (fail open)
    assert.strictEqual(result, 0, 'should return 0 (fail open) even on error');

    // Restore perms for cleanup
    fs.chmodSync(progressPath, 0o644);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});
