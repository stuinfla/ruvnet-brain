// Work package 6 (release rail) test helpers. The rail is driven only through its command line,
// `packages/release/rail.mjs`, in a scratch copy of the tree (helpers.mjs `ctx.tree()`), with a key
// pair generated at test time. Workflow files are read from scratch copies so a break can patch them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BREAKS } from './breaks.mjs';
import { HOME_ENV, ROOT, THREE } from './helpers.mjs';
import { parseYaml } from './wp6-yaml.mjs';

export const REQUIRED_OS = ['linux', 'macos', 'windows'];
export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export const appVersion = (tree) => JSON.parse(fs.readFileSync(path.join(tree.root, 'packages', 'version.json'), 'utf8')).app;

/** Runs the rail's command line in the scratch tree. The signing key is the tree's unless `key` says otherwise. */
export function rail(tree, args, { key = tree.keys.privatePem, env = {} } = {}) {
  const e = { ...process.env, NODE_NO_WARNINGS: '1', [HOME_ENV]: path.join(os.tmpdir(), 'rb5-wp6-never-used'), ...env };
  delete e.RUVNET_BRAIN5_SIGNING_KEY;
  if (key) e.RUVNET_BRAIN5_SIGNING_KEY = key;
  // The rail binds receipts to a GitHub Actions run when it runs in one; a test says so explicitly.
  for (const k of ['GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'RUNNER_OS']) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [path.join(tree.root, 'packages', 'release', 'rail.mjs'), ...args], { encoding: 'utf8', timeout: 300_000, env: e, cwd: os.tmpdir() });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Builds the three fixture repositories and seals them through the rail. Returns { pack, rel, r }. */
export function sealed(ctx, tree, { number = 1, version = appVersion(tree), pack = null, extra = [] } = {}) {
  const p = pack ?? tree.build(THREE);
  pinFixtureSet(tree);
  const rel = path.join(ctx.tmp('rb5-wp6-rel-'), 'release');
  const r = rail(tree, ['seal', '--pack', p, '--out', rel, '--version', version, '--release-number', String(number), ...extra]);
  return { pack: p, rel, r };
}

// The question-set hash the promotion fixtures below name. sealed() pins it in the scratch tree's
// rail.json (unless a test pinned a real set), as the owner pins a frozen set.
export const FIXTURE_SET_SHA = 'f1'.repeat(32);
export function pinFixtureSet(tree, hash = FIXTURE_SET_SHA) {
  const f = path.join(tree.root, 'packages', 'release', 'rail.json');
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (r.answerGate?.questionSetSha256) return;
  r.answerGate = { ...r.answerGate, questionSetSha256: hash };
  fs.writeFileSync(f, JSON.stringify(r, null, 2));
}

const sortedSha = (v) => {
  const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return crypto.createHash('sha256').update(JSON.stringify(sort(v))).digest('hex');
};
/** Recomputes a gate result's resultSha256 as the gate does (a forger can do this too). */
export const rehash = (g) => {
  const { resultSha256, at, ...body } = g;
  return { ...body, resultSha256: sortedSha(body), at: at ?? new Date().toISOString() };
};

/**
 * A complete gate-result file for exactly the release in `relDir`, in the shape gate.mjs writes and
 * internally consistent (a promotion fixture: the real gate runs in wp6-06 and wp8). `layer` edits
 * the retrieval layer before the hash is computed.
 */
export function gateFor(relDir, { passed = true, hit = 5, of = 6, set = FIXTURE_SET_SHA, layer = {} } = {}) {
  const release = JSON.parse(fs.readFileSync(path.join(relDir, 'release.json'), 'utf8'));
  const questions = Array.from({ length: of }, (_, i) => ({ id: `q${i + 1}`, group: 'fixture', hit: i < hit, chars: 100, tokens: 25, problems: [] }));
  const retrieval = { passed, hit, of, baseline: { hit, of, measuredOn: 'fixture' }, tolerance: 0, ceiling: { maxChars: 44000, maxTokens: 20000 }, probes: { passed: 3, of: 3 }, problems: passed ? [] : ['fixture failure'], questions, ...layer };
  return rehash({
    schema: 'ruvnet-brain/gate-result', version: 1, release: sha256File(path.join(relDir, 'release.json')), pack: release.pack.generation, passed, score: { hit, of }, rule: 'fixture rule',
    questionSet: { id: 'fixture', sha256: set, n: of, synthetic: true, pinned: true },
    layers: { retrieval, answer: { given: false, required: false, bound: false, met: false, problems: [], shortfalls: [], summary: null } },
    reasons: passed ? [] : ['fixture failure'],
  });
}

/** One complete passing probe-receipt per required system for the staged release in `stagedDir`. */
export function receiptsFor(stagedDir, { ci = null } = {}) {
  const release = JSON.parse(fs.readFileSync(path.join(stagedDir, 'release.json'), 'utf8'));
  const probes = JSON.parse(fs.readFileSync(path.join(stagedDir, 'pack', 'PROBES.json'), 'utf8')).probes;
  const runner = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
  return REQUIRED_OS.map((os) => ({
    schema: 'ruvnet-brain/probe-receipt', version: 1, os, node: process.version, release: sha256File(path.join(stagedDir, 'release.json')), releaseNumber: release.releaseNumber, app: release.app.version, pack: release.pack.generation,
    install: { exit: 0, tail: 'installed' }, probes: probes.map((p) => ({ question: p.question, expect: p.expect, pass: true, mode: 'MODE · normal' })), doctor: { exit: 0, line: '[RuvNet Brain] OK' }, ok: true, error: null, at: new Date().toISOString(),
    ...(ci ? { ci: { runId: ci, runnerOs: runner[os] } } : {}),
  }));
}

/** Writes receipts (receiptsFor's, or the ones given) into a folder, one file per system. */
export function writeReceipts(dir, stagedDir, receipts = receiptsFor(stagedDir)) {
  for (const r of receipts) writeJson(path.join(dir, `${r.os}.json`), r);
  return dir;
}

export const writeJson = (file, v) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, JSON.stringify(v, null, 2)));

/**
 * The v5 workflow files, copied to a scratch folder with this test's break applied, each parsed.
 * Returns { dir, files: { name: { text, doc } } }.
 */
export function workflows(ctx, testId) {
  const src = path.join(ROOT, '.github', 'workflows');
  const dir = ctx.tmp('rb5-wp6-wf-');
  for (const f of fs.readdirSync(src).filter((x) => /^v5-.*\.yml$/.test(x))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  const brk = process.env.V5_BREAK && BREAKS[process.env.V5_BREAK];
  if (brk && (brk.test === testId || testId.startsWith(`${brk.test}-`))) {
    for (const pt of brk.patches) {
      const file = path.join(dir, path.basename(pt.file));
      const text = fs.readFileSync(file, 'utf8');
      if (text.split(pt.find).length !== 2) throw new Error(`patch anchor in ${pt.file} must match once`);
      fs.writeFileSync(file, text.replace(pt.find, () => pt.replace));
    }
  }
  const files = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    files[f] = { text, doc: parseYaml(text, f) };
  }
  return { dir, files };
}
