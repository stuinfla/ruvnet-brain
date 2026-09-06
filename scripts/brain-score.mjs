/**
 * brain-score.mjs — the ONLY sanctioned source of a score about this product.
 *
 * THE DEFECT THIS REPLACES, measured 2026-08-13. Asked to grade the architecture, I counted files
 * — stores/repos, cards/stores — called the result 52/100, and reported it as an architecture
 * grade. Six graders sat unused in this same repo. The real numbers were nothing like 52, and they
 * disagreed with each other in ways that mattered:
 *
 *     grounded  100/100   does it fabricate?              (evals/baseline.json)
 *     routed     63/80    does it reach the right store?  same file, same run
 *     panel      ~56      independent multi-vendor grade  (data/grade-*.json)
 *
 * A single number could not have carried that. My 52 did not measure quality at all; it measured
 * CATALOGUE COVERAGE and wore a quality label. That is the specific error this file makes
 * structurally impossible: dimensions carry a `kind`, and `composite()` REFUSES to average across
 * kinds. A coverage percentage and a quality percentage are answers to different questions, and
 * collapsing them tells the owner his working product is failing while his users report it works.
 *
 * THE SECOND DEFECT, committed while correcting the first. Having found `grounded 100/100`, I
 * quoted it as current. It was recorded 2026-07-10 — 34 days and ~40 commits earlier. The existing
 * claims gate passed it because it checks INTERNAL consistency (k<=n, lo<=p<=hi) and never asks
 * WHEN. So every dimension here declares `maxAgeDays`, and a reading past it is `stale` — reported,
 * never silently used, and never the basis of a claim.
 *
 * This is not new machinery. It is ADR-065's own rule — facts are GENERATED, behaviours are TESTED
 * — applied to the one class of fact that was still being typed by hand. `orgTotalApprox: 248` was
 * this exact bug about a repo count; it was wrong by 48 in two files at once. `sync-version.mjs`
 * and `sync-census.mjs` fixed it for versions and counts. Scores were never brought along.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAY = 86_400_000;

/**
 * Every dimension names the QUESTION it answers, because a number whose question is unstated is
 * the thing that produced the 52. `kind` is load-bearing: see `composite()`.
 */
export const DIMENSIONS = [
  {
    key: 'grounded',
    kind: 'quality',
    question: 'When it answers, is the answer bound to real retrieved source rather than invented?',
    artifact: 'evals/baseline.json',
    maxAgeDays: 14,
    read: (j) => ({ value: pct(j?.score?.grounded), detail: frac(j?.score?.grounded), at: j?.recorded }),
  },
  {
    key: 'routed',
    kind: 'quality',
    question: 'Does a by-description query reach the store that actually holds the answer?',
    artifact: 'evals/baseline.json',
    maxAgeDays: 14,
    read: (j) => ({ value: pct(j?.score?.routed), detail: frac(j?.score?.routed), at: j?.recorded }),
  },
  {
    key: 'abstained',
    kind: 'quality',
    question: 'When it does NOT know, does it decline instead of producing something?',
    artifact: 'evals/baseline.json',
    maxAgeDays: 14,
    read: (j) => ({ value: pct(j?.score?.abstain), detail: frac(j?.score?.abstain), at: j?.recorded }),
  },
  {
    key: 'panelStrict',
    kind: 'quality',
    question: 'How do INDEPENDENT-vendor graders score the answers, strictly? (ADR-0002 gate)',
    artifact: 'data/grade-*.json',
    maxAgeDays: 30,
    read: null, // aggregated across files — see readPanel()
  },
  {
    key: 'catalogue',
    kind: 'coverage',
    question: 'What FRACTION of rUv\'s live repos has a store at all? (NOT a quality measure)',
    artifact: 'data/org-repo-count.json + the live store root',
    maxAgeDays: 7,
    read: null, // derived — see readCatalogue()
  },
  {
    key: 'routable',
    kind: 'coverage',
    question: 'What fraction of BUILT stores can a by-description query actually reach?',
    artifact: 'capability-cards.md at the store root',
    maxAgeDays: 7,
    read: null,
  },
];

/**
 * Is this store reachable by a by-description query? ALIAS-AWARE, because the router is.
 *
 * Pure and exported so the rule can be tested without a live store root — the previous version was
 * an inline `cards.has(s)` buried in an async reader, which is why nobody noticed it disagreed with
 * the router. `resolve` is injected rather than imported here so a fixture can supply its own
 * registry; production passes `repositoryNames` from kb/card-lane.mjs, the router's own resolver.
 */
export function isRoutable(store, cards, root, resolve) {
  return resolve(store, root).some((name) => cards.has(name));
}

const pct = (s) => (s && Number.isFinite(s.p) ? Math.round(s.p * 1000) / 10 : null);
const frac = (s) => (s && Number.isFinite(s.k) ? `${s.k}/${s.n}` : null);

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; }
}

/**
 * Aggregate the multi-vendor panel across whatever stores have actually been graded.
 *
 * `at` comes from each file's OWN `summary.recordedAt` (written by the producer,
 * `scripts/brain-grade-groundtruth.mjs`) — never from `fs.statSync(...).mtime`. A `git clone` or
 * `git checkout` resets every file's mtime to the checkout instant, so a panel graded weeks ago
 * read as "0d old" on any fresh checkout, a CI runner, or this very nightly agent's own ephemeral
 * container — the exact "quoted a 34-day-old reading as current" defect this file's own header
 * names as the reason `maxAgeDays`/`staleness()` exist, alive in the one dimension that never used
 * them. Measured 2026-09-06: this container's `data/grade-*.json` mtimes are today's checkout time
 * regardless of when the panel actually ran (last touched, per `git log`, 2026-08-21).
 *
 * A file with no `recordedAt` (every grade file committed before this fix) has no trustworthy
 * timestamp at all — `at: null` here, same as `staleness()` already does for any other artifact
 * with nothing recorded, so it reads STALE / "no timestamp recorded" rather than borrowing a
 * fabricated freshness from disk. That is the safe direction: this repo's own rule elsewhere in
 * this file is that a wrong number is worse than an honestly unmeasured one.
 */
export function readPanel(dir = path.join(ROOT, 'data')) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^grade-.*\.json$/.test(f)); } catch { /* none */ }
  const readGrade = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const rows = files.map((f) => ({ f, j: readGrade(f) })).filter((r) => r.j?.summary);
  if (!rows.length) return { value: null, detail: null, at: null };
  const strict = rows.map((r) => r.j.summary.avgStrict).filter(Number.isFinite);
  if (!strict.length) return { value: null, detail: null, at: null };
  const at = rows
    .map((r) => r.j.summary.recordedAt)
    .filter((v) => typeof v === 'string' && v.trim())
    .sort().pop() ?? null;
  return {
    value: Math.round((strict.reduce((a, b) => a + b, 0) / strict.length) * 10) / 10,
    detail: `${strict.length} store(s) graded`,
    at,
  };
}

/**
 * Coverage is DERIVED from the live store root, never from a number in a doc. Returns null rather
 * than a guess when the denominator is unknown — a wrong denominator still renders, which is worse
 * than an absent one.
 */
export async function readCoverage(rootOverride) {
  const { storeRoot, storesAt, cardsAt, rootNeverMaterialized } = await import('../kb/store-root.mjs');
  // ROUTABILITY IS ALIAS-AWARE, BECAUSE THE ROUTER IS.
  //
  // `carded` was `stores.filter((s) => cards.has(s))` — a direct name match against card HEADINGS,
  // while the real router resolves a store through `repositoryNames()` first. So a store reachable
  // ONLY under an alias counted as unroutable, and this metric under-reported the brain's own
  // reachability: measured 2026-08-19, 30 stores called unroutable when 26 actually are —
  // `metaharness` among the four, which is reachable through the `agent-harness-generator` card.
  //
  // That is not a rounding error, it is the same alias-blindness ADR-058 records as open in
  // `darkStores()`, and it already cost something real: a false "dark store" reading led to a
  // DUPLICATE `## metaharness` card being added, which collided with `agent-harness-generator` and
  // broke alias resolution outright. A metric that cannot see aliases manufactures work that
  // damages the thing it measures.
  const { repositoryNames } = await import('../kb/card-lane.mjs');
  const root = rootOverride ?? storeRoot();
  // NEVER-MATERIALIZED, THE SAME AMBIGUITY `restore-local-ingests.mjs`'s `classify()` WAS FIXED
  // FOR (PR #143, Night 1) — but never carried here. `storesAt()`/`cardsAt()` silently return
  // `[]` on ENOENT, so a host whose store root was never restored (a fresh checkout, this very
  // nightly agent's own ephemeral container) reads IDENTICALLY to a materialized root that
  // genuinely has zero coverage. Checked once, here, before either derived number is computed —
  // a wrong `0` still renders, which is worse than an honestly unmeasured one.
  //
  // `rootNeverMaterialized()` (kb/store-root.mjs), not `fs.existsSync(root)`: the latter returns
  // `true` for a stray FILE at `root` (ENOTDIR) or an unreadable directory (EACCES), so either
  // rendered "materialized" here and let the exact same false-current-`0` back in for a different
  // errno class than ENOENT — flagged as an accepted, unfixed gap by the ENOENT-only fix itself.
  const neverMaterialized = rootNeverMaterialized(root);
  const stores = storesAt(root);
  const cards = new Set(cardsAt(root));
  const org = readJson('data/org-repo-count.json');
  const total = Number.isFinite(org?.count) && org.count > 0 ? org.count : null;
  const carded = stores.filter((s) => isRoutable(s, cards, root, repositoryNames)).length;
  const absentDetail = 'store root does not exist on this host (never materialized) — not evidence of live coverage';
  return {
    catalogue: {
      value: neverMaterialized ? null : (total ? Math.round((stores.length / total) * 1000) / 10 : null),
      detail: neverMaterialized ? absentDetail
        : (total ? `${stores.length}/${total} live repos` : `${stores.length} stores, org total UNKNOWN`),
      at: neverMaterialized ? null : (org?.at ?? null),
    },
    routable: {
      value: neverMaterialized || !stores.length ? null : Math.round((carded / stores.length) * 1000) / 10,
      detail: neverMaterialized ? absentDetail : `${carded}/${stores.length} built stores have a card`,
      // Derived from the live store root at this instant, so it is current BY CONSTRUCTION. A
      // read-now value reported as stale would train the reader to ignore the stale flag, which
      // costs more than the flag is worth.
      at: neverMaterialized ? null : new Date().toISOString(),
    },
  };
}

/** A reading past its dimension's `maxAgeDays`, or with no timestamp at all, is not current. */
export function staleness(at, maxAgeDays, now = Date.now()) {
  if (!at) return { stale: true, ageDays: null, why: 'no timestamp recorded' };
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return { stale: true, ageDays: null, why: 'unparseable timestamp' };
  const ageDays = Math.round((ms / DAY) * 10) / 10;
  return { stale: ageDays > maxAgeDays, ageDays, why: ageDays > maxAgeDays ? `${ageDays}d > ${maxAgeDays}d budget` : null };
}

export async function brainScore({ now = Date.now() } = {}) {
  const cov = await readCoverage();
  const out = [];
  for (const d of DIMENSIONS) {
    let r;
    if (d.key === 'panelStrict') r = readPanel();
    else if (cov[d.key]) r = cov[d.key];
    else r = d.read ? d.read(readJson(d.artifact)) : { value: null, detail: null, at: null };
    out.push({
      ...d,
      ...r,
      ...staleness(r.at, d.maxAgeDays, now),
      status: r.value === null ? 'unmeasured' : (staleness(r.at, d.maxAgeDays, now).stale ? 'stale' : 'current'),
    });
  }
  return out;
}

/**
 * THE STRUCTURAL GUARD. Averaging a coverage percentage with a quality percentage is precisely the
 * 52. It is refused here rather than discouraged in prose, because prose did not stop me.
 */
export function composite(dims, kind) {
  if (!kind) return { value: null, refused: 'a score must name WHICH question it answers — pass a kind' };
  const mine = dims.filter((d) => d.kind === kind);
  if (!mine.length) return { value: null, refused: `no dimensions of kind "${kind}"` };
  const usable = mine.filter((d) => d.status === 'current' && d.value !== null);
  if (usable.length < mine.length) {
    return {
      value: null,
      refused: `${mine.length - usable.length} of ${mine.length} ${kind} dimension(s) are stale or unmeasured`,
      missing: mine.filter((d) => !usable.includes(d)).map((d) => `${d.key} (${d.status})`),
    };
  }
  return { value: Math.round((usable.reduce((a, d) => a + d.value, 0) / usable.length) * 10) / 10, of: usable.length };
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const dims = await brainScore();
  const asJson = process.argv.includes('--json');
  if (asJson) {
    console.log(JSON.stringify({ recorded: new Date().toISOString(), dimensions: dims }, null, 2));
  } else {
    console.log('\nRUVNET-BRAIN — MEASURED, never typed. Each row names the question it answers.\n');
    for (const kind of ['quality', 'coverage']) {
      console.log(`  ${kind.toUpperCase()}`);
      for (const d of dims.filter((x) => x.kind === kind)) {
        const v = d.value === null ? 'UNMEASURED' : `${d.value}`.padStart(5);
        const age = d.ageDays === null ? '' : ` ${d.ageDays}d old`;
        const flag = d.status === 'current' ? '' : `  <-- ${d.status.toUpperCase()}${d.why ? ` (${d.why})` : ''}`;
        console.log(`    ${d.key.padEnd(13)} ${v}  ${(d.detail ?? '').padEnd(26)}${age}${flag}`);
        console.log(`      ${d.question}`);
      }
      const c = composite(dims, kind);
      console.log(c.value === null ? `    => NO ${kind} COMPOSITE: ${c.refused}` : `    => ${kind} composite ${c.value} (mean of ${c.of})`);
      console.log('');
    }
    console.log('  A quality number and a coverage number are NEVER averaged. That was the 52.\n');
  }
  const anyStale = dims.some((d) => d.status !== 'current');
  if (process.argv.includes('--require-current') && anyStale) {
    console.error('brain-score: refusing — at least one dimension is stale or unmeasured. Re-run the graders.');
    process.exit(1);
  }
}
