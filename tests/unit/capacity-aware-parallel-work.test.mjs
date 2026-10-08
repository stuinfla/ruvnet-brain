import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  describeMeasurement,
  effectiveAgentRecommendation,
  formatAdvisory,
  hardwareAgentCeiling,
  isSubstantialParallelWork,
  managedParallelismPlan,
  parseMacPressureOutput,
  pressureRecommendation,
  runCapacityHook,
  UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING,
} from '../../plugin/scripts/capacity-aware-parallel-work.mjs';

it.each(['Update 3 files.', 'Use a swarm.', 'Change architecture boundaries.', 'Fix QA behavior.', 'Change release publication behavior.', 'Implement independent workstreams for backend and frontend.'])('accepted classifier joins existing parallel choice: %s', originalPrompt => {
  const tasks=['a','b'].map(id=>({id,dependsOn:[],ownership:{mode:'read'}}));
  const plan=managedParallelismPlan(tasks,2,undefined,originalPrompt);
  expect(plan.classifierRequired).toBe(true);expect(plan.plannedChoice).toBe('parallel');expect(plan.serialReason).toBeNull();
  const serial=managedParallelismPlan(tasks,1,undefined,originalPrompt);
  expect(serial.plannedChoice).toBe('serial');expect(serial.serialReason).toContain('Configured child ceiling');
});

it.each(['Explain how to update 3 files.', 'Do not use a swarm; fix 3 files.', 'Fix a typo in README.md.'])('nonforcing classification stays silent: %s', originalPrompt => {
  const plan=managedParallelismPlan([{id:'a',dependsOn:[],ownership:{mode:'read'}}],2,undefined,originalPrompt);
  expect(plan.classifierRequired).toBe(false);
});

it('records real DAG eligibility and concrete serial constraints without claiming execution', () => {
  const task = (id, dependsOn = [], mode = 'read') => ({ id, dependsOn, ownership: { mode } });
  const independent = managedParallelismPlan([task('a'), task('b'), task('writer', ['a', 'b'], 'write')], 3);
  expect(independent.plannedIndependentReadPairs).toBe(1); expect(independent.serialReason).toBeNull();
  expect(independent.evidenceScope).toContain('plan only');
  const chain = managedParallelismPlan([task('a'), task('b', ['a']), task('c', ['b'])], 3);
  expect(chain.plannedIndependentReadPairs).toBe(0); expect(chain.serialReason).toContain('Dependency ordering');
  expect(managedParallelismPlan([task('a'), task('b')], 1).serialReason).toContain('Configured child ceiling');
  expect(() => managedParallelismPlan([task('a')], 3, 'serial')).toThrow('Concrete bounded serial reason');
});
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

  it.each(['Implement changes across 3 files.','Use a swarm to fix this tiny bug.','Use a swarm.','Refactor the release behavior.','Change the architecture contract.','Update the QA gate behavior.','Implement changes across three files.','Use parallel agents for this tiny fix.','Fix a tiny bug in release behavior.'])('routes clear required parallel-work intent upward: %s',prompt=>{
    expect(isSubstantialParallelWork(prompt)).toBe(true);
    expect(runCapacityHook(JSON.stringify({prompt}),healthy)).toContain('no workers were started');
  });
  it.each(['Can you explain how to implement changes across 3 files?','Explain how a swarm fixes tiny bugs.','Define the architecture contract.','Review release notes for a tiny typo.','Do not use a swarm to implement changes across 3 files.','Fix the release behavior without delegation.','Fix this tiny bug without a swarm.','Rename one variable in this function.','Fix a tiny typo in QA documentation.','Fix a tiny typo in the architecture docs.','Do not use parallel agents to change release behavior.','Fix the release behavior without delegating.','Implement changes across 2 files.'])('preserves informational, nondelegated and genuine trivial intent: %s',prompt=>{
    expect(isSubstantialParallelWork(prompt)).toBe(false);
    expect(runCapacityHook(JSON.stringify({prompt}),healthy)).toBe('');
  });
  it('uses memory pressure, swap, compression, and normalized load rather than raw free RAM', () => {
    expect(pressureRecommendation(healthy)).toMatchObject({ tier: 'available', totalAgents: null });
    expect(pressureRecommendation({ ...healthy, freePct: 64, compressorBytes: 30.7 * GIB, normalizedLoad: 0.52 }))
      .toMatchObject({ tier: 'moderate', totalAgents: 5 });
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

  // Owner rule 2026-09-30: the M3 Max (16 cores / 128 GB) must actually be used. Before this the hook
  // capped every machine at 4 total agents, and when the memory probe timed out under load it fell to
  // 'unknown' = ONE agent — the opposite of the situation that needs measuring.
  it('scales the agent ceiling to the machine and never reads a measurable CPU as unknown', () => {
    expect(hardwareAgentCeiling(16)).toBe(10);
    expect(hardwareAgentCeiling(8)).toBe(6);
    expect(hardwareAgentCeiling(4)).toBe(UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING);
    expect(hardwareAgentCeiling(null)).toBe(UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING);
    // idle big machine: go wide; busy: owner thresholds (<50% wide, >75% three, oversubscribed one)
    expect(effectiveAgentRecommendation(healthy, { cores: 16 })).toMatchObject({ tier: 'available', totalAgents: 10 });
    expect(effectiveAgentRecommendation({ ...healthy, normalizedLoad: 0.6 }, { cores: 16 })).toMatchObject({ tier: 'moderate', totalAgents: 5 });
    expect(effectiveAgentRecommendation({ ...healthy, normalizedLoad: 0.8 }, { cores: 16 })).toMatchObject({ tier: 'high-cpu', totalAgents: 3 });
    // a host-reported cap still wins over the hardware ceiling
    expect(effectiveAgentRecommendation(healthy, { cores: 16, runtimeTotalAgentCap: 6 }).totalAgents).toBe(6);
    // memory probe timed out: only the load average is known — classify by load, do not collapse to serial
    expect(pressureRecommendation({ normalizedLoad: 0.2 })).toMatchObject({ tier: 'available', totalAgents: null });
    expect(pressureRecommendation({ normalizedLoad: 0.6 })).toMatchObject({ tier: 'moderate', totalAgents: 5 });
    expect(pressureRecommendation({ normalizedLoad: 0.8 })).toMatchObject({ tier: 'high-cpu', totalAgents: 3 });
    expect(pressureRecommendation({ normalizedLoad: 1.79 })).toMatchObject({ tier: 'constrained', totalAgents: 1 });
    // truly nothing measurable stays serial
    expect(pressureRecommendation({})).toMatchObject({ tier: 'unknown', totalAgents: 1 });
    expect(pressureRecommendation({ normalizedLoad: Number.NaN })).toMatchObject({ tier: 'unknown', totalAgents: 1 });
  });

  it('prints the measured numbers so the owner can check the recommendation', () => {
    const line = describeMeasurement({ ...healthy, loadAvg1: 3.2, normalizedLoad: 0.2 }, 16);
    expect(line).toContain('16 cores');
    expect(line).toContain('128 GB RAM');
    expect(line).toContain('load 3.2 (0.20/core)');
    expect(line).toContain('memory 86% free');
    expect(line).toContain('no swap');
    expect(describeMeasurement({ normalizedLoad: 0.4 }, 16)).toContain('load 0.40/core');
    expect(describeMeasurement(null, 16)).toBe('capacity measurement unavailable');
    const advisory = runCapacityHook(JSON.stringify({
      prompt: 'Implement the cross-cutting auth change across API, CLI, docs, and tests; split independent workstreams.',
    }), { ...healthy, loadAvg1: 3.2 });
    expect(advisory).toContain('Measured just now:');
    expect(advisory).toContain('State these numbers to the owner');
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
    for(const prompt of ['Implement changes across 3 files.','Use a swarm to fix this tiny bug.','Refactor the release behavior.']){
      const result=invoke(prompt);expect(result.status).toBe(0);expect(result.stdout).toContain('Capacity-aware parallel-work advisory');
      expect(result.stdout).toContain('no workers were started');expect(result.stdout).toContain('no dispatch or progress authority');
    }
    for(const prompt of ['Can you explain how to implement changes across 3 files?','Do not use a swarm to fix this tiny bug.','Review release notes for a tiny typo.']){
      const result=invoke(prompt);expect(result.status).toBe(0);expect(result.stdout).toBe('');
    }
    const trivial = invoke('Rename one variable in this function.');
    expect(trivial.status).toBe(0);
    expect(trivial.stdout).toBe('');

    fs.mkdirSync(env.RUVNET_BRAIN_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.RUVNET_BRAIN_STATE_DIR, 'brain-off'), 'off');
    const off = invoke('Implement the cross-cutting auth change across API, CLI, docs, and tests; split independent workstreams.');
    expect(off.status).toBe(0);
    expect(off.stdout).toBe('');
    expect(off.stderr).toBe('');
    fs.unlinkSync(path.join(env.RUVNET_BRAIN_STATE_DIR, 'brain-off'));
    expect(invoke('Implement the cross-cutting auth change across API, CLI, docs, and tests; split independent workstreams.').stdout)
      .toContain('Capacity-aware parallel-work advisory');
  });

  it('does not execute the capacity body at all while OFF', () => {
    const home = tempDir('capacity-off-home-');
    const brainHome = path.join(home, 'brain');
    const scripts = path.join(brainHome, 'versions', '9.9.9', 'scripts');
    const stateDir = path.join(home, 'state');
    const marker = path.join(home, 'body-executed');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(scripts, 'capacity-aware-parallel-work.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('BODY');`);
    fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({ generation: 1, version: '9.9.9', codeRoot: 'versions/9.9.9' }));
    fs.writeFileSync(path.join(brainHome, '.spine-seeded'), 'yes');
    const invoke = () => spawnSync(process.execPath, [SHIM, 'capacity-aware-parallel-work'], {
      env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: stateDir },
      input: JSON.stringify({ prompt: 'Implement a large cross-cutting change across API, CLI and tests.' }),
      encoding: 'utf8', timeout: 3000,
    });
    expect(invoke().stdout).toContain('BODY');
    fs.unlinkSync(marker);
    fs.writeFileSync(path.join(stateDir, 'brain-off'), 'off');
    expect(invoke()).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
