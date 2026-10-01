#!/usr/bin/env node
// Host-neutral automatic updater. The published installer is the single coordinator for Claude
// Code and Codex, so lifecycle updates cannot drift into host-specific shell pipelines again.
import { spawnSync } from 'node:child_process';

const CHILD_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'ComSpec', 'PATHEXT',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'FORCE_COLOR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'RUVNET_BRAIN_HOME', 'RUVNET_BRAIN_KB', 'RUVNET_BRAIN_MODEL_CACHE',
  'RUVNET_BRAIN_NO_UPDATE_FALLBACK', 'RUVNET_BRAIN_TEST',
]);

export function childEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => CHILD_ENV_KEYS.has(key)),
  );
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

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// --knowledge <attemptFile> <lockFile>: the SessionStart knowledge self-heal worker (launched by
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
    const probe = process.env.RUVNET_AUTO_UPDATE_PROBE_URL || 'https://registry.npmjs.org/ruvnet-brain/latest';
    let online = false;
    try { online = (await fetch(probe, { signal: AbortSignal.timeout(5_000) })).ok; } catch { /* offline */ }
    if (!online) {
      record({ outcome: 'offline', code: null, reason: `registry unreachable (${probe})` });
    } else {
      const run = spawnSync(npx, ['--yes', 'ruvnet-brain@latest', '--update', '--no-nightly-prompt'], {
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
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* stale-lock rule reclaims it */ }
  }
  process.exit(0);
}

const result = spawnSync(npx, [
  '--yes',
  'ruvnet-brain@latest',
  '--update',
  '--host-sync-only',
  '--no-nightly-prompt',
], {
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
