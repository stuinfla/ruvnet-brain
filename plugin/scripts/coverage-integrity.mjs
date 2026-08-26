import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX_GIST = /^[a-f0-9]{20,64}$/;
export const PUBLIC_GENERATIONS_FILE = 'PUBLIC-RVF-GENERATIONS.json';
export const RUNTIME_GENERATIONS_FILE = 'RVF-GENERATIONS.json';
export const INSTALLED_PROFILE_FILE = 'INSTALLED-PROFILE.json';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function validateLegacyGistAggregateReceipt({ receipt, passagesFile, expectedIds }) {
  const ids = Object.keys(receipt?.gists || {});
  if (receipt?.schemaVersion !== 2 || receipt?.owner !== 'ruvnet' || !ids.length
    || (expectedIds && canonicalJson([...ids].sort()) !== canonicalJson([...expectedIds].map(String).sort()))) {
    throw new Error('legacy gist aggregate receipt is malformed or has the wrong gist set');
  }
  for (const id of ids) {
    const row = receipt.gists[id];
    const files = row?.files;
    if (!HEX_GIST.test(id) || !/^[a-f0-9]{40}$/.test(String(row?.versionSha || ''))
      || !Array.isArray(files) || !files.length
      || files.some((file) => typeof file?.filename !== 'string' || !file.filename
        || (file.included === true
          ? !HEX64.test(String(file.sha256 || '')) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
          : file.included !== false || typeof file.reason !== 'string' || !file.reason
            || !Number.isSafeInteger(file.size) || file.size < 0))
      // Schema 2 was generated with JSON.stringify(array), before the
      // canonical-json contract was introduced for schema 3. Preserve that
      // historical receipt format while keeping the stricter contract below.
      || row.contentDigest !== crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')) {
      throw new Error(`legacy gist ${id} receipt is incomplete or internally inconsistent`);
    }
  }
  let passagesStat = null;
  try { passagesStat = fs.lstatSync(passagesFile); } catch { /* handled below */ }
  if (!passagesStat?.isFile() || passagesStat.isSymbolicLink()
    || !HEX64.test(String(receipt.passagesSha256 || ''))
    || receipt.passagesSha256 !== sha256File(passagesFile)) {
    throw new Error('legacy gist aggregate receipt does not bind its passage bytes');
  }
  return receipt;
}

export function validateGistAggregateReceipt({ receipt, passagesFile, expectedIds = null,
  sourceObservationSha256 = null }) {
  if (receipt?.schemaVersion === 2 && sourceObservationSha256 === null) {
    return validateLegacyGistAggregateReceipt({ receipt, passagesFile, expectedIds });
  }
  if (receipt?.schemaVersion !== 3 || receipt?.kind !== 'ruvnet-brain-gist-source-receipts'
    || !receipt.gists || typeof receipt.gists !== 'object' || Array.isArray(receipt.gists)
    || !HEX64.test(String(receipt.sourceObservationSha256 || ''))) {
    throw new Error('gist aggregate receipt schema or observation identity is invalid');
  }
  if (sourceObservationSha256 !== null && receipt.sourceObservationSha256 !== sourceObservationSha256) {
    throw new Error('gist aggregate receipt observation differs from coverage');
  }
  const ids = Object.keys(receipt.gists);
  if (!ids.length || ids.some((id) => !HEX_GIST.test(id))
    || canonicalJson(ids) !== canonicalJson([...ids].sort())
    || (expectedIds && canonicalJson(ids) !== canonicalJson([...expectedIds].map(String).sort()))
    || receipt.gistSet?.count !== ids.length || receipt.gistSet?.idsSha256 !== digest(ids)
    || receipt.gistSet?.observationSha256 !== receipt.sourceObservationSha256) {
    throw new Error('gist aggregate receipt does not bind the exact sorted gist set');
  }
  for (const id of ids) {
    const row = receipt.gists[id];
    const files = row?.files;
    const filenames = Array.isArray(files) ? files.map((file) => file?.filename) : [];
    if (row?.schemaVersion !== 3 || row?.kind !== 'ruvnet-brain-gist-source-receipt'
      || row.gistId !== id || row.complete !== true || !/^[a-f0-9]{40}$/.test(String(row.versionSha || ''))
      || !Array.isArray(files) || !files.length || row.fileCount !== files.length
      || canonicalJson(filenames) !== canonicalJson([...filenames].sort())
      || new Set(filenames).size !== filenames.length
      || files.some((file) => typeof file?.filename !== 'string' || !file.filename
        || (file.included === true
          ? !HEX64.test(String(file.sha256 || '')) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
          : file.included !== false || typeof file.reason !== 'string' || !file.reason
            || !(file.size === null || (Number.isSafeInteger(file.size) && file.size >= 0))))
      || row.contentDigest !== digest(files)) {
      throw new Error(`gist ${id} receipt is incomplete or internally inconsistent`);
    }
    const { receiptSha256, ...payload } = row;
    if (!HEX64.test(String(receiptSha256 || '')) || receiptSha256 !== digest(payload)) {
      throw new Error(`gist ${id} receipt digest differs`);
    }
  }
  const sourceSet = ids.map((id) => ({ id, receiptSha256: receipt.gists[id].receiptSha256 }));
  if (receipt.sourceSetSha256 !== digest(sourceSet)) throw new Error('gist source set digest differs');
  let passagesStat = null;
  try { passagesStat = fs.lstatSync(passagesFile); } catch { /* handled below */ }
  if (!passagesFile || !passagesStat?.isFile() || passagesStat.isSymbolicLink()
    || !HEX64.test(String(receipt.passagesSha256 || ''))
    || receipt.passagesSha256 !== sha256File(passagesFile)) {
    throw new Error('gist aggregate receipt does not bind its passage bytes');
  }
  const { receiptSha256, ...payload } = receipt;
  if (!HEX64.test(String(receiptSha256 || '')) || receiptSha256 !== digest(payload)) {
    throw new Error('gist aggregate receipt digest differs');
  }
  return receipt;
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

const readJson = (file, label) => {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted regular file`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is unreadable: ${error.message}`); }
};

function containedRegular(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/).includes('..')) throw new Error(`${label} path escapes the public inventory root`);
  const resolved = path.resolve(root, relative);
  const within = path.relative(root, resolved);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`${label} path escapes the public inventory root`);
  }
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted regular file`);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(resolved);
  const realWithin = path.relative(realRoot, realFile);
  if (!realWithin || realWithin.startsWith('..') || path.isAbsolute(realWithin)) {
    throw new Error(`${label} resolves outside the public inventory root`);
  }
  return resolved;
}

function evidenceIdentity(root, file, kind) {
  return {
    kind,
    path: path.relative(root, file).split(path.sep).join('/'),
    sha256: sha256File(file),
    bytes: fs.statSync(file).size,
  };
}

const canonicalStores = (root) => {
  const stores = [];
  for (const name of fs.readdirSync(root).filter((entry) => !entry.startsWith('._'))) {
    const store = name.match(/^(.+)\.big\.rvf$/)?.[1];
    if (!store) continue;
    const stat = fs.lstatSync(path.join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${store} canonical RVF is not a trusted regular file`);
    stores.push(store);
  }
  const folded = stores.map((store) => store.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new Error('canonical RVF store names have case-fold aliases');
  return stores.sort();
};

export function projectPublicGenerationLedger({ ledger, publicStores, version, sourceSnapshot }) {
  if (!ledger?.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
    throw new Error('generation ledger stores are malformed');
  }
  if (typeof version !== 'string' || !version) throw new Error('public generation ledger version is missing');
  if (!HEX40.test(String(sourceSnapshot || ''))) throw new Error('public generation ledger source snapshot is invalid');
  const names = [...publicStores].map(String).sort();
  if (!names.length || new Set(names).size !== names.length) {
    throw new Error('public generation ledger store set is empty or duplicated');
  }
  const stores = {};
  for (const name of names) {
    if (!ledger.stores[name]) throw new Error(`generation ledger is missing public store ${name}`);
    stores[name] = structuredClone(ledger.stores[name]);
  }
  return {
    schemaVersion: 2,
    kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: version,
    releaseTag: `v${version}`,
    sourceSnapshot,
    stores,
  };
}

export function generationLedgerBytes(ledger) {
  return Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
}

export function validatePublicInventory({ assetsDir, coverage, ledger, installedPublicStores = null }) {
  const root = path.resolve(assetsDir);
  const selected = installedPublicStores === null ? null : [...installedPublicStores].map((store) => String(store).toLowerCase());
  if (selected && (selected.some((store) => !store) || new Set(selected).size !== selected.length)) {
    throw new Error('installed public store selection is missing or duplicated');
  }
  const selectedSet = selected === null ? null : new Set(selected);
  if (!Array.isArray(coverage?.rows) || !ledger?.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
    throw new Error('coverage rows or generation ledger stores are malformed');
  }
  const fence = readJson(path.join(root, 'PRIVATE-STORES.json'), 'private fence');
  if (!Array.isArray(fence.privateStores)) throw new Error('private fence has no privateStores array');
  const privateStores = fence.privateStores.map((store) => String(store).toLowerCase());
  if (privateStores.some((store) => !store) || new Set(privateStores).size !== privateStores.length) {
    throw new Error('private fence stores are missing or duplicated');
  }
  const privateSet = new Set(privateStores);
  const evidenceFiles = [];
  const uniqueStores = (rows, family) => {
    const stores = rows.map((row) => String(row?.artifact?.store || '').toLowerCase());
    if (stores.some((store) => !store) || new Set(stores).size !== stores.length) throw new Error(`${family} stores are missing or duplicated`);
    return stores.sort();
  };
  const repos = coverage.rows.filter((row) => row.kind === 'repository' && row.disposition === 'eligible');
  if (repos.some((row) => row.status !== 'CURRENT')) throw new Error('an eligible repository is not CURRENT');
  const repositories = uniqueStores(repos, 'repository');
  const excludedRepositories = uniqueStores(coverage.rows.filter((row) => row.kind === 'repository'
    && row.disposition !== 'eligible'), 'excluded repository');
  const excludedSet = new Set(excludedRepositories);
  if (repositories.some((store) => excludedSet.has(store))) throw new Error('eligible and excluded repository stores overlap');
  const gists = coverage.rows.filter((row) => row.kind === 'gist' && row.disposition === 'eligible');
  if (gists.some((row) => row.status !== 'CURRENT')) throw new Error('an eligible gist is not CURRENT');
  let gistAggregate = null;
  if (gists.length) {
    const gistStores = new Set(gists.map((row) => String(row?.artifact?.store || '').toLowerCase()));
    if (gistStores.size !== 1 || !gistStores.has('ruv-gists')) throw new Error('eligible gists must use the ruv-gists aggregate');
    if (!selectedSet || selectedSet.has('ruv-gists')) {
      const receiptFile = path.join(root, 'ruv-gists.sources.json');
      const receipt = readJson(receiptFile, 'gist aggregate receipt');
      const passages = path.join(root, 'ruv-gists.passages.jsonl');
      const ids = gists.map((row) => String(row.key || '').replace(/^gist:/, ''));
      if (ids.some((id) => !id)) throw new Error('gist coverage row identity is missing');
      validateGistAggregateReceipt({ receipt, passagesFile: passages, expectedIds: ids,
        sourceObservationSha256: coverage.sourceObservationSha256 });
      evidenceFiles.push(evidenceIdentity(root, passages, 'gist-passages'));
      evidenceFiles.push(evidenceIdentity(root, receiptFile, 'gist-receipt'));
    }
    gistAggregate = 'ruv-gists';
  }
  const classesFile = path.join(root, 'public-store-classes.json');
  const classes = readJson(classesFile, 'public store classes');
  evidenceFiles.push(evidenceIdentity(root, classesFile, 'class-registry'));
  if (classes.schemaVersion !== 1 || !Array.isArray(classes.derived)) throw new Error('derived store classes are malformed');
  const derived = classes.derived.map((entry) => String(entry?.store || '').toLowerCase()).sort();
  if (derived.some((store) => !store) || new Set(derived).size !== derived.length) throw new Error('derived stores are missing or duplicated');
  for (const entry of classes.derived) {
    const store = String(entry.store || '').toLowerCase();
    if (selectedSet && !selectedSet.has(store)) continue;
    const receiptFile = containedRegular(root, entry.receipt, `derived ${store} receipt`);
    const receipt = readJson(receiptFile, `derived ${store} receipt`);
    const passages = containedRegular(root, `${store}.passages.jsonl`, `derived ${store} passages`);
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'ruvnet-brain-derived-store-receipt'
      || String(receipt.store || '').toLowerCase() !== store || !Array.isArray(receipt.inputs) || receipt.inputs.length === 0
      || !HEX64.test(String(receipt.passagesSha256 || '')) || receipt.passagesSha256 !== sha256File(passages)) {
      throw new Error(`derived ${store} receipt does not bind its passage bytes`);
    }
    for (const input of receipt.inputs) {
      let inputFile = null;
      try { inputFile = containedRegular(root, input?.path, `derived ${store} input`); } catch { /* handled below */ }
      if (!inputFile || !HEX64.test(String(input.sha256 || '')) || input.sha256 !== sha256File(inputFile)) {
        throw new Error(`derived ${store} input receipt differs from ${input?.path || '(missing)'}`);
      }
      evidenceFiles.push(evidenceIdentity(root, inputFile, 'derived-input'));
    }
    evidenceFiles.push(evidenceIdentity(root, passages, 'derived-passages'));
    evidenceFiles.push(evidenceIdentity(root, receiptFile, 'derived-receipt'));
  }
  const expected = [...repositories, ...(gistAggregate ? [gistAggregate] : []), ...derived].sort();
  if (new Set(expected).size !== expected.length) throw new Error('public store classes overlap');
  const excludedCollision = expected.filter((store) => excludedSet.has(store));
  if (excludedCollision.length) throw new Error(`excluded/public store collision: ${excludedCollision.join(', ')}`);
  const privateCollision = expected.filter((store) => privateSet.has(store));
  if (privateCollision.length) throw new Error(`private/public store collision: ${privateCollision.join(', ')}`);
  const installedExpected = selected === null ? expected : [...selected].sort();
  if (installedExpected.some((store) => !expected.includes(store))) throw new Error('installed profile selects an unknown public store');
  const actual = canonicalStores(root).filter((store) => !privateSet.has(store.toLowerCase())
    && !excludedSet.has(store.toLowerCase())).sort();
  const missing = installedExpected.filter((store) => !actual.includes(store));
  const extras = actual.filter((store) => !installedExpected.includes(store));
  if (missing.length) throw new Error(`${missing.join(', ')} public store is missing`);
  if (extras.length) throw new Error(`unclassified public stores: ${extras.join(', ')}`);
  const ledgerStores = Object.keys(ledger.stores);
  const foldedLedgerStores = ledgerStores.map((store) => store.toLowerCase());
  if (new Set(foldedLedgerStores).size !== foldedLedgerStores.length) {
    throw new Error('generation ledger store names have case-fold aliases');
  }
  const publicLedgerStores = ledgerStores.filter((store) => !privateSet.has(store.toLowerCase())
    && !excludedSet.has(store.toLowerCase())).sort();
  if (canonicalJson(publicLedgerStores) !== canonicalJson(expected)) throw new Error('public generation ledger store set differs from the inventory partition');
  for (const store of expected) {
    const generation = ledger.stores[store];
    const filename = `${store}.big.rvf`;
    const file = path.join(root, filename);
    const selected = installedExpected.includes(store);
    if (generation?.file !== filename || (selected && (generation.bytes !== fs.statSync(file).size || generation.sha256 !== sha256File(file)))) {
      throw new Error(`${store} generation record does not bind the RVF bytes`);
    }
    if (typeof generation.model !== 'string' || !generation.model.trim()
      || !Number.isInteger(generation.dimensions) || generation.dimensions <= 0
      || (generation.sourceCommit !== null && !/^[a-f0-9]{7,64}$/i.test(String(generation.sourceCommit || '')))
      || typeof generation.builtUtc !== 'string' || !Number.isFinite(Date.parse(generation.builtUtc))) {
      throw new Error(`${store} generation record provenance is incomplete`);
    }
  }
  const publicStores = expected;
  evidenceFiles.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { repositories, excludedRepositories, gistAggregate, derived, publicStores,
    installedPublicStores: installedExpected,
    evidenceFiles,
    partitionSha256: digest({ repositories, excludedRepositories, gistAggregate, derived, publicStores, evidenceFiles }) };
}

export function coverageGenerationFor({ generatorSourceSha, snapshotRoot, sourceObservationSha256 = null, rows, enumerationReceipt,
  policyDispositionDigests = [], exemptionDigests = [] }) {
  const orderedRows = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  return digest({ schemaVersion: 1, generatorSourceSha, snapshotRoot, sourceObservationSha256, orderedRows,
    enumerationReceiptDigest: digest(enumerationReceipt), policyDispositionDigests, exemptionDigests });
}

export function releaseCoverageGenerationFor(coverage) {
  const orderedRows = [...(coverage.rows || [])].sort((a, b) => a.key.localeCompare(b.key));
  return digest({
    schemaVersion: 1,
    releaseIdentity: coverage.releaseIdentity,
    corpusSeed: coverage.corpusSeed,
    corpusCoverage: coverage.corpusCoverage,
    generationLedger: coverage.generationLedger,
    publicInventoryPartitionSha256: coverage.publicInventoryPartitionSha256,
    installedProjectionSchema: coverage.installedProjectionSchema,
    generatorSourceSha: coverage.generatorSourceSha,
    snapshotRoot: coverage.snapshotRoot,
    sourceObservationSha256: coverage.sourceObservationSha256,
    orderedRows,
    totals: coverage.totals,
    enumerationReceiptDigest: digest(coverage.enumerationReceipt),
    policy: coverage.policy,
  });
}

function validateRowsAndTotals(coverage, failures) {
  const rows = Array.isArray(coverage?.rows) ? coverage.rows : [];
  if (!Array.isArray(coverage?.rows)) failures.push('rows are missing');
  const keys = rows.map((row) => row?.key);
  if (keys.some((key) => typeof key !== 'string' || !key)) failures.push('a row key is missing');
  if (new Set(keys).size !== keys.length) failures.push('row keys are duplicated');
  if (rows.some((row) => !['repository', 'gist'].includes(row?.kind)
      || typeof row?.name !== 'string' || typeof row?.url !== 'string'
      || typeof row?.status !== 'string' || typeof row?.disposition !== 'string'
      || !row?.upstream || !row?.artifact || !Array.isArray(row?.reasons))) failures.push('row shape is invalid');
  const repositoryCount = rows.filter((row) => row.kind === 'repository').length;
  const gistCount = rows.filter((row) => row.kind === 'gist').length;
  const byStatus = Object.fromEntries([...new Set(rows.map((row) => row.status))].sort()
    .map((status) => [status, rows.filter((row) => row.status === status).length]));
  if (coverage?.totals?.rows !== rows.length || coverage?.totals?.repositories !== repositoryCount
      || coverage?.totals?.gists !== gistCount || canonicalJson(coverage?.totals?.byStatus || {}) !== canonicalJson(byStatus)) {
    failures.push('totals do not match rows');
  }
  return { rows, repositoryCount, gistCount };
}

export function validateCoverageLedger(coverage) {
  const failures = [];
  if (coverage?.schemaVersion !== 1) failures.push('schemaVersion is unsupported');
  const isCorpus = coverage?.kind === 'ruvnet-brain-corpus-coverage';
  const isRelease = coverage?.kind === 'ruvnet-brain-release-coverage';
  if ((isCorpus || isRelease) && !HEX64.test(String(coverage?.sourceObservationSha256 || ''))) {
    failures.push('source observation digest is missing');
  }
  if (!HEX64.test(String(coverage?.generatorSourceSha || ''))) failures.push('generator source digest is missing');
  if (!HEX64.test(String(coverage?.snapshotRoot || ''))) failures.push('snapshot root is missing');
  const { rows, repositoryCount, gistCount } = validateRowsAndTotals(coverage, failures);
  const enumeration = coverage?.enumerationReceipt;
  if (enumeration?.schemaVersion !== 1 || enumeration?.terminal !== true || enumeration?.duplicateKeys !== 0
      || enumeration?.repositories?.expected !== repositoryCount || enumeration?.gists?.expected !== gistCount
      || !Array.isArray(enumeration?.repositories?.pages) || !Array.isArray(enumeration?.gists?.pages)) {
    failures.push('enumeration receipt is incomplete');
  }
  const policyDispositionDigests = coverage?.policy?.policyDispositionDigests;
  const exemptionDigests = coverage?.policy?.exemptionDigests;
  if (!Array.isArray(policyDispositionDigests) || !Array.isArray(exemptionDigests)
      || [...policyDispositionDigests, ...exemptionDigests].some((value) => !HEX64.test(String(value)))) {
    failures.push('policy digests are invalid');
  }
  if (isRelease) {
    const identity = coverage.releaseIdentity;
    if (!identity || !identity.version || identity.tag !== `v${identity.version}` || !HEX40.test(String(identity.sourceSnapshot || ''))) {
      failures.push('release identity is invalid');
    }
    const seed = coverage.corpusSeed;
    if (!seed || typeof seed.tag !== 'string' || !seed.tag || /latest/i.test(seed.tag)
      || !HEX64.test(String(seed.archiveSha256 || '')) || !Number.isSafeInteger(seed.archiveBytes) || seed.archiveBytes < 1
      || !HEX64.test(String(seed.receiptSha256 || ''))) failures.push('corpus seed identity is invalid');
    if (!HEX64.test(String(coverage.corpusCoverage?.sha256 || ''))
      || !HEX64.test(String(coverage.corpusCoverage?.coverageGeneration || ''))) failures.push('corpus coverage link is invalid');
    if (coverage.generationLedger?.file !== PUBLIC_GENERATIONS_FILE
      || !HEX64.test(String(coverage.generationLedger?.sha256 || ''))
      || !Number.isSafeInteger(coverage.generationLedger?.bytes) || coverage.generationLedger.bytes < 1
      || !Number.isSafeInteger(coverage.generationLedger?.storeCount) || coverage.generationLedger.storeCount < 1) {
      failures.push('generation ledger identity is invalid');
    }
    if (!HEX64.test(String(coverage.publicInventoryPartitionSha256 || ''))) failures.push('public inventory partition is invalid');
    if (coverage.installedProjectionSchema !== 2) failures.push('installed projection schema is unsupported');
    if (!failures.length && coverage.releaseCoverageGeneration !== releaseCoverageGenerationFor(coverage)) {
      failures.push('release coverage generation digest does not match the ledger');
    }
  } else if (!failures.length) {
    const expected = coverageGenerationFor({
      generatorSourceSha: coverage.generatorSourceSha,
      snapshotRoot: coverage.snapshotRoot,
      sourceObservationSha256: coverage.sourceObservationSha256 || null,
      rows,
      enumerationReceipt: enumeration,
      policyDispositionDigests,
      exemptionDigests,
    });
    if (coverage.coverageGeneration !== expected) failures.push('coverage generation digest does not match the ledger');
  }
  return { valid: failures.length === 0, failures };
}

export function validateCoverageLink({ releaseCoverage, corpusCoverage, corpusCoverageSha256 }) {
  const failures = [];
  const release = validateCoverageLedger(releaseCoverage);
  const corpus = validateCoverageLedger(corpusCoverage);
  if (!release.valid) failures.push(...release.failures.map((failure) => `release: ${failure}`));
  if (!corpus.valid || corpusCoverage?.kind !== 'ruvnet-brain-corpus-coverage') {
    failures.push(...corpus.failures.map((failure) => `corpus: ${failure}`));
    if (corpusCoverage?.kind !== 'ruvnet-brain-corpus-coverage') failures.push('corpus: wrong coverage kind');
  }
  if (releaseCoverage?.corpusCoverage?.sha256 !== corpusCoverageSha256) failures.push('corpus coverage byte digest differs');
  if (releaseCoverage?.corpusCoverage?.coverageGeneration !== corpusCoverage?.coverageGeneration) {
    failures.push('corpus coverage generation differs');
  }
  return { valid: failures.length === 0, failures };
}

/**
 * Validate the exact installed/staged projection from disk. This is the single activation-boundary
 * reader used by install, update, Console, and public proof; callers never reconstruct the linkage.
 */
export function validateCoverageDirectory(root, {
  expectedVersion = null,
  expectedSourceSnapshot = null,
  requireCompleteProfile = false,
} = {}) {
  const coverageFile = path.join(root, 'COVERAGE.json');
  const corpusFile = path.join(root, 'CORPUS-COVERAGE.json');
  const failures = [];
  if (!fs.existsSync(coverageFile)) failures.push('COVERAGE.json is missing');
  if (!fs.existsSync(corpusFile)) failures.push('CORPUS-COVERAGE.json is missing');
  if (failures.length) return { valid: false, failures, coverageFile, corpusFile };
  try {
    const coverageBytes = fs.readFileSync(coverageFile);
    const corpusBytes = fs.readFileSync(corpusFile);
    const coverage = JSON.parse(coverageBytes);
    const corpusCoverage = JSON.parse(corpusBytes);
    if (coverage.kind !== 'ruvnet-brain-release-coverage') {
      failures.push('COVERAGE.json is not bound to a product release identity');
    }
    const linked = validateCoverageLink({
      releaseCoverage: coverage,
      corpusCoverage,
      corpusCoverageSha256: crypto.createHash('sha256').update(corpusBytes).digest('hex'),
    });
    failures.push(...linked.failures);
    if (expectedVersion && coverage?.releaseIdentity?.version !== expectedVersion) {
      failures.push(`release version ${coverage?.releaseIdentity?.version || '(missing)'} differs from ${expectedVersion}`);
    }
    if (expectedSourceSnapshot && coverage?.releaseIdentity?.sourceSnapshot !== expectedSourceSnapshot) {
      failures.push(`release source snapshot ${coverage?.releaseIdentity?.sourceSnapshot || '(missing)'} differs from ${expectedSourceSnapshot}`);
    }
    let generationLedger = null;
    let runtimeGenerationLedger = null;
    let publicInventory = null;
    let installedProfile = null;
    let coverageState = 'COMPLETE';
    try {
      const ledgerFile = path.join(root, PUBLIC_GENERATIONS_FILE);
      const ledgerBytes = fs.readFileSync(ledgerFile);
      generationLedger = JSON.parse(ledgerBytes);
      if (crypto.createHash('sha256').update(ledgerBytes).digest('hex') !== coverage?.generationLedger?.sha256
        || ledgerBytes.length !== coverage?.generationLedger?.bytes) failures.push('generation ledger bytes differ from ReleaseCoverage');
      if (generationLedger.brainVersion !== coverage?.releaseIdentity?.version
        || generationLedger.releaseTag !== coverage?.releaseIdentity?.tag
        || generationLedger.sourceSnapshot !== coverage?.releaseIdentity?.sourceSnapshot
        || generationLedger.schemaVersion !== 2
        || generationLedger.kind !== 'ruvnet-brain-public-generation-ledger') {
        failures.push('generation ledger release identity differs');
      }
      const installedProfileFile = path.join(root, INSTALLED_PROFILE_FILE);
      if (fs.existsSync(installedProfileFile)) {
        installedProfile = readJson(installedProfileFile, 'installed profile receipt');
        const runtimeBytes = fs.readFileSync(path.join(root, RUNTIME_GENERATIONS_FILE));
        const selected = [...(installedProfile.selectedPublicStores || [])].sort();
        if (installedProfile.schemaVersion !== 1 || installedProfile.kind !== 'ruvnet-brain-installed-profile'
          || installedProfile.profile !== 'ruvector' || installedProfile.state !== 'PROFILED'
          || canonicalJson(selected) !== canonicalJson(['ruvector'])
          || installedProfile.immutablePublicLedger?.file !== PUBLIC_GENERATIONS_FILE
          || installedProfile.immutablePublicLedger?.sha256 !== crypto.createHash('sha256').update(ledgerBytes).digest('hex')
          || installedProfile.immutablePublicLedger?.bytes !== ledgerBytes.length
          || installedProfile.runtimeLedger?.file !== RUNTIME_GENERATIONS_FILE
          || installedProfile.runtimeLedger?.sha256 !== crypto.createHash('sha256').update(runtimeBytes).digest('hex')
          || installedProfile.runtimeLedger?.bytes !== runtimeBytes.length) {
          failures.push('installed profile receipt is invalid or does not bind the installed ledgers');
        } else {
          coverageState = 'PROFILED';
          if (requireCompleteProfile) failures.push('complete public corpus is required but the installed profile is ruvector');
        }
      }
      const selectedPublicStores = installedProfile?.selectedPublicStores || null;
      publicInventory = validatePublicInventory({ assetsDir: root, coverage, ledger: generationLedger, installedPublicStores: selectedPublicStores });
      if (publicInventory.publicStores.length !== coverage?.generationLedger?.storeCount) failures.push('generation ledger public store count differs');
      if (publicInventory.partitionSha256 !== coverage?.publicInventoryPartitionSha256) failures.push('installed public inventory partition digest differs');

      const immutableNames = Object.keys(generationLedger.stores || {}).sort();
      if (canonicalJson(immutableNames) !== canonicalJson(publicInventory.publicStores)) {
        failures.push('immutable public generation ledger contains non-public stores');
      }
      runtimeGenerationLedger = readJson(path.join(root, RUNTIME_GENERATIONS_FILE), 'runtime generation ledger');
      if (runtimeGenerationLedger.brainVersion !== coverage?.releaseIdentity?.version
        || runtimeGenerationLedger.releaseTag !== coverage?.releaseIdentity?.tag
        || runtimeGenerationLedger.sourceSnapshot !== coverage?.releaseIdentity?.sourceSnapshot
        || runtimeGenerationLedger.schemaVersion !== 2
        || runtimeGenerationLedger.kind !== 'ruvnet-brain-runtime-generation-ledger') {
        failures.push('runtime generation ledger release identity differs');
      }
      const fence = readJson(path.join(root, 'PRIVATE-STORES.json'), 'private fence');
      const privateSet = new Set((fence.privateStores || []).map((name) => String(name).toLowerCase()));
      const runtimeNames = Object.keys(runtimeGenerationLedger.stores || {});
      const runtimePublicNames = runtimeNames.filter((name) => !privateSet.has(name.toLowerCase())).sort();
      const undeclaredExtras = runtimeNames.filter((name) => !immutableNames.includes(name) && !privateSet.has(name.toLowerCase()));
      if (undeclaredExtras.length) failures.push(`runtime generation ledger has unclassified stores: ${undeclaredExtras.sort().join(', ')}`);
      const expectedRuntimePublicNames = (selectedPublicStores || immutableNames).slice().sort();
      if (canonicalJson(runtimePublicNames) !== canonicalJson(expectedRuntimePublicNames)) {
        failures.push('runtime public generation store set differs from immutable public ledger');
      } else {
        for (const name of expectedRuntimePublicNames) {
          if (canonicalJson(runtimeGenerationLedger.stores[name]) !== canonicalJson(generationLedger.stores[name])) {
            failures.push(`runtime public generation record differs for ${name}`);
          }
        }
      }
    } catch (error) { failures.push(`installed inventory: ${error.message}`); }
    return {
      valid: failures.length === 0,
      failures,
      coverage,
      corpusCoverage,
      generationLedger,
      runtimeGenerationLedger,
      publicInventory,
      installedProfile,
      coverageState,
      coverageFile,
      corpusFile,
      coverageSha256: crypto.createHash('sha256').update(coverageBytes).digest('hex'),
      corpusCoverageSha256: crypto.createHash('sha256').update(corpusBytes).digest('hex'),
    };
  } catch (error) {
    return { valid: false, failures: [`coverage projection is unreadable: ${error.message}`], coverageFile, corpusFile };
  }
}
