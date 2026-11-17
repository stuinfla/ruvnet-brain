// Writes PACK.json: every file in the pack with its role, size and hash. The manifest is the only
// definition of what a pack holds; roles are an open list.
import fs from 'node:fs';
import path from 'node:path';
import { isMain, listFiles, readJson, sha256, sha256File, writeJsonAtomic } from '../contract/home.mjs';

const ROLES = { 'lexical.db': 'lexical-db', 'PROBES.json': 'probes', 'RECIPE.json': 'recipe' };

/** meta: { recipeId, recipeHash, sources, counts, knowledgeDate }. Omitted on a re-assemble. */
export function assemble(packDir, meta = null) {
  const m = meta ?? readJson(path.join(packDir, 'PACK.json'));
  const files = listFiles(packDir)
    .filter((p) => p !== 'PACK.json')
    .map((p) => ({ path: p, role: ROLES[p] ?? 'data', size: fs.statSync(path.join(packDir, p)).size, sha256: sha256File(path.join(packDir, p)) }));
  const digest = sha256(m.recipeHash + files.map((f) => `${f.path}:${f.sha256}`).join('\n')).slice(0, 12);
  const pack = {
    schema: 'ruvnet-brain/pack',
    version: 1,
    generation: `g-${m.knowledgeDate}-${digest}`,
    builtAt: `${m.knowledgeDate}T00:00:00Z`,
    knowledgeDate: m.knowledgeDate,
    recipeId: m.recipeId,
    recipeHash: m.recipeHash,
    sources: m.sources,
    counts: m.counts,
    files,
  };
  writeJsonAtomic(path.join(packDir, 'PACK.json'), pack);
  return pack;
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node assemble.mjs <packDir>');
    process.exit(2);
  }
  console.log(assemble(path.resolve(dir)).generation);
}
