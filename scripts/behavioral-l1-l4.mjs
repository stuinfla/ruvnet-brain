#!/usr/bin/env node
// scripts/behavioral-l1-l4.mjs — the 4-level BEHAVIORAL test harness for the RuvNet brain.
//
// The existing eval scripts (prove.mjs, brain-capability-check.mjs, brain-grade-groundtruth.mjs)
// test RETRIEVAL: does the right source come back, is it confident, is the answer graded high. This
// harness tests the four BEHAVIORS a user actually depends on — including the one the brain is meant
// to DRIVE (orchestration), which no prior script covered:
//
//   L1 ROUTE        — "which repo solves X?" → the brain routes the top hit to the correct repo.
//   L2 DEEP-RECALL  — "how is X implemented?" → the brain returns CODE-level source (full bodies),
//                     not just doc-comments — proof it walked the repo to the implementation.
//   L3 IMPLEMENT    — "implement X using <repo>" → the #1 cited source actually contains the API you
//                     would build against, so an implementation grounded in it is correct (mechanical
//                     correctness proxy; full multi-vendor grading stays brain-grade-groundtruth.mjs).
//   L4 ORCHESTRATE  — the newbie path. Run the real hooks — session-start.sh ONCE per harness run
//                     (since ADR-0011 Phase 2 it carries THE PLAYBOOK: ground → SPARC → DDD/ADR →
//                     parallel swarm → QA → score ≥98 → frontend-design → AI image-gen →
//                     ask-for-API-key → prove) AND the per-turn UserPromptSubmit hook
//                     (ground-ruvnet.sh) on "go make magic / here's a spec, build it" prompts — and
//                     assert every directive appears at the layer that now owns it (see the ADR-0011
//                     Phase 2 relocation note above the L4 table). Hook injection is the only
//                     enforcement primitive that exists (ADR-0005), so testing the injected text IS
//                     testing whether the brain takes the wheel.
//
// L1–L3 call searchAll() — the EXACT engine search_ruvnet wraps (forge-mcp-all.mjs:77). L4 shells the
// real hooks. No mutation, read-only. Needs KB_MODEL_CACHE pointing at the ONNX model cache for L1–L3.
//
// Usage:
//   KB_MODEL_CACHE=<cache> node scripts/behavioral-l1-l4.mjs [--dir kb] [--repos a,b,c] [--levels L1,L4]
//   --repos  restrict the search pool (collision-safe while a build sweep is running)
//   --levels comma list of L1,L2,L3,L4 to run (default all)
// Exit 0 iff every selected check passes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAll } from '../kb/forge-ask-all.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const KB_DIR = path.resolve(arg('--dir', path.join(ROOT, 'kb')));
const HOOK = path.resolve(arg('--hook', path.join(ROOT, 'plugin/scripts/ground-ruvnet.sh')));
const SESSION_HOOK = path.resolve(arg('--session-hook', path.join(ROOT, 'plugin/scripts/session-start.sh')));
const reposArg = arg('--repos', '');
const REPOS = reposArg ? reposArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const K = parseInt(arg('--k', '6'), 10);
const LEVELS = new Set((arg('--levels', 'L1,L2,L3,L4')).split(',').map((s) => s.trim().toUpperCase()));

const CODE_RX = /(\bfn\s|\bfunction\s|\bimpl\s|\bstruct\s|\bclass\s|\bexport\s|\basync\s|=>|\(full body\))/;
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`, DIM = (s) => `\x1b[2m${s}\x1b[0m`;

// ── L1 ROUTE: question → repo it should route to ──────────────────────────────────────────────
const L1 = [
  { q: 'single-file HNSW vector store with no server', expect: 'ruvector' },
  { q: 'orchestrate a swarm of agents across multiple steps', expect: 'ruflo' },
  { q: 'causal explainable agent memory — why did I recall that', expect: 'agentdb' },
  { q: 'fork a million vectors cheaply, branch agent memory copy-on-write', expect: 'agenticow' },
  { q: 'WiFi CSI sensing of vital signs on an edge device', expect: 'ruview' },
];
// ── L2 DEEP-RECALL: must return CODE (full bodies) from the right repo, not doc-comments ──────────
const L2 = [
  { q: 'how is the HNSW graph insert / neighbour selection implemented', expect: 'ruvector' },
  { q: 'how does the swarm decide how many agents to spawn in code', expect: 'ruflo' },
  { q: 'how is a copy-on-write branch created in code', expect: 'agenticow' },
];
// ── L3 IMPLEMENT: #1 cited source must contain the API you'd build against ────────────────────────
const L3 = [
  { q: 'implement a nearest-neighbour query against an .rvf store', expect: 'ruvector', apiRx: /query|search|knn|nearest/i },
  { q: 'store and recall an agent memory entry with AgentDB', expect: 'agentdb', apiRx: /store|recall|memory|insert|search/i },
];
// ── L4 ORCHESTRATE: run the real hook; assert the injected directive is complete ──────────────────
const L4 = [
  {
    name: 'newbie "go make magic"',
    prompt: 'go make magic and build me an app that helps people learn',
    // pure build prompt, no RuvNet keyword → Gate 3 (take-the-wheel) must fire with the full pipeline
    must: ['take the wheel', 'SPARC', 'DDD', 'ADR', 'swarm', 'QA gate', '98', 'frontend-design', 'image generation', 'API key', 'PROVEN', 'PARALLEL'],
  },
  {
    name: 'spec → build (RuvNet-named)',
    prompt: 'here is a product spec, build a knowledge base feature using ruvector',
    // names ruvector → Gate 1 (ground) AND Gate 3 (build) must both fire
    must: ['search_ruvnet', 'ground', 'SPARC', 'DDD', 'frontend-design', 'image generation', 'API key', '98'],
  },
  {
    name: 'classical-default drift',
    prompt: 'set up pinecone and langchain to do rag over my docs',
    // drift keywords → Gate 2 (hijack) must fire AND build keyword "set up" → Gate 3
    must: ['classical default', 'RuVector', 'Ruflo', 'AgentDB', 'take the wheel'],
  },
  {
    name: 'pure recall (no build)',
    prompt: 'what can ruflo actually do',
    must: ['search_ruvnet', 'ground'],
    mustNot: ['take the wheel'], // no build verb → Gate 3 must stay silent
  },
];

const results = { L1: [], L2: [], L3: [], L4: [] };

async function runL1() {
  for (const t of L1) {
    const { results: r } = await searchAll({ dir: KB_DIR, query: t.q, k: K, repos: REPOS });
    const top = r[0];
    // Routing (breadth) is correct if the #1 hit (a) IS the expected repo, (b) is a `concepts`
    // capability-card naming it (the by-description router that took routing 33%→96%), or (c) is a
    // doc explicitly ABOUT it in a sibling repo (e.g. a cognitum-cogs page packaging ruview) — all
    // three correctly point the user at the right building block. Annotated transparently below.
    const named = !!top && new RegExp(`\\b${t.expect}\\b`, 'i').test(`${top.path} ${top.title} ${(top.fullText || '').slice(0, 400)}`);
    const viaCard = !!top && top.repo === 'concepts' && named;
    const viaTopic = !!top && top.repo !== t.expect && top.repo !== 'concepts' && named;
    const pass = !!top && (top.repo === t.expect || viaCard || viaTopic);
    const tag = !top ? '' : top.repo === t.expect ? '' : viaCard ? ' via card' : viaTopic ? ` via ${top.repo} doc` : '';
    results.L1.push({ pass, info: `${t.q.slice(0, 38)}… → ${top ? top.repo + '/' + (top.path || '').split('/').pop() : 'none'} (want ${t.expect}${tag}; ce ${top?.ceScore?.toFixed(2) ?? 'n/a'})` });
  }
}
async function runL2() {
  // DEPTH is scoped to the target repo: "does repo X actually contain the implementation of Y?"
  // (full-ecosystem routing is L1's job; here we ask the repo directly so cards/sibling docs can't
  // mask whether the code is indexed). k bumped a bit — deep-recall may sit below overview chunks.
  for (const t of L2) {
    const { results: r } = await searchAll({ dir: KB_DIR, query: t.q, k: 10, repos: [t.expect] });
    const hit = r.find((x) => CODE_RX.test(x.fullText || x.text || ''));
    const pass = !!hit;
    results.L2.push({ pass, info: `${t.q.slice(0, 42)}… → ${pass ? `CODE @ ${t.expect}/${hit.path}` : r[0] ? `doc-only @ ${t.expect}/${r[0].path}` : `no ${t.expect} hit`}` });
  }
}
async function runL3() {
  // Implementability scoped to the target repo: its #1 source for the task must contain the API.
  for (const t of L3) {
    const { results: r } = await searchAll({ dir: KB_DIR, query: t.q, k: K, repos: [t.expect] });
    const top = r[0];
    const apiOk = top && t.apiRx.test(top.fullText || top.text || '');
    const pass = !!top && !!apiOk;
    results.L3.push({ pass, info: `${t.q.slice(0, 40)}… → #1 ${top ? `${t.expect}/${top.path}` : 'none'} apiMatch=${!!apiOk}` });
  }
}
function runL4() {
  // Phase 2 (2026-07-09) relocated the full playbook into session-start.sh (once per session); the
  // per-turn hook carries only a slim reminder. So `must` markers are asserted against the UNION of
  // session-start output (captured once, exactly as a real session receives it) + the scenario's
  // per-turn hook output. `mustNot` leak checks stay on the PER-TURN output alone — session-start
  // legitimately always contains the playbook; the leak under test is a non-build turn wrongly
  // triggering build directives.
  const hookEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') };
  let session = '';
  try { session = execFileSync('bash', [SESSION_HOOK], { input: '', encoding: 'utf8', env: hookEnv }); } catch (e) { session = (e.stdout || ''); }
  const sessionLc = session.toLowerCase();
  for (const t of L4) {
    let out = '';
    try { out = execFileSync('sh', [HOOK], { input: JSON.stringify({ prompt: t.prompt }), encoding: 'utf8', env: hookEnv }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    const lc = out.toLowerCase();
    const union = `${lc}\n${sessionLc}`;
    const missing = (t.must || []).filter((m) => !union.includes(m.toLowerCase()));
    const leaked = (t.mustNot || []).filter((m) => lc.includes(m.toLowerCase()));
    const pass = missing.length === 0 && leaked.length === 0;
    results.L4.push({ pass, info: `${t.name}${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}${leaked.length ? ` — LEAKED: ${leaked.join(', ')}` : ''}` });
  }
}

(async () => {
  console.log(`\n=== RuvNet Brain — L1–L4 behavioral harness ===`);
  console.log(DIM(`kb=${KB_DIR}  pool=${REPOS ? REPOS.join(',') : 'ALL'}  hook=${path.relative(ROOT, HOOK)}\n`));
  if (LEVELS.has('L1')) await runL1();
  if (LEVELS.has('L2')) await runL2();
  if (LEVELS.has('L3')) await runL3();
  if (LEVELS.has('L4')) runL4();

  let allPass = true;
  const titles = { L1: 'ROUTE', L2: 'DEEP-RECALL', L3: 'IMPLEMENT', L4: 'ORCHESTRATE' };
  for (const lvl of ['L1', 'L2', 'L3', 'L4']) {
    if (!LEVELS.has(lvl) || !results[lvl].length) continue;
    const passN = results[lvl].filter((x) => x.pass).length;
    const ok = passN === results[lvl].length;
    allPass = allPass && ok;
    console.log(`${ok ? G('PASS') : R('FAIL')}  ${lvl} ${titles[lvl]}  (${passN}/${results[lvl].length})`);
    for (const x of results[lvl]) console.log(`   ${x.pass ? G('✓') : R('✗')} ${x.info}`);
    console.log();
  }
  console.log(`=== OVERALL: ${allPass ? G('PASS') : R('FAIL')} ===\n`);
  process.exit(allPass ? 0 : 1);
})();
