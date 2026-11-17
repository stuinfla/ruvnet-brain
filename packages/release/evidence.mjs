// What promotion accepts as evidence (review F01). Promotion never takes a "passed" flag on trust:
//   gate      the result must name the pinned frozen question set, its hash must recompute, and its
//             decision is recomputed here from the recorded layers (count against the baseline, every
//             probe, every hard check, the answer layer when the set requires it); `passed` must agree.
//   receipts  one complete probe-receipt per required system: the contract schema, an installer and a
//             doctor that both exited 0, the staged release's app, pack and number, every probe the
//             staged pack ships asked and passed. In GitHub Actions each receipt must also come from
//             this workflow run on a runner of its own system (a receipt relabelled from another
//             runner, or carried in from another run, is refused).
// These are integrity checks: they refuse inconsistent, partial or relabelled evidence. They do not
// make a receipt unforgeable by someone who can write the workflow; that needs signed receipts.
import fs from 'node:fs';
import path from 'node:path';
import { problems } from '../contract/validate.mjs';
import { RAIL, Refused } from './checks.mjs';
import { canonicalSha } from './gate/question-set.mjs';

const RUNNER_OS = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };

/** Refuses unless the gate result passed, for exactly this release and pack, by the pinned set's rule. */
export function checkGate(gate, sha256, release, pin = RAIL.answerGate?.questionSetSha256 ?? '') {
  if (!gate) throw new Refused('the release has no answer-gate result; nothing is promoted without the gate');
  if (gate.schema !== 'ruvnet-brain/gate-result' || gate.version !== 1) throw new Refused('the answer-gate result is not a gate-result file this rail understands');
  if (gate.release !== sha256 || gate.pack !== release.pack.generation) throw new Refused('the answer-gate result is for different bytes than the staged release');
  if (!(Number.isInteger(gate.score?.of) && gate.score.of > 0 && Number.isInteger(gate.score?.hit))) throw new Refused('the answer-gate result carries no score');
  const bad = problems('gate-result', gate);
  if (bad.length) throw new Refused(`the answer-gate result is not a gate-result file this rail understands (${bad[0]})`);
  if (gate.passed !== true) throw new Refused(`the answer gate did not pass (${gate.score.hit} of ${gate.score.of}${gate.rule ? `, rule: ${gate.rule}` : ''})`);
  const why = gateProblems(gate, pin);
  if (why.length) throw new Refused(`the answer-gate result says passed but its own evidence does not (${why[0]})`);
}

/** Every reason the recorded evidence does not support `passed` (empty when it does). */
export function gateProblems(gate, pin) {
  const out = [];
  const qs = gate.questionSet;
  const l1 = gate.layers?.retrieval;
  const l2 = gate.layers?.answer;
  if (!pin) out.push('no frozen question set is pinned in packages/release/rail.json (answerGate.questionSetSha256)');
  if (!qs || !l1 || !l2) return [...out, 'it records no question set or no layers'];
  if (qs.sha256 !== pin || qs.pinned !== true) out.push(`question set ${qs.sha256} is not the pinned ${pin || '(none)'}`);
  const { resultSha256, at, ...body } = gate;
  if (!resultSha256 || canonicalSha(body) !== resultSha256) out.push('its resultSha256 does not match its content');
  if (Array.isArray(gate.reasons) ? gate.reasons.length : true) out.push('it lists reasons for failing');
  const n = qs.n;
  if (gate.score.of !== n || l1.of !== n || l1.questions.length !== n) out.push(`its counts disagree (score of ${gate.score.of}, layer 1 of ${l1.of}, ${l1.questions.length} questions, set n=${n})`);
  const hits = l1.questions.filter((q) => q.hit === true).length;
  if (gate.score.hit !== l1.hit || l1.hit !== hits) out.push(`its hit counts disagree (score ${gate.score.hit}, layer 1 ${l1.hit}, ${hits} questions marked hit)`);
  const base = l1.baseline;
  if (!(Number.isInteger(base?.hit) && Number.isInteger(l1.tolerance) && l1.tolerance >= 0)) out.push('layer 1 records no baseline or tolerance');
  else if (hits < base.hit - l1.tolerance) out.push(`${hits} of ${n} is below the baseline ${base.hit} by more than ${l1.tolerance}`);
  if (!(l1.probes?.of > 0 && l1.probes.passed === l1.probes.of)) out.push(`probes ${l1.probes?.passed} of ${l1.probes?.of}`);
  const hard = l1.questions.filter((q) => !Array.isArray(q.problems) || q.problems.length);
  if (hard.length) out.push(`${hard.length} served result(s) failed a hard check`);
  if (l1.passed !== true || l1.problems.length) out.push('layer 1 did not pass');
  if (l2.given && !l2.bound) out.push('the answer-level result does not bind to this release');
  if (l2.required && !(l2.given && l2.bound && l2.met)) out.push('the set requires answer-level results that are missing or below its thresholds');
  return out;
}

/** The probes the staged pack ships (what every receipt must have asked and passed). */
export function stagedProbes(stagedDir) {
  const f = path.join(stagedDir, 'pack', 'PROBES.json');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).probes ?? [];
  } catch {
    throw new Refused('the staged release holds no readable pack/PROBES.json');
  }
}

/** Refuses unless every required system has a complete, passing receipt for exactly these bytes. */
export function checkReceipts(receipts, sha256, release, probes, env = process.env) {
  if (!probes.length) throw new Refused('the staged pack ships no probes, so no receipt can prove a search');
  const ci = env.GITHUB_ACTIONS === 'true' ? env.GITHUB_RUN_ID : null;
  for (const os of RAIL.requiredOs) {
    const mine = receipts.filter((x) => x?.os === os && x.release === sha256);
    if (!mine.length) throw new Refused(`there is no install-and-probe receipt from ${os} for these bytes`);
    if (mine.length > 1) throw new Refused(`there are ${mine.length} receipts from ${os} for these bytes; exactly one is accepted`);
    const r = mine[0];
    if (r.ok !== true) throw new Refused(`the install-and-probe check failed on ${os} (${r.error ?? 'not ok'})`);
    const bad = problems('probe-receipt', r);
    const why = bad.length ? `it is not a complete probe-receipt (${bad[0]})`
      : r.error !== null ? `it records an error (${r.error})`
      : r.install?.exit !== 0 ? 'its installer did not exit 0'
      : r.doctor?.exit !== 0 ? 'its doctor did not exit 0'
      : r.app !== release.app.version || r.pack !== release.pack.generation || r.releaseNumber !== release.releaseNumber ? 'it names a different app, pack or release number'
      : probes.find((p) => !r.probes.some((x) => x.question === p.question && x.expect === p.expect && x.pass === true)) ? 'it does not show every probe of the staged pack passing'
      : ci && (r.ci?.runId !== ci || r.ci?.runnerOs !== RUNNER_OS[os]) ? `it was not written by this workflow run on a ${RUNNER_OS[os]} runner`
      : null;
    if (why) throw new Refused(`the install-and-probe receipt from ${os} is not evidence of a passed check: ${why}`);
  }
}
