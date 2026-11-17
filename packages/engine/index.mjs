// The engine (architecture 2.1): open, search, selfTest (and close, to release file handles).
// A pure function of (pack, query, options): it reads no environment variables, no settings and no
// folder other than the pack, and it writes nothing.
// Lanes are plug-ins: the recipe names each lane, its kind and its pack file; KINDS maps a kind to
// its implementation ({ open, search, fileRows, close }). A new kind is one module and one row here;
// a new lane of an existing kind, and the section it fills, is recipe data only.
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../contract/validate.mjs';
import { SUPPORTED_RECIPE_VERSIONS } from '../contract/constants.mjs';
import { sha256 } from '../contract/home.mjs';
import { checkAnalyser } from './analyse.mjs';
import { AUTHORITY_ORDER, fit, holdToDelivery, publicItem, section } from './assemble.mjs';
import * as fts5 from './lanes/lexical.mjs';

const KINDS = { 'fts5-bm25': fts5 };
const roleOf = (spec) => spec.role ?? `${spec.name}-db`;

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
  checkAnalyser(recipe.analyser);
  if (sha256(recipeText) !== pack.recipeHash) throw new Error("The pack's recipe does not match its manifest.");
  const optionalRoles = new Set(recipe.lanes.filter((l) => l.optional).map(roleOf));
  const broken = new Map();
  for (const f of pack.files) {
    let size = -1;
    try {
      size = fs.statSync(path.join(packDir, f.path)).size;
    } catch {}
    if (size === f.size) continue;
    if (!optionalRoles.has(f.role)) throw new Error(`Pack file ${f.path} is missing or has the wrong size.`);
    broken.set(f.role, `pack file ${f.path} is missing or has the wrong size`);
  }
  const lanes = [];
  const handles = {};
  // An optional lane whose file the pack does not list is not in this pack (a pack built with no
  // history): not opened, not reported as an unavailable lane, and its section says so.
  const absent = new Set(recipe.lanes.filter((l) => l.optional && !pack.files.some((f) => f.role === roleOf(l))).map((l) => l.name));
  for (const spec of recipe.lanes) {
    if (absent.has(spec.name)) continue;
    try {
      if (broken.has(roleOf(spec))) throw new Error(broken.get(roleOf(spec)));
      if (!KINDS[spec.kind]) throw new Error(`lane kind ${spec.kind} is not supported by this engine`);
      handles[spec.name] = { impl: KINDS[spec.kind], lane: KINDS[spec.kind].open(packDir, pack, recipe, spec) };
      lanes.push({ name: spec.name, available: true });
    } catch (e) {
      if (!spec.optional) {
        for (const x of Object.values(handles)) x.impl.close(x.lane);
        throw new Error(`Lane ${spec.name} could not open: ${e.message}`);
      }
      lanes.push({ name: spec.name, available: false, reason: e.message });
    }
  }
  return { packDir, pack, recipe, lanes, handles, absent };
}

export function close(h) {
  for (const { impl, lane } of Object.values(h.handles)) impl.close(lane);
}

/** Normalised absolute folder, for comparing projects: symbolic links resolved where the folder
 *  exists (the only thing read outside the pack is the link, never a file in the project). */
function folder(p) {
  let s = path.resolve(String(p));
  try {
    s = fs.realpathSync(s);
  } catch {}
  if (s.length > 1 && s.endsWith(path.sep)) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** A private pack answers only from a project on its list (the project itself or a folder in it). */
function scopeRefusal(pack, project) {
  if (pack.access !== 'private') return null;
  if (!project) return 'this is a private pack and the caller named no project, so it was not searched';
  const here = folder(project);
  const allowed = (Array.isArray(pack.projects) ? pack.projects : []).map(folder);
  if (allowed.some((a) => here === a || here.startsWith(a.endsWith(path.sep) ? a : a + path.sep))) return null;
  return `this is a private pack, searched only from its listed projects; ${project} is not one of them`;
}

function run(h, query, options, scoped) {
  const t0 = Date.now();
  const { recipe, pack } = h;
  const detail = options.detail === 'full' || options.detail === 'brief' ? options.detail : recipe.result.defaultDetail;
  const refusal = scoped ? scopeRefusal(pack, options.project) : null;
  const sourceOf = (repo) => pack.sources.find((s) => s.repo === repo);
  const used = new Set();
  const lanesRun = [];
  const runs = new Map();
  const sections = recipe.sections.map((sec) => {
    if (refusal) return { name: sec.name, items: [], empty: { reason: refusal } };
    if (h.absent.has(sec.lane)) return { name: sec.name, items: [], empty: { reason: `this pack has no ${sec.name.toLowerCase()}` } };
    const x = h.handles[sec.lane];
    if (!x || (options.lanes && !options.lanes.includes(sec.lane))) {
      const why = h.lanes.find((l) => l.name === sec.lane)?.reason;
      return { name: sec.name, items: [], empty: { reason: `lane ${sec.lane} is not available${why ? `: ${why}` : ''}` } };
    }
    if (!runs.has(sec.lane)) {
      runs.set(sec.lane, x.impl.search(x.lane, String(query ?? '')));
      lanesRun.push(sec.lane);
    }
    const { rows, emptyReason } = runs.get(sec.lane);
    const items = section({ sec, lane: x.lane, laneImpl: x.impl, rows, detail, recipe, sourceOf, used });
    return { name: sec.name, items, empty: items.length ? null : { reason: emptyReason ?? 'every match was already sent in an earlier section' } };
  });
  fit(sections.flatMap((s) => s.items), recipe.result.capChars[detail]);
  holdToDelivery(sections.flatMap((s) => s.items), recipe.result.delivery);
  return {
    schema: 'ruvnet-brain/result',
    version: 1,
    generation: pack.generation,
    knowledgeDate: pack.knowledgeDate,
    recipeId: recipe.id,
    detail,
    lanes: h.lanes,
    safeMode: { on: false, reason: null },
    sections: sections.map((s) => ({ ...s, items: s.items.map(publicItem) })),
    closing: AUTHORITY_ORDER,
    meta: { lanesRun, ms: Date.now() - t0 },
  };
}

/** The passages of one file of the pack, in order, from the first lane that holds it (read_ruvnet's
 *  source); [] when the pack has no such file. A private pack's project rule is the caller's to apply. */
export function read(h, repo, file) {
  for (const spec of h.recipe.lanes) {
    const x = h.handles[spec.name];
    const rows = x ? x.impl.fileRows(x.lane, repo, file) : [];
    if (rows.length) return rows;
  }
  return [];
}

/** options: { detail: 'brief' | 'full', lanes?: [names], project?: folder the question comes from } */
export function search(h, query, options = {}) {
  return run(h, query, options, true);
}

/** Runs the probes shipped in the pack. ok only when every probe finds its expected file. Probes test
 *  the machinery, so a private pack's project list does not apply to them. */
export function selfTest(h) {
  const probesFile = h.pack.files.find((f) => f.role === 'probes');
  if (!probesFile) return { ok: false, error: 'the pack ships no probes', results: [], lanes: h.lanes };
  const { probes } = JSON.parse(fs.readFileSync(path.join(h.packDir, probesFile.path), 'utf8'));
  const results = probes.map((p) => {
    const files = run(h, p.question, {}, false).sections.flatMap((s) => s.items.map((i) => `${i.repo}/${i.path}`));
    return { question: p.question, expect: p.expect, pass: files.includes(p.expect), top: files[0] ?? null };
  });
  return { ok: results.length > 0 && results.every((r) => r.pass), results, lanes: h.lanes };
}
