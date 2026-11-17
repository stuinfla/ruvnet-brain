// Work package 8 (answer gate) test helpers. The gate is driven only through its command line,
// `packages/release/gate/gate.mjs`, in a scratch copy of the tree (helpers.mjs `ctx.tree()`, which
// applies this test's break). The synthetic question set in wp8-fixtures/ is copied OUTSIDE the
// repository before every use, because the gate refuses a set kept inside it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, THREE } from './helpers.mjs';

export const FIXTURE_SET = path.join(ROOT, 'tests', 'acceptance', 'v5', 'wp8-fixtures', 'question-set');
export const STUBS = path.join(ROOT, 'tests', 'acceptance', 'v5', 'wp8-fixtures', 'stubs');
export const QUESTION_WORDS = ['brindlewort', 'gloamwick', 'tidewrack', 'thistledown', 'marrowlight', 'zephyrlattice'];
const GATE_ENV = ['RUVNET_BRAIN5_GATE_ANSWER_CMD', 'RUVNET_BRAIN5_GATE_JUDGE_CMD', 'RUVNET_BRAIN5_SIGNING_KEY'];

/** A copy of the synthetic set in a temporary folder; `mutate(manifest)` may change its manifest. */
export function questionSet(ctx, mutate = null, into = null) {
  const dir = into ?? path.join(ctx.tmp('rb5-wp8-set-'), 'set');
  fs.cpSync(FIXTURE_SET, dir, { recursive: true });
  if (mutate) {
    const f = path.join(dir, 'MANIFEST.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    mutate(m);
    fs.writeFileSync(f, JSON.stringify(m, null, 2));
  }
  return dir;
}

/** Runs the gate's command line in the scratch tree. */
export function gate(tree, args, env = {}) {
  const e = { ...process.env, NODE_NO_WARNINGS: '1', ...env };
  for (const k of GATE_ENV) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [path.join(tree.root, 'packages', 'release', 'gate', 'gate.mjs'), ...args], { encoding: 'utf8', timeout: 600_000, env: e, cwd: os.tmpdir() });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The set's hash as the gate computes it (what the owner pins). */
export function setHash(tree, dir) {
  const r = gate(tree, ['hash', '--questions', dir]);
  if (r.status !== 0) throw new Error(`gate hash failed: ${r.out}`);
  return r.stdout.trim();
}

/** Pins a question set's hash in the scratch tree's rail.json, as the owner does when a set is frozen. */
export function pin(tree, hash) {
  const f = path.join(tree.root, 'packages', 'release', 'rail.json');
  const rail = JSON.parse(fs.readFileSync(f, 'utf8'));
  rail.answerGate = { ...rail.answerGate, questionSetSha256: hash };
  fs.writeFileSync(f, JSON.stringify(rail, null, 2));
}

/** A sealed release of the fixture repositories built by the scratch tree. */
export const releaseOf = (tree, sources = THREE, opts = {}) => tree.release(tree.build(sources), opts);

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const outFile = (ctx, name = 'gate.json') => path.join(ctx.tmp('rb5-wp8-out-'), name);

/** The stub commands' environment: a state folder for their run counters and logs. */
export function stubEnv(ctx, { answer = null, judge = null } = {}) {
  const state = ctx.tmp('rb5-wp8-stub-');
  const a = answer ?? [process.execPath, path.join(STUBS, 'answer.mjs'), '--home', '{home}'];
  const j = judge ?? [process.execPath, path.join(STUBS, 'judge.mjs')];
  return { state, env: { WP8_STUB_STATE: state, RUVNET_BRAIN5_GATE_ANSWER_CMD: JSON.stringify(a), RUVNET_BRAIN5_GATE_JUDGE_CMD: JSON.stringify(j) } };
}

/** Asserts that no question text from the synthetic set appears in `text`. */
export function noQuestionText(text) {
  const qs = JSON.parse(fs.readFileSync(path.join(FIXTURE_SET, 'questions.json'), 'utf8'));
  return qs.filter((q) => text.includes(q.question) || QUESTION_WORDS.some((w) => q.question.includes(w) && text.includes(w))).map((q) => q.id);
}

/** sha256 of JSON with sorted keys: how an answer-gate result's content is hashed (re-implemented
 *  here so a test can play a forger who recomputes the hash after an edit). */
export function contentSha(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
