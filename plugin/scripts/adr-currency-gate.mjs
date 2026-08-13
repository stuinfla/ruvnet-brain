/**
 * adr-currency-gate.mjs — the ADR check, moved from the LAST possible moment to the FIRST.
 *
 * WHAT HAPPENED, 2026-08-13. Three commits touched code governed by ADR-055, 065, 066 and 067. All
 * four ADRs were left describing a world the code had left. The pre-push gate caught it and refused
 * — correctly, and it is a good gate. But look at WHEN: after the files were written, after three
 * commits, after I had moved on. By then the work read as a toll booth, and my own words for it were
 * "real work I skipped". The owner quoted that line back at me as the exhibit, and he was right to.
 *
 * A gate at push time cannot shape the work; it can only penalise it afterwards. Worse, it TRAINS
 * the behaviour it exists to stop — if the wall is at the end, the cheap move is always to run at it
 * and let it sort you out. The instinct the owner keeps asking for is not something exhortation can
 * install; it is what you get when the right action is the only action available at the moment of
 * acting.
 *
 * SO THIS FIRES ON THE EDIT, AND IT REFUSES DEBT RATHER THAN CHANGE. It does NOT ask you to document
 * an edit you have not made yet — that would be incoherent. It refuses to let you write MORE code
 * governed by a document that is ALREADY stale from your last round. One unreconciled ADR is a
 * conversation; four is the mess that shipped today.
 *
 * REUSED, NOT REIMPLEMENTED. Every verdict comes from `scripts/doc-currency.mjs` — the same
 * `evaluateDoc`/`resolveGoverned` the pre-push gate calls. A second implementation of "is this ADR
 * current" would be one fact restated in two places, which is the defect this repo has paid for at
 * least five times (orgTotalApprox in two producers, seven store-root expressions, a hand-listed
 * import graph in four fixtures, two ship-command definitions shipped disagreeing on day one).
 *
 * FAIL OPEN, ALWAYS. Not a git repo, unreadable doc, git unavailable, anything unexpected: ALLOW,
 * silently. An adversarial review earlier today found a sibling hook turning a missing `sqlite3`
 * into a confident claim that the memory store was corrupt. A gate that fabricates a reason is worse
 * than no gate, because it spends the credibility every other gate is drawing on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** States that mean "the code moved and nobody has reconciled the document since". */
const STALE = new Set(['presumed-stale']);

/**
 * Which documents govern this file, and are they current?
 *
 * Only the ADRs that actually govern the edited path are evaluated — `evaluate()` walks 83 documents
 * with git calls per document, which is fine for a pre-push gate and far too slow for something on
 * the Write path. Same logic, narrower question.
 */
export async function staleGovernorsOf(relPath, { root = REPO, docCurrency = null, readFile = null } = {}) {
  const mod = docCurrency ?? await import('../../scripts/doc-currency.mjs');
  const { listDocs, evaluateDoc, parseFrontmatter, DEFAULT_DIRS, isGitRepo } = mod;
  // `readFile` is injectable for one reason, and it is not tidiness: with `fs.readFileSync` hardcoded
  // here, a test that injects `listDocs`/`parseFrontmatter` never reaches them — the read throws on a
  // fixture path that does not exist, the loop `continue`s, and NO CANDIDATE IS EVER FOUND. The first
  // mutation run of this file reported "STALE ADR -> DID NOT FIRE", while all three allow-cases
  // passed. A suite of only allow-cases would have shipped this green and unfireable, which is the
  // exact defect class this repo has now hit four times in one day.
  const read = readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  if (!isGitRepo(root)) return [];

  // TWO PASSES, AND THE ORDER IS THE WHOLE DESIGN. Measured before writing it, not after:
  // `evaluateDoc` costs ~190-240ms because it shells out to git, and there are 83 documents — a
  // naive loop is ~19 SECONDS on the Write path, which would make this the gate everybody disables.
  // Reading frontmatter for all 83 costs 40ms total. So: cheap pass to find WHICH documents govern
  // this file (usually one), expensive pass on only those. ~250ms typical, and exactly 40ms for the
  // overwhelmingly common case of a file no ADR governs.
  const candidates = [];
  for (const docRel of listDocs(root, DEFAULT_DIRS)) {
    let fm;
    try { fm = parseFrontmatter(read(path.join(root, docRel))); } catch { continue; }
    const governs = fm?.keys?.governs;
    if (!Array.isArray(governs)) continue;
    // Entries are exact paths or directory prefixes, read the way the pre-push gate reads them.
    const governsThis = governs.some((p) => typeof p === 'string'
      && (relPath === p || relPath.startsWith(p.endsWith('/') ? p : `${p}/`)));
    if (governsThis) candidates.push({ docRel, id: fm?.keys?.id ?? path.basename(docRel) });
  }
  if (!candidates.length) return [];

  const out = [];
  for (const c of candidates) {
    let doc;
    try { doc = evaluateDoc(root, c.docRel); } catch { continue; }
    if (STALE.has(doc?.drift?.state)) out.push({ doc: c.docRel, id: c.id, why: doc?.drift?.why ?? '' });
  }
  return out;
}

export function refusalText(relPath, stale) {
  const names = stale.map((s) => `${s.id} (${s.doc})`).join('\n           ');
  return `⛔ BLOCKED — ${relPath} is governed by a document that is ALREADY stale.

  stale:   ${names}

Reconcile it BEFORE writing more of what it governs. Not because the rule says so, but because
this is the moment the reconciliation is cheap: you still remember what changed and why. On
2026-08-13 four ADRs went stale together and the pre-push gate caught them after three commits,
when the work read as a toll booth and got called "real work I skipped".

  1. add a Currency-log row to the document: what changed, and why, with referents
  2. \`node scripts/doc-currency.mjs --fix\` backfills only the dates git can prove
  3. status, and every claim in the row, is yours to make — no script may write it

An ADR describing a world the code left is worse than no ADR: the next reader trusts it.`;
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  // Every failure path below ALLOWS. This gate may never be the reason work cannot proceed for a
  // reason it cannot explain.
  let allow = 0;
  try {
    const payload = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(payload)?.tool_input ?? {};
    const file = input.file_path || input.path || '';
    if (!file) process.exit(allow);
    const rel = path.relative(REPO, path.resolve(file));
    // Edits OUTSIDE the repo, and edits to the documents themselves, are never blocked — the second
    // exemption is essential: reconciling a stale ADR must not be refused by the staleness it fixes.
    if (rel.startsWith('..') || rel.startsWith('docs/')) process.exit(allow);
    const stale = await staleGovernorsOf(rel);
    if (!stale.length) process.exit(allow);
    process.stderr.write(`${refusalText(rel, stale)}\n`);
    process.exit(2);
  } catch {
    process.exit(allow);
  }
}
