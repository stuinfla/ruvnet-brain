#!/usr/bin/env node
// The answer gate (work package 8). Three commands:
//   gate.mjs --release <dir> --questions <dir> --out <file> [--answer <file>]
//       CI, every release candidate. Layer 1 (retrieval, no model) is measured on the staged bytes;
//       a layer 2 result, when given, is only verified. Writes the contract's gate-result file, bound
//       to this release.json's sha256 and pack generation, which `rail.mjs promote` requires.
//   gate.mjs answer --release <dir> --questions <dir> --out <file> [--runs N]
//       The maintainer's machine only: layer 2 through the commands named in
//       RUVNET_BRAIN5_GATE_ANSWER_CMD and RUVNET_BRAIN5_GATE_JUDGE_CMD (see answer.mjs).
//   gate.mjs hash --questions <dir>
//       Prints a question set's hash, the value the owner pins in packages/release/rail.json
//       (answerGate.questionSetSha256) when the set is frozen.
// The question set always comes from a folder outside the repository. Pass rule: layer 1 passes, the
// set is the pinned one, and layer 2 is verified and meets the set's thresholds when the set requires
// it (until then its absence is reported, not fatal; a file that is given and does not bind fails).
// Exit 0 passed, 1 refused or failed (one plain sentence on stderr), 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, readJson } from '../../contract/home.mjs';
import { problems as schemaProblems } from '../../contract/validate.mjs';
import { RAIL, Refused } from '../checks.mjs';
import { answerLayer, roles, writeResult } from './answer.mjs';
import { canonicalSha, loadSet, pinProblem } from './question-set.mjs';
import { installRelease, packFiles, retrievalLayer } from './retrieval.mjs';
import { verifyAnswer } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(HERE, '..', '..');
const REPO = path.resolve(PACKAGES, '..');
const USAGE = 'usage: node packages/release/gate/gate.mjs [answer|hash] --release <dir> --questions <dir> --out <file> [--answer <file>] [--runs N]';

class UsageError extends Error {}

/** The release gate as CI runs it. Returns { result, lines }. */
export async function releaseGate({ releaseDir, questionsDir, answerFile, now = Date.now() }) {
  const set = loadSet(questionsDir, REPO);
  const pin = pinProblem(RAIL.answerGate?.questionSetSha256 ?? '', set);
  const l1 = await retrievalLayer({ packagesDir: PACKAGES, releaseDir, set });
  const l2 = set.manifest.layer2;
  let answer = { given: false, bound: false, met: false, problems: [], shortfalls: [], summary: null };
  if (answerFile) {
    if (!fs.existsSync(answerFile)) throw new Refused(`the answer-gate result ${answerFile} does not exist`);
    answer = verifyAnswer(readJson(answerFile, null), { sha256: l1.sha256, generation: l1.release.pack.generation, set, now });
  }
  const why = [];
  if (pin) why.push(pin);
  if (!l1.ok) why.push(...l1.problems);
  if (answer.given && !answer.bound) why.push(`the answer-gate result does not bind to this release: ${answer.problems[0]}`);
  else if (answer.given && l2.required && !answer.met) why.push(`answer level below the set's thresholds: ${answer.shortfalls.join('; ')}`);
  else if (!answer.given && l2.required) why.push('the question set requires an answer-level result and none was given (--answer)');
  const answerState = !answer.given ? (l2.required ? 'missing (required)' : 'not given (not required by this question set)') : !answer.bound ? 'does not bind' : answer.met ? 'thresholds met' : `below thresholds${l2.required ? '' : ' (not required by this question set)'}`;
  const n = set.questions.length;
  const result = {
    schema: 'ruvnet-brain/gate-result',
    version: 1,
    release: l1.sha256,
    pack: l1.release.pack.generation,
    passed: why.length === 0,
    score: { hit: l1.hit, of: n },
    rule: `layer 1: ${l1.hit} of ${n} questions served a gold file (baseline ${l1.baseline.hit} of ${l1.baseline.of}, tolerance ${l1.tolerance}); hard checks on every result; probes ${l1.probes.passed} of ${l1.probes.of}; layer 2: ${answerState}; question set ${set.sha256}`,
    questionSet: { id: set.manifest.id, sha256: set.sha256, n, synthetic: set.manifest.synthetic, pinned: !pin },
    layers: {
      retrieval: { passed: l1.ok, hit: l1.hit, of: n, baseline: l1.baseline, tolerance: l1.tolerance, ceiling: l1.ceiling, probes: l1.probes, problems: l1.problems, questions: l1.questions },
      answer: { given: answer.given, required: l2.required, bound: answer.bound, met: answer.met, problems: answer.problems, shortfalls: answer.shortfalls, summary: answer.summary },
    },
    reasons: why,
  };
  result.resultSha256 = canonicalSha(result);
  result.at = new Date(now).toISOString();
  const bad = schemaProblems('gate-result', result);
  if (bad.length) throw new Refused(`the gate wrote a result the contract refuses (${bad[0]})`);
  const lines = [
    `answer gate ${result.passed ? 'PASSED' : 'FAILED'} · release.json sha256 ${result.release} · pack ${result.pack}`,
    `question set ${set.manifest.id} · sha256 ${set.sha256} · n=${n}${set.manifest.synthetic ? ' · synthetic' : ''}`,
    `layer 1 · ${l1.hit} of ${n} served a gold file (baseline ${l1.baseline.hit} of ${l1.baseline.of}, tolerance ${l1.tolerance}) · probes ${l1.probes.passed} of ${l1.probes.of} · ${l1.questions.filter((q) => q.problems.length).length} of ${n} results failed a hard check`,
    `layer 2 · ${answerState}${answer.summary ? ` · overall ${answer.summary.overall.success} of ${answer.summary.overall.n}` : ''}`,
    ...why.map((w) => `reason · ${w}`),
  ];
  return { result, lines };
}

/** Layer 2 on the maintainer's machine. Returns { result, lines }. */
export function answerGate({ releaseDir, questionsDir, runs }) {
  const roleArgv = roles();
  const set = loadSet(questionsDir, REPO);
  const inst = installRelease({ packagesDir: PACKAGES, releaseDir });
  try {
    const result = answerLayer({ inst, set, runs: runs ?? set.manifest.layer2.runs, roleArgv, known: packFiles(inst.packDir) });
    const c = result.content;
    const lines = [
      `answer level · question set ${set.manifest.id} · sha256 ${set.sha256} · ${c.runs} runs · release.json sha256 ${c.release}`,
      `judge calibration · ${c.calibration.withinOne} of ${c.calibration.n} within one point · ${c.calibration.plantedCapped} of ${c.calibration.planted} planted answers capped · ${c.calibration.passed ? 'passed' : 'FAILED'}`,
      ...Object.entries(c.groups).map(([g, m]) => `${g} · ${m.success} of ${m.n} (${m.share}, ${Math.round(m.confidence * 100)}% interval ${m.ci[0]} to ${m.ci[1]}) · set ${set.sha256.slice(0, 12)}`),
      ...(c.overall ? [`overall · ${c.overall.success} of ${c.overall.n} (${c.overall.share}, interval ${c.overall.ci[0]} to ${c.overall.ci[1]}) · set ${set.sha256.slice(0, 12)}`] : []),
    ];
    return { result, lines };
  } finally {
    inst.remove();
  }
}

export async function main(argv) {
  const cmd = ['answer', 'hash'].includes(argv[0]) ? argv[0] : 'release';
  const args = cmd === 'release' ? argv : argv.slice(1);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    return v;
  };
  const need = (name) => opt(name) ?? (() => { throw new UsageError(`--${name} is required`); })();
  const questions = opt('questions');
  if (cmd === 'hash') return { lines: [loadSet(questions && path.resolve(questions), REPO).sha256] };
  const releaseDir = path.resolve(need('release'));
  const out = path.resolve(need('out'));
  const r = cmd === 'answer'
    ? answerGate({ releaseDir, questionsDir: questions && path.resolve(questions), runs: opt('runs') === null ? null : Number(opt('runs')) })
    : await releaseGate({ releaseDir, questionsDir: questions && path.resolve(questions), answerFile: opt('answer') && path.resolve(opt('answer')) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeResult(out, r.result);
  const ok = cmd === 'answer' ? r.result.content.calibration.passed : r.result.passed;
  if (!ok) process.exitCode = 1;
  return { lines: [...r.lines, `wrote ${out}`] };
}

if (isMain(import.meta.url)) {
  try {
    const { lines } = await main(process.argv.slice(2));
    console.log(lines.join('\n'));
    if (process.exitCode === 1) console.error('refused: the gate did not pass; see the reasons above and the result file');
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(e instanceof Refused ? `refused: ${e.message}` : `failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
