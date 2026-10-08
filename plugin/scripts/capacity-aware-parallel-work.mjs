#!/usr/bin/env node
/**
 * UserPromptSubmit advisory for substantial work with independent workstreams.
 *
 * This hook classifies only the submitted prompt and samples local pressure signals. It NEVER
 * creates agents or claims that agents are running. The coordinator still has to check the live
 * agent tools and runtime concurrency ceiling, then spawn real workers and inspect their results.
 * Missing or malformed input, unavailable probes, and unexpected errors are silent and fail open.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHarnessGenerated } from './hook-input.mjs';

export const UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING = 4;
const INPUT_LIMIT = 32 * 1024;
const PROBE_TIMEOUT_MS = 450;
const GIB = 1024 ** 3;

const ACTION = /\b(?:build|implement|refactor|migrate|investigate|audit|review|design|fix|add|remove|optimi[sz]e|plan|execute|ship)\b/i;
const EXPLICIT_FANOUT = /\b(?:parallel(?:ize|ise)?|swarm|delegate|spawn (?:real )?agents?|independent workstreams?|separate owners?)\b/i;
// Clear requests classify work only; admission and effect authority remain in the existing controller.
const INFORMATIONAL = /^(?:what\b|why\b|how\b|explain\b|describe\b|define\b|tell me\b|can you (?:explain|describe|define)\b)/i;
const NO_FANOUT = /\b(?:do not|don't|never)\s+(?:(?:use|run|start|launch|create|spawn)\s+(?:(?:a|any|the|real)\s+)?(?:swarm|(?:parallel\s+)?agents?|parallel work)|delegate|parallelize|parallelise)\b|\b(?:without|avoid|no)\s+(?:a\s+)?(?:swarm|agents?|delegat(?:ion|ing)|parallel(?:ism| work)?)\b|\b(?:keep|remain|stay|work)\s+(?:this\s+|the task\s+)?(?:serial|single[- ]agent)\b/i;
const AFFIRMATIVE_FANOUT = /\b(?:use|run|start|launch|create|spawn)\s+(?:(?:a|the|real)\s+)?(?:swarm|(?:parallel\s+)?agents?|agent team)\b|\b(?:parallelize|parallelise|delegate)\b/i;
const THREE_PLUS_FILES = /\b(?:[3-9]|[1-9]\d+|three|four|five|six|seven|eight|nine|ten)\s+(?:source\s+)?files?\b/i;
const CHANGE_ACTION = /\b(?:build|implement|refactor|migrate|design|fix|add|remove|change|update|modify|rework|revise)\b/i;
const CONSEQUENTIAL_SCOPE = /\b(?:architecture|architectural|qa|quality[- ]assurance)\b|\brelease\s+(?:(?:publication|publishing)\s+)?(?:behavior|behaviour|contract|policy|pipeline|gates?|process)\b/i;
const BROAD_SCOPE = /\b(?:cross[- ]cutting|end[- ]to[- ]end|multi[- ]step|large[- ]scale|whole (?:repo|repository|codebase|system)|entire (?:repo|repository|codebase|system)|full (?:repo|repository|codebase|system)|across (?:the )?(?:repo|repository|codebase|system)|multiple (?:modules|files|packages|components|services)|several (?:modules|files|packages|components|services|workstreams))\b/i;
const TRIVIAL_SCOPE = /\b(?:tiny|trivial|simple|single[- ]line|one[- ]line|small typo|rename (?:one|a|single) variable|format one file|just (?:a )?quick fix)\b/i;
const TRIVIAL_TEXT_EDIT = /\b(?:typos?|spelling|formatting)\b|\bformat one file\b|\brename (?:one|a|single) variable\b/i;
const COMPONENTS = [
  /\bapi\b/i, /\bcli\b/i, /\bui\b|\bfront[- ]end\b|\binterface\b/i,
  /\btests?\b|\bqa\b/i, /\bdocs?\b|\bdocumentation\b/i,
  /\bdata(?:base| layer| model)?\b|\bschema\b/i, /\bsecurity\b/i,
  /\binfra(?:structure)?\b|\bdeployment\b/i, /\bhooks?\b/i,
  /\binstaller\b|\bpackaging\b/i, /\bruntime\b/i,
];

function estimateWorkUnitCount(prompt) {
  const componentCount = COMPONENTS.reduce((n, re) => n + Number(re.test(prompt)), 0);
  if (componentCount >= 2) return componentCount;
  const numberedItems = [...prompt.matchAll(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S/g)].length;
  return numberedItems >= 2 ? numberedItems : null;
}

export function isSubstantialParallelWork(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text || INFORMATIONAL.test(text) || NO_FANOUT.test(text)) return false;
  if (AFFIRMATIVE_FANOUT.test(text)) return true;
  if (CHANGE_ACTION.test(text) && THREE_PLUS_FILES.test(text)) return true;
  if (TRIVIAL_SCOPE.test(text) && TRIVIAL_TEXT_EDIT.test(text)) return false;
  if (CHANGE_ACTION.test(text) && CONSEQUENTIAL_SCOPE.test(text)) return true;
  if (TRIVIAL_SCOPE.test(text) || !ACTION.test(text)) return false;
  if (EXPLICIT_FANOUT.test(text)) return true;
  const breadth = BROAD_SCOPE.test(text);
  const componentCount = COMPONENTS.reduce((n, re) => n + Number(re.test(text)), 0);
  const numberedItems = [...text.matchAll(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S/g)].length;
  return (breadth && componentCount >= 2) || componentCount >= 3 || numberedItems >= 3;
}

function parseUsedBytes(text) {
  const match = String(text).match(/\bused\s*=\s*([\d.]+)\s*([KMGT]?)B?\b/i);
  if (!match) return null;
  const scale = { '': 1, K: 1024, M: 1024 ** 2, G: GIB, T: 1024 ** 4 }[match[2].toUpperCase()];
  const value = Number(match[1]) * scale;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseMacPressureOutput(text, { totalMemoryBytes, normalizedLoad }) {
  const source = String(text || '');
  const freeMatch = source.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  const pageSizeMatch = source.match(/page size of\s+([\d,]+)\s+bytes/i);
  const compressorMatch = source.match(/Pages occupied by compressor:\s*([\d,]+)/i);
  const swapMatch = source.match(/vm\.swapusage:.*?used\s*=\s*([\d.]+)\s*([KMGT]?)B?\b/i);
  if (!freeMatch || !pageSizeMatch || !compressorMatch || !swapMatch) return null;
  const pageSize = Number(pageSizeMatch[1].replaceAll(',', ''));
  const compressedPages = Number(compressorMatch[1].replaceAll(',', ''));
  const swapUsedBytes = parseUsedBytes(`used = ${swapMatch[1]}${swapMatch[2]}B`);
  const freePct = Number(freeMatch[1]);
  const compressorBytes = pageSize * compressedPages;
  if (![pageSize, compressedPages, swapUsedBytes, freePct, totalMemoryBytes, normalizedLoad]
    .every(Number.isFinite) || pageSize <= 0 || compressedPages < 0 || totalMemoryBytes <= 0
    || freePct < 0 || freePct > 100 || normalizedLoad < 0) return null;
  return { freePct, swapUsedBytes, compressorBytes, totalMemoryBytes, normalizedLoad };
}

/**
 * The total-agent ceiling when no host cap is reported, scaled to the machine. Owner rule (2026-09-30):
 * a big machine must be used — 16 cores / 128 GB is ~10 agents when idle; small or unmeasured machines
 * keep the conservative 4.
 */
export function hardwareAgentCeiling(cores) {
  if (!Number.isInteger(cores) || cores < 1) return UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING;
  if (cores >= 12) return 10;
  if (cores >= 8) return 6;
  return UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING;
}

/**
 * Classify measured pressure. Memory probes can time out on a loaded machine, so a sample carrying only
 * the load average is classified by load alone (an unmeasurable memory state must not silently turn a
 * 16-core machine into a one-agent machine). Nothing measurable at all recommends serial work.
 */
export function pressureRecommendation(sample) {
  const memoryKnown = !!sample && [
    sample.freePct, sample.swapUsedBytes, sample.compressorBytes, sample.totalMemoryBytes,
  ].every(Number.isFinite) && sample.totalMemoryBytes > 0;
  if (sample && !memoryKnown && Number.isFinite(sample.normalizedLoad) && sample.normalizedLoad >= 0) {
    const load = sample.normalizedLoad;
    if (load >= 1) return { tier: 'constrained', totalAgents: 1, reason: 'CPU oversubscribed (load-only measurement)' };
    if (load >= 0.75) return { tier: 'high-cpu', totalAgents: 3, reason: 'CPU pressure is high (load-only measurement)' };
    if (load >= 0.55) return { tier: 'moderate', totalAgents: 5, reason: 'CPU headroom is partial (load-only measurement)' };
    return { tier: 'available', totalAgents: null, reason: 'CPU headroom is available (load-only measurement)' };
  }
  if (!sample || !memoryKnown || !Number.isFinite(sample.normalizedLoad)) {
    return { tier: 'unknown', totalAgents: 1, reason: 'capacity signals unavailable' };
  }
  const compressedRatio = sample.compressorBytes / sample.totalMemoryBytes;
  if (sample.freePct < 45 || sample.swapUsedBytes > 0 || compressedRatio >= 0.4
    || sample.normalizedLoad >= 1) {
    return { tier: 'constrained', totalAgents: 1, reason: 'resource pressure is high' };
  }
  // The local load-per-logical-core signal is a bounded CPU-pressure proxy, not a claim to a
  // precise CPU utilization sample. Above 75% it trims fan-out to three total agents.
  if (sample.normalizedLoad >= 0.75) {
    return { tier: 'high-cpu', totalAgents: 3, reason: 'CPU pressure is high' };
  }
  if (sample.freePct < 75 || compressedRatio >= 0.2 || sample.normalizedLoad >= 0.55) {
    return { tier: 'moderate', totalAgents: 5, reason: 'resource headroom is partial' };
  }
  return { tier: 'available', totalAgents: null, reason: 'measured headroom is available' };
}

/**
 * Apply lower configured/runtime caps after pressure sizing. A configured worker ceiling never
 * proves runtime availability; an authoritative runtime cap, when supplied by the host, wins.
 */
export function effectiveAgentRecommendation(sample, {
  configuredMaxChildren = null,
  runtimeTotalAgentCap = null,
  workUnitCount = null,
  cores = null,
} = {}) {
  const pressure = pressureRecommendation(sample);
  const runtimeCapKnown = Number.isInteger(runtimeTotalAgentCap) && runtimeTotalAgentCap >= 1;
  const ceiling = hardwareAgentCeiling(cores);
  // A host-reported cap is authoritative over the hardware ceiling; pressure tiers never exceed it.
  const limits = [pressure.totalAgents === null
    ? (runtimeCapKnown ? runtimeTotalAgentCap : ceiling)
    : Math.min(pressure.totalAgents, ceiling)];
  if (Number.isInteger(configuredMaxChildren) && configuredMaxChildren >= 0) {
    limits.push(configuredMaxChildren + 1); // configured workers plus the coordinating agent
  }
  if (runtimeCapKnown) {
    limits.push(runtimeTotalAgentCap);
  }
  if (Number.isInteger(workUnitCount) && workUnitCount >= 0) limits.push(workUnitCount + 1);
  const totalAgents = Math.min(...limits);
  return {
    ...pressure,
    totalAgents,
    workers: Math.max(0, totalAgents - 1),
    runtimeCapKnown,
  };
}

/** Plan evidence only; the existing AK controller performs admission and execution. */
export function managedParallelismPlan(tasks, maxConcurrent, serialReason, originalPrompt) {
  if (serialReason !== undefined && (typeof serialReason !== 'string' || serialReason.trim().length < 12 || serialReason.length > 500)) throw new TypeError('Concrete bounded serial reason required');
  const precedes = (id, target) => tasks.find(task => task.id === id).dependsOn?.some(dep => dep === target || precedes(dep, target)) || false;
  const readers = tasks.filter(task => task.ownership.mode === 'read'); let pairs = 0;
  for (const [index, task] of readers.entries()) for (const other of readers.slice(index + 1)) if (!precedes(task.id, other.id) && !precedes(other.id, task.id)) pairs++;
  const classifierRequired=typeof originalPrompt==='string'?isSubstantialParallelWork(originalPrompt):null;
  const plannedChoice=maxConcurrent>1&&pairs>0?'parallel':'serial';
  const reason=serialReason?.trim() ?? (maxConcurrent === 1 ? 'Configured child ceiling permits one worker' : pairs ? null
    : tasks.length === 1 ? 'One scoped task; no independent branch in the validated DAG' : 'Dependency ordering or exclusive writer prevents independent read overlap');
  if(classifierRequired&&plannedChoice==='serial'&&!(typeof reason==='string'&&reason.length>=12))throw new TypeError('Classifier-required serial work needs a concrete reason');
  return { taskDag: tasks.map(task => ({ id: task.id, dependsOn: task.dependsOn ?? [], mode: task.ownership.mode })),
    classifierRequired,plannedChoice,
    plannedIndependentReadPairs: pairs, configuredChildCeiling: maxConcurrent, evidenceScope: 'plan only; admission is controller-local, not a global resource lease',
    serialReason: reason };
}

function readInput() {
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  let total = 0;
  while (total < INPUT_LIMIT) {
    const count = fs.readSync(0, buffer, 0, Math.min(buffer.length, INPUT_LIMIT - total), null);
    if (!count) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    total += count;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The load average alone, from the OS. Used when the macOS memory probe times out (it does, under
// exactly the heavy load that matters) and on other platforms. Windows reports no load average, so it
// stays unmeasured there rather than reading as an idle machine.
function collectLoadOnly() {
  if (process.platform === 'win32') return null;
  const cpuCount = os.cpus().length;
  const load = os.loadavg()[0];
  if (!cpuCount || !Number.isFinite(load) || load < 0) return null;
  return { normalizedLoad: load / cpuCount, loadAvg1: load };
}

export function collectMacPressure() {
  if (process.platform !== 'darwin') return collectLoadOnly();
  try {
    // One bounded subprocess gathers pressure, swap, and compressor bytes. Never use raw free RAM
    // as the capacity signal; memory_pressure, actual swap, compression, and normalized load drive
    // the tier. The hook intentionally does not wait for a timed CPU sample.
    const probe = spawnSync('/bin/sh', ['-c', '/usr/bin/memory_pressure -Q; /usr/sbin/sysctl vm.swapusage; /usr/bin/vm_stat'], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 24 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    if (probe.error || probe.status !== 0) return collectLoadOnly();
    const cpuCount = os.cpus().length;
    const load = os.loadavg()[0];
    if (!cpuCount || !Number.isFinite(load) || load < 0) return null;
    const parsed = parseMacPressureOutput(probe.stdout, {
      totalMemoryBytes: os.totalmem(), normalizedLoad: load / cpuCount,
    });
    return parsed ? { ...parsed, loadAvg1: load } : collectLoadOnly();
  } catch {
    return collectLoadOnly();
  }
}

/** The numbers behind the recommendation, so the owner can check them (owner 2026-09-30). */
export function describeMeasurement(sample, cores) {
  if (!sample || !Number.isFinite(sample.normalizedLoad)) return 'capacity measurement unavailable';
  const parts = [];
  if (Number.isInteger(cores) && cores > 0) parts.push(`${cores} cores`);
  if (Number.isFinite(sample.totalMemoryBytes) && sample.totalMemoryBytes > 0) parts.push(`${Math.round(sample.totalMemoryBytes / GIB)} GB RAM`);
  parts.push(Number.isFinite(sample.loadAvg1) ? `load ${sample.loadAvg1.toFixed(1)} (${sample.normalizedLoad.toFixed(2)}/core)` : `load ${sample.normalizedLoad.toFixed(2)}/core`);
  if (Number.isFinite(sample.freePct)) parts.push(`memory ${Math.round(sample.freePct)}% free`);
  if (Number.isFinite(sample.swapUsedBytes)) parts.push(sample.swapUsedBytes > 0 ? 'swap in use' : 'no swap');
  return parts.join(', ');
}

export function formatAdvisory(recommendation, measured = null) {
  const n = recommendation.totalAgents;
  const runtime = recommendation.runtimeCapKnown
    ? 'Do not exceed the host-reported runtime cap; configured concurrency is only a ceiling.'
    : `This hook cannot see the live runtime/tool cap; ${n} total is this machine's measured ceiling until the coordinator checks it. Configured concurrency is not proof of available slots.`;
  const workerPlan = recommendation.workers > 0
    ? `At most ${recommendation.workers} worker agent${recommendation.workers === 1 ? '' : 's'}`
    : 'No additional worker agents';
  return [
    'Capacity-aware parallel-work advisory (context only; no workers were started).',
    ...(measured ? [`Measured just now: ${measured}. State these numbers to the owner when you size a fan-out, and never claim parallel workers that are not running.`] : []),
    `This prompt appears to contain independent work. Resource tier: ${recommendation.tier}; recommend no more than ${n} total agent${n === 1 ? '' : 's'} including the coordinator (${workerPlan}).`,
    `${runtime} Treat configured concurrency as a ceiling only; never infer that configured slots are available.`,
    'If a real agent-spawn/task tool is available and slots remain, launch actual workers now with non-overlapping deliverables and collect their results. If tools or slots are unavailable, continue serially and do not claim parallel workers exist.',
    'Require an explicit task DAG with useful independent branches, or a concrete serial reason. The managed AK controller enforces admission; this native hook has no dispatch or progress authority.',
  ].join('\n');
}

export function runCapacityHook(rawInput, sample) {
  let input;
  try { input = JSON.parse(String(rawInput || '')); } catch { return ''; }
  const prompt = input?.prompt ?? input?.user_prompt ?? input?.input;
  // H2: a background task notification or other harness-authored message reads as substantial
  // "independent work" prose but nobody wrote it — never advise a parallel-work fan-out off of one.
  if (isHarnessGenerated(prompt)) return '';
  if (!isSubstantialParallelWork(prompt)) return '';
  const measuredSample = sample === undefined ? collectMacPressure() : sample;
  const cores = os.cpus().length;
  return formatAdvisory(effectiveAgentRecommendation(measuredSample, {
    configuredMaxChildren: input?.configured_max_children,
    runtimeTotalAgentCap: input?.runtime_total_agent_cap,
    workUnitCount: input?.independent_workstream_count ?? estimateWorkUnitCount(prompt),
    cores,
  }), describeMeasurement(measuredSample, cores));
}

function main() {
  try {
    const output = runCapacityHook(readInput());
    if (output) process.stdout.write(`${output}\n`);
  } catch {
    // This advisory has no authority to block or delay user work when anything is unavailable.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
