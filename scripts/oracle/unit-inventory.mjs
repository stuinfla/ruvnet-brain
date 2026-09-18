/**
 * scripts/oracle/unit-inventory.mjs — the parser-independent core of oracle-source-units/2.
 *
 * ADR-086:248 asks for U "meaningful source units" per repository. The EXTEND_FIRST Dual verdict
 * (2026-09-14) made that operational, and this module enforces the parts that do not depend on which
 * parsers are chosen:
 *
 *   - Every tracked entry of the pinned tree (scripts/oracle/source-tree.mjs) receives exactly ONE
 *     disposition. Nothing is skipped without a named reason.
 *   - A narrow, published exclusion list only: lockfiles, vendored dependency trees, license
 *     boilerplate, submodule pointers, symlinks, and opaque binary / LFS modality. Tests, examples,
 *     configuration, dist output and large files are NOT blanket-excluded any more.
 *   - Anything else must be claimed by an ADAPTER. Adapters are injected (their parsers are a separate
 *     decision); each returns units plus errors.
 *   - COMPLETENESS: any adapter error, or any entry no adapter supports, makes the inventory INCOMPLETE:
 *     `inventoryComplete: false`, `U: null`, and a separately named `enumeratedU` lower bound. An
 *     incomplete inventory is never sampled, because it "cannot authorize a passing C3 result".
 *   - Opaque binaries, LFS pointers, symlinks and gitlinks never count toward emptiness.
 *
 * Adapter contract:
 *   { id, version, parserIdentity, matches(entry, text) -> boolean,
 *     enumerate({ path, text, bytes }) -> { units: [{ kind, name, sourceType, startByte, endByte, startLine, endLine }],
 *                                           errors: [{ message, location }] } }
 */
import crypto from 'node:crypto';
import { validateSnapshot } from './source-tree.mjs';
import { selectUnits, DEFAULT_SEED } from './unit-sampling.mjs';

export const RULES_VERSION = 'oracle-source-units/2';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  'bun.lockb', 'go.sum', 'composer.lock', 'Gemfile.lock', 'flake.lock', 'uv.lock', 'npm-shrinkwrap.json']);
// External code vendored into the tree is outside the declared repository-source scope. `dist`, `build`
// and `target` are NOT here: the verdict removed that blanket exclusion, since sole-source distribution
// content is still the repository's own.
const VENDORED_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'vendors', 'third_party', 'third-party',
  'site-packages', '.venv', 'venv']);
const LICENSE_FILE = /^(license|licence|copying|notice|patents)(\.[a-z0-9]+)?$/i;

/** The single disposition for an entry that is decided without any adapter, or null if an adapter must decide. */
export function fixedDisposition(entry) {
  const segments = entry.path.split('/');
  const base = segments[segments.length - 1];
  if (entry.entryKind === 'gitlink') return { disposition: 'excluded', reason: 'submodule-pointer' };
  if (entry.entryKind === 'symlink') return { disposition: 'excluded', reason: 'symlink' };
  if (entry.entryKind === 'lfs-pointer') return { disposition: 'modality-excluded', reason: 'lfs-object-not-in-tree' };
  if (entry.entryKind === 'binary') return { disposition: 'modality-excluded', reason: 'opaque-binary' };
  if (segments.slice(0, -1).some((s) => VENDORED_DIRS.has(s))) return { disposition: 'excluded', reason: 'vendored-dependency' };
  if (LOCKFILES.has(base)) return { disposition: 'excluded', reason: 'lockfile' };
  if (LICENSE_FILE.test(base)) return { disposition: 'excluded', reason: 'license-boilerplate' };
  return null;
}

export function unitIdFor({ repo, path, objectSha, kind, startByte, endByte }) {
  return sha256(Buffer.from(JSON.stringify([repo, path, objectSha, kind, startByte, endByte]), 'utf8')).slice(0, 16);
}

/**
 * Build a v2 inventory from a snapshot manifest, its blob bytes and the injected adapters. Pure over its
 * inputs. `adapters` order is the published dialect precedence: the first adapter that matches claims
 * the entry.
 */
export function buildInventory({ manifest, blobs, adapters, seed = DEFAULT_SEED, dispositions = null, requireSemanticReview = false }) {
  if (!manifest?.repo || !manifest?.treeSha || !Array.isArray(manifest.entries)) {
    throw new Error('buildInventory needs a source-tree snapshot manifest');
  }
  if (dispositions && (dispositions.schemaVersion !== 1 || dispositions.kind !== 'oracle-source-dispositions'
    || dispositions.repo !== manifest.repo || dispositions.commitSha !== manifest.commitSha
    || dispositions.treeSha !== manifest.treeSha || !Array.isArray(dispositions.entries))) {
    throw new Error('semantic dispositions do not bind the exact source tree');
  }
  validateSnapshot({ manifest, blobs });
  const reviewed = new Map();
  const reviewedEntries = new Map();
  for (const row of dispositions?.entries || []) {
    if (row?.kind === 'entry') {
      if (typeof row.path !== 'string' || reviewedEntries.has(row.path) || row.disposition !== 'non-source'
        || !/^[a-f0-9]{40}$/.test(row.objectSha || '') || !/^[a-f0-9]{64}$/.test(row.bytesSha256 || '')
        || typeof row.reason !== 'string' || !row.reason.trim() || typeof row.reviewer !== 'string' || !row.reviewer.trim()) {
        throw new Error('entry disposition is malformed or duplicate');
      }
      reviewedEntries.set(row.path,row);continue;
    }
    if (!row?.unitId || reviewed.has(row.unitId) || !['eligible', 'excluded'].includes(row.disposition)
      || typeof row.path !== 'string' || !/^[a-f0-9]{40}$/.test(row.objectSha || '')
      || !/^[a-f0-9]{64}$/.test(row.bytesSha256 || '')
      || typeof row.reason !== 'string' || !row.reason.trim() || typeof row.reviewer !== 'string' || !row.reviewer.trim()) {
      throw new Error('semantic disposition is malformed or duplicate');
    }
    reviewed.set(row.unitId, row);
  }
  const pendingSemanticReview = [];
  const dispositionRows = [];
  const rows = [];
  const units = [];
  const failures = [];
  const unsupported = [];
  for (const entry of manifest.entries) {
    const fixed = fixedDisposition(entry);
    if (fixed) { rows.push({ path: entry.path, entryKind: entry.entryKind, ...fixed }); continue; }
    const bytes = blobs.get(entry.objectSha);
    if (!bytes) throw new Error(`no blob bytes for ${entry.path} (${entry.objectSha})`);
    const entryReview = reviewedEntries.get(entry.path);
    if (entryReview) {
      if (entryReview.objectSha !== entry.objectSha || entryReview.bytesSha256 !== sha256(bytes)) throw new Error(`entry disposition source drift: ${entry.path}`);
      rows.push({path:entry.path,entryKind:entry.entryKind,disposition:'excluded',reason:entryReview.reason,reviewer:entryReview.reviewer});
      dispositionRows.push(entryReview);reviewedEntries.delete(entry.path);continue;
    }
    const text = bytes.toString('utf8');
    let validUtf8 = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { validUtf8 = false; }
    if (!validUtf8) {
      failures.push({ path: entry.path, objectSha: entry.objectSha, adapter: null, message: 'not valid UTF-8 text' });
      rows.push({ path: entry.path, entryKind: entry.entryKind, disposition: 'extraction-failed', reason: 'decoding' });
      continue;
    }
    const adapter = adapters.find((a) => a.matches(entry, text));
    if (!adapter) {
      unsupported.push({ path: entry.path, objectSha: entry.objectSha });
      rows.push({ path: entry.path, entryKind: entry.entryKind, disposition: 'unsupported-modality', reason: 'no adapter claims this entry' });
      continue;
    }
    let result;
    try {
      result = adapter.enumerate({ path: entry.path, text, bytes });
      if (!result || !Array.isArray(result.units) || !Array.isArray(result.errors)) throw new Error('adapter must return explicit units and errors arrays');
    } catch (error) {
      result = { units: [], errors: [{ message: `adapter threw: ${error.message}`, location: null }] };
    }
    if (result.errors?.length) {
      for (const e of result.errors) failures.push({ path: entry.path, objectSha: entry.objectSha, adapter: `${adapter.id}@${adapter.version}`, ...e });
      rows.push({ path: entry.path, entryKind: entry.entryKind, disposition: 'extraction-failed', adapter: adapter.id, reason: 'parser diagnostics' });
      continue;
    }
    const fileUnits = (result.units || []).map((u) => {
      if (!(Number.isSafeInteger(u.startByte) && Number.isSafeInteger(u.endByte) && u.startByte >= 0 && u.endByte > u.startByte && u.endByte <= bytes.length)) {
        throw new Error(`${adapter.id} returned an invalid owned span for ${entry.path}: ${u.startByte}..${u.endByte}`);
      }
      const owned = bytes.subarray(u.startByte, u.endByte);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const prefix = decoder.decode(bytes.subarray(0, u.startByte));
      const source = decoder.decode(owned);
      const startLine = prefix.split('\n').length;
      const endLine = startLine + source.split('\n').length - 1;
      if (u.startLine !== startLine || u.endLine !== endLine) throw new Error('adapter line bounds disagree with owned bytes');
      return {
        unitId: unitIdFor({ repo: manifest.repo, path: entry.path, objectSha: entry.objectSha, kind: u.kind, startByte: u.startByte, endByte: u.endByte }),
        path: entry.path, blobSha: entry.objectSha, kind: u.kind, name: u.name ?? null, sourceType: u.sourceType,
        startByte: u.startByte, endByte: u.endByte, startLine: u.startLine, endLine: u.endLine,
        bytesSha256: sha256(owned), chars: owned.toString('utf8').length, adapter: `${adapter.id}@${adapter.version}`,
      };
    });
    const accepted = [];
    for (const unit of fileUnits) {
      const review = reviewed.get(unit.unitId);
      if (review && (review.path !== unit.path || review.objectSha !== unit.blobSha || review.bytesSha256 !== unit.bytesSha256)) {
        throw new Error(`semantic disposition source drift for ${unit.unitId}`);
      }
      if (requireSemanticReview && !review) pendingSemanticReview.push(unit.unitId);
      if (!review || review.disposition === 'eligible') accepted.push(unit);
      if (review) { dispositionRows.push(review); reviewed.delete(unit.unitId); }
    }
    units.push(...accepted);
    rows.push({ path: entry.path, entryKind: entry.entryKind, disposition: accepted.length ? 'eligible' : 'no-eligible-units', adapter: adapter.id, candidates: fileUnits.length, units: accepted.length });
  }

  if (reviewedEntries.size) throw new Error('entry dispositions contain entries outside the reviewable inventory');
  if (reviewed.size) throw new Error('semantic dispositions contain units outside this inventory');
  const inventoryComplete = failures.length === 0 && unsupported.length === 0 && pendingSemanticReview.length === 0;
  const identity = {
    rulesVersion: RULES_VERSION, repo: manifest.repo, commitSha: manifest.commitSha, treeSha: manifest.treeSha,
    manifestSha256: manifest.manifestSha256,
    pendingSemanticReview, dispositionRows, requireSemanticReview,
    adapters: adapters.map((a) => ({ id: a.id, version: a.version, parserIdentity: a.parserIdentity })),
  };
  if (!inventoryComplete) {
    return {
      ...identity, inventoryComplete: false, U: null, enumeratedU: units.length,
      failures, unsupported, entries: rows, units, selection: null,
    };
  }
  if (units.length === 0) {
    // Complete accounting that finds no eligible unit is NOT a measurement and NOT proof of emptiness:
    // N=0 is NOT_MEASURED, and emptySources needs an independent review receipt over this manifest.
    return {
      ...identity, inventoryComplete: true, U: 0, enumeratedU: 0, emptyOfEligibleSource: true, requiresEmptinessReview: true,
      failures, unsupported, entries: rows, units, selection: null,
    };
  }
  const selection = selectUnits({ units, repo: manifest.repo, treeSha: manifest.treeSha, seed });
  return {
    ...identity, inventoryComplete: true, U: units.length, enumeratedU: units.length, emptyOfEligibleSource: false,
    requiresEmptinessReview: false, failures, unsupported, entries: rows, units, selection,
  };
}
