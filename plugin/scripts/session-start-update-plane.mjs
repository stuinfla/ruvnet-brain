#!/usr/bin/env node
// session-start-update-plane.mjs — the Stable Spine seed dispatch and the update-check heartbeat.
// Extracted 2026-09-11 out of session-start-core.mjs (unchanged behavior) to keep that file under
// 500 lines. `announceVersion` was intentionally NOT migrated here: it was dead code (defined, never
// called, never tested) and was deleted rather than relocated — moving unused code to a new module
// would still be scope creep, just in a different file.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { read, write, exists, json, firstVersion, dispatchDetached, mtimeMs } from './session-start-fsutil.mjs';
import { KNOWLEDGE_LINE_PREFIX, AUTO_UPDATE_LOCK_STALE_MS, autoUpdateOptOut, knowledgeFacts } from './session-start-health.mjs';
import { inventoryFootprint } from './brain-footprint.mjs';
import { confirm, footprintAlarm } from './brain-confirmation.mjs';

/**
 * KNOWLEDGE SELF-HEAL (owner invariant 2026-09-30: no brain may ever be more than 48h old) AND
 * NEWER-PUBLISHED CHECK (owner requirement 2026-10-02: "all accounts auto update anytime a new corpus of
 * knowledge happens"). Two triggers, ONE updater:
 *   • 'update' — nothing proves the knowledge current inside 24h: launch the detached, bounded
 *     `npx ruvnet-brain@latest --update --no-nightly-prompt` (the exact argv bin/nightly-refresh.mjs runs)
 *     through host-update.mjs's credential boundary and detach.mjs's TTL supervisor. At most one launch
 *     per 6h (30 min after an offline probe).
 *   • 'check' — the knowledge is fresh BY AGE, but age never says whether something newer was published
 *     (measured: v4.4.1 stayed live ~13h after v4.5.0 shipped). At most once per checkMinutes per machine,
 *     the same detached worker first runs the installed `kb/forge-update.mjs --check` (one GET of the
 *     canonical releases/latest pointer, no download) and proceeds to the SAME update only on a newer
 *     identity — forge-update's currencyVerdict(): UPDATE_AVAILABLE/UNKNOWN; CURRENT and REFUSED (the
 *     published corpus is older: never downgrade) stop there.
 * Per machine (all state under brainHome), never while a refresh lock or another launch is live, never
 * blocks (spawn + unref, no wait). SessionStart calls this; so does the long-lived MCP server on a timer
 * (plugin/mcp/server.mjs, announce:false so it never consumes the once-per-session line). The outcome is
 * recorded by the worker and spoken by the NEXT session's knowledge line.
 */
export const AUTO_UPDATE_POLICY = Object.freeze({ staleHours: 24, retryHours: 6, offlineRetryMinutes: 30, ttlSec: 1800, checkMinutes: 60 });
export const corpusCheckMinutes = (env = {}) => {
  const raw = env.RUVNET_CORPUS_CHECK_MINUTES;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : AUTO_UPDATE_POLICY.checkMinutes;
};

const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`); fs.renameSync(tmp, file); return true; }
  catch { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } return false; }
};

export const knowledgeAutoUpdate = ({ env, home, now, hookDir, emit = () => {}, spawnFn = spawn, announce = true }) => {
  const facts = knowledgeFacts({ env, home, now });
  const { attemptFile, lockFile, logFile, checkFile, checkResultFile } = facts.auto;
  const attempt = facts.attempt;
  const hoursAgo = (iso) => (now - Date.parse(iso || '')) / 3_600_000;
  if (announce && attempt?.outcome === 'succeeded' && !attempt.reported) {
    const built = facts.builtMs;
    // A corpus-only release carries its identity in corpusReleaseTag; releaseTag is the code release beside it.
    const id = facts.source?.corpusReleaseTag || facts.source?.releaseTag;
    const short = id && id.length > 28 ? `${id.slice(0, 26)}…` : id;
    const tag = !id ? 'the latest corpus' : id.startsWith('corpus-') ? short : `corpus ${short}`;
    emit(`${KNOWLEDGE_LINE_PREFIX}UPDATED] automatic update finished ${Math.round(hoursAgo(attempt.finishedAt))}h ago: ${tag}, `
      + `knowledge base built ${Number.isFinite(built) ? `${Math.round(facts.hours(built))}h ago` : 'at an UNKNOWN time'}.`);
    writeJsonAtomic(attemptFile, { ...attempt, reported: true });
  }
  const optOut = autoUpdateOptOut({ env, home, facts });
  if (optOut) return { launched: false, why: optOut };
  const fresh = facts.provenWithin(AUTO_UPDATE_POLICY.staleHours)
    || (Number.isFinite(facts.builtMs) && facts.hours(facts.builtMs) <= AUTO_UPDATE_POLICY.staleHours);
  const mode = fresh ? 'check' : 'update';
  if (mode === 'check') {
    const lastCheck = Date.parse(facts.corpusCheck?.launchedAt || '');
    const sinceCheck = now - lastCheck;
    if (Number.isFinite(lastCheck) && sinceCheck >= 0 && sinceCheck < corpusCheckMinutes(env) * 60_000) {
      return { launched: false, why: 'fresh' };
    }
  }
  // A nightly or manual --update holds this lock (kb/refresh-run.mjs refreshLockPath, duplicated here
  // because the plugin payload cannot import kb/); --update would refuse anyway, this saves the launch.
  if (exists(path.join(path.dirname(facts.kbDir), `.${path.basename(facts.kbDir)}.refresh-run.lock`))) {
    return { launched: false, why: 'refresh running' };
  }
  const since = hoursAgo(attempt?.launchedAt);
  const retryHours = attempt?.outcome === 'offline' ? AUTO_UPDATE_POLICY.offlineRetryMinutes / 60 : AUTO_UPDATE_POLICY.retryHours;
  // A SUCCEEDED update never delays the next newer-published check: a different, newer corpus may proceed
  // at once. The same target is not re-run within 6h (host-update.mjs --if-newer's 'not-converged' guard).
  const retryBlocks = !(mode === 'check' && attempt?.outcome === 'succeeded');
  if (retryBlocks && since >= 0 && since < retryHours) return { launched: false, why: 'throttled' };
  // Cross-process: exactly one session (or MCP server timer) wins the O_EXCL create; a stale lock is reclaimed.
  const claim = () => { try { fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() })}\n`, { flag: 'wx' }); return true; } catch { return false; } };
  if (!claim()) {
    const lockMs = Date.parse(json(lockFile)?.at || '') || mtimeMs(lockFile);
    if (!(lockMs > 0 && now - lockMs > AUTO_UPDATE_LOCK_STALE_MS)) return { launched: false, why: 'locked' };
    try { fs.rmSync(lockFile, { force: true }); } catch { /* raced */ }
    if (!claim()) return { launched: false, why: 'locked' };
  }
  const at = new Date(now).toISOString();
  // A check is not an update attempt: it must not reset the 6h retry or read as an abandoned launch.
  if (mode === 'update') writeJsonAtomic(attemptFile, { schemaVersion: 1, launchedAt: at, outcome: 'launched' });
  else writeJsonAtomic(checkFile, { ...(facts.corpusCheck || {}), schemaVersion: 1, launchedAt: at, outcome: 'checking' });
  try {
    const child = spawnFn(process.execPath, [path.join(hookDir, 'detach.mjs'), String(AUTO_UPDATE_POLICY.ttlSec), logFile,
      process.execPath, path.join(hookDir, 'host-update.mjs'), '--knowledge', attemptFile, lockFile,
      ...(mode === 'check' ? ['--if-newer', facts.kbDir, checkFile, checkResultFile] : [])],
    { detached: true, stdio: 'ignore', env, windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
  } catch (error) {
    const reason = `could not launch: ${error.message}`;
    if (mode === 'update') {
      writeJsonAtomic(attemptFile, { schemaVersion: 1, launchedAt: at, outcome: 'failed', code: null, reason, finishedAt: at });
    } else writeJsonAtomic(checkFile, { schemaVersion: 1, launchedAt: at, outcome: 'failed', reason, checkedAt: at });
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    return { launched: false, why: 'launch failed', mode };
  }
  return { launched: true, why: mode === 'check' ? 'checking for a newer published corpus' : 'stale', mode };
};

/**
 * FOOTPRINT (ADR-0098): a cheap, read-only classification (names and sizes of single files only, no
 * hashing, no tree walks) on every session. Silent when the machine is clean. When it is not: ONE line,
 * and — at most once per 6h, never in test mode, never while a refresh holds the lock — a detached
 * `brain-footprint.mjs --sweep --apply` that removes only what the proof allows (private-unique copies are
 * kept). Self-heal installs and updates enforce the same sweep inside bin/install.mjs.
 */
export const FOOTPRINT_SWEEP_HOURS = 6;
export const footprintCheck = ({ env, home, now, hookDir, emit = () => {}, dispatch = dispatchDetached }) => {
  const footprint = inventoryFootprint({ env, home, now, measure: false });
  const line = footprintAlarm(confirm({ footprint, env, home, now }));
  if (!line) return { clean: true, dispatched: false };
  const stamp = path.join(footprint.roots.brainHome, '.footprint-sweep');
  const removable = footprint.cruft.some((i) => ['remove', 'remove-if-proven', 'rotate', 'truncate'].includes(i.action));
  // Nothing a sweep could remove (e.g. a copy kept for the private data it holds — review S7): say it ONCE,
  // until the line changes, instead of at every session; and dispatch no sweep that could only keep it again.
  if (!removable && !footprint.roots.dangling) { // an unplugged brain disk is told every session, and nothing is written beside it
    const notice = path.join(footprint.roots.brainHome, '.footprint-kept-notice');
    if (read(notice) === line) return { clean: false, dispatched: false, repeated: true };
    write(notice, line);
  }
  const due = !(now - mtimeMs(stamp) < FOOTPRINT_SWEEP_HOURS * 3_600_000);
  const testMode = env.RUVNET_BRAIN_TEST === '1' && String(env.RUVNET_FOOTPRINT_SWEEP || '').toLowerCase() !== 'on';
  let dispatched = false;
  if (removable && due && !testMode && !footprint.lockHeld) {
    write(stamp, `${new Date(now).toISOString()}\n`);
    dispatched = dispatch(hookDir, 600, path.join(footprint.roots.brainHome, '.last-footprint-sweep.log'),
      process.execPath, [path.join(hookDir, 'brain-footprint.mjs'), '--sweep', '--apply', '--json'], env);
  }
  emit(dispatched ? line.replace(/\. Fix: /, ' — cleaning it up in the background now. Fix: ') : line);
  return { clean: false, dispatched };
};

export const compareVersions = (a, b) => {
  const left = String(a).split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const right = String(b).split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
};

export const stableSpine = ({ env, hookDir, stateDir, home, pluginVersion, emit, now }) => {
  const activeFile = path.join(stateDir, 'active.json');
  const stamp = path.join(stateDir, '.last-update-check');
  let seedDispatched = false;
  if (!exists(activeFile)) {
    const seedStamp = path.join(stateDir, '.seed-attempted');
    const last = Number(read(seedStamp).trim()) || 0;
    const canSeed = exists(path.join(env.CLAUDE_PLUGIN_ROOT || '', 'scripts'))
      || exists(path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain'));
    if (canSeed && now / 1000 - last > 300) {
      write(seedStamp, `${Math.floor(now / 1000)}\n`);
      seedDispatched = dispatchDetached(hookDir, 120, path.join(stateDir, '.seed.log'),
        'node', [
          path.join(hookDir, 'first-session-worker.mjs'),
          path.join(hookDir, 'update-apply.mjs'),
          path.join(hookDir, 'host-update.mjs'),
          path.join(stateDir, '.last-version-check.log'),
        ], env);
      if (seedDispatched) write(stamp, `${Math.floor(now / 1000)}\n`);
    }
  } else {
    const active = json(activeFile);
    const shellBoundary = active?.shellChangedAtVersion;
    const shellChangedBeforeHost = shellBoundary && pluginVersion
      ? compareVersions(pluginVersion, shellBoundary) < 0
      : false;
    if ((active?.shellChanged || shellChangedBeforeHost) && pluginVersion && active.version && active.version !== pluginVersion) {
      emit(`[RuvNet Brain — v${active.version} changed boot-level declarations (the rare case); this session booted v${pluginVersion}'s]`);
      const host = env.RUVNET_HOOK_HOST || 'claude';
      const convergence = json(path.join(stateDir, 'host-convergence.json'));
      const ready = convergence?.desiredVersion === active.version
        && convergence?.hosts?.[host]?.state === 'ready'
        && convergence.hosts[host].version === active.version;
      if (!ready) {
        emit(`Tell the user ONE line: "🧠 RuvNet Brain v${active.version} runtime is live, but this host's exact boot snapshot is not yet verified — do not restart for this update yet; automatic host repair will retry."`);
      } else if (host === 'codex') {
        emit(`Tell the user ONE line: "🧠 RuvNet Brain v${active.version} is already installed and verified for Codex; restart Codex to load its boot-level declarations, then run /hooks and trust only ruvnet-brain@ruvnet-brain if Codex shows the changed definitions as pending. Runtime behavior already updated live."`);
      } else {
        emit(`Tell the user ONE line: "🧠 RuvNet Brain v${active.version} is already installed and verified for Claude Code; one restart picks up its boot-level declarations (\`claude --continue\` keeps this conversation). Runtime behavior already updated live."`);
      }
    }
  }
  return { seedDispatched, stamp };
};

export const heartbeat = ({ env, hookDir, stateDir, home, running, seedDispatched, stamp, emit, now }) => {
  const last = Number(read(stamp).trim()) || 0;
  const epoch = Math.floor(now / 1000);
  if (seedDispatched || epoch <= 0 || epoch - last <= 900) return;
  write(stamp, `${epoch}\n`);
  const pref = read(path.join(stateDir, '.auto-update-pref')).trim();
  const kbDir = path.join(home, '.cache', 'ruvnet-brain', 'kb');
  if (pref === 'yes' && exists(path.join(kbDir, 'forge-update.mjs'))) {
    const kbLog = path.join(stateDir, '.last-kb-check.log');
    // Only when the automatic knowledge update is OFF on this machine: otherwise it IS applied (signature
    // verified first) and the knowledge line says so — this notice would be a false statement.
    if (/\bBEHIND\b/.test(read(kbLog)) && autoUpdateOptOut({ env, home, facts: knowledgeFacts({ env, home, now }) })) {
      emit('[RuvNet Brain — a newer knowledge bundle is available. It is signed (Ed25519) and the updater verifies that signature before extracting anything. We do NOT auto-apply it: applying replaces executable tool files, which is your call. To update: npx ruvnet-brain@latest --update]');
    }
    // S2 (ONE CURRENCY VERDICT): --result-file records the SAME structured verdict --check/--apply
    // and bin/install.mjs already read (forge-update.mjs's currencyVerdict()), at the well-known path
    // session-start-core.mjs's banner stage reads it from — so the banner's own "is my code out of
    // sync" alarm reads this recorded verdict instead of re-deriving its own comparison.
    dispatchDetached(hookDir, 60, kbLog, process.execPath,
      [path.join(kbDir, 'forge-update.mjs'), '--check', '--result-file', path.join(stateDir, '.last-kb-check-result.json')], env);
  }
  const versionLog = path.join(stateDir, '.last-version-check.log');
  const remoteVersion = firstVersion(read(versionLog));
  dispatchDetached(hookDir, 10, versionLog, process.execPath,
    [path.join(hookDir, 'host-update.mjs'), '--check'], env);
  if (!running || !remoteVersion || remoteVersion === running) return;
  if (pref === 'yes' && exists(path.join(hookDir, 'host-update.mjs'))) {
    dispatchDetached(hookDir, 600, path.join(stateDir, '.last-auto-update.log'),
      process.execPath, [path.join(hookDir, 'host-update.mjs')], env);
    emit(`[RuvNet Brain — v${remoteVersion} is downloading and will AUTO-APPLY via the Stable Spine (ADR-023); this session picks up the new behavior live]`);
    emit('Tell the user ONE short line, near the top of your first response:');
    emit(`  "🧠 RuvNet Brain v${remoteVersion} is installing in the background for every detected host. Runtime behavior goes live automatically; if boot-level declarations changed, I'll ask for a restart only after that host's exact new snapshot is verified."`);
    emit("Don't repeat this notice later in the same session.");
    emit('');
    return;
  }
  emit('[RuvNet Brain — update available, auto-update not enabled]');
  emit('Tell the user this PLAINLY, near the top of your first response:');
  emit(`  "🧠 RuvNet Brain found v${remoteVersion} (you're on v${running}). Run: npx ruvnet-brain@latest --update"`);
  emit("  (Or say the word and I'll turn on auto-update so this never comes up again.)\"");
  emit("Don't repeat this notice later in the same session.");
  emit('');
};
