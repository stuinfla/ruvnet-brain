// Rebuild the two source-derived public aggregate stores as one atomic artifact set.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';
import { buildGistAggregate } from './rebuild-gists-from-receipts.mjs';
import { writeRvfGeneration } from './rvf-generation.mjs';
import { digest, sha256File } from './coverage-integrity.mjs';
import { materializePublicInputs, SELECTION_RECEIPT_KIND, SELECTION_RECEIPT_SCHEMA,
  validateSelectionReceipt } from './public-inputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[a-f0-9]{64}$/;
const MODEL = 'Xenova/bge-base-en-v1.5';
const DIMENSIONS = 768;

function fail(message) {
  throw new Error(`[corpus-aggregates] ${message}`);
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

// buildConceptAggregate — Step 3 (2026-09-13): this used to be a SECOND, independently-fenced
// concepts transformation (its own privateStores/privateSlugs re-derivation from
// PRIVATE-STORES.json/l2-topics.*.json, duplicating scripts/build-concepts.mjs's separate copy of
// the same logic). Fencing now happens EXACTLY ONCE, upstream, in materializePublicInputs
// (scripts/public-inputs.mjs) -- `publicInputDir` is trusted to already contain ONLY public prose,
// so this function does no fencing of its own; it just assembles passages from what is actually
// there. `selectionReceipt` is the PublicInputSet's own receipt (proves what was excluded, by
// digest, without carrying private content) and `observationSha256` must be the corpus coverage's
// own observation identity -- callers assert that equality (rebuildCorpusAggregates does, below),
// not this pure function.
export function buildConceptAggregate({ publicInputDir, selectionReceipt, observationSha256, outDir,
  now = () => new Date().toISOString() } = {}) {
  const input = path.resolve(publicInputDir || '');
  const output = path.resolve(outDir || '');
  if (!HEX64.test(String(observationSha256 || ''))) fail('concepts require an exact source observation');
  // Step 5 remediation (2026-09-13): the receipt is schema 2 (byte-bound `files[]`); the exact
  // kind/schema constants are the producer's own exports, never restated here.
  if (!selectionReceipt || selectionReceipt.schemaVersion !== SELECTION_RECEIPT_SCHEMA
    || selectionReceipt.kind !== SELECTION_RECEIPT_KIND) {
    fail('concepts require a valid public input selection receipt');
  }
  // P2 (Dual, 2026-09-14): "checks kind/schema only, then enumerates disk primers". Kind and schema
  // are a label, not a proof — this function then reads whatever prose happens to be on disk under
  // `publicInputDir` and embeds it permanently into concepts.passages.jsonl, where no later file
  // deletion can remove it. So the receipt is VERIFIED against that exact directory first, by the
  // producer's own fail-closed validator: every sealed file present with exact bytes, every included
  // name backed, and NO unsealed managed prose riding along. Both callers
  // (scripts/build-concepts.mjs and rebuildCorpusAggregates) hand in the producer's own receipt, so
  // this is a cheap re-read, not a second policy.
  try {
    validateSelectionReceipt({ receipt: selectionReceipt, dir: input });
  } catch (error) {
    fail(`concepts refuse to read prose that its selection receipt does not prove (${error.message})`);
  }
  const ownership = new Map(Object.entries(selectionReceipt.ownership || {}));

  const repositories = fs.readdirSync(input)
    .filter((file) => file.endsWith('-primer.md'))
    .map((file) => file.slice(0, -'-primer.md'.length))
    .sort();

  const passages = [];
  const entries = {};
  let nextId = 0;
  const inputFiles = new Set();
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
  if (fs.existsSync(l2Dir)) {
    for (const name of fs.readdirSync(l2Dir).filter((file) => file.endsWith('.md')).sort()) {
      const slug = name.slice(0, -3);
      const repository = ownership.get(slug) || 'ruvnet';
      const relative = `l2/${name}`;
      const body = fs.readFileSync(path.join(input, relative), 'utf8');
      inputFiles.add(relative);
      add(repository, 'L2', slug, body.match(/^#\s+(.+)/m)?.[1] || slug, body);
    }
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
      if (!repository || !body) continue;
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
    observationSha256,
    selectionReceiptSha256: selectionReceipt.receiptSha256,
    inputs: [...inputFiles].sort().map((relative) => ({ path: relative, sha256: sha256File(path.join(input, relative)) })),
    passagesSha256: digest(passageBody),
  };
  fs.writeFileSync(path.join(output, 'concepts.sources.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  // Rule 9: the store-classes registry is generated FRESH from the derived stores this call actually
  // produced -- never merged with a stale checkout copy of public-store-classes.json. Concepts is
  // the only derived store this pipeline builds today; ruv-gists is a repository/gist-class store,
  // classified separately (scripts/build-bundle.mjs's own discovery), not through this registry.
  const classes = { schemaVersion: 1, derived: [{ store: 'concepts', receipt: 'concepts.sources.json' }] };
  fs.writeFileSync(path.join(output, 'public-store-classes.json'), `${JSON.stringify(classes, null, 2)}\n`);
  return { store: 'concepts', kind: 'derived-store-aggregate', passages: passages.length, receipt };
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
export async function rebuildCorpusAggregates({ assetsDir, observation, coverage, root = ROOT, cache = null,
  transport = {}, buildVector = defaultBuildVector, builderSha = null, allowNoPrivateFence = false,
  now = () => new Date().toISOString() } = {}) {
  const assets = path.resolve(assetsDir || '');
  const observationSha256 = String(observation?.observationSha256 || '');
  if (!HEX64.test(observationSha256)) fail('aggregate rebuild requires an exact source observation');
  if (typeof buildVector !== 'function') fail('aggregate vector builder is unavailable');
  // Rule 8: the concepts receipt's observation identity must EXACTLY EQUAL corpus coverage's own
  // observation identity, not merely happen to be fed the same value by an accident of call order.
  if (!coverage || coverage.sourceObservationSha256 !== observationSha256) {
    fail('concepts observation identity does not exactly equal the corpus coverage observation identity');
  }

  const gistAggregate = await buildGistAggregate({
    observation, cache, outDir: assets, root, transport, buildVector, sourceCommit: observationSha256, now,
  });

  // Public prose selection (rule 1-3, 5): a fresh, positively-selected, already-fenced tree, rebuilt
  // every round directly into `assets` -- never an overlay onto whatever a prior round left behind.
  const publicInputs = materializePublicInputs({
    builderRoot: root, outDir: assets, policy: { allowNoFence: allowNoPrivateFence }, builderSha, now,
  });

  const stage = fs.mkdtempSync(path.join(path.dirname(assets), '.corpus-aggregates-'));
  try {
    buildConceptAggregate({
      publicInputDir: assets, selectionReceipt: publicInputs.selectionReceipt,
      observationSha256, outDir: stage, now,
    });
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
    return { rebuilt: rebuilt.sort(), sourceObservationSha256: observationSha256, gistAggregate, publicInputs };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
