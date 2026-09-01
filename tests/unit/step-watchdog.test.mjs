import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const watchdog = path.join(root, 'scripts/ci/step-watchdog.mjs');

describe('CI step watchdog', () => {
  it('fails a hung child and writes a named timeout receipt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-watchdog-'));
    let error;
    try {
      execFileSync(process.execPath, [watchdog, '--name', 'hung-fixture', '--timeout-ms', '100', '--heartbeat-ms', '25', '--receipt-dir', dir, '--', process.execPath, '-e', 'setTimeout(() => {}, 10000)'], { encoding: 'utf8', timeout: 5000 });
    } catch (caught) { error = caught; }
    expect(error?.status).toBe(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'hung-fixture.json'), 'utf8'));
    expect(receipt.status).toBe('TIMEOUT');
    expect(receipt.name).toBe('hung-fixture');
  });

  it('preserves a successful child result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-watchdog-'));
    execFileSync(process.execPath, [watchdog, '--name', 'quick-fixture', '--timeout-ms', '1000', '--heartbeat-ms', '25', '--receipt-dir', dir, '--', process.execPath, '-e', ''], { encoding: 'utf8' });
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'quick-fixture.json'), 'utf8'));
    expect(receipt.status).toBe('PASS');
    expect(receipt.exitCode).toBe(0);
  });
});
