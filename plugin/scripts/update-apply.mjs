#!/usr/bin/env node
// update-apply.mjs — THE single writer of the Stable Spine (ADR-023, docs/INTELLIGENT-UPDATING.md,
// DDD-0003 INV-2). Every path that changes what code runs — seed/migration, unattended session
// update, manual apply, rollback, dev mode, GC — goes through here, under one lock, with a
// persisted transaction record. Consumers (hook-shim.mjs, mcp/server.mjs) only ever READ.
//
//   node scripts/update-apply.mjs --seed              # migrate: seed the spine from the running plugin install
//   node scripts/update-apply.mjs --auto              # unattended: newest CC-staged plugin version → gate → flip
//   node scripts/update-apply.mjs --from-dir <path>   # apply a specific plugin payload dir
//   node scripts/update-apply.mjs --rollback          # flip back to `previous` (instant)
//   node scripts/update-apply.mjs --dev [pluginDir]   # dev mode: point codeRoot at a git checkout's plugin/
//   node scripts/update-apply.mjs --dev-off
//   node scripts/update-apply.mjs --gc                # collect unreferenced generations (leases respected)
//   node scripts/update-apply.mjs --doctor            # report spine state, honestly
//
// Layout under ~/.cache/ruvnet-brain/ (all writes atomic temp+rename; NO symlinks — works
// unprivileged on macOS/Linux/Windows, red-team finding 6):
//   active.json          { generation, version, codeRoot, previous:{...}, flippedAt }
//   versions/<v>/        immutable plugin-payload copies (scripts/, hooks/, mcp/, …)
//   .update.lock/        mkdir-atomic lock dir (owner.json inside; stale-pid reclaimed) [finding 5]
//   update-txn.json      transaction record; crash recovery is deterministic            [finding 21]
//   update-receipts.jsonl  append-only ledger of every check/gate/flip/rollback
//   leases/<gen>.json    consumers lease the generation they serve; GC never collects a fresh lease [finding 23]
//   dev.json             opt-in dev-mode marker; --auto NEVER flips away from dev        [finding 24]
//
// TRUST BOUNDARY for unattended applies (findings 10/11, honest v1 scope): --auto applies ONLY
// version dirs that Claude Code's own marketplace update already staged locally (integrity: GitHub
// over TLS + CC's git clone of the marketplace). Applying a downloaded BUNDLE unattended requires
// the Ed25519-signed path (bin/install.mjs owns the key) and is wired there, not here. --from-dir
// is interactive-only by definition (a human typed the path).
//
// This engine NEVER touches kb/ (DDD-0003 INV-6): KB data has its own lifecycle and fence.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The one resolver (issue #38). `fs.existsSync('/bin/bash')` here meant win32 SKIPPED the syntax
// check on every .sh it was about to install — the platform most likely to receive a broken hook
// was the one platform that never checked. Git-for-Windows bash can run `bash -n` perfectly well.
import { resolveBash } from './hook-shim-bash.mjs';
import { SHELL_PATHS, shellDiff } from './host-shell-boundary.mjs';
export { SHELL_PATHS, shellDiff } from './host-shell-boundary.mjs';

const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const ACTIVE = path.join(BRAIN_HOME, 'active.json');
const VERSIONS = path.join(BRAIN_HOME, 'versions');
const LOCK = path.join(BRAIN_HOME, '.update.lock');
const TXN = path.join(BRAIN_HOME, 'update-txn.json');
const RECEIPTS = path.join(BRAIN_HOME, 'update-receipts.jsonl');
const LEASES = path.join(BRAIN_HOME, 'leases');
const DEV = path.join(BRAIN_HOME, 'dev.json');
const SEEDED = path.join(BRAIN_HOME, '.spine-seeded');
// Claude Code honours CLAUDE_CONFIG_DIR for its whole config tree, plugins included; Codex honours CODEX_HOME.
const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CODEX_CONFIG = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PLUGIN_CACHES = [
  path.join(CLAUDE_CONFIG, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'),
  path.join(CODEX_CONFIG, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'),
];
// Evidence that a host has been pointed at the Brain's plugin at all (marketplace registered or plugin
// cache created) — even when `plugin install` then failed and staged nothing.
const HOST_PLUGIN_EVIDENCE = [CLAUDE_CONFIG, CODEX_CONFIG].flatMap((root) => [
  path.join(root, 'plugins', 'marketplaces', 'ruvnet-brain'),
  path.join(root, 'plugins', 'cache', 'ruvnet-brain'),
]);
const LEASE_FRESH_MS = 6 * 3600_000; // a lease older than 6h is stale (its process is long gone)

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

// ── atomic primitives ────────────────────────────────────────────────────────────────────────────
function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file); // atomic on macOS/Linux/Windows
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function receipt(event, data) {
  try { fs.appendFileSync(RECEIPTS, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n'); } catch { /* ledger must not break the engine */ }
}

// ── the lock (finding 5): atomic mkdir; the owner is judged by PROCESS IDENTITY, not pid alone ────
// 4.7.21 (audit C-opus, reproduced): a pid-only check let any unrelated process that reused the pid hold
// the spine forever, and an empty owner.json (the window between mkdir and the owner write) was deleted out
// from under a live writer. The owner now records its process start time; a live pid whose start differs is
// a reused pid. A lock held by a genuinely live owner is BUSY (exit 75), never success: host convergence
// must not read "nothing applied" as "applied".
export const BUSY_EXIT = 75; // EX_TEMPFAIL
const OWNER_PUBLISH_GRACE_MS = 60_000;
function processStartOf(pid) {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8' })
      : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
    return r.status === 0 ? String(r.stdout || '').trim() || null : null;
  } catch { return null; }
}
const startMs = (text) => Date.parse(/T.*Z$/.test(text) ? text : `${text} UTC`);
function lockOwnerState(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return 'incomplete';
  try { process.kill(owner.pid, 0); } catch (error) { if (error?.code !== 'EPERM') return 'stale'; }
  const observed = processStartOf(owner.pid);
  if (!observed) return 'live'; // alive and unprovable: never steal it
  if (owner.processStart) return observed === owner.processStart ? 'live' : 'stale';
  // A pre-4.7.21 owner has only startedAt. Its process existed when it wrote that, so a process that
  // started later (lstart has 1 s resolution) is a different process holding a reused pid.
  const written = Date.parse(owner.startedAt || '');
  return Number.isFinite(written) && startMs(observed) > written + 2000 ? 'stale' : 'live';
}
function lockAgeMs() {
  let newest = 0;
  for (const p of [LOCK, path.join(LOCK, 'owner.json')]) { try { newest = Math.max(newest, fs.lstatSync(p).mtimeMs); } catch { /* absent */ } }
  return Date.now() - newest;
}
// 4.7.21 review (Codex #1, the quarantine path): judging an owner and then moving LOCK aside are two steps, so a
// contender could move a lock that had changed since it was judged. Moving it back on a mismatch left a window in which
// a third run's fresh lock blocked the restore; and an owner-less lock (raw null) was indistinguishable from another
// run's directory between its mkdir and its owner write, so the restore never ran and both runs applied. A takeover now
// holds an exclusive claim file inside the judged directory and re-checks it (dev/ino + owner bytes) before moving it;
// a run releases only the lock that carries its own token.
// Round 4 (Codex #1): mkdir-then-publish left an owner-less moment; a run paused there past the grace was judged debris,
// claimed, re-checked (still owner-less: "the same") and moved aside with the owner it published meanwhile: two runs
// applied. LOCK is now built complete in a staging sibling and published by ONE rename, so it never exists without its
// owner; a rename onto an existing lock fails (ENOTEMPTY/EEXIST, EPERM/EACCES on Windows) and that lock is judged.
const CLAIM_STALE_MS = 5 * 60_000;
const CLAIM_FILE = /^takeover(?:-(\d+))?\.json$/;
function observeLock() {
  const stat = fs.lstatSync(LOCK, { bigint: true });
  if (!stat.isDirectory()) throw Object.assign(new Error('the update lock is not a directory'), { code: 'ENOTDIR' });
  let raw = null;
  try { raw = fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return { identity: `${stat.dev}:${stat.ino}`, raw };
}
const readRaw = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// A claim file must not restart the publication grace (Opus r2 #6): writing or removing one bumps LOCK's mtime, which
// lockAgeMs reads, so LOCK's own times are put back.
function keepLockTimes(change) {
  let before = null;
  try { before = fs.lstatSync(LOCK); } catch { /* judged below */ }
  try { return change(); } finally { if (before) try { fs.lutimesSync(LOCK, before.atime, before.mtime); } catch { /* gone */ } }
}
const GONE = Symbol('judged lock vanished');
function claimTakeover() {
  let highest = -1; let highestName = null; let names;
  // The judged lock vanished (another run moved it): re-judge rather than throw out of main (Fable r2 P3-1).
  try { names = fs.readdirSync(LOCK); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return GONE; throw error; }
  for (const name of names) {
    const match = CLAIM_FILE.exec(name);
    const level = match ? (match[1] ? Number(match[1]) : 0) : -1;
    if (level > highest) { highest = level; highestName = name; }
  }
  if (highestName) {
    let ageMs = 0;
    try { ageMs = Date.now() - fs.lstatSync(path.join(LOCK, highestName)).mtimeMs; } catch { return null; }
    if (!(ageMs > CLAIM_STALE_MS)) return null; // another run is mid-takeover
  }
  const level = highest + 1;
  const file = path.join(LOCK, level ? `takeover-${level}.json` : 'takeover.json');
  const token = crypto.randomBytes(16).toString('hex');
  try { keepLockTimes(() => fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, claimedAt: new Date().toISOString() }), { flag: 'wx' })); }
  catch (error) { if (error?.code === 'EEXIST') return null; if (error?.code === 'ENOENT') return GONE; throw error; }
  return { file, token };
}
const dropClaim = (claim) => { try { if (readRaw(claim.file)?.includes(claim.token)) keepLockTimes(() => fs.unlinkSync(claim.file)); } catch { /* gone with its directory */ } };
function removeObservedLock(observed) {
  const claim = claimTakeover();
  if (claim === GONE) return 'changed';
  if (!claim) return 'busy';
  let same = false;
  try {
    const now = observeLock();
    same = now.identity === observed.identity && now.raw === observed.raw && Boolean(readRaw(claim.file)?.includes(claim.token));
  } catch { same = false; }
  if (!same) { dropClaim(claim); return 'changed'; }
  const quarantine = `${LOCK}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(LOCK, quarantine); } catch (error) { if (error?.code === 'ENOENT') return 'changed'; dropClaim(claim); throw error; }
  if (!readRaw(path.join(quarantine, path.basename(claim.file)))?.includes(claim.token)) {
    try { if (!fs.existsSync(LOCK)) fs.renameSync(quarantine, LOCK); } catch { /* keep as evidence */ }
    return 'changed';
  }
  try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { /* best effort */ }
  return 'removed';
}
/** LOCK appears with its owner already inside, by one rename that fails when a populated lock is there. */
const CONTENDED = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);
function publishLock(content) {
  const staged = `${LOCK}.acquire-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const dropStaged = () => { try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, 'owner.json'), content, { flag: 'wx' });
  } catch (error) { dropStaged(); throw error; } // staging failures are real errors, never contention
  try { fs.renameSync(staged, LOCK); } catch (error) {
    dropStaged();
    // A refused publication is contention even if LOCK is gone a moment later: its holder can release in between, and
    // re-checking existsSync here rethrew a raw ENOTEMPTY (exit 1, not BUSY_EXIT) (Opus r3 P2-1). The caller re-observes
    // and tries again when the lock has vanished, as kb/refresh-run.mjs does.
    if (CONTENDED.has(error?.code)) throw Object.assign(new Error('the update lock is held'), { code: 'EEXIST' });
    throw error;
  }
}
export function acquireLock(target) {
  fs.mkdirSync(BRAIN_HOME, { recursive: true });
  const processStart = processStartOf(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = crypto.randomBytes(16).toString('hex');
    try {
      publishLock(JSON.stringify({ pid: process.pid, host: os.hostname(), target, token,
        processStart, startedAt: new Date().toISOString() }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let observed;
      try { observed = observeLock(); } catch (observeError) { if (observeError?.code === 'ENOENT') continue; throw observeError; }
      let owner = null;
      try { owner = observed.raw === null ? null : JSON.parse(observed.raw); } catch { /* incomplete */ }
      const state = lockOwnerState(owner);
      if (state === 'live') return { acquired: false, owner };
      if (state === 'incomplete' && lockAgeMs() < OWNER_PUBLISH_GRACE_MS) return { acquired: false, owner: null };
      const outcome = removeObservedLock(observed);
      if (outcome === 'busy') return { acquired: false, owner: null };
      if (outcome === 'removed') {
        receipt('StaleLockReclaimed', { owner: owner ? { pid: owner.pid, host: owner.host, startedAt: owner.startedAt } : null, state });
      }
      continue; // 'changed': judge the directory that is there now
    }
    return { acquired: true, token };
  }
  return { acquired: false, owner: null };
}
/** Releases LOCK only while it still carries this run's token: never another run's lock. */
export function releaseLock(lock) {
  if (!lock?.acquired || !lock.token) return false;
  if (!readRaw(path.join(LOCK, 'owner.json'))?.includes(`"token":"${lock.token}"`)) return false;
  const released = `${LOCK}.released-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(LOCK, released); } catch { return false; }
  const moved = readRaw(path.join(released, 'owner.json'));
  if (!moved?.includes(`"token":"${lock.token}"`)) {
    try { if (!fs.existsSync(LOCK)) fs.renameSync(released, LOCK); } catch { /* keep as evidence */ }
    return false;
  }
  try { fs.rmSync(released, { recursive: true, force: true }); } catch { /* gone */ }
  return true;
}

// ── crash recovery (finding 21): resolve any incomplete transaction BEFORE new work ─────────────
function recoverTxn() {
  const txn = readJSON(TXN);
  if (!txn || txn.state === 'active' || txn.state === 'rolled-back') return;
  // candidate-ready but never flipped: the candidate dir is valid & gated — leave it (a future run
  // may flip it); staging remnants are junk. Either way the active pointer was never touched, so
  // the world is the OLD world. Clean staging, close the txn honestly.
  for (const d of fs.existsSync(VERSIONS) ? fs.readdirSync(VERSIONS) : []) {
    if (d.includes('.staging-')) { try { fs.rmSync(path.join(VERSIONS, d), { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  writeAtomic(TXN, JSON.stringify({ ...txn, state: 'recovered-old-world', recoveredAt: new Date().toISOString() }));
  receipt('TxnRecovered', { from: txn.state, target: txn.to });
}

// ── gates (finding 20): interpreter-true syntax + structural checks on the CANDIDATE ────────────
function gateCandidate(dir) {
  const problems = [];
  const scripts = path.join(dir, 'scripts');
  if (!fs.existsSync(scripts)) problems.push('no scripts/ dir — not a plugin payload');
  const hooksJson = path.join(dir, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksJson)) {
    try { JSON.parse(fs.readFileSync(hooksJson, 'utf8')); } catch (e) { problems.push(`hooks.json unparseable: ${e.message}`); }
  }
  // Interpreter-true, platform-honest: bash-check .sh only where /bin/bash exists (the hooks are
  // "_platform":"posix"-declared — on Windows they never execute, so a bash syntax check there
  // would be checking with an interpreter the machine doesn't have). node --check gates everywhere.
  const bashPath = resolveBash();
  const haveBash = Boolean(bashPath);
  for (const f of fs.existsSync(scripts) ? fs.readdirSync(scripts) : []) {
    const p = path.join(scripts, f);
    if (f.endsWith('.sh')) {
      if (!haveBash) continue;
      const r = spawnSync(bashPath, ['-n', p], { encoding: 'utf8' });
      if (r.status !== 0) problems.push(`bash -n ${f}: ${(r.stderr || '').trim()}`);
    } else if (f.endsWith('.mjs') || f.endsWith('.js')) {
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) problems.push(`node --check ${f}: ${(r.stderr || '').trim()}`);
    }
  }
  return problems;
}

// ── copy a payload into an immutable version dir (staged; never into a live dir) ────────────────
function safeVersion(version) {
  if (typeof version !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)
    || version.includes('..')) {
    throw new Error(`unsafe payload version: ${JSON.stringify(version)}`);
  }
  return version;
}
function versionPath(version, suffix = '') {
  const root = path.resolve(VERSIONS);
  const target = path.resolve(root, `${safeVersion(version)}${suffix}`);
  if (path.dirname(target) !== root) throw new Error(`payload version escapes versions/: ${JSON.stringify(version)}`);
  return target;
}
function ensureVersionsRoot() {
  fs.mkdirSync(VERSIONS, { recursive: true });
  if (fs.lstatSync(VERSIONS).isSymbolicLink()) {
    throw new Error('versions/ must be a real directory, not a symbolic link');
  }
}
function assertNoSymlinks(root) {
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('payload root is a symbolic link');
  }
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(`payload contains a symbolic link: ${path.relative(root, candidate)}`);
      }
      if (stat.isDirectory()) pending.push(candidate);
    }
  }
}
function payloadDigest(root) {
  const hash = crypto.createHash('sha256');
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\0${rel}\0`);
      if (entry.isDirectory()) visit(full, rel);
      else hash.update(fs.readFileSync(full));
    }
  };
  visit(root);
  return hash.digest('hex');
}
function stagePayload(srcDir, version) {
  ensureVersionsRoot();
  assertNoSymlinks(srcDir);
  const staging = versionPath(version, `.staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(srcDir, staging, { recursive: true, dereference: false });
    // Scan the copy too: a source entry swapped after the pre-copy lstat must never survive the
    // time-of-check/time-of-use window into an activated generation.
    assertNoSymlinks(staging);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return staging;
}
function promote(staging, version) {
  const finalDir = versionPath(version);
  fs.rmSync(finalDir, { recursive: true, force: true }); // re-promote of same version is legal (idempotent)
  fs.renameSync(staging, finalDir);
  return finalDir;
}

// ── the flip: rewrite active.json (THE update) ──────────────────────────────────────────────────
// The SHELL set — files Claude Code binds at boot. If none of these changed between generations,
// the update is fully live with no restart and session-start stays silent; if any did, the ONE
// honest nag fires (the release classifier computes the same thing publish-side; this is the
// client-side truth for locally-applied generations). Red-team finding 18's client half.
function flip(version, codeRootAbs, why) {
  const prev = readJSON(ACTIVE);
  const prevRootAbs = prev?.codeRoot ? (path.isAbsolute(prev.codeRoot) ? prev.codeRoot : path.join(BRAIN_HOME, prev.codeRoot)) : null;
  const shellChanged = prevRootAbs && fs.existsSync(prevRootAbs) ? shellDiff(prevRootAbs, codeRootAbs) : [];
  const next = {
    generation: (prev?.generation ?? 0) + 1,
    version,
    codeRoot: path.relative(BRAIN_HOME, codeRootAbs),
    previous: prev ? { generation: prev.generation, version: prev.version, codeRoot: prev.codeRoot } : null,
    shellChanged: shellChanged.length > 0,
    shellChangedPaths: shellChanged,
    // Keep the first boot-level change attached to subsequent body-only generations. A host that
    // still booted the pre-change generation must not lose the restart signal merely because a
    // later update changed only implementation code.
    shellChangedSinceVersion: shellChanged.length > 0
      ? (prev?.version || version)
      : (prev?.shellChangedSinceVersion || null),
    shellChangedAtVersion: shellChanged.length > 0
      ? version
      : (prev?.shellChangedAtVersion || null),
    flippedAt: new Date().toISOString(),
  };
  writeAtomic(TXN, JSON.stringify({ state: 'flipping', from: prev?.version ?? null, to: version }));
  writeAtomic(ACTIVE, JSON.stringify(next, null, 2));
  writeAtomic(TXN, JSON.stringify({ state: 'active', from: prev?.version ?? null, to: version }));
  try { fs.writeFileSync(SEEDED, next.flippedAt); } catch { /* marker best-effort */ }
  receipt('SpineFlipped', { from: prev?.version ?? null, to: version, generation: next.generation, why });
  console.log(`✓ spine flipped: ${prev?.version ?? '(none)'} → ${version} (generation ${next.generation}) — live on the next hook fire / MCP call`);
  return next;
}

function applyFromDir(srcDir, version, why) {
  const active = readJSON(ACTIVE);
  if (active?.version === version) {
    const activeRoot = active.codeRoot
      ? (path.isAbsolute(active.codeRoot) ? active.codeRoot : path.join(BRAIN_HOME, active.codeRoot))
      : null;
    const problems = [];
    if (!activeRoot || !fs.existsSync(activeRoot)) problems.push('active generation directory is missing');
    try {
      assertNoSymlinks(srcDir);
      if (!problems.length) problems.push(...gateCandidate(activeRoot));
      problems.push(...gateCandidate(srcDir));
      if (!problems.length && payloadDigest(activeRoot) !== payloadDigest(srcDir)) {
        problems.push('same version identifies different payload bytes — bump the version');
      }
    } catch (e) {
      problems.push(String(e?.message || e));
    }
    if (problems.length) {
      receipt('SameVersionRejected', { version, problems: problems.slice(0, 5) });
      console.error(`✗ active ${version} cannot be treated as an idempotent retry: ${problems[0]}`);
      return false;
    }
    receipt('SameVersionNoop', { version, generation: active.generation, why });
    console.log(`✓ spine already active: ${version} (generation ${active.generation}) — verified no-op`);
    return true;
  }
  writeAtomic(TXN, JSON.stringify({ state: 'staging', to: version }));
  const staging = stagePayload(srcDir, version);
  const problems = gateCandidate(staging);
  receipt('CandidateGated', { version, passed: problems.length === 0, problems: problems.slice(0, 5) });
  if (problems.length) {
    fs.rmSync(staging, { recursive: true, force: true });
    writeAtomic(TXN, JSON.stringify({ state: 'gate-failed', to: version, problems: problems.slice(0, 5) }));
    console.error(`✗ candidate ${version} FAILED the gate — spine untouched, users stay on the working version:`);
    for (const p of problems) console.error(`  · ${p}`);
    return false;
  }
  writeAtomic(TXN, JSON.stringify({ state: 'candidate-ready', to: version }));
  const finalDir = promote(staging, version);
  flip(version, finalDir, why);
  return true;
}

// ── GC (finding 23): keep active + previous + fresh leases; collect the rest ────────────────────
function gc() {
  const active = readJSON(ACTIVE);
  const keep = new Set();
  if (active?.codeRoot) keep.add(path.basename(active.codeRoot));
  if (active?.previous?.codeRoot) keep.add(path.basename(active.previous.codeRoot));
  if (fs.existsSync(LEASES)) {
    for (const f of fs.readdirSync(LEASES)) {
      const p = path.join(LEASES, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs < LEASE_FRESH_MS) {
          const lease = readJSON(p);
          if (lease?.version) keep.add(lease.version);
        } else fs.rmSync(p, { force: true });
      } catch { /* skip */ }
    }
  }
  let removed = 0;
  for (const d of fs.existsSync(VERSIONS) ? fs.readdirSync(VERSIONS) : []) {
    if (!keep.has(d) && !d.includes('.staging-')) {
      try { fs.rmSync(path.join(VERSIONS, d), { recursive: true, force: true }); removed++; } catch { /* busy */ }
    }
  }
  receipt('GcRan', { kept: [...keep], removed });
  console.log(`gc: kept ${[...keep].join(', ') || '(none)'} · removed ${removed}`);
}

// Version ordering, hoisted to module scope so BOTH the exact payload selector and the
// already-converged check below can use one comparator (#126). Two copies is how the
// selection rule and the convergence rule would drift apart.
const semverish = (v) => String(v).split(/[.-]/).map((x) => (Number.isFinite(+x) ? +x : x));
const cmp = (a, b) => { const A = semverish(a), B = semverish(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { if ((A[i] ?? 0) === (B[i] ?? 0)) continue; if (typeof A[i] === 'number' && typeof B[i] === 'number') return A[i] - B[i]; return String(A[i] ?? '') < String(B[i] ?? '') ? -1 : 1; } return 0; };

// ── sources ─────────────────────────────────────────────────────────────────────────────────────
function newestStagedCC(expectedVersion = null) {
  const candidates = [];
  for (const cache of PLUGIN_CACHES) {
    if (!fs.existsSync(cache)) continue;
    for (const version of fs.readdirSync(cache)) {
      if (!version.startsWith('.') && fs.existsSync(path.join(cache, version, 'scripts'))) {
        const dir = path.join(cache, version);
        const payloadVersion = versionOfPayload(dir, version);
        if (!expectedVersion || payloadVersion === expectedVersion) candidates.push({ version: payloadVersion, dir });
      }
    }
  }
  candidates.sort((a, b) => cmp(a.version, b.version));
  return candidates.at(-1) || null;
}
function versionOfPayload(dir, fallback) {
  const pj = readJSON(path.join(dir, '.claude-plugin', 'plugin.json'));
  return pj?.version || fallback;
}

// ── modes ───────────────────────────────────────────────────────────────────────────────────────
function main() {
  fs.mkdirSync(BRAIN_HOME, { recursive: true });

  if (has('--doctor')) {
    const active = readJSON(ACTIVE); const dev = readJSON(DEV); const txn = readJSON(TXN);
    console.log('spine doctor —', BRAIN_HOME);
    console.log('  active :', active ? `${active.version} (gen ${active.generation}, flipped ${active.flippedAt})` : 'NOT SEEDED — hooks run the frozen plugin fallback');
    console.log('  prev   :', active?.previous ? `${active.previous.version} (gen ${active.previous.generation})` : '(none)');
    console.log('  dev    :', dev ? `ON → ${dev.codeRoot}` : 'off');
    console.log('  txn    :', txn ? txn.state : '(clean)');
    console.log('  staged :', (() => { const s = newestStagedCC(); return s ? `${s.version} in CC plugin cache` : '(none found)'; })());
    return 0;
  }

  if (has('--dev-off')) { fs.rmSync(DEV, { force: true }); receipt('DevOff', {}); console.log('dev mode OFF — active.json governs again'); return 0; }
  if (has('--dev')) {
    const target = path.resolve(val('--dev', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin')));
    if (!fs.existsSync(path.join(target, 'scripts'))) { console.error(`✗ ${target} has no scripts/ — point --dev at a checkout's plugin/ dir`); return 1; }
    writeAtomic(DEV, JSON.stringify({ codeRoot: target, setAt: new Date().toISOString() }, null, 2));
    receipt('DevOn', { codeRoot: target });
    console.log(`dev mode ON → ${target} (edits are live on save; --auto will never flip away; turn off: --dev-off)`);
    return 0;
  }

  const lock = acquireLock(argv.join(' '));
  if (!lock.acquired) {
    console.log(`another update is in progress${lock.owner?.pid ? ` (pid ${lock.owner.pid})` : ''} — nothing was applied; exiting busy (${BUSY_EXIT}, concurrency 1).`);
    return BUSY_EXIT;
  }
  try {
    recoverTxn();

    if (has('--rollback')) {
      const active = readJSON(ACTIVE);
      if (!active?.previous) { console.error('✗ nothing to roll back to (no previous generation recorded)'); return 1; }
      const prevRoot = path.isAbsolute(active.previous.codeRoot) ? active.previous.codeRoot : path.join(BRAIN_HOME, active.previous.codeRoot);
      if (!fs.existsSync(prevRoot)) { console.error(`✗ previous generation's payload is gone (${prevRoot}) — cannot roll back`); return 1; }
      flip(active.previous.version, prevRoot, 'rollback');
      receipt('RollbackFlipped', { to: active.previous.version });
      return 0;
    }

    if (has('--seed')) {
      const src = process.env.CLAUDE_PLUGIN_ROOT && fs.existsSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts'))
        ? { dir: process.env.CLAUDE_PLUGIN_ROOT, version: versionOfPayload(process.env.CLAUDE_PLUGIN_ROOT, 'seeded') }
        : (() => { const s = newestStagedCC(); return s ? { dir: s.dir, version: versionOfPayload(s.dir, s.version) } : null; })();
      if (!src) { console.error('✗ nothing to seed from (no CLAUDE_PLUGIN_ROOT, no CC-staged version)'); return 1; }
      return applyFromDir(src.dir, src.version, 'seed') ? 0 : 1;
    }

    if (has('--from-dir')) {
      const dir = path.resolve(val('--from-dir'));
      if (!dir || !fs.existsSync(dir)) { console.error('✗ --from-dir requires an existing payload dir'); return 1; }
      return applyFromDir(dir, versionOfPayload(dir, `dir-${Date.now()}`), 'from-dir') ? 0 : 1;
    }

    // --auto (default): unattended — newest CC-staged version, only if newer than active.
    const dev = readJSON(DEV);
    if (dev) { receipt('AutoSkippedDev', {}); console.log('dev mode is ON — --auto never flips away from a checkout (finding 24).'); return 0; }
    const expectedVersion = val('--expected-version', null);
    const staged = newestStagedCC(expectedVersion);
    const active = readJSON(ACTIVE);
    if (!staged) {
      if (expectedVersion) {
        // ALREADY AHEAD IS ALREADY CONVERGED (issue #126) — but the SELECTION above stays exact.
        //
        // Issue #64 requires that we never apply "a different newer payload in another host cache",
        // and that requirement is right: the caches are per-host, so grabbing a newer payload from
        // .codex to satisfy a .claude request installs something nobody asked for. My first attempt
        // at #126 loosened newestStagedCC() to "newest >= expected" and reintroduced exactly that
        // bug — tests/qe/release/issue-64-host-convergence.test.mjs caught it.
        //
        // The real defect is one layer up: after a release the plugin is bumped to the next -dev
        // generation, so the ACTIVE host is routinely ahead of the published version the updater
        // requests. No payload matched, this returned 1, host sync reported incomplete, and the
        // Console runtime refresh inside that sync was rolled back — so the header's
        // "⟳ update available — click to update" ran clean and changed nothing, forever.
        //
        // Nothing to apply because you are already past it is SUCCESS, not failure. This asserts
        // that about the ACTIVE spine only; it never selects an unrequested payload.
        const activeNow = readJSON(ACTIVE);
        if (activeNow?.version && cmp(activeNow.version, expectedVersion) >= 0) {
          console.log(`already on ${activeNow.version}, at or above requested ${expectedVersion} — nothing to apply.`);
          return 0;
        }
        // NO HOST AT ALL is not a stale spine. With no active spine and no payload of ANY version in
        // any host cache, nothing was ever seeded, so nothing can be behind (a desktop-app/IDE-extension
        // customer whose shell has no host CLI). A host cache holding some OTHER version still fails
        // closed below — issue #64's exact-selection guard is untouched.
        // Existence, not a parse: a corrupt active.json is a damaged spine and still fails closed below.
        // A host that registered the Brain's plugin but staged nothing (its `plugin install` failed) is
        // NOT "no host": that is a failed install and must keep failing.
        if (!fs.existsSync(ACTIVE) && !newestStagedCC() && !HOST_PLUGIN_EVIDENCE.some((dir) => fs.existsSync(dir))) {
          console.log(`no host has staged a payload and no spine is active — nothing to converge for ${expectedVersion}.`);
          return 0;
        }
        console.error(`✗ no staged host payload exactly matches expected version ${expectedVersion} — spine unchanged`);
        return 1;
      }
      console.log('no host-staged version found — nothing to apply.');
      return 0;
    }
    const stagedVersion = versionOfPayload(staged.dir, staged.version);
    if (active && active.version === stagedVersion) { console.log(`already on ${stagedVersion} — nothing to do.`); return 0; }
    receipt('UpdateChecked', { active: active?.version ?? null, staged: stagedVersion });
    return applyFromDir(staged.dir, stagedVersion, active ? 'auto-update' : 'auto-seed') ? 0 : 1;
  } finally {
    releaseLock(lock);
    if (has('--gc') || !has('--no-gc')) { try { gc(); } catch { /* GC never fails the run */ } }
  }
}

// #420 item 6: `--help` used to fall through to the default action (take the update lock and apply). Usage is derived from
// the flags main() reads; help and unknown flags answer BEFORE main() so they touch no state (no BRAIN_HOME mkdir, lock, network).
const USAGE = [
  'usage: node update-apply.mjs [--auto [--expected-version <v>] | --seed | --from-dir <path> | --rollback | --dev [pluginDir] | --dev-off | --doctor] [--gc | --no-gc]',
  '  (no flag = --auto: newest host-staged plugin version, applied only if newer than active)',
  '  --auto [--expected-version <v>]  unattended: apply the host-staged payload, optionally pinned to exactly <v>',
  '  --seed                           seed the spine from the running plugin install',
  '  --from-dir <path>                apply a specific plugin payload dir',
  '  --rollback                       flip back to the previous generation',
  '  --dev [pluginDir]                dev mode: point codeRoot at a checkout\'s plugin/',
  '  --dev-off                        leave dev mode',
  '  --doctor                         report spine state (read-only)',
  '  --gc / --no-gc                   force / skip collecting unreferenced generations after the run',
  '  --help, -h                       print this usage and exit without touching any state',
].join('\n');
const KNOWN_FLAGS = new Set(['--auto', '--seed', '--from-dir', '--rollback', '--dev', '--dev-off', '--doctor', '--gc', '--no-gc', '--expected-version']);
if (process.env.RUVNET_BRAIN_IMPORT_ONLY !== 'update-shell-test') {
  if (has('--help') || has('-h')) { console.log(USAGE); process.exit(0); }
  const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
  if (unknown.length) { console.error(`✗ unknown argument: ${unknown.join(' ')}\n${USAGE}`); process.exit(2); }
  process.exit(main());
}
