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
import { getVersionTag } from './version.mjs';
import { verifyRvfGenerations } from './rvf-generation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const V = getVersion();
const TODAY = new Date().toISOString().slice(0, 10);
let drift = 0;

export function readLockVersion(s) {
  const doc = JSON.parse(s);
  const top = doc.version ?? null;
  const root = doc.packages?.['']?.version ?? null;
  return top === root ? top : `mixed(${top}, ${root})`;
}

export function writeLockVersion(s, version) {
  const doc = JSON.parse(s);
  doc.version = version;
  if (doc.packages?.['']) doc.packages[''].version = version;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// Each target: a file, a regex to find the version-bearing line, and the corrected line.
const targets = [
  { // Codex plugin manifest — same product, same release train as the Claude manifest
    file: 'plugin/.codex-plugin/plugin.json',
    get: (s) => (JSON.parse(s).version),
    set: (s) => s.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${V}"`),
  },
  { // npm installer package — inherits the product version (publish in lockstep)
    file: 'package.json',
    get: (s) => (JSON.parse(s).version),
    set: (s) => s.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${V}"`),
  },
  { // npm lock metadata is part of the packed candidate lineage too
    file: 'package-lock.json',
    get: readLockVersion,
    set: (s) => writeLockVersion(s, V),
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
  { // the human primer's header stamp — shipped in the bundle, read by real users
    // (drifted to v2.0.0 during the 2.0.1 release because no target covered it — 2026-07-10 gremlin hunt)
    file: 'primer/ruvnet-primer.md',
    get: (s) => { const m = s.match(/Brain version: v([^\s·`]+)/); return m ? m[1] : null; },
    set: (s) => s.replace(/(Brain version: v)[^\s·`]+/, `$1${V}`),
  },
  { // the live explainer page carries the version twice (JSON-LD softwareVersion + the status badge).
    // get() returns the value only when BOTH agree; a mismatch reports as drift too.
    file: 'explainer/index.html',
    get: (s) => {
      const ld = s.match(/"softwareVersion"\s*:\s*"([^"]+)"/)?.[1] ?? null;
      const badge = s.match(/&middot;\s*v([0-9][^\s<]*)</)?.[1] ?? null;
      return ld === badge ? ld : `mixed(${ld}, ${badge})`;
    },
    set: (s) => s
      .replace(/("softwareVersion"\s*:\s*)"[^"]+"/, `$1"${V}"`)
      .replace(/(&middot;\s*v)[0-9][^\s<]*</, `$1${V}<`),
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

// The installed knowledge bundle and the checksum-bound RVF generation ledger are release
// surfaces too. They are generated artifacts, so tolerate absence in a source-only checkout; when
// present they must carry the same bare field and v-prefixed tag as npm/GitHub.
for (const rel of ['kb/RVF-GENERATIONS.json']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const expectedTag = getVersionTag();
  const bad = doc.brainVersion !== V || doc.releaseTag !== expectedTag;
  if (!bad) continue;
  if (CHECK) {
    console.error(`[version] DRIFT: ${rel} = ${doc.brainVersion}/${doc.releaseTag}, expected ${V}/${expectedTag}`);
    drift++;
  } else {
    doc.brainVersion = V;
    doc.releaseTag = expectedTag;
    fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`[version] ${rel}: -> ${V}/${expectedTag}`);
  }
}

if (CHECK && fs.existsSync(path.join(ROOT, 'kb/RVF-GENERATIONS.json'))) {
  const kbDir = path.join(ROOT, 'kb');
  // Validate the committed ledger's version fields ONLY. The previous form scanned the working
  // directory for `*.big.rvf` and byte-compared every ledger row against whatever this machine
  // happened to have — but those binaries are gitignored, so the verdict described the machine, not
  // the commit. It was unsatisfiable in practice (ledger: 72 stores; a real checkout: 71, because
  // the nightly rebuilds RVFs and regenerates the ledger as one step) and it blocked every push,
  // tags included, while pointing at a remedy that cannot clear it. Byte verification now happens
  // where the bytes are genuinely present and genuinely shipped: scripts/build-bundle.mjs:204-214.
  // This is the same rule release.mjs:100 already applies — a verdict is only about the committed
  // candidate.
  const { failures } = verifyRvfGenerations(kbDir, { verifyBytes: false });
  for (const failure of failures) {
    console.error(`[version] RVF GENERATION DRIFT: ${failure}`);
    drift++;
  }
}

// README: the heading badge encodes the product version twice — the human-readable alt text
// ("RuvNet Brain version X — updated Y") and the shields.io URL token ("version_X-updated_Y", with
// hyphens escaped as `--`). --check flags version drift; write-mode now FIXES it in place (version
// only — the nightly publisher owns the `updated_` timestamp), so `--check` and a plain write agree.
{
  const p = path.join(ROOT, 'README.md');
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(/version_([0-9][^-\s)]*(?:--[^-\s)]*)*)-updated_/); // inside the badge URL
  const badgeVer = m ? m[1].replace(/--/g, '-') : null;
  if (badgeVer !== V) {
    if (CHECK) { console.error(`[version] DRIFT: README badge = ${badgeVer}, expected ${V}`); drift++; }
    else {
      const vBadge = V.replace(/-/g, '--'); // shields.io escapes a literal hyphen as `--`
      const next = s
        // URL token:  version_<ver>-updated_<timestamp>  → swap <ver>, keep the timestamp
        .replace(/(version_)[0-9][^-\s)]*(?:--[^-\s)]*)*(-updated_)/, `$1${vBadge}$2`)
        // alt text:  "RuvNet Brain version <ver> — updated <timestamp>" → swap <ver>, keep the timestamp
        .replace(/(RuvNet Brain version )\S+( — updated )/, `$1${V}$2`);
      if (next !== s) { fs.writeFileSync(p, next); console.log(`[version] README badge: ${badgeVer} -> ${V}`); }
    }
  }
}

// Guard: no stray hardcoded product-version literal anywhere in the source tree — every code path must
// read getVersion() (or inherit a synced literal via the `targets` above / the README badge). Rather than
// a fixed 3-file allowlist (which silently missed strays in every other file), walk the WHOLE tree and
// scan source files, skipping the regenerable / external / VCS dirs. A quoted vX.Y.Z / X.Y.Z(-dev)? literal
// is flagged when it IS the current product version (bare or `v`-tagged) OR is a `-dev` prerelease literal —
// i.e. anything that is meant to be the product version, not just the `-dev` form the old guard caught.
// A line can opt out with `sync-version-ignore` (one documented last-ditch fallback); the version toolchain
// itself is exempt because it legitimately embeds version strings in doc examples + unit-test fixtures.
if (CHECK) {
  // `worktrees` (2026-07-27): parallel agents run in git worktrees under .claude/worktrees/, which
  // is GITIGNORED (.gitignore:110) but still on disk — and this walker reads the FILESYSTEM, not
  // git's index. So every agent worktree's copy of the repo got scanned for version literals and
  // the pre-push gate refused a legitimate push over version strings inside transient checkouts
  // that ship to nobody. A shipping-surface scan must not see a scratch copy of itself.
  const SKIP_DIRS = new Set(['node_modules', 'clones', 'dist', '.git', 'worktrees']);
  const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.sh']);
  const EXEMPT = new Set([ // the version machinery defines/tests these literals — linting them = false positive
    'scripts/version.mjs', 'scripts/version.test.mjs', 'scripts/sync-version.mjs', 'scripts/self-update.mjs',
    // The unit tests moved from scripts/ to tests/unit/ but this list did not follow them, so `--check`
    // has been failing on its OWN test fixtures — a gate nobody could pass, which is a gate nobody heeds.
    'tests/unit/version.test.mjs', 'tests/unit/sync-version-drift.test.mjs', 'tests/unit/self-update-plan.test.mjs',
    // Asserts stripTag('v1.14.1-dev') === '1.14.1-dev' — the literals ARE the fixture.
    'tests/unit/version-tag-vs-field.test.mjs',
  ]);
  const litRe = /['"`](v?\d+\.\d+\.\d+(?:-dev)?)['"`]/g;

  const walk = (dir) => {
    const files = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) files.push(...walk(abs)); }
      else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name))) files.push(abs);
    }
    return files;
  };

  const strays = [];
  for (const abs of walk(ROOT)) {
    // EXEMPT keys are forward-slash; path.relative() yields backslashes on Windows, which made the
    // guard flag its own exempt fixtures there — the same gate-nobody-can-pass failure as above.
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (EXEMPT.has(rel)) continue;
    fs.readFileSync(abs, 'utf8').split('\n').forEach((ln, i) => {
      if (ln.includes('sync-version-ignore')) return;
      for (const mm of ln.matchAll(litRe)) {
        const lit = mm[1].replace(/^v/, '');
        if (lit === V || lit.endsWith('-dev')) strays.push(`${rel}:${i + 1}: ${ln.trim()}`);
      }
    });
  }
  if (strays.length) {
    console.error(`[version] DRIFT: ${strays.length} stray hardcoded version literal(s) — read getVersion() instead:`);
    for (const s of strays) console.error(`    ${s}`);
    drift++;
  }
}

if (CHECK) {
  if (drift) { console.error(`\n[version] ${drift} surface(s) drifted from the source of truth (${V}). Run: node scripts/sync-version.mjs`); process.exit(1); }
  console.log(`[version] all surfaces agree on ${V} ✓`);
} else {
  console.log(`[version] synced everything to ${V} (source: plugin/.claude-plugin/plugin.json)`);
}
