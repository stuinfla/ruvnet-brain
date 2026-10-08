#!/usr/bin/env node
// DISTINCT-FROM: kb/forge-update.mjs reclaimBackups — that proof keeps a full-KB copy unless EVERY byte of it survives in the live brain, which an older generation never satisfies (measured 2026-10-01: 3.6 GB in three copies kept forever). This module releases public bytes (signed, re-downloadable) and demands byte-identity in live only for private-store files, per the owner's rule (ADR-0098).
// brain-footprint.mjs — THE FOOTPRINT GUARANTEE (ADR-0098). One classifier for everything the Brain
// owns on a machine, in three classes, and one sweep that keeps it that way:
//
//   must-exist      the live KB, the active Stable Spine generation, each registered plugin generation
//   may-exist       bounded state: logs under a size cap, lease-held plugin generations, the newest npx
//                   copy, lifecycle evidence under its own retention policy, models, small state files,
//                   the newest rescued operational files of released KB copies (kb-copy-rescued/)
//   must-not-exist  every other full-KB copy (kb.bak-*, kb.install-preserved-*, kb.pre-update-*, …,
//                   *-quarantine-* dirs), stale install stages and forge candidates, older npx copies,
//                   stale leases, ruflo scratch debris, rotated-away log bytes
//   unowned         things in our directories we did not create and cannot classify: REPORTED, never removed
//
// SAFETY (non-negotiable, each one has a test that breaks it and goes red):
//   * A KB copy is removed only after kbCopyProof() shows nothing in it is unique (every private-store file
//     byte-identical in live, everything else of public provenance); a KEPT proof is cached (footprint-io).
//     Its operational files (logs, ruflo scratch) are copied out and verified first (rescueOperationalFiles).
//   * Nothing is followed through a symlink; a removal target must sit directly inside the real directory it
//     was inventoried in, itself inside an owned root (footprint-io removeWithin).
//   * Kept: non-terminal transaction trees; every KB sibling and npx copy while someone else holds the refresh
//     lock or an install is activating; hand-made backups (unowned). The live KB is never written here.
//   * Plugin generations go only through the caller's lease-aware collector (prunePluginGenerations).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isKbTree, kbCopyProof } from './kb-copy-proof.mjs';
import { brainLocation } from './brain-location.mjs';
import { assessMoveLeftovers, cachedKept, cmpVersion, isVolumeMetadata, keptCopyFix, physical, pidAlive, readProofCache, rememberKept, removeWithin, rotate,
  RESCUE_DIR, rescueOperationalFiles, treeBytes, truncateToTail } from './footprint-io.mjs';

export { cmpVersion, physical, treeBytes } from './footprint-io.mjs';

export { kbCopyProof, privateStoreNames } from './kb-copy-proof.mjs';

const MIB = 1024 * 1024;
export const FOOTPRINT_POLICY = Object.freeze({
  schemaVersion: 1,
  logCapBytes: 2 * MIB,              // an append-only ledger rotates to <name>.1 past this (bound: 2x cap)
  textLogCapBytes: 512 * 1024,       // a .last-*.log is truncated to its newest tail past this
  fixedAllowanceBytes: 512 * MIB,    // plugin + spine generations, logs, evidence, scratch, state files
  staleStageMs: 2 * 3_600_000,       // an install stage nobody activated in 2h is debris
  staleForgeCandidateMs: 24 * 3_600_000,
  staleLeaseMs: 6 * 3_600_000,       // plugin/scripts/update-apply.mjs LEASE_FRESH_MS
  staleRufloRunMs: 3_600_000,        // plugin/scripts/project-progression-store.mjs STALE_RUN_MS
  rescuedCopiesKept: 5,              // kb-copy-rescued/<copy>: the newest five released copies' logs are kept
});

/** Every full-KB copy name this product (or a recovery) has ever created beside the live KB. A superset of
 * kb/update-storage-transaction.mjs managedStorageInventory's names and kb/forge-update.mjs reclaimBackups'
 * prefixes — tests/unit/brain-footprint.test.mjs fails if either grows a name this table lacks. */
export const kbCopyPrefixes = (base) => [
  `${base}.bak-`, `${base}.pre-reset-backup-`, `${base}.agent-harness-generator-backup-`,
  `${base}-pre-gap-rebuild-backup-`, `${base}.install-preserved-`, `${base}.install-prior-`,
  `${base}.pre-update-`, `${base}.next-`, `${base}.rollback-`, `${base}.failed-`,
];
const BRAIN_BACKUP_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z$/; // the updater's stamp(); other kb.bak-* are the customer's
const TRANSACTION_KINDS ={ next: 'candidate', rollback: 'rollback', failed: 'failed' };
export const LOG_FILES = Object.freeze(['evidence.jsonl', 'token-ledger.jsonl', 'detached-jobs.jsonl',
  'update-receipts.jsonl', 'gate-blocks.jsonl', 'distill-receipts.jsonl', 'assertion-gate-shadow.jsonl',
  'capability-live-evidence.jsonl', 'design-grades.jsonl', 'grounding-overrides.jsonl']);
const TEXT_LOG = /^\.(?:last-[A-Za-z0-9-]+|seed)\.log$/;
const RECOVERY_LEFTOVER = /(?:\.(?:bak|retired|dead)-\d{6,}|^bootstrap-backup-\d)/;
const RUFLO_DEBRIS = new Set(['.swarm', '.claude', '.claude-flow', 'ruvector.db']);
// Directories in the brain home that hold data another tool owns: measured, shown, never budgeted or removed.
const FOREIGN = { 'ruvector-mcp': 'RuVector MCP server working store (its own live memory)',
  'worktree-recovery': 'hand-made recovery archives, not created by the Brain' };
const TERMINAL = new Set(['NOOP', 'COMMITTED', 'ROLLED_BACK']);

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const lstat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir).filter((n) => !isVolumeMetadata(n)).sort(); } catch { return []; } };
/** A lease's process is gone only when the OS says so (ESRCH); anything else counts as alive. */

export function footprintRoots({ env = process.env, home = os.homedir() } = {}) {
  const brainHomeSpelled = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  const brainHome = physical(brainHomeSpelled);
  const kbSpelled = env.RUVNET_BRAIN_KB || path.join(brainHomeSpelled, 'kb');
  const kbDir = physical(kbSpelled);
  // WHERE THE BRAIN REALLY IS and whether its disk is there: the ONE reader, plugin/scripts/brain-location.mjs
  // (owned by `--move-brain`). An 'unmounted' brain is reported and nothing is cleaned, created or reinstalled.
  const location = brainLocation({ home, brainHome: path.resolve(brainHomeSpelled) });
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  // `npm run`/`npx` export npm_config_cache to every child — including a test that swapped HOME for a temp
  // dir, where honouring it would point the sweep at the REAL npm cache. It is honoured only inside HOME.
  const defaultCache = process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'npm-cache') : path.join(home, '.npm');
  const configured = env.npm_config_cache || env.NPM_CONFIG_CACHE;
  const npmCache = configured && physical(configured).startsWith(`${physical(home)}${path.sep}`) ? configured : defaultCache;
  return { brainHome, kbDir, kbParent: path.dirname(kbDir), brainHomeParent: path.dirname(brainHome),
    // A moved brain's quarantines may sit beside the SPELLED home (~/.cache) as well as the real one.
    brainHomeParents: [...new Set([path.dirname(brainHome), physical(path.dirname(path.resolve(brainHomeSpelled)))])],
    location, dangling: location.state === 'unmounted',
    claudeRegistry: path.join(claude, 'plugins', 'installed_plugins.json'),
    claudePluginCache: path.join(claude, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'),
    codexPluginCache: path.join(codex, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'),
    npxRoot: path.join(npmCache, '_npx') };
}


function transactionState(kbParent, base, id) {
  const dir = path.join(kbParent, `.${base}.update-transactions`, id);
  const phases = names(dir).filter((n) => /^\d{3}-[A-Z_]+\.json$/.test(n));
  if (!phases.length) return null;
  return readJson(path.join(dir, phases.at(-1)))?.state || 'UNREADABLE';
}

/** Registered Claude generations (installPaths) and the version each one carries. */
function claudeRegistered(registryFile) {
  const registry = readJson(registryFile);
  return Object.entries(registry?.plugins || {}).filter(([name]) => /^ruvnet-brain@/.test(name))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [])).map((e) => e?.installPath).filter((p) => typeof p === 'string' && p)
    .map((p) => physical(p));
}

const pluginVersion = (dir) => readJson(path.join(dir, '.claude-plugin', 'plugin.json'))?.version || null;

/**
 * The classified inventory. Pure read. `measure:false` skips recursive byte counts (SessionStart's fast
 * path); classes and actions do not depend on bytes. `evidence` is kb/lifecycle-evidence-retention.mjs
 * assessLifecycleEvidence (injected: the plugin payload cannot import kb/).
 */
export function inventoryFootprint({ env = process.env, home = os.homedir(), now = Date.now(), measure = true,
  evidence = null, npmLatest = null, holdingRefreshLock = false, selfPath = process.argv[1] || '' } = {}) {
  const roots = footprintRoots({ env, home });
  const policy = FOOTPRINT_POLICY;
  const items = [];
  const bytes = (p) => (measure ? treeBytes(p) : 0);
  // Each item remembers the REAL directory it was found in; removal refuses if that changed (review S7).
  const add = (item) => { items.push({ bytes: 0, realParent: physical(path.dirname(item.path)), ...item }); return item; };
  const base = path.basename(roots.kbDir);
  const refreshLock = path.join(roots.kbParent, `.${base}.refresh-run.lock`);
  const lockHeld = !holdingRefreshLock && Boolean(lstat(refreshLock));
  // A plain `npx ruvnet-brain` install holds no refresh lock (review S6). It is IN PROGRESS while its activation
  // marker, its young stage, or a kb.install-prior-<ts>-<pid> rollback copy names a live pid: nothing beside the KB moves.
  // Proof of life is bounded by TIME too (re-review S5): an old marker or a reused / EPERM pid no longer freezes it.
  const young = (at) => Number.isFinite(at) && now - at >= -60_000 && now - at <= policy.staleStageMs; // a FUTURE stamp is stale
  const priorParts = (name) => name.slice(`${base}.install-prior-`.length).split('-').map(Number);
  const installing = (() => {
    const marker = readJson(path.join(roots.kbParent, `.${base}.install-activation.lock`));
    if (marker && young(Number(marker.at)) && pidAlive(Number(marker.pid))) return true;
    return names(roots.kbParent).some((n) => (n.startsWith(`.${base}.install-stage-`) && young(lstat(path.join(roots.kbParent, n))?.mtimeMs))
      || (n.startsWith(`${base}.install-prior-`) && young(priorParts(n)[0]) && pidAlive(priorParts(n).at(-1))));
  })();
  const kbBlocked = lockHeld ? 'an update holds the refresh lock; KB copies are never touched while it runs'
    : installing ? 'an install is activating a new generation; KB copies and installer copies are never touched while it runs' : null;

  // ── a moved brain whose volume is not mounted: report it, touch NOTHING (no sweep, no reinstall) ─
  if (roots.dangling) {
    add({ id: 'kb', path: roots.location.path, class: 'must-exist', kind: 'live-kb', action: 'report', present: false, dangling: true,
      reason: roots.location.message });
    return summarize({ roots, items, policy, kbCopyDirs: [], lockHeld });
  }

  // ── the live KB and its siblings ────────────────────────────────────────────────────────────
  const liveOk = isKbTree(roots.kbDir);
  add({ id: 'kb', path: roots.kbDir, class: 'must-exist', kind: 'live-kb', action: 'keep',
    bytes: bytes(roots.kbDir), present: liveOk, reason: liveOk ? 'the one live knowledge base' : 'MISSING or incomplete' });
  const kbCopyDirs = [];
  const seen = new Set();
  const quarantineCopies = (dir) => names(dir).filter((n) => isKbTree(path.join(dir, n))).length;
  const proofCache = readProofCache(roots.brainHome);
  // A quarantine whose every entry is a KB copy already proven KEPT has nothing a sweep could remove.
  const quarantineKept = (dir) => {
    const children = names(dir);
    const hits = children.map((n) => isKbTree(path.join(dir, n)) && cachedKept(proofCache, path.join(dir, n), roots.kbDir));
    return children.length && hits.every(Boolean) ? { hit: hits[0], file: path.join(dir, children[0]) } : null;
  };
  const addQuarantine = (full) => {
    const kept = quarantineKept(full);
    add({ id: 'quarantine', path: full, class: 'must-not-exist', kind: 'quarantine', action: kbBlocked || kept ? 'report' : 'remove-if-proven',
      blocked: kbBlocked, bytes: bytes(full), copies: quarantineCopies(full), keptUnique: Boolean(kept), fix: kept ? keptCopyFix(kept.file, kept.hit) : null,
      reason: kept ? `KEPT: ${kept.hit.reason}` : 'a recovery quarantine of earlier KB copies' });
  };
  const scanSiblings = (dir) => {
    for (const name of names(dir)) {
      const full = path.join(dir, name);
      if (seen.has(full) || full === roots.kbDir) continue;
      const st = lstat(full);
      if (!st) continue;
      const before = items.length;
      classifySibling(name, full, st);
      if (items.length > before) seen.add(full);
    }
  };
  const classifySibling = (name, full, st) => {
    {
      const prefix = kbCopyPrefixes(base).find((p) => name.startsWith(p));
      if (prefix === `${base}.bak-` && !BRAIN_BACKUP_STAMP.test(name.slice(prefix.length))) {
        return void add({ id: 'foreign', path: full, class: 'unowned', kind: 'hand-made-backup', action: 'report', bytes: bytes(full),
          reason: 'a hand-made KB backup (not the Brain\'s own kb.bak-<stamp> name): reported, never deleted' });
      }
      if (prefix) {
        if (st.isSymbolicLink() || !st.isDirectory()) { add({ id: 'kb-copy', path: full, class: 'unowned', kind: 'kb-copy-link', action: 'report', reason: 'a link or file under a KB-copy name; never followed or removed' }); return; }
        const kind = Object.entries(TRANSACTION_KINDS).find(([k]) => prefix === `${base}.${k}-`)?.[1] || null;
        if (kind) {
          const state = transactionState(roots.kbParent, base, name.slice(prefix.length));
          if (state && !TERMINAL.has(state)) {
            add({ id: 'kb-copy', path: full, class: 'may-exist', kind: `transaction-${kind}`, action: 'keep', bytes: bytes(full),
              reason: `owned by an in-progress update transaction (${state}); its recovery decides` });
            return;
          }
        }
        kbCopyDirs.push(full);
        const hit = cachedKept(proofCache, full, roots.kbDir);
        add({ id: 'kb-copy', path: full, class: 'must-not-exist', kind: 'kb-copy', action: kbBlocked || hit ? 'report' : 'remove-if-proven',
          blocked: kbBlocked, bytes: bytes(full), keptUnique: Boolean(hit), fix: hit ? keptCopyFix(full, hit) : null,
          reason: hit ? `KEPT: ${hit.reason}` : 'a second full copy of the knowledge base' });
      } else if (name.startsWith(`.${base}.install-stage-`) && st.isDirectory() && !st.isSymbolicLink()) {
        const stale = now - st.mtimeMs > policy.staleStageMs;
        add({ id: 'install-stage', path: full, class: stale ? 'must-not-exist' : 'may-exist', kind: 'install-stage',
          action: stale && !kbBlocked ? 'remove' : 'keep', bytes: bytes(full), reason: stale ? 'an install stage nobody activated' : 'an install may be extracting into it now' });
      } else if (/^\.forge-.+-candidate-/.test(name) && st.isDirectory() && !st.isSymbolicLink()) {
        const empty = !names(full).length;
        const stale = empty || now - st.mtimeMs > policy.staleForgeCandidateMs;
        add({ id: 'forge-candidate', path: full, class: stale ? 'must-not-exist' : 'may-exist', kind: 'forge-candidate',
          action: stale && !kbBlocked ? 'remove' : 'keep', bytes: bytes(full), reason: stale ? 'a local rebuild candidate left by a killed run' : 'a local rebuild may be using it' });
      } else if (/quarantine/i.test(name) && st.isDirectory() && !st.isSymbolicLink()) {
        addQuarantine(full);
      }
    }
  };
  scanSiblings(roots.kbParent);
  if (roots.brainHome !== roots.kbParent) scanSiblings(roots.brainHome);
  for (const parent of roots.brainHomeParents) for (const name of names(parent)) {
    if (!/^ruvnet-brain.*quarantine/i.test(name)) continue;
    const full = path.join(parent, name);
    if (seen.has(full)) continue;
    seen.add(full);
    const st = lstat(full);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    addQuarantine(full);
  }
  // Interrupted `--move-brain` leftovers (dead pid only; none while a refresh lock may mean a move is running):
  // REPORTED with the exact next step, never removed. The set-aside original is the ONLY copy if the Brain is gone.
  if (!lockHeld) for (const lo of assessMoveLeftovers({ brainHome: roots.location.path, location: roots.location, isAlive: pidAlive })) {
    add({ id: 'move-leftover', path: lo.path, class: 'unowned', kind: 'move-leftover', action: 'report', what: lo.what, onlyCopy: lo.onlyCopy,
      bytes: lo.link ? 0 : bytes(lo.path), copies: !lo.link && (isKbTree(path.join(lo.path, 'kb')) || isKbTree(lo.path)) ? 1 : 0, fix: lo.fix, reason: lo.reason });
  }

  // ── brain home state ────────────────────────────────────────────────────────────────────────
  const homeEntries = names(roots.brainHome);
  for (const name of homeEntries) {
    const full = path.join(roots.brainHome, name);
    const st = lstat(full);
    if (!st || full === roots.kbDir || seen.has(full)) continue;
    const entryStart = items.length;
    // Lifecycle evidence has its own retention policy (kb/lifecycle-evidence-retention.mjs); with the
    // assessment injected it is ONE item below, otherwise it is measured here — never counted twice.
    if (name === 'refresh-runs' || name === `.${base}.update-transactions`) {
      if (!evidence) add({ id: 'evidence', path: full, class: 'may-exist', kind: 'lifecycle-evidence', action: 'keep', bytes: bytes(full), reason: 'refresh and transaction receipts (retention: lifecycle-evidence-v1)' });
      continue;
    }
    if (FOREIGN[name]) { add({ id: 'foreign', path: full, class: 'unowned', kind: name, action: 'report', bytes: bytes(full), reason: FOREIGN[name] }); continue; }
    if (LOG_FILES.includes(name) && st.isFile()) {
      const over = st.size > policy.logCapBytes;
      add({ id: 'log', path: full, class: over ? 'must-not-exist' : 'may-exist', kind: 'log', action: over ? 'rotate' : 'keep', bytes: st.size,
        reason: over ? `${(st.size / MIB).toFixed(1)} MiB over its ${policy.logCapBytes / MIB} MiB cap` : 'within its size cap' });
      continue;
    }
    if (LOG_FILES.some((log) => name === `${log}.1`) && st.isFile()) {
      add({ id: 'log', path: full, class: 'may-exist', kind: 'log-rotation', action: 'keep', bytes: st.size,
        reason: 'the one retained rotation of a capped log (replaced at the next rotation)' });
      continue;
    }
    // Operational files rescued from released KB copies (footprint-io rescueOperationalFiles), one directory
    // per copy, each file <= 2 MiB and <= 16 MiB per copy (kb-copy-proof RESCUE_*_CAP_BYTES): bounded like a
    // rotated log, by keeping the newest few directories.
    if (name === RESCUE_DIR && st.isDirectory() && !st.isSymbolicLink()) {
      const rescued = names(full).map((n) => ({ n, s: lstat(path.join(full, n)) })).filter((r) => r.s)
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs || a.n.localeCompare(b.n));
      rescued.forEach(({ n }, i) => {
        const keep = i < policy.rescuedCopiesKept;
        add({ id: 'rescued', path: path.join(full, n), class: keep ? 'may-exist' : 'must-not-exist', kind: 'rescued-kb-logs',
          action: keep ? 'keep' : 'remove', bytes: bytes(path.join(full, n)),
          reason: keep ? 'logs rescued from a released KB copy (one of the newest kept)' : `older than the newest ${policy.rescuedCopiesKept} rescued KB-copy logs` });
      });
      continue;
    }
    if (TEXT_LOG.test(name) && st.isFile()) {
      const over = st.size > policy.textLogCapBytes;
      add({ id: 'log', path: full, class: over ? 'must-not-exist' : 'may-exist', kind: 'text-log', action: over ? 'truncate' : 'keep', bytes: st.size,
        reason: over ? 'over its size cap' : 'within its size cap' });
      continue;
    }
    // A hand-made backup (X.bak-20260808, .retired-, .dead-, bootstrap-backup-*): the Brain never writes
    // these names (its own backups are ISO-stamped, `.bak-2026-10-01T…Z`, and live outside the brain home),
    // so there is no proof it is ours to judge. REPORTED, never removed, never counted as Brain cruft.
    if (RECOVERY_LEFTOVER.test(name) && !st.isSymbolicLink()) {
      const holdsKb = st.isDirectory() && (isKbTree(full) || names(full).some((n) => isKbTree(path.join(full, n))));
      add({ id: 'leftover', path: full, class: 'unowned', kind: 'recovery-leftover', action: 'report', bytes: bytes(full),
        reason: holdsKb ? 'a hand-made recovery copy that holds a KB tree, not created by the Brain; remove it yourself once inspected'
          : 'a hand-made backup, not created by the Brain; kept — remove it yourself if you no longer need it' });
      continue;
    }
    if (name === 'leases' && st.isDirectory()) {
      for (const lease of names(full)) {
        const lp = path.join(full, lease); const ls = lstat(lp);
        if (ls && ls.isFile() && now - ls.mtimeMs > policy.staleLeaseMs && !pidAlive(readJson(lp)?.pid)) {
          add({ id: 'lease', path: lp, class: 'must-not-exist', kind: 'stale-lease', action: 'remove', bytes: ls.size, reason: 'a spine lease older than 6h whose process is gone' });
        }
      }
    }
    if (name === 'versions' && st.isDirectory() && !st.isSymbolicLink()) {
      const active = readJson(path.join(roots.brainHome, 'active.json'));
      const keep = new Set([active?.codeRoot, active?.previous?.codeRoot].filter(Boolean).map((p) => path.basename(p)));
      for (const leaseName of names(path.join(roots.brainHome, 'leases'))) {
        const lp = path.join(roots.brainHome, 'leases', leaseName); const ls = lstat(lp);
        const lease = ls ? readJson(lp) : null;
        if (lease?.version && (now - ls.mtimeMs < policy.staleLeaseMs || pidAlive(lease.pid))) keep.add(lease.version);
      }
      for (const v of names(full)) {
        const vp = path.join(full, v);
        const kept = keep.has(v);
        add({ id: 'spine', path: vp, class: kept ? (path.basename(active?.codeRoot || '') === v ? 'must-exist' : 'may-exist') : 'must-not-exist',
          kind: 'spine-generation', action: kept ? 'keep' : 'report', bytes: bytes(vp), fix: kept ? null : 'npx ruvnet-brain@latest --update',
          reason: kept ? 'active, previous, or leased Stable Spine generation' : 'unreferenced spine generation (collected by the next update)' });
      }
      continue;
    }
    if (name === 'ruflo-cwd' && st.isDirectory() && !st.isSymbolicLink()) {
      for (const project of names(full)) {
        const pp = path.join(full, project); const ps = lstat(pp);
        if (!ps || ps.isSymbolicLink() || !ps.isDirectory()) continue;
        for (const entry of names(pp)) {
          const ep = path.join(pp, entry); const es = lstat(ep);
          if (!es || es.isSymbolicLink()) continue;
          const debris = RUFLO_DEBRIS.has(entry) || (entry.startsWith('run-') && es.isDirectory() && now - es.mtimeMs > policy.staleRufloRunMs);
          if (debris) add({ id: 'ruflo-scratch', path: ep, class: 'must-not-exist', kind: 'ruflo-scratch', action: 'remove', bytes: bytes(ep), reason: 'ruflo working-directory debris (never read back)' });
        }
      }
    }
    // Debris items carved out of this directory above are counted once, as debris, not again as state.
    const carved = items.slice(entryStart).reduce((n, i) => n + (i.bytes || 0), 0);
    add({ id: 'state', path: full, class: 'may-exist', kind: name === 'models' ? 'models' : 'state', action: 'keep',
      bytes: Math.max(0, bytes(full) - carved), reason: name === 'models' ? 'embedder and reranker model cache' : 'Brain state' });
  }

  // ── host plugin caches ──────────────────────────────────────────────────────────────────────
  const registered = new Set(claudeRegistered(roots.claudeRegistry));
  for (const v of names(roots.claudePluginCache)) {
    const vp = physical(path.join(roots.claudePluginCache, v)); const vs = lstat(path.join(roots.claudePluginCache, v));
    if (!vs || vs.isSymbolicLink() || !vs.isDirectory() || !pluginVersion(vp)) continue;
    const leases = names(path.join(vp, '.in_use')).length;
    const isRegistered = registered.has(vp);
    add({ id: 'plugin', path: vp, host: 'claude', version: pluginVersion(vp), bytes: bytes(vp),
      class: isRegistered ? 'must-exist' : leases ? 'may-exist' : 'must-not-exist', kind: 'claude-plugin-generation',
      action: isRegistered ? 'keep' : 'collect', reason: isRegistered ? 'the registered Claude Code plugin'
        : leases ? `kept while ${leases} session lease(s) may still run it` : 'an unregistered generation with no live session' });
  }
  const codexVersions = names(roots.codexPluginCache).filter((v) => pluginVersion(path.join(roots.codexPluginCache, v)));
  const codexNewest = codexVersions.slice().sort(cmpVersion).at(-1);
  for (const v of codexVersions) {
    const vp = path.join(roots.codexPluginCache, v);
    add({ id: 'plugin', path: vp, host: 'codex', version: pluginVersion(vp), bytes: bytes(vp), class: v === codexNewest ? 'must-exist' : 'must-not-exist',
      kind: 'codex-plugin-generation', action: v === codexNewest ? 'keep' : 'report', fix: v === codexNewest ? null : 'codex plugin update ruvnet-brain@ruvnet-brain',
      reason: v === codexNewest ? 'the current Codex plugin' : 'an older Codex plugin generation' });
  }

  // ── npx copies of the installer ─────────────────────────────────────────────────────────────
  const self = physical(selfPath);
  const npx = [];
  for (const hash of names(roots.npxRoot)) {
    const dir = path.join(roots.npxRoot, hash);
    const manifest = readJson(path.join(dir, 'package.json'));
    const specs = manifest?._npx?.packages || Object.keys(manifest?.dependencies || {});
    if (!specs.length || !specs.every((s) => /^ruvnet-brain(?:@[^/\\]*)?$/.test(String(s)))) {
      if (lstat(path.join(dir, 'node_modules', 'ruvnet-brain'))) add({ id: 'npx', path: dir, class: 'unowned', kind: 'npx-dev-copy', action: 'report', bytes: bytes(dir), reason: 'an npx copy of a local checkout (not a registry install)' });
      continue;
    }
    const version = readJson(path.join(dir, 'node_modules', 'ruvnet-brain', 'package.json'))?.version;
    if (!version) continue;
    npx.push({ dir, version, mtime: lstat(dir)?.mtimeMs || 0, running: self.startsWith(`${physical(dir)}${path.sep}`) });
  }
  // Keep at most ONE copy: the running installer, else the newest copy that is not older than the current
  // version (npm latest when known, else the installed runtime). Every older copy goes.
  const current = npmLatest || readJson(path.join(roots.brainHome, 'active.json'))?.version
    || readJson(path.join(roots.kbDir, 'RUNTIME-IDENTITY.json'))?.brainVersion || null;
  const newestVersion = npx.map((n) => n.version).sort(cmpVersion).at(-1);
  const keepVersion = current && cmpVersion(newestVersion, current) < 0 ? null : newestVersion;
  const keeper = npx.find((n) => n.running) || npx.filter((n) => n.version === keepVersion).sort((a, b) => b.mtime - a.mtime)[0];
  for (const n of npx) {
    const keep = n === keeper || n.running;
    // An older copy fetched < 2h ago may be running in another terminal; none goes during an update/install (S6).
    const recent = now - n.mtime <= policy.staleStageMs;
    const hold = !keep && (kbBlocked || (recent ? 'fetched in the last 2h; it may be running now' : null));
    add({ id: 'npx', path: n.dir, version: n.version, bytes: bytes(n.dir), class: keep ? 'may-exist' : 'must-not-exist', kind: 'npx-copy',
      action: keep || hold ? (keep ? 'keep' : 'report') : 'remove', blocked: hold || null,
      reason: keep ? (n.running ? 'the installer running now' : 'the newest installer copy') : `an older installer copy (${n.version})` });
  }

  // ── lifecycle evidence, judged by its own policy ────────────────────────────────────────────
  if (evidence) {
    add({ id: 'evidence', path: path.join(roots.brainHome, 'refresh-runs'), class: evidence.withinBudget ? 'may-exist' : 'must-not-exist',
      kind: 'lifecycle-evidence', action: evidence.withinBudget ? 'keep' : 'prune', bytes: evidence.before?.bytes || 0,
      reason: evidence.withinBudget ? 'within lifecycle-evidence-v1 retention' : `over retention (${evidence.unsafe?.length || 0} unsafe entr(ies))` });
  }
  return summarize({ roots, items, policy, kbCopyDirs, lockHeld });
}

function summarize({ roots, items, policy, kbCopyDirs, lockHeld }) {
  const sum = (list) => list.reduce((n, i) => n + (i.bytes || 0), 0);
  const owned = items.filter((i) => i.class !== 'unowned');
  const kbBytes = sum(items.filter((i) => i.kind === 'live-kb'));
  const modelBytes = sum(items.filter((i) => i.kind === 'models'));
  const budgetBytes = kbBytes + modelBytes + policy.fixedAllowanceBytes;
  const breakdown = {};
  for (const i of owned) {
    const group = i.kind === 'live-kb' ? 'knowledge base' : i.kind === 'models' ? 'models' : /plugin|spine/.test(i.kind) ? 'plugins'
      : i.kind === 'lifecycle-evidence' && i.class !== 'must-not-exist' ? 'receipts'
      : i.kind === 'npx-copy' ? 'installer' : /log/.test(i.kind) ? 'logs' : i.class === 'must-not-exist' ? 'cruft' : 'state';
    breakdown[group] = (breakdown[group] || 0) + (i.bytes || 0);
  }
  const cruft = items.filter((i) => i.class === 'must-not-exist');
  // Every extra copy unremovable → its own fix, not --clean; all owned by an update transaction → --update (4.5.2).
  const extra = items.filter((i) => i.kind === 'kb-copy' || i.kind === 'quarantine'), onlyCopy = items.find((i) => i.kind === 'move-leftover' && i.onlyCopy);
  const inTransaction = items.some((i) => /^transaction-/.test(i.kind)), kbCopyFix = onlyCopy ? onlyCopy.fix : extra.length && extra.every((i) => i.keptUnique) ? extra[0].fix
    : !extra.length && inTransaction ? 'npx ruvnet-brain@latest --update' : null;
  const moved = items.filter((i) => i.kind === 'move-leftover');
  return { schemaVersion: 1, kind: 'ruvnet-brain-footprint', roots, items, policy, lockHeld, kbCopyFix,
    liveKb: items.find((i) => i.kind === 'live-kb'),
    kbCopies: (items.find((i) => i.kind === 'live-kb')?.present ? 1 : 0)
      + items.filter((i) => i.kind === 'kb-copy' || /^transaction-/.test(i.kind)).length
      + items.filter((i) => i.kind === 'quarantine').reduce((n, i) => n + (i.copies || 0), 0),
    kbCopyDirs, cruft, totalBytes: sum(owned), budgetBytes, withinBudget: sum(owned) <= budgetBytes, breakdown,
    moveLeftovers: { items: moved.length, copies: moved.reduce((n, i) => n + (i.copies || 0), 0), bytes: sum(moved) },
    unowned: items.filter((i) => i.class === 'unowned') };
}

/**
 * Enforce the classification. `apply:false` reports what would happen. Every removal is returned by name;
 * every refusal is returned with its reason. `collectPluginGenerations` is the caller's lease-aware
 * collector (bin/install.mjs prunePluginGenerations); `pruneEvidence` is kb's pruneLifecycleEvidence.
 */
export function sweepFootprint({ apply = false, collectPluginGenerations = null, pruneEvidence = null,
  proveCopy = kbCopyProof, beforeRemove = null, ...options } = {}) {
  const before = inventoryFootprint(options);
  const { roots } = before;
  const owned = [...new Set([roots.kbParent, roots.brainHome, ...roots.brainHomeParents, roots.npxRoot].map(physical))];
  const prove = (copyDir) => {
    const proof = proveCopy({ copyDir, liveDir: roots.kbDir });
    if (apply && !proof.disposable && isKbTree(roots.kbDir)) rememberKept(roots.brainHome, copyDir, roots.kbDir, proof); // a dry run writes nothing
    return proof;
  };
  const removed = []; const kept = []; const rotated = []; const errors = [];
  if (roots.dangling) {
    return { schemaVersion: 1, kind: 'ruvnet-brain-footprint-sweep', apply, removed, rotated, errors, plugins: null, evidence: null,
      kept: [{ path: roots.location.path, kind: 'unmounted-brain', reason: before.items[0].reason }], freedBytes: 0, before, after: before };
  }
  const record = (item, freed, note) => removed.push({ path: item.path, kind: item.kind, bytes: freed ?? item.bytes, reason: note || item.reason });
  for (const item of before.items) {
    if (!['remove', 'remove-if-proven', 'rotate', 'truncate'].includes(item.action)) {
      if (item.class === 'must-not-exist' || item.class === 'unowned') kept.push({ path: item.path, kind: item.kind, reason: item.blocked || item.reason, fix: item.fix || null });
      continue;
    }
    try {
      if (item.action === 'rotate') { if (apply) rotate(item.path); rotated.push({ path: item.path, bytes: item.bytes }); continue; }
      if (item.action === 'truncate') { if (apply) truncateToTail(item.path, before.policy.textLogCapBytes / 2); rotated.push({ path: item.path, bytes: item.bytes }); continue; }
      if (apply) beforeRemove?.(item);
      if (item.action === 'remove') { record(item, apply ? removeWithin(item.path, item.realParent, owned) : item.bytes); continue; }
      // remove-if-proven: a KB copy, or a quarantine holding KB copies.
      if (item.kind === 'kb-copy') {
        const proof = prove(item.path);
        if (!proof.disposable) { kept.push({ path: item.path, kind: item.kind, reason: `KEPT: ${proof.reason}`, unique: proof.unique }); continue; }
        if (apply) rescueOperationalFiles(item.path, proof.rescue, roots.brainHome); // throws -> the copy is kept
        record(item, apply ? removeWithin(item.path, item.realParent, owned) : item.bytes, proof.reason);
        continue;
      }
      let uniqueLeft = false;
      const quarantineReal = physical(item.path);
      for (const child of names(item.path)) {
        const childPath = path.join(item.path, child);
        const proof = isKbTree(childPath) ? prove(childPath)
          : { disposable: false, unique: [], reason: 'not a KB copy; not ours to judge' };
        if (!proof.disposable) { uniqueLeft = true; kept.push({ path: childPath, kind: 'quarantined-copy', reason: `KEPT: ${proof.reason}`, unique: proof.unique }); continue; }
        if (apply) rescueOperationalFiles(childPath, proof.rescue, roots.brainHome, `${path.basename(item.path)}--${child}`); // throws -> kept
        record({ path: childPath, kind: 'quarantined-copy', bytes: treeBytes(childPath) }, apply ? removeWithin(childPath, quarantineReal, owned) : undefined, proof.reason);
      }
      if (!uniqueLeft && apply) removeWithin(item.path, item.realParent, owned);
    } catch (error) { errors.push({ path: item.path, reason: error.message }); kept.push({ path: item.path, kind: item.kind, reason: `could not act: ${error.message}` }); }
  }
  let plugins = null;
  if (collectPluginGenerations && before.items.some((i) => i.kind === 'claude-plugin-generation' && i.class !== 'must-exist')) {
    try { plugins = collectPluginGenerations({ registryPath: roots.claudeRegistry, apply }); }
    catch (error) { errors.push({ path: roots.claudePluginCache, reason: error.message }); }
  }
  let evidence = null;
  if (pruneEvidence && apply) {
    try { evidence = pruneEvidence({ brainHome: roots.brainHome, kbDir: roots.kbDir }); }
    catch (error) { errors.push({ path: roots.brainHome, reason: error.message }); }
  }
  const after = apply ? inventoryFootprint({ ...options, evidence: evidence ? { withinBudget: evidence.withinBudget, before: evidence.after, unsafe: evidence.unsafe } : options.evidence }) : before;
  return { schemaVersion: 1, kind: 'ruvnet-brain-footprint-sweep', apply, removed, kept, rotated, errors, plugins, evidence,
    freedBytes: removed.reduce((n, r) => n + (r.bytes || 0), 0), before, after };
}

/** The KB's own sanctioned readers, loaded from the live KB (where the updater keeps them). */
export async function loadKbReaders(kbDir) {
  try {
    const evidence = await import(pathToFileURL(path.join(kbDir, 'lifecycle-evidence-retention.mjs')).href);
    return { assessLifecycleEvidence: evidence.assessLifecycleEvidence, pruneLifecycleEvidence: evidence.pruneLifecycleEvidence };
  } catch { return {}; }
}

// CLI: the detached SessionStart sweep. `node brain-footprint.mjs --sweep [--apply] [--json]`.
if (process.argv[1] && pathToFileURL(physical(process.argv[1])).href === pathToFileURL(physical(fileURLToPath(import.meta.url))).href) {
  const argv = process.argv.slice(2);
  const roots = footprintRoots();
  const readers = await loadKbReaders(roots.kbDir);
  const evidence = readers.assessLifecycleEvidence ? (() => { try { return readers.assessLifecycleEvidence({ brainHome: roots.brainHome, kbDir: roots.kbDir }); } catch { return null; } })() : null;
  const result = sweepFootprint({ apply: argv.includes('--apply'), evidence, pruneEvidence: readers.pruneLifecycleEvidence || null });
  const { before: _b, after, ...rest } = result;
  const out = { ...rest, after: { kbCopies: after.kbCopies, totalBytes: after.totalBytes, budgetBytes: after.budgetBytes, cruft: after.cruft.length } };
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(out)}\n`
    : `footprint sweep${result.apply ? '' : ' (dry run)'}: removed ${result.removed.length} (${(result.freedBytes / MIB).toFixed(1)} MiB), rotated ${result.rotated.length}, kept ${result.kept.length}\n`);
}
