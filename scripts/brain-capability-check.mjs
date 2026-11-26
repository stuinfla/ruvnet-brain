#!/usr/bin/env node
// brain-capability-check.mjs — the "never doubt a real capability" gate.
//
// Stuart's #1 ask: Claude Code must STOP guessing "I don't think RuvNet can do X" when X exists in
// Ruv's real source. This measures exactly that. For each "Can <repo> do <Y>?" question — where Y is
// a REAL capability — the bundle must return a CONFIDENTLY-relevant source document (positive cross-
// encoder relevance) from the right repo whose text actually evidences the capability. A weak/negative
// top hit is precisely where Claude would have doubted → a measured FAIL to drive to zero.
//
// It also supports CONTROL questions (truth:"no") — capabilities a repo genuinely does NOT have — to
// confirm the bundle does not hallucinate capabilities either (it should NOT return a confident,
// evidence-bearing hit for those).
//
//   node scripts/brain-capability-check.mjs --dir kb --questions kb/capability.agentdb.json [--tau 0] [--k 5] [--pool 12]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAll } from '../kb/forge-ask-all.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DIR = path.resolve(ROOT, arg('--dir', 'kb'));
const QFILE = path.resolve(ROOT, arg('--questions', 'kb/capability.agentdb.json'));
const TAU = parseFloat(arg('--tau', '0'));        // min cross-encoder relevance to count as "confident"
const K = parseInt(arg('--k', '5'), 10);
const POOL = parseInt(arg('--pool', '12'), 10);

const spec = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
const questions = spec.questions || spec;

// A capability is "evidenced + confident" if, within the top-k cross-repo hits, some hit is from the
// expected repo (when specified), scores >= TAU, and its text contains >= half of the evidence terms.
function evaluate(results, qq) {
  const ev = (qq.evidence || []).map((s) => s.toLowerCase());
  const need = Math.max(1, Math.ceil(ev.length / 2));
  let best = null;
  for (const r of results) {
    // accept hits from the expected repo, OR a concepts-store hit attributed to it via its path prefix
    if (qq.expectRepo && r.repo !== qq.expectRepo && !(r.repo === 'concepts' && (r.path || '').startsWith(qq.expectRepo + '/'))) continue;
    const txt = (r.fullText || r.text || '').toLowerCase();
    const hits = ev.filter((t) => txt.includes(t)).length;
    const confident = r.ceScore != null
      ? r.ceScore >= TAU
      : (r._lane === 'source-backed-card' && r.evidenceClass === 'implementation');
    const cand = { repo: r.repo, path: r.path, ce: r.ceScore, evHits: hits, evNeed: need, confident, evidenced: hits >= need };
    const candPasses = cand.confident && cand.evidenced;
    const bestPasses = Boolean(best && best.confident && best.evidenced);
    if (!best
      || (candPasses && !bestPasses)
      || (candPasses === bestPasses && (r.ceScore ?? -Infinity) > (best.ce ?? -Infinity))) {
      best = cand;
    }
  }
  return best;
}

const rows = [];
for (let i = 0; i < questions.length; i++) {
  const qq = questions[i];
  const { results } = await searchAll({ dir: DIR, query: qq.q, k: K, pool: POOL });
  const best = evaluate(results, qq);
  const truthYes = (qq.truth || 'yes').toLowerCase() !== 'no';
  // YES-capability: pass = confident + evidenced from expected repo. NO-capability (control):
  // pass = the bundle does NOT return a confident, evidenced hit (it correctly has nothing to assert).
  const evidencedConfident = !!(best && best.confident && best.evidenced);
  const pass = truthYes ? evidencedConfident : !evidencedConfident;
  rows.push({ i: i + 1, q: qq.q, truth: truthYes ? 'YES' : 'NO(control)', pass, best });
}

const passN = rows.filter((r) => r.pass).length;
console.log(`\n=== capability-confidence gate — ${path.basename(QFILE)} (τ=${TAU}, k=${K}, pool=${POOL}) ===\n`);
for (const r of rows) {
  const b = r.best;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.truth}]  ${r.q}`);
  console.log(`      → top@repo=${b ? b.repo : '-'} ce=${b && b.ce != null ? b.ce.toFixed(3) : 'n/a'} evidence=${b ? `${b.evHits}/${b.evNeed}` : '-'} ${b ? (b.path) : ''}`);
}
console.log(`\nCAPABILITY-CONFIDENCE: ${passN}/${rows.length} pass (${(100 * passN / rows.length).toFixed(0)}%)  | gate target = 100% on YES + 100% on NO controls`);
process.exit(passN === rows.length ? 0 : 1);
