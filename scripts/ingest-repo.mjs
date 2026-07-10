#!/usr/bin/env node
// ingest-repo.mjs — pull ANY github.com/ruvnet/<name> repo into the brain ON DEMAND.
//
//   clone (shallow) -> deep-walk + embed (MiniLM-384) -> sharp re-embed (bge-768) -> symbol index
//
// After it finishes the new repo is searchable immediately: search_ruvnet / forge-ask-all discover
// every <name>.rvf in the kb dir at query time, so no server restart is needed. Use this when a
// project needs a RuvNet repo the brain doesn't cover yet — load it first, don't guess about it.
//
//   node scripts/ingest-repo.mjs --name rvm
//
// For full capability-confidence on the new repo (so it's never wrongly doubted), also build its
// prose primer afterwards:
//   node scripts/build-primer.mjs --name <name> --variant big
//   node scripts/build-concepts.mjs && node kb/forge-big.mjs both --dir kb --name concepts
//
// Portable: paths resolve relative to this file; model cache via KB_MODEL_CACHE (or auto-download).
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FULL_HINTS, KEEP_DIRS } from './full-hints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NAME = arg('--name');
// --org lets us ingest ecosystem repos that live in a rUv COLLABORATOR org (e.g. the QE fleet at
// proffesor-for-testing/agentic-qe), not just github.com/ruvnet/*. Defaults to ruvnet.
const ORG = arg('--org', 'ruvnet');
if (!NAME) { console.error('Usage: node scripts/ingest-repo.mjs --name <repo> [--org <github-org>]'); process.exit(2); }

const KB = path.join(ROOT, 'kb');
const CLONES = path.join(ROOT, 'clones');
const kb = NAME.toLowerCase();
const dir = path.join(CLONES, NAME);
const env = { ...process.env };
const run = (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

fs.mkdirSync(CLONES, { recursive: true });
if (!fs.existsSync(path.join(dir, '.git'))) {
  console.log(`[clone] ${ORG}/${NAME}`);
  run('git', ['clone', '--depth', '1', `https://github.com/${ORG}/${NAME}`, dir]);
} else {
  console.log(`[update] ${ORG}/${NAME}`);
  run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin']);
  run('git', ['-C', dir, 'reset', '--hard', 'origin/HEAD']);
}

const url = process.env.RUVNET_CANONICAL_URL || 'https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/kb';
// Depth config (--full / --keep) comes from the SHARED per-repo map, overridable per-invocation.
// Before this, ingest-repo.mjs never passed --full: any repo rebuilt through it silently lost its
// full-body source indexing (the 2026-07-10 depth-restore run zeroed ruvector this way).
const FULL = arg('--full', FULL_HINTS[kb] || '');
const KEEP = arg('--keep', KEEP_DIRS[kb] || '');
const buildArgs = ['forge-build.mjs', '--repo', dir, '--out', '.', '--name', kb, '--canonical-url', url];
if (FULL) buildArgs.push('--full', FULL);
if (KEEP) buildArgs.push('--keep', KEEP);
console.log(`[embed MiniLM-384] ${kb}${FULL ? ' (--full: ' + FULL.split(',').length + ' prefixes)' : ''}${KEEP ? ' (--keep: ' + KEEP + ')' : ''}`);
run('node', buildArgs, { cwd: KB, env });
// bge-768 re-embed. Default = single-process `forge-big.mjs both` (the committed pipeline
// behavior). For bulk work, opt into N parallel embed shards via RUVNET_BIG_SHARDS=N —
// forge-big both is CPU-bound at ~4 passages/s; 4 shards cut wall time ~4x on an M-series Mac.
const SHARDS = Math.max(1, parseInt(process.env.RUVNET_BIG_SHARDS || '1', 10) || 1);
console.log(`[embed bge-768 sharp] ${kb} (${SHARDS} shard(s))`);
if (SHARDS === 1) {
  run('node', ['forge-big.mjs', 'both', '--dir', '.', '--name', kb], { cwd: KB, env });
} else {
  await Promise.all(Array.from({ length: SHARDS }, (_, i) => new Promise((resolve, reject) => {
    const child = execFile('node', ['forge-big.mjs', 'embed', '--dir', '.', '--name', kb, '--shard', String(i), '--of', String(SHARDS)],
      { cwd: KB, env, maxBuffer: 64 * 1024 * 1024 },
      (err) => err ? reject(new Error(`big embed shard ${i}/${SHARDS} failed: ${err.message}`)) : resolve());
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  })));
  run('node', ['forge-big.mjs', 'ingest', '--dir', '.', '--name', kb], { cwd: KB, env });
}
console.log(`[symbols] ${kb}`);
try { run('node', ['scripts/build-symbols.mjs', '--name', kb], { cwd: ROOT, env }); } catch { console.log('  (symbols skipped — sparse repo)'); }

const ok = fs.existsSync(path.join(KB, `${kb}.rvf`)) && fs.existsSync(path.join(KB, `${kb}.big.rvf`));
console.log(ok
  ? `\n[done] ${NAME} ingested → searchable now via search_ruvnet (no restart). For capability-confidence, build its primer next.`
  : `\n[FAIL] ${NAME}: expected stores missing after build.`);
process.exit(ok ? 0 : 1);
