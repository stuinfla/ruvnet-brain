// Every setting the builder uses, read from the recipe and nowhere else. The builder holds no chunk
// size, model, tokenizer, pattern or bound of its own: a missing or out-of-range setting stops the
// build with one sentence naming it (ROADMAP A4, WP 5: "a chunk size outside recipe/RECIPE.json
// fails the build").
import { checkAnalyser } from '../engine/analyse.mjs';
import { ESTIMATORS } from './tokens.mjs';

function get(recipe, dotted) {
  let v = recipe;
  for (const k of dotted.split('.')) v = v == null ? undefined : v[k];
  if (v === undefined || v === null) throw new Error(`recipe has no ${dotted}; the builder has no default for it`);
  return v;
}

function int(recipe, dotted, lo, hi) {
  const v = get(recipe, dotted);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${dotted} must be a whole number from ${lo} to ${hi}; the recipe has ${JSON.stringify(v)}`);
  return v;
}

function str(recipe, dotted) {
  const v = get(recipe, dotted);
  if (typeof v !== 'string') throw new Error(`${dotted} must be text; the recipe has ${JSON.stringify(v)}`);
  return v;
}

function list(recipe, dotted) {
  const v = get(recipe, dotted);
  if (!Array.isArray(v)) throw new Error(`${dotted} must be a list; the recipe has ${JSON.stringify(v)}`);
  return v;
}

function regex(pattern, flags, what) {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`${what} is not a valid pattern: ${e.message}`);
  }
}

const rules = (recipe, dotted, extraFlags) =>
  list(recipe, dotted).map((r, i) => ({ rule: str(r, 'rule'), re: regex(str(r, 'pattern'), `${r.flags ?? ''}${extraFlags}`, `${dotted}[${i}]`) }));

/** The layered store's settings (contract 1.3), or null when the recipe names no layered store (a
 *  pack built from such a recipe has no layered.db, and the layered tools say so). */
function layeredSettings(recipe) {
  if (recipe.layered === undefined) return null;
  const l = 'layered';
  if (int(recipe, `${l}.version`, 1, 1) !== 1) throw new Error('layered.version must be 1');
  const out = {
    fts5Tokenizer: str(recipe, `${l}.fts5Tokenizer`),
    pageChars: int(recipe, `${l}.pageChars`, 2000, 44_000),
    rowMaxChars: int(recipe, `${l}.rowMaxChars`, 200, 44_000),
    readLines: int(recipe, `${l}.readLines`, 1, 100_000),
    searchDepth: int(recipe, `${l}.searchDepth`, 1, 10_000),
    mapDepth: int(recipe, `${l}.mapDepth`, 1, 10_000),
  };
  // The reader holds every page to the lower of pageChars and the recipe's delivery ceiling; a row
  // shown inline must fit well inside that page.
  const page = Math.min(out.pageChars, recipe.result?.delivery?.maxChars ?? 44_000, 44_000);
  if (out.rowMaxChars * 2 > page) throw new Error(`layered.rowMaxChars ${out.rowMaxChars} must be at most half of the page cap (${page} characters), or one row could fill a page`);
  return out;
}

/** The builder's whole configuration, derived from the recipe. Throws one sentence on any gap. */
export function settings(recipe) {
  for (const m of list(recipe, 'models')) {
    throw new Error(`recipe names model ${m?.name}@${m?.revision ?? '?'}, which this builder does not load (day one ships no model)`);
  }
  const sc = 'units.passage.symbolChunker';
  const est = get(recipe, `${sc}.tokenEstimator`);
  const make = ESTIMATORS[est.name]?.[est.version];
  if (!make) throw new Error(`token estimator ${est.name} version ${est.version ?? '?'} is not one this builder has (known: ${Object.keys(ESTIMATORS).join(', ')})`);
  const outer = 'units.passage.chunker';
  const contentTypes = get(recipe, 'sources.contentTypes');
  const typeOfExt = new Map();
  for (const [type, exts] of Object.entries(contentTypes)) for (const e of exts) typeOfExt.set(e, type);
  checkAnalyser(recipe.analyser);
  const s = {
    chunker: {
      name: str(recipe, `${sc}.name`),
      version: int(recipe, `${sc}.version`, 1, 1000),
      maxTokens: int(recipe, `${sc}.maxTokens`, 64, 8192),
      groupTarget: int(recipe, `${sc}.groupTarget`, 1, 8192),
      labelTokens: int(recipe, `${sc}.labelTokens`, 0, 1024),
      specialTokens: int(recipe, `${sc}.specialTokens`, 0, 16),
      separator: str(recipe, `${sc}.headerSeparator`),
      maxSymbolChars: int(recipe, `${sc}.maxSymbolChars`, 8, 1000),
      maxLines: int(recipe, `${outer}.maxLines`, 1, 1_000_000),
      maxChars: int(recipe, `${outer}.maxChars`, 100, 10_000_000),
      counter: make(est),
    },
    history: {
      splitChars: int(recipe, 'units.history.splitChars', 200, 100_000),
      separator: str(recipe, 'units.history.headerSeparator'),
      minCommitChars: int(recipe, 'units.history.minCommitChars', 0, 100_000),
      minReleaseBodyChars: int(recipe, 'units.history.minReleaseBodyChars', 0, 100_000),
      skipCommitSubjects: list(recipe, 'units.history.skipCommitSubjects').map((p, i) => regex(p, 'i', `units.history.skipCommitSubjects[${i}]`)),
      versionCommitSubjects: list(recipe, 'units.history.versionCommitSubjects').map((p, i) => regex(p, 'i', `units.history.versionCommitSubjects[${i}]`)),
      versionCommitMaxChars: int(recipe, 'units.history.versionCommitMaxChars', 0, 100_000),
      kinds: list(recipe, 'units.history.kinds'),
      standing: get(recipe, 'units.history.standing'),
      perPage: int(recipe, 'units.history.perPage', 1, 100),
    },
    sources: {
      include: new Set(list(recipe, 'sources.include').map((e) => e.toLowerCase())),
      excludeDirs: new Set(list(recipe, 'sources.excludeDirs')),
      sourceFile: str(recipe, 'sources.sourceFile'),
      typeOfExt,
      buildManifests: list(recipe, 'sources.buildDirBesideManifests'),
      skipNames: new Set(list(recipe, 'sources.skipFileNames')),
      skipPaths: list(recipe, 'sources.skipPathPatterns').map((p, i) => regex(p, '', `sources.skipPathPatterns[${i}]`)),
      generated: regex(str(recipe, 'sources.generatedPattern'), 'i', 'sources.generatedPattern'),
      maxFileBytes: int(recipe, 'sources.maxFileBytes', 1, 2 ** 31),
      configMaxChars: int(recipe, 'sources.configMaxChars', 100, 10_000_000),
    },
    standing: {
      docExt: new Set(list(recipe, 'standing.docExtensions')),
      doc: str(recipe, 'standing.doc'),
      code: str(recipe, 'standing.code'),
      byKind: get(recipe, 'standing.byKind'),
    },
    screen: {
      redaction: str(recipe, 'screen.redaction'),
      secrets: rules(recipe, 'screen.secrets', 'g'),
      hostile: rules(recipe, 'screen.hostile', ''),
    },
    carryMaxShare: get(recipe, 'carry.maxShare'),
    probes: {
      perRepo: int(recipe, 'probes.perRepo', 1, 1000),
      termsPerProbe: int(recipe, 'probes.termsPerProbe', 1, 32),
      minTermLength: int(recipe, 'probes.minTermLength', 1, 64),
    },
  };
  s.layered = layeredSettings(recipe);
  if (typeof s.carryMaxShare !== 'number' || s.carryMaxShare < 0 || s.carryMaxShare >= 1) throw new Error('carry.maxShare must be a number from 0 up to (not including) 1');
  for (const k of s.history.kinds) if (typeof s.history.standing[k] !== 'string') throw new Error(`recipe has no units.history.standing.${k}; the builder has no default for it`);
  return s;
}
