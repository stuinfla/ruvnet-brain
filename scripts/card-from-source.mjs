#!/usr/bin/env node
/**
 * card-from-source.mjs — give a DARK store a card written from the repo's own words.
 *
 * A store with no capability card is DARK: the bytes are valid and no by-description query can
 * reach them. `ingest-repo.mjs` says so on every run. After the 2026-08-20 bulk ingest the brain
 * held ~111 stores and ~71 of them were dark — loaded, and unusable for anything except a query
 * that already knew the repo's name, which is precisely the query a knowledge base is least needed
 * for.
 *
 * THE LINE THIS DOES NOT CROSS. `ingest-new-repos.mjs` deliberately refuses to write cards, because
 * a card invented from a repo NAME is a confident claim in the routing layer that nobody grounded —
 * it routes real questions to a corpus that cannot answer them, which is worse than an honest gap.
 * That refusal stands. This is a different act: it copies the repo's OWN description and the
 * opening of its OWN README. Every content word in the card came from the repository. Nothing here
 * infers what a project is "probably" for.
 *
 * AND IT SAYS WHAT IT IS. Each generated card carries a marker so a reader can tell it apart from
 * the hand-written ones, which are richer — they say when to REACH for a tool and what it is NOT.
 * An auto-derived card is a floor, not a substitute: it makes a store reachable and invites a
 * better card later. Claiming otherwise would be the overselling this file exists to avoid.
 *
 *   node scripts/card-from-source.mjs                 # report which stores are dark
 *   node scripts/card-from-source.mjs --apply         # write cards for them
 *   node scripts/card-from-source.mjs --apply --max 20
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeRoot, darkStores } from '../kb/store-root.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OWNER = process.env.RUVNET_ORG_OWNER || 'ruvnet';
const APPLY = process.argv.includes('--apply');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAX = Number(arg('--max', '500'));
export const MARKER = 'Auto-derived from the repository\'s own description and README';

/** The repo's own description + README opening. Never a guess about what the name implies. */
export function sourceFacts(repo) {
  let description = '';
  let readme = '';
  try {
    const meta = JSON.parse(execFileSync('gh', ['api', `repos/${OWNER}/${repo}`], { encoding: 'utf8', maxBuffer: 1 << 24 }));
    description = String(meta?.description || '').trim();
  } catch { /* a repo can legitimately have no description */ }
  try {
    const raw = execFileSync('gh', ['api', `repos/${OWNER}/${repo}/readme`, '-H', 'Accept: application/vnd.github.raw'],
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    readme = raw;
  } catch { /* and no README */ }
  return { description, readme };
}

/** First real prose of a README: skip badges, HTML, headings, and link-only lines. */
export function firstProse(readme, limit = 600) {
  const lines = String(readme || '').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (out.length) break; continue; }
    if (t.startsWith('#') || t.startsWith('<') || t.startsWith('|') || t.startsWith('---')) continue;
    if (/^!?\[[^\]]*\]\([^)]*\)$/.test(t)) continue;          // a lone badge or image
    if (/^\[!\[/.test(t)) continue;                            // badge-wrapped link
    out.push(t);
    if (out.join(' ').length > limit) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, limit).trim();
}

export function buildCard(repo, { description, readme }) {
  const prose = firstProse(readme);
  if (!description && !prose) return null;   // nothing grounded to say — leave it dark, honestly
  const body = [description, prose].filter(Boolean).join(' — ');
  return `## ${repo.toLowerCase()}\n${body}\n(${MARKER}; a hand-written card saying when to reach for it, and when not to, would be better.)\n`;
}

// Repository names may contain RegExp metacharacters (`ruv.io` is already in this corpus). The
// heading lookup is literal identity, so escape the name before compiling it.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function insertSorted(file, card, name) {
  const s = fs.readFileSync(file, 'utf8');
  if (new RegExp(`^## ${escapeRegExp(name)}$`, 'mi').test(s)) return false;
  const heads = [...s.matchAll(/^## (.+)$/gm)].map((m) => [m.index, m[1].trim().toLowerCase()]);
  const pos = heads.find(([, n]) => n > name)?.[0];
  fs.writeFileSync(file, pos === undefined ? `${s.replace(/\n+$/, '')}\n\n${card}` : s.slice(0, pos) + card + '\n' + s.slice(pos));
  return true;
}

/** Apply one grounded card to every required surface without turning a failed write into success. */
export function applyCardToFiles(files, card, name, insert = insertSorted) {
  let changed = 0;
  const failures = [];
  for (const file of files) {
    try {
      if (insert(file, card, name)) changed += 1;
    } catch (error) {
      failures.push({ file, error: String(error?.message || error) });
    }
  }
  return { changed, failures };
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const root = storeRoot();
  const dark = darkStores(root);
  console.log(`[card] ${dark.length} dark store(s) — valid bytes no by-description query can reach`);
  if (!dark.length) process.exit(0);
  if (!APPLY) {
    console.log(`[card] ${dark.slice(0, 20).join(', ')}${dark.length > 20 ? ' …' : ''}`);
    console.log('[card] report only. Re-run with --apply to write cards from each repo\'s own source.');
    process.exit(0);
  }
  const repoCards = path.join(ROOT, 'kb', 'capability-cards.md');
  const liveCards = path.join(root, 'capability-cards.md');
  let wrote = 0; let skipped = 0; let failed = 0;
  for (const name of dark.slice(0, MAX)) {
    const card = buildCard(name, sourceFacts(name));
    if (!card) { skipped += 1; console.log(`[card] ${name}: no description and no README prose — left dark rather than invented`); continue; }
    const outcome = applyCardToFiles([repoCards, liveCards], card, name.toLowerCase());
    if (outcome.failures.length) {
      failed += 1;
      console.error(`[card] ${name}: FAILED/PARTIAL (${outcome.changed}/2 surfaces changed) — `
        + outcome.failures.map(({ file, error }) => `${file}: ${error}`).join('; '));
      continue;
    }
    if (outcome.changed > 0) wrote += 1;
    else skipped += 1;
  }
  const remaining = darkStores(root).length;
  console.log(`\n[card] wrote ${wrote}, skipped ${skipped}, failed ${failed}, ${remaining} still dark.`);
  if (failed) process.exitCode = 1;
}
