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
  const r = spawnSync(process.execPath, [path.join(tree.root, 'packages', 'release', 'rail.mjs'), ...args], { encoding: 'utf8', timeout: 300_000, env: e, cwd: os.tmpdir() });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Builds the three fixture repositories and seals them through the rail. Returns { pack, rel, r }. */
export function sealed(ctx, tree, { number = 1, version = appVersion(tree), pack = null, extra = [] } = {}) {
  const p = pack ?? tree.build(THREE);
  const rel = path.join(ctx.tmp('rb5-wp6-rel-'), 'release');
  const r = rail(tree, ['seal', '--pack', p, '--out', rel, '--version', version, '--release-number', String(number), ...extra]);
  return { pack: p, rel, r };
}

/** A gate-result file for exactly the release in `relDir` (the format work package 8 must write). */
export function gateFor(relDir, { passed = true, hit = 90, of = 100 } = {}) {
  const release = JSON.parse(fs.readFileSync(path.join(relDir, 'release.json'), 'utf8'));
  return { schema: 'ruvnet-brain/gate-result', version: 1, release: sha256File(path.join(relDir, 'release.json')), pack: release.pack.generation, passed, score: { hit, of }, rule: 'fixture rule', at: new Date().toISOString() };
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
