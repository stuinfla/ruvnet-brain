#!/usr/bin/env node
// ingest-repo.mjs — pull ANY github.com/ruvnet/<name> repo into the brain ON DEMAND.
//
//   clone (shallow) -> transactional incremental bge-768 refresh -> symbol index
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FULL_HINTS, KEEP_DIRS } from './full-hints.mjs';
import { storeRoot } from '../kb/store-root.mjs';
import { applyPrivateOverlay } from './private-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NAME = arg('--name');
// --org lets us ingest ecosystem repos that live in a rUv COLLABORATOR org (e.g. the QE fleet at
// proffesor-for-testing/agentic-qe), not just github.com/ruvnet/*. Defaults to ruvnet.
const ORG = arg('--org', 'ruvnet');
const SOURCE = arg('--source');
if (!NAME) {
  console.error('Usage: node scripts/ingest-repo.mjs --name <repo> [--org <github-org>] [--source <local-checkout>]');
  process.exit(2);
}

// THE WRITER NOW USES THE SAME RESOLVER AS THE READER. This was `path.join(ROOT, 'kb')` — the
// repo's build directory — while retrieval (kb/forge-mcp-all.mjs) reads storeRoot(), which defaults
// to ~/.cache/ruvnet-brain/kb. That split is why on 2026-08-12 three repos were ingested, each
// printed `roundtrip 3/3 PASS` and "searchable now", and NONE of them could be found by search: the
// ingest wrote one root and the live brain read another. This file's own header promises "the new
// repo is searchable immediately", and that promise was false by construction.
//
// Two adversarial audits both flagged that fixing the READER alone (kb/store-root.mjs, earlier
// today) made the split GUARANTEED rather than accidental for a dev checkout. This closes it at the
// writer, which is the half that was left.
//
// The repo's own bundle build still targets ./kb by setting KB_DIR — an explicit override of a
// stated default, not a second answer to the same question.
// TWO DIFFERENT THINGS, WHICH THE ORIGINAL `path.join(ROOT,'kb')` CONFLATED and my first fix
// inherited: where the BUILD SCRIPTS live (forge-refresh.mjs, always in this checkout) and where
// the STORES go (the root retrieval actually reads). Pointing both at storeRoot() broke immediately
// with `Cannot find module .../.cache/ruvnet-brain/kb/forge-refresh.mjs` — the tool is not the
// output. One name for two facts is the same defect as one fact in two names.
const KB_TOOLS = path.join(ROOT, 'kb');   // where forge-refresh.mjs lives
const KB = storeRoot();                   // where stores go — the root the reader reads
const CLONES = path.join(ROOT, 'clones');
const kb = NAME.toLowerCase();
const dir = SOURCE ? path.resolve(SOURCE) : path.join(CLONES, NAME);
const env = { ...process.env };
const run = (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

fs.mkdirSync(CLONES, { recursive: true });
if (SOURCE) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.error(`[source] ${dir} is not a git checkout`);
    process.exit(2);
  }
  console.log(`[source] local candidate ${dir}`);
} else if (!fs.existsSync(path.join(dir, '.git'))) {
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
// `--out` is the STORE ROOT, not '.' — cwd is the tools directory now, and '.' would have written
// the store next to the build script, which is precisely the reader/writer split this change closes.
const buildArgs = ['forge-refresh.mjs', '--repo', dir, '--out', KB, '--name', kb, '--canonical-url', url];
if (FULL) buildArgs.push('--full', FULL);
if (KEEP) buildArgs.push('--keep', KEEP);
console.log(`[refresh bge-768] ${kb}${FULL ? ' (--full: ' + FULL.split(',').length + ' prefixes)' : ''}${KEEP ? ' (--keep: ' + KEEP + ')' : ''}`);
run('node', buildArgs, { cwd: KB_TOOLS, env });
console.log(`[symbols] ${kb}`);
try { run('node', ['scripts/build-symbols.mjs', '--name', kb], { cwd: ROOT, env }); } catch { console.log('  (symbols skipped — sparse repo)'); }

const ok = fs.existsSync(path.join(KB, `${kb}.big.rvf`))
  && fs.existsSync(path.join(KB, `${kb}.passages.jsonl`))
  && fs.existsSync(path.join(KB, `${kb}.meta.json`));
// BUILT IS NOT REACHABLE, AND THIS LINE USED TO CLAIM OTHERWISE. It printed "searchable now" on
// the strength of three files existing. Measured 2026-08-13 on the very next run: helix ingested
// cleanly, every file present, and `search_ruvnet` answered "Searched 0 RuvNet repos" — the router
// declined because nothing in capability-cards.md describes the repo, so a by-description query
// cannot reach it. 26 of 66 stores are in exactly that state. The 2026-08-12 incident (three repos
// ingested, all reporting success, none findable) was read as a path bug; the path was only half of
// it. A store with no card is BUILT AND DARK, and saying "searchable" of it is the product lying.
const carded = (() => {
  try {
    return new RegExp(`^##\\s+${kb}\\s*$`, 'im')
      .test(fs.readFileSync(path.join(KB, 'capability-cards.md'), 'utf8'));
  } catch { return false; }
})();
// AN ARTIFACT WITH NO COMMITTED RECIPE IS NOT DURABLE WORK — it is a local side effect with a
// countdown on it. Proven overnight 2026-08-13 -> 08-14: a scheduled bundle apply extracted an
// Aug-8 bundle over the live cache. capability-cards.md SURVIVED because it was committed and the
// brain was restored from the repo in one command. helix, rvQR, RuCelium and wifi-veil — ingested
// and VERIFIED ROUTING hours earlier — were gone without a trace, because a .rvf is a 32MB
// gitignored build artifact that existed in exactly one directory on one machine.
//
// The stores themselves cannot be committed. The FACT that they were ingested can, so a wipe
// becomes detectable and replayable instead of silent and permanent. This record is the recipe.
let ownershipFailure = null;
if (ok) {
  let rest = [];
  try {
    const ledger = path.join(ROOT, 'kb', 'local-ingests.json');
    const prior = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : { ingests: [] };
    rest = (prior.ingests || []).filter((e) => e.name !== NAME);
    rest.push({ name: NAME, org: ORG, at: new Date().toISOString(), store: kb });
    rest.sort((a, b) => a.name.localeCompare(b.name));
    fs.writeFileSync(ledger, `${JSON.stringify({ ingests: rest }, null, 2)}\n`);
    console.log(`[record] kb/local-ingests.json — ${rest.length} local ingest(s) recorded. COMMIT THIS.`);
  } catch (e) { console.log(`[record] could not record the ingest: ${e.message}`); }

  // S3 (explicit local ownership): stamp updateManaged:false + origin:'local-ingest' into the LIVE
  // store root's own SOURCE.json (via scripts/private-overlay.mjs's writer — --from equals --root
  // here, since forge-refresh.mjs already wrote the bytes directly into KB; the writer degenerates
  // to registry-stamping only, see its own header). Without this a store built through THIS script
  // reads exactly like a normal public store to kb/forge-update.mjs — unmarked, and therefore
  // silently deleted the moment it is absent from an incoming public bundle.
  //
  // ONE-TIME MIGRATION for stores this script ingested BEFORE this fix shipped: every OTHER name
  // this ledger already recorded is retroactively re-stamped too, provided its files still exist and
  // it is not already an update-managed (public) SOURCE.json entry. This runs HERE — where the
  // recipe ledger (kb/local-ingests.json, git-tracked in the checkout) and the live store root (KB,
  // ~/.cache/ruvnet-brain/kb by default — a DIFFERENT, non-git-tracked directory, see kb/store-
  // root.mjs) are both actually in scope in the same process — rather than inside kb/forge-update.mjs,
  // which runs against an installed KB tree with no reliable path back to this checkout's ledger.
  const candidateNames = [...new Set([kb, ...rest.map((e) => e.store).filter(Boolean)])];
  const sourceFile = path.join(KB, 'SOURCE.json');
  let liveSourceStores = {};
  try { liveSourceStores = JSON.parse(fs.readFileSync(sourceFile, 'utf8')).stores || {}; } catch { /* handled by applyPrivateOverlay below */ }
  const toStamp = candidateNames.filter((name) => {
    const existing = liveSourceStores[name];
    if (existing && existing.updateManaged !== false) return false; // a real public store — never shadow it
    return [`${name}.big.rvf`, `${name}.big.rvf.embed.json`, `${name}.big.rvf.idmap.json`, `${name}.meta.json`, `${name}.passages.jsonl`]
      .every((file) => fs.existsSync(path.join(KB, file)));
  });
  if (!toStamp.includes(kb)) {
    ownershipFailure = 'canonical sidecars incomplete or existing public-store ownership cannot be relabeled';
  } else if (toStamp.length) {
    try {
      const fenceFile = path.join(KB, 'PRIVATE-STORES.json');
      const fence = fs.existsSync(fenceFile) ? JSON.parse(fs.readFileSync(fenceFile, 'utf8')) : { privateStores: [] };
      const fenceNames = new Set((fence.privateStores || []).map((n) => String(n).toLowerCase()));
      const additions = toStamp.filter((name) => !fenceNames.has(name.toLowerCase()));
      if (additions.length) {
        fence.privateStores = [...new Set([...(fence.privateStores || []), ...additions])].sort();
        fs.writeFileSync(fenceFile, `${JSON.stringify(fence, null, 2)}\n`);
      }
      const receipt = applyPrivateOverlay({ root: KB, from: KB, stores: toStamp, origin: 'local-ingest' });
      const owned = JSON.parse(fs.readFileSync(sourceFile, 'utf8')).stores?.[kb];
      const verifiedFence = JSON.parse(fs.readFileSync(fenceFile, 'utf8')).privateStores;
      if (owned?.updateManaged !== false || owned.origin !== 'local-ingest'
        || !Array.isArray(verifiedFence) || !verifiedFence.some(name => String(name).toLowerCase() === kb)) {
        throw new Error('local ownership readback unconfirmed');
      }
      const stamped = receipt.stores.filter((entry) => entry.changes.includes('SOURCE.json')).map((entry) => entry.name);
      if (stamped.length) console.log(`[local-ownership] marked updateManaged:false (origin: local-ingest) — ${stamped.join(', ')}`);
    } catch (e) {
      ownershipFailure = e.message;
      console.log(`[local-ownership] could not stamp local ownership (${e.message}); the next forge-update.mjs --apply may remove ${toStamp.join(', ')} if they are absent from the incoming bundle`);
    }
  }
}

if (ownershipFailure) {
  console.log(`[UNKNOWN] ${NAME}: local ownership unconfirmed (${ownershipFailure}); built bytes and recipe retained, ingestion incomplete.`);
  process.exit(1);
}

console.log(!ok
  ? `\n[FAIL] ${NAME}: expected stores missing after build.`
  : carded
    ? `\n[done] ${NAME} ingested AND routable → answers by-description queries now (no restart).`
    : `\n[done] ${NAME} ingested, but DARK: no '## ${kb}' section in ${path.join(KB, 'capability-cards.md')}.\n`
      + `       The store is valid and a by-description query CANNOT reach it. Write a card describing\n`
      + `       what ${NAME} is for and when to reach for it, then re-check with a real search_ruvnet query.`);
process.exit(ok ? 0 : 1);
