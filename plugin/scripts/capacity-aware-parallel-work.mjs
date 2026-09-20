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

export const UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING = 4;
const INPUT_LIMIT = 32 * 1024;
const PROBE_TIMEOUT_MS = 450;
const GIB = 1024 ** 3;

const ACTION = /\b(?:build|implement|refactor|migrate|investigate|audit|review|design|fix|add|remove|optimi[sz]e|plan|execute|ship)\b/i;
const EXPLICIT_FANOUT = /\b(?:parallel(?:ize|ise)?|swarm|delegate|spawn (?:real )?agents?|independent workstreams?|separate owners?)\b/i;
const BROAD_SCOPE = /\b(?:cross[- ]cutting|end[- ]to[- ]end|multi[- ]step|large[- ]scale|whole (?:repo|repository|codebase|system)|entire (?:repo|repository|codebase|system)|full (?:repo|repository|codebase|system)|across (?:the )?(?:repo|repository|codebase|system)|multiple (?:modules|files|packages|components|services)|several (?:modules|files|packages|components|services|workstreams))\b/i;
const TRIVIAL_SCOPE = /\b(?:tiny|trivial|simple|single[- ]line|one[- ]line|small typo|rename (?:one|a|single) variable|format one file|just (?:a )?quick fix)\b/i;
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
  if (!text || TRIVIAL_SCOPE.test(text) || !ACTION.test(text)) return false;
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

/** Classify measured pressure. Unknown or incomplete measurements recommend serial work. */
export function pressureRecommendation(sample) {
  if (!sample || ![
    sample.freePct, sample.swapUsedBytes, sample.compressorBytes,
    sample.totalMemoryBytes, sample.normalizedLoad,
  ].every(Number.isFinite) || sample.totalMemoryBytes <= 0) {
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
    return { tier: 'moderate', totalAgents: 2, reason: 'resource headroom is partial' };
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
} = {}) {
  const pressure = pressureRecommendation(sample);
  const runtimeCapKnown = Number.isInteger(runtimeTotalAgentCap) && runtimeTotalAgentCap >= 1;
  const limits = [pressure.totalAgents ?? (runtimeCapKnown ? runtimeTotalAgentCap : UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING)];
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

function collectMacPressure() {
  if (process.platform !== 'darwin') return null;
  try {
    // One bounded subprocess gathers pressure, swap, and compressor bytes. Never use raw free RAM
    // as the capacity signal; memory_pressure, actual swap, compression, and normalized load drive
    // the tier. The hook intentionally does not wait for a timed CPU sample.
    const probe = spawnSync('/bin/sh', ['-c', '/usr/bin/memory_pressure -Q; /usr/sbin/sysctl vm.swapusage; /usr/bin/vm_stat'], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 24 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    if (probe.error || probe.status !== 0) return null;
    const cpuCount = os.cpus().length;
    const load = os.loadavg()[0];
    if (!cpuCount || !Number.isFinite(load) || load < 0) return null;
    return parseMacPressureOutput(probe.stdout, {
      totalMemoryBytes: os.totalmem(), normalizedLoad: load / cpuCount,
    });
  } catch {
    return null;
  }
}

export function formatAdvisory(recommendation) {
  const n = recommendation.totalAgents;
  const runtime = recommendation.runtimeCapKnown
    ? 'Do not exceed the host-reported runtime cap; configured concurrency is only a ceiling.'
    : `This hook cannot see the live runtime/tool cap; ${UNKNOWN_RUNTIME_TOTAL_AGENT_CEILING} total is only a conservative ceiling until the coordinator checks it. Configured concurrency is not proof of available slots.`;
  const workerPlan = recommendation.workers > 0
    ? `At most ${recommendation.workers} worker agent${recommendation.workers === 1 ? '' : 's'}`
    : 'No additional worker agents';
  return [
    'Capacity-aware parallel-work advisory (context only; no workers were started).',
    `This prompt appears to contain independent work. Resource tier: ${recommendation.tier}; recommend no more than ${n} total agent${n === 1 ? '' : 's'} including the coordinator (${workerPlan}).`,
    `${runtime} Treat configured concurrency as a ceiling only; never infer that configured slots are available.`,
    'If a real agent-spawn/task tool is available and slots remain, launch actual workers now with non-overlapping deliverables and collect their results. If tools or slots are unavailable, continue serially and do not claim parallel workers exist.',
  ].join('\n');
}

export function runCapacityHook(rawInput, sample) {
  let input;
  try { input = JSON.parse(String(rawInput || '')); } catch { return ''; }
  const prompt = input?.prompt ?? input?.user_prompt ?? input?.input;
  if (!isSubstantialParallelWork(prompt)) return '';
  return formatAdvisory(effectiveAgentRecommendation(sample === undefined ? collectMacPressure() : sample, {
    configuredMaxChildren: input?.configured_max_children,
    runtimeTotalAgentCap: input?.runtime_total_agent_cap,
    workUnitCount: input?.independent_workstream_count ?? estimateWorkUnitCount(prompt),
  }));
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
