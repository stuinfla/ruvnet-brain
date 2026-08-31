#!/usr/bin/env node
// forge-currency.mjs — opt-in, read-only "currency radar" for the RuvNet Brain.
//
// Answers the one question the brain can't answer about itself: "What has rUv shipped or
// updated that I'm not current with?" — across three layers:
//   • discover         (read-only)  rUv's GitHub repos the brain does NOT index, by stars
//   • installed        (read-only)  locally-cloned ruvnet/* repos whose HEAD is behind origin
//   • update-installed  (--apply)   ff-only pull for stale local repos (dry-run without --apply)
//   • brain            (read-only)  delegates to forge-update.mjs --check (the brain bundle)
//   • (no subcommand)  (read-only)  combined currency report: discover + installed + brain
//
//   node forge-currency.mjs                  combined read-only report
//   node forge-currency.mjs discover         what's new in rUv's GitHub vs the brain
//   node forge-currency.mjs installed        which local ruvnet/* clones are stale
//   node forge-currency.mjs update-installed          dry-run plan for stale clones
//   node forge-currency.mjs update-installed --apply  ff-only pull each stale clone
//   node forge-currency.mjs brain            is the brain KB bundle current?
//
// Zero dependencies. Node 18+ (global fetch). Shells out to `gh` and `git` only when present.
// SAFETY: everything is read-only unless `--apply`; `--apply` prints a dry-run plan first;
// a dirty working tree is NEVER touched; authoritative network failures fail LOUD + non-zero
// with nothing changed. Never edits index.html or any .rvf store.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storeRoot, storesAt } from './store-root.mjs';

const KB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(KB_DIR, 'SOURCE.json');
const HOME = os.homedir();

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SUB = (argv.find((a) => !a.startsWith('--')) || 'report').toLowerCase();

function die(msg, code = 1) { console.error(`\n[forge-currency] ERROR: ${msg}`); process.exit(code); }
function have(bin) { try { execFileSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }); return true; } catch { return false; } }

// Run a command, capture stdout, never throw on non-zero (returns {ok,out,code}).
function run(bin, args, { timeout = 25000, cwd } = {}) {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8', cwd, timeout, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    });
    return { ok: true, out: out.trim(), err: '', code: 0 };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || '').toString().trim() || e.message, code: e.status ?? 1 };
  }
}
const git = (dir, args, opts) => run('git', ['-C', dir, ...args], opts);

// ---------- the brain's KNOWN set (authoritative: the .rvf files it actually loads) ----------
//
// `storesAt(storeRoot())`, not a directory listing of KB_DIR (this script's own co-located
// directory): kb/store-root.mjs exists precisely because a component that answers "where does the
// knowledge live?" from its own location rather than the one canonical root gives a different
// answer than the reader that actually serves queries — the exact bug PR #143/#155/#176 fixed in
// restore-local-ingests.mjs/brain-score.mjs/brain-stamp.mjs. KB_DIR (a gitignored build workspace
// per store-root.mjs's own header, "never a second brain") is not that root on any host where
// RUVNET_BRAIN_KB/KB_DIR/the default ~/.cache/ruvnet-brain/kb diverges from it.
export function brainKnownSet(root = storeRoot()) {
  const known = new Set();
  for (const s of storesAt(root)) known.add(s.toLowerCase());
  if (fs.existsSync(SOURCE_PATH)) {
    try {
      const src = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8'));
      const stores = Array.isArray(src.stores) ? src.stores
        : (src.stores && typeof src.stores === 'object') ? Object.values(src.stores) : [];
      for (const s of stores) {
        if (s && s.sourceRepo) known.add(path.basename(String(s.sourceRepo)).replace(/\.git$/, '').toLowerCase());
        if (s && s.kbName) known.add(String(s.kbName).toLowerCase());
      }
    } catch { /* SOURCE.json optional — filenames are the authoritative truth */ }
  }
  return known;
}

// ---------- list github.com/ruvnet repos (gh preferred, REST fallback) ----------
async function listRuvnetRepos() {
  if (have('gh')) {
    const r = run('gh', ['repo', 'list', 'ruvnet', '--limit', '300', '--json',
      'name,description,stargazerCount,pushedAt,primaryLanguage,isArchived'], { timeout: 60000 });
    if (r.ok && r.out) {
      try {
        return JSON.parse(r.out).map((x) => ({
          name: x.name, description: x.description || '', stars: x.stargazerCount || 0,
          pushedAt: x.pushedAt || '', lang: (x.primaryLanguage && x.primaryLanguage.name) || '', archived: !!x.isArchived,
        }));
      } catch (e) { die(`gh returned unparseable JSON: ${e.message}`, 2); }
    }
    console.error(`[forge-currency] gh failed (${r.err || r.code}); falling back to GitHub REST...`);
  }
  // REST fallback — paginate /users/ruvnet/repos. GitHub requires a User-Agent.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = { 'User-Agent': 'forge-currency', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.github.com/users/ruvnet/repos?per_page=100&type=owner&sort=pushed&page=${page}`;
    let res;
    try { res = await fetch(url, { headers, redirect: 'follow' }); }
    catch (e) { die(`network failure fetching ruvnet repo list\n  ${e.message} — nothing changed.`, 2); }
    if (!res.ok) die(`GitHub REST returned HTTP ${res.status} for ${url} — nothing changed.`, 2);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const x of batch) all.push({
      name: x.name, description: x.description || '', stars: x.stargazers_count || 0,
      pushedAt: x.pushed_at || '', lang: x.language || '', archived: !!x.archived,
    });
    if (batch.length < 100) break;
  }
  if (all.length === 0) die('GitHub REST returned no repos for ruvnet — nothing changed.', 2);
  return all;
}

// ---------- scan local roots for cloned ruvnet/* repos ----------
const SCAN_ROOTS = [
  path.join(HOME, '.cache', 'ruvnet-brain'),
  path.join(HOME, 'RuVector_Clean'),
  ...((() => { const c = path.join(HOME, 'Code'); try { return fs.readdirSync(c).map((d) => path.join(c, d)); } catch { return []; } })()),
  path.join(HOME, '.npm-global', 'lib', 'node_modules'),
  path.join(HOME, '.claude', 'plugins'),
];
const PRUNE = new Set(['node_modules', '.cache', '.git', 'target', 'dist', 'build', '.next']);

function findGitRepos(root, maxDepth = 4) {
  const found = [];
  function walk(dir, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isDirectory() && e.name === '.git')) { found.push(dir); return; } // prune at repo root
    if (depth >= maxDepth) return;
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || PRUNE.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  if (fs.existsSync(root)) walk(root, 0);
  return found;
}
function isRuvnetOrigin(url) { return /github\.com[:/]ruvnet\//i.test(url || ''); }

// Returns [{dir, name, origin, dirty, local, remote, stale|null}], stale=null => unknown (network).
function scanInstalled() {
  const seen = new Set(); const repos = [];
  for (const root of SCAN_ROOTS) {
    for (const dir of findGitRepos(root)) {
      if (seen.has(dir)) continue; seen.add(dir);
      const origin = git(dir, ['config', '--get', 'remote.origin.url']).out;
      if (!isRuvnetOrigin(origin)) continue;
      const local = git(dir, ['rev-parse', 'HEAD']).out;
      const dirty = git(dir, ['status', '--porcelain']).out.length > 0;
      const ls = git(dir, ['ls-remote', 'origin', 'HEAD'], { timeout: 30000 });
      const remote = ls.ok ? (ls.out.split(/\s+/)[0] || '') : '';
      const stale = ls.ok ? (local && remote && local !== remote) : null;
      repos.push({ dir, name: path.basename(dir), origin, dirty, local, remote, stale });
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- presentation ----------
const sh = (s) => (s ? String(s).slice(0, 9) : '(none)');
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

async function discover() {
  console.log(`\n=== discover — what rUv has shipped that the brain does NOT index ===`);
  const known = brainKnownSet();
  const repos = await listRuvnetRepos();
  const missing = repos.filter((r) => !r.archived && !known.has(r.name.toLowerCase()))
    .sort((a, b) => b.stars - a.stars);
  console.log(`brain indexes ${known.size} names; ruvnet has ${repos.length} repos; ` +
    `${missing.length} not indexed (archived excluded).\n`);
  if (missing.length === 0) { console.log('The brain indexes every active ruvnet repo. Nothing new.'); return missing; }
  console.log(`${pad('STARS', 7)}${pad('REPO', 30)}${pad('LANG', 14)}DESCRIPTION`);
  console.log('-'.repeat(90));
  for (const r of missing) {
    const desc = (r.description || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`${pad('★' + r.stars, 7)}${pad(r.name, 30)}${pad(r.lang || '-', 14)}${desc}`);
  }
  console.log(`\nThese are candidates to forge into the brain. (Building a new store is a separate, deliberate step.)`);
  return missing;
}

function printInstalled(repos) {
  console.log(`\n=== installed — locally-cloned ruvnet/* repos vs their origin ===`);
  if (repos.length === 0) {
    console.log(`No ruvnet/* git clones found under:\n  ${SCAN_ROOTS.join('\n  ')}`);
    return repos;
  }
  console.log(`${pad('STATUS', 12)}${pad('REPO', 26)}${pad('LOCAL', 11)}${pad('REMOTE', 11)}PATH`);
  console.log('-'.repeat(96));
  for (const r of repos) {
    const status = r.stale === null ? 'UNKNOWN(net)' : r.stale ? (r.dirty ? 'STALE+DIRTY' : 'STALE') : 'CURRENT';
    console.log(`${pad(status, 12)}${pad(r.name, 26)}${pad(sh(r.local), 11)}${pad(sh(r.remote), 11)}${r.dir.replace(HOME, '~')}`);
  }
  const stale = repos.filter((r) => r.stale);
  if (stale.length) console.log(`\n${stale.length} stale. To update (dry-run first): node forge-currency.mjs update-installed   then add --apply`);
  else console.log(`\nAll resolved clones current.`);
  return repos;
}

async function updateInstalled() {
  const repos = scanInstalled();
  printInstalled(repos);
  const stale = repos.filter((r) => r.stale);
  if (stale.length === 0) { console.log(`\nNothing to update.`); return; }
  console.log(`\n=== update-installed ${APPLY ? '(APPLY)' : '(DRY-RUN — re-run with --apply to execute)'} ===`);
  for (const r of stale) {
    if (r.dirty) { console.log(`  SKIP  ${r.name} — working tree is DIRTY; refusing to pull (commit/stash first).`); continue; }
    console.log(`  PLAN  ${r.name}: git -C ${r.dir.replace(HOME, '~')} pull --ff-only  (${sh(r.local)} -> ${sh(r.remote)})`);
    if (!APPLY) continue;
    const res = git(r.dir, ['pull', '--ff-only'], { timeout: 120000 });
    if (res.ok) console.log(`  DONE  ${r.name} updated.`);
    else console.log(`  FAIL  ${r.name}: ff-only pull failed (diverged or network) — left untouched. ${res.err || ''}`);
  }
  if (!APPLY) console.log(`\nNo changes made (dry-run). Re-run with --apply to pull the listed repos.`);
}

function brainCheck() {
  console.log(`\n=== brain — is the brain KB bundle current? (via forge-update.mjs) ===`);
  const updater = path.join(KB_DIR, 'forge-update.mjs');
  if (!fs.existsSync(updater)) { console.log(`forge-update.mjs not found next to this script — cannot check the brain layer.`); return; }
  const res = run(process.execPath, [updater, '--check'], { cwd: KB_DIR, timeout: 60000 });
  if (res.out) console.log(res.out);
  if (res.err && res.code !== 0 && res.code !== 10) console.log(res.err);
  // forge-update exits 0 = current, 10 = behind, other = error/not-configured.
  if (res.code === 10) console.log(`\nThe brain bundle is BEHIND. To update:  node forge-update.mjs --apply`);
  else if (res.code === 0) console.log(`\nThe brain bundle is current.`);
  else console.log(`\n(forge-update reported: exit ${res.code} — likely "self-update not configured" for this build; see message above.)`);
}

async function main() {
  switch (SUB) {
    case 'discover': await discover(); break;
    case 'installed': printInstalled(scanInstalled()); break;
    case 'update-installed': case 'update': await updateInstalled(); break;
    case 'brain': brainCheck(); break;
    case 'report': case 'all': default: {
      console.log(`RuvNet Brain — currency report  (${new Date().toISOString()})\nRead-only. Nothing is changed.`);
      await discover();
      printInstalled(scanInstalled());
      brainCheck();
      console.log(`\n=== end of report ===`);
    }
  }
}

// CLI — guarded so importing this module (e.g. from a unit test) never fires a real
// gh/git/fetch call as an import side effect. Same pattern as scripts/verify-bundle.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => die(`unexpected: ${e.message}`));
}
