#!/usr/bin/env node
// session-start-update-plane.mjs — the Stable Spine seed dispatch and the update-check heartbeat.
// Extracted 2026-09-11 out of session-start-core.mjs (unchanged behavior) to keep that file under
// 500 lines. `announceVersion` was intentionally NOT migrated here: it was dead code (defined, never
// called, never tested) and was deleted rather than relocated — moving unused code to a new module
// would still be scope creep, just in a different file.
import path from 'node:path';
import { read, write, exists, json, firstVersion, dispatchDetached } from './session-start-fsutil.mjs';

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
    dispatchDetached(hookDir, 60, kbLog, process.execPath,
      [path.join(kbDir, 'forge-update.mjs'), '--check'], env);
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
