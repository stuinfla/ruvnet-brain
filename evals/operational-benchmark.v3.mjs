import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { OPERATIONAL_FIXTURES as V2_FIXTURES } from './operational-benchmark.v2.mjs';

// Keep all v2 query text fixed, but make v3's source oracle a separate, independently frozen input.
export const OPERATIONAL_FIXTURES_V3 = [
  ...V2_FIXTURES.map(({ id, class: fixtureClass, query }) => ({ id, class: fixtureClass, query })),
  { id: 'doctor-local-vector-storage', class: 'broad', query: 'How should I store embeddings in this project without running a server?' },
  { id: 'broad-cross-project-discovery', class: 'broad', query: 'How can agents carry useful learning from one project to another?' },
];

const HEX64 = /^[a-f0-9]{64}$/;
const REPO = /^[a-z0-9][a-z0-9._-]*$/i;
const ORACLE_CATALOG = 'evals/oracles/operational-source-oracles.v3.json';
const ARCHIVE_MANIFEST = 'ARCHIVE-MANIFEST.json';
const SOURCE_MANIFEST = 'SOURCE.json';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isRegularFile = (file) => {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); }
  catch { return false; }
};

function validRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.startsWith('/') && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function asFixtureMap(fixtures) { return new Map(fixtures.map((fixture) => [fixture.id, fixture])); }

async function readExactPassage(kbDir, alternative) {
  const candidates = [`${alternative.repo}.passages.jsonl`, `${alternative.repo}.big.passages.jsonl`];
  let firstMismatch = null;
  const sourceRowsByStore = [];
  for (const name of candidates) {
    const file = path.join(kbDir, name);
    if (!isRegularFile(file)) continue;
    const rows = [];
    const input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of input) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.path === alternative.path && typeof record.text === 'string') {
          rows.push(record.text);
          firstMismatch ??= { record, file, storeSha256: await hashFile(file) };
        }
      }
    } finally { input.close(); }
    if (rows.some((text) => sha256(text) === alternative.passageSha256)) {
      sourceRowsByStore.push({ file, storeSha256: await hashFile(file), rows });
    }
  }
  const witness = sourceRowsByStore.flatMap((store) => store.rows.map((text) => ({ text, store })))
    .find(({ text }) => sha256(text) === alternative.passageSha256);
  if (!witness) return firstMismatch;
  return { record: { text: witness.text }, file: witness.store.file,
    storeSha256: witness.store.storeSha256, sourceRowsByStore };
}

/** Accept only exact source bytes: contiguous text, newline-joined rows, or ordered verbatim paragraphs. */
export function isVerbatimSourceProjection(returnedText, sourceRowsByStore = []) {
  if (typeof returnedText !== 'string' || !returnedText.length || !sourceRowsByStore.length) return false;
  for (const { rows } of sourceRowsByStore) {
    if (!Array.isArray(rows)) continue;
    if (rows.join('\n').includes(returnedText)) return true;
    // The runtime can join complete retrieved rows in ranking order rather than file order.
    // Accept only exact whole rows, each at most once, with the runtime's newline separator.
    const remaining = rows.filter((row) => typeof row === 'string' && row.length).sort((a, b) => b.length - a.length);
    let offset = 0;
    while (remaining.length) {
      const index = remaining.findIndex((row) => returnedText.startsWith(row, offset));
      if (index < 0) break;
      offset += remaining.splice(index, 1)[0].length;
      if (offset === returnedText.length) return true;
      if (returnedText[offset] !== '\n') break;
      offset += 1;
    }
    const sourceParagraphs = rows.flatMap((row) => row.split(/\r?\n+/)).filter(Boolean);
    const returnedParagraphs = returnedText.split(/\r?\n+/).filter(Boolean);
    if (returnedParagraphs.length < 2) continue;
    let cursor = 0;
    const ordered = returnedParagraphs.every((paragraph) => {
      for (let index = cursor; index < sourceParagraphs.length; index += 1) {
        if (sourceParagraphs[index].includes(paragraph)) { cursor = index + 1; return true; }
      }
      return false;
    });
    if (ordered) return true;
  }
  return false;
}

const storeHashes = new Map();
async function hashFile(file) {
  if (!storeHashes.has(file)) {
    storeHashes.set(file, (async () => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    })());
  }
  return storeHashes.get(file);
}

/** Validate catalog shape and its claims against the actual source corpus before any retrieval. */
export async function preflightOperationalOracle({ fixtures = OPERATIONAL_FIXTURES_V3, catalog,
  catalogPath = null, kbDir } = {}) {
  const outcomes = new Map();
  const fixtureMap = asFixtureMap(fixtures);
  const failAll = (status, reason) => fixtures.forEach((fixture) => outcomes.set(fixture.id, { status, reason }));
  if (!catalog || catalog.schema !== 'operational-source-oracles/v3'
    || !catalog.corpus || !HEX64.test(String(catalog.corpus.archiveManifestSha256 || ''))
    || !HEX64.test(String(catalog.corpus.sourceManifestSha256 || '')) || !Array.isArray(catalog.fixtures)) {
    failAll('INVALID_ORACLE', 'catalog schema, corpus pins, or fixture list is invalid');
    return outcomes;
  }
  const entries = new Map();
  for (const entry of catalog.fixtures) {
    if (!entry || typeof entry.id !== 'string' || entries.has(entry.id) || !fixtureMap.has(entry.id)
      || !Array.isArray(entry.claimSlots)) {
      failAll('INVALID_ORACLE', 'catalog has an unknown, duplicate, or malformed fixture entry');
      return outcomes;
    }
    entries.set(entry.id, entry);
  }
  if (entries.size !== fixtures.length || fixtures.some(({ id }) => !entries.has(id))) {
    for (const fixture of fixtures) outcomes.set(fixture.id, entries.has(fixture.id)
      ? { status: 'INVALID_ORACLE', reason: 'catalog contains a fixture set different from the frozen query suite' }
      : { status: 'INVALID_ORACLE', reason: 'fixture is absent from the frozen oracle catalog' });
    return outcomes;
  }

  if (!kbDir || !isRegularFile(path.join(kbDir, ARCHIVE_MANIFEST)) || !isRegularFile(path.join(kbDir, SOURCE_MANIFEST))) {
    failAll('CORPUS_GAP', 'mounted corpus lacks ARCHIVE-MANIFEST.json or SOURCE.json');
    return outcomes;
  }
  const [archiveManifestSha256, sourceManifestSha256] = await Promise.all([
    hashFile(path.join(kbDir, ARCHIVE_MANIFEST)), hashFile(path.join(kbDir, SOURCE_MANIFEST)),
  ]);
  if (archiveManifestSha256 !== catalog.corpus.archiveManifestSha256
    || sourceManifestSha256 !== catalog.corpus.sourceManifestSha256) {
    failAll('CORPUS_GAP', 'mounted corpus manifest bytes do not match the independently frozen archive/source identity');
    return outcomes;
  }

  for (const fixture of fixtures) {
    const entry = entries.get(fixture.id);
    const answerable = fixture.class === 'broad' || fixture.class === 'named';
    if (!entry.claimSlots.length) {
      outcomes.set(fixture.id, answerable
        ? (typeof entry.unavailableReason === 'string' && entry.unavailableReason.trim()
          ? { status: 'CORPUS_GAP', reason: entry.unavailableReason }
          : { status: 'INVALID_ORACLE', reason: 'answerable fixture has neither claim slots nor an explicit gap' })
        : { status: 'PASS', reason: 'negative/ambiguity control has no positive fact oracle' });
      continue;
    }
    if (!answerable || entry.unavailableReason !== undefined) {
      outcomes.set(fixture.id, { status: 'INVALID_ORACLE', reason: 'non-answerable or unavailable fixture cannot carry claim slots' });
      continue;
    }
    const slotIds = new Set();
    let malformed = false;
    let missingSource = false;
    const resolvedSlots = [];
    for (const slot of entry.claimSlots) {
      if (!slot || typeof slot.id !== 'string' || slotIds.has(slot.id) || !Array.isArray(slot.alternatives)
        || !slot.alternatives.length) { malformed = true; break; }
      slotIds.add(slot.id);
      const resolvedAlternatives = [];
      for (const alt of slot.alternatives) {
        if (!alt || !REPO.test(String(alt.repo || '')) || !validRelativePath(alt.path)
          || !HEX64.test(String(alt.passageSha256 || '')) || !Array.isArray(alt.spans)
          || !alt.spans.length || alt.spans.some((span) => typeof span !== 'string' || !span.trim())) {
          malformed = true;
          break;
        }
        const found = await readExactPassage(kbDir, alt);
        if (!found) { missingSource = true; continue; }
        const passageSha256 = sha256(found.record.text);
        if (passageSha256 !== alt.passageSha256) { malformed = true; break; }
        if (!alt.spans.every((span) => found.record.text.includes(span))) { malformed = true; break; }
        resolvedAlternatives.push({ ...alt, passageSha256, storedText: found.record.text,
          sourceRowsByStore: found.sourceRowsByStore.map((store) => ({
            store: path.basename(store.file), storeSha256: store.storeSha256, rows: store.rows,
          })),
          store: path.basename(found.file), storeSha256: found.storeSha256 });
      }
      if (malformed) break;
      resolvedSlots.push({ id: slot.id, alternatives: resolvedAlternatives });
    }
    if (malformed) outcomes.set(fixture.id, { status: 'INVALID_ORACLE', reason: 'oracle spans or passage digest do not match their exact stored source bytes' });
    else if (resolvedSlots.some((slot) => !slot.alternatives.length)) outcomes.set(fixture.id,
      { status: 'CORPUS_GAP', reason: 'no reviewed source alternative for one or more required claim slots exists in the pinned corpus' });
    else outcomes.set(fixture.id, { status: 'PASS', resolvedSlots });
  }
  return outcomes;
}

export function gradeOperationalFixtureV3(fixture, { output, verification, sourceSupport, processOk,
  preflightStatus }) {
  if (!processOk) return { pass: false, status: 'RETRIEVAL_MISS', reason: 'retrieval process failed or timed out' };
  if (preflightStatus !== 'PASS') return { pass: false, status: preflightStatus, reason: 'source oracle preflight did not pass' };
  const citations = verification?.citations ?? [];
  if (fixture.class === 'negative' || fixture.class === 'ambiguity') {
    // The runtime emits its structured confidence grade before result blocks. Inspect only that
    // preamble so retrieved document text cannot spoof an abstention with a matching phrase.
    const preamble = String(output ?? '').split(/^#\d+\s+repo=/m, 1)[0];
    const explicitRefusal = /^⚠ EVIDENCE: INSUFFICIENT_EVIDENCE \(top score (?:null|-?\d+(?:\.\d+)?)\) — .+$/m.test(preamble);
    const noPositiveCitation = citations.every((citation) => typeof citation.ce === 'number' && citation.ce < 0);
    const pass = explicitRefusal && noPositiveCitation;
    return { pass, status: pass ? 'PASS' : 'RETRIEVAL_MISS', abstained: pass,
      reason: 'negative and ambiguous controls require explicit uncertainty with no positive citation' };
  }
  const matchedSlots = sourceSupport?.slots?.filter((slot) => slot.supported).map(({ id }) => id) ?? [];
  const preamble = String(output ?? '').split(/^#\d+\s+repo=/m, 1)[0];
  const abstained = /^⚠ EVIDENCE: INSUFFICIENT_EVIDENCE\b/m.test(preamble);
  const pass = !abstained && !!verification?.grounded && sourceSupport?.allSlotsSupported === true;
  return { pass, status: pass ? 'PASS' : 'RETRIEVAL_MISS', grounded: !!verification?.grounded,
    allClaimSlotsSupported: sourceSupport?.allSlotsSupported === true, matchedSlots,
    receipt: verification?.receipt ?? null };
}

/** Match AND claim slots; each slot is satisfied by one independently frozen OR alternative. */
export function matchClaimSlots(preflight, verification) {
  const citations = verification?.citations ?? [];
  const slots = (preflight?.resolvedSlots ?? []).map((slot) => {
    const matched = slot.alternatives.find((alt) => citations.some((citation) => {
      if (citation.repo !== alt.repo || citation.docPath !== alt.path) return false;
      const returnedText = typeof citation.returnedText === 'string' ? citation.returnedText : '';
      // Each required excerpt must occur both in the independently SHA-bound stored witness and
      // in this citation block's returned body. The whole passage need not be returned, but path
      // existence and a parser-supplied proof label alone prove nothing.
      if (!alt.spans.every((span) => alt.storedText.includes(span) && returnedText.includes(span))) return false;
      if (!isVerbatimSourceProjection(returnedText, alt.sourceRowsByStore)) return false;
      // Source validation above is identical for old and new unscored source-card lanes.
      // Runtime proof labels are descriptive, never an authority or version discriminator.
      return citation.ce === null || (Number.isFinite(citation.ce) && citation.ce >= 0);
    }));
    return { id: slot.id, supported: !!matched, alternative: matched ?? null };
  });
  return { slots, allSlotsSupported: slots.length > 0 && slots.every((slot) => slot.supported) };
}

export { ORACLE_CATALOG };
