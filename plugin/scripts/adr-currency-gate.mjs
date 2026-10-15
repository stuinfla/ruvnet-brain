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
 * with a typed skipped-policy diagnostic when an owning-checkout inspection cannot finish. An adversarial review earlier today found a sibling hook turning a missing `sqlite3`
 * into a confident claim that the memory store was corrupt. A gate that fabricates a reason is worse
 * than no gate, because it spends the credibility every other gate is drawing on.
 */
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Finding codes within this edit gate's narrow stale-debt policy. */
const STALE = new Set(['presumed-stale']);

/**
 * Which documents govern this file, and are they current?
 *
 * Only the ADRs that actually govern the edited path are evaluated — `evaluate()` walks 83 documents
 * with git calls per document, which is fine for a pre-push gate and far too slow for something on
 * the Write path. Same logic, narrower question.
 */
/**
 * The canonical evaluator ships adjacent to this owned hook. The root CLI is a thin compatibility
 * entrypoint; an edited checkout supplies only files and Git history, never executable evaluator
 * code. Missing owned bytes are unavailable evidence, not permission to import project JavaScript.
 */
async function loadDocCurrency() {
  const p = path.join(HERE, 'doc-currency.mjs');
  if (!fs.existsSync(p)) return null;
  try { return await import(pathToFileURL(p).href); } catch { return null; }
}

export async function staleGovernorsOf(relPath, { root = REPO, docCurrency = null, readFile = null } = {}) {
  const mod = docCurrency ?? await loadDocCurrency();
  if (!mod) return [];
  const { listDocs, evaluateDoc, parseFrontmatter, resolveGoverned, blockingFindings, DEFAULT_DIRS, isGitRepo } = mod;
  // `readFile` is injectable for one reason, and it is not tidiness: with `fs.readFileSync` hardcoded
  // here, a test that injects `listDocs`/`parseFrontmatter` never reaches them — the read throws on a
  // fixture path that does not exist, the loop `continue`s, and NO CANDIDATE IS EVER FOUND. The first
  // mutation run of this file reported "STALE ADR -> DID NOT FIRE", while all three allow-cases
  // passed. A suite of only allow-cases would have shipped this green and unfireable, which is the
  // exact defect class this repo has now hit four times in one day.
  const read = readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  let docs;
  try {
    if (!isGitRepo(root)) return [];
    docs = listDocs(root, DEFAULT_DIRS);
  } catch { return []; }

  // Resolve declarations together, then evaluate only the documents governing this exact file.
  // The shared resolver owns scalar/list/glob semantics; directories are not recursive governors.
  const candidates = [];
  const entries = new Set();
  for (const docRel of docs) {
    let fm;
    try { fm = parseFrontmatter(read(path.join(root, docRel))); } catch { continue; }
    const governs = fm?.keys?.governs;
    const declared = (Array.isArray(governs) ? governs : (governs ? [String(governs)] : []))
      .map((entry) => String(entry).trim()).filter(Boolean);
    if (!declared.length) continue;
    declared.forEach((entry) => entries.add(entry));
    candidates.push({ docRel, id: fm?.keys?.id ?? path.basename(docRel), declared });
  }
  if (!candidates.length) return [];
  let matching;
  try {
    const target = relPath.split(path.sep).join('/');
    matching = new Set(resolveGoverned(root, [...entries])
      .filter((g) => g.resolved && g.path === target).map((g) => g.from));
  } catch { return []; }

  const out = [];
  for (const c of candidates) {
    if (!c.declared.some((entry) => matching.has(entry))) continue;
    try {
      const doc = evaluateDoc(root, c.docRel);
      const finding = blockingFindings([doc]).find((f) => STALE.has(f.code));
      if (finding) out.push({ doc: c.docRel, id: c.id, why: finding.message });
    } catch { continue; }
  }
  return out;
}

export function refusalText(relPath, stale) {
  const names = stale.map((s) => `${s.id} (${s.doc})${s.why ? ` — ${s.why}` : ''}`).join('\n           ');
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

/** Installed location is transport, never the authority for the edited repository. */
export function owningEditedCheckout(payload, deadline = Date.now() + 1000) {
  const input = payload?.tool_input ?? {};
  const file = input.file_path || input.path;
  if (typeof file !== 'string' || !file) return null;
  let absolute = path.resolve(payload.cwd || process.cwd(), file);
  if (fs.existsSync(absolute)) absolute = fs.realpathSync.native(absolute);
  let directory = path.dirname(absolute);
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  const suffix = path.relative(directory, absolute);
  directory = fs.realpathSync.native(directory);
  absolute = path.join(directory, suffix);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('ADR scope deadline exceeded');
  let root;
  try { root = execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(); } catch (error) { if (error.code === 'ETIMEDOUT') throw error; return null; }
  const rel = path.relative(root, absolute).split(path.sep).join('/');
  if (rel.startsWith('../') || rel === '..' || rel.startsWith('docs/')) return null;
  if (!fs.existsSync(path.join(root, 'docs', 'adr'))) return null;
  return { root, rel };
}

/** Keep imports and the reused evaluator's Git descendants inside the parent decision budget. */
export function boundedStaleGovernorsOf(scope, deadline) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now() - 250;
    if (remaining <= 0) return resolve({ skipped: 'ADR evaluation deadline exceeded' });
    let settled = false; let timer; let output = '';
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--evaluate-owning-checkout', scope.root, scope.rel], {
      detached: process.platform !== 'win32' && process.env.RUVNET_DECISION_GATE !== '1', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const kill = () => { try { if (process.platform !== 'win32' && process.env.RUVNET_DECISION_GATE !== '1') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    timer = setTimeout(() => { kill(); finish({ skipped: 'ADR evaluation deadline exceeded' }); }, remaining);
    child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 65536) { kill(); finish({ skipped: 'ADR evaluation output exceeded bound' }); } });
    child.once('error', () => finish({ skipped: 'ADR evaluator unavailable' }));
    child.once('close', (code) => { kill(); if (code !== 0) return finish({ skipped: 'ADR evaluator failed' });
      try { const stale = JSON.parse(output); if (!Array.isArray(stale)) throw Error(); finish({ stale }); }
      catch { finish({ skipped: 'ADR evaluator returned invalid result' }); }
    });
  });
}

if (isMain) {
  if (process.argv[2] === '--evaluate-owning-checkout') {
    try {
      const ownedEvaluator = await loadDocCurrency();
      if (!ownedEvaluator) throw new Error('Brain-owned evaluator unavailable');
      process.stdout.write(JSON.stringify(await staleGovernorsOf(process.argv[4], { root: process.argv[3], docCurrency: ownedEvaluator })));
    }
    catch { process.exitCode = 1; }
  } else {
    try {
      const deadline = Math.min(Number(process.env.RUVNET_DECISION_DEADLINE) || Infinity, Date.now() + 3000);
      const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
      const scope = owningEditedCheckout(payload, deadline);
      if (scope) {
        const result = await boundedStaleGovernorsOf(scope, deadline);
        if (result.skipped) { process.stderr.write(result.skipped + '\n'); process.exitCode = 3; }
        else if (result.stale.length) { process.stderr.write(refusalText(scope.rel, result.stale) + '\n'); process.exitCode = 2; }
      }
    } catch { process.stderr.write('ADR owning-checkout inspection unavailable; no currency verdict was obtained.\n'); process.exitCode = 3; }
  }
}
