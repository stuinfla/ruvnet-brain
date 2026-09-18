/** Explicit, user-reviewed recovery of concurrent progression heads. */
import { digestCanonical, planItemId, restoreProjectProgression } from './project-progression-contract.mjs';

function headSet(heads) {
  return heads.map((head) => ({ eventKey: head.eventKey, payloadDigest: head.payloadDigest }))
    .sort((a, b) => a.eventKey.localeCompare(b.eventKey));
}

function sameSet(left, right) {
  return JSON.stringify(headSet(left)) === JSON.stringify(headSet(right));
}

function readCurrent(store) {
  const keys = store.listSnapshotKeys();
  const exact = store.retrieveSnapshots(keys);
  if (exact.rejected?.length) throw new Error(`progression exact retrieval rejected ${exact.rejected.length} row(s)`);
  const restored = restoreProjectProgression(exact.snapshots, {
    expectedProjectIdentity: store.resolution.projectIdentity,
  });
  const hardRejected = restored.rejected.filter((row) => !row.reasons?.every((reason) => reason === 'causally stale'));
  if (hardRejected.length) throw new Error(`progression restore rejected ${hardRejected.length} row(s)`);
  if (!restored.ok) throw new Error('no coherent progression state could be restored');
  const byKey = new Map(exact.snapshots.map((row) => [row.eventKey, row]));
  const heads = restored.heads.map((key) => byKey.get(key)).filter(Boolean);
  return { keys, heads, restored, pendingReplay: store.pendingReplayCount() };
}

export function conflictDigest(conflict) {
  return digestCanonical({ field: conflict.field, values: conflict.values });
}

export function inspectReconciliation({ store }) {
  const current = readCurrent(store);
  return {
    mode: 'reconcile-inspect',
    expectedHeads: headSet(current.heads),
    conflicts: current.restored.state.resumeConflicts.map((conflict) => ({
      ...conflict, conflictDigest: conflictDigest(conflict),
    })),
    state: current.restored.state,
    pendingReplay: current.pendingReplay,
    structurallyEnumerated: current.keys.length,
  };
}

function dispositionFor(conflict, dispositions) {
  const digest = conflictDigest(conflict);
  const d = dispositions?.[digest];
  if (!d || typeof d !== 'object') throw new Error(`missing disposition for ${conflict.field} (${digest})`);
  if (d.conflictDigest !== digest) throw new Error(`stale disposition for ${conflict.field}`);
  return d;
}

function resolveConflicts(state, dispositions, heads) {
  const conflicts = state.resumeConflicts ?? [];
  const selectable = conflicts.filter((conflict) => !['sourceIdentity', 'provenance', 'evidence'].includes(conflict.field));
  const known = new Set(selectable.map(conflictDigest));
  for (const key of Object.keys(dispositions ?? {})) if (!known.has(key)) throw new Error(`unknown conflict disposition ${key}`);
  const resolved = { ...state, resumeConflicts: [] };
  const audit = {
    parents: headSet(heads),
    conflictDigests: conflicts.map(conflictDigest).sort(),
    dispositions: Object.fromEntries(Object.entries(dispositions ?? {}).sort()),
    resolvedBy: 'explicit-checkpoint',
  };
  resolved.evidence = { ...(state.evidence ?? {}), reconciliation: audit };
  resolved.provenance = {};
  const fields = new Set(heads.flatMap((head) => Object.keys(head.completeProjectState.provenance ?? {})));
  for (const field of fields) {
    const markers = heads.map((head) => head.completeProjectState.provenance?.[field] ?? null);
    resolved.provenance[field] = markers.every((marker) => digestCanonical(marker) === digestCanonical(markers[0]))
      ? markers[0] : { source: 'prior-head', authoritative: false, origins: [...new Set(markers.map((marker) => marker?.origin ?? marker?.source ?? 'unknown'))].sort() };
  }
  for (const conflict of selectable) {
    const d = dispositionFor(conflict, dispositions);
    if (conflict.field === 'changedFiles') throw new Error('mechanical field cannot be reconciled: changedFiles');
    const marker = { source: 'model-checkpoint', authoritative: false };
    if (d.action === 'select') {
      const option = conflict.values.find((row) => row.head === d.head);
      if (!option) throw new Error(`unknown selected head for ${conflict.field}`);
      if (conflict.field.startsWith('plan.')) {
        const id = conflict.field.slice(5);
        resolved.plan = resolved.plan.filter((item) => planItemId(item) !== id);
        if (option.value !== null) resolved.plan.push(option.value);
      } else resolved[conflict.field] = option.value;
      marker.selectedFrom = d.head;
      const origin = heads.find((head) => head.eventKey === d.head)?.completeProjectState.provenance?.[conflict.field];
      marker.origin = origin?.origin ?? origin?.source ?? 'unknown';
      resolved.provenance[conflict.field] = marker;
    } else if (d.action === 'replace') {
      if (!Object.prototype.hasOwnProperty.call(d, 'value')) throw new Error(`replacement value missing for ${conflict.field}`);
      if (conflict.field.startsWith('plan.')) {
        const id = conflict.field.slice(5);
        resolved.plan = resolved.plan.filter((item) => planItemId(item) !== id);
        if (d.value !== null) {
          if (planItemId(d.value) !== id) throw new Error(`replacement must preserve plan identity ${id}`);
          resolved.plan.push(d.value);
        }
      } else resolved[conflict.field] = d.value;
      resolved.provenance[conflict.field] = marker;
    } else if (d.action === 'clear') {
      if (conflict.field.startsWith('plan.')) {
        const id = conflict.field.slice(5);
        resolved.plan = resolved.plan.filter((item) => planItemId(item) !== id);
      } else resolved[conflict.field] = null;
      resolved.provenance[conflict.field] = marker;
    } else throw new Error(`unsupported disposition action for ${conflict.field}`);
  }
  // These are rebuilt from current mechanical observations and an audit reference by the
  // producer. Never carry merge sentinel nulls or synthetic journal heads into a new state.
  delete resolved.sourceIdentity;
  delete resolved.journalHeads;
  return resolved;
}

export function prepareReconciliation({ store, expectedHeads, dispositions = {} }) {
  const current = readCurrent(store);
  if (!Array.isArray(expectedHeads) || !sameSet(current.heads, expectedHeads)) {
    throw new Error('progression heads changed; inspect again before applying reconciliation');
  }
  const state = resolveConflicts(current.restored.state, dispositions, current.heads);
  const proposalDigest = digestCanonical({ expectedHeads: headSet(current.heads), dispositions, state });
  return { expectedHeads: headSet(current.heads), state, proposalDigest };
}

export { readCurrent };
