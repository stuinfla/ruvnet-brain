#!/usr/bin/env node
/**
 * lesson-ratify.mjs — the human control over what the machine is allowed to enforce.
 *
 * The owner's requirement, verbatim (2026-07-22): "I should be able to see them all at a global
 * level, and I should be able to go delete any ones on a global level that you thought were global
 * but are really project-based."
 *
 * That is not a nice-to-have. ADR-029's promotion bar is evidence-based but not infallible — a
 * keyword cluster can absolutely lift something local, and ADR-031's trust boundary exists because
 * an adversarial review found that a hallucinated session summary could otherwise reach the
 * objective function. A rule the user cannot see, audit, and delete is a rule imposed on them.
 *
 * Three verbs, and the asymmetry between them is the design:
 *
 *   --list            every lesson, its trigger, force, provenance, and evidence
 *   --ratify <id>     a human agrees: raise it to the enforcement it was proposed at
 *   --demote <id>     a human disagrees: it stops firing, PERMANENTLY
 *
 * Ratification is the ONLY path from candidate to enforcement, and `ratify()` refuses to raise a
 * model-inferred lesson to `block` no matter what is asked of it. If the model could ratify its own
 * inferences, the trust boundary would be a comment rather than a control.
 *
 * Demotion is STICKY — it survives every future mining run. A one-click reject that the next
 * nightly quietly undoes is worse than no control at all, because the user stops trusting it and,
 * correctly, stops using it.
 *
 * MUTATIONS GO THROUGH `updateLessons()`, NOT `loadLessons()` + `saveLessons()`. The earlier version
 * read `lessons` once at module load, then handed that same in-memory snapshot to `saveLessons()`
 * after transforming it — the exact unlocked read-modify-write `lesson-store.mjs`'s own header
 * documents destroying three ratified rules on 2026-07-22, and the exact race `updateLessons()` was
 * written to close. `saveLessons()` taking a lock around the WRITE never protected the READ that
 * preceded it: two ratify/demote invocations overlapping (a double-click, a script driving two calls
 * back to back) could both load the same pre-change snapshot, and the second writer's save would
 * silently discard the first writer's change — on the one file this CLI exists to make trustworthy.
 * `updateLessons()` holds the lock across read → transform → write, so a concurrent writer's change
 * is never lost.
 */
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadLessons, updateLessons, ratify, demote, weightOf, pending, ENFORCEMENT, STATUS, ORIGIN, SOURCE_CLASS, TRIGGERS } from './lesson-store.mjs';

const FORCE = { block: '⛔ BLOCKS', checklist: '☑ checklist', inject: '· context', review: '👁 review only' };

export function list(lessons) {
  const pend = pending(lessons);
  console.log(`\n  ${lessons.length} lessons — ${pend.length} awaiting your decision.\n`);
  console.log('  Nothing here refuses your work until YOU ratify it. The model does not get to');
  console.log('  ratify its own rules — that is the whole trust boundary.\n');

  for (const t of Object.values(TRIGGERS)) {
    const group = lessons.filter((l) => l.trigger === t.key);
    if (!group.length) continue;
    console.log(`  ▸ WHEN ${t.label}`);
    for (const l of group) {
      const now = FORCE[l.enforcement] || l.enforcement;
      const becomes = l.intendedEnforcement && l.intendedEnforcement !== l.enforcement
        ? ` → ${FORCE[l.intendedEnforcement]} once ratified` : '';
      const flag = l.demoted ? ' [DEMOTED — will never fire]' : '';
      const who = l.origin === ORIGIN.USER_STATED ? 'you said it' : `${l.origin} — quarantined, can never block`;
      console.log(`      ${l.id}${flag}`);
      console.log(`        ${l.statement.slice(0, 110)}${l.statement.length > 110 ? '…' : ''}`);
      console.log(`        ${now}${becomes}  ·  ${who}  ·  taught ${l.repeatCount}×  ·  weight ${weightOf(l)}`);
    }
    console.log('');
  }
  console.log('  node scripts/lesson-ratify.mjs --ratify <id>    # agree: let it enforce');
  console.log('  node scripts/lesson-ratify.mjs --demote <id>    # disagree: silence it for good');
  console.log('  node scripts/lesson-ratify.mjs --ratify-all-user-stated\n');
}

/**
 * Apply `mutate(id, lessons)` to the lesson `id`, holding the store lock across the read and the
 * write (via `updateLessons`) so a concurrent ratify/demote can never be read as stale and clobbered.
 * Returns the lesson's new state, or null if no lesson with `id` exists (the store is left untouched).
 */
export function applyMutation(id, mutate, file) {
  let result = null;
  updateLessons((fresh) => {
    if (!fresh.find((x) => x.id === id)) return fresh;
    const next = mutate(id, fresh);
    result = next.find((x) => x.id === id);
    return next;
  }, file);
  return result;
}

/**
 * Bulk convenience, deliberately scoped: it can only touch lessons the USER stated. Model-inferred
 * lessons are never swept up by a bulk action — that would be exactly the hole the boundary closes.
 * Also lock-protected end to end, for the same reason as `applyMutation`.
 */
export function applyRatifyAllUserStated(file) {
  let ratifiedIds = [];
  let nowBlocking = 0;
  updateLessons((fresh) => {
    const targets = fresh.filter((l) => l.origin === ORIGIN.USER_STATED
      && l.sourceClass === SOURCE_CLASS.CURRENT_USER
      && l.status === STATUS.CANDIDATE
      && !l.demoted);
    let next = fresh;
    for (const l of targets) next = ratify(l.id, next);
    ratifiedIds = targets.map((l) => l.id);
    nowBlocking = next.filter((l) => l.enforcement === ENFORCEMENT.BLOCK).length;
    return next;
  }, file);
  return { ratifiedCount: ratifiedIds.length, nowBlocking };
}

function printResult(result, id, verb) {
  if (!result) { console.log(`\n  No lesson with id "${id}". Run --list to see them.\n`); process.exit(1); }
  console.log(`\n  ✓ ${verb} ${result.id}`);
  console.log(`      now: ${FORCE[result.enforcement] || result.enforcement}${result.demoted ? '  (demoted — will never fire again, including after future mining runs)' : ''}`);
  console.log(`      stored at ${(process.env.RUVNET_LESSON_STORE || '~/.config/ruvnet-brain/lessons.json').replace(os.homedir(), '~')}\n`);
}

/** am I the entrypoint? — `fileURLToPath`, never `.pathname` (Windows); `realpathSync` guarded (vitest). */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntrypoint()) {
  const argv = process.argv.slice(2);
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const has = (f) => argv.includes(f);

  const lessons = loadLessons();
  if (!lessons.length) {
    console.log('\n  No personal lessons stored yet. They appear after an explicit user correction is captured.\n');
    process.exit(0);
  }

  if (has('--ratify')) {
    const id = arg('--ratify');
    printResult(applyMutation(id, ratify), id, 'ratified');
  } else if (has('--demote')) {
    const id = arg('--demote');
    printResult(applyMutation(id, demote), id, 'demoted');
  } else if (has('--ratify-all-user-stated')) {
    const { ratifiedCount, nowBlocking } = applyRatifyAllUserStated();
    console.log(`\n  ✓ ratified ${ratifiedCount} lesson(s) you stated yourself.`);
    console.log(`      ${nowBlocking} now BLOCK at their decision point. Model-inferred lessons were left`);
    console.log(`      as candidates — a bulk action may never promote something the model inferred.\n`);
  } else {
    list(lessons);
  }
}
