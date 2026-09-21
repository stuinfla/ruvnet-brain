import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  effectiveAgentRecommendation,
  formatAdvisory,
  isSubstantialParallelWork,
  parseMacPressureOutput,
  pressureRecommendation,
  runCapacityHook,
  UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING,
} from '../../plugin/scripts/capacity-aware-parallel-work.mjs';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const HOOKS = [
  path.join(ROOT, 'plugin/hooks/hooks.json'),
  path.join(ROOT, 'plugin/hooks/codex-hooks.json'),
];
const GIB = 1024 ** 3;
const healthy = {
  freePct: 86,
  swapUsedBytes: 0,
  compressorBytes: 10 * GIB,
  totalMemoryBytes: 128 * GIB,
  normalizedLoad: 0.2,
};
let tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('capacity-aware parallel-work hook', () => {
  it('recognizes substantial independent work while leaving ordinary and trivial prompts silent', () => {
    const large = 'Implement the cross-cutting auth change across API, CLI, docs, and tests; split independent workstreams.';
    expect(isSubstantialParallelWork(large)).toBe(true);
    expect(isSubstantialParallelWork('Rename one variable in this function and run the test.')).toBe(false);
    expect(isSubstantialParallelWork('Can you define what a swarm is?')).toBe(false);
    expect(runCapacityHook(JSON.stringify({ prompt: 'Fix a tiny typo in README.' }), healthy)).toBe('');
    expect(runCapacityHook('not json', healthy)).toBe('');
  });

  it('uses memory pressure, swap, compression, and normalized load rather than raw free RAM', () => {
    expect(pressureRecommendation(healthy)).toMatchObject({ tier: 'available', totalAgents: null });
    expect(pressureRecommendation({ ...healthy, freePct: 64, compressorBytes: 30.7 * GIB, normalizedLoad: 0.52 }))
      .toMatchObject({ tier: 'moderate', totalAgents: 2 });
    expect(pressureRecommendation({ ...healthy, freePct: 64, swapUsedBytes: 1 }))
      .toMatchObject({ tier: 'constrained', totalAgents: 1 });
    expect(pressureRecommendation({ ...healthy, normalizedLoad: 0.85 }))
      .toMatchObject({ tier: 'high-cpu', totalAgents: 3 });
    expect(pressureRecommendation(null)).toMatchObject({ tier: 'unknown', totalAgents: 1 });
    expect(pressureRecommendation({ ...healthy, normalizedLoad: 1.1 }))
      .toMatchObject({ tier: 'constrained', totalAgents: 1 });
  });

  it('parses macOS memory-pressure, swap, and compressor output into evidence fields', () => {
    const output = [
      'The system has 8388608 pages with a page size of 16384 bytes.',
      'System-wide memory free percentage: 64%',
      'vm.swapusage: total = 1024.00M used = 0.00M free = 1024.00M',
      'Pages occupied by compressor: 2011955.',
    ].join('\n');
    expect(parseMacPressureOutput(output, { totalMemoryBytes: 128 * GIB, normalizedLoad: 0.52 })).toEqual({
      freePct: 64,
      swapUsedBytes: 0,
      compressorBytes: 2011955 * 16384,
      totalMemoryBytes: 128 * GIB,
      normalizedLoad: 0.52,
    });
    expect(parseMacPressureOutput('incomplete', { totalMemoryBytes: 128 * GIB, normalizedLoad: 0.5 })).toBeNull();
  });

  it('clamps configured concurrency to the hard conservative ceiling and lower runtime caps', () => {
    expect(UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING).toBe(4);
    expect(effectiveAgentRecommendation(healthy, { configuredMaxChildren: 100 })
      .totalAgents).toBe(4);
    expect(effectiveAgentRecommendation(healthy, { configuredMaxChildren: 7, runtimeTotalAgentCap: 2 }))
      .toMatchObject({ totalAgents: 2, workers: 1, runtimeCapKnown: true });
    expect(effectiveAgentRecommendation(healthy, { configuredMaxChildren: 7, runtimeTotalAgentCap: 4 }))
      .toMatchObject({ totalAgents: 4, runtimeCapKnown: true });
    expect(effectiveAgentRecommendation(healthy, { configuredMaxChildren: 7, runtimeTotalAgentCap: 8, workUnitCount: 7 }))
      .toMatchObject({ totalAgents: 8, runtimeCapKnown: true });
    expect(effectiveAgentRecommendation(healthy, { configuredMaxChildren: 7, runtimeTotalAgentCap: 8, workUnitCount: 3 }))
      .toMatchObject({ totalAgents: 4, runtimeCapKnown: true });
    expect(effectiveAgentRecommendation(healthy).runtimeCapKnown).toBe(false);
    const forwarded = runCapacityHook(JSON.stringify({
      prompt: 'Implement the cross-cutting auth change across API, CLI, docs, and tests; split independent workstreams.',
      configured_max_children: 7,
      runtime_total_agent_cap: 2,
    }), healthy);
    expect(forwarded).toContain('no more than 2 total agents');
    expect(forwarded).toContain('host-reported runtime cap');
  });

  it('tells the coordinator to use real tools and fail open to serial work when tools or slots are absent', () => {
    const advisory = formatAdvisory(effectiveAgentRecommendation(null));
    expect(advisory).toContain('no workers were started');
    expect(advisory).toContain('live runtime/tool cap');
    expect(advisory).toContain('If a real agent-spawn/task tool is available');
    expect(advisory).toContain('continue serially');
    expect(advisory).toContain('do not claim parallel workers exist');
  });

  it('is registered on both measured prompt surfaces and through the shared continuity allowlist', () => {
    expect(continuityRegistrations('claude', 'UserPromptSubmit').map((entry) => entry.id))
      .toContain('capacity-aware-parallel-work');
    expect(continuityRegistrations('codex', 'UserPromptSubmit').map((entry) => entry.id))
      .toContain('capacity-aware-parallel-work');
    for (const file of HOOKS) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const registrations = manifest.hooks.UserPromptSubmit.flatMap((group) => group.hooks);
      expect(registrations.some((entry) => entry.command.includes('capacity-aware-parallel-work'))).toBe(true);
    }
  });

  it('runs through the shipped shim, injects context for large work, and exits silently on a trivial prompt', () => {
    const home = tempDir('capacity-hook-home-');
    const plugin = path.join(ROOT, 'plugin');
    const env = {
      ...process.env,
      HOME: home,
      RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'),
      CLAUDE_PLUGIN_ROOT: plugin,
    };
    const invoke = (prompt) => spawnSync(process.execPath, [SHIM, 'capacity-aware-parallel-work'], {
      cwd: ROOT,
      env,
      input: JSON.stringify({ prompt }),
      encoding: 'utf8',
      timeout: 3000,
    });
    const large = invoke('Implement the cross-cutting auth change across API, CLI, docs, and tests; split independent workstreams.');
    expect(large.status).toBe(0);
    expect(large.stdout).toContain('Capacity-aware parallel-work advisory');
    expect(large.stdout).toContain('no workers were started');
    const trivial = invoke('Rename one variable in this function.');
    expect(trivial.status).toBe(0);
    expect(trivial.stdout).toBe('');
  });
});
