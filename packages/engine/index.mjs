// The engine (architecture 2.1): open, search, selfTest (and close, to release file handles).
// A pure function of (pack, query, options): it reads no environment variables, no settings and no
// folder other than the pack, and it writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../contract/validate.mjs';
import { SUPPORTED_RECIPE_VERSIONS } from '../contract/constants.mjs';
import { sha256 } from '../contract/home.mjs';
import * as lexical from './lanes/lexical.mjs';

const LANES = { lexical };

export function open(packDir) {
  const pack = check('pack', JSON.parse(fs.readFileSync(path.join(packDir, 'PACK.json'), 'utf8')), 'PACK.json');
  const recipeFile = pack.files.find((f) => f.role === 'recipe');
  if (!recipeFile) throw new Error('The pack carries no recipe, so it cannot be searched.');
  const recipeText = fs.readFileSync(path.join(packDir, recipeFile.path), 'utf8');
  const recipe = JSON.parse(recipeText);
  if (!SUPPORTED_RECIPE_VERSIONS.includes(recipe.version)) {
    throw new Error(`This pack was made with recipe version ${recipe.version}, which this engine does not understand.`);
  }
  check('recipe', recipe, 'RECIPE.json');
  if (sha256(recipeText) !== pack.recipeHash) throw new Error("The pack's recipe does not match its manifest.");
  for (const f of pack.files) {
    let size = -1;
    try {
      size = fs.statSync(path.join(packDir, f.path)).size;
    } catch {}
    if (size !== f.size) throw new Error(`Pack file ${f.path} is missing or has the wrong size.`);
  }
  const lanes = [];
  const handles = {};
  for (const spec of recipe.lanes) {
    try {
      if (!LANES[spec.name]) throw new Error('not supported by this engine');
      handles[spec.name] = LANES[spec.name].open(packDir, pack, recipe, spec);
      lanes.push({ name: spec.name, available: true });
    } catch (e) {
      if (!spec.optional) throw new Error(`Lane ${spec.name} could not open: ${e.message}`);
      lanes.push({ name: spec.name, available: false, reason: e.message });
    }
  }
  return { packDir, pack, recipe, lanes, handles };
}

export function close(h) {
  for (const [name, lane] of Object.entries(h.handles)) LANES[name].close(lane);
}

/** options: { detail: 'brief' | 'full', lanes?: [names] } */
export function search(h, query, options = {}) {
  const detail = options.detail === 'full' || options.detail === 'brief' ? options.detail : h.recipe.result.defaultDetail;
  const sections = h.recipe.sections.map((sec) => {
    const lane = h.handles[sec.lane];
    if (!lane || (options.lanes && !options.lanes.includes(sec.lane))) {
      return { name: sec.name, items: [], empty: { reason: `lane ${sec.lane} is not available` } };
    }
    const { items, emptyReason } = LANES[sec.lane].search(lane, String(query ?? ''), sec.maxItems);
    return { name: sec.name, items, empty: items.length ? null : { reason: emptyReason } };
  });
  return {
    schema: 'ruvnet-brain/result',
    version: 1,
    generation: h.pack.generation,
    knowledgeDate: h.pack.knowledgeDate,
    recipeId: h.recipe.id,
    detail,
    lanes: h.lanes,
    safeMode: { on: false, reason: null },
    sections,
  };
}

/** Runs the probes shipped in the pack. ok only when every probe finds its expected file. */
export function selfTest(h) {
  const probesFile = h.pack.files.find((f) => f.role === 'probes');
  if (!probesFile) return { ok: false, error: 'the pack ships no probes', results: [], lanes: h.lanes };
  const { probes } = JSON.parse(fs.readFileSync(path.join(h.packDir, probesFile.path), 'utf8'));
  const results = probes.map((p) => {
    const files = search(h, p.question).sections.flatMap((s) => s.items.map((i) => `${i.repo}/${i.path}`));
    return { question: p.question, expect: p.expect, pass: files.includes(p.expect), top: files[0] ?? null };
  });
  return { ok: results.length > 0 && results.every((r) => r.pass), results, lanes: h.lanes };
}
