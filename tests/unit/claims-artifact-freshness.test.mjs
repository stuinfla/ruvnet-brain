// tests/unit/claims-artifact-freshness.test.mjs — a truth-gate whose verdict depends on an
// UNVALIDATED, ROTTABLE input is ceremony wearing the costume of substance.
//
// The defect these tests were written against (measured 2026-07-26): coverage/coverage-summary.json
// was NINE DAYS stale (mtime Jul 18) while scripts/claims-verify.mjs happily re-derived "the truth"
// from it and graded the README badge against a number nobody had measured since. Then a coverage run
// that ended on a failing test DELETED the file and wrote nothing at all. So the same gate could emit
// a false FAIL, a false PASS, or crash — three different lies from one unchecked precondition.
//
// The fix under test: the coverage claim is UNVERIFIABLE (a LOUD skip, never a number, never a silent
// pass) unless the artifact is present AND demonstrably fresher than the source set it claims to
// measure — that source set being derived from vitest.config.mjs's own coverage.include globs, not
// from a list hand-copied here that could itself rot.
//
// RED-FIRST — run against the UNFIXED scripts/claims-verify.mjs, before a line of the fix existed.
// Verbatim (vitest 4.1.10, node v22.13.1, 2026-07-26, `npx vitest run tests/unit/claims-artifact-freshness.test.mjs`):
//
//   AssertionError: expected 'coverage/coverage-summary.json absent…' to include undefined
//   TypeError: coverageFreshness is not a function
//   AssertionError: expected 'PASS' to be 'SKIP' // Object.is equality
//   AssertionError: expected 'PASS' to be 'SKIP' // Object.is equality
//   TypeError: coverageFreshness is not a function
//   TypeError: applyFix is not a function
//   TypeError: applyFix is not a function
//   TypeError: applyFix is not a function
//   TypeError: applyFix is not a function
//         Tests  9 failed | 2 passed (11)
//
// The two lines that matter are the middle ones: **"expected 'PASS' to be 'SKIP'"** is the shipped
// defect caught in the act — a coverage artifact older than the source it measures was GRADED, and
// graded as a confident pass. The 2 that were already green are the (c) regression pair: a fresh
// artifact must still be graded normally, which the old code did do; they are here so the fix cannot
// be "make it always skip", which would trade a false pass for a gate that never fires.
// tests/mutation/claims-freshness-mutation.test.mjs then re-breaks the precondition on purpose and
// proves the same fixture goes back to PASSing — so this file's verdicts are load-bearing, not lucky.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyCoverageBadge,
  verifyChunkCountSurfaces,
  coverageFreshness,
  applyFix,
  COVERAGE_REGEN_CMD,
} from '../../scripts/claims-verify.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-freshness-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Force an mtime ordering the test controls, instead of racing the filesystem clock. */
const setMtime = (file, secondsFromNow) => {
  const t = new Date(Date.now() + secondsFromNow * 1000);
  fs.utimesSync(file, t, t);
};

let seq = 0;
/** A self-contained fixture repo: vitest config + one covered source + (optionally) a coverage summary. */
function fixture({ pcts = { statements: 17, branches: 15.4, functions: 20, lines: 18 }, badge = 15, summary = true } = {}) {
  const root = path.join(TMP, `repo-${seq++}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });

  const srcFile = path.join(root, 'src', 'a.mjs');
  fs.writeFileSync(srcFile, 'export const a = 1;\n');

  const vitestFile = path.join(root, 'vitest.config.mjs');
  fs.writeFileSync(
    vitestFile,
    'export default { test: { coverage: { all: true, include: ["src/*.mjs"], exclude: [] } } };\n',
  );

  const readmeFile = path.join(root, 'README.md');
  fs.writeFileSync(
    readmeFile,
    `# X\n[![coverage](https://img.shields.io/badge/coverage-${badge}%25%20of%20ALL%20source%20·%20honest-b58900)](#)\n`,
  );

  const summaryFile = path.join(root, 'coverage', 'coverage-summary.json');
  if (summary) {
    fs.writeFileSync(
      summaryFile,
      JSON.stringify({
        total: {
          statements: { pct: pcts.statements },
          branches: { pct: pcts.branches },
          functions: { pct: pcts.functions },
          lines: { pct: pcts.lines },
        },
        [srcFile]: { statements: { pct: pcts.statements }, branches: { pct: pcts.branches }, functions: { pct: pcts.functions }, lines: { pct: pcts.lines } },
      }),
    );
    // Default state is FRESH: sources and the config that defines them are older than the run that
    // measured them. Tests that want staleness move ONE file forward, so what is under test is
    // unambiguous.
    setMtime(srcFile, -600);
    setMtime(vitestFile, -600);
    setMtime(summaryFile, -300);
  }
  return { root, srcFile, vitestFile, readmeFile, summaryFile };
}

describe('(a) the coverage artifact is ABSENT — UNVERIFIABLE, and it names the exact regenerate command', () => {
  it('SKIPs (not a pass, not a number) and prints the command that fixes it', async () => {
    const f = fixture({ summary: false });
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status).toBe('SKIP');
    expect(res.evidence).toContain(COVERAGE_REGEN_CMD);
    expect(COVERAGE_REGEN_CMD).toBe('npm run test:cov');
    // never a derived number when nothing was measured
    expect(res.evidence).not.toMatch(/re-derived floor/);
  });

  it('coverageFreshness reports the absence as its own code, not a generic failure', async () => {
    const f = fixture({ summary: false });
    const state = await coverageFreshness(f.summaryFile, f.vitestFile, f.root);
    expect(state.fresh).toBe(false);
    expect(state.code).toBe('absent');
  });
});

describe('(b) the coverage artifact is OLDER than a source it claims to measure — UNVERIFIABLE, never a number', () => {
  it('SKIPs even when the stale numbers would have AGREED with the badge (the false PASS this exists to kill)', async () => {
    // The nine-day-stale artifact matched the badge, so grading it produced a confident PASS about a
    // measurement nobody had taken since. Freshness must refuse BEFORE the arithmetic is reached.
    const f = fixture({ pcts: { statements: 17, branches: 15.4, functions: 20, lines: 18 }, badge: 15 });
    setMtime(f.srcFile, -60); // the one covered source, edited AFTER the run that measured it
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status).toBe('SKIP');
    expect(res.evidence).toContain(COVERAGE_REGEN_CMD);
    expect(res.evidence).toMatch(/stale|older/i);
    expect(res.evidence).toContain('a.mjs'); // names the source that outran it
    expect(res.evidence).not.toMatch(/re-derived floor/); // no verdict was reached
    expect(res.evidence).not.toMatch(/\b15%\b/); // and no number was published
  });

  it('SKIPs a summary that is missing files the include globs cover (a partial write is not truth)', async () => {
    const f = fixture();
    const b = path.join(f.root, 'src', 'b.mjs');
    fs.writeFileSync(b, 'export const b = 2;\n'); // matched by the globs, never measured
    setMtime(b, -600); //                            older than the run, so ONLY partiality can fail it
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status).toBe('SKIP');
    expect(res.evidence).toMatch(/partial|missing/i);
    expect(res.evidence).toContain('b.mjs');
    expect(res.evidence).toContain(COVERAGE_REGEN_CMD);
  });

  it('coverageFreshness derives the source set from vitest.config.mjs, not from a hand-copied list', async () => {
    const f = fixture();
    // A file OUTSIDE the config's include globs, newer than the run: irrelevant, because the config
    // says it is not part of what was measured.
    fs.mkdirSync(path.join(f.root, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'unrelated', 'z.mjs'), 'export const z = 3;\n');
    expect((await coverageFreshness(f.summaryFile, f.vitestFile, f.root)).fresh).toBe(true);

    // The SAME edit inside the globs is what makes the measurement stale.
    setMtime(f.srcFile, -60);
    const stale = await coverageFreshness(f.summaryFile, f.vitestFile, f.root);
    expect(stale.fresh).toBe(false);
    expect(stale.code).toBe('stale');
    expect(stale.reason).toContain('a.mjs');
  });
});

describe('(c) a FRESH artifact grades normally — the gate still does its job', () => {
  it('PASSes a badge that matches floor(min of the four metrics)', async () => {
    const f = fixture({ pcts: { statements: 17, branches: 15.4, functions: 20, lines: 18 }, badge: 15 });
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status, res.evidence).toBe('PASS');
    expect(res.evidence).toContain('15');
  });

  it('still FAILs a lying badge when the artifact is fresh (freshness is a precondition, not an amnesty)', async () => {
    const f = fixture({ pcts: { statements: 16.21, branches: 14.55, functions: 19.69, lines: 17.38 }, badge: 10 });
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('10%'); // the false claim
    expect(res.evidence).toContain('14%'); // the re-derived truth
  });
});

describe('(d) the writer regenerates every surface in ONE pass, from the real artifacts, idempotently', () => {
  // Four surfaces that drifted four different ways — exactly how 149,930 outlived 150,161 in four files.
  const mkSurfaceRepo = (name) => {
    const root = path.join(TMP, name);
    fs.mkdirSync(path.join(root, 'explainer'), { recursive: true });
    fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });

    const kb = path.join(root, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
    const idmap = (n) => {
      const idToLabel = {};
      for (let i = 0; i < n; i++) idToLabel[i] = `chunk-${i}`;
      return JSON.stringify({ idToLabel });
    };
    fs.writeFileSync(path.join(kb, 'alpha.big.rvf.idmap.json'), idmap(1200));
    fs.writeFileSync(path.join(kb, 'beta.big.rvf.idmap.json'), idmap(34)); // public total = 1,234 / 2 stores
    fs.writeFileSync(path.join(kb, 'secret.big.rvf.idmap.json'), idmap(999)); // private, fenced out

    fs.writeFileSync(
      path.join(root, 'README.md'),
      '# X\n' +
        '[![coverage](https://img.shields.io/badge/coverage-9%25%20of%20ALL%20source%20·%20honest-b58900)](#)\n\n' +
        'That is **111,111 source chunks** across 3 public stores (4 built stores incl. private).\n' +
        '| **Unit tests** | 9% of ALL source covered | 9% is the honest number |\n',
    );
    fs.writeFileSync(
      path.join(root, 'explainer', 'index.html'),
      '<p>222,222 public source chunks (4 built stores incl. private)</p>\n' +
        '<div><span data-count="3" data-decimals="0">3</span> public stores</div>\n',
    );
    fs.writeFileSync(path.join(root, 'explainer', 'llms.txt'), '- Coverage: 3 public stores · 333,333 public source chunks (4 built stores incl. private).\n');
    fs.writeFileSync(
      path.join(root, 'explainer', 'llms-full.txt'),
      'source code (444,444 public source chunks across 3 public\nstores; 4 built stores incl. private) and grounds the answer\n',
    );

    fs.writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'vitest.config.mjs'), 'export default { test: { coverage: { all: true, include: ["src/*.mjs"], exclude: [] } } };\n');
    const summaryFile = path.join(root, 'coverage', 'coverage-summary.json');
    const srcFile = path.join(root, 'src', 'a.mjs');
    fs.writeFileSync(
      summaryFile,
      JSON.stringify({
        total: { statements: { pct: 42.4 }, branches: { pct: 41.9 }, functions: { pct: 44 }, lines: { pct: 43 } },
        [srcFile]: { statements: { pct: 42.4 } },
      }),
    );
    setMtime(srcFile, -600);
    setMtime(path.join(root, 'vitest.config.mjs'), -600);
    setMtime(summaryFile, -300);
    return { root, kb, summaryFile, vitestFile: path.join(root, 'vitest.config.mjs'), srcFile };
  };

  const SURFACES = ['README.md', 'explainer/index.html', 'explainer/llms.txt', 'explainer/llms-full.txt'];
  // The private-stores fence is a repo-committed policy file, decoupled from kbDir (which now
  // defaults to the canonical store root, not <repo>/kb — see scripts/claims-verify.mjs). This
  // fixture colocates a synthetic fence with its synthetic idmaps, so it must say so explicitly.
  const opts = (f) => ({
    root: f.root,
    kbDir: f.kb,
    privateStoresFile: path.join(f.kb, 'PRIVATE-STORES.json'),
    surfaces: SURFACES,
    readmeFile: path.join(f.root, 'README.md'),
    summaryFile: f.summaryFile,
    vitestFile: f.vitestFile,
  });

  it('one pass makes all four surfaces quote the SAME re-derived count, and the ledger then passes', async () => {
    const f = mkSurfaceRepo('surfaces-one-pass');
    const report = await applyFix({ ...opts(f), write: true });
    expect(report.changed.length).toBeGreaterThanOrEqual(4);

    for (const rel of SURFACES) {
      const s = fs.readFileSync(path.join(f.root, rel), 'utf8');
      expect(s, rel).toContain('1,234');
      expect(s, rel).not.toMatch(/111,111|222,222|333,333|444,444/);
    }
    expect(verifyChunkCountSurfaces(f.kb, SURFACES, f.root, path.join(f.kb, 'PRIVATE-STORES.json')).status).toBe('PASS');

    // the badge and BOTH prose copies moved together, to floor(min) = 41
    const readme = fs.readFileSync(path.join(f.root, 'README.md'), 'utf8');
    expect(readme).toContain('coverage-41%25%20of%20ALL%20source');
    expect(readme).toContain('41% of ALL source covered');
    expect(readme).toContain('41% is the honest number');
    expect(readme).not.toMatch(/\b9%/);
    expect((await verifyCoverageBadge(path.join(f.root, 'README.md'), f.summaryFile, f.vitestFile, f.root)).status).toBe('PASS');
  });

  it('is idempotent — a second pass changes nothing', async () => {
    const f = mkSurfaceRepo('surfaces-idempotent');
    await applyFix({ ...opts(f), write: true });
    const before = SURFACES.map((rel) => fs.readFileSync(path.join(f.root, rel), 'utf8'));
    const second = await applyFix({ ...opts(f), write: true });
    expect(second.changed).toEqual([]);
    SURFACES.forEach((rel, i) => expect(fs.readFileSync(path.join(f.root, rel), 'utf8'), rel).toBe(before[i]));
  });

  it('writes NOTHING by default — the gate is read-only unless --fix is asked for', async () => {
    const f = mkSurfaceRepo('surfaces-dry-run');
    const before = SURFACES.map((rel) => fs.readFileSync(path.join(f.root, rel), 'utf8'));
    const report = await applyFix({ ...opts(f), write: false });
    expect(report.changed.length).toBeGreaterThanOrEqual(4); // it still REPORTS what would change
    SURFACES.forEach((rel, i) => expect(fs.readFileSync(path.join(f.root, rel), 'utf8'), rel).toBe(before[i]));
  });

  it('REFUSES to stamp a coverage number from a stale artifact — the writer obeys the same precondition as the gate', async () => {
    const f = mkSurfaceRepo('surfaces-stale');
    setMtime(f.srcFile, -60); // source now newer than the measurement
    const report = await applyFix({ ...opts(f), write: true });
    const readme = fs.readFileSync(path.join(f.root, 'README.md'), 'utf8');
    expect(readme).toContain('coverage-9%25'); // untouched — a rotten number is never propagated
    expect(report.coverage.skipped).toBe(true);
    expect(report.coverage.reason).toMatch(/stale|older/i);
    // ...while the chunk counts, whose artifacts ARE present, are still fixed in the same pass
    expect(readme).toContain('1,234');
  });
});
