/**
 * A refused store must say WHY. forge-guard writes its [FAIL] lines to stdout; the updater used to keep only
 * execFileSync's message (command line + stderr), so the cause was lost (canary log, 2026-09-30).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describeGuardFailure } from '../../kb/forge-update.mjs';

describe('describeGuardFailure', () => {
  it('keeps the guard\'s own FAIL line from a REAL failed child process', () => {
    let caught;
    try {
      execFileSync(process.execPath, ['-e', "const w = ['FAI', 'L'].join(''); console.log('  [ok] parity'); console.log('  [' + w + '] TRUNCATION: 3/45 passages clipped'); process.exit(1)"], { stdio: 'pipe' });
    } catch (error) { caught = error; }
    const text = describeGuardFailure(caught);
    expect(text).toMatch(/Command failed/);
    expect(text).toMatch(/\[FAIL\] TRUNCATION: 3\/45 passages clipped/);
    // The FAIL text is built at run time, so it is NOT in the printed command line: it can only have come
    // from the child's stdout. Only FAIL lines are appended; the guard's [ok] lines are not.
    const appended = text.split(' -- ')[1];
    expect(appended).toMatch(/TRUNCATION: 3\/45/);
    expect(appended).not.toMatch(/\[ok\]/);
  });

  it('is exit-safe on odd inputs and bounds its length', () => {
    expect(describeGuardFailure(undefined)).toBe('undefined');
    // the WHOLE message survives (stderr from execFileSync sits on the lines after the command line)
    expect(describeGuardFailure({ message: 'boom\nsecond line' })).toBe('boom\nsecond line');
    const long = { message: 'x', stdout: Buffer.from(`[FAIL] ${'y'.repeat(5000)}`) };
    expect(describeGuardFailure(long).length).toBeLessThan(1000);
  });

  it('is the ONLY way the updater reports a guard failure (the wiring, not just the helper)', () => {
    const source = fs.readFileSync(new URL('../../kb/forge-update.mjs', import.meta.url), 'utf8');
    expect(source).toContain('forge-guard failed: ${describeGuardFailure(error)}');
    expect(source).not.toContain('forge-guard failed: ${error.message}');
  });
});
