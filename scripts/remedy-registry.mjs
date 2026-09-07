// remedy-registry.mjs — ONE object per recommendation id, owning detector ⇄ executor ⇄ inverse.
//
// WHY THIS EXISTS. Before this file, a recommendation's id, the code that ran it, and the code that
// reversed it lived in three different places that nothing forced to agree. All three drifted, and
// every drift was invisible until someone clicked the button:
//
//   1. `learning:enable-fleet` was constructed, validated, and offered — with NO executor at all.
//      It fell through apply()'s if/else to `Unknown recommendation id`. The single most important
//      recommendation in the product (ADR-027's North Star case) was a dead button.
//   2. `repair:memory-index` journalled `kind:'restore-memory-backup'`, and undo() had no branch for
//      it. It hit the default arm and reported "nothing to undo (the change reverses itself
//      automatically)" — while the recommendation had promised "restore the backup taken immediately
//      before the repair." The undo did not exist. The promise was a lie.
//   3. `repair:memory-index` also satisfies `startsWith('repair:')`, so ONE reordering of an if/else
//      chain silently routed a database repair into a global npm sync. That was caught by review,
//      but only by review — nothing structural prevented it.
//
// The common shape: a chain of `if (id.startsWith(...))` cannot be audited, because the set of ids
// it handles is not a value anything can inspect. So it becomes a value here. Each Remedy owns its
// id, the executor as DATA (not a spawn), and a DECLARED inverse. `assertRegistryClosure()` then
// proves, in a test, that every id the builders can construct resolves to exactly one remedy with a
// real undo handler behind it — so a dead button fails CI instead of failing a user.
//
// PURITY: no I/O, no spawn, no fs — same discipline as console-engine.mjs (DDD context 4). A remedy
// RETURNS a description of what to run; onboarding-console.mjs is the only thing that runs it. That
// is what lets the closure test check every path without touching the machine.

// ── Undo kinds ───────────────────────────────────────────────────────────────────────────────────
// The set of inverses the console can actually perform. A remedy may not name a kind outside this
// set, and every kind here MUST have a live branch in onboarding-console.undo(). Both directions are
// enforced by test, because a missing branch does not throw — it silently returns "nothing to undo",
// which is the most dangerous possible answer: it reads like success.
//
// NONE is a real, declared value, not an absence. "This genuinely has no inverse" and "nobody wrote
// one" must never look the same, which is exactly the bug that made #2 above invisible.
export const UNDO_KINDS = Object.freeze({
  NONE: 'none',
  REINSTALL_VERSION: 'reinstall-version',
  RESTORE_BACKUP: 'restore-backup',
  RESTORE_MEMORY_BACKUP: 'restore-memory-backup',
  RESTORE_STORE_BACKUPS: 'restore-store-backups',
  AUTO_REBUILD: 'auto-rebuild',
  // distill-project.mjs's OWN `--restore` (see its header: a tested inverse, not a re-implementation
  // of one). Distinct from RESTORE_MEMORY_BACKUP/RESTORE_STORE_BACKUPS because those restore backups
  // *this server* located and named; this one hands the restore entirely to the same script that took
  // the snapshot, which already knows where its own backups live.
  RESTORE_PROJECT_DISTILL: 'restore-project-distill',
});
const K = UNDO_KINDS;

// Ids that are exact, reserved words. A parameterized matcher (`repair:<pkg>`) must never capture
// one of these — see the ambiguity throw in resolveRemedy().
const RESERVED = new Set(['repair:memory-index', 'purge:shadows']);

// ── The registry ─────────────────────────────────────────────────────────────────────────────────
// match(id)   → params object if this remedy owns the id, else null.
// plan(p)     → { script, args } — the executor, as data.
// inverse(p)  → { kind, ...params } — journalled BEFORE the change is made.
export const REMEDIES = [
  {
    key: 'memory-index',
    autoEligible: true,
    summary: 'REINDEX a corrupt AgentDB store',
    match: (id) => (id === 'repair:memory-index' ? {} : null),
    plan: () => ({ script: 'scripts/health-repair.mjs', args: ['--repair-memory'] }),
    // health-repair.mjs takes an sqlite `.backup` of the store immediately before REINDEX (never a
    // cp — that silently truncates a live WAL database, a standing lesson proven by experiment).
    // The inverse is restoring it. This is the branch whose absence made the promise a lie.
    inverse: () => ({ kind: K.RESTORE_MEMORY_BACKUP }),
  },
  {
    key: 'learning-flush',
    summary: 'drain the capture queue into the learner',
    match: (id) => (id === 'learning:flush' ? {} : null),
    plan: () => ({ script: 'scripts/health-repair.mjs', args: ['--flush-learning'] }),
    // Genuinely additive: it moves already-captured local events into the learner. Declared NONE on
    // purpose, and the human string says what a user would actually do instead.
    inverse: () => ({ kind: K.NONE, human: 'nothing to reverse — this only adds observations the learner already had queued; learned state can be reset separately' }),
  },
  {
    key: 'learning-train',
    summary: 'run one training cycle',
    match: (id) => (id === 'learning:train' ? {} : null),
    plan: () => ({ script: 'scripts/health-repair.mjs', args: ['--train-learning'] }),
    inverse: () => ({ kind: K.NONE, human: 'nothing to reverse here — learned state is reset with `ruflo hooks intelligence --reset`, which is a separate, deliberate action' }),
  },
  {
    // THE ONE THAT HAD NO EXECUTOR. See ADR-027's North Star case: stores full of memories that
    // teach nothing. The remedy is not ours to invent — memory-doctor.mjs has printed the exact fix
    // since the day it was written ("embedded but never distilled — run: ruflo memory distill run"),
    // and the console simply never said it out loud. This wires that sentence to a button.
    key: 'distill-fleet',
    summary: 'distill embedded-but-never-distilled stores into reusable patterns',
    match: (id) => (id === 'learning:distill-fleet' ? {} : null),
    // needsReceipt: this remedy touches a SET of stores discovered at run time, so the inverse
    // cannot be described up front. The executor writes down exactly which stores it snapshotted
    // and where; the inverse reads that receipt. Without it, "restore the backups" would be a hope
    // rather than an instruction — and a hope is what made the memory-index undo a lie.
    plan: () => ({ script: 'scripts/health-repair.mjs', args: ['--distill-fleet'], needsReceipt: true }),
    // Distillation WRITES (reasoning_patterns, episodes, causal_edges), so it needs a real inverse.
    // health-repair snapshots each store with `ruflo memory backup` (rUv's own WAL-safe, rotated
    // snapshotter) before distilling it; the inverse restores those snapshots.
    inverse: () => ({ kind: K.RESTORE_STORE_BACKUPS }),
  },
  {
    // Retained for explicit execution and existing receipts, not offered as reversible.
    // The restore command refuses unsafe replacement; historical roundtrips do not authorize it.
    key: 'enable-memory-distillation',
    autoEligible: false,
    summary: "mine this project's stored memories into reusable patterns (snapshots first; automatic undo unavailable)",
    match: (id) => (id === 'enable:memory-distillation' ? {} : null),
    // This console instance is always scoped to ONE project — the directory it was started in — the
    // same assumption the memory-index/learning-flush/learning-train remedies above already make.
    // `usesServerProject` asks onboarding-console.mjs (impure, process-aware) to supply that directory
    // at call time; this file stays pure and never reads process.cwd() itself (see header).
    plan: () => ({ script: 'scripts/distill-project.mjs', args: [], usesServerProject: true }),
    inverse: () => ({ kind: K.RESTORE_PROJECT_DISTILL, available: false,
      human: 'automatic undo is unavailable; retain the snapshot and coordinate offline SQLite recovery with all database users stopped' }),
  },
  {
    key: 'stack-sync',
    summary: 'install/repair a global package to its target version',
    match: (id) => {
      if (RESERVED.has(id)) return null; // `repair:memory-index` is NOT a package repair
      const m = /^(?:sync|repair):(.+)$/.exec(id);
      return m ? { pkg: m[1] } : null;
    },
    plan: () => ({ script: 'scripts/stack-sync.mjs', args: ['--sync'] }),
    // The inverse of a version bump is the version that was on disk a moment ago — which only the
    // caller can read, so it is filled in at journal time. Declaring it here is what makes the
    // closure test able to check that undo() can honour it.
    inverse: ({ pkg }) => ({ kind: K.REINSTALL_VERSION, pkg }),
  },
  {
    key: 'purge-shadows',
    summary: 'delete stale duplicate copies from the npx cache',
    match: (id) => (id === 'purge:shadows' ? {} : null),
    plan: () => ({ script: 'scripts/stack-sync.mjs', args: ['--sync'] }),
    inverse: () => ({ kind: K.AUTO_REBUILD, human: 'the temporary cache re-fills itself on next use; no manual step needed' }),
  },
  {
    key: 'reconcile-project',
    autoEligible: true,
    summary: 'rewire a project from npx to the global binary',
    match: (id) => {
      const m = /^reconcile:(.+)$/.exec(id);
      return m ? { project: m[1] } : null;
    },
    plan: ({ project }) => ({ script: 'scripts/reconcile-project.mjs', args: ['--apply', '--project', project], resolveProject: true }),
    inverse: ({ project }) => ({ kind: K.RESTORE_BACKUP, project }),
  },
];

/**
 * Resolve an id to EXACTLY ONE remedy.
 *
 * Ambiguity throws rather than picking a winner. Silently preferring the first match is precisely
 * how `repair:memory-index` once routed into a global npm sync while telling the user their database
 * had been repaired — a wrong action reported as the right one. A throw is a loud developer error;
 * a silent misroute is a user's data.
 */
export function resolveRemedy(id) {
  const hits = [];
  for (const r of REMEDIES) {
    const params = r.match(id);
    if (params) hits.push({ remedy: r, params });
  }
  if (hits.length > 1) {
    throw new Error(`Remedy id "${id}" is ambiguous — claimed by: ${hits.map((h) => h.remedy.key).join(', ')}. Exactly one remedy must own an id.`);
  }
  return hits[0] ?? null;
}

/** The full plan for an id: what to run, and what reverses it. Null when nothing owns the id. */
export function planFor(id) {
  const hit = resolveRemedy(id);
  if (!hit) return null;
  const { remedy, params } = hit;
  return {
    key: remedy.key,
    summary: remedy.summary,
    autoEligible: remedy.autoEligible === true,
    exec: remedy.plan(params),
    undo: remedy.inverse(params),
    params,
  };
}

/**
 * THE CLOSURE PROOF. Every id that can be OFFERED must be runnable and reversible.
 *
 * Takes the ids the recommendation builders actually constructed (never a hand-typed list — a
 * hand-typed list drifts from the builders, which is the whole failure mode) plus the undo kinds
 * onboarding-console.undo() implements, and returns every gap it finds.
 *
 * @param {string[]} offeredIds  ids from buildHealth/Stack/WiringRecommendations
 * @param {string[]} handledUndoKinds  kinds undo() has a real branch for
 * @returns {{orphanIds:string[], ambiguousIds:string[], unhandledUndoKinds:string[], deadKinds:string[]}}
 */
export function assertRegistryClosure(offeredIds = [], handledUndoKinds = []) {
  const orphanIds = [];
  const ambiguousIds = [];
  const unhandledUndoKinds = [];
  const handled = new Set(handledUndoKinds);
  const usedKinds = new Set();

  for (const id of offeredIds) {
    let plan = null;
    try { plan = planFor(id); } catch { ambiguousIds.push(id); continue; }
    if (!plan) { orphanIds.push(id); continue; } // offered with no executor — the dead-button bug
    usedKinds.add(plan.undo.kind);
    // NONE is self-handling by definition, but it must still be DECLARED (see UNDO_KINDS).
    if (plan.undo.kind !== K.NONE && !handled.has(plan.undo.kind)) unhandledUndoKinds.push(`${id} → ${plan.undo.kind}`);
  }

  // The other direction: a kind the registry declares that undo() cannot perform is a broken promise
  // waiting to happen, even if no builder currently emits that id.
  const declared = new Set();
  for (const r of REMEDIES) {
    try { declared.add(r.inverse(r.match(sampleIdFor(r)) || {}).kind); } catch { /* sampling is best-effort */ }
  }
  const deadKinds = [...declared].filter((k) => k !== K.NONE && !handled.has(k));

  return { orphanIds, ambiguousIds, unhandledUndoKinds, deadKinds };
}

/** A representative id for each remedy, so closure can sample parameterized matchers too. */
export function sampleIdFor(remedy) {
  switch (remedy.key) {
    case 'memory-index': return 'repair:memory-index';
    case 'learning-flush': return 'learning:flush';
    case 'learning-train': return 'learning:train';
    case 'distill-fleet': return 'learning:distill-fleet';
    case 'enable-memory-distillation': return 'enable:memory-distillation';
    case 'stack-sync': return 'sync:ruflo';
    case 'purge-shadows': return 'purge:shadows';
    case 'reconcile-project': return 'reconcile:example';
    default: return `__unknown:${remedy.key}`;
  }
}
