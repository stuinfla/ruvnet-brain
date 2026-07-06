// sync-version.mjs — propagate the ONE source-of-truth version (plugin.json) into the files that must
// carry a literal, and (with --check) fail if any surface has drifted. SEC-0010 #2 / ADR-0009 decision 1.
//
//   node scripts/sync-version.mjs           # write plugin.json's version into all inheriting files
//   node scripts/sync-version.mjs --check    # CI mode: exit 1 if any surface disagrees (writes nothing)
//
// The ONE hand-edited number is plugin/.claude-plugin/plugin.json `version`. Bump it there, run this,
// and every other surface follows. `--check` in CI makes drift impossible to merge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersion } from './version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const V = getVersion();
const TODAY = new Date().toISOString().slice(0, 10);
let drift = 0;

// Each target: a file, a regex to find the version-bearing line, and the corrected line.
const targets = [
  { // npm installer package — inherits the product version (publish in lockstep)
    file: 'package.json',
    get: (s) => (JSON.parse(s).version),
    set: (s) => s.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${V}"`),
  },
  { // the brain bundle's product-version stamp (corpus provenance stays in SOURCE.json separately)
    file: 'data/manifest.json',
    get: (s) => { const m = s.match(/"brainVersion"\s*:\s*"([^"]+)"/); return m ? m[1] : null; },
    set: (s) => s.replace(/("brainVersion"\s*:\s*)"[^"]+"/, `$1"${V}"`),
  },
  { // the MCP server's advertised version
    file: 'kb/package.json',
    get: (s) => (JSON.parse(s).version),
    set: (s) => s.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${V}"`),
  },
];

for (const t of targets) {
  const p = path.join(ROOT, t.file);
  if (!fs.existsSync(p)) continue;
  const s = fs.readFileSync(p, 'utf8');
  const cur = t.get(s);
  if (cur === V) continue;
  if (CHECK) { console.error(`[version] DRIFT: ${t.file} = ${cur}, expected ${V}`); drift++; }
  else { fs.writeFileSync(p, t.set(s)); console.log(`[version] ${t.file}: ${cur} -> ${V}`); }
}

// README: the visible badge already reads plugin.json live via shields.io; the human-readable heading
// line ("RuvNet Brain version X — updated Y") is the one literal, kept in lockstep here.
{
  const p = path.join(ROOT, 'README.md');
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(/version_([0-9][^-\s)]*(?:--[^-\s)]*)*)-updated_/); // inside the badge URL
  const badgeVer = m ? m[1].replace(/--/g, '-') : null;
  if (badgeVer !== V) {
    if (CHECK) { console.error(`[version] DRIFT: README badge = ${badgeVer}, expected ${V}`); drift++; }
    // (the nightly publisher regenerates the README badge with a timestamp; --check just flags staleness)
  }
}

// Guard: no stray hardcoded vX.Y.Z-dev literals in code paths that should read getVersion() instead.
if (CHECK) {
  const scanFiles = ['bin/install.mjs', 'scripts/brain-stamp.mjs', 'scripts/build-bundle.mjs'];
  const re = /['"`]v?\d+\.\d+\.\d+-dev['"`]/;
  for (const f of scanFiles) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    // Line-based so a single documented last-ditch fallback can opt out with `// sync-version-ignore`.
    const bad = fs.readFileSync(p, 'utf8').split('\n')
      .filter((ln) => re.test(ln) && !ln.includes('sync-version-ignore'));
    if (bad.length) { console.error(`[version] DRIFT: ${f} has hardcoded version literal(s) — read getVersion() instead:\n    ${bad.map((l) => l.trim()).join('\n    ')}`); drift++; }
  }
}

if (CHECK) {
  if (drift) { console.error(`\n[version] ${drift} surface(s) drifted from the source of truth (${V}). Run: node scripts/sync-version.mjs`); process.exit(1); }
  console.log(`[version] all surfaces agree on ${V} ✓`);
} else {
  console.log(`[version] synced everything to ${V} (source: plugin/.claude-plugin/plugin.json)`);
}
