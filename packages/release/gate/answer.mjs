// Layer 2 of the answer gate: answer level. It needs a language model, so it NEVER runs in CI and
// never spends API money: the maintainer runs `gate.mjs answer` on their own machine, through two
// local commands they configure (no model is called from here, and no vendor is named):
//   RUVNET_BRAIN5_GATE_ANSWER_CMD   JSON list, the answering command; {home} and {launcher} are
//                                   replaced by the installed release's brain home and launcher, and
//                                   RUVNET_BRAIN5_HOME is set to that home
//   RUVNET_BRAIN5_GATE_JUDGE_CMD    JSON list, the blind judge
// Each command reads its prompt on standard input and writes its reply on standard output; the judge's
// reply must contain `SCORE: <0-10>`. The two commands must differ (the builder never grades its own
// work); both are recorded in the result as given.
//
// Rules applied in code (pre-registration R8): mechanical caps before any model grade (an answer citing
// no file, or a file the pack does not hold, at most 3; an answer stating a must-not-claim item at most
// 3, or 1 when it is in the answer's first line, its main recommendation); the judge counts only after
// it passes the seeded calibration set (at least minWithinOne within one point of the key, every planted
// answer capped); at least 3 runs; the owner's measure = share of questions graded passGrade or better
// in at least minRunsPassing runs, per asker group, with a seeded bootstrap interval.
// The result is deterministic given the same inputs: keys sorted, the time it was written kept outside
// the hashed part (`content`). It holds ids and grades, never question or answer text.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Refused } from '../checks.mjs';
import { canonical, canonicalSha } from './question-set.mjs';

export const ANSWER_SCHEMA = 'ruvnet-brain/answer-gate-result';
export const ENV = { answer: 'RUVNET_BRAIN5_GATE_ANSWER_CMD', judge: 'RUVNET_BRAIN5_GATE_JUDGE_CMD', timeout: 'RUVNET_BRAIN5_GATE_CALL_TIMEOUT_MS' };

/** Reads both command templates; refuses a missing one, or the same command in both roles. */
export function roles(env = process.env) {
  const read = (role) => {
    const raw = env[ENV[role]];
    if (!raw) throw new Refused(`${ENV[role]} is not set; it names the ${role} command as a JSON list, e.g. ["prog","--flag"]`);
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
    if (!Array.isArray(v) || !v.length || !v.every((s) => typeof s === 'string' && s.trim())) throw new Refused(`${ENV[role]} must be a JSON list of strings (program first)`);
    return v.map((s) => s.trim());
  };
  const r = { answer: read('answer'), judge: read('judge') };
  if (r.answer.join('\u0000').replace(/\s+/g, ' ') === r.judge.join('\u0000').replace(/\s+/g, ' ')) {
    throw new Refused('the judge command is the answer command; the builder never grades its own work, so a different judge must be configured');
  }
  return r;
}

function run(argv, input, vars, env) {
  const args = argv.map((a) => a.replace(/\{(home|launcher)\}/g, (_, k) => vars[k] ?? ''));
  const r = spawnSync(args[0], args.slice(1), { input, encoding: 'utf8', env, timeout: Number(env[ENV.timeout]) || 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Refused(`${args[0]} failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? '').trim().slice(-300)}`);
  return r.stdout ?? '';
}

export const answerPrompt = (q) => `${q.question}\n\nAnswer the question above using the RuvNet Brain search tool. Cite every file you rely on as repo/path.\n`;

export function judgePrompt(item, answer) {
  return [
    'You are grading one answer, blind: you are not told which system wrote it.',
    'Grade it from 0 to 10 for whether it answers the question correctly and usefully, using the reference files and the claims it must not make.',
    'Reply with your reasoning, then one final line: SCORE: <0-10>',
    '',
    `QUESTION:\n${item.question}`,
    `REFERENCE FILES:\n${item.gold.join('\n')}`,
    `MUST NOT CLAIM:\n${(item.mustNotClaim ?? []).join('\n') || '(none)'}`,
    `ANSWER:\n${answer}`,
    '',
  ].join('\n');
}

export function parseScore(text) {
  const all = [...String(text).matchAll(/SCORE:\s*(\d+(?:\.\d+)?)/gi)];
  const v = all.length ? Number(all.at(-1)[1]) : NaN;
  return v >= 0 && v <= 10 ? v : null;
}

/** File citations in an answer: repo/path tokens with a file name (extension) at the end. */
export function citations(answer) {
  const out = new Set();
  for (const m of String(answer).matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+/g)) out.add(m[0].replace(/^\.\//, ''));
  return [...out];
}

/** The mechanical caps (R8), applied before the judge's grade counts. Returns { cap, reasons }. */
export function caps(answer, item, known) {
  let cap = 10;
  const reasons = [];
  const cited = citations(answer);
  if (!cited.length) {
    cap = Math.min(cap, 3);
    reasons.push('no-citation');
  } else if (cited.some((c) => !known.has(c))) {
    cap = Math.min(cap, 3);
    reasons.push('unresolved-citation');
  }
  const low = String(answer).toLowerCase();
  const firstLine = (low.split('\n').find((l) => l.trim()) ?? '').trim();
  for (const claim of item.mustNotClaim ?? []) {
    const c = claim.toLowerCase();
    if (!low.includes(c)) continue;
    const main = firstLine.includes(c);
    cap = Math.min(cap, main ? 1 : 3);
    reasons.push(main ? 'false-claim-main' : 'false-claim');
  }
  return { cap, reasons: [...new Set(reasons)] };
}

function grade(judgeArgv, item, answer, known, env) {
  const raw = parseScore(run(judgeArgv, judgePrompt(item, answer), {}, env));
  if (raw === null) throw new Refused('the judge replied without a SCORE: <0-10> line');
  const c = caps(answer, item, known);
  return { raw, score: Math.min(raw, c.cap), caps: c.reasons };
}

/** The seeded calibration gate: the judge, after the caps, must reproduce the known scores. */
export function calibrate(judgeArgv, items, minWithinOne, known, env) {
  let withinOne = 0;
  let planted = 0;
  let plantedCapped = 0;
  for (const it of items) {
    const g = grade(judgeArgv, it, it.answer, known, env);
    if (Math.abs(g.score - it.key) <= 1) withinOne++;
    if (it.planted) {
      planted++;
      if (g.score <= 3) plantedCapped++;
    }
  }
  return { n: items.length, withinOne, minWithinOne, planted, plantedCapped, passed: withinOne >= minWithinOne && plantedCapped === planted };
}

function prng(seedHex) {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Share of successes with a percentile bootstrap interval over questions (seeded, so repeatable). */
export function measure(successes, { resamples, confidence }, seedHex) {
  const n = successes.length;
  const hit = successes.filter(Boolean).length;
  const rnd = prng(seedHex);
  const shares = [];
  for (let i = 0; i < resamples; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += successes[Math.floor(rnd() * n)] ? 1 : 0;
    shares.push(s / n);
  }
  shares.sort((x, y) => x - y);
  const tail = (1 - confidence) / 2;
  const at = (p) => shares[Math.min(resamples - 1, Math.max(0, Math.floor(p * resamples)))];
  const r4 = (v) => Math.round(v * 10_000) / 10_000;
  return { n, success: hit, share: r4(hit / n), ci: [r4(at(tail)), r4(at(1 - tail))], confidence, resamples };
}

/** The owner's measure per group and overall, from per-question scores. */
export function ownersMeasure(questions, l2, setSha) {
  const ok = (q) => q.scores.filter((s) => s >= l2.passGrade).length >= l2.minRunsPassing;
  const groups = {};
  for (const g of [...new Set(questions.map((q) => q.group))].sort()) groups[g] = measure(questions.filter((q) => q.group === g).map(ok), l2.bootstrap, canonicalSha({ setSha, g }));
  return { groups, overall: measure(questions.map(ok), l2.bootstrap, canonicalSha({ setSha, g: '*' })) };
}

/** Runs layer 2 against an installed release. Returns the result object (also when calibration fails). */
export function answerLayer({ inst, set, runs, roleArgv, known, env = process.env }) {
  const l2 = set.manifest.layer2;
  if (!Number.isInteger(runs) || runs < l2.runs) throw new Refused(`--runs ${runs} is below the ${l2.runs} runs the question set requires (no answer-level claim on fewer than 3)`);
  if (!set.calibration) throw new Refused('the question set has no calibration file; the judge cannot be trusted without one');
  const judgeEnv = { ...env };
  delete judgeEnv.RUVNET_BRAIN5_HOME;
  const calibration = calibrate(roleArgv.judge, set.calibration, l2.calibration.minWithinOne, known, judgeEnv);
  const content = {
    release: inst.sha256,
    pack: inst.release.pack.generation,
    questionSet: { id: set.manifest.id, sha256: set.sha256, n: set.questions.length },
    runs,
    passGrade: l2.passGrade,
    minRunsPassing: l2.minRunsPassing,
    roles: roleArgv,
    calibration,
    groups: {},
    overall: null,
    questions: [],
  };
  if (calibration.passed) {
    const answerEnv = { ...env, RUVNET_BRAIN5_HOME: inst.home };
    const vars = { home: inst.home, launcher: inst.launcher };
    content.questions = set.questions.map((q) => ({ id: q.id, group: q.group, scores: [], raw: [], caps: [] }));
    for (let r = 0; r < runs; r++) {
      set.questions.forEach((q, i) => {
        const g = grade(roleArgv.judge, q, run(roleArgv.answer, answerPrompt(q), vars, answerEnv), known, judgeEnv);
        content.questions[i].scores.push(g.score);
        content.questions[i].raw.push(g.raw);
        content.questions[i].caps.push(g.caps);
      });
    }
    Object.assign(content, ownersMeasure(content.questions, l2, set.sha256));
  }
  return { schema: ANSWER_SCHEMA, version: 1, content, contentSha256: canonicalSha(content), producedAt: new Date().toISOString() };
}

export const writeResult = (file, value) => fs.writeFileSync(file, `${canonical(value, 2)}\n`);
