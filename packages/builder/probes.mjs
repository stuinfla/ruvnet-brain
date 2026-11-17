// Probes (architecture 2.4 step 6): per repository, in sorted order, the first file (sorted) that has
// enough words whose analysed token is found in no other file; the question is those words as written
// (lower-cased), the expected file is that file. They test that the machinery works on this machine,
// not answer quality. Tokens are cut by the engine's analyser, the same function the index and the
// question go through, so a probe word means at question time what it meant at build time (asking
// with the surface word, not its stem, since stemming a stem again can give a different token).
// Every probe is checked against the pack just built (build.mjs); one miss stops the build.
import { words } from '../engine/analyse.mjs';

export function makeProbes(rows, analyser, { perRepo, termsPerProbe, minTermLength }) {
  const usable = (w) => w.length >= minTermLength && !/^\d+$/.test(w);
  const filesOf = new Map(); // analysed token -> files whose text has it
  const surfaceOf = new Map(); // file -> [[surface word, its one analysed token]] in text order
  const filesByRepo = new Map();
  for (const r of rows) {
    const f = `${r.repo}/${r.path}`;
    if (!surfaceOf.has(f)) surfaceOf.set(f, []);
    if (!filesByRepo.has(r.repo)) filesByRepo.set(r.repo, []);
    if (!filesByRepo.get(r.repo).includes(f)) filesByRepo.get(r.repo).push(f);
    for (const t of words(r.text, analyser)) {
      if (!filesOf.has(t)) filesOf.set(t, new Set());
      filesOf.get(t).add(f);
    }
    for (const w of String(r.text).toLowerCase().split(/[^a-z0-9]+/)) {
      if (!usable(w)) continue;
      const t = words(w, analyser);
      if (t.length === 1) surfaceOf.get(f).push([w, t[0]]);
    }
  }
  const probes = [];
  for (const repo of [...filesByRepo.keys()].sort()) {
    let made = 0;
    for (const f of [...filesByRepo.get(repo)].sort()) {
      if (made >= perRepo) break;
      const own = [];
      const taken = new Set();
      for (const [w, t] of surfaceOf.get(f)) {
        if (filesOf.get(t)?.size === 1 && !taken.has(t)) (taken.add(t), own.push(w));
      }
      if (own.length >= termsPerProbe) {
        probes.push({ question: own.slice(0, termsPerProbe).join(' '), expect: f, repo });
        made++;
      }
    }
  }
  return probes;
}
