// Probes (architecture 2.4 step 6): per repository, in sorted order, the first file (sorted) that has
// enough words whose analysed token is found in no other file; the question is those words as written
// (lower-cased), the expected file is that file. They test that the machinery works on this machine,
// not answer quality. Tokens are cut by the engine's analyser, the same function the index and the
// question go through, so a probe word means at question time what it meant at build time (asking
// with the surface word, not its stem, since stemming a stem again can give a different token).
// Every probe is checked against the pack just built (build.mjs); one miss stops the build.
import { words } from '../engine/analyse.mjs';

/**
 * The probe index, filled one source at a time so no pack is held in memory: add(rows) records, for
 * every analysed token, the one file it is found in (or that it is found in more than one); make(rowsOf)
 * then walks each repository's files in sorted order and reads a candidate file's rows back (rowsOf(repo,
 * path), in their stored order) only when it needs that file's words. The same rows give the same probes
 * as reading them all at once.
 */
export function probeIndex(analyser, { perRepo, termsPerProbe, minTermLength }) {
  const usable = (w) => w.length >= minTermLength && !/^\d+$/.test(w);
  const fileOf = new Map(); // analysed token -> id of the one file that has it, or -1 for more than one
  const ids = new Map(); // "repo/path" -> id
  const filesByRepo = new Map(); // repo -> Set of paths
  return {
    add(rows) {
      for (const r of rows) {
        const f = `${r.repo}/${r.path}`;
        let id = ids.get(f);
        if (id === undefined) {
          id = ids.size;
          ids.set(f, id);
          if (!filesByRepo.has(r.repo)) filesByRepo.set(r.repo, new Set());
          filesByRepo.get(r.repo).add(r.path);
        }
        for (const t of words(r.text, analyser)) {
          const was = fileOf.get(t);
          if (was === undefined) fileOf.set(t, id);
          else if (was !== id && was !== -1) fileOf.set(t, -1);
        }
      }
    },
    make(rowsOf) {
      const probes = [];
      for (const repo of [...filesByRepo.keys()].sort()) {
        let made = 0;
        for (const p of [...filesByRepo.get(repo)].map((x) => `${repo}/${x}`).sort()) {
          if (made >= perRepo) break;
          const own = [];
          const taken = new Set();
          for (const r of rowsOf(repo, p.slice(repo.length + 1))) {
            for (const w of String(r.text).toLowerCase().split(/[^a-z0-9]+/)) {
              if (!usable(w)) continue;
              const t = words(w, analyser);
              if (t.length !== 1) continue;
              const one = fileOf.get(t[0]);
              if (one !== undefined && one !== -1 && !taken.has(t[0])) (taken.add(t[0]), own.push(w));
            }
          }
          if (own.length >= termsPerProbe) {
            probes.push({ question: own.slice(0, termsPerProbe).join(' '), expect: p, repo });
            made++;
          }
        }
      }
      return probes;
    },
  };
}

/** All rows at once (kept for callers that hold them). */
export function makeProbes(rows, analyser, cfg) {
  const ix = probeIndex(analyser, cfg);
  ix.add(rows);
  const byFile = new Map();
  for (const r of rows) {
    const k = `${r.repo}/${r.path}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(r);
  }
  return ix.make((repo, p) => byFile.get(`${repo}/${p}`) ?? []);
}
