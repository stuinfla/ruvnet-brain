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

/**
 * KNOWLEDGE SELF-HEAL (owner invariant 2026-09-30: no brain may ever be more than 48h old). The
 * nightly scheduler is opt-in and can silently never register, so this does not depend on it: when
 * a session starts and nothing proves the knowledge current inside 24h, launch ONE detached, bounded
 * `npx ruvnet-brain@latest --update --no-nightly-prompt` (the exact argv bin/nightly-refresh.mjs
 * runs) through the existing host-update.mjs credential boundary and detach.mjs TTL supervisor.
 * Per machine (all state under brainHome), at most one launch per 6h (30 min after an offline
 * probe), never while a refresh lock or another launch is live, never blocks (spawn + unref, no
 * wait). The outcome is recorded by the worker and spoken by the NEXT session's knowledge line.
 */
export const AUTO_UPDATE_POLICY = Object.freeze({ staleHours: 24, retryHours: 6, offlineRetryMinutes: 30, ttlSec: 1800 });

const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`); fs.renameSync(tmp, file); return true; }
  catch { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } return false; }
};

export const knowledgeAutoUpdate = ({ env, home, now, hookDir, emit = () => {}, spawnFn = spawn }) => {
  const facts = knowledgeFacts({ env, home, now });
  const { attemptFile, lockFile, logFile } = facts.auto;
  const attempt = facts.attempt;
  const hoursAgo = (iso) => (now - Date.parse(iso || '')) / 3_600_000;
  if (attempt?.outcome === 'succeeded' && !attempt.reported) {
    const built = facts.builtMs;
    const tag = facts.source?.releaseTag ? `corpus ${facts.source.releaseTag}` : 'the latest corpus';
    emit(`${KNOWLEDGE_LINE_PREFIX}UPDATED] automatic update finished ${Math.round(hoursAgo(attempt.finishedAt))}h ago: ${tag}, `
      + `knowledge base built ${Number.isFinite(built) ? `${Math.round(facts.hours(built))}h ago` : 'at an UNKNOWN time'}.`);
    writeJsonAtomic(attemptFile, { ...attempt, reported: true });
  }
  const optOut = autoUpdateOptOut({ env, home, facts });
  if (optOut) return { launched: false, why: optOut };
  const fresh = facts.provenWithin(AUTO_UPDATE_POLICY.staleHours)
    || (Number.isFinite(facts.builtMs) && facts.hours(facts.builtMs) <= AUTO_UPDATE_POLICY.staleHours);
  if (fresh) return { launched: false, why: 'fresh' };
  // A nightly or manual --update holds this lock (kb/refresh-run.mjs refreshLockPath, duplicated here
  // because the plugin payload cannot import kb/); --update would refuse anyway, this saves the launch.
  if (exists(path.join(path.dirname(facts.kbDir), `.${path.basename(facts.kbDir)}.refresh-run.lock`))) {
    return { launched: false, why: 'refresh running' };
  }
  const since = hoursAgo(attempt?.launchedAt);
  const retryHours = attempt?.outcome === 'offline' ? AUTO_UPDATE_POLICY.offlineRetryMinutes / 60 : AUTO_UPDATE_POLICY.retryHours;
  if (since >= 0 && since < retryHours) return { launched: false, why: 'throttled' };
  // Cross-process: exactly one session wins the O_EXCL create; a lock older than the TTL is stale.
  const claim = () => { try { fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() })}\n`, { flag: 'wx' }); return true; } catch { return false; } };
  if (!claim()) {
    const lockMs = Date.parse(json(lockFile)?.at || '') || mtimeMs(lockFile);
    if (!(lockMs > 0 && now - lockMs > AUTO_UPDATE_LOCK_STALE_MS)) return { launched: false, why: 'locked' };
    try { fs.rmSync(lockFile, { force: true }); } catch { /* raced */ }
    if (!claim()) return { launched: false, why: 'locked' };
  }
  writeJsonAtomic(attemptFile, { schemaVersion: 1, launchedAt: new Date(now).toISOString(), outcome: 'launched' });
  try {
    const child = spawnFn(process.execPath, [path.join(hookDir, 'detach.mjs'), String(AUTO_UPDATE_POLICY.ttlSec), logFile,
      process.execPath, path.join(hookDir, 'host-update.mjs'), '--knowledge', attemptFile, lockFile],
    { detached: true, stdio: 'ignore', env, windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
  } catch (error) {
    writeJsonAtomic(attemptFile, { schemaVersion: 1, launchedAt: new Date(now).toISOString(), outcome: 'failed',
      code: null, reason: `could not launch: ${error.message}`, finishedAt: new Date(now).toISOString() });
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    return { launched: false, why: 'launch failed' };
  }
  return { launched: true, why: 'stale' };
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
    if (/\bBEHIND\b/.test(read(kbLog))) {
      emit('[RuvNet Brain — a newer knowledge bundle is available. It is signed (Ed25519) and the updater verifies that signature before extracting anything. We do NOT auto-apply it: applying replaces executable tool files, which is your call. To update: cd ~/.cache/ruvnet-brain/kb && node forge-update.mjs --apply]');
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
