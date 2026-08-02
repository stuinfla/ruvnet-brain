// lesson-presentation.mjs — pure selection and rendering for lesson-gate.
// The executable adapter owns I/O and consent state; this module turns its verified candidates into
// one bounded, deterministic presentation so hook and candidate modes cannot drift in wording.
import { ENFORCEMENT, TRIGGERS } from './lesson-store.mjs';

const ADVISORY_APPLICATION_CONTRACT = [
  'Your own recorded corrections apply at this moment. They are advisory: they do not refuse',
  "anything or override the user's current instruction or a safety boundary.",
  "Apply any relevant correction directly to the user's requested action.",
  'When a correction already provides the required form, do not replace the requested action with help, setup, status, or other discovery.',
  'When a correction supplies an exact Ruflo command, use it as the FIRST and ONLY Ruflo invocation.',
  'You must not prefix it with --help, --version, status, or any alternate Ruflo call.',
  'If you intentionally take another path, state why.',
];

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function renderLesson(lesson, mark) {
  const lines = [`  ${mark} ${lesson.statement}`];
  if (lesson.evidence?.[0]?.observed) lines.push(`      ${clip(String(lesson.evidence[0].observed), 150)}`);
  if (lesson.repeatCount >= 3) {
    lines.push(`      you have had to say this ${lesson.repeatCount} times across ${lesson.projects.length} project(s)`);
  }
  return lines.join('\n');
}

export function buildLessonPresentation({
  candidates,
  event,
  shownCount,
  isBlocking,
  triggers,
  optInPath,
  maxShows = 3,
  nudgeBudget = 1200,
}) {
  const capped = event
    ? candidates.filter((lesson) => isBlocking(lesson) || shownCount(lesson.id) < maxShows)
    : candidates;
  const ranked = [...capped].sort((a, b) => (b.repeatCount || 0) - (a.repeatCount || 0));

  // Give every distinct decision point one voice before any trigger receives a second.
  const seeded = [];
  const seededTriggers = new Set();
  for (const lesson of ranked) {
    if (seededTriggers.has(lesson.trigger)) continue;
    seededTriggers.add(lesson.trigger);
    seeded.push(lesson);
  }
  const order = [...seeded, ...ranked.filter((lesson) => !seeded.includes(lesson))];

  const inForce = [];
  let spent = 0;
  for (const lesson of order) {
    const cost = renderLesson(lesson, '·').length;
    if (inForce.length && spent + cost > nudgeBudget) continue;
    inForce.push(lesson);
    spent += cost;
  }

  const represented = new Set(inForce.map((lesson) => lesson.trigger));
  const compactExtras = seeded.filter((lesson) => !represented.has(lesson.trigger));
  const trimmed = capped.length - inForce.length;
  const blocking = inForce.filter(isBlocking);
  const blockCapable = inForce.filter((lesson) => !isBlocking(lesson)
    && (lesson.enforcement === ENFORCEMENT.BLOCK || lesson.intendedEnforcement === ENFORCEMENT.BLOCK));

  const lines = [''];
  const label = Object.values(TRIGGERS).find((trigger) => trigger.key === triggers[0])?.label || triggers.join(', ');
  lines.push(`  ⚑ ${blocking.length ? 'BLOCKED' : 'Before you continue'} — you are ${label}.`, '');
  for (const lesson of inForce) lines.push(renderLesson(lesson, isBlocking(lesson) ? '⛔' : '·'), '');
  if (compactExtras.length) {
    lines.push('  Also live at this moment:');
    for (const lesson of compactExtras) lines.push(`  · ${clip(String(lesson.statement), 150)}`);
    lines.push('');
  }
  if (trimmed > 0) {
    lines.push(`  (${trimmed} further lesson${trimmed === 1 ? '' : 's'} also applies here, trimmed to keep this short —`);
    lines.push('   see them all with: node scripts/lesson-ratify.mjs --list)', '');
  }
  if (blockCapable.length && !blocking.length) {
    lines.push(`  ${blockCapable.length} of these can REFUSE this action instead of mentioning it,`);
    lines.push('  if you want that. Entirely your call — nothing changes unless you add the id:');
    lines.push(`      ${optInPath}`, '');
  }
  const body = lines.join('\n');
  return {
    inForce,
    blocking,
    blockCapable,
    body,
    advisoryContext: [...ADVISORY_APPLICATION_CONTRACT, body].join('\n'),
  };
}
