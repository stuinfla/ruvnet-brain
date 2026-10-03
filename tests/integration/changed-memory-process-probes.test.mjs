import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Execute production capture/readback boundaries in disposable projects; no owner store is used.
for (const gap of ['G-001', 'G-002', 'G-004', 'G-014']) {
  it(`${gap} executes the changed-feature process acceptance`, () => {
    const run = spawnSync(process.execPath, [`tests/e2e/closure/${gap}.probe.mjs`], {
      encoding: 'utf8', timeout: 90000, env: { ...process.env, RUVNET_TURN_CAPTURE: 'force' },
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
    expect(result.gap).toBe(gap);
    expect(result.evidenceClass).toBe('EXECUTED');
  }, 95000);
}
