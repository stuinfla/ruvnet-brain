// The builder's cache folder (CI only; never shipped): extracted rows by key, and each source's last
// good snapshot for the carry rule.
//   <cache>/units/<key>.json        extract() result; key = sha256(recipe hash, source content hash, history hash, EXTRACT_VERSION)
//   <cache>/sources/<repo>.json     the last snapshot read in full: { meta, docs, skipped, truncated, contentHash, history }
//   <cache>/build-report.json       which sources were rebuilt, reused and carried by the last build
// Without a cache folder every source is rebuilt and nothing can be carried.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../contract/home.mjs';

const safe = (repo) => encodeURIComponent(repo);

export function openCache(dir) {
  if (!dir) return { units: () => null, saveUnits() {}, lastGood: () => null, saveLastGood() {}, stageLastGood() {}, commitLastGood() {}, report() {} };
  fs.mkdirSync(dir, { recursive: true });
  const pending = [];
  return {
    // The streaming build reads a source and drops it before the next one; a snapshot read in full is
    // staged beside its last good state and replaces it only once the carry rule has passed (as when
    // every source was read before any was saved).
    stageLastGood(snapshot) {
      const file = path.join(dir, 'sources', `${safe(snapshot.meta.repo)}.json`);
      writeJsonAtomic(`${file}.pending`, snapshot);
      pending.push(file);
    },
    commitLastGood() {
      for (const f of pending.splice(0)) fs.renameSync(`${f}.pending`, f);
    },
    units: (key) => readJson(path.join(dir, 'units', `${key}.json`), null),
    saveUnits: (key, value) => writeJsonAtomic(path.join(dir, 'units', `${key}.json`), value),
    lastGood: (repo) => readJson(path.join(dir, 'sources', `${safe(repo)}.json`), null),
    saveLastGood: (snapshot) => writeJsonAtomic(path.join(dir, 'sources', `${safe(snapshot.meta.repo)}.json`), snapshot),
    report: (value) => writeJsonAtomic(path.join(dir, 'build-report.json'), value),
  };
}
