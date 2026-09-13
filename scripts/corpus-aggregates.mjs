// Rebuild the two source-derived public aggregate stores as one atomic artifact set.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';
import { buildGistAggregate } from './rebuild-gists-from-receipts.mjs';
import { writeRvfGeneration } from './rvf-generation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[a-f0-9]{64}$/;
const MODEL = 'Xenova/bge-base-en-v1.5';
const DIMENSIONS = 768;

function fail(message) {
  throw new Error(`[corpus-aggregates] ${message}`);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is missing or unreadable (${error.message})`); }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function chunks(text, size = 3200) {
  const result = [];
  let buffer = '';
  for (const paragraph of String(text).split(/\n\n+/)) {
    if (buffer && buffer.length + paragraph.length + 2 > size) {
      result.push(buffer);
      buffer = '';
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer.trim()) result.push(buffer);
  return result;
}

export function buildConceptAggregate({ inputDir, outDir, sourceObservationSha256,
  now = () => new Date().toISOString() } = {}) {
  const input = path.resolve(inputDir || '');
  const output = path.resolve(outDir || '');
  if (!HEX64.test(String(sourceObservationSha256 || ''))) fail('concepts require an exact source observation');
  const fenceFile = path.join(input, 'PRIVATE-STORES.json');
  const fence = readJson(fenceFile, 'private fence');
  if (!Array.isArray(fence.privateStores)) fail('private fence has no privateStores array');
  const privateStores = new Set(fence.privateStores.map((store) => String(store).toLowerCase()));
  const privateSlugs = new Set();
  for (const store of privateStores) {
    const file = path.join(input, `l2-topics.${store}.json`);
    if (!fs.existsSync(file)) continue;
    const topics = readJson(file, `${store} private topic fence`);
    if (!Array.isArray(topics)) fail(`${store} private topic fence is malformed`);
    for (const topic of topics) if (topic?.slug) privateSlugs.add(String(topic.slug));
  }

  const repositories = fs.readdirSync(input)
    .filter((file) => file.endsWith('-primer.md'))
    .map((file) => file.slice(0, -'-primer.md'.length))
    .filter((store) => !privateStores.has(store.toLowerCase()))
    .sort();
  const slugRepository = new Map([
    ['guidance-mechanism', 'ruflo'], ['memory-end-to-end', 'ruflo'], ['adr-coverage', 'ruflo'],
  ]);
  const inputFiles = new Set(['PRIVATE-STORES.json']);
  for (const repository of repositories) {
    const relative = `l2-topics.${repository}.json`;
    const file = path.join(input, relative);
    if (!fs.existsSync(file)) continue;
    const topics = readJson(file, `${repository} topics`);
    if (!Array.isArray(topics)) fail(`${repository} topics are malformed`);
    inputFiles.add(relative);
    for (const topic of topics) if (topic?.slug) slugRepository.set(String(topic.slug), repository);
  }

  const passages = [];
  const entries = {};
  let nextId = 0;
  const add = (repository, kind, slug, title, body) => {
    const parts = chunks(body);
    for (const [index, text] of parts.entries()) {
      const id = String(nextId++);
      const passagePath = `${repository}/${kind}/${slug}${parts.length > 1 ? `#${index}` : ''}`;
      passages.push({ id, text, path: passagePath, title });
      entries[id] = { path: passagePath, kind: 'doc', title, chunk: index, preview: text.slice(0, 200) };
    }
  };

  const l2Dir = path.join(input, 'l2');
  if (!fs.existsSync(l2Dir) || !fs.statSync(l2Dir).isDirectory()) fail('concept L2 input directory is missing');
  for (const name of fs.readdirSync(l2Dir).filter((file) => file.endsWith('.md')).sort()) {
    const slug = name.slice(0, -3);
    const repository = slugRepository.get(slug) || 'ruvnet';
    if (privateStores.has(repository.toLowerCase()) || privateSlugs.has(slug)) continue;
    const relative = `l2/${name}`;
    const body = fs.readFileSync(path.join(input, relative), 'utf8');
    inputFiles.add(relative);
    add(repository, 'L2', slug, body.match(/^#\s+(.+)/m)?.[1] || slug, body);
  }
  for (const repository of repositories) {
    const relative = `${repository}-primer.md`;
    const body = fs.readFileSync(path.join(input, relative), 'utf8');
    inputFiles.add(relative);
    add(repository, 'PRIMER', `${repository}-primer`, `${repository} — Primer`, body);
  }
  const cardsRelative = 'capability-cards.md';
  const cardsFile = path.join(input, cardsRelative);
  if (fs.existsSync(cardsFile)) {
    inputFiles.add(cardsRelative);
    const sections = fs.readFileSync(cardsFile, 'utf8').split(/^##\s+/m).slice(1);
    for (const section of sections) {
      const newline = section.indexOf('\n');
      if (newline < 0) continue;
      const repository = section.slice(0, newline).trim();
      const body = section.slice(newline + 1).trim();
      if (!repository || !body || privateStores.has(repository.toLowerCase())) continue;
      add(repository, 'CARD', `${repository}-card`, `${repository} — Capability`, `${repository} — ${body}`);
    }
  }
  if (!passages.length) fail('concept aggregate produced zero public passages');

  fs.mkdirSync(output, { recursive: true });
  const passageBody = `${passages.map((row) => JSON.stringify(row)).join('\n')}\n`;
  fs.writeFileSync(path.join(output, 'concepts.passages.jsonl'), passageBody);
  fs.writeFileSync(path.join(output, 'concepts.meta.json'), `${JSON.stringify({
    model: 'concepts', dimensions: 0, metric: 'cosine', name: 'concepts', generated: now(),
    repo: 'ruvnet-concepts', note: 'Public L2 synthesis, primers, and capability cards.', entries,
  }, null, 2)}\n`);
  const receipt = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-derived-store-receipt',
    store: 'concepts',
    sourceObservationSha256,
    inputs: [...inputFiles].sort().map((relative) => ({ path: relative, sha256: sha256File(path.join(input, relative)) })),
    passagesSha256: crypto.createHash('sha256').update(passageBody).digest('hex'),
  };
  fs.writeFileSync(path.join(output, 'concepts.sources.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const classesFile = path.join(input, 'public-store-classes.json');
  const classes = fs.existsSync(classesFile) ? readJson(classesFile, 'public store classes') : { schemaVersion: 1, derived: [] };
  if (classes.schemaVersion !== 1 || !Array.isArray(classes.derived)) fail('public store classes are malformed');
  classes.derived = [...classes.derived.filter((entry) => String(entry?.store || '').toLowerCase() !== 'concepts'),
    { store: 'concepts', receipt: 'concepts.sources.json' }]
    .sort((a, b) => String(a.store).localeCompare(String(b.store)));
  fs.writeFileSync(path.join(output, 'public-store-classes.json'), `${JSON.stringify(classes, null, 2)}\n`);
  return { passages: passages.length, receipt };
}

function defaultBuildVector({ root, assetsDir, store }) {
  const script = path.join(path.resolve(root || ROOT), 'kb', 'forge-big.mjs');
  const result = spawnSync(process.execPath, [script, 'both', '--dir', assetsDir, '--name', store], {
    encoding: 'utf8', stdio: 'inherit', env: { ...process.env },
  });
  if (result.error || result.status !== 0) fail(`${store} vector build failed (${result.error?.message || `exit ${result.status}`})`);
}

// Gists and concepts are independent derived stores (concepts never reads gist content), so each is
// now built and promoted through its OWN atomic step rather than one shared stage+promotion:
//   1. buildGistAggregate owns the ENTIRE gist lifecycle -- capture, render, embed, seal, validate,
//      and promote -- as one atomic unit (see gist-receipts.mjs). A failed gist build/embed leaves
//      `assets` completely untouched and concepts is never attempted.
//   2. concepts is then rebuilt from the (now gist-updated) `assets` tree, exactly as before.
// This trades the OLD single joint promotion of both stores for two independently-atomic ones; each
// store's own artifact set can never be left half-written, which the joint promotion could not
// promise for gists specifically once gist capture/render/seal became a single multi-step pipeline.
export async function rebuildCorpusAggregates({ assetsDir, observation, root = ROOT, cache = null,
  transport = {}, buildVector = defaultBuildVector, now = () => new Date().toISOString() } = {}) {
  const assets = path.resolve(assetsDir || '');
  const observationSha256 = String(observation?.observationSha256 || '');
  if (!HEX64.test(observationSha256)) fail('aggregate rebuild requires an exact source observation');
  if (typeof buildVector !== 'function') fail('aggregate vector builder is unavailable');

  const gistAggregate = await buildGistAggregate({
    observation, cache, outDir: assets, root, transport, buildVector, sourceCommit: observationSha256, now,
  });

  const stage = fs.mkdtempSync(path.join(path.dirname(assets), '.corpus-aggregates-'));
  try {
    buildConceptAggregate({ inputDir: assets, outDir: stage, sourceObservationSha256: observationSha256, now });
    await buildVector({ root, assetsDir: stage, store: 'concepts' });
    writeRvfGeneration({ dir: stage, previousDir: assets, store: 'concepts', model: MODEL,
      dimensions: DIMENSIONS, sourceCommit: observationSha256, builtUtc: now() });
    const files = [
      'concepts.passages.jsonl', 'concepts.meta.json', 'concepts.big.rvf',
      'concepts.big.rvf.idmap.json', 'concepts.big.rvf.embed.json',
      'concepts.sources.json', 'public-store-classes.json', 'RVF-GENERATIONS.json',
    ];
    promoteArtifactSet({ liveDir: assets, candidateDir: stage, files });
    const rebuilt = gistAggregate.omitted ? ['concepts'] : ['concepts', 'ruv-gists'];
    return { rebuilt: rebuilt.sort(), sourceObservationSha256: observationSha256, gistAggregate };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
