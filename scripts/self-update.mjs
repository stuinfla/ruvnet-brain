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
const FULL_HINTS = { ruflo: 'v3/@claude-flow,v3/mcp,ruflo/src' };

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
  else if (live && built !== 'unknown' && live !== built) action = 'rebuild (changed)';
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
  } catch (e) { console.error(`[FAIL] ${p.name}: ${e.message}`); }
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

    // Keep the README's human-readable version line in lockstep (Stuart's rule: first thing
    // anyone sees must state the exact current version — badges lag, text doesn't).
    const README = path.join(ROOT, 'README.md');
    const readme = fs.readFileSync(README, 'utf8').replace(
      /^### RuvNet Brain version .*$/m,
      `### RuvNet Brain version ${next} — updated ${pj.updated}`,
    );
    fs.writeFileSync(README, readme);

    const zipPath = path.join(ROOT, 'dist', 'ruvnet-brain.zip');
    console.log('[publish] zipping bundle (private stores already fenced out at assembly)');
    try { fs.unlinkSync(zipPath); } catch {}
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', path.join(ROOT, 'dist', 'ruvnet-brain'), zipPath], { stdio: 'inherit' });

    console.log(`[publish] creating GitHub Release ${tag} + uploading bundle (~this can take minutes)`);
    execFileSync('gh', ['release', 'create', tag, zipPath,
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
