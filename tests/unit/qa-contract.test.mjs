import { describe, expect, it } from 'vitest';
import { runLanes, verdictOf, sourceIdentity } from '../../scripts/qa-contract.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { qaLanes, selectLanes } from '../../scripts/qa-lanes.mjs';

describe('QA dependency and evidence contract', () => {
  it('CI workflows request only registered shared QA lanes', () => {
    const names = new Set(qaLanes({ release: true }).map(({ name }) => name));
    for (const file of ['ci.yml', 'canonical-qa.yml']) {
      const workflow = fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
      for (const match of workflow.matchAll(/--lane\s+([\w-]+)/g)) {
        expect(names.has(match[1]), `${file}: unregistered lane ${match[1]}`).toBe(true);
      }
    }
  });
  it('selecting claims includes its real coverage prerequisite and rejects unknown lanes', () => {
    const lanes = qaLanes({ release: true });
    expect(selectLanes(lanes, ['claims-source']).map(({ name }) => name)).toEqual(['coverage', 'claims-source']);
    expect(selectLanes(lanes, ['architecture'])[0].args).toEqual(['scripts/product-integrity-contract.mjs', '--check-source']);
    expect(() => selectLanes(lanes, ['absent'])).toThrow();
  });
  it('release acceptance runs the packed cross-host continuity test', () => {
    const lane = selectLanes(qaLanes({ release: true }), ['continuity'])[0];
    expect(lane.args).toEqual(['node_modules/vitest/vitest.mjs', 'run', 'tests/acceptance/cross-host-project-resume.test.mjs']);
    expect(lane.resource).toBe('tests');
  });
  it('runs independent resources concurrently, serializes shared resources, and blocks dependents', async () => {
    let active = 0, maximum = 0;
    const held = new Set();
    const results = await runLanes([
      { name: 'coverage', resource: 'tests' }, { name: 'mesh', resource: 'tests' },
      { name: 'docs', resource: 'static' }, { name: 'claims', dependsOn: ['coverage'] },
    ], async (lane) => {
      expect(held.has(lane.resource)).toBe(false);
      held.add(lane.resource); maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      held.delete(lane.resource); active--;
      return { name: lane.name, status: lane.name === 'coverage' ? 'FAIL' : 'PASS' };
    }, 2);
    expect(maximum).toBe(2);
    expect(results.find((r) => r.name === 'claims').status).toBe('BLOCKED');
    expect(results.find((r) => r.name === 'mesh').status).toBe('PASS');
  });
  it('rejects unknown dependencies and cycles instead of hanging', async () => {
    await expect(runLanes([{ name: 'a', dependsOn: ['absent'] }], async () => ({}))).rejects.toThrow();
    await expect(runLanes([{ name: 'a', dependsOn: ['a'] }], async () => ({}))).rejects.toThrow();
  });
  it('unknown and empty evidence never aggregate to PASS', () => {
    expect(verdictOf([])).toBe('UNKNOWN');
    expect(verdictOf([{ status: 'PASS' }, { status: 'UNKNOWN' }])).toBe('UNKNOWN');
    expect(verdictOf([{ status: 'BLOCKED' }])).toBe('FAIL');
  });
  it('binds dirty untracked bytes without claiming they are the HEAD artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-source-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      fs.writeFileSync(path.join(root, 'source.mjs'), 'one');
      const first = sourceIdentity(root);
      fs.writeFileSync(path.join(root, 'source.mjs'), 'two');
      expect(first.sha).toBe(null);
      expect(first.dirty).toBe(true);
      expect(first.digest).not.toBe(sourceIdentity(root).digest);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
