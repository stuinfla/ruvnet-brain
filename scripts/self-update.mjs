#!/usr/bin/env node
// self-update.mjs — nightly evergreen driver.
// Compares each in-scope repo's live HEAD against the stamped manifest, then (re)builds the segments
// that changed and re-stamps. Dry-run by default; pass --apply to actually (re)build.
//
//   node scripts/self-update.mjs                 # dry-run: print the rebuild plan
//   node scripts/self-update.mjs --apply         # rebuild stale/pending repos (serial; embedding is CPU-bound)
//   node scripts/self-update.mjs --apply --tier T0   # limit scope
//   node scripts/self-update.mjs --apply --repo ruflo
//
// Designed to be invoked by deploy/com.ruvnet.brain-nightly.plist (LaunchAgent — NOT auto-installed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (f) => process.argv.includes(f);
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = has('--apply');
const TIER = arg('--tier', null);
const ONLY = arg('--repo', null);
const MODEL_CACHE = process.env.KB_MODEL_CACHE || path.join(ROOT, 'kb', 'models-cache');

// Optional author-side clone overrides via env (JSON map); default empty → uses CLONE_DIR/<name>.
const KNOWN_CLONES = JSON.parse(process.env.RUVNET_KNOWN_CLONES || '{}');
const CLONE_DIR = path.join(ROOT, 'clones');
// --full source-dir hints per repo (extend as repos onboard; default = whole tree, docs+manifests+lead-comments)
//
// The shipped v0.5.0-dev bundle's kb/*.passages.jsonl already contains substantial full-body
// source indexing for 14 repos, but only ruflo was ever recorded here. Without a hint, the FIRST
// time self-update.mjs ever rebuilds one of the other 13 (the moment any of them actually
// drifts), it silently downgrades that content from full source bodies to doc-comment-only
// snippets. Confirmed this happens in practice: rebuilding agent-harness-generator via
// self-update.mjs --apply (before this fix) took it from 201 full-body entries to 0.
//
// ruflo/agentdb/rulake have one clean top-level prefix each (or a hand-curated small set, for
// ruflo) that reproduces the existing indexing. The rest are genuinely scattered multi-crate/
// multi-package workspaces with no single clean prefix -- most span nearly every crate/package
// in the repo, which strongly suggests the original bulk build simply used --full over the
// whole tree for these T0-T2 tier repos rather than a hand-curated subset. The lists below are
// the exhaustive, empirically-derived minimal prefix set that reproduces every full-body path
// currently in the shipped bundle -- extracted directly from each repo's own
// kb/<name>.passages.jsonl, not guessed. The original build command isn't recorded anywhere, so
// these are reconstructed from evidence rather than confirmed against original intent -- please
// correct if the authoritative list (or a switch to a tier-based default) is preferred instead.
const FULL_HINTS = {
  'ruflo': 'v3/@claude-flow,v3/mcp,ruflo/src',
  'agentdb': 'src',
  'rulake': 'crates',
  'daa': 'crates/daa-ai,crates/daa-chain,crates/daa-economy,crates/daa-rules,daa-ai/src,daa-chain/src,daa-cli/src,daa-compute/benches,daa-compute/build.rs,daa-compute/src,daa-compute/tests,daa-economy/src,daa-mcp/src,daa-orchestrator/daa-napi,daa-orchestrator/src,daa-orchestrator/tests,daa-rules/src,daa-sdk/crates,examples/agents,examples/basic-crypto.ts,examples/decentralized-task-scheduler.ts,examples/federated-learning.ts,examples/full-stack-agent.ts,examples/orchestrator.ts,examples/performance-benchmark.ts,prime-rust/crates,prime-rust/prime-napi,prime-rust/tests,src/main.rs,src/security',
  'qudag': 'benchmarks/benches,benchmarks/cli,benchmarks/dark_addressing,benchmarks/lib.rs,benchmarks/optimized_benchmarks.rs,benchmarks/src,cli-standalone/src,cli-standalone/tests,core/crypto,core/dag,core/health.rs,core/monitoring,core/network,core/optimized,core/protocol,core/swarm,core/vault,examples/bitchat,examples/crypto,examples/dark_addressing_example.rs,examples/dht_discovery_example.rs,examples/nat_traversal_example.rs,examples/onion_routing_example.rs,examples/peer_management_example.rs,examples/persistence_example.rs,examples/shadow_address_example.rs,examples/traffic_obfuscation_example.rs,qudag-exchange/cli,qudag-exchange/core,qudag-exchange/crates,qudag-exchange/src,qudag-exchange/test_core_fee_model.rs,qudag-exchange/test_fee_model.rs,qudag-exchange/tests,qudag-mcp/benches,qudag-mcp/examples,qudag-mcp/src,qudag-mcp/tests,qudag-testnet/configs,qudag-wasm/final-test.mjs,qudag-wasm/simple-test.mjs,qudag-wasm/src,qudag-wasm/test-nodejs.mjs,qudag-wasm/test-setup.ts,qudag-wasm/tests,qudag-wasm/vitest.config.ts,qudag-wasm/vitest.workspace.ts,qudag-wasm/working-features-test.mjs,tools/cli,tools/simulator,tools/swarm-test,vault-standalone/examples,vault-standalone/src,vault-standalone/tests',
  'ruvector': 'crates/agentic-robotics-core,crates/agentic-robotics-mcp,crates/agentic-robotics-node,crates/agentic-robotics-rt,crates/cognitum-gate-kernel,crates/cognitum-gate-tilezero,crates/emergent-time,crates/emergent-time-wasm,crates/hailort-sys,crates/mcp-brain,crates/mcp-brain-server,crates/mcp-gate,crates/micro-hnsw-wasm,crates/neural-trader-coherence,crates/neural-trader-core,crates/neural-trader-replay,crates/neural-trader-wasm,crates/photonlayer-bench,crates/photonlayer-cli,crates/photonlayer-core,crates/photonlayer-ruvector,crates/photonlayer-wasm,crates/prime-radiant,crates/ruos-thermal,crates/ruvector-acorn,crates/ruvector-acorn-wasm,crates/ruvector-agent-memory,crates/ruvector-attention,crates/ruvector-attention-cli,crates/ruvector-attention-node,crates/ruvector-attention-wasm,crates/ruvector-attn-mincut,crates/ruvector-bench,crates/ruvector-bet4-ivf-bench,crates/ruvector-capgated,crates/ruvector-cli,crates/ruvector-cluster,crates/ruvector-cnn,crates/ruvector-cnn-wasm,crates/ruvector-coherence,crates/ruvector-coherence-hnsw,crates/ruvector-collections,crates/ruvector-consciousness,crates/ruvector-core,crates/ruvector-crv,crates/ruvector-dag,crates/ruvector-dag-wasm,crates/ruvector-decompiler,crates/ruvector-delta-core,crates/ruvector-delta-graph,crates/ruvector-delta-index,crates/ruvector-delta-wasm,crates/ruvector-diskann,crates/ruvector-diskann-node,crates/ruvector-dither,crates/ruvector-economy-wasm,crates/ruvector-exotic-wasm,crates/ruvector-filter,crates/ruvector-gnn,crates/ruvector-gnn-node,crates/ruvector-gnn-rerank,crates/ruvector-gnn-wasm,crates/ruvector-graph,crates/ruvector-graph-condense,crates/ruvector-graph-node,crates/ruvector-graph-wasm,crates/ruvector-hailo,crates/ruvector-hailo-cluster,crates/ruvector-hnsw-repair,crates/ruvector-hybrid,crates/ruvector-kalshi,crates/ruvector-learning-wasm,crates/ruvector-lsm-ann,crates/ruvector-math,crates/ruvector-math-wasm,crates/ruvector-matryoshka,crates/ruvector-maxsim,crates/ruvector-metrics,crates/ruvector-mincut,crates/ruvector-mincut-node,crates/ruvector-mincut-wasm,crates/ruvector-mmwave,crates/ruvector-nervous-system,crates/ruvector-node,crates/ruvector-perception,crates/ruvector-postgres,crates/ruvector-pq-search,crates/ruvector-profiler,crates/ruvector-proof-gate,crates/ruvector-rabitq,crates/ruvector-rabitq-wasm,crates/ruvector-raft,crates/ruvector-rairs,crates/ruvector-replication,crates/ruvector-robotics,crates/ruvector-router-cli,crates/ruvector-router-core,crates/ruvector-router-ffi,crates/ruvector-router-wasm,crates/ruvector-rulake,crates/ruvector-server,crates/ruvector-snapshot,crates/ruvector-solver,crates/ruvector-solver-node,crates/ruvector-solver-wasm,crates/ruvector-sota-bench,crates/ruvector-spann,crates/ruvector-sparsifier,crates/ruvector-tiny-dancer-node,crates/ruvector-verified,crates/ruvector-verified-wasm,crates/ruvector-wasm,crates/ruvix,crates/ruvllm,crates/ruvllm-cli,crates/ruvllm-wasm,crates/ruvllm_sparse_attention,crates/rvAgent,crates/rvf,crates/rvlite,crates/rvm,crates/sona,crates/sonic-ct,crates/sonic-ct-wasm,crates/thermorust,crates/timesfm',
  'ruv-fann': 'cuda-wasm/.eslintrc.js,cuda-wasm/benches,cuda-wasm/build.rs,cuda-wasm/cli,cuda-wasm/cuda-examples,cuda-wasm/demo,cuda-wasm/examples,cuda-wasm/jest.config.js,cuda-wasm/scripts,cuda-wasm/src,cuda-wasm/tests,examples/basic_usage.rs,examples/cuda_wasm_neural_integration.rs,examples/final_performance_demo.rs,examples/gpu_sweet_spot_benchmark.rs,examples/gpu_training_test.rs,examples/test_adam.rs,examples/test_gpu_detection.rs,examples/test_optimizers_simple.rs,examples/xor.rs,neuro-divergent/src,neuro-divergent/tests,opencv-rust/opencv-core,opencv-rust/opencv-sdk,opencv-rust/opencv-sys,opencv-rust/opencv-wasm,opencv-rust/tests,ruv-swarm/benches,ruv-swarm/benchmarking,ruv-swarm/crates,ruv-swarm/examples,ruv-swarm/ml-training,ruv-swarm/models,ruv-swarm/npm,ruv-swarm/test,ruv-swarm/test-simd-fix.mjs,ruv-swarm/test-wasm.js,ruv-swarm/tests,ruv-swarm/vitest.config.js,src/activation.rs,src/cascade.rs,src/connection.rs,src/errors.rs,src/integration.rs,src/io,src/layer.rs,src/lib.rs,src/memory_manager.rs,src/mock_types.rs,src/network.rs,src/network_gpu.rs,src/neuron.rs,src/simd,src/tests,src/training,src/webgpu',
  'agentic-flow': 'agentic-flow/.claude,agentic-flow/Python,agentic-flow/add_two_numbers.py,agentic-flow/app,agentic-flow/benchmark,agentic-flow/examples,agentic-flow/path,agentic-flow/scripts,agentic-flow/src,agentic-flow/tests,agentic-flow/validation,agentic-flow/vitest.config.ts,crates/agentic-flow-quic,examples/batch-query.js,examples/batch-store.js,examples/billing-example.ts,examples/cached-query.js,examples/climate-prediction,examples/connection-pool.js,examples/deepseek-direct-api.js,examples/nova-medicina,examples/perf-monitor.js,examples/quic-server-coordinator.js,examples/quic-swarm-coordination.js,examples/reasoningbank-benchmark.js,examples/reasoningbank-learning-demo.js,examples/reasoningbank-optimize.js,examples/research-swarm,examples/verification-example.ts,packages/agent-booster,packages/agentdb-onnx,packages/agentic-jujutsu,packages/agentic-llm,reasoningbank/examples,reasoningbank/tests,src/App.tsx,src/api,src/cli,src/components,src/consent,src/controller,src/controllers,src/main.tsx,src/mcp,src/middleware,src/notifications,src/pages,src/providers,src/routing,src/security,src/services,src/transport,src/types,src/utils,src/verification',
  'agent-harness-generator': 'crates/kernel,crates/kernel-napi,crates/kernel-wasm,crates/poker-darwin,crates/template-catalog,packages/aws-finops,packages/bench,packages/create-agent-harness,packages/darwin-mode,packages/harness,packages/host-claude-code,packages/host-codex,packages/host-copilot,packages/host-github-actions,packages/host-hermes,packages/host-openclaw,packages/host-opencode,packages/host-pi-dev,packages/host-rvm,packages/jujutsu,packages/kernel-js,packages/projects,packages/redblue,packages/router,packages/sdk,packages/vertical-base,packages/vertical-trading,packages/weight-eft',
  'safla': 'benchmarks/__init__.py,benchmarks/cli_benchmarks.py,benchmarks/core.py,benchmarks/database.py,benchmarks/safla_benchmarks.py,benchmarks/utils.py,examples/01_basic_setup.py,examples/02_simple_memory.py,examples/03_basic_safety.py,examples/05_delta_evaluation.py,examples/12_ai_assistant.py,examples/15_enterprise_integration.py,examples/config_examples.py,examples/hybrid_memory_demo.py,examples/mcp_auth_client.py,examples/mcp_usage,examples/safety_validation_demo.py,safla/__init__.py,safla/__main__.py,safla/api,safla/auth,safla/cli.py,safla/cli_implementations.py,safla/cli_interactive.py,safla/cli_main.py,safla/cli_manager.py,safla/core,safla/exceptions.py,safla/installer.py,safla/integrations,safla/mcp,safla/mcp_stdio_server.py,safla/middleware,safla/security,safla/utils,safla/validation,safla_mcp_enhanced.py,safla_mcp_server.py,safla_mcp_simple.py,scripts/advanced_optimization_engine.py,scripts/agent_swarm_optimizer.py,scripts/build.py,scripts/comprehensive_capability_test.py,scripts/continuous_optimization_engine.py,scripts/debug_enhanced_server.py,scripts/demo_jwt_mcp_client.py,scripts/final_capability_verification.py,scripts/final_system_test.py,scripts/gpu_optimization_benchmark.py,scripts/install.py,scripts/minimal_security_test.py,scripts/quick_capability_test.py,scripts/remote_gpu_benchmarker.py,scripts/save_extreme_optimizations.py,scripts/save_optimized_models.py,scripts/system_status_report.py,scripts/verify_system.py',
  'ruview': 'firmware/esp32-csi-node,firmware/esp32-hello-world,v2/crates',
  'open-claude-code': 'v2/src',
  'ruv-dev': 'bin/index.js,src/cli,src/core,src/index.js,src/utils',
  'agenticow': 'bin/agenticow.js,examples/_shared.mjs,examples/ab-at-scale.mjs,examples/ab-branches.mjs,examples/checkpointing.mjs,examples/compliance-lineage.mjs,examples/git-workflow.mjs,examples/memory-evolution.mjs,examples/multi-persona-consensus.mjs,examples/multi-tenant-saas.mjs,examples/parallel-agents.mjs,examples/parallel-selves.mjs,examples/personalization.mjs,examples/promotion-pipeline.mjs,examples/red-team-sandbox.mjs,examples/rollback-quarantine.mjs,examples/simulated-org.mjs,examples/time-travel-debug.mjs,src/index.d.ts,src/index.js',
};

const tiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/registry.tiers.json'), 'utf8'));
const manifest = fs.existsSync(path.join(ROOT, 'data/manifest.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/manifest.json'), 'utf8')) : { builtRepos: [] };
// case-insensitive: registry names are capitalized (RuVector) but built artifacts are lowercase (ruvector)
const builtSha = Object.fromEntries(manifest.builtRepos.map((r) => [r.name.toLowerCase(), r.builtFromSha]));

const remoteHead = (slug) => {
  try { return execFileSync('git', ['ls-remote', `https://github.com/ruvnet/${slug}`, 'HEAD'], { timeout: 30000 }).toString().split(/\s/)[0] || null; }
  catch { return null; }
};
const clonePath = (name) => KNOWN_CLONES[name] || path.join(CLONE_DIR, name);

const inScope = [];
for (const t of ['T0', 'T1', 'T2', 'T3']) {
  if (TIER && t !== TIER) continue;
  for (const r of tiers.tiers[t].repos) {
    if (ONLY && r.name !== ONLY) continue;
    if (t === 'T3' && !ONLY) continue;            // T3 is deep-walked on demand, not nightly
    inScope.push({ ...r, tier: t });
  }
}

const plan = [];
for (const r of inScope) {
  const live = remoteHead(r.name);
  const built = builtSha[r.name.toLowerCase()] || null;
  let action = 'up-to-date';
  if (!built) action = 'build (new)';
  // 'unknown' stamped SHA cannot prove freshness — treat as changed whenever upstream is reachable.
  // (Real bug: ruflo + agentic-flow were stamped unknown and therefore NEVER auto-rebuilt — the two
  // most-central repos were invisible to the freshness loop until a 3.24 release exposed it.)
  else if (built === 'unknown') action = live ? 'rebuild (changed)' : 'up-to-date';
  else if (live && live !== built) action = 'rebuild (changed)';
  plan.push({ name: r.name, tier: r.tier, built: built?.slice(0, 12) || '—', live: live?.slice(0, 12) || '?', action });
}

console.log(`self-update ${APPLY ? '(APPLY)' : '(dry-run)'} — ${plan.length} repos in scope\n`);
for (const p of plan) console.log(`  ${p.action.padEnd(20)} ${p.tier} ${p.name.padEnd(24)} built:${p.built}  live:${p.live}`);
// SAFE NIGHTLY SCOPE: by default only REBUILD already-built repos whose upstream changed (keeps the
// shipped bundle current). Building brand-new repos is a supervised, multi-hour scaling effort, NOT an
// unattended nightly job — gate it behind --include-new so the cron can't silently try to deep-walk 40+
// repos (days of compute) on its first run.
const INCLUDE_NEW = has('--include-new');
const changed = plan.filter((p) => p.action === 'rebuild (changed)');
const newRepos = plan.filter((p) => p.action === 'build (new)');
const todo = INCLUDE_NEW ? [...changed, ...newRepos] : changed;
console.log(`\nrebuild(changed): ${changed.map((p) => p.name).join(', ') || 'none'}`);
console.log(`new(not built): ${newRepos.length} repos${INCLUDE_NEW ? ' — INCLUDED (--include-new)' : ' — SKIPPED (supervised; pass --include-new to build)'}`);
console.log(`→ this run will (re)build ${todo.length}: ${todo.map((p) => p.name).join(', ') || 'none'}`);

if (!APPLY) { console.log('\n(dry-run — pass --apply to (re)build; runs serially since embedding is CPU-bound)'); process.exit(0); }

const failures = []; // per-repo build failures collected here; ANY failure aborts before publish (see below)
for (const p of todo) {
  const dir = clonePath(p.name);
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      console.log(`[clone] ${p.name}`);
      fs.mkdirSync(CLONE_DIR, { recursive: true });
      execFileSync('git', ['clone', '--depth', '1', `https://github.com/ruvnet/${p.name}`, dir], { stdio: 'inherit' });
    } else {
      execFileSync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin'], { stdio: 'inherit' });
      execFileSync('git', ['-C', dir, 'reset', '--hard', 'origin/HEAD'], { stdio: 'inherit' });
    }
    const env = { ...process.env, KB_MODEL_CACHE: MODEL_CACHE };
    const kb = p.name.toLowerCase();                 // artifacts are lowercase (ruvector.rvf), registry name is RuVector
    const full = FULL_HINTS[kb];
    const buildArgs = ['forge-build.mjs', '--repo', dir, '--out', '.', '--name', kb,
      '--canonical-url', process.env.RUVNET_CANONICAL_URL || 'https://raw.githubusercontent.com/ruvnet/ruvnet-brain/main/kb'];
    if (full) buildArgs.push('--full', full);
    console.log(`[build] ${kb}`);
    execFileSync('node', buildArgs, { cwd: path.join(ROOT, 'kb'), env, stdio: 'inherit' });
    console.log(`[sharp] ${kb}`);
    execFileSync('node', ['forge-big.mjs', 'both', '--dir', '.', '--name', kb], { cwd: path.join(ROOT, 'kb'), env, stdio: 'inherit' });
    console.log(`[symbols] ${kb}`);
    execFileSync('node', ['scripts/build-symbols.mjs', '--name', kb], { cwd: ROOT, env, stdio: 'inherit' });
  } catch (e) { console.error(`[FAIL] ${p.name}: ${e.message}`); failures.push({ name: p.name, error: e.message }); }
}

// A per-repo build failure used to be logged and swallowed — the run then re-stamped, re-bundled and (with
// --publish) cut a Release + git push based on todo.length alone, shipping a half-rebuilt brain (stale or
// missing stores) under a fresh version. Fail loud instead: if ANY repo failed, abort BEFORE stamp/bundle
// and the publish block (gh release create / git push) with a non-zero exit, so the nightly log surfaces it
// and nothing partial is released.
if (failures.length) {
  console.error(`\n[FATAL] ${failures.length} repo build(s) failed this run — aborting before stamp/bundle/publish. NOTHING released (no re-stamp, no Release, no version bump, no push):`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  console.error('Fix the failing repo(s) and re-run.');
  process.exit(1);
}

console.log('\n[stamp] re-stamping bundle');
execFileSync('node', ['scripts/brain-stamp.mjs'], { cwd: ROOT, stdio: 'inherit' });
// refresh the shipped bundle so the rebuilt deep-source ships (concepts/primers/L2 are supervised — not regenerated here)
console.log('[bundle] re-assembling dist/ruvnet-brain');
execFileSync('node', ['scripts/build-bundle.mjs'], { cwd: ROOT, env: { ...process.env, KB_MODEL_CACHE: MODEL_CACHE }, stdio: 'inherit' });
console.log('self-update done. (Deep-source refreshed + bundle re-assembled. Primer/L2/concepts + grading are supervised steps — re-run them when a repo materially changes.)');

// ── PUBLISH (the last mile): local rebuild → users, automatically. ─────────────────────────────
// Without this, the nightly makes the LOCAL brain smarter while releases/latest never advances —
// users' auto-updaters correctly report "up to date" against a stale Release forever. Gated on
// --publish (the LaunchAgent passes it; ad-hoc manual runs don't publish by accident) and on
// something having actually been rebuilt this run. ONE product version: plugin.json's version is
// bumped (patch) and shipped in the same Release tag, so brain content and plugin always move
// under a single user-visible number. Fail-loud: any error here exits non-zero into the nightly
// log; nothing is half-published silently (release create is atomic per-tag; the version-bump
// commit only pushes after the Release exists).
if (has('--publish')) {
  if (todo.length === 0) {
    console.log('[publish] nothing was rebuilt — no new Release needed. Done.');
  } else {
    const PLUGIN_JSON = path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
    const m = pj.version.match(/^(\d+)\.(\d+)\.(\d+)(-dev)?$/);
    if (!m) { console.error(`[publish] FAIL: cannot parse plugin version "${pj.version}"`); process.exit(1); }
    const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] || ''}`;
    const tag = `v${next}`;
    pj.version = next;
    pj.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(PLUGIN_JSON, JSON.stringify(pj, null, 2) + '\n');
    console.log(`[publish] product version → ${next} (${tag})`);

    // Keep the README's bright-blue version badge in lockstep (Stuart's rule: version + updated
    // timestamp with timezone, bright blue, first thing anyone sees). GitHub strips color from
    // markdown text, so the line is a shields.io for-the-badge image — colors guaranteed.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).formatToParts(new Date());
    const g = (t) => fmt.find((p) => p.type === t)?.value || '';
    const human = `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${g('timeZoneName')}`;
    const badgeStamp = human.replace(/-/g, '--').replace(/ /g, '_');
    const badgeVer = next.replace(/-/g, '--');
    const badge = `https://img.shields.io/badge/version_${badgeVer}-updated_${badgeStamp}-1E90FF?style=for-the-badge&labelColor=0757BA`;
    const README = path.join(ROOT, 'README.md');
    const readme = fs.readFileSync(README, 'utf8').replace(
      /^### 🧠 RuvNet Brain — \[!\[.*$/m,
      `### 🧠 RuvNet Brain — [![RuvNet Brain version ${next} — updated ${human}](${badge})](https://github.com/stuinfla/ruvnet-brain/blob/main/plugin/.claude-plugin/plugin.json)`,
    );
    fs.writeFileSync(README, readme);

    const zipPath = path.join(ROOT, 'dist', 'ruvnet-brain.zip');
    console.log('[publish] zipping bundle (private stores already fenced out at assembly)');
    try { fs.unlinkSync(zipPath); } catch {}
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', path.join(ROOT, 'dist', 'ruvnet-brain'), zipPath], { stdio: 'inherit' });

    // Sign the bundle (SEC-0010 #6) so the installer can verify-before-extract. Transitional: if no
    // signing key is available in this env yet (RUVNET_SIGNING_KEY / .secrets/…key.pem), warn and ship
    // unsigned rather than break the nightly — once the key is wired in, every release ships signed and
    // install.mjs's SIGNING_REQUIRED can flip to true. sign-bundle emits <zip>.sig + <zip>.sha256.
    const sigAssets = [];
    try {
      execFileSync('node', ['scripts/sign-bundle.mjs', '--bundle', zipPath], { cwd: ROOT, stdio: 'inherit' });
      for (const a of [`${zipPath}.sig`, `${zipPath}.sha256`]) if (fs.existsSync(a)) sigAssets.push(a);
      console.log(`[publish] signed bundle (${sigAssets.length} signature asset(s) will be uploaded)`);
    } catch (e) {
      console.warn(`[publish] WARNING: bundle NOT signed (${e.message.split('\n')[0]}). Shipping unsigned (transitional). Set RUVNET_SIGNING_KEY in the nightly env to enable signing.`);
    }

    console.log(`[publish] creating GitHub Release ${tag} + uploading bundle (~this can take minutes)`);
    execFileSync('gh', ['release', 'create', tag, zipPath, ...sigAssets,
      '--title', `${tag} — nightly brain refresh`,
      '--notes', `Automated nightly: re-ingested upstream changes in: ${todo.map((p) => p.name).join(', ')}. One product version — plugin ${next} + this knowledge bundle ship together; user installs pick both up automatically.`,
    ], { cwd: ROOT, stdio: 'inherit' });

    console.log('[publish] committing version bump + stamped manifests, pushing');
    execFileSync('git', ['add', 'README.md', 'plugin/.claude-plugin/plugin.json', 'data/manifest.json', 'primer/ruvnet-primer.md'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', `Nightly brain refresh ${tag}: ${todo.map((p) => p.name).join(', ')}\n\nAutomated by scripts/self-update.mjs --publish (launchd com.ruvnet.brain-nightly).`], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
    console.log(`[publish] DONE — ${tag} live. Users' heartbeats will pick up plugin + brain automatically.`);
  }
}
