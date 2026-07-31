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
import {
  resolveModelCache,
  requiredEmbedderModels,
  modelPresent,
  classifyBattery,
} from './model-cache.mjs';

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
for (const f of ['skills/ruvnet-brain/SKILL.md', 'skills/brain-score/SKILL.md', 'skills/brain-build/SKILL.md', 'skills/brain-prompt/SKILL.md', 'mcp/server.mjs', 'scripts/ground-ruvnet.sh', 'README.md', 'test/capability-questions.json']) {
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

// 2b. brain-score skill + the 2.0 token-intelligence announcement (default-on vs key-gated, honestly)
section('2b. brain-score skill + 2.0 announcement');
const skillRaw = (() => { try { return fs.readFileSync(path.join(ROOT, 'skills/brain-score/SKILL.md'), 'utf8'); } catch { return ''; } })();
const fm = skillRaw.match(/^---\n([\s\S]*?)\n---\n/);
check('brain-score frontmatter parses (name: brain-score + description)', !!fm && /(^|\n)name:\s*brain-score\s*(\n|$)/.test(fm[1]) && /(^|\n)description:\s*\S/.test(fm[1]));
check('brain-score carries the ≤70 architectural-flaw cap rule', /caps? (its |a )?dimension at ≤70/i.test(skillRaw));
check('brain-score mandates the "what I did NOT test" section', /what I did NOT test/i.test(skillRaw) && /mandatory/i.test(skillRaw));
check('brain-score scores /100, never /10', skillRaw.includes('/100') && /never \/10\b/.test(skillRaw));
check('brain-score demands cited evidence for every deduction', /every deduction (must )?cite/i.test(skillRaw));
check('brain-score carries the qe_qx_analyze remote-URL hallucination warning', skillRaw.includes('qe_qx_analyze') && /hallucinat/i.test(skillRaw));
check('brain-score is honest about the key gate (evolve needs OPENROUTER_API_KEY; score/oia free)', skillRaw.includes('OPENROUTER_API_KEY') && skillRaw.includes('metaharness_evolve') && skillRaw.includes('metaharness_score'));

// 2c. brain-build + brain-prompt skills (the PR #8 standing-prompt contract, productized)
section('2c. brain-build + brain-prompt skills');
const readSkill = (name) => { try { return fs.readFileSync(path.join(ROOT, `skills/${name}/SKILL.md`), 'utf8'); } catch { return ''; } };
for (const name of ['brain-build', 'brain-prompt']) {
  const raw = readSkill(name);
  const sfm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  check(`${name} frontmatter parses (name: ${name} + description)`, !!sfm && new RegExp(`(^|\\n)name:\\s*${name}\\s*(\\n|$)`).test(sfm[1]) && /(^|\n)description:\s*\S/.test(sfm[1]));
  check(`${name} credits the community standing-prompt pattern (PR #8)`, /PR #8/.test(raw));
}
const bb = readSkill('brain-build');
check('brain-build carries the ≥95 loop rule (below 95 → fix and regrade)', /below 95/i.test(bb) && /≥\s*95/.test(bb) && /regrade/i.test(bb));
check('brain-build caps the loop at a maximum of 5 iterations', /maximum of 5 iterations/i.test(bb) && /max 5 iterations/i.test(bb));
check('brain-build carries the cost ladder (route-cheap receipt + frontier-only gate + >$1/20-call stop)',
  bb.includes('route-cheap.mjs') && /frontier ONLY for the authoritative gate run/i.test(bb) && bb.includes('>$1') && /20 paid calls/.test(bb));
check('brain-build batches questions into ONE list with recommended defaults', /ONE list/.test(bb) && /recommended default/i.test(bb));
check('brain-build cites rUv SPARC sources for its phase structure',
  bb.includes('concepts/sparc/CARD/sparc-card') && bb.includes('sparc/specification/README.md') && bb.includes('ruflo/plugins/ruflo-sparc/commands/ruflo-sparc.md'));
check('brain-build wires the crash-resumable checkpoint (done = exit code, not opinion)',
  bb.includes('loop-checkpoint.mjs') && /exit code, not (an )?opinion/i.test(bb));
check('brain-build applies brain-score gate rules (evidence-cited deductions, ≤70 cap, "not tested" section)',
  /deduction cites evidence/i.test(bb) && bb.includes('≤70') && /what I did NOT test/i.test(bb));
const bp = readSkill('brain-prompt');
check('brain-prompt teaches verifiable gates (done = exit code, not opinion)', /done = exit code, not opinion/i.test(bp));
check('brain-prompt ends by offering execution with /brain-build semantics', /Run this now with \/brain-build semantics\?/.test(bp) && /On yes, execute/i.test(bp));
check('brain-prompt infers defaults and batches only genuine questions into ONE list', /infer defaults/i.test(bp) && /ONE list/.test(bp) && /recommended default/i.test(bp));
check('brain-prompt grounds tool choices via search_ruvnet with citations', bp.includes('search_ruvnet') && /cite/i.test(bp));
check('brain-prompt cites rUv metaprompt prior art', bp.includes('ruv-gists/874e2138/metaprompt.txt'));
check('brain-score cross-references /brain-build as its gate consumer', /\/brain-build/.test(skillRaw));

const ssPath = path.join(ROOT, 'scripts/session-start.sh');
const ssCorePath = path.join(ROOT, 'scripts/session-start-core.mjs');
const ssRaw = fs.readFileSync(ssCorePath, 'utf8');
const MARKER = '[RuvNet Brain — token intelligence + QE, mention once]';
check('session-start announcement present exactly once in the core authority', ssRaw.split(MARKER).length === 2);
check('the old "OpenRouter key, already set" overclaim is gone', !ssRaw.includes('OpenRouter key, already set'));

// Behavior: fires when ruflo is detectable; degrades SILENTLY when it is not.
const tmpDirs = [];
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
const mkHome = () => {
  const h = mkTmp('rb-ss-home-');
  const c = path.join(h, '.cache', 'ruvnet-brain');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, '.last-update-check'), String(Math.floor(Date.now() / 1000))); // skip network
  fs.writeFileSync(path.join(c, '.auto-update-pref'), 'no\n'); // skip one-time question + KB check
  return h;
};
// Exercise the registered authority, not the legacy shell compatibility launcher. In particular,
// the no-Ruflo fixture deliberately strips `node` from PATH; the real hook is already inside the
// Node shim and invokes this core with process.execPath, so routing that fixture through the shell
// would test an adjacent, obsolete door.
const runSS = (cwd, env) => spawnSync(process.execPath, [ssCorePath], {
  cwd, encoding: 'utf8', timeout: 15000,
  env: { ...process.env, RUVNET_BRAIN_METER: '0', CLAUDE_PLUGIN_ROOT: ROOT, ...env },
});

const withDir = mkTmp('rb-ss-ruflo-');
fs.mkdirSync(path.join(withDir, '.claude-flow')); // project marker → ruflo detectable
const withRuflo = runSS(withDir, { HOME: mkHome() });
check('announcement fires when ruflo is detectable, exactly once', withRuflo.status === 0 && withRuflo.stdout.split(MARKER).length === 2);
// The closing quote is OPTIONAL in this anchor (2026-07-27). It used to be mandatory, which made it
// an accidental assertion that the block ends by writing the user's sentence out verbatim inside
// quotes. The stdout-budget work replaced that quoted line with a directive — same facts, same
// required phrases below, ~50 fewer bytes — and the anchor stopped matching, reporting the block as
// absent rather than as changed. What this check is FOR (the 512-byte budget and the trigger
// phrases) is untouched; only the boundary it uses to find the block is now shape-agnostic.
const block = withRuflo.stdout.match(/\[RuvNet Brain — token intelligence \+ QE, mention once\][\s\S]*?OPENROUTER_API_KEY\."?\n/);
const blockBytes = block ? Buffer.byteLength(block[0], 'utf8') : -1;
check(`announcement under the 512-byte budget (actual: ${blockBytes})`, blockBytes > 0 && blockBytes <= 512);
check('announcement names the triggers + the key gate', !!block && ["do this cheaper", "score my harness", "score this repo", '/brain-build', '/brain-prompt', 'OPENROUTER_API_KEY'].every((s) => block[0].includes(s)));

const noDir = mkTmp('rb-ss-noruflo-');
// no project markers, ruflo stripped off PATH, fresh HOME with no ~/.claude.json
const noRuflo = runSS(noDir, { HOME: mkHome(), PATH: '/usr/bin:/bin' });
check('degrades silently when ruflo is absent (no announcement, exit 0, banner intact)', noRuflo.status === 0 && !noRuflo.stdout.includes(MARKER) && /RuvNet Brain v/.test(noRuflo.stdout));

// Gate 4 routes the new trigger phrase to the brain-score skill.
const scoreRepo = runHook(JSON.stringify({ prompt: 'score this repo' }));
check('"score this repo" fires Gate 4 and names the brain-score skill', scoreRepo.status === 0 && /brain-score/.test(scoreRepo.stdout));
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }

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
let coldSkipped = false;  // cold model cache (embedder not downloaded) — distinct from a retrieval outage
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
  // The smoke battery proves fast capability selection. Implementation claims live in the separate
  // source-evidence corpus; mixing them here forced nine heavyweight searches into every npm test.
  const questions = readJson(process.env.CAP_QUESTIONS || 'test/capability-selection-questions.json') || [];
  // COLD-CACHE EVIDENCE (docs/4.0-READINESS.md §6 item 1). Read the required query model from the
  // installed RVF sidecars. Canonical `*.big.rvf` stores use BGE; assuming MiniLM here used to make
  // this gate declare itself warm while the real reader failed every general query.
  // If a required model has never been downloaded, EVERY query fails and — parsed
  // by this battery — prints the same "(no hit)" a real outage prints, mislabeling a healthy brain as
  // broken. Resolve the SAME cache path the child will use (mirrors plugin/mcp/server.mjs) and read
  // the one honest signal: is the embedder on disk? A cold cache is reported distinctly and is NOT a
  // failure; an outage (model present, retrieval still dead) stays red. See plugin/test/model-cache.mjs.
  const modelCache = resolveModelCache();
  const requiredModels = requiredEmbedderModels(KB);
  const haveModel = modelPresent(modelCache, requiredModels);
  await withServer(KB, async (rpc) => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('launcher: initialize returns serverInfo ruvnet-brain', init?.result?.serverInfo?.name === 'ruvnet-brain');
    const tl = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    check('launcher: tools/list exposes search_ruvnet', !!tl?.result?.tools?.find((t) => t.name === 'search_ruvnet'));

    // Cold cache → do NOT run the battery. Running it would either hang on a ~90MB first-run download
    // or print a misleading "(no hit)" per question. Say plainly it is cold and how to warm it.
    if (!haveModel) {
      coldSkipped = true;
      console.log(`\n  ⚠️  CAPABILITY BATTERY SKIPPED — COLD MODEL CACHE (embedder not downloaded).`);
      console.log(`      Required query model(s): ${requiredModels.join(', ')}`);
      console.log(`      At least one is ABSENT from ${modelCache}.`);
      console.log(`      This is NOT a retrieval outage: the corpus is present and the launcher answered above.`);
      console.log(`      A cold cache makes EVERY query fail identically to a real outage, so the battery is not`);
      console.log(`      run rather than printing a misleading "(no hit)" on every question (empty-first house rule).`);
      console.log(`      Warm it once (downloads ~90MB from HuggingFace) or point at a warmed cache:`);
      console.log(`        KB_MODEL_CACHE=/path/to/models-cache npm test`);
      // In a dedicated warm/nightly/release job the cache MUST be warm — REQUIRE_BRAIN promotes the
      // cold skip to a failure there, same contract as the brain-absent skip above.
      if (process.env.REQUIRE_BRAIN === '1') {
        console.log(`      REQUIRE_BRAIN=1 set → treating a cold model cache as FAILURE.`);
        failures.push('capability battery skipped: cold model cache but REQUIRE_BRAIN=1');
      }
      return;
    }

    console.log('\n  -- capability-confidence battery (never wrongly doubt) --');
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const resp = await rpc({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: q.query, k: q.k || 3 } } });
      const text = resp?.result?.content?.[0]?.text || '';
      const m = text.match(/#1\s+repo=(\S+)\s+\(relevance ([^;]+);/);
      // The permanent zero-ML card lane is a real grounded answer too. It deliberately does not
      // impersonate the heavy lane's `#1 ... relevance` format, so the QE oracle must recognize
      // both response contracts or every fast answer is mislabeled "(no hit)".
      const fast = text.match(/FAST LANE[\s\S]*?#1\s+repo=(\S+)\s+evidence=/);
      const repo = m?.[1] || fast?.[1];
      const rel = m && m[2] !== 'n/a' ? parseFloat(m[2]) : null;
      const exp = q.expectRepo;
      const repoOk = !exp || (Array.isArray(exp) ? exp.includes(repo) : repo === exp);
      const relOk = rel == null ? true : rel >= (q.minRelevance ?? -3);
      // Model is present here, so classifyBattery can only return 'pass' or 'fail' — a "(no hit)" now
      // is a GENUINE outage and stays red, never softened to cold.
      const status = classifyBattery({ repo, repoOk, relOk, haveModel });
      check(`"${q.query.slice(0, 48)}…" → ${repo || '(no hit)'} @ ${rel ?? 'n/a'}`, status === 'pass', exp ? `expected one of [${[].concat(exp).join(', ')}]` : '');
    }
  });
  await finish();
}

async function finish() {
  section('summary');
  const total = pass + failures.length;
  const skipNote = brainSkipped ? '  ⚠️  (core capability battery SKIPPED — brain absent; structure/hook/guard only)'
    : coldSkipped ? '  ⚠️  (core capability battery SKIPPED — COLD model cache; warm it or set KB_MODEL_CACHE. NOT an outage.)'
    : '';
  console.log(`\n${pass}/${total} checks passed.${skipNote ? '\n' + skipNote : ''}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(failures.length ? 1 : 0);
}
