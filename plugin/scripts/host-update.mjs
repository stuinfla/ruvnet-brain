#!/usr/bin/env node
// Host-neutral automatic updater. The published installer is the single coordinator for Claude
// Code and Codex, so lifecycle updates cannot drift into host-specific shell pipelines again.
import { spawnSync } from 'node:child_process';
import { automaticInvocation, automaticPath, updateSource } from './automatic-update.mjs';
import { developerCoordinatorOwner } from './developer-update-owner.mjs';

const CHILD_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'ComSpec', 'PATHEXT',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'FORCE_COLOR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'RUVNET_BRAIN_HOME', 'RUVNET_BRAIN_KB', 'RUVNET_BRAIN_MODEL_CACHE',
  'RUVNET_BRAIN_NO_UPDATE_FALLBACK', 'RUVNET_BRAIN_TEST', 'RUVNET_DEVELOPER_UPDATE_TOKEN',
]);

export function childEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => CHILD_ENV_KEYS.has(key)));
  env.PATH = automaticPath({ home: source.HOME || source.USERPROFILE, env: source });
  return env;
}

if (process.argv.includes('--check')) {
  try {
    const response = await fetch('https://registry.npmjs.org/ruvnet-brain/latest', {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) process.exit(1);
    const metadata = await response.json();
    if (typeof metadata.version !== 'string' || !metadata.version) process.exit(1);
    process.stdout.write(`${metadata.version}\n`);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}


// --knowledge <attemptFile> <lockFile> [--if-newer <kbDir> <checkFile> <resultFile>]: the SessionStart
// (and MCP server timer) knowledge self-heal worker (launched by
// session-start-update-plane.mjs under detach.mjs's TTL). Unlike the default mode below it DOES
// update knowledge: the same argv bin/nightly-refresh.mjs runs, through the same env boundary.
// Offline (registry unreachable) is recorded as 'offline' so the next session retries in 30 min
// without reporting a failure. Every other outcome is recorded for the next session to speak.
const knowledgeAt = process.argv.indexOf('--knowledge');
if (knowledgeAt >= 0) {
  const fs = await import('node:fs');
  const [attemptFile, lockFile] = process.argv.slice(knowledgeAt + 1);
  const record = (fields) => {
    try {
      let prior = {};
      try { prior = JSON.parse(fs.readFileSync(attemptFile, 'utf8')); } catch { /* first write */ }
      const tmp = `${attemptFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify({ ...prior, ...fields, finishedAt: new Date().toISOString() })}\n`);
      fs.renameSync(tmp, attemptFile);
    } catch { /* the next session reports a launch with no outcome as a failure */ }
  };
  try {
    const coordinator = developerCoordinatorOwner();
    if (coordinator.active && !coordinator.ready) throw new Error(`coordinated updater is not ready: ${coordinator.reason}`);
    const source = coordinator.active ? 'developer-suite' : updateSource();
    // --if-newer <kbDir> <checkFile> <resultFile>: the newer-published identity check (2026-10-02). Run the
    // INSTALLED updater's --check (bounded transient GET retries of the canonical releases/latest pointer, no download) and only a
    // newer identity proceeds to the update below. Exit codes are forge-update.mjs's own: 0 current (or
    // REFUSED: the published corpus is older — never downgrade), 10 newer, 2 network, 5 incompatible.
    const ifNewerAt = process.argv.indexOf('--if-newer');
    if (ifNewerAt >= 0) {
      const path = await import('node:path');
      const [kbDir, checkFile, resultFile] = process.argv.slice(ifNewerAt + 1);
      const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
      const note = (fields) => {
        try {
          const tmp = `${checkFile}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, `${JSON.stringify({ ...(readJson(checkFile) || {}), schemaVersion: 1, ...fields, checkedAt: new Date().toISOString() })}\n`);
          fs.renameSync(tmp, checkFile);
        } catch { /* the next tick re-checks */ }
      };
      // process.exit() skips finally{}, so every early stop releases the shared lock itself.
      const stop = () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* stale-lock rule reclaims it */ } process.exit(0); };
      const started = Date.now();
      const check = spawnSync(process.execPath, [path.join(kbDir, 'forge-update.mjs'), '--check', '--result-file', resultFile], {
        env: childEnvironment(), encoding: 'utf8', timeout: Number(process.env.RUVNET_CORPUS_CHECK_TIMEOUT_MS || 90_000),
      });
      const out = `${check.stdout || ''}\n${check.stderr || ''}`;
      const result = readJson(resultFile);
      const fresh = result && Date.parse(result.recordedAt || '') >= started - 1000 ? result : null;
      const candidateTag = fresh?.candidateTag || /canonical built:\s+(\S+)/.exec(out)?.[1] || null;
      const verdict = fresh?.currencyVerdict || /currency verdict:\s+([A-Z_]+)/.exec(out)?.[1] || null;
      const reason = (out.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /error|refus|incompatible|fail/i.test(l)) || '').slice(0, 200);
      // Decide by the recorded IDENTITY verdict whenever this run wrote one; the exit code only when it did
      // not (a network failure or an incompatible release dies before recording). Measured against the real
      // API: an install whose profile selects no stores exits 0 on UPDATE_AVAILABLE ("All stores current").
      const newer = verdict ? ['UPDATE_AVAILABLE', 'UNKNOWN'].includes(verdict) : check.status === 10;
      if (!newer && (verdict || check.status === 0)) {
        note({ outcome: verdict === 'REFUSED' ? 'refused' : 'current', verdict: verdict || 'CURRENT', candidateTag, reason: '' });
        stop();
      }
      if (!newer) {
        note({ outcome: check.status === 2 ? 'offline' : check.status === 5 ? 'incompatible' : 'failed',
          verdict: null, candidateTag, reason: reason || `check exited ${check.error ? check.error.message : check.status}` });
        stop();
      }
      // Newer. Loop guard: the same target already "succeeded" within 6h yet is still not installed — do
      // not download it again every hour; a DIFFERENT newer corpus proceeds at once.
      const prior = readJson(attemptFile);
      if (prior?.outcome === 'succeeded' && candidateTag && prior.targetTag === candidateTag
        && Date.now() - Date.parse(prior.launchedAt || '') < 6 * 3_600_000) {
        note({ outcome: 'not-converged', verdict, candidateTag, reason: 'the last automatic update to this corpus finished without installing it' });
        stop();
      }
      note({ outcome: 'updating', verdict, candidateTag, reason: '' });
      const tmp = `${attemptFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, launchedAt: new Date().toISOString(), outcome: 'launched',
        trigger: 'newer-corpus-published', targetTag: candidateTag })}\n`);
      fs.renameSync(tmp, attemptFile);
    }
    const probe = process.env.RUVNET_AUTO_UPDATE_PROBE_URL || 'https://registry.npmjs.org/ruvnet-brain/latest';
    let online = source === 'installed' || source === 'developer-suite';
    if (!online) try { online = (await fetch(probe, { signal: AbortSignal.timeout(5_000) })).ok; } catch { /* offline */ }
    if (!online) {
      record({ outcome: 'offline', code: null, reason: `registry unreachable (${probe})` });
    } else {
      const invocation = automaticInvocation(['--update', '--no-nightly-prompt'], { source });
      const run = spawnSync(invocation.executable, invocation.args, {
        env: childEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        timeout: Number(process.env.RUVNET_KNOWLEDGE_UPDATE_TIMEOUT_MS || 25 * 60_000),
      });
      process.stdout.write(run.stdout || '');
      process.stderr.write(run.stderr || '');
      // eslint-disable-next-line no-control-regex
      const tail = `${run.stderr || ''}\n${run.stdout || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
        .split('\n').map((line) => line.trim()).filter(Boolean);
      const code = run.error ? null : run.status;
      record({ outcome: code === 0 ? 'succeeded' : 'failed', code,
        reason: code === 0 ? '' : String(run.error?.message || tail.find((l) => /✗|error|fail/i.test(l)) || tail.at(-1) || 'no output').slice(0, 200) });
    }
  } catch (error) {
    record({ outcome: 'failed', code: null, reason: error.message.slice(0, 200) });
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* stale-lock rule reclaims it */ }
  }
  process.exit(0);
}

let invocation;
try { invocation = automaticInvocation(['--update', '--host-sync-only', '--no-nightly-prompt']); }
catch (error) { process.stderr.write(`[ruvnet-brain] automatic update refused: ${error.message}\n`); process.exit(1); }
const result = spawnSync(invocation.executable, invocation.args, {
  // The downloaded package must not inherit unrelated API keys, cloud credentials, or tokens from
  // the interactive host. npm's registry integrity protects the package bytes; this boundary
  // limits what those bytes can observe when they execute.
  env: childEnvironment(),
  stdio: 'inherit',
  timeout: Number(process.env.RUVNET_HOST_UPDATE_TIMEOUT_MS || 9 * 60_000),
});

if (result.error) {
  process.stderr.write(`[ruvnet-brain] host update failed: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
