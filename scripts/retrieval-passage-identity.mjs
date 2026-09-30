// How the retrieval fixture recognises "the expected passage" across store rebuilds.
//
// data/retrieval-query-evidence.json pins each expected passage by digest(row), where a row is
// { id, path, text, title }. Until 2026-09-29 the `id` was an ordinal ("2824"); the CI corpus builder
// now writes content-addressed ids ("chunk:<hash>"). The same passage — identical path, title and text —
// therefore changed digest with no content change, and every release that consumed a freshly built
// generation failed with "<store> has no sealed independent query evidence" (4.3.37 preflight, 2026-09-29).
//
// The fixture bytes are FROZEN on purpose: its sha256 is what corpus-next-seed judges a generation's
// recall report against, so editing it would make the newest generation an incompatible seed and force
// a full multi-hour rebuild. Instead this module adds a second, id-independent identity, looked up
// through a committed map (pinned digest -> content digest) derived once, mechanically, from the last
// corpus built with ordinal ids (scripts/derive-passage-content-map.mjs). The map can only ADD
// acceptance for a row whose path, title and text equal the row the fixture originally pinned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './coverage-integrity.mjs';

export const CONTENT_MAP_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'data', 'retrieval-passage-content-digests.json');
export const CONTENT_MAP_KIND = 'ruvnet-brain-retrieval-passage-content-digests';
const HEX64 = /^[a-f0-9]{64}$/;

/** Digest of everything about a passage row except its (build-dependent) id. */
export function passageContentDigest(row) {
  const { id: _id, ...rest } = row ?? {};
  return digest(rest);
}

/** pinned digest -> content digest. A missing file is an empty map: legacy exact-digest matching only. */
export function loadContentMap(file = CONTENT_MAP_FILE) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error(`passage content map is unreadable: ${error.message}`);
  }
  if (parsed?.kind !== CONTENT_MAP_KIND || parsed.schemaVersion !== 1
    || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    throw new Error('passage content map is malformed');
  }
  const map = new Map();
  for (const [pinned, content] of Object.entries(parsed.entries)) {
    if (!HEX64.test(pinned) || !HEX64.test(String(content))) throw new Error('passage content map holds a non-sha256 entry');
    map.set(pinned, content);
  }
  return map;
}

let cachedMap = null;
const defaultMap = () => (cachedMap ??= loadContentMap());

/** Does this row satisfy a fixture pin: exact digest, or (when the map knows the pin) equal content. */
export function passageMatches(row, pinnedSha256, map = defaultMap()) {
  if (digest(row) === pinnedSha256) return true;
  const content = map.get(pinnedSha256);
  return Boolean(content) && passageContentDigest(row) === content;
}
