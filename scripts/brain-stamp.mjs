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
import { getVersionTag, stripTag } from './version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BRAIN_VERSION = arg('--brain-version', getVersionTag()); // inherits the single source of truth
const NOW = new Date().toISOString();

// Known local clones (extend as repos are added). Self-update resolves remote SHAs for the rest.
const CLONES = JSON.parse(process.env.RUVNET_KNOWN_CLONES || '{}');
const builtName = (n) => fs.existsSync(path.join(ROOT, 'kb', `${n}.rvf`));
const shaOf = (dir) => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim(); } catch { return null; } };
// no shell: slug is placed in a URL arg, never interpreted by a shell
const remoteSha = (slug) => { try { return execFileSync('git', ['ls-remote', `https://github.com/ruvnet/${slug}`, 'HEAD']).toString().split(/\s/)[0] || null; } catch { return null; } };

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
      builtFromSha: builtName(r.name) ? (localSha || 'unknown') : null,
      latestRemoteSha: null,           // filled by --check-remote (network) in self-update
      status: builtName(r.name) ? 'built' : 'pending',
    });
  }
}
const built = repos.filter((r) => r.status === 'built');
const manifest = {
  brainVersion: stripTag(BRAIN_VERSION), // FIELD = bare literal; the "v" tag is display-only (see version.mjs)
  generated: NOW,
  generatedHuman: new Date(NOW).toUTCString(),
  coverage: { built: built.length, catalogued: repos.length, orgTotalApprox: 248, pending: repos.length - built.length },
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
