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
  // analysed token -> id (>= 0) of the one file that has it, or -n for n files (n >= 2)
  const fileOf = new Map();
  const ids = new Map(); // "repo/path" -> id
  const filesByRepo = new Map(); // repo -> Set of paths
  /** A repository none of whose files has enough words of its own (a fork, a copy, boilerplate) gets
   *  the file whose rarest words are rarest across the corpus, asked with those words, marked
   *  `fallback: true` (review F15). The pack's self-test still has to find it, or the build stops. */
  function fallback(repo, rowsOf) {
    let best = null;
    for (const p of [...filesByRepo.get(repo)].sort()) {
      const counts = new Map(); // surface word -> number of files its token is in
      const tokens = new Set();
      for (const r of rowsOf(repo, p)) {
        for (const w of String(r.text).toLowerCase().split(/[^a-z0-9]+/)) {
          if (!usable(w) || counts.has(w)) continue;
          const t = words(w, analyser);
          if (t.length !== 1 || tokens.has(t[0])) continue;
          const one = fileOf.get(t[0]);
          if (one === undefined) continue;
          tokens.add(t[0]);
          counts.set(w, one >= 0 ? 1 : -one);
        }
      }
      if (counts.size < termsPerProbe) continue;
      const pick = [...counts].sort((a, b) => a[1] - b[1]).slice(0, termsPerProbe);
      const cost = pick.reduce((n, [, c]) => n + c, 0);
      if (!best || cost < best.cost) best = { cost, question: pick.map(([w]) => w).join(' '), expect: `${repo}/${p}` };
    }
    return best && { question: best.question, expect: best.expect, repo, fallback: true };
  }
  return {
    add(rows) {
      let seen = new Set(); // tokens already counted for the current file (a file's rows come together)
      let cur = -1;
      for (const r of rows) {
        const f = `${r.repo}/${r.path}`;
        let id = ids.get(f);
        if (id === undefined) {
          id = ids.size;
          ids.set(f, id);
          if (!filesByRepo.has(r.repo)) filesByRepo.set(r.repo, new Set());
          filesByRepo.get(r.repo).add(r.path);
        }
        if (id !== cur) (cur = id), (seen = new Set());
        for (const t of words(r.text, analyser)) {
          if (seen.has(t)) continue;
          seen.add(t);
          const was = fileOf.get(t);
          if (was === undefined) fileOf.set(t, id);
          else if (was >= 0 && was !== id) fileOf.set(t, -2);
          else if (was < 0) fileOf.set(t, was - 1);
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
              if (one !== undefined && one >= 0 && !taken.has(t[0])) (taken.add(t[0]), own.push(w));
            }
          }
          if (own.length >= termsPerProbe) {
            probes.push({ question: own.slice(0, termsPerProbe).join(' '), expect: p, repo });
            made++;
          }
        }
        if (!made) {
          const f = fallback(repo, rowsOf);
          if (f) probes.push(f);
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
