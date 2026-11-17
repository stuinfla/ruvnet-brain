// A frozen question set for the answer gate: its format, its hash, and where it may live.
//
// A question set is NEVER in the repository: the product indexes this repository, so a committed
// question (or its gold) would be found by search and contaminate every later measurement. The gate
// refuses a set folder, or any file in it, that resolves inside the checkout it runs from.
//
// Folder layout (every regular file in the folder is covered by the set's hash):
//   MANIFEST.json     the manifest below
//   <questions>       JSON list of { id, group, question, gold: ["repo/path", ...], mustNotClaim: [string] }
//   <calibration>     JSON list of { id, question, gold, mustNotClaim, answer, key (0-10), planted }
//                     where planted is null, "zero-citation", "unresolved-citation" or "false-claim"
//
// MANIFEST.json:
//   schema "ruvnet-brain/question-set", version 1, id (string), synthetic (boolean: true only for a
//   made-up test set), questions (file name), calibration (file name; required when layer2.required),
//   layer1: { baseline: { hit, of, measuredOn }, tolerance (questions, >= 0), delivery?: { maxChars, maxTokens } }
//   layer2: { required (boolean), runs (>= 3), passGrade (1-10), minRunsPassing (1..runs), maxAgeDays (> 0),
//             thresholds: { <group>: share 0..1 }, bootstrap: { resamples (>= 200), confidence (0.5..0.999) },
//             calibration: { minWithinOne } }
// Thresholds, baseline and tolerance are part of the hashed set, so they are fixed with the questions
// and can never be edited after a result without changing the hash the rail pins.
//
// The set's hash = sha256 of canonical JSON (keys sorted) of { files: { <relative path>: sha256 } }.
// MANIFEST.json is one of the files, so every number in it is covered.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Refused } from '../checks.mjs';

export const SET_SCHEMA = 'ruvnet-brain/question-set';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** JSON with every object's keys sorted, so the same value always gives the same bytes. */
export function canonical(value, indent = 0) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(value), null, indent || undefined);
}
export const canonicalSha = (value) => sha(canonical(value));

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Every entry under dir (files and links), refusing anything that resolves inside `repoRoot`. */
function walk(dir, repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const real = fs.realpathSync(dir);
  const refuse = (what) => {
    throw new Refused(`${what} is inside the repository (${root}); a question set is never kept in the repository the product indexes, so the gate refuses it`);
  };
  if (inside(real, root)) refuse(`the question set ${dir}`);
  const files = {};
  (function rec(rel) {
    for (const ent of fs.readdirSync(path.join(real, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const p = path.join(real, r);
      const target = fs.realpathSync(p);
      if (inside(target, root)) refuse(`question-set file ${r}`);
      const st = fs.statSync(target);
      if (st.isDirectory()) rec(r);
      else if (st.isFile()) files[r] = fs.readFileSync(target);
    }
  })('');
  return files;
}

const fail = (why) => {
  throw new Refused(`the question set is not one the gate understands: ${why}`);
};
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const isShare = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const isPath = (v) => typeof v === 'string' && /^[^/\s]+\/\S+$/.test(v);

function parse(files, name) {
  if (!files[name]) fail(`${name} is missing`);
  try {
    return JSON.parse(files[name].toString('utf8'));
  } catch (e) {
    fail(`${name} is not JSON (${e.message})`);
  }
}

function checkManifest(m) {
  if (m?.schema !== SET_SCHEMA || m.version !== 1) fail(`MANIFEST.json must say schema "${SET_SCHEMA}", version 1`);
  if (typeof m.id !== 'string' || !m.id) fail('MANIFEST.json needs an id');
  if (typeof m.synthetic !== 'boolean') fail('MANIFEST.json must say whether the set is synthetic');
  if (typeof m.questions !== 'string') fail('MANIFEST.json must name its questions file');
  const l1 = m.layer1;
  if (!l1 || !isInt(l1.baseline?.hit) || !isInt(l1.baseline?.of, 1) || l1.baseline.hit > l1.baseline.of) fail('layer1.baseline needs hit and of (the count the baseline served)');
  if (!isInt(l1.tolerance)) fail('layer1.tolerance must be a whole number of questions, 0 or more');
  if (l1.delivery && !(isInt(l1.delivery.maxChars, 1) && isInt(l1.delivery.maxTokens, 1))) fail('layer1.delivery needs maxChars and maxTokens');
  const l2 = m.layer2;
  if (!l2 || typeof l2.required !== 'boolean') fail('layer2.required must be true or false');
  if (!isInt(l2.runs, 3)) fail('layer2.runs must be at least 3 (no answer-level claim on fewer than 3 runs)');
  if (!isInt(l2.passGrade, 1) || l2.passGrade > 10) fail('layer2.passGrade must be 1 to 10');
  if (!isInt(l2.minRunsPassing, 1) || l2.minRunsPassing > l2.runs) fail('layer2.minRunsPassing must be 1 to runs');
  if (!(typeof l2.maxAgeDays === 'number' && l2.maxAgeDays > 0)) fail('layer2.maxAgeDays must be above 0');
  if (!l2.thresholds || typeof l2.thresholds !== 'object' || !Object.values(l2.thresholds).every(isShare)) fail('layer2.thresholds must map each asker group to a share from 0 to 1');
  if (!isInt(l2.bootstrap?.resamples, 200) || !(l2.bootstrap.confidence >= 0.5 && l2.bootstrap.confidence < 1)) fail('layer2.bootstrap needs resamples (>= 200) and confidence');
  if (!isInt(l2.calibration?.minWithinOne, 1)) fail('layer2.calibration.minWithinOne is required');
  if (l2.required && typeof m.calibration !== 'string') fail('a set that requires layer 2 must name its calibration file');
}

function checkQuestions(qs, m) {
  if (!Array.isArray(qs) || !qs.length) fail(`${m.questions} must be a non-empty list`);
  const ids = new Set();
  for (const q of qs) {
    if (typeof q?.id !== 'string' || !q.id || ids.has(q.id)) fail('every question needs a unique id');
    ids.add(q.id);
    if (typeof q.group !== 'string' || !q.group) fail(`question ${q.id} needs an asker group`);
    if (typeof q.question !== 'string' || !q.question.trim()) fail(`question ${q.id} has no text`);
    if (!Array.isArray(q.gold) || !q.gold.length || !q.gold.every(isPath)) fail(`question ${q.id} needs gold files as repo/path`);
    if (q.mustNotClaim !== undefined && !(Array.isArray(q.mustNotClaim) && q.mustNotClaim.every((s) => typeof s === 'string' && s.trim()))) fail(`question ${q.id} mustNotClaim must be a list of strings`);
  }
  if (m.layer1.baseline.of !== qs.length) fail(`layer1.baseline was recorded on ${m.layer1.baseline.of} questions but the set holds ${qs.length}`);
  for (const g of Object.keys(m.layer2.thresholds)) if (!qs.some((q) => q.group === g)) fail(`layer2.thresholds names group ${g}, which no question belongs to`);
}

const PLANTED = [null, 'zero-citation', 'unresolved-citation', 'false-claim'];
function checkCalibration(items, m) {
  if (!Array.isArray(items) || !items.length) fail(`${m.calibration} must be a non-empty list`);
  for (const c of items) {
    if (typeof c?.id !== 'string' || typeof c.question !== 'string' || typeof c.answer !== 'string') fail('every calibration item needs id, question and answer');
    if (!isInt(c.key) || c.key > 10) fail(`calibration item ${c.id} needs a key score 0 to 10`);
    if (!PLANTED.includes(c.planted ?? null)) fail(`calibration item ${c.id} planted must be one of ${PLANTED.join(', ')}`);
    if (!Array.isArray(c.gold) || !c.gold.every(isPath)) fail(`calibration item ${c.id} needs gold files as repo/path`);
  }
  const need = m.layer2.calibration.minWithinOne;
  // R8: 18 of 20 within one point. A set may hold more items, never a weaker share.
  if (need > items.length || need / items.length < 0.9) fail(`layer2.calibration.minWithinOne ${need} of ${items.length} is below 90% of the calibration set`);
}

/**
 * Reads and checks a question set. Refuses a folder in the repository, a malformed manifest or file.
 * Returns { dir, sha256, manifest, questions, calibration }.
 */
export function loadSet(dir, repoRoot) {
  if (!dir) throw new Refused('no question set was given (--questions <folder outside the repository>); the gate fails closed');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Refused(`the question set ${dir} is not a folder`);
  const files = walk(dir, repoRoot);
  const manifest = parse(files, 'MANIFEST.json');
  checkManifest(manifest);
  const questions = parse(files, manifest.questions);
  checkQuestions(questions, manifest);
  const calibration = manifest.calibration ? parse(files, manifest.calibration) : null;
  if (calibration) checkCalibration(calibration, manifest);
  const sha256 = canonicalSha({ files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha(b)])) });
  return { dir, sha256, manifest, questions: [...questions].sort((a, b) => (a.id < b.id ? -1 : 1)), calibration };
}

/** The rail's pin. Empty means no set has been frozen: the gate measures but never passes. */
export function pinProblem(pin, set) {
  if (!pin) return 'no frozen question set is pinned in packages/release/rail.json (answerGate.questionSetSha256); the gate fails closed';
  if (pin !== set.sha256) return `the question set's hash ${set.sha256} is not the pinned ${pin}`;
  return null;
}
