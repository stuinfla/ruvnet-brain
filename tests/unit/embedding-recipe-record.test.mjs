// tests/unit/embedding-recipe-record.test.mjs : the embedding recipe page cannot silently disagree with the code.
//
// docs/brain-research/EMBEDDING-RECIPE.md carries one fenced block tagged `json recipe-constants` naming every
// constant of the shipped embedding and search recipe (ADR-109). This test reads each constant from the code,
// at EVERY place the code defines it, and fails when:
//   - the block is missing, appears twice, or has a missing or extra key;
//   - any code site disagrees with another code site (for example the nightly refresh drifting from the full build);
//   - the block's value differs from the code (the message names the constant and both values);
//   - the block's digest is not the digest of the code's values (so a constant cannot change unnoticed);
//   - the version table has no single row carrying the block's recipeVersion, lastChanged date and digest;
//   - docs/brain-research/DECISIONS.md has no entry naming that recipeVersion.
// So a recipe change must touch the code, the block, the version table and the decision log together.
//
// Portable by design: RECIPE_SOURCES below is the only place that knows where a constant lives. A new
// architecture (v5) swaps that list and the block; nothing else here changes. Every source is read as text with
// an anchored pattern that must match exactly once, so no product module is imported (several start servers or
// load models at import time). RECIPE_CHECK_ROOT points the whole check at another checkout; the default is this
// repository. It exists so the check can be proven to fail on a broken scratch copy without touching this one.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RECIPE_CHECK_ROOT
  ? path.resolve(process.env.RECIPE_CHECK_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RECIPE_DOC = 'docs/brain-research/EMBEDDING-RECIPE.md';
const DECISIONS_DOC = 'docs/brain-research/DECISIONS.md';

const str = (m) => m[1];
const int = (m) => Number.parseInt(m[1], 10);
const bool = (m) => m[1] === 'true';
// FORGE_BUILD_FINGERPRINT = [chunker, 'model@revision:dimensions:pooling'].join('|')
const FINGERPRINT = /^export const FORGE_BUILD_FINGERPRINT = \[\n\s+FORGE_CHUNKER_VERSION,\n\s+'([^'@]+)@([0-9a-f]{40}):(\d+):(\w+)',\n\]\.join\('\|'\);$/m;

/** The one list v5 swaps: constant -> every code site that defines it. The first site is the one the page names. */
const RECIPE_SOURCES = {
  embeddingModel: [
    { file: 'kb/forge-big.mjs', re: /^const MODEL = '([^']+)';$/m, cast: str },
    { file: 'kb/forge-refresh.mjs', re: /^ {2}model: '([^']+)',$/m, cast: str },
    { file: 'kb/model-requirements.mjs', re: /^export const BGE_MODEL = '([^']+)';$/m, cast: str },
    { file: 'kb/forge-corpus.mjs', re: FINGERPRINT, cast: (m) => m[1] },
  ],
  embeddingRevision: [
    { file: 'kb/forge-big.mjs', re: /^const MODEL_REVISION = '([0-9a-f]{40})';$/m, cast: str },
    { file: 'kb/forge-refresh.mjs', re: /^ {2}revision: '([0-9a-f]{40})',$/m, cast: str },
    { file: 'kb/forge-corpus.mjs', re: FINGERPRINT, cast: (m) => m[2] },
  ],
  dimensions: [
    { file: 'kb/forge-big.mjs', re: /^const DIM = (\d+);$/m, cast: int },
    { file: 'kb/forge-refresh.mjs', re: /^ {2}dimensions: (\d+),$/m, cast: int },
    { file: 'kb/forge-corpus.mjs', re: FINGERPRINT, cast: (m) => Number.parseInt(m[3], 10) },
  ],
  pooling: [
    { file: 'kb/forge-big.mjs', re: /^const POOLING = '(\w+)';$/m, cast: str },
    { file: 'kb/forge-refresh.mjs', re: /^ {2}pooling: '(\w+)',$/m, cast: str },
    { file: 'kb/forge-corpus.mjs', re: FINGERPRINT, cast: (m) => m[4] },
  ],
  quantized: [
    { file: 'kb/forge-big.mjs', re: /T\.pipeline\('feature-extraction', MODEL, \{ quantized: (true|false),/, cast: bool },
    { file: 'kb/forge-refresh.mjs', re: /T\.pipeline\('feature-extraction', config\.model, \{\n\s+quantized: (true|false),/, cast: bool },
  ],
  queryPrefix: [
    { file: 'kb/forge-big.mjs', re: /^const QUERY_PREFIX = '([^']*)';$/m, cast: str },
  ],
  embeddedTextField: [
    { file: 'kb/forge-big.mjs', re: /embedTexts\(batch\.map\(\(r\) => r\.(\w+)\)\)/, cast: str },
    { file: 'kb/forge-refresh.mjs', re: /const texts = batch\.map\(\(\{ (\w+) \}\) => \w+\);/, cast: str },
  ],
  chunkChars: [
    { file: 'kb/forge-corpus.mjs', re: /^export const MAX_CHUNK_CHARS = (\d+);$/m, cast: int },
  ],
  chunkOverlap: [
    { file: 'kb/forge-corpus.mjs', re: /^export const CHUNK_OVERLAP_CHARS = (\d+);$/m, cast: int },
  ],
  chunkerId: [
    { file: 'kb/forge-corpus.mjs', re: /^export const FORGE_CHUNKER_VERSION = '([^']+)';$/m, cast: str },
  ],
  rerankerModel: [
    { file: 'kb/model-requirements.mjs', re: /^export const RERANKER_MODEL = '([^']+)';$/m, cast: str },
  ],
  rerankerRevision: [
    { file: 'kb/forge-rerank.mjs', re: /^const CE_REVISION = CE_MODEL === DEFAULT_CE_MODEL \? '([0-9a-f]{40})' : 'main';$/m, cast: str },
  ],
  defaultK: [
    { file: 'kb/forge-mcp-all.mjs', re: /^\s+const k = Math\.max\(1, parseInt\(args\.k \?\? (\d+), 10\) \|\| \d+\);$/m, cast: int },
    { file: 'kb/forge-mcp-all.mjs', re: /'Number of documents to return \(default \d+\)\.', default: (\d+) \}/, cast: int },
    { file: 'kb/forge-ask-all.mjs', re: /^ {2}dir, query, k = (\d+), pool = \d+, repos, _routeStage = false,$/m, cast: int },
  ],
  storeSuffix: [
    { file: 'kb/forge-big.mjs', re: /path\.join\(DIR, `\$\{NAME\}(\.big\.rvf)`\)/, cast: str },
  ],
};

const REQUIRED_KEYS = Object.keys(RECIPE_SOURCES).sort();

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** One anchored read: the pattern must match exactly once, or the failure names the constant and the file. */
function readSite(key, { file, re, cast }) {
  const text = readText(file);
  const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))];
  if (all.length !== 1) {
    throw new Error(`recipe constant ${key}: expected exactly one match in ${file}, found ${all.length} (pattern ${re})`);
  }
  return cast(all[0]);
}

/** Every site of every constant; throws if two sites of one constant disagree. */
function readCodeConstants() {
  const out = {};
  for (const key of REQUIRED_KEYS) {
    const sites = RECIPE_SOURCES[key].map((site) => ({ file: site.file, value: readSite(key, site) }));
    const distinct = [...new Set(sites.map((s) => JSON.stringify(s.value)))];
    if (distinct.length !== 1) {
      throw new Error(`recipe constant ${key}: code sites disagree: ${sites.map((s) => `${s.file}=${JSON.stringify(s.value)}`).join(', ')}`);
    }
    out[key] = { value: sites[0].value, from: sites[0].file };
  }
  return out;
}

function recipeDigest(values) {
  const canonical = JSON.stringify(REQUIRED_KEYS.map((k) => [k, values[k]]));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

function readRecipeBlock(markdown) {
  const blocks = [...markdown.matchAll(/^```json recipe-constants\n([\s\S]*?)\n```$/gm)];
  if (blocks.length !== 1) throw new Error(`${RECIPE_DOC}: expected exactly one \`json recipe-constants\` block, found ${blocks.length}`);
  return JSON.parse(blocks[0][1]);
}

describe('the embedding recipe page matches the shipped code (ADR-109)', () => {
  const markdown = readText(RECIPE_DOC);
  const block = readRecipeBlock(markdown);
  const code = readCodeConstants();
  const codeValues = Object.fromEntries(REQUIRED_KEYS.map((k) => [k, code[k].value]));

  it('the block names exactly the required constants, no more and no fewer', () => {
    expect(Object.keys(block.constants ?? {}).sort()).toEqual(REQUIRED_KEYS);
  });

  it('every constant in the block equals the code, and names the file that defines it', () => {
    const problems = [];
    for (const key of REQUIRED_KEYS) {
      const doc = block.constants?.[key];
      if (!doc) { problems.push(`${key}: missing from the block`); continue; }
      if (JSON.stringify(doc.value) !== JSON.stringify(code[key].value)) {
        problems.push(`${key}: page says ${JSON.stringify(doc.value)}, code (${code[key].from}) says ${JSON.stringify(code[key].value)}`);
      }
      if (doc.from !== code[key].from) problems.push(`${key}: page names ${doc.from}, the defining file is ${code[key].from}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the block digest is the digest of the code values (a changed constant forces a new recipe version)', () => {
    const actual = recipeDigest(codeValues);
    expect(block.digest, `block digest ${block.digest} but the code's constants hash to ${actual}: bump recipeVersion, lastChanged and digest, and add a version-table row and a DECISIONS.md entry`).toBe(actual);
  });

  it('the version table has exactly one row for this recipe version, with its date and digest', () => {
    expect(block.recipeVersion, 'block has no recipeVersion').toMatch(/^R\d+$/);
    expect(block.lastChanged, 'block lastChanged must be YYYY-MM-DD').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const rows = markdown.split('\n').filter((l) => new RegExp(`^\\|\\s*${block.recipeVersion}\\s*\\|`).test(l));
    expect(rows.length, `version table rows starting "| ${block.recipeVersion} |": ${rows.length}`).toBe(1);
    expect(rows[0]).toContain(block.lastChanged);
    expect(rows[0]).toContain(block.digest);
  });

  it('DECISIONS.md records this recipe version', () => {
    expect(readText(DECISIONS_DOC)).toContain(`recipe-version: ${block.recipeVersion}`);
  });
});

describe('the check itself can fail', () => {
  it('a missing or doubled block is refused', () => {
    expect(() => readRecipeBlock('no block here')).toThrow(/found 0/);
    const one = '```json recipe-constants\n{}\n```';
    expect(() => readRecipeBlock(`${one}\n\n${one}`)).toThrow(/found 2/);
  });
  it('a pattern that matches twice is refused, naming the constant', () => {
    const site = { file: RECIPE_DOC, re: /recipe/, cast: str };
    expect(() => readSite('demo', site)).toThrow(/recipe constant demo: expected exactly one match/);
  });
  it('the digest moves when any one constant moves', () => {
    const base = Object.fromEntries(REQUIRED_KEYS.map((k) => [k, 1]));
    for (const k of REQUIRED_KEYS) expect(recipeDigest({ ...base, [k]: 2 })).not.toBe(recipeDigest(base));
  });
});
