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
 */
import os from 'node:os';
import { loadLessons, saveLessons, ratify, demote, weightOf, pending, ENFORCEMENT, STATUS, ORIGIN, SOURCE_CLASS, TRIGGERS } from './lesson-store.mjs';

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (f) => argv.includes(f);

const lessons = loadLessons();
if (!lessons.length) {
  console.log('\n  No personal lessons stored yet. They appear after an explicit user correction is captured.\n');
  process.exit(0);
}

const FORCE = { block: '⛔ BLOCKS', checklist: '☑ checklist', inject: '· context', review: '👁 review only' };

function list() {
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

function show(next, id, verb) {
  const l = next.find((x) => x.id === id);
  if (!l) { console.log(`\n  No lesson with id "${id}". Run --list to see them.\n`); process.exit(1); }
  saveLessons(next);
  console.log(`\n  ✓ ${verb} ${l.id}`);
  console.log(`      now: ${FORCE[l.enforcement] || l.enforcement}${l.demoted ? '  (demoted — will never fire again, including after future mining runs)' : ''}`);
  console.log(`      stored at ${(process.env.RUVNET_LESSON_STORE || '~/.config/ruvnet-brain/lessons.json').replace(os.homedir(), '~')}\n`);
}

if (has('--ratify')) {
  const id = arg('--ratify');
  show(ratify(id, lessons), id, 'ratified');
} else if (has('--demote')) {
  const id = arg('--demote');
  show(demote(id, lessons), id, 'demoted');
} else if (has('--ratify-all-user-stated')) {
  // Bulk convenience, deliberately scoped: it can only touch lessons the USER stated. Model-inferred
  // lessons are never swept up by a bulk action — that would be exactly the hole the boundary closes.
  let next = lessons;
  const targets = lessons.filter((l) => l.origin === ORIGIN.USER_STATED
    && l.sourceClass === SOURCE_CLASS.CURRENT_USER
    && l.status === STATUS.CANDIDATE
    && !l.demoted);
  for (const l of targets) next = ratify(l.id, next);
  saveLessons(next);
  const nowBlocking = next.filter((l) => l.enforcement === ENFORCEMENT.BLOCK).length;
  console.log(`\n  ✓ ratified ${targets.length} lesson(s) you stated yourself.`);
  console.log(`      ${nowBlocking} now BLOCK at their decision point. Model-inferred lessons were left`);
  console.log(`      as candidates — a bulk action may never promote something the model inferred.\n`);
} else {
  list();
}
