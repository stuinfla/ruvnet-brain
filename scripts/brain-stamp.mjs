#!/usr/bin/env node
// brain-stamp.mjs — stamp the bundle with build date + per-repo commit SHA.
// Writes data/manifest.json and injects the stamp into the primer header + each KB SOURCE.json.
// Run after a (re)build. Self-update calls this so every download says exactly what it covers.
//
// Usage: node scripts/brain-stamp.mjs [--brain-version v0.1.0-dev]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalRvfStores, hasCanonicalRvfStore, readRvfGenerations } from './rvf-generation.mjs';
import { resolveBuiltFromSha } from './brain-stamp-resolve.mjs';
import { getVersionTag, stripTag } from './version.mjs';
// The org total is DERIVED, never a literal: it was hardcoded 248 in this file and in its
// sibling while the account actually had 200 — one stale fact, restated twice (2026-08-12).
import { orgRepoCount } from './org-repo-count.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BRAIN_VERSION = arg('--brain-version', getVersionTag()); // inherits the single source of truth
const NOW = new Date().toISOString();
const KB_DIR = path.join(ROOT, 'kb');

// Known local clones (extend as repos are added). Self-update resolves remote SHAs for the rest.
const CLONES = JSON.parse(process.env.RUVNET_KNOWN_CLONES || '{}');
const builtName = (n) => hasCanonicalRvfStore(KB_DIR, n);
const shaOf = (dir) => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim(); } catch { return null; } };
// no shell: slug is placed in a URL arg, never interpreted by a shell
const remoteSha = (slug) => { try { return execFileSync('git', ['ls-remote', `https://github.com/ruvnet/${slug}`, 'HEAD']).toString().split(/\s/)[0] || null; } catch { return null; } };

const generations = readRvfGenerations(KB_DIR).stores || {};
const tiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/registry.tiers.json'), 'utf8'));
const repos = [];
for (const t of ['T0', 'T1', 'T2', 'T3']) {
  for (const r of tiers.tiers[t].repos) {
    // Default clone location is ROOT/clones/<name> (where self-update.mjs puts them) — the env
    // override is the exception, not the only source. Stamping 'unknown' when a real clone sits
    // on disk made unknown-SHA repos permanently invisible to the freshness loop (ruflo bug).
    const cloneDir = CLONES[r.name] || path.join(ROOT, 'clones', r.name);
    const localSha = fs.existsSync(path.join(cloneDir, '.git')) ? shaOf(cloneDir) : null;
    repos.push({
      name: r.name, tier: t, stars: r.stars,
      builtFromSha: builtName(r.name) ? resolveBuiltFromSha(r.name, { generations, localSha }) : null,
      latestRemoteSha: null,           // filled by --check-remote (network) in self-update
      status: builtName(r.name) ? 'built' : 'pending',
    });
  }
}

// DURABILITY FIX (nail-the-nightly): the nightly is now --fresh-window / live-scan driven, but this
// stamper was tiers-file driven. A repo discovered by --fresh-window that isn't in the static
// registry.tiers.json would build every night yet never receive a builtFromSha, so the freshness loop
// would REBUILD it forever. Stamp EVERY built store on disk (tiers-listed or not) so "unchanged =>
// skipped" holds for fresh-window repos too. Clone dir resolved case-insensitively (store names are
// lowercased; clone dirs keep the repo's own casing, e.g. kb/photonlayer.rvf <- clones/PhotonLayer).
const clonesDir = path.join(ROOT, 'clones');
const cloneEntries = fs.existsSync(clonesDir) ? fs.readdirSync(clonesDir) : [];
const findClone = (name) => {
  if (CLONES[name] && fs.existsSync(path.join(CLONES[name], '.git'))) return CLONES[name];
  const exact = path.join(clonesDir, name);
  if (fs.existsSync(path.join(exact, '.git'))) return exact;
  const ci = cloneEntries.find((d) => d.toLowerCase() === name.toLowerCase());
  return ci && fs.existsSync(path.join(clonesDir, ci, '.git')) ? path.join(clonesDir, ci) : null;
};
const seen = new Set(repos.map((r) => r.name.toLowerCase()));
for (const store of canonicalRvfStores(KB_DIR)) {
  if (seen.has(store.toLowerCase())) continue;
  seen.add(store.toLowerCase());
  const cloneDir = findClone(store);
  repos.push({
    name: store, tier: 'fresh', stars: undefined,
    builtFromSha: resolveBuiltFromSha(store, { generations, localSha: cloneDir ? shaOf(cloneDir) : null }),
    latestRemoteSha: null,
    status: 'built',
  });
}
const built = repos.filter((r) => r.status === 'built');
const ORG = orgRepoCount();
const manifest = {
  brainVersion: stripTag(BRAIN_VERSION), // FIELD = bare literal; the "v" tag is display-only (see version.mjs)
  generated: NOW,
  generatedHuman: new Date(NOW).toUTCString(),
  coverage: { built: built.length, catalogued: repos.length, orgTotalApprox: ORG.count, orgTotalSource: ORG.source, orgTotalAt: ORG.at, pending: repos.length - built.length },
  builtRepos: built,
  pendingRepos: repos.filter((r) => r.status === 'pending').map((r) => ({ name: r.name, tier: r.tier })),
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/manifest.json'), JSON.stringify(manifest, null, 2));

// Stamp the primer header line.
const primerPath = path.join(ROOT, 'primer/ruvnet-primer.md');
if (fs.existsSync(primerPath)) {
  let p = fs.readFileSync(primerPath, 'utf8');
  const stamp = `\`Brain version: ${BRAIN_VERSION} · Built: ${new Date(NOW).toISOString().slice(0, 10)} · Covers: ${built.length}/${repos.length} repos built @ pinned SHAs (see data/manifest.json)\``;
  p = p.replace(/`Brain version:[^`]*`/, stamp);
  fs.writeFileSync(primerPath, p);
}
console.log(`Stamped ${BRAIN_VERSION} @ ${NOW}`);
console.log(`Coverage: ${built.length} built / ${repos.length} total`);
for (const b of built) console.log(`  ${b.tier} ${b.name} @ ${b.builtFromSha?.slice(0, 12)}`);
