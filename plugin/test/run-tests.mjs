#!/usr/bin/env node
// run-tests.mjs — QA suite for the ruvnet-brain Claude Code plugin.
//
// Verifies the plugin top-to-bottom and PROVES the core guarantee — that the brain never
// wrongly doubts a RuvNet capability — with a real retrieval battery, not assertions.
//
// Sections:
//   1. manifests & structure   — every config file is valid + has required fields
//   2. grounding hook          — fires on RuvNet prompts, silent otherwise, never errors
//   3. MCP launcher            — resolves the brain and proxies JSON-RPC (initialize, tools/list)
//   4. capability battery      — each "can RuvNet do X?" returns a grounded hit from the right repo
//
// Requests are sent SEQUENTIALLY (one in flight at a time), the way a real MCP client behaves —
// firing them concurrently would overwhelm one process running 10 cross-encoder passes at once.
//
// Usage:  node test/run-tests.mjs
// Needs the brain at $RUVNET_BRAIN_KB or ~/.cache/ruvnet-brain/kb (sections 3–4 SKIP without it).
// Tip:    export KB_MODEL_CACHE=/path/to/warm/models-cache   to avoid a first-run model download.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // plugin/
let pass = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } }

// 1. manifests & structure
section('1. manifests & structure');
const plugin = readJson('.claude-plugin/plugin.json');
check('plugin.json is valid JSON', !!plugin);
check('plugin.json name = ruvnet-brain', plugin?.name === 'ruvnet-brain');
check('plugin.json has a version', !!plugin?.version);
const market = readJson('.claude-plugin/marketplace.json');
check('marketplace.json lists the ruvnet-brain plugin', Array.isArray(market?.plugins) && market.plugins.some((p) => p.name === 'ruvnet-brain'));
const mcp = readJson('.mcp.json');
check('.mcp.json registers the ruvnet-brain MCP server', !!mcp?.mcpServers?.['ruvnet-brain']);
const hooks = readJson('hooks/hooks.json');
check('hooks.json declares a UserPromptSubmit hook', Array.isArray(hooks?.hooks?.UserPromptSubmit));
for (const f of ['skills/ruvnet-brain/SKILL.md', 'mcp/server.mjs', 'scripts/ground-ruvnet.sh', 'README.md', 'test/capability-questions.json']) {
  check(`exists: ${f}`, fs.existsSync(path.join(ROOT, f)));
}

// 2. grounding hook
section('2. grounding hook (enforcement)');
const hookPath = path.join(ROOT, 'scripts/ground-ruvnet.sh');
const runHook = (input) => spawnSync('/bin/bash', [hookPath], { input, encoding: 'utf8' });
const onTopic = runHook(JSON.stringify({ prompt: 'does ruflo support agent swarms?' }));
check('fires on a RuvNet prompt', /search_ruvnet/.test(onTopic.stdout) && /ground before you assert/i.test(onTopic.stdout));
check('exits 0 on a RuvNet prompt', onTopic.status === 0);
const offTopic = runHook(JSON.stringify({ prompt: 'write a haiku about the ocean' }));
// SEC-0010 #3: the always-on Gate-0 status footer is intended (Stuart's "show version+stack every turn"
// requirement). What must stay silent off-topic are the GROUNDING gates — no search_ruvnet directive,
// no hijack "STOP", no "take the wheel" build playbook. The neutral status line is expected, not a leak.
const groundingFired = /search_ruvnet/.test(offTopic.stdout)
  || /STOP: you're reaching/i.test(offTopic.stdout)
  || /take the wheel/i.test(offTopic.stdout);
check('grounding gates stay silent on a non-RuvNet prompt (status footer is intended)', !groundingFired);
const malformed = runHook('this is not json');
check('handles malformed input without erroring (exit 0)', malformed.status === 0);

// A minimal sequential JSON-RPC client over the launcher's stdio (one request in flight at a time).
function withServer(KB, fn) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(ROOT, 'mcp/server.mjs')], {
      env: { ...process.env, RUVNET_BRAIN_KB: KB }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    const waiters = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.id != null && waiters.has(o.id)) { waiters.get(o.id)(o); waiters.delete(o.id); }
      }
    });
    child.on('error', reject);
    const rpc = (req) => new Promise((res) => { waiters.set(req.id, res); child.stdin.write(JSON.stringify(req) + '\n'); });
    Promise.resolve(fn(rpc)).then(resolve, reject).finally(() => { try { child.stdin.end(); child.kill(); } catch { /* */ } });
  });
}

// 3 & 4. launcher + capability battery
const KB = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
let brainSkipped = false; // QE-0011 tests#1: track so "skipped" can never masquerade as "passed"
section('3. MCP launcher + 4. capability battery');
if (!fs.existsSync(path.join(KB, 'forge-mcp-all.mjs'))) {
  brainSkipped = true;
  console.log(`  ⚠️  CORE CAPABILITY BATTERY SKIPPED — brain not found at ${KB}.`);
  console.log(`      The MCP launcher + the 9-question "never wrongly doubt a real capability" battery`);
  console.log(`      did NOT run. This is structure/hook/guard coverage only, NOT the product guarantee.`);
  // A fresh CI runner has no 512MB brain, so this skips there by default. Set REQUIRE_BRAIN=1 in a
  // dedicated (nightly/release) job that restores a brain, so a skipped battery FAILS instead of
  // silently green-lighting. Without it, the skip is loud but non-fatal (the fast PR job).
  if (process.env.REQUIRE_BRAIN === '1') {
    console.log(`      REQUIRE_BRAIN=1 set → treating a skipped battery as FAILURE.`);
    failures.push('core capability battery skipped but REQUIRE_BRAIN=1');
  }
  await finish();
} else {
  const questions = readJson(process.env.CAP_QUESTIONS || 'test/capability-questions.json') || [];
  await withServer(KB, async (rpc) => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('launcher: initialize returns serverInfo ruvnet-brain', init?.result?.serverInfo?.name === 'ruvnet-brain');
    const tl = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    check('launcher: tools/list exposes search_ruvnet', !!tl?.result?.tools?.find((t) => t.name === 'search_ruvnet'));

    console.log('\n  -- capability-confidence battery (never wrongly doubt) --');
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const resp = await rpc({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: q.query, k: q.k || 3 } } });
      const text = resp?.result?.content?.[0]?.text || '';
      const m = text.match(/#1\s+repo=(\S+)\s+\(relevance ([^;]+);/);
      const repo = m?.[1];
      const rel = m && m[2] !== 'n/a' ? parseFloat(m[2]) : null;
      const exp = q.expectRepo;
      const repoOk = !exp || (Array.isArray(exp) ? exp.includes(repo) : repo === exp);
      const relOk = rel == null ? true : rel >= (q.minRelevance ?? -3);
      check(`"${q.query.slice(0, 48)}…" → ${repo || '(no hit)'} @ ${rel ?? 'n/a'}`, !!repo && repoOk && relOk, exp ? `expected one of [${[].concat(exp).join(', ')}]` : '');
    }
  });
  await finish();
}

async function finish() {
  section('summary');
  const total = pass + failures.length;
  const skipNote = brainSkipped ? '  ⚠️  (core capability battery SKIPPED — brain absent; structure/hook/guard only)' : '';
  console.log(`\n${pass}/${total} checks passed.${skipNote ? '\n' + skipNote : ''}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(failures.length ? 1 : 0);
}
