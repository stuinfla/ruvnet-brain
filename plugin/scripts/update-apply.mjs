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

const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const ACTIVE = path.join(BRAIN_HOME, 'active.json');
const VERSIONS = path.join(BRAIN_HOME, 'versions');
const LOCK = path.join(BRAIN_HOME, '.update.lock');
const TXN = path.join(BRAIN_HOME, 'update-txn.json');
const RECEIPTS = path.join(BRAIN_HOME, 'update-receipts.jsonl');
const LEASES = path.join(BRAIN_HOME, 'leases');
const DEV = path.join(BRAIN_HOME, 'dev.json');
const SEEDED = path.join(BRAIN_HOME, '.spine-seeded');
const PLUGIN_CACHES = [
  path.join(os.homedir(), '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'),
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'),
];
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

// ── the lock (finding 5): atomic mkdir; stale-pid reclaim (issue-fix.mjs house pattern) ──────────
function acquireLock(target) {
  fs.mkdirSync(BRAIN_HOME, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK); // atomic: exists → EEXIST
      writeAtomic(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), target, startedAt: new Date().toISOString() }));
      return true;
    } catch {
      const owner = readJSON(path.join(LOCK, 'owner.json'));
      try { if (owner && owner.pid) { process.kill(owner.pid, 0); return false; } } catch { /* stale */ }
      try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* race — retry once */ }
    }
  }
  return false;
}
function releaseLock() { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* gone */ } }

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
  const haveBash = fs.existsSync('/bin/bash');
  for (const f of fs.existsSync(scripts) ? fs.readdirSync(scripts) : []) {
    const p = path.join(scripts, f);
    if (f.endsWith('.sh')) {
      if (!haveBash) continue;
      const r = spawnSync('/bin/bash', ['-n', p], { encoding: 'utf8' });
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
const SHELL_PATHS = ['hooks/hooks.json', 'scripts/hook-shim.mjs', 'mcp/server.mjs', '.mcp.json'];
function shellDiff(prevRootAbs, nextRootAbs) {
  const changed = [];
  for (const rel of SHELL_PATHS) {
    const a = (() => { try { return fs.readFileSync(path.join(prevRootAbs, rel), 'utf8'); } catch { return null; } })();
    const b = (() => { try { return fs.readFileSync(path.join(nextRootAbs, rel), 'utf8'); } catch { return null; } })();
    if (a !== b) changed.push(rel);
  }
  // skills/ and commands/ are boot-loaded markdown: any file-set or content difference counts.
  for (const dir of ['skills', 'commands']) {
    const list = (root) => { try { return fs.readdirSync(path.join(root, dir), { recursive: true }).sort().join('|'); } catch { return ''; } };
    if (list(prevRootAbs) !== list(nextRootAbs)) changed.push(`${dir}/`);
  }
  return changed;
}

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

  if (!acquireLock(argv.join(' '))) { console.log('another update is in progress — exiting (concurrency 1).'); return 0; }
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
    releaseLock();
    if (has('--gc') || !has('--no-gc')) { try { gc(); } catch { /* GC never fails the run */ } }
  }
}

process.exit(main());
