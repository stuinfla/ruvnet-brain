#!/usr/bin/env node
// Derive data/retrieval-passage-content-digests.json from a corpus archive built with ordinal passage
// ids. See scripts/retrieval-passage-identity.mjs for why the map exists.
//
//   node scripts/derive-passage-content-map.mjs --zip <old-format ruvnet-brain.zip> \
//        --source-tag v4.3.36 [--fixture data/retrieval-query-evidence.json] [--out <file>]
//
// For every expected passage the frozen fixture pins (primary + alternatives), find the ONE row in the
// archive's store whose path matches and whose digest equals the pin, and record that row's id-less
// content digest. A pin that is not found exactly once is listed as `unresolved` (never guessed): it
// keeps exact-digest matching only. The output is deterministic, so re-running proves the committed map.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './coverage-integrity.mjs';
import { CONTENT_MAP_FILE, CONTENT_MAP_KIND, passageContentDigest } from './retrieval-passage-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every pin in the fixture: [{ store, path, pinned }]. */
export function fixturePins(fixture) {
  const pins = [];
  for (const [store, row] of Object.entries(fixture.queries || {})) {
    const sources = [{ path: row.expected.path, passageSha256: row.expected.passageSha256 }, ...(row.expected.alternatives || [])];
    for (const source of sources) pins.push({ store, path: source.path, pinned: source.passageSha256 });
  }
  return pins;
}

export function deriveContentMap({ fixture, fixtureSha256, readRows, sourceTag, archiveSha256 }) {
  const entries = {};
  const unresolved = [];
  for (const { store, path: expectedPath, pinned } of fixturePins(fixture)) {
    const rows = readRows(store);
    const found = (rows || []).filter((row) => row.path === expectedPath && digest(row) === pinned);
    if (found.length === 1) entries[pinned] = passageContentDigest(found[0]);
    else unresolved.push({ store, path: expectedPath, pinned, reason: rows ? `${found.length} matching rows` : 'store absent from archive' });
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  return { schemaVersion: 1, kind: CONTENT_MAP_KIND, fixtureSha256,
    derivedFrom: { tag: sourceTag, archiveSha256 },
    entries: sorted,
    unresolved: unresolved.sort((a, b) => a.store.localeCompare(b.store) || a.path.localeCompare(b.path)) };
}

function zipRows(zipFile, store) {
  const result = spawnSync('unzip', ['-p', zipFile, `${store}.passages.jsonl`], { maxBuffer: 1 << 30 });
  if (result.status !== 0) return null;
  // Split on \n only: rows may contain U+2028/U+2029, which are not JSONL separators.
  return result.stdout.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function main(argv) {
  const arg = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const zip = arg('--zip');
  const sourceTag = arg('--source-tag');
  if (!zip || !sourceTag) { console.error('usage: derive-passage-content-map.mjs --zip <archive> --source-tag <tag> [--fixture f] [--out f]'); process.exit(2); }
  const fixtureFile = path.resolve(arg('--fixture', path.join(ROOT, 'data', 'retrieval-query-evidence.json')));
  const out = path.resolve(arg('--out', CONTENT_MAP_FILE));
  const cache = new Map();
  const readRows = (store) => { if (!cache.has(store)) cache.set(store, zipRows(zip, store)); return cache.get(store); };
  const map = deriveContentMap({ fixture: JSON.parse(fs.readFileSync(fixtureFile, 'utf8')), fixtureSha256: sha256File(fixtureFile),
    readRows, sourceTag, archiveSha256: sha256File(zip) });
  fs.writeFileSync(out, `${JSON.stringify(map, null, 2)}\n`);
  console.log(JSON.stringify({ out, resolved: Object.keys(map.entries).length, unresolved: map.unresolved.length }));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
