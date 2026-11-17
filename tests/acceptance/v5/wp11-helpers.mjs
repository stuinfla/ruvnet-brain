// Work package 11 (generated documents) test helpers: a scratch tree that also holds the committed
// generated documents and the files the parity data names as evidence, and the generator run on it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

export const DOCS = ['docs/RECIPE.md', 'docs/v5/REFERENCE.md', 'docs/v5/PARITY.md'];

/** A scratch tree with the committed documents and the parity evidence copied in. */
export function docsTree(ctx, opts) {
  const tree = ctx.tree(opts);
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(tree.root, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tree.root, rel));
  };
  for (const d of DOCS) copy(d);
  const parity = JSON.parse(fs.readFileSync(path.join(tree.root, 'packages', 'docs', 'parity.json'), 'utf8'));
  for (const e of new Set(parity.rows.flatMap((r) => r.evidence ?? []))) if (!fs.existsSync(path.join(tree.root, e))) copy(e);
  return tree;
}

/** Runs the generator on a tree: generate.mjs [--check] --root <tree>. */
export function gen(tree, ...args) {
  const r = spawnSync(process.execPath, [path.join(tree.root, 'packages', 'docs', 'generate.mjs'), ...args, '--root', tree.root], { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

export const doc = (tree, rel) => fs.readFileSync(path.join(tree.root, rel), 'utf8');
export const editJson = (file, change) => fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
