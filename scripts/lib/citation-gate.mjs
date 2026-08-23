// scripts/lib/citation-gate.mjs — the one place that decides whether a generated artifact (an L2
// synthesis article, a repo primer) cites enough real, retrieved source to ship live.
//
// build-l2.mjs and build-primer.mjs each hand-rolled their own copy of this predicate and silently
// diverged on the one thing that matters: what happens when the count comes back low. build-l2.mjs
// already routes an ungrounded article to kb/l2/rejected/ instead of kb/l2/; build-primer.mjs wrote
// the primer to its live path unconditionally, before ever checking the count (see
// tests/unit/countrefs-primer-l2-drift.test.mjs for the full history). This module is the shared
// version both callers now use, so accept/reject is enforced identically everywhere it applies.
import fs from 'node:fs';
import path from 'node:path';

// Counts how many of `candidatePaths` actually appear in `txt`, verbatim or by bare basename (an
// LLM often cites "forge-ask.mjs" without the "kb/" prefix). Basename matching can over-credit when
// two candidate paths share a basename in different directories — a known, accepted tradeoff.
export function countRefs(txt, candidatePaths) {
  const set = candidatePaths instanceof Set ? candidatePaths : new Set(candidatePaths);
  return [...set].filter((p) => txt.includes(p) || txt.includes(p.split('/').pop()));
}

export function isGrounded(refs, minRefs) {
  return refs.length >= minRefs;
}

// Writes `content` to `liveDir/filename` when grounded, otherwise to `rejectedDir/filename` —
// never both, and never the live path when ungrounded. The check runs before the write, not after.
export function writeGated({ liveDir, rejectedDir, filename, content, grounded }) {
  const dir = grounded ? liveDir : rejectedDir;
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, content);
  return { outPath, grounded };
}
