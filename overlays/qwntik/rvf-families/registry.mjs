#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAMILY_FILES = ['testimate', 'makerkit', 'saythanks'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function cardDocument(markdown) {
  const text = String(markdown || '');
  const matches = [...text.matchAll(/^## ([^\n]+)\n/gm)];
  const sections = new Map();
  for (let index = 0; index < matches.length; index++) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? text.length;
    sections.set(matches[index][1].trim(), text.slice(start, end).trimEnd());
  }
  const first = matches[0]?.index ?? text.length;
  return { preamble: text.slice(0, first).trimEnd(), sections };
}

function renderCardDocument({ preamble, sections }) {
  const body = [...sections.values()].join('\n\n');
  return `${preamble}${preamble && body ? '\n\n' : ''}${body}\n`;
}

function atomicText(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, value);
  fs.renameSync(temp, file);
}

function manifestPaths(overlayDir = HERE) {
  return FAMILY_FILES.flatMap((family) => [
    `${family}-family-manifest.json`,
    `${family}-routing-alias.json`,
  ]).map((name) => ({ name, file: path.join(overlayDir, 'manifests', name) }));
}

export function captureOverlay({ kbDir, manifestsDir, overlayDir = HERE }) {
  const aliases = readJson(path.join(kbDir, 'repo-aliases.json'));
  const generations = readJson(path.join(kbDir, 'RVF-GENERATIONS.json'));
  const source = readJson(path.join(kbDir, 'SOURCE.json'));
  const custom = readJson(path.join(manifestsDir, 'custom-stores.json'));
  const routing = FAMILY_FILES.map((family) => ({
    family,
    value: readJson(path.join(overlayDir, 'manifests', `${family}-routing-alias.json`)),
  }));
  const familyManifests = Object.fromEntries(FAMILY_FILES.map((family) => [
    family,
    readJson(path.join(overlayDir, 'manifests', `${family}-family-manifest.json`)),
  ]));
  const canonicalRoles = new Map(Object.values(familyManifests)
    .flatMap((manifest) => (manifest.stores || []).map((store) => [store.name, store.role])));
  const storeNames = [...new Set(routing.flatMap(({ value }) => value.stores))];
  const roots = new Set(FAMILY_FILES);
  const repoAliases = Object.fromEntries(Object.entries(aliases)
    .filter(([key]) => [...roots].some((root) => key === root || key.startsWith(`${root}-`))));
  const generationStores = Object.fromEntries(storeNames.map((name) => {
    if (!generations.stores?.[name]) throw new Error(`RVF-GENERATIONS.json has no ${name}`);
    return [name, { ...generations.stores[name], role: canonicalRoles.get(name) ?? generations.stores[name].role }];
  }));
  const customStores = storeNames.map((name) => {
    const record = custom.stores?.find((store) => store.name === name);
    if (!record) throw new Error(`custom-stores.json has no ${name}`);
    return { ...record, role: canonicalRoles.get(name) ?? record.role };
  });
  const sourceStores = Object.fromEntries(storeNames.map((name) => {
    const record = customStores.find((store) => store.name === name);
    const generation = generationStores[name];
    return [name, {
      kbName: name,
      sourceRepo: record.source || null,
      sourceCommit: record.source_commit ?? generation.sourceCommit ?? null,
      sourceDescribe: record.source_commit ? String(record.source_commit).slice(0, 12) : null,
      builtUtc: generation.builtUtc,
      builder: `qwntik-private-overlay:${record.producer || generation.producer || 'unknown'}`,
      canonicalManifestUrl: null,
      canonicalBundleUrl: null,
      selfUpdate: null,
      updateManaged: false,
      family: record.family || generation.family,
      familyManifestHash: record.family_manifest_hash || generation.familyManifestHash,
      role: canonicalRoles.get(name) || record.role || generation.role || null,
      provenanceState: record.provenance_state || (record.source_commit ? 'commit-pinned' : 'reference-only-unpinned-map'),
    }];
  }));
  const cardsFile = path.join(kbDir, 'capability-cards.md');
  const cards = cardDocument(fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '').sections;
  const cardNames = new Set([...storeNames, ...Object.keys(repoAliases)]);
  const capabilityCards = Object.fromEntries([...cards].filter(([name]) => cardNames.has(name)));
  const manifestDigests = Object.fromEntries(manifestPaths(overlayDir)
    .map(({ name, file }) => [name, sha256File(file)]));
  const liveManifestDigests = Object.fromEntries(manifestPaths(overlayDir).map(({ name }) => {
    const file = path.join(manifestsDir, name);
    return [name, fs.existsSync(file) ? sha256File(file) : null];
  }));

  return {
    schema: 'qwntik-private-rvf-overlay-v1',
    families: routing.map(({ family, value }) => ({
      name: family,
      alias: value.alias,
      familyManifestHash: value.familyManifestHash,
      sourceCommit: value.sourceCommit,
      stores: value.stores,
    })),
    repoAliases,
    generations: {
      schemaVersion: generations.schemaVersion,
      brainVersion: generations.brainVersion,
      releaseTag: generations.releaseTag,
      stores: generationStores,
    },
    sourceStores,
    customStores,
    capabilityCards,
    manifestDigests,
    liveManifestDigests,
    priorState: {
      repoAliases: Object.fromEntries(Object.keys(repoAliases).map((name) => [name, aliases[name] ?? null])),
      generationStores: Object.fromEntries(storeNames.map((name) => [name, generations.stores?.[name] ?? null])),
      sourceStores: Object.fromEntries(storeNames.map((name) => [name, source.stores?.[name] ?? null])),
      customStores: Object.fromEntries(storeNames.map((name) => [name, custom.stores?.find((store) => store.name === name) ?? null])),
      capabilityCards: Object.fromEntries(Object.keys(capabilityCards).map((name) => [name, cards.get(name) ?? null])),
    },
  };
}

export function verifyOverlayArtifacts({ overlay, kbDir, overlayDir = HERE }) {
  const failures = [];
  const generationNames = Object.keys(overlay.generations.stores).sort();
  const sourceNames = Object.keys(overlay.sourceStores).sort();
  if (!sameJson(sourceNames, generationNames)) failures.push('source store set does not match generation store set');
  for (const [name, entry] of Object.entries(overlay.sourceStores)) {
    if (entry.updateManaged !== false) failures.push(`${name}: private source entry must set updateManaged=false`);
    if (entry.canonicalManifestUrl != null || entry.canonicalBundleUrl != null) {
      failures.push(`${name}: private source entry must not declare a public update URL`);
    }
  }
  for (const [name, entry] of Object.entries(overlay.generations.stores)) {
    const file = path.join(kbDir, entry.file);
    if (!fs.existsSync(file)) {
      failures.push(`${name}: missing ${entry.file}`);
      continue;
    }
    const stat = fs.statSync(file);
    if (stat.size !== entry.bytes) failures.push(`${name}: bytes ${stat.size} != ${entry.bytes}`);
    const digest = sha256File(file);
    if (digest !== entry.sha256) failures.push(`${name}: sha256 ${digest} != ${entry.sha256}`);
  }
  for (const { name, file } of manifestPaths(overlayDir)) {
    if (!fs.existsSync(file)) failures.push(`overlay manifest missing: ${name}`);
    else if (sha256File(file) !== overlay.manifestDigests[name]) failures.push(`overlay manifest digest mismatch: ${name}`);
  }
  for (const family of FAMILY_FILES) {
    const familyManifest = readJson(path.join(overlayDir, 'manifests', `${family}-family-manifest.json`));
    const routingAlias = readJson(path.join(overlayDir, 'manifests', `${family}-routing-alias.json`));
    const manifestNames = (familyManifest.stores || []).map((store) => store.name);
    const expectedFamily = overlay.families.find((entry) => entry.name === family);
    if (!expectedFamily) failures.push(`${family}: overlay family registration missing`);
    if (familyManifest.familyName !== routingAlias.alias) failures.push(`${family}: familyName does not match routing alias`);
    if (familyManifest.sourceCommit !== routingAlias.sourceCommit) failures.push(`${family}: sourceCommit does not match routing alias`);
    if (familyManifest.familyManifestHash !== routingAlias.familyManifestHash) failures.push(`${family}: familyManifestHash does not match routing alias`);
    if (familyManifest.registration?.activeRegistration !== routingAlias.registration?.activeRegistration) {
      failures.push(`${family}: activeRegistration does not match routing alias`);
    }
    if (expectedFamily && (!sameJson(expectedFamily.stores, routingAlias.stores)
      || expectedFamily.alias !== routingAlias.alias
      || expectedFamily.sourceCommit !== routingAlias.sourceCommit
      || expectedFamily.familyManifestHash !== routingAlias.familyManifestHash)) {
      failures.push(`${family}: overlay family registration does not match routing alias`);
    }
    if (!sameJson(manifestNames, routingAlias.stores)) {
      failures.push(`${family}: family manifest stores do not match routing alias stores`);
    }
    for (const store of familyManifest.stores || []) {
      const generation = overlay.generations.stores[store.name];
      const sourceEntry = overlay.sourceStores[store.name];
      const customEntry = overlay.customStores.find((entry) => entry.name === store.name);
      for (const [label, entry] of [['generation', generation], ['source', sourceEntry], ['custom', customEntry]]) {
        if (!entry) failures.push(`${store.name}: ${label} registration missing`);
        else {
          if (entry.role !== store.role) failures.push(`${store.name}: ${label} role does not match family manifest`);
          if (entry.family !== familyManifest.familyName) failures.push(`${store.name}: ${label} family does not match family manifest`);
          const hash = entry.familyManifestHash ?? entry.family_manifest_hash;
          if (hash !== familyManifest.familyManifestHash) failures.push(`${store.name}: ${label} family hash does not match family manifest`);
        }
      }
      for (const expected of store.files || []) {
        const deployed = path.join(kbDir, path.basename(expected.path));
        if (!fs.existsSync(deployed)) {
          failures.push(`${store.name}: missing sidecar ${path.basename(expected.path)}`);
          continue;
        }
        const stat = fs.statSync(deployed);
        if (stat.size !== expected.bytes) failures.push(`${store.name}: ${path.basename(expected.path)} bytes ${stat.size} != ${expected.bytes}`);
        const digest = sha256File(deployed);
        if (digest !== expected.sha256) failures.push(`${store.name}: ${path.basename(expected.path)} sha256 ${digest} != ${expected.sha256}`);
      }
    }
  }
  return failures;
}

export function verifyOverlayRegistration({ overlay, kbDir, manifestsDir }) {
  const failures = [];
  const aliases = readJson(path.join(kbDir, 'repo-aliases.json'));
  const generations = readJson(path.join(kbDir, 'RVF-GENERATIONS.json'));
  const source = readJson(path.join(kbDir, 'SOURCE.json'));
  const custom = readJson(path.join(manifestsDir, 'custom-stores.json'));
  const cardsFile = path.join(kbDir, 'capability-cards.md');
  const cards = cardDocument(fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '').sections;

  for (const [name, expected] of Object.entries(overlay.repoAliases)) {
    if (!sameJson(aliases[name], expected)) failures.push(`repo-aliases.json mismatch: ${name}`);
  }
  for (const [name, expected] of Object.entries(overlay.generations.stores)) {
    if (!sameJson(generations.stores?.[name], expected)) failures.push(`RVF-GENERATIONS.json mismatch: ${name}`);
  }
  for (const [name, expected] of Object.entries(overlay.sourceStores)) {
    if (!sameJson(source.stores?.[name], expected)) failures.push(`SOURCE.json mismatch: ${name}`);
  }
  for (const expected of overlay.customStores) {
    const actual = custom.stores?.find((store) => store.name === expected.name);
    if (!sameJson(actual, expected)) failures.push(`custom-stores.json mismatch: ${expected.name}`);
  }
  for (const [name, expected] of Object.entries(overlay.capabilityCards || {})) {
    if (cards.get(name) !== expected) failures.push(`capability-cards.md mismatch: ${name}`);
  }
  for (const name of Object.keys(overlay.manifestDigests)) {
    const file = path.join(manifestsDir, name);
    if (!fs.existsSync(file)) failures.push(`live manifest missing: ${name}`);
    else if (sha256File(file) !== overlay.manifestDigests[name]) failures.push(`live manifest digest mismatch: ${name}`);
  }
  return failures;
}

function backupFiles({ kbDir, manifestsDir, backupDir, overlay }) {
  if (fs.existsSync(backupDir)) throw new Error(`backup directory already exists: ${backupDir}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of ['repo-aliases.json', 'RVF-GENERATIONS.json', 'SOURCE.json', 'capability-cards.md']) {
    fs.copyFileSync(path.join(kbDir, name), path.join(backupDir, name));
  }
  fs.copyFileSync(path.join(manifestsDir, 'custom-stores.json'), path.join(backupDir, 'custom-stores.json'));
  for (const name of Object.keys(overlay.manifestDigests)) {
    const source = path.join(manifestsDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupDir, name));
  }
}

function restoreBackup({ kbDir, manifestsDir, backupDir, overlay }) {
  for (const name of ['repo-aliases.json', 'RVF-GENERATIONS.json', 'SOURCE.json', 'capability-cards.md']) {
    fs.copyFileSync(path.join(backupDir, name), path.join(kbDir, name));
  }
  fs.copyFileSync(path.join(backupDir, 'custom-stores.json'), path.join(manifestsDir, 'custom-stores.json'));
  for (const name of Object.keys(overlay.manifestDigests)) {
    const backup = path.join(backupDir, name);
    const target = path.join(manifestsDir, name);
    if (fs.existsSync(backup)) fs.copyFileSync(backup, target);
    else if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

function collision(actual, target, prior) {
  const normalizedActual = actual == null ? null : actual;
  const normalizedPrior = prior == null ? null : prior;
  return !sameJson(normalizedActual, target) && !sameJson(normalizedActual, normalizedPrior);
}

function assertExpectedPredecessor({ overlay, kbDir, manifestsDir }) {
  const aliases = readJson(path.join(kbDir, 'repo-aliases.json'));
  const generations = readJson(path.join(kbDir, 'RVF-GENERATIONS.json'));
  const source = readJson(path.join(kbDir, 'SOURCE.json'));
  const custom = readJson(path.join(manifestsDir, 'custom-stores.json'));
  const customByName = Object.fromEntries((custom.stores || []).map((entry) => [entry.name, entry]));
  const cards = cardDocument(fs.readFileSync(path.join(kbDir, 'capability-cards.md'), 'utf8')).sections;
  const checks = [
    ['repo-aliases.json', overlay.repoAliases, overlay.priorState?.repoAliases || {}, aliases],
    ['RVF-GENERATIONS.json', overlay.generations.stores, overlay.priorState?.generationStores || {}, generations.stores || {}],
    ['SOURCE.json', overlay.sourceStores, overlay.priorState?.sourceStores || {}, source.stores || {}],
    ['custom-stores.json', Object.fromEntries(overlay.customStores.map((entry) => [entry.name, entry])), overlay.priorState?.customStores || {}, customByName],
    ['capability-cards.md', overlay.capabilityCards || {}, overlay.priorState?.capabilityCards || {}, Object.fromEntries(cards)],
  ];
  for (const [label, targets, priors, actuals] of checks) {
    for (const [name, target] of Object.entries(targets)) {
      if (collision(actuals[name], target, priors[name])) throw new Error(`${label} unexpected collision: ${name}`);
    }
  }
  for (const [name, targetDigest] of Object.entries(overlay.manifestDigests)) {
    const file = path.join(manifestsDir, name);
    const actualDigest = fs.existsSync(file) ? sha256File(file) : null;
    const priorDigest = overlay.liveManifestDigests?.[name] ?? null;
    if (collision(actualDigest, targetDigest, priorDigest)) throw new Error(`manifest unexpected collision: ${name}`);
  }
}

export function applyOverlay({ overlay, kbDir, manifestsDir, backupDir, overlayDir = HERE, injectFailure = () => {} }) {
  const artifactFailures = verifyOverlayArtifacts({ overlay, kbDir, overlayDir });
  if (artifactFailures.length) throw new Error(`artifact preflight failed:\n${artifactFailures.join('\n')}`);
  assertExpectedPredecessor({ overlay, kbDir, manifestsDir });
  backupFiles({ kbDir, manifestsDir, backupDir, overlay });
  try {
    const aliases = readJson(path.join(kbDir, 'repo-aliases.json'));
    Object.assign(aliases, overlay.repoAliases);
    atomicJson(path.join(kbDir, 'repo-aliases.json'), aliases);
    injectFailure('repo-aliases');

    const generations = readJson(path.join(kbDir, 'RVF-GENERATIONS.json'));
    generations.stores = { ...generations.stores, ...overlay.generations.stores };
    atomicJson(path.join(kbDir, 'RVF-GENERATIONS.json'), generations);
    injectFailure('generations');

    const source = readJson(path.join(kbDir, 'SOURCE.json'));
    source.stores = { ...source.stores, ...overlay.sourceStores };
    atomicJson(path.join(kbDir, 'SOURCE.json'), source);
    injectFailure('source');

    const custom = readJson(path.join(manifestsDir, 'custom-stores.json'));
    const names = new Set(overlay.customStores.map((store) => store.name));
    custom.stores = [...(custom.stores || []).filter((store) => !names.has(store.name)), ...overlay.customStores];
    atomicJson(path.join(manifestsDir, 'custom-stores.json'), custom);
    injectFailure('custom-stores');

    const cardsFile = path.join(kbDir, 'capability-cards.md');
    const cards = cardDocument(fs.readFileSync(cardsFile, 'utf8'));
    for (const [name, section] of Object.entries(overlay.capabilityCards || {})) cards.sections.set(name, section);
    atomicText(cardsFile, renderCardDocument(cards));
    injectFailure('capability-cards');

    for (const { name, file } of manifestPaths(overlayDir)) {
      fs.copyFileSync(file, path.join(manifestsDir, name));
      injectFailure(`manifest:${name}`);
    }

    const failures = verifyOverlayRegistration({ overlay, kbDir, manifestsDir });
    if (failures.length) throw new Error(`post-apply verification failed:\n${failures.join('\n')}`);
    return { backupDir, stores: Object.keys(overlay.generations.stores) };
  } catch (error) {
    restoreBackup({ kbDir, manifestsDir, backupDir, overlay });
    throw new Error(`${error.message}\nRolled back from ${backupDir}`);
  }
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2] || 'check';
  const kbDir = path.resolve(arg('--kb-dir', process.cwd()));
  const manifestsDir = path.resolve(arg('--manifests-dir', path.join(path.dirname(kbDir), 'manifests')));
  const overlayFile = path.resolve(arg('--overlay', path.join(HERE, 'registry.json')));

  if (command === 'capture') {
    const output = path.resolve(arg('--out', overlayFile));
    atomicJson(output, captureOverlay({ kbDir, manifestsDir }));
    console.log(JSON.stringify({ ok: true, command, output }));
    return;
  }

  const overlay = readJson(overlayFile);
  if (command === 'check') {
    const failures = [
      ...verifyOverlayArtifacts({ overlay, kbDir }),
      ...verifyOverlayRegistration({ overlay, kbDir, manifestsDir }),
    ];
    console.log(JSON.stringify({ ok: failures.length === 0, command, stores: Object.keys(overlay.generations.stores).length, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
    return;
  }
  if (command === 'apply') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.resolve(arg('--backup-dir', path.join(path.dirname(kbDir), 'backups', `qwntik-rvf-overlay-${stamp}`)));
    console.log(JSON.stringify({ ok: true, command, ...applyOverlay({ overlay, kbDir, manifestsDir, backupDir }) }, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
