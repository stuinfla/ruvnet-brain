#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const NOVICE_QUESTIONS = [
  ['orientation', 'I just installed this. What is RuvNet Brain actually for?', 'ruvnet-brain', /source|ground|actual|rUv/i],
  ['orientation', 'I am lost. What should I try first?', 'ruvnet-brain', /install|doctor|console|search/i],
  ['orientation', 'Is this a chatbot, a database, or something else?', 'ruvnet-brain', /knowledge|ground|MCP|RVF/i],
  ['orientation', 'Why would I use this instead of asking Claude from memory?', 'ruvnet-brain', /source|stale|ground|cite/i],
  ['orientation', 'Does this work in Codex too, or only Claude Code?', 'ruvnet-brain', /Codex|Claude/i],
  ['tiny-command', 'How do I open the settings screen?', 'ruvnet-brain', /rvbc|console/i],
  ['tiny-command', 'What command checks whether my install is healthy?', 'ruvnet-brain', /doctor/i],
  ['tiny-command', 'How do I see what changed in version 4?', 'ruvnet-brain', /what.?s.new|upgrade|4\.0/i],
  ['tiny-command', 'Do I install this separately in every project?', 'ruvnet-brain', /user.level|shared|every project|cache/i],
  ['tiny-command', 'Can I turn the Brain off temporarily?', 'ruvnet-brain', /off|disable|sentinel/i],
  ['mistake', 'I guess RVF is just a JSON file full of embeddings, right?', 'ruvector', /binary|HNSW|RVF/i],
  ['mistake', 'Should I put these vectors in Pinecone instead?', 'ruvector', /RVF|HNSW|local|zero.server/i],
  ['mistake', 'AgentDB and RVF are the same thing, correct?', 'agentdb', /structured|memory|vector|RVF/i],
  ['mistake', 'Ruflo is only a prompt library, isn’t it?', 'ruflo', /orchestrat|agent|swarm|memory/i],
  ['mistake', 'If search finds nothing, that proves the feature does not exist, yes?', 'ruvnet-brain', /thin|absence|narrow|artifact/i],
  ['small-specific', 'Where does RuvNet Brain store its own knowledge?', 'ruvnet-brain', /RVF|kb|cache/i],
  ['small-specific', 'What is HNSW doing inside RVF?', 'ruvector', /index|nearest|vector|search/i],
  ['small-specific', 'What is a witness chain in an RVF file?', 'ruvector', /witness|integrity|chain|provenance/i],
  ['small-specific', 'What does AgentDB remember that RVF does not?', 'agentdb', /structured|operational|agent|memory/i],
  ['small-specific', 'What is RuLake supposed to speed up?', 'rulake', /cache|read|vector|RVF/i],
  ['how-to', 'How do I ask RuvNet Brain a source question?', 'ruvnet-brain', /search_ruvnet|query|source/i],
  ['how-to', 'How do I make several coding agents work together?', 'ruflo', /swarm|agent|orchestrat|hierarchical/i],
  ['how-to', 'How do I keep project decisions across sessions?', 'ruflo', /memory store|memory search|AgentDB|session/i],
  ['how-to', 'How do I test a repo with specialized QE agents?', 'agentic-qe', /test|fleet|agent|quality/i],
  ['how-to', 'How do I find code that has weak test coverage?', 'agentic-qe', /coverage|gap|risk/i],
  ['big-picture', 'Explain how RVF, AgentDB, Ruflo, and RuvNet Brain fit together.', 'ruvnet-brain', /RVF|AgentDB|Ruflo|ground/i],
  ['big-picture', 'What happens from my question to a cited answer?', 'ruvnet-brain', /retriev|rerank|evidence|cite/i],
  ['big-picture', 'How does the system avoid hallucinating about shipped features?', 'ruvnet-brain', /implementation|source|manifest|proposed/i],
  ['big-picture', 'What is the difference between orchestration and memory here?', 'ruflo', /orchestrat|memory|agent/i],
  ['big-picture', 'Why use local models and files instead of a hosted vector server?', 'ruvector', /local|offline|RVF|server/i],
  ['recovery', 'My search has been spinning for minutes. What should I check?', 'ruvnet-brain', /doctor|model|cache|health|timeout/i],
  ['recovery', 'The Brain says evidence is thin. What do I do next?', 'ruvnet-brain', /narrow|repo|artifact|query/i],
  ['recovery', 'My project memory is not updating. Which store should I inspect?', 'ruflo', /memory\.db|ruflo memory|swarm/i],
  ['recovery', 'Ruflo memory says success but nothing was written. How do I prove it?', 'ruflo', /retrieve|search|sqlite|mtime|row/i],
  ['recovery', 'The native SQLite bridge has the wrong Node ABI. Is fallback good enough?', 'ruflo', /ABI|better-sqlite3|fallback|native/i],
  ['architecture', 'What is the correct storage split for a new knowledge app?', 'ruvnet-brain', /RVF|AgentDB|structured|vector/i],
  ['architecture', 'When should I use SPARC?', 'sparc', /specification|architecture|refinement|completion/i],
  ['architecture', 'How should a release prove the exact artifact it publishes?', 'ruvnet-brain', /SHA|digest|artifact|publish/i],
  ['architecture', 'How should RuvNet Brain behave when a source worker times out?', 'ruvnet-brain', /kill|health|error|restart|timeout/i],
  ['architecture', 'How does query routing keep searches from touching every repo?', 'ruvnet-brain', /route|card|scope|repo/i],
  ['truth', 'Is the cross-encoder cascade currently shipped on by default?', 'ruvnet-brain', /off|default|ADR-060|accepted/i],
  ['truth', 'Can you prove the release-proof protocol is implemented, not merely proposed?', 'ruvnet-brain', /implementation|source|manifest|proven/i],
  ['truth', 'Does a green test run prove the npm package works after install?', 'ruvnet-brain', /packed|install|artifact|public/i],
  ['truth', 'If Agentic QE executes zero tests, may the gate still pass?', 'ruvnet-brain', /zero|vacuous|fail|gate/i],
  ['truth', 'Is every capability described in an ADR already available?', 'ruvnet-brain', /proposed|accepted|implemented|status/i],
  ['comparison', 'RuvNet Brain versus Ruflo: which one answers source questions?', 'ruvnet-brain', /source|orchestrat|Ruflo|Brain/i],
  ['comparison', 'RVF versus AgentDB: where do vectors and structured records go?', 'agentdb', /RVF|vector|AgentDB|structured/i],
  ['comparison', 'RuLake versus RVF: is the cache the source of truth?', 'rulake', /cache|RVF|source|truth/i],
  ['advanced', 'Which code path reranks candidates after RVF retrieval?', 'ruvnet-brain', /forge-rerank|cross.encoder|rerank/i],
  ['advanced', 'What exact evidence would make you call RuvNet Brain ready to ship?', 'ruvnet-brain', /exact|artifact|test|public|receipt/i],
].map(([category, query, repo, required], index) => ({
  id: index + 1, category, query, repo, required,
}));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function grade(spec, text, elapsedMs, transportOk) {
  const top = /^#1\s+repo=(\S+)(?:\s+ce=(-?[\d.]+))?/m.exec(text);
  const expectedRepoCited = [...String(text).matchAll(/^#\d+\s+repo=(\S+)/gm)]
    .some((match) => match[1].toLowerCase() === spec.repo.toLowerCase());
  const cited = /^#\d+\s+repo=[a-z0-9._-]+/im.test(text);
  const abstained = !top || (top[2] !== undefined && Number(top[2]) < 0);
  // This regex is retained as a visible keyword signal only. It is not semantic accuracy and it
  // cannot make a row effective without a citation from the independently expected owner.
  const keywordSignal = spec.required.test(text);
  const unsupportedAbsence = /\b(?:does not exist|must be built|you need to build it)\b/i.test(text);
  const evidenceQualified = /EVIDENCE:\s*THIN|NOT PROVEN|PROPOSED|curated-capability-card|THIS QUERY found nothing/i.test(text);
  const honest = !unsupportedAbsence || evidenceQualified;
  const latencyPoints = elapsedMs <= 4000 ? 10 : elapsedMs <= 8000 ? 5 : 0;
  const effective = transportOk && cited && expectedRepoCited && honest && !abstained && elapsedMs <= 4000;
  return { cited, expectedRepoCited, keywordSignal, honest, abstained, effective, latencyPoints };
}

async function main() {
  const concurrency = Math.max(1, Number(process.argv[2] || 10));
  const brainHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-novice-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'plugin/mcp/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RUVNET_BRAIN_HOME: brainHome,
      RUVNET_BRAIN_KB: path.join(ROOT, 'kb'),
      RUVNET_BRAIN_CHILD_MCP: path.join(ROOT, 'kb/forge-mcp-all.mjs'),
      KB_MODEL_CACHE: path.join(ROOT, 'kb/models-cache'),
      RUVNET_BRAIN_CALL_TIMEOUT_MS: '30000',
      RUVNET_BRAIN_METER: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const done = waiting.get(msg.id);
    if (done) { waiting.delete(msg.id); done(msg); }
  });
  const request = (method, params, timeoutMs = 120_000) => {
    const requestId = ++id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve({ error: { message: `${method} client timeout` } });
      }, timeoutMs);
      waiting.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  };

  const readyAt = performance.now();
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'novice-50', version: '1' } });
  const tools = await request('tools/list', {});
  if (!tools.result?.tools?.some((tool) => tool.name === 'search_ruvnet')) throw new Error('search_ruvnet not ready');
  const readinessMs = Math.round(performance.now() - readyAt);

  const results = new Array(NOVICE_QUESTIONS.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let index = next++; index < NOVICE_QUESTIONS.length; index = next++) {
      const spec = NOVICE_QUESTIONS[index];
      const started = performance.now();
      const msg = await request('tools/call', {
        name: 'search_ruvnet',
        arguments: { query: spec.query, k: 5 },
      }, 35_000);
      const elapsedMs = Math.round(performance.now() - started);
      const text = msg.result?.content?.[0]?.text || '';
      const transportOk = !msg.error && msg.result?.isError !== true;
      results[index] = {
        ...spec,
        elapsedMs,
        transportOk,
        error: msg.error?.message || (msg.result?.isError ? text.slice(0, 240) : null),
        answer: text,
        ...grade(spec, text, elapsedMs, transportOk),
      };
      process.stdout.write(`${String(spec.id).padStart(2, '0')} ${results[index].effective ? 'ELIGIBLE' : 'MISS    '} ${String(elapsedMs).padStart(6)}ms ${spec.category.padEnd(14)} ${spec.query}\n`);
    }
  }));

  child.stdin.end();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  rl.close();
  fs.rmSync(brainHome, { recursive: true, force: true });

  const times = results.map((result) => result.elapsedMs);
  const report = {
    generatedAt: new Date().toISOString(),
    concurrency,
    readinessMs,
    passed: results.filter((result) => result.effective).length,
    under4s: results.filter((result) => result.elapsedMs <= 4000).length,
    averageMs: Math.round(times.reduce((sum, value) => sum + value, 0) / times.length),
    medianMs: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    longestMs: Math.max(...times),
    stderr: stderr.trim(),
    gradingScope: 'Operational eligibility only: transport, citation presence, expected-owner citation, honest uncertainty, and latency. keywordSignal is diagnostic only; this report does not measure semantic answer accuracy.',
    results,
  };
  const output = path.join(ROOT, 'data/novice-50-report.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`SUMMARY ${report.passed}/50 eligible · ${report.under4s}/50 under 4s · avg ${report.averageMs}ms · p95 ${report.p95Ms}ms · max ${report.longestMs}ms`);
  console.log(`REPORT ${output}`);
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
