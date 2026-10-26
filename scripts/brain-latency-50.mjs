#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const QUESTIONS = [
  ['How does RuvNet Brain expose the rvbc console in Claude Code and Codex?', /repo=ruvnet-brain/i],
  ['What command shows the RuvNet Brain 4.0 upgrade highlights?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain build and include its own source RVF?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain prevent a broad product query from searching every repository?', /repo=ruvnet-brain/i],
  ['What release gates prevent RuvNet Brain from publishing an unverified artifact?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain verify Claude Code plugin installation?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain verify Codex skill discovery?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain display what changed after a 4.0 upgrade?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain detect stale project memory without interrupting the user?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain bind release evidence to an exact Git SHA and artifact digest?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain test narrow, broad, and concurrent source searches?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain distinguish proposed ADR capabilities from shipped code?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain prevent a zero-test QE run from passing?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain verify the public npm and GitHub release surfaces agree?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain update both Claude Code and Codex installations?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain handle model-cache initialization across concurrent processes?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain measure whether grounding evidence is thin or strong?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain stop private stores from entering a public bundle?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain sign and verify its downloadable RVF bundle?', /repo=ruvnet-brain/i],
  ['What does the RuvNet Brain doctor command verify after installation?', /repo=ruvnet-brain/i],
  ['How does RVF provide persistent HNSW vector search?', /repo=ruvector/i],
  ['Which RuVector source implements RVF database creation and querying?', /repo=ruvector/i],
  ['How does RuVector avoid hand-written cosine search for persisted knowledge?', /repo=ruvector/i],
  ['How are witness chains represented in the RVF architecture?', /repo=ruvector/i],
  ['How does RuVector support local embedding generation for vector search?', /repo=ruvector/i],
  ['How does Ruflo initialize and coordinate a hierarchical agent swarm?', /repo=ruflo/i],
  ['How does Ruflo route work to an architect agent?', /repo=ruflo/i],
  ['How does Ruflo store and search project memory?', /repo=ruflo/i],
  ['How does Ruflo track agent execution separately from agent registration?', /repo=ruflo/i],
  ['How does Ruflo enforce policy before consequential actions?', /repo=ruflo/i],
  ['How does AgentDB store structured agent memories?', /repo=agentdb/i],
  ['How does AgentDB perform semantic memory search?', /repo=agentdb/i],
  ['How does AgentDB handle SQLite WAL-backed persistence?', /repo=agentdb/i],
  ['How does AgentDB represent graph relationships between memories?', /repo=agentdb/i],
  ['How does AgentDB prevent unsafe memory input at its boundaries?', /repo=agentdb/i],
  ['How does Agentic QE generate and execute a test fleet?', /repo=agentic-qe/i],
  ['How does Agentic QE report test coverage gaps?', /repo=agentic-qe/i],
  ['How does Agentic QE run security-focused quality checks?', /repo=agentic-qe/i],
  ['How does Agentic QE prevent vacuous success when no tests execute?', /repo=(?:agentic-qe|ruvnet-brain)/i],
  ['How does Agentic QE coordinate specialized testing agents?', /repo=agentic-qe/i],
  ['What phases are defined by the SPARC methodology?', /repo=sparc/i],
  ['How does RuvNet Brain package the managed CLI boundary users invoke?', /repo=ruvnet-brain/i],
  ['How does RuvNet Brain validate that every advertised file exists in the npm tarball?', /repo=ruvnet-brain/i],
  ['How does RuLake act as a read cache over vector collections?', /repo=rulake/i],
  ['How does RuView process radar sensor data?', /repo=ruview/i],
  ['Compare RuvNet Brain project memory with AgentDB structured storage.', /repo=(?:ruvnet-brain|agentdb)/i],
  ['Compare RuvNet Brain source grounding with Ruflo orchestration.', /repo=(?:ruvnet-brain|ruflo)/i],
  ['How should RuvNet Brain enforce an exact-artifact deployment process with clean lineage, GitHub checks, Agentic QE, independent graders, and post-publication verification?', /repo=ruvnet-brain/i],
  ['Which shipped files implement the RuvNet Brain release-proof protocol?', /repo=ruvnet-brain/i],
  ['What evidence proves RuvNet Brain answers its own product questions from RVF?', /repo=ruvnet-brain/i],
];

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function parseArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    server: path.resolve(value('--server', path.join(ROOT, 'plugin/mcp/server.mjs'))),
    kb: path.resolve(value('--kb', path.join(ROOT, 'kb'))),
    timeoutMs: Number(value('--timeout-ms', '30000')),
    modelCache: path.resolve(value('--model-cache', path.join(ROOT, 'kb', 'models-cache'))),
    json: argv.includes('--json'),
    from: Number(value('--from', '1')),
    to: Number(value('--to', String(QUESTIONS.length))),
  };
}

export async function benchmark(options) {
  if (QUESTIONS.length !== 50) throw new Error(`benchmark must contain exactly 50 questions, found ${QUESTIONS.length}`);
  const brainHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-latency-'));
  const child = spawn(process.execPath, [options.server], {
    env: {
      ...process.env,
      KB_DIR: options.kb,
      RUVNET_BRAIN_KB: options.kb,
      RUVNET_BRAIN_CHILD_MCP: path.join(options.kb, 'forge-mcp-all.mjs'),
      RUVNET_BRAIN_HOME: brainHome,
      KB_MODEL_CACHE: options.modelCache,
      RUVNET_BRAIN_CALL_TIMEOUT_MS: String(options.timeoutMs),
      RUVNET_BRAIN_METER: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });

  const request = (method, params, timeoutMs) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const ask = (query, expected) => {
    const id = nextId++;
    const started = performance.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ query, elapsedMs: Math.round(performance.now() - started), status: 'TIMEOUT', cited: false });
      }, options.timeoutMs + 5_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        const text = message.result?.content?.[0]?.text || '';
        const cited = expected.test(text);
        const observedRepos = [...text.matchAll(/repo=([a-z0-9._-]+)/gi)].map((match) => match[1]);
        resolve({
          query,
          elapsedMs: Math.round(performance.now() - started),
          status: !message.result?.isError && cited ? 'PASS' : 'FAIL',
          cited,
          observedRepos: [...new Set(observedRepos)],
          error: message.error?.message || (message.result?.isError ? text.slice(0, 500) : undefined),
          preview: text.slice(0, 500),
        });
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'search_ruvnet', arguments: { query, k: 5 } },
      })}\n`);
    });
  };

  const results = [];
  const readinessStarted = performance.now();
  const initialize = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'brain-latency-50', version: '1.0.0' },
  }, 120_000);
  if (initialize.error) throw new Error(`MCP initialize failed: ${initialize.error.message}`);
  const listed = await request('tools/list', {}, 120_000);
  if (!listed.result?.tools?.some((tool) => tool.name === 'search_ruvnet')) {
    throw new Error('MCP readiness failed: search_ruvnet was not advertised');
  }
  const readinessMs = Math.round(performance.now() - readinessStarted);
  try {
    const selected = QUESTIONS.slice(Math.max(0, options.from - 1), Math.min(QUESTIONS.length, options.to));
    for (const [query, expected] of selected) {
      const result = await ask(query, expected);
      results.push(result);
      if (!options.json) {
        process.stdout.write(`${String(results.length).padStart(2, '0')} ${result.status.padEnd(7)} ${String(result.elapsedMs).padStart(6)}ms  ${query}\n`);
      }
    }
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    lines.close();
    fs.rmSync(brainHome, { recursive: true, force: true });
  }

  const times = results.map((result) => result.elapsedMs);
  const summary = {
    server: options.server,
    kb: options.kb,
    questions: results.length,
    passed: results.filter((result) => result.status === 'PASS').length,
    failed: results.filter((result) => result.status === 'FAIL').length,
    timedOut: results.filter((result) => result.status === 'TIMEOUT').length,
    cited: results.filter((result) => result.cited).length,
    averageMs: Math.round(times.reduce((sum, value) => sum + value, 0) / times.length),
    medianMs: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    longestMs: Math.max(...times),
    deadlineMs: options.timeoutMs,
    readinessMs,
    stderr: stderr.trim(),
    results,
  };
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`SUMMARY ${summary.passed}/${summary.questions} pass · avg ${summary.averageMs}ms · median ${summary.medianMs}ms · p95 ${summary.p95Ms}ms · max ${summary.longestMs}ms · timeouts ${summary.timedOut}`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const summary = await benchmark(parseArgs(argv));
  return summary.passed === summary.questions && summary.timedOut === 0 ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = await main();
}
