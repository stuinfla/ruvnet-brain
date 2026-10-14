/**
 * Which project-state checkpoint is the newest — decided by the epoch-ms in the KEY, never by `ruflo memory list`
 * order, createdAt/updatedAt, semantic score or a list limit. Shared by the per-prompt recall
 * (agentdb-recall.mjs) and SessionStart restore (ruflo-memory-hooks.mjs). Pure: no I/O.
 */
import path from 'node:path';

/**
 * Namespaces that hold a project's checkpoints. `ruflo memory list -n` is case-sensitive, and owners write
 * both the dirname and its lowercase form (measured 2026-10-13: AppealArmor's newest checkpoints are all in
 * `appealarmor`), plus `default` when no -n was given.
 */
export function checkpointNamespaces(root) {
  const base = path.basename(root);
  return [...new Set([base, base.toLowerCase(), 'default'])];
}

const CHECKPOINT_KEY = /^project-state-(current|auto)-(\d{13})(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const MIN_CHECKPOINT_MS = Date.UTC(2020, 0, 1);
const FUTURE_SKEW_MS = 24 * 3600 * 1000;

/** The epoch-ms a checkpoint key carries ({family, ms}), or null for a key that cannot be ordered by time. */
export function checkpointMs(key, now = Date.now()) {
  const match = CHECKPOINT_KEY.exec(String(key));
  if (!match) return null;
  const ms = Number(match[2]);
  return ms >= MIN_CHECKPOINT_MS && ms <= now + FUTURE_SKEW_MS ? { family: match[1], ms } : null;
}

/** Newest key of one family ('current' | 'auto') across {namespace: keys[]}; ties go to the earlier namespace. */
export function newestOfFamily(keysByNamespace, namespaces, family, now = Date.now()) {
  let best = null;
  namespaces.forEach((namespace, rank) => {
    for (const key of keysByNamespace?.[namespace] ?? []) {
      const parsed = checkpointMs(key, now);
      if (!parsed || parsed.family !== family) continue;
      if (!best || parsed.ms > best.ms || parsed.ms === best.ms && rank === best.rank && key > best.key) best = { namespace, key, ms: parsed.ms, rank };
    }
  });
  return best && { namespace: best.namespace, key: best.key, ms: best.ms };
}

/** The newest curated project-state-current-*; an automatic project-state-auto-* only when no curated one exists. */
export function newestCheckpoint(keysByNamespace, namespaces, now = Date.now()) {
  return newestOfFamily(keysByNamespace, namespaces, 'current', now) ?? newestOfFamily(keysByNamespace, namespaces, 'auto', now);
}
