// kb-build-identity.mjs — ONE answer to "which KB build is this directory right now?", for every
// in-process cache that must never outlive an update (forge-ask-all.mjs's router metadata index and
// identifier-lane.mjs's identifier scans). Extracted from forge-ask-all.mjs so identifier-lane.mjs
// can use it without an import cycle.
//
// An update swaps the whole kb/ directory under the same path; extracted files can carry archive
// mtimes, and a rewritten store can keep its byte size. So a per-file (mtime, size) key is not an
// identity, and a cache keyed only by the directory path is not one either. The build identity is
// the manifest.json stat (dev, inode, mtime, size) plus the manifest's own generated /
// generationTag / brainVersion stamp. Re-read only when that stat changes, so it costs one stat().
import fs from 'node:fs';
import path from 'node:path';

const _buildIdentity = new Map(); // dir -> { statKey, identity }

export function kbBuildIdentity(dir) {
  const file = path.join(dir, 'manifest.json');
  let stat;
  try { stat = fs.statSync(file); } catch { return `${path.resolve(dir)}|no-manifest`; }
  const statKey = `${stat.dev}:${stat.ino}|${stat.mtimeMs}|${stat.size}`;
  const cached = _buildIdentity.get(dir);
  if (cached?.statKey === statKey) return cached.identity;
  let stamp = 'unreadable';
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    stamp = `${manifest.generated || ''}|${manifest.corpus?.generationTag || ''}|${manifest.brainVersion || ''}`;
  } catch { /* the stat key alone still changes on any rewrite */ }
  const identity = `${path.resolve(dir)}|${statKey}|${stamp}`;
  _buildIdentity.set(dir, { statKey, identity });
  return identity;
}
