#!/usr/bin/env node
// session-start-health.mjs — the three LOCAL installation-health reads SessionStart's banner depends
// on: is the brain turned off, is the knowledge cache actually usable, and is the MCP worker alive.
// Extracted 2026-09-11 out of session-start-core.mjs to keep that file under 500 lines; behavior is
// unchanged from the original inline functions.
//
// These are the checks behind the 🚨 HEALTH ALARM and the RETRIEVAL-DOWN banner — LOCAL installation
// integrity, not maintainer-only content. Per the 2026-09-11 reviewer correction, everything read
// here is delivered to every user via SessionStart's existing always-shown alarm/banner lines,
// worded for the user — never gated behind the maintainer entitlement file.
import fs from 'node:fs';
import path from 'node:path';
import { json, exists, mtimeMs } from './session-start-fsutil.mjs';

export const brainState = (env, home) => {
  const stateDir = env.RUVNET_BRAIN_STATE_DIR || path.join(home, '.config', 'ruvnet-brain');
  const file = path.join(stateDir, 'brain-off');
  let off = env.RUVNET_BRAIN_OFF === '1';
  if (!off) {
    try { fs.statSync(file); off = true; }
    catch (error) { off = !(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')); }
  }
  let since = '';
  if (off) {
    const record = json(file);
    if (typeof record?.since === 'string') since = record.since.slice(0, 10);
    if (!since && mtimeMs(file)) since = new Date(mtimeMs(file)).toISOString().slice(0, 10);
  }
  return { off, since, stateDir, file };
};

export const health = (home, off) => {
  const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
  let rvf = false;
  try { rvf = fs.readdirSync(kb).some((name) => name.endsWith('.rvf') && exists(path.join(kb, name))); }
  catch { /* absent */ }
  const absentByChoice = off && (!exists(kb) || !rvf);
  if (absentByChoice) return { problem: '', absentByChoice };
  if (!exists(kb)) return { problem: `the brain cache directory is MISSING (${kb}) — reinstall: npx github:stuinfla/ruvnet-brain`, absentByChoice };
  if (!rvf) return { problem: `NO vector stores (.rvf) found in ${kb} — the brain is empty; reinstall: npx github:stuinfla/ruvnet-brain --force`, absentByChoice };
  if (!exists(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'))) {
    return { problem: `reader dependencies are MISSING (node_modules gone) — every search WILL fail. Fix: cd ${kb} && npm i`, absentByChoice };
  }
  const last = json(path.join(home, '.cache', 'ruvnet-brain', 'health.json'));
  if (last?.status === 'down') {
    const detail = `"error": ${JSON.stringify(String(last.error || 'unknown error'))}`.slice(0, 180);
    return { problem: `the last real search FAILED across all repos (${detail}). Fix: cd ${kb} && npm i, then run one search to clear the alarm`, absentByChoice };
  }
  return { problem: '', absentByChoice };
};

export const mcpReadiness = (env, home) => {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  const receipt = json(path.join(brainHome, 'mcp-readiness.json'));
  if (receipt?.state === 'ready' && Number.isInteger(receipt.pid) && Number.isInteger(receipt.workerPid)) {
    try {
      process.kill(receipt.pid, 0);
      process.kill(receipt.workerPid, 0);
      return { state: 'ready', receipt };
    } catch { /* a stale receipt is registration evidence, not live evidence */ }
  }
  if (receipt?.state === 'degraded') return { state: 'degraded', receipt };
  return { state: 'registered', receipt };
};
