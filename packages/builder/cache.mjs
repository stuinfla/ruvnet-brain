// The builder's cache folder (CI only; never shipped): extracted rows by key, and each source's last
// good snapshot for the carry rule.
//   <cache>/units/<key>.json        extract() result; key = sha256(recipe hash, source content hash, history hash)
//   <cache>/sources/<repo>.json     the last snapshot read in full: { meta, docs, skipped, truncated, contentHash, history }
//   <cache>/build-report.json       which sources were rebuilt, reused and carried by the last build
// Without a cache folder every source is rebuilt and nothing can be carried.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../contract/home.mjs';

const safe = (repo) => encodeURIComponent(repo);

export function openCache(dir) {
  if (!dir) return { units: () => null, saveUnits() {}, lastGood: () => null, saveLastGood() {}, report() {} };
  fs.mkdirSync(dir, { recursive: true });
  return {
    units: (key) => readJson(path.join(dir, 'units', `${key}.json`), null),
    saveUnits: (key, value) => writeJsonAtomic(path.join(dir, 'units', `${key}.json`), value),
    lastGood: (repo) => readJson(path.join(dir, 'sources', `${safe(repo)}.json`), null),
    saveLastGood: (snapshot) => writeJsonAtomic(path.join(dir, 'sources', `${safe(snapshot.meta.repo)}.json`), snapshot),
    report: (value) => writeJsonAtomic(path.join(dir, 'build-report.json'), value),
  };
}
