import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { qaLanes } from '../../scripts/qa-lanes.mjs';
import { getVersion } from '../../scripts/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('canonical QA runner execution contract', () => {
  it('forwards explicit candidate binding to the strict runtime ledger', () => {
    const args = ['--candidate-kb', '/candidate/kb', '--candidate-sha', 'a'.repeat(40),
      '--candidate-version', getVersion(), '--candidate-root', '/candidate',
      '--payload-manifest', '/sealed/payload-manifest.json', '--payload-id', 'b'.repeat(64),
      '--qualification-mode', 'staged'];
    const lane = qaLanes({ release: true, runtimeCensusArgs: args }).find(({ name }) => name === 'claims-runtime');
    expect(lane.args).toEqual(['scripts/claims-verify.mjs', '--strict', '--scope', 'runtime', ...args]);
    expect(qaLanes({ release: true }).find(({ name }) => name === 'claims-runtime').args)
      .toEqual(['scripts/claims-verify.mjs', '--strict', '--scope', 'runtime']);
  });

  it('passes candidate options through the actual runner CLI without executing lanes', () => {
    const args = ['--candidate-kb', '/candidate/kb', '--candidate-sha', 'a'.repeat(40),
      '--candidate-version', getVersion(), '--candidate-root', '/candidate',
      '--payload-manifest', '/sealed/manifest.json', '--payload-signature', '/sealed/signature',
      '--payload-id', 'b'.repeat(64), '--qualification-mode', 'signed'];
    const child = spawnSync(process.execPath,
      ['scripts/qa-runner.mjs', '--release', '--lane', 'claims-runtime', '--list', ...args],
      { cwd: ROOT, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)[0].args).toEqual(['scripts/claims-verify.mjs', '--strict', '--scope', 'runtime', ...args]);
  });

  it('runs independent lanes concurrently and does not fail fast after the first lane', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/qa-runner.mjs'), 'utf8');

    expect(source).toContain('runLanes(lanes, run, 2)');
    expect(source).toContain('verdictOf(results)');
    expect(source).not.toMatch(/for \(const lane of lanes\) \{[\s\S]*?if \(result\.status !== 'PASS'\) break;/);
  });
});
