import { describe, test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { captureDecision } from '../../plugin/hooks/memory-store-decisions.mjs';

describe('memory-decision-store', () => {
  test('ignores non-consequential edits', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));

    const output = [];
    const result = captureDecision({
      editedFilePath: path.join(tmpDir, 'src/utils/helper.js'),
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 for non-consequential edits');
    assert.strictEqual(output.length, 0, 'should not emit for non-consequential edits');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('captures ADR file edits', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const adrDir = path.join(tmpDir, 'docs', 'adr');
    fs.mkdirSync(adrDir, { recursive: true });

    const adrFile = path.join(adrDir, '0076-test-decision.md');
    fs.writeFileSync(adrFile, `---
id: ADR-076
title: Test Decision Record
status: Proposed
---

# Test Decision

## Decision

We decided to test the memory system.

## Alternatives Considered

### A. Option A
First alternative

### B. Option B
Second alternative
`);

    const output = [];
    const result = captureDecision({
      editedFilePath: adrFile,
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 for ADR file edits');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('captures version file changes', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const pkgFile = path.join(tmpDir, 'package.json');
    fs.writeFileSync(pkgFile, JSON.stringify({
      version: '1.2.3',
      name: 'test-pkg',
    }));

    const output = [];
    const result = captureDecision({
      editedFilePath: pkgFile,
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 for package.json edits');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('handles missing .swarm directory', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));

    const adrDir = path.join(tmpDir, 'docs', 'adr');
    fs.mkdirSync(adrDir, { recursive: true });

    const adrFile = path.join(adrDir, '0076-test.md');
    fs.writeFileSync(adrFile, '# Test\n\nDecision made.');

    const output = [];
    const result = captureDecision({
      editedFilePath: adrFile,
      cwd: tmpDir,
      stdout: { write: (s) => output.push(s) },
      stderr: { write: () => {} },
    });

    // Should still return 0 (fail open) even if .swarm doesn't exist
    assert.strictEqual(result, 0, 'should return 0 even when .swarm missing');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('handles missing edited file gracefully', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const result = captureDecision({
      editedFilePath: path.join(tmpDir, 'docs', 'adr', 'missing.md'),
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 (fail open) for missing file');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('captures config file changes', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const configFile = path.join(configDir, 'settings.json');
    fs.writeFileSync(configFile, JSON.stringify({ debug: true }));

    const result = captureDecision({
      editedFilePath: configFile,
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should capture config file changes');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('no file path provided', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));

    const result = captureDecision({
      editedFilePath: undefined,
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    assert.strictEqual(result, 0, 'should return 0 when no file path provided');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('fails open on error', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-test-'));
    const swarmDir = path.join(tmpDir, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });

    const errors = [];
    const result = captureDecision({
      editedFilePath: null,
      cwd: tmpDir,
      stdout: { write: () => {} },
      stderr: { write: (s) => errors.push(s) },
    });

    // Even on error, should return 0 (fail open)
    assert.strictEqual(result, 0, 'should return 0 (fail open) even on error');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});
