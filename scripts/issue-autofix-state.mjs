// scripts/issue-autofix-state.mjs — where the autofix job (ADR-107) remembers things: its paths, its slice of the
// shared issue-watch state file (key __issueAutofix, spread-merged, never overwritten), the halt file and the
// per-run receipts. Everything is written tmp-then-rename so a crash never leaves half a file.
import fs from 'node:fs';
import path from 'node:path';

export const STATE_NS = '__issueAutofix';

export const PATHS = (home) => ({
  clone: `${home}/.cache/ruvnet-brain/autofix-repo`,
  runner: `${home}/.cache/ruvnet-brain/autofix-runner`,
  worktrees: `${home}/.cache/ruvnet-brain/issue-fix-worktrees`,
  state: process.env.ISSUE_WATCH_STATE || `${home}/.claude/ruvnet-brain/issue-watch-state.json`,
  receipts: `${home}/.cache/ruvnet-brain/issue-autofix/runs`,
  offFile: `${home}/.config/ruvnet-brain/issue-autofix.off`,
  haltFile: `${home}/.config/ruvnet-brain/issue-autofix.halt`,
  holdFile: `${home}/.config/ruvnet-brain/release-hold`,
  lock: process.env.ISSUE_FIX_LOCK || `${home}/.claude/ruvnet-brain/issue-fix.lock`,
  primary: `${home}/Code/ruvnet-brain`,
});

export function readJson(file, fallback = {}) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch { return fallback; }
}

export function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const readNs = (statePath) => {
  const all = readJson(statePath, {});
  const ns = all[STATE_NS];
  return ns && typeof ns === 'object' && !Array.isArray(ns) ? ns : {};
};

/** Re-reads the shared file, merges `patch` into the autofix slice only, and writes it back. Other keys are untouched. */
export function patchNs(statePath, patch) {
  const all = readJson(statePath, {});
  all[STATE_NS] = { ...readNs(statePath), ...patch };
  writeAtomic(statePath, all);
  return all[STATE_NS];
}

/** Merge `patch` into one issue's record. */
export function patchIssue(statePath, n, patch) {
  const cur = readNs(statePath)[n] || {};
  return patchNs(statePath, { [n]: { ...cur, ...patch } });
}

export const clearAwaiting = (statePath, n) => {
  const { awaitingVerification, ...rest } = readNs(statePath)[n] || {}; // eslint-disable-line no-unused-vars
  patchNs(statePath, { [n]: rest });
};

export const writeHaltFile = (file, info) => writeAtomic(file, { at: new Date().toISOString(), ...info });
