#!/usr/bin/env node
// scripts/codex-hook-wrapper-history.mjs — every byte-exact Codex hook bridge the Brain has ever shipped.
//
// WHY (owner's machine, 2026-10-17). bin/install.mjs trusts an existing ~/.cache/ruvnet-brain/codex-hook.mjs
// only when it equals the NEW source or a wrapper in a RETAINED Stable Spine generation (versions/<v>/).
// A bridge written by an older release whose generation has since been pruned (for example the 4.5.2
// wrapper, sha256 d3ee284722aa…, written while stale 4.5.2 code ran) is still the Brain's own bytes, but
// nothing on disk proves it any more, so every update reported hook-wrapper-ownership-conflict and failed
// host convergence night after night. The proof that was missing is HISTORICAL: the set of wrapper bytes
// each shipped tag carried. That set is derived here from git, committed as data/codex-hook-wrapper-history.json
// (shipped in the npm package), and checked against git in the unit suite so it cannot drift.
//
// It proves only identity of BYTES. Links, hard links, another uid, a foreign path and edited bytes stay
// conflicts: those checks run first in legacyBrainWrapperOwnership and are untouched.
//
//   node scripts/codex-hook-wrapper-history.mjs --write   # regenerate data/codex-hook-wrapper-history.json
//   node scripts/codex-hook-wrapper-history.mjs --check   # exit 1 when the committed file differs from git

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HISTORY_FILE = path.join('data', 'codex-hook-wrapper-history.json');
export const HISTORY_KIND = 'ruvnet-brain-codex-hook-wrapper-history';
export const WRAPPER_SOURCE = 'plugin/scripts/codex-hook-wrapper.mjs';
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

const semver = (tag) => tag.slice(1).split('.').map(Number);
const byVersion = (a, b) => { const [x, y] = [semver(a), semver(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Release tags (vX.Y.Z) in this checkout, ascending. Empty when git or the tags are unavailable. */
export function releaseTags(root = ROOT) {
  try {
    return git(root, ['tag', '-l', 'v*']).split('\n').map((line) => line.trim()).filter((tag) => RELEASE_TAG.test(tag)).sort(byVersion);
  } catch { return []; }
}

/** { sha256, bytes, tags } for every distinct wrapper the release tags carried, ordered by first shipping tag. */
export function deriveWrapperHistory(root = ROOT) {
  const tags = releaseTags(root);
  const wrappers = new Map();
  for (const tag of tags) {
    let bytes;
    try { bytes = execFileSync('git', ['show', `${tag}:${WRAPPER_SOURCE}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); }
    catch { continue; } // a tag that predates the wrapper shipped no bridge
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!wrappers.has(sha256)) wrappers.set(sha256, { sha256, bytes: bytes.length, tags: [] });
    wrappers.get(sha256).tags.push(tag);
  }
  return {
    schemaVersion: 1,
    kind: HISTORY_KIND,
    source: WRAPPER_SOURCE,
    releaseTags: tags.length,
    wrappers: [...wrappers.values()],
  };
}

export function readWrapperHistory(root = ROOT) {
  const history = JSON.parse(fs.readFileSync(path.join(root, HISTORY_FILE), 'utf8'));
  if (history?.schemaVersion !== 1 || history.kind !== HISTORY_KIND || !Array.isArray(history.wrappers)) {
    throw new Error(`${HISTORY_FILE} is not a schema-1 ${HISTORY_KIND}`);
  }
  return history;
}

/**
 * How the committed history differs from git: `missing` = wrappers a release tag shipped that the file lacks
 * (an upgrade of those bytes would be a conflict again); `extra` = rows in the file no release tag shipped
 * (bytes the installer would trust that git never did -- a hand-added row is exactly the forgery this must name).
 */
export function historyDrift(committed, derived) {
  const key = (row) => `${row.sha256}:${row.bytes}`;
  const known = new Set((committed.wrappers || []).map(key));
  const shipped = new Set(derived.wrappers.map(key));
  return {
    missing: derived.wrappers.filter((row) => !known.has(key(row))),
    extra: (committed.wrappers || []).filter((row) => !shipped.has(key(row))),
  };
}
/** Kept for callers that only ask the one-sided question. */
export function missingWrappers(committed, derived) { return historyDrift(committed, derived).missing; }
export function describeDrift({ missing, extra }) {
  const name = (row) => `${String(row.sha256 || '').slice(0, 12)} (${row.tags?.[0] ?? 'no tag'})`;
  return [missing.length ? `missing ${missing.map(name).join(', ')}` : '', extra.length ? `not shipped by any release tag: ${extra.map(name).join(', ')}` : '']
    .filter(Boolean).join('; ');
}

export function main(argv = process.argv.slice(2)) {
  const derived = deriveWrapperHistory();
  if (!derived.releaseTags) {
    console.error('[wrapper-history] no vX.Y.Z tags are visible to git here; nothing to derive');
    return 1;
  }
  const text = `${JSON.stringify(derived, null, 2)}\n`;
  const file = path.join(ROOT, HISTORY_FILE);
  if (argv.includes('--write')) {
    fs.writeFileSync(file, text);
    console.log(`wrote ${HISTORY_FILE}: ${derived.wrappers.length} distinct wrapper(s) across ${derived.releaseTags} release tag(s)`);
    return 0;
  }
  if (argv.includes('--check')) {
    // The BYTES are the contract; the tag lists are provenance. A new release that ships an unchanged wrapper
    // adds a tag without adding a wrapper and must not fail this check at the next checkout.
    let drift;
    try { drift = historyDrift(readWrapperHistory(ROOT), derived); } catch (error) { console.error(`[wrapper-history] ${error.message}`); return 1; }
    if (!drift.missing.length && !drift.extra.length) {
      console.log(`${HISTORY_FILE} carries exactly the wrappers git's release tags shipped (${derived.wrappers.length} wrapper(s), ${derived.releaseTags} tag(s))`);
      return 0;
    }
    console.error(`${HISTORY_FILE} differs from git: ${describeDrift(drift)}; run: node scripts/codex-hook-wrapper-history.mjs --write`);
    return 1;
  }
  console.error('usage: codex-hook-wrapper-history.mjs --write | --check');
  return 2;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
