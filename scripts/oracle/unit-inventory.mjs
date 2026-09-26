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
export function buildInventory({ manifest, blobs, adapters, seed = DEFAULT_SEED }) {
  if (!manifest?.repo || !manifest?.treeSha || !Array.isArray(manifest.entries)) {
    throw new Error('buildInventory needs a source-tree snapshot manifest');
  }
  const rows = [];
  const units = [];
  const failures = [];
  const unsupported = [];
  for (const entry of manifest.entries) {
    const fixed = fixedDisposition(entry);
    if (fixed) { rows.push({ path: entry.path, entryKind: entry.entryKind, ...fixed }); continue; }
    const bytes = blobs.get(entry.objectSha);
    if (!bytes) throw new Error(`no blob bytes for ${entry.path} (${entry.objectSha})`);
    const text = bytes.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') !== bytes.length || text.includes('�')) {
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
      return {
        unitId: unitIdFor({ repo: manifest.repo, path: entry.path, objectSha: entry.objectSha, kind: u.kind, startByte: u.startByte, endByte: u.endByte }),
        path: entry.path, blobSha: entry.objectSha, kind: u.kind, name: u.name ?? null, sourceType: u.sourceType,
        startByte: u.startByte, endByte: u.endByte, startLine: u.startLine, endLine: u.endLine,
        bytesSha256: sha256(owned), chars: owned.toString('utf8').length, adapter: `${adapter.id}@${adapter.version}`,
      };
    });
    units.push(...fileUnits);
    rows.push({ path: entry.path, entryKind: entry.entryKind, disposition: fileUnits.length ? 'eligible' : 'no-eligible-units', adapter: adapter.id, units: fileUnits.length });
  }

  const inventoryComplete = failures.length === 0 && unsupported.length === 0;
  const identity = {
    rulesVersion: RULES_VERSION, repo: manifest.repo, commitSha: manifest.commitSha, treeSha: manifest.treeSha,
    manifestSha256: manifest.manifestSha256,
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
