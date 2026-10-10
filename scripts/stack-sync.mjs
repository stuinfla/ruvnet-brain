#!/usr/bin/env node
// stack-sync.mjs — THE one rule for the RuvNet stack. One global copy. Correct. Provable.
//
// WHY THIS EXISTS (found live 2026-07-14, because Stuart noticed an update nag pointing BACKWARDS):
//
//   TWO installers were fighting on this machine:
//     com.stuartkerr.ruflo-autoupdate   nightly 03:30   npm install -g <38 pkgs>, core on @alpha
//     io.ruv.auto-subscribe             HOURLY          npm install -g <4 pkgs>  on @latest
//   The moment rUv publishes an alpha ahead of latest — the entire point of an alpha track — the
//   nightly puts you on alpha and the hourly drags you back down. Every hour. Forever.
//
//   Meanwhile ~190 hook invocations across 16 projects call `npx <pkg>@latest` on every Edit, Bash
//   and prompt. npx runs its OWN private copy from ~/.npm/_npx, which can be badly stale (rvf sat
//   at 0.1.9 in that cache while the global was 0.2.3). npx does not merely fail to catch drift —
//   it MANUFACTURES THE ILLUSION OF CURRENCY: every command works, every --version prints the new
//   number, and the binary the MCP server actually executes quietly rots.
//
// THE ROOT CAUSE, stated once: currency is an ORDERING question, not an EQUALITY one.
// Three separate files compared installed vs latest with `!=`, which fires in EITHER direction:
//     plugin/scripts/ground-ruvnet.sh              -> advised a DOWNGRADE every prompt (fixed 2.7.2)
//     ~/.claude/hooks/ruflo-upgrade-awareness.sh   -> same bug, same bad advice
//     ~/.claude/scripts/ruvnet-auto-subscribe.sh   -> same bug, but it EXECUTES npm install -g
// `!=` only ever LOOKS right because installed is normally <= latest. Nothing asserted direction.
//
// So this file has exactly ONE comparator, and it is the only place ordering is decided.
// A downgrade is not "policy-forbidden" here — it is STRUCTURALLY UNREACHABLE: the only install
// gate is isBehind(), and AHEAD is an explicitly allowed, untouched state.
//
// GROUNDING (search_ruvnet across 37 repos): rUv ships no machine-wide package updater. His docs
// present `npm install -g` and `npx` as equally valid with no ruling on which wins — which is
// exactly where the drift lives. Closest precedent: ruflo/plugins/ruflo-ruvector ADR-0001
// (ACCEPTED) — pin, verify against a smoke test, bump deliberately. This is OUR operator script
// honoring that discipline. It is not an rUv product and does not wear rUv's name.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeveloperUpdate, readDeveloperUpdateConfig } from '../plugin/scripts/developer-update.mjs';
import { FAMILY, PLUGIN_MARKETPLACES, cmpVersion, pickTargetTag, normalizeNpmDistTags } from '../plugin/scripts/developer-update-policy.mjs';
export { FAMILY, PLUGIN_MARKETPLACES, cmpVersion, pickTargetTag, normalizeNpmDistTags } from '../plugin/scripts/developer-update-policy.mjs';

const HOME = os.homedir();

// ISSUE #18 (Henrik Pettersen): PREFIX used to be hardcoded to ~/.npm-global. That path is Stuart's
// own convention, not an npm default — on any machine managing Node via mise/nvm/volta/fnm, npm's
// real global prefix lives somewhere else entirely (e.g. ~/.local/share/mise/installs/node/24.14.1),
// so the hardcoded path never existed there and this tool reported "0 packages on your global
// stack" with the full stack actually installed under the real prefix — reporting health while
// blind, the exact failure ADR-0013 (Onboarding Console) exists to kill.
// Fix: ask npm itself where its prefix is, at runtime, and resolve it ONCE at module load (not per
// call — `npm config get prefix` is a subprocess spawn, not free). Fall back to ~/.npm-global only
// if npm can't tell us anything usable.
function resolveNpmPrefix() {
  const r = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', timeout: 10000 });
  const out = r.status === 0 && r.stdout ? r.stdout.trim() : '';
  return out || path.join(HOME, '.npm-global');
}

// npm's on-disk layout for global packages differs by platform: macOS/Linux nest an extra `lib/`
// segment (<prefix>/lib/node_modules), Windows does not (<prefix>/node_modules). Rather than assume
// either, prefer whichever actually exists on disk so one code path works on both.
function resolveGlobalLib(prefix) {
  const withLib = path.join(prefix, 'lib', 'node_modules');
  const withoutLib = path.join(prefix, 'node_modules');
  if (fs.existsSync(withLib)) return withLib;
  if (fs.existsSync(withoutLib)) return withoutLib;
  return withLib; // neither exists yet (e.g. a fresh/empty prefix) — keep the more common shape
}

const PREFIX = resolveNpmPrefix();
const GLOBAL_LIB = resolveGlobalLib(PREFIX);
const NPX_CACHE = path.join(HOME, '.npm/_npx');
const RECEIPT = path.join(HOME, '.cache/ruvnet-brain/stack-sync-receipt.json');
// ISSUE #22: rUv tools installed through the Claude Code plugin MARKETPLACE (not `npm install -g`)
// live here, and were invisible to this auditor — so plugin-only users saw a permanently undercounted
// stack, and any plugin they DID have could never be reported "installed". Claude Code writes the
// authoritative install list (which plugin, which marketplace, which cached version dir is active) to
// installed_plugins.json under this dir; we read THAT rather than guessing among the dozens of stale
// version folders the cache keeps around.
const PLUGINS_DIR = path.join(HOME, '.claude', 'plugins');

// The tag policy. ONE table — the single source of truth for "what SHOULD be installed".
// The recommended default is latest. The canonical owner config can explicitly select alpha.
// Unlisted packages still get DEFAULT_TAG; installed Kit retains next/latest ordering.
export const TAG_POLICY = { ruflo: 'latest', '@claude-flow/cli': 'latest' };
export const DEFAULT_TAG = 'latest';

// Resolve a package's TARGET version to the NEWEST of its candidate tags — the policy tag AND latest —
// not blindly the policy tag. TAG_POLICY names the tag the orchestration core USUALLY leads on (@alpha,
// because rUv ships fast). But the reverse happens: on 2026-07-18 the core's @latest was 3.32.7 while
// its @alpha sat at 3.32.0, so "track @alpha" alone pinned the install 7 releases behind the newest
// published build — and the nightly reported SUCCESS doing it (installed 3.32.2 read as AHEAD of the
// 3.32.0 @alpha target, so it correctly refused to downgrade and never chased 3.32.7). Considering both
// tags and taking the higher version fixes that in EITHER direction: alpha-leads → track alpha;
// latest-leads → track latest. You are never left behind the newest thing rUv actually published.

// What counts as "the stack": an explicit allow-list pattern, not a loose scope match, so a stray
// package can never be swept into a global install by accident.


// The plugin side of the same allow-list intent (ISSUE #22). Plugin identifiers are marketplace
// names (`ruflo-core`, `ruvnet-brain`, `cog-beehive-monitor`), NOT npm package names, so FAMILY
// alone cannot classify them — `ruvnet-brain` and cognitum's plugins never match it. The reliable
// signal is the MARKETPLACE a plugin came from: these four are rUv/ruvnet marketplaces (verified in
// ~/.claude/plugins/known_marketplaces.json → ruvnet/ruflo, ruvnet/RuView, stuinfla/ruvnet-brain,
// cognitum.one). An explicit set, mirroring FAMILY's "allow-list, never a loose scope match" so a
// stray third-party plugin can never be swept into the RuvNet stack by accident. FAMILY is still
// applied as a secondary matcher, so a future rUv plugin shipped through a different marketplace is
// still counted.


const log = (m) => console.log(m);
const die = (m) => { console.error(`\n  FAILED: ${m}`); process.exit(1); };

// THE COMPARATOR. The only place ordering is decided anywhere in this system.
// Prerelease-aware per semver: a prerelease sorts BEFORE its release (3.28.0-alpha.1 < 3.28.0),
// and numeric identifiers compare numerically — alpha.9 < alpha.10, which a string compare gets
// backwards, and a string compare is precisely the bug this whole file exists to kill.

export const isBehind = (installed, target) => cmpVersion(installed, target) < 0;

export function installedVersion(pkg, lib = GLOBAL_LIB) {
  const pj = path.join(lib, pkg, 'package.json');
  if (!fs.existsSync(pj)) return null;
  try { return JSON.parse(fs.readFileSync(pj, 'utf8')).version || null; } catch { return null; }
}

// ISSUE #22 — the version of an installed Claude Code plugin is its plugin.json `version`, read from
// the exact cached version dir Claude Code marked active (installPath). Injectable exactly like
// installedVersion(pkg, lib) so it is unit-testable against a temp dir.
export function pluginVersion(installPath) {
  const pj = path.join(installPath, '.claude-plugin', 'plugin.json');
  try { return JSON.parse(fs.readFileSync(pj, 'utf8')).version || null; } catch { return null; }
}

// ISSUE #22 — scan the Claude Code plugin cache for rUv-family plugins. Source of truth is
// installed_plugins.json (Claude Code's own record of what is installed, its marketplace, and which
// cached version dir is active) — NOT a raw walk of the cache, which keeps dozens of stale version
// folders per plugin. `pluginsDir` is injectable, mirroring the lib=GLOBAL_LIB pattern, so tests can
// point it at a fixture. Returns the same {name, installed} shape as the npm scan, tagged source:'plugin'.
export function listInstalledPlugins(pluginsDir = PLUGINS_DIR) {
  const manifest = path.join(pluginsDir, 'installed_plugins.json');
  if (!fs.existsSync(manifest)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { return []; }
  const plugins = data && typeof data.plugins === 'object' ? data.plugins : {};
  const out = [];
  for (const [key, records] of Object.entries(plugins)) {
    // key = "<plugin>@<marketplace>"; the marketplace is the last @-segment.
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : '';
    if (!(PLUGIN_MARKETPLACES.has(marketplace) || FAMILY.test(name))) continue;
    // A plugin can have several install records (user + per-project scope). Pick the highest readable
    // version so a stale project-scoped copy can never mask a newer user-scoped one — same "ordering,
    // not equality" discipline as the rest of this file. Fall back to the manifest's own version field
    // if the on-disk plugin.json is unreadable, so a present plugin is NEVER reported "not installed".
    let installed = null;
    const instances = [];
    for (const rec of Array.isArray(records) ? records : []) {
      const v = (rec && rec.installPath ? pluginVersion(rec.installPath) : null)
        || (rec && rec.version && rec.version !== 'unknown' ? rec.version : null);
      instances.push({ scope: rec?.scope || 'unknown', installPath: rec?.installPath || null, version: v, readable: Boolean(rec?.installPath && pluginVersion(rec.installPath)) });
      if (!v) continue;
      if (installed === null || cmpVersion(v, installed) > 0) installed = v;
    }
    out.push({ name, installed, source: 'plugin', marketplace, instances });
  }
  return out;
}

function listInstalled({ lib = GLOBAL_LIB, pluginsDir = PLUGINS_DIR } = {}) {
  const out = [];
  const scan = (dir, scope = '') => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      if (e.startsWith('.')) continue;
      if (e.startsWith('@') && !scope) { scan(path.join(dir, e), e + '/'); continue; }
      const name = scope + e;
      if (FAMILY.test(name)) out.push({ name, installed: installedVersion(name, lib), source: 'npm-global' });
    }
  };
  scan(lib);
  // Preserve both distribution sources; one must not hide the other.
  out.push(...listInstalledPlugins(pluginsDir));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function registryTags(pkg) {
  const r = spawnSync('npm', ['view', pkg, 'dist-tags', '--json'], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 || !r.stdout) return null;
  try { return normalizeNpmDistTags(JSON.parse(r.stdout)); } catch { return null; }
}

// A second copy of a stack package in the npx cache can only ever SHADOW the global one.
// It is never useful. This is how "two ruflos" happens.
export function findShadows(npxCache = NPX_CACHE, lib = GLOBAL_LIB) {
  const shadows = [];
  if (!fs.existsSync(npxCache)) return shadows;
  for (const d of fs.readdirSync(npxCache)) {
    const nm = path.join(npxCache, d, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    const scan = (dir, scope = '') => {
      for (const e of fs.readdirSync(dir)) {
        if (e.startsWith('.')) continue;
        if (e.startsWith('@') && !scope) { scan(path.join(dir, e), e + '/'); continue; }
        const name = scope + e;
        if (!FAMILY.test(name)) continue;
        try {
          const v = JSON.parse(fs.readFileSync(path.join(dir, e, 'package.json'), 'utf8')).version;
          shadows.push({ name, version: v, dir: path.join(npxCache, d), global: installedVersion(name, lib) });
        } catch { /* unreadable copy: still a shadow, but we cannot name its version */ }
      }
    };
    try { scan(nm); } catch { /* unreadable cache dir */ }
  }
  return shadows;
}

// Classify installed packages against the registry. Ordering is STILL decided only in cmpVersion/
// isBehind — this function assigns a state label, it does not compare versions itself except through
// the single comparator. Extracted so audit() (CLI, may exit) and auditModel() (embedders, never
// exits) share ONE classification, never two that can drift.
export function classify(pkgs, { channel = readDeveloperUpdateConfig().channel } = {}) {
  return pkgs.map((p) => {
    // Installed records prove presence, not marketplace currency.
    if (p.source === 'plugin') {
      return { ...p, tag: 'plugin', target: null, state: p.installed ? 'INSTALLED_UNVERIFIED' : 'BROKEN', evidence: 'local install record only; marketplace revision not checked' };
    }
    const want = p.name === '@pacphi/agentic-kit' ? 'next' : channel === 'alpha' && FAMILY.test(p.name) ? 'alpha' : DEFAULT_TAG;
    const tags = registryTags(p.name);
    // Newest of {policy tag, latest} — see pickTargetTag: "track @alpha" alone pinned the core behind
    // @latest on 2026-07-18. A package with no alpha tag falls through to latest.
    const { tag, target } = pickTargetTag(tags, want);
    let state;
    if (!p.installed) state = 'BROKEN';
    else if (!target) state = 'UNRESOLVED';
    else if (isBehind(p.installed, target)) state = 'BEHIND';
    else if (cmpVersion(p.installed, target) > 0) state = 'AHEAD';
    else state = 'CURRENT';
    return { ...p, tag, target, state };
  });
}

function audit() {
  const pkgs = listInstalled();
  if (!pkgs.length) die(`no stack packages under ${GLOBAL_LIB} — is the npm prefix right?`);

  // A BLIND TOOL MUST NOT REPORT HEALTH. (Adversarial review, 2026-07-14 — a real bug in the first
  // version of this file.) If the registry is unreachable, EVERY package resolves UNRESOLVED, the
  // drift count is 0+0+0, and --audit used to print "all current" and exit 0 — a currency claim
  // that was never measured. That is the exact failure this whole file exists to kill, reproduced
  // inside the fix for it. Silence is not health.
  const rows = classify(pkgs);
  const unresolved = rows.filter((r) => r.state === 'UNRESOLVED');
  // Registry reachability is measured only against npm rows; plugins remain unverified.
  const npmRows = rows.filter((r) => r.source !== 'plugin');
  if (npmRows.length && unresolved.length === npmRows.length) {
    die(`could not reach the npm registry for ANY of ${npmRows.length} npm packages.\n` +
        `   This tool refuses to report on a stack it could not measure. Check the network and re-run.`);
  }

  const shadows = findShadows();
  return { rows, unresolved, shadows, stale: shadows.filter((s) => s.global && isBehind(s.version, s.global)) };
}

// Non-exiting audit for embedders (the Onboarding Console). Same measurement as audit(), but returns
// a model with an `error` field instead of calling process.exit — a long-lived server must never be
// killed by a transient registry blip. Honours the SAME "a blind tool must not report health" rule:
// if the registry was unreachable for EVERY package, that is surfaced as an error, not as "all current".
export function auditModel() {
  const pkgs = listInstalled();
  if (!pkgs.length) return { error: `no stack packages under ${GLOBAL_LIB}`, rows: [], unresolved: [], shadows: [], stale: [] };
  const rows = classify(pkgs);
  const unresolved = rows.filter((r) => r.state === 'UNRESOLVED');
  const shadows = findShadows();
  const stale = shadows.filter((s) => s.global && isBehind(s.version, s.global));
  // Same npm-scoped guard as audit() (ISSUE #22): plugin rows never count toward "registry unreachable".
  const npmRows = rows.filter((r) => r.source !== 'plugin');
  const error = npmRows.length && unresolved.length === npmRows.length
    ? `could not reach the npm registry for any of ${npmRows.length} npm packages` : null;
  return { rows, unresolved, shadows, stale, error, summary: summarizeAudit({ rows, shadows }) };
}

export function summarizeAudit({ rows, shadows }) {
  const count = (state) => rows.filter((row) => row.state === state).length;
  const summary = { behind: count('BEHIND'), broken: count('BROKEN'),
    unverified: count('INSTALLED_UNVERIFIED') + count('UNRESOLVED'), shadows: shadows.length,
    stale: shadows.filter((s) => s.global && isBehind(s.version, s.global)).length };
  summary.verdict = summary.behind || summary.broken || summary.shadows ? 'DRIFT'
    : summary.unverified || !rows.length ? 'UNKNOWN' : 'PASS';
  summary.exitCode = summary.verdict === 'PASS' ? 0 : summary.verdict === 'UNKNOWN' ? 4 : 1;
  return summary;
}

function report({ rows, shadows, stale }) {
  const w = Math.max(1, ...rows.map((r) => r.name.length));
  const nPlugin = rows.filter((r) => r.source === 'plugin').length;
  const nNpm = rows.length - nPlugin;
  log(`\n  RuvNet stack — ${rows.length} distribution records (${nNpm} npm-global, ${nPlugin} Claude Code plugin)\n`);
  for (const r of rows) {
    const mark = { CURRENT: '  ok  ', BEHIND: 'BEHIND', AHEAD: ' ahead', BROKEN: 'BROKEN', UNRESOLVED: '  ??  ', INSTALLED_UNVERIFIED: 'UNVERIFIED' }[r.state];
    const detail = r.state === 'BEHIND' ? `${r.installed} -> ${r.target}  (@${r.tag})`
      : r.state === 'AHEAD' ? `${r.installed}  (ahead of @${r.tag} ${r.target} — alpha track; left alone)`
      : r.state === 'BROKEN' ? `no readable version on disk; registry has ${r.target ?? '?'}`
      : r.source === 'plugin' ? `${r.installed}  (plugin · ${r.marketplace}; marketplace currency NOT CHECKED; ${r.instances?.length || 1} scope record(s))`
      : r.installed;
    log(`  [${mark}] ${r.name.padEnd(w)}  ${detail}`);
    if (r.instances?.length > 1) for (const instance of r.instances) log(`      ${instance.scope}: ${instance.version || 'UNREADABLE'} (${instance.readable ? 'disk' : 'record only'})`);
  }
  if (shadows.length) {
    log(`\n  npx shadow copies:`);
    for (const s of shadows) {
      log(`    ${s.name}@${s.version}${s.global && isBehind(s.version, s.global) ? `   STALE — global is ${s.global}` : ''}`);
    }
  }
  log('');
  return { behind: rows.filter((r) => r.state === 'BEHIND'), broken: rows.filter((r) => r.state === 'BROKEN'), stale };
}

async function sync({ dryRun = false } = {}) {
  const config = readDeveloperUpdateConfig();
  const receipt = await runDeveloperUpdate({ mode: dryRun ? 'check' : 'apply', config });
  log(`Coordinated update ${receipt.state}; ${receipt.steps.length} installed package owners checked.`);
  if (receipt.coverage.notes.length) log(`Excluded or preserved: ${receipt.coverage.notes.join('; ')}`);
}

// Importable as a module by the tests; only acts when run as a CLI.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('stack-sync.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--audit')) {
    const a = audit();
    report(a);
    const summary = summarizeAudit(a);
    log(`  Audit: ${JSON.stringify(summary)}`);
    if (summary.unverified) log('  Required: verify each plugin against its marketplace revision and each unresolved npm target against registry tags.');
    if (summary.shadows) log('  Cached copies are present; inspect invocation paths before removing any cache. No copies removed by audit.');
    process.exitCode = summary.exitCode;
  } else if (args.includes('--sync')) {
    sync({ dryRun: args.includes('--dry-run') }).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else {
    log(`
  stack-sync — one global copy of the RuvNet stack. Correct. Provable.

    --audit     report drift; exit 1 if anything is behind, broken, or shadowed
    --sync      update existing owners through the shared coordinator; cleanup is explicit
    --dry-run   with --sync: say what it would do, change nothing

  Tag policy: ${JSON.stringify(TAG_POLICY)}; everything else @${DEFAULT_TAG}
  Receipt:    ${RECEIPT}
`);
  }
}
