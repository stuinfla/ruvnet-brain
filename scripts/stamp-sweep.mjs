#!/usr/bin/env node
// scripts/stamp-sweep.mjs — ADR-056 §2. The ONE-TIME half of the owner's first rule.
//
//   node scripts/stamp-sweep.mjs             report: every authored .md, its stamp state, its verdict
//   node scripts/stamp-sweep.mjs --apply     write the stamps git can prove
//   node scripts/stamp-sweep.mjs --json      machine-readable, same evaluation
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS SEPARATELY FROM THE HOOK. `plugin/scripts/md-stamp.mjs` maintains stamps when a
// file is edited. That is necessary and it is not sufficient, and the adversarial duel on ADR-056
// said why in one sentence:
//
//     "Insert-on-touch fires only when a file IS edited — so it reaches actively-edited files, the
//      ones least likely to be stale, and never reaches a stale file, BY DEFINITION OF STALE."
//
// The owner's rule is about the documents sitting on disk TODAY: "so I know if they're stale or
// current actually in there so that I can read it, not just you." Measured 2026-07-27: 166 of 239
// .md files carry no stamp. The hook would have reached approximately none of them. This reaches
// them once; the hook keeps them true afterwards.
//
// ONE IMPLEMENTATION, TWO CALLERS. Every placement decision lives in md-stamp.mjs (`ensureStamp`,
// `stampInsertionPoint`, `hasStamp`) and is imported here. A second copy of "where does the stamp
// go" is the exact drift this whole ADR is about.
//
// NOTHING IS EVER INVENTED — the load-bearing rule, inherited verbatim from doc-currency.mjs:
//   · no git history        -> SKIP and say so. A file git cannot date does not get a date.
//   · dirty working tree    -> SKIP. The last commit's date is not the date of the current contents,
//                             and stamping it would assert a freshness that is not true.
//   · already stamped       -> SKIP, byte-for-byte untouched.
//   · unrecognised prologue -> SKIP. MDX exports, HTML comments, license banners: an insertion that
//                             corrupts someone's document is worse than a document with no date.
//
// GENERATED MARKDOWN IS NOT AN AUTHORED DOCUMENT. 96 of the 166 unstamped files live under kb/,
// dist/ and .agentic-qe/logs/. Stamping machine output is noise wearing the costume of signal, and
// it would bury the ~70 files where the stamp actually carries information.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureStamp, hasStamp, stampInsertionPoint, atomicWriteSync } from '../plugin/scripts/md-stamp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

// Directories whose markdown is GENERATED, vendored, or archival — never authored by a human here.
export const EXCLUDED = [
  'node_modules', '.git', 'kb', 'dist', 'clones', 'archive', '.agentic-qe',
  'coverage', '.next', 'build', 'tmp', '.swarm',
];

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

/** Every authored .md tracked by git. Untracked files are out of scope — git cannot date them. */
export function authoredDocs(root = REPO_ROOT) {
  const ls = git(root, ['ls-files', '--', '*.md']);
  if (!ls.ok) return [];
  return ls.out.split('\n').filter(Boolean).filter((rel) => {
    const segs = rel.split('/');
    return !segs.some((s) => EXCLUDED.includes(s));
  });
}

/** Dates git can PROVE for this path. Absent is absent; nothing is inferred from a neighbour. */
export function gitDates(root, rel) {
  const created = git(root, ['log', '--follow', '--diff-filter=A', '--format=%cs', '-1', '--', rel]);
  const updated = git(root, ['log', '-1', '--format=%cs', '--', rel]);
  const dirty = git(root, ['status', '--porcelain', '--', rel]);
  return {
    created: created.ok && /^\d{4}-\d{2}-\d{2}$/.test(created.out) ? created.out : null,
    updated: updated.ok && /^\d{4}-\d{2}-\d{2}$/.test(updated.out) ? updated.out : null,
    dirty: Boolean(dirty.out),
  };
}

export function evaluate(root = REPO_ROOT, docs = authoredDocs(root)) {
  const rows = [];
  for (const rel of docs) {
    const abs = path.join(root, rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    if (hasStamp(content)) { rows.push({ rel, verdict: 'already-stamped' }); continue; }

    const at = stampInsertionPoint(content);
    if (!at) { rows.push({ rel, verdict: 'skip-prologue', why: 'prologue shape not recognised — refusing to insert' }); continue; }

    const d = gitDates(root, rel);
    if (d.dirty) { rows.push({ rel, verdict: 'skip-dirty', why: 'working tree modified — the last commit date is not the date of these contents' }); continue; }
    if (!d.updated) { rows.push({ rel, verdict: 'skip-no-history', why: 'no commits — no date can be derived, and none will be invented' }); continue; }

    const next = ensureStamp(content, { updated: d.updated, created: d.created });
    if (next === content) { rows.push({ rel, verdict: 'no-change' }); continue; }
    rows.push({ rel, verdict: 'would-stamp', placement: at.kind, updated: d.updated, created: d.created, next });
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');
  const rows = evaluate();

  if (asJson) {
    console.log(JSON.stringify(rows.map(({ next, ...r }) => r), null, 2));
    return 0;
  }

  const by = (v) => rows.filter((r) => r.verdict === v);
  const todo = by('would-stamp');

  console.log(`\nstamp sweep — ${rows.length} authored document(s) under ${REPO_ROOT}\n`);
  for (const r of todo) {
    const c = r.created && r.created !== r.updated ? `, created ${r.created}` : '';
    console.log(`  ${apply ? '[stamped] ' : '[would stamp]'} ${r.rel} — updated ${r.updated}${c} (derived-from-git, ${r.placement})`);
    if (apply) {
      try { atomicWriteSync(path.join(REPO_ROOT, r.rel), r.next); }
      catch (e) { console.log(`  [failed]  ${r.rel}: ${e.message}`); }
    }
  }

  const skipped = [...by('skip-prologue'), ...by('skip-dirty'), ...by('skip-no-history')];
  if (skipped.length) {
    console.log(`\n  ${skipped.length} deliberately NOT stamped — no date will be invented:\n`);
    for (const s of skipped) console.log(`    ○ ${s.rel}\n       ${s.why}`);
  }

  console.log(`\nsummary: ${by('already-stamped').length} already stamped · ${todo.length} `
    + `${apply ? 'stamped' : 'stampable'} · ${skipped.length} skipped (honestly)`);
  if (!apply && todo.length) console.log('\ndry run — nothing written. Re-run with --apply to write them.');
  console.log('Dates are only ever copied out of git; nothing is reconstructed.\n');
  return 0;
}

function isMain() {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMain()) process.exit(main());
