// What CI does with a layer 2 (answer-level) result: it never produces one, it only checks the file
// the maintainer produced. Binding problems (any of them) mean the file is not evidence for this
// release; the numbers are then read against the thresholds frozen in the question set's manifest.
import { problems as schemaProblems } from '../../contract/validate.mjs';
import { ANSWER_SCHEMA, ownersMeasure } from './answer.mjs';
import { canonical, canonicalSha } from './question-set.mjs';

const DAY = 86_400_000;

/**
 * Returns { given, bound, met, problems, shortfalls, summary }. `bound` is true only when the file is a
 * well-formed result for exactly this release, pack and question set, written by two different
 * commands, with a passed judge calibration, within the manifest's age limit. `met` is true when every
 * threshold in the manifest is reached.
 */
export function verifyAnswer(file, { sha256, generation, set, now = Date.now() }) {
  const l2 = set.manifest.layer2;
  const problems = [];
  const shortfalls = [];
  const c = file?.content;
  if (file?.schema !== ANSWER_SCHEMA || file.version !== 1 || !c || typeof c !== 'object') {
    return { given: true, bound: false, met: false, problems: ['it is not an answer-gate result this gate understands'], shortfalls, summary: null };
  }
  if (file.contentSha256 !== canonicalSha(c)) problems.push('its content does not match its contentSha256 (edited after it was written)');
  if (c.release !== sha256 || c.pack !== generation) problems.push('it is for different bytes than this release (release.json sha256 and pack generation)');
  if (c.questionSet?.sha256 !== set.sha256) problems.push(`it was measured on question set ${c.questionSet?.sha256 ?? 'none'}, not ${set.sha256}`);
  if (!c.calibration || typeof c.calibration !== 'object') problems.push('it carries no judge calibration record');
  else if (c.calibration.passed !== true) problems.push(`its judge did not pass calibration (${c.calibration.withinOne} of ${c.calibration.n} within one point; ${c.calibration.plantedCapped} of ${c.calibration.planted} planted answers capped)`);
  const roles = c.roles;
  if (!Array.isArray(roles?.answer) || !Array.isArray(roles?.judge)) problems.push('it does not record which command answered and which judged');
  else if (canonical(roles.answer) === canonical(roles.judge)) problems.push('the same command answered and judged');
  if (!(Number.isInteger(c.runs) && c.runs >= l2.runs)) problems.push(`it has ${c.runs} runs; the set requires ${l2.runs}`);
  const at = Date.parse(file.producedAt);
  if (!Number.isFinite(at)) problems.push('it carries no time it was produced');
  else if (now - at > l2.maxAgeDays * DAY) problems.push(`it is ${Math.floor((now - at) / DAY)} days old; the set allows ${l2.maxAgeDays}`);
  else if (at - now > 10 * 60_000) problems.push('it says it was produced in the future');
  const qs = Array.isArray(c.questions) ? c.questions : [];
  // The contract's answer-gate-result schema (contract 1.2): a file that binds must also have its shape.
  const shape = problems.length ? [] : schemaProblems('answer-gate-result', file);
  if (shape.length) problems.push(`it does not have the shape of an answer-gate result (${shape[0]})`);
  if (!problems.length) {
    const ids = set.questions.map((q) => q.id).join('\n');
    if (qs.map((q) => q.id).join('\n') !== ids || !qs.every((q) => Array.isArray(q.scores) && q.scores.length === c.runs)) problems.push('its per-question scores do not cover every question of the set in every run');
    else if (canonical(ownersMeasure(qs, l2, set.sha256)) !== canonical({ groups: c.groups, overall: c.overall })) problems.push("its owner's measure does not follow from its own scores");
  }
  if (!problems.length) {
    for (const [g, min] of Object.entries(l2.thresholds).sort()) {
      const m = c.groups[g];
      if (!m) shortfalls.push(`group ${g}: no result`);
      else if (m.share < min) shortfalls.push(`group ${g}: ${m.success} of ${m.n} (${m.share}) below the threshold ${min}`);
    }
  }
  const summary = problems.length ? null : { overall: c.overall, groups: c.groups, calibration: c.calibration, runs: c.runs, roles, producedAt: file.producedAt };
  return { given: true, bound: problems.length === 0, met: problems.length === 0 && shortfalls.length === 0, problems, shortfalls, summary };
}
