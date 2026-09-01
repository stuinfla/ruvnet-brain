// tests/unit/claims-verify.test.mjs — the claims ledger (ADR-0011 Phase 0) is what makes every
// advertised number falsifiable, so each checker gets a test proving it FAILS on a tampered
// artifact. A ledger that can only pass verifies nothing.
//
// scripts/claims-verify.mjs is main-guarded (like scripts/eval-brain.mjs), so importing its
// checkers here runs no CLI. Every checker takes artifact paths as parameters with repo
// defaults — tampered copies go to a tmpdir and the checker is pointed at them.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ledger,
  invariants,
  verifyBaseline,
  verifyHeldOutStrata,
  verifyCheaperFactor,
  verifyCoverageBadge,
  verifyVersionSurfaces,
  verifyChunkCountSurfaces,
  computePublicChunkTotal,
  countBuiltStores,
  brainCensus,
  CHUNK_SURFACES,
  PRIVATE_STORES_FILE,
  EXPECTED_STRATA,
  readBadgePct,
} from '../../scripts/claims-verify.mjs';
import { storeRoot } from '../../kb/store-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-verify-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const writeTmp = (name, content) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
};

describe('ledger shape', () => {
  it('has six number claims plus one row per registered invariant, each with claim/source/verify', () => {
    // The bare `6` was correct until ADR-058's critical-invariant VECTOR started riding the same
    // runner (so a named invariant obeys the identical "a skip is never a silent pass" rule). Kept
    // as an arithmetic identity rather than bumped to a new magic number: a new invariant must still
    // be a deliberate edit here, and a claim quietly disappearing still goes red.
    expect(ledger.length).toBe(6 + invariants.length);
    for (const entry of ledger) {
      expect(typeof entry.claim).toBe('string');
      expect(typeof entry.source).toBe('string');
      expect(typeof entry.verify).toBe('function');
    }
  });

  it('registers LEARNING-REPLAY in the invariant vector', () => {
    expect(invariants.map((i) => i.name)).toContain('LEARNING-REPLAY');
  });
});

describe('verifyBaseline — recorded truth + shape consistency', () => {
  const realBaseline = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/baseline.json'), 'utf8'));

  it('passes on the real repo artifact', () => {
    expect(verifyBaseline().status).toBe('PASS');
  });

  it('rejects k > n — an impossible count must never verify', () => {
    const b = realBaseline();
    b.score.grounded.k = b.score.grounded.n + 5;
    const res = verifyBaseline(writeTmp('baseline-k-gt-n.json', b));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toMatch(/k=105 > n=100|p=.*≠/);
  });

  it('rejects a broken interval (p above hi)', () => {
    const b = realBaseline();
    b.score.routed.hi = b.score.routed.p - 0.1;
    const res = verifyBaseline(writeTmp('baseline-bad-interval.json', b));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('interval broken');
  });

  it('rejects drift from the recorded truth (routed n changed)', () => {
    const b = realBaseline();
    b.score.routed.n = 81;
    b.score.routed.p = b.score.routed.k / 81;
    b.score.routed.lo = 0;
    b.score.routed.hi = 1;
    const res = verifyBaseline(writeTmp('baseline-routed-n.json', b));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('routed n=80');
  });

  it('fails, not throws, on a missing file', () => {
    expect(verifyBaseline(path.join(TMP, 'nope.json')).status).toBe('FAIL');
  });
});

describe('verifyHeldOutStrata — the census is recounted, not trusted', () => {
  const realSet = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/held-out.json'), 'utf8'));

  it('passes on the real frozen set (120 across 5 strata)', () => {
    expect(verifyHeldOutStrata().status).toBe('PASS');
  });

  it('fails on a tampered copy with a question removed', () => {
    const s = realSet();
    s.questions = s.questions.slice(1);
    const res = verifyHeldOutStrata(writeTmp('held-out-minus-one.json', s));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('119 ≠ 120');
  });

  it('fails on a tampered copy with a question moved between strata (total still 120)', () => {
    const s = realSet();
    const q = s.questions.find((x) => x.stratum === 'named');
    q.stratum = 'described';
    const res = verifyHeldOutStrata(writeTmp('held-out-moved.json', s));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toMatch(/named: 27 ≠ 28/);
  });

  it('fails on an unexpected sixth stratum', () => {
    const s = realSet();
    s.questions[0] = { ...s.questions[0], stratum: 'bonus' };
    const res = verifyHeldOutStrata(writeTmp('held-out-sixth.json', s));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('unexpected stratum "bonus"');
  });

  it('advertised census matches ADR-0011', () => {
    expect(EXPECTED_STRATA).toEqual({ named: 28, described: 32, scenario: 20, adversarial: 20, provenance: 20 });
  });
});

describe('verifyCheaperFactor — ~56× regenerates from the corpus, or skips LOUDLY', () => {
  it('SKIPs (never silently passes) when the brain is not installed', async () => {
    const res = await verifyCheaperFactor(path.join(TMP, 'absent.passages.jsonl'));
    expect(res.status).toBe('SKIP');
    expect(res.evidence).toContain('brain not installed');
  });

  it('fails when the corpus fact is missing from the passages file', async () => {
    const p = writeTmp('tampered.passages.jsonl', '{"text":"a run cost $9.99 and nothing else"}\n');
    const res = await verifyCheaperFactor(p);
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('$0.267');
  });

  it('passes when both corpus strings are present (streaming, first match wins)', async () => {
    const p = writeTmp(
      'good.passages.jsonl',
      '{"text":"total run cost $0.267"}\n{"text":"vs $15 direct — 51.33 dollars-per-run baseline"}\n',
    );
    const res = await verifyCheaperFactor(p);
    expect(res.status).toBe('PASS');
    expect(res.evidence).toContain('56.2');
  });

  it('defaults to the canonical store root (kb/store-root.mjs), not <repo>/kb', async () => {
    const res = await verifyCheaperFactor();
    expect(['PASS', 'SKIP']).toContain(res.status);
    // storeRoot() honors KB_DIR/RUVNET_BRAIN_KB, so this can legitimately equal <repo>/kb under an
    // explicit override — the invariant is that the default TRACKS storeRoot(), not a hardcoded path.
    if (res.status === 'SKIP') expect(res.evidence).toContain(storeRoot());
  });
});

describe('verifyCoverageBadge — the badge % is RE-DERIVED from the real coverage run, never string-matched', () => {
  // v8 json-summary shape: { total: { statements:{pct}, branches:{pct}, functions:{pct}, lines:{pct} } }
  let seq = 0;
  const summary = (pcts) => writeTmp(`cov-summary-${seq++}.json`, {
    total: {
      statements: { pct: pcts.statements },
      branches: { pct: pcts.branches },
      functions: { pct: pcts.functions },
      lines: { pct: pcts.lines },
    },
  });
  const realVitest = path.join(ROOT, 'vitest.config.mjs');
  const realReadme = path.join(ROOT, 'README.md');
  // The four live metrics measured 2026-07-18 (min = branches 14.55 → floor 14, the shipped badge).
  const liveIsh = { statements: 16.21, branches: 14.55, functions: 19.69, lines: 17.38 };

  // Since 2026-07-26 the checker refuses to grade an artifact it cannot show is fresher than the
  // source it measures (tests/unit/claims-artifact-freshness.test.mjs). A grading test therefore
  // needs a COMPLETE fixture — config, source, summary, mtimes — not just a `total` block: the old
  // half-fixtures paired a tmp summary with the REPO's config, which is exactly the "measures a
  // source set it has never seen" shape the precondition now rejects.
  const gradable = (name, pcts, badgePct) => {
    const root = path.join(TMP, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
    const src = path.join(root, 'src', 'a.mjs');
    const vitestFile = path.join(root, 'vitest.config.mjs');
    const readmeFile = path.join(root, 'README.md');
    const summaryFile = path.join(root, 'coverage', 'coverage-summary.json');
    fs.writeFileSync(src, 'export const a = 1;\n');
    fs.writeFileSync(vitestFile, 'export default { test: { coverage: { all: true, include: ["src/*.mjs"], exclude: [] } } };\n');
    fs.writeFileSync(readmeFile, `# X\n[![coverage](https://img.shields.io/badge/coverage-${badgePct}%25%20of%20ALL%20source%20·%20honest-b58900)](#)\n`);
    fs.writeFileSync(summaryFile, JSON.stringify({
      total: { statements: { pct: pcts.statements }, branches: { pct: pcts.branches }, functions: { pct: pcts.functions }, lines: { pct: pcts.lines } },
      [src]: { statements: { pct: pcts.statements } },
    }));
    const at = (f, s) => { const t = new Date(Date.now() + s * 1000); fs.utimesSync(f, t, t); };
    at(src, -600); at(vitestFile, -600); at(summaryFile, -300); // measured AFTER the source it measures
    return { root, readmeFile, summaryFile, vitestFile };
  };

  it('readBadgePct parses the advertised integer from the real README, null when the badge is gone', () => {
    const n = readBadgePct(fs.readFileSync(realReadme, 'utf8'));
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
    expect(readBadgePct('no badge here')).toBeNull();
  });

  it('passes: a badge that matches floor(min of the four metrics) within 1pt', async () => {
    const f = gradable('cov-pass', { statements: 17, branches: 15.4, functions: 20, lines: 18 }, 15);
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status, res.evidence).toBe('PASS');
    expect(res.evidence).toContain('15');
  });

  it('KNOWN-BAD (the exact live lie just fixed): badge says 10% while the real floor is 14% → FAIL naming both', async () => {
    const f = gradable('cov-lying', liveIsh, 10);
    const res = await verifyCoverageBadge(f.readmeFile, f.summaryFile, f.vitestFile, f.root);
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('10%'); // the false claim
    expect(res.evidence).toContain('14%'); // the re-derived truth
  });

  it('SKIPs LOUDLY (never a silent pass) when the coverage summary has not been generated', async () => {
    const res = await verifyCoverageBadge(realReadme, path.join(TMP, 'no-such-summary.json'), realVitest);
    expect(res.status).toBe('SKIP');
    expect(res.evidence).toContain('test:cov');
  });

  it('fails when the coverage badge is gone from the README entirely', async () => {
    const noBadge = writeTmp('README-no-badge.md', '# RuvNet Brain\n\nNo badge here.\n');
    const res = await verifyCoverageBadge(noBadge, summary(liveIsh), realVitest);
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('badge');
  });

  it('fails when vitest.config no longer sets all: true, even with the badge intact', async () => {
    const vitestCfg = writeTmp('vitest-no-all.config.mjs', 'export default { test: { coverage: { all: false } } };\n');
    const res = await verifyCoverageBadge(realReadme, summary(liveIsh), vitestCfg);
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('all: true');
  });
});

describe('verifyChunkCountSurfaces — the advertised chunk count regenerates, or skips LOUDLY', () => {
  // Build a miniature brain in tmp: two public stores + one private, with idmap sidecars.
  const idmap = (n) => {
    const idToLabel = {};
    for (let i = 0; i < n; i++) idToLabel[i] = `chunk-${i}`;
    return { idToLabel, labelToId: {}, nextLabel: n };
  };
  const mkBrain = (dirName) => {
    const kb = path.join(TMP, dirName);
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
    fs.writeFileSync(path.join(kb, 'alpha.big.rvf.idmap.json'), JSON.stringify(idmap(1200)));
    fs.writeFileSync(path.join(kb, 'beta.big.rvf.idmap.json'), JSON.stringify(idmap(34)));
    fs.writeFileSync(path.join(kb, 'secret.big.rvf.idmap.json'), JSON.stringify(idmap(999)));
    return kb;
  };

  it('SKIPs (never silently passes) when the brain is not installed', () => {
    const empty = path.join(TMP, 'no-kb');
    fs.mkdirSync(empty, { recursive: true });
    const res = verifyChunkCountSurfaces(empty);
    expect(res.status).toBe('SKIP');
    expect(res.evidence).toContain('brain not installed');
  });

  // mkBrain colocates the fence file with the idmap sidecars for fixture convenience; production
  // does not (see the canonical-root tests below), so every call here passes the fence path
  // explicitly rather than relying on the (now real-repo-pointing) default.
  const fence = (kb) => path.join(kb, 'PRIVATE-STORES.json');

  it('computePublicChunkTotal sums public stores only — the private fence holds', () => {
    const kb = mkBrain('kb-fence');
    expect(computePublicChunkTotal(kb, fence(kb))).toEqual({ total: 1234, stores: 2 });
  });

  it('passes when every surface quotes the regenerated count', () => {
    const kb = mkBrain('kb-good');
    const root = path.join(TMP, 'root-good');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'S.md'), 'That is **1,234 source chunks** in the brain.\n');
    const res = verifyChunkCountSurfaces(kb, ['S.md'], root, fence(kb));
    expect(res.status).toBe('PASS');
    expect(res.evidence).toContain('1,234');
  });

  it('fails when a surface still quotes a STALE count, even alongside the fresh one', () => {
    const kb = mkBrain('kb-stale');
    const root = path.join(TMP, 'root-stale');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'S.md'), '1,234 chunks here, but elsewhere 128,994 source chunks.\n');
    const res = verifyChunkCountSurfaces(kb, ['S.md'], root, fence(kb));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('128,994');
  });

  it('fails when a surface simply does not quote the number', () => {
    const kb = mkBrain('kb-missing');
    const root = path.join(TMP, 'root-missing');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'S.md'), 'A brain of unspecified size.\n');
    const res = verifyChunkCountSurfaces(kb, ['S.md'], root, fence(kb));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('does not contain');
  });

  it('fails when the explainer animated counter data-count attribute is stale', () => {
    const kb = mkBrain('kb-counter');
    const root = path.join(TMP, 'root-counter');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'S.html'),
      '1,234 source chunks. <span data-count="9999">1,234</span> chunks\n',
    );
    const res = verifyChunkCountSurfaces(kb, ['S.html'], root, fence(kb));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('data-count="9999"');
  });

  it('passes on the real repo artifacts when the brain is present (else skips)', () => {
    const res = verifyChunkCountSurfaces();
    expect(['PASS', 'SKIP']).toContain(res.status);
    if (res.status === 'PASS') expect(res.evidence).toContain(`${CHUNK_SURFACES.length} surfaces`);
  });

  // Before this fix, computePublicChunkTotal/countBuiltStores/brainCensus/verifyChunkCountSurfaces
  // all defaulted kbDir to `<repo>/kb`, the same anti-pattern kb/forge-currency.mjs's brainKnownSet()
  // carried until PR #222 (kb/store-root.mjs's own header: "<repo>/kb — a gitignored BUILD
  // WORKSPACE, never a second brain"). A host with a real installed brain at the canonical root but
  // nothing under `<repo>/kb` reported a false "brain not installed" SKIP. Proven here via
  // storeRoot()'s own documented RUVNET_BRAIN_KB override — passing `undefined` explicitly (as
  // opposed to omitting the arg) still triggers the default, so this exercises the exact same
  // default-parameter expression a real zero-arg call does.
  describe('kbDir sources from storeRoot(), not a hardcoded <repo>/kb', () => {
    let prevRoot;
    const withRoot = (dir, fn) => {
      prevRoot = process.env.RUVNET_BRAIN_KB;
      process.env.RUVNET_BRAIN_KB = dir;
      try { return fn(); } finally {
        if (prevRoot === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = prevRoot;
      }
    };

    it('computePublicChunkTotal / countBuiltStores / brainCensus follow RUVNET_BRAIN_KB', () => {
      const kb = mkBrain('kb-env-root');
      withRoot(kb, () => {
        expect(computePublicChunkTotal(undefined, fence(kb))).toEqual({ total: 1234, stores: 2 });
        expect(countBuiltStores()).toBe(3); // private fence not applied here — all 3 idmaps count
        expect(brainCensus(undefined, fence(kb))).toEqual({ chunks: 1234, publicStores: 2, builtStores: 3 });
      });
    });

    it('verifyChunkCountSurfaces follows RUVNET_BRAIN_KB for the zero-arg (real CLI) call shape', () => {
      const kb = mkBrain('kb-env-root-verify');
      const root = path.join(TMP, 'root-env-root-verify');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'S.md'), 'That is **1,234 source chunks** in the brain.\n');
      withRoot(kb, () => {
        const res = verifyChunkCountSurfaces(undefined, ['S.md'], root, fence(kb));
        expect(res.status).toBe('PASS');
        expect(res.evidence).toContain('1,234');
      });
    });
  });

  it('keeps the private-stores fence pinned to the repo-committed file regardless of kbDir', () => {
    // The fence is a policy file this repo commits at a fixed path (scripts/build-bundle.mjs reads
    // the identical path); it must not silently empty out just because kbDir now points at the
    // canonical store root instead of <repo>/kb.
    expect(PRIVATE_STORES_FILE).toBe(path.join(ROOT, 'kb', 'PRIVATE-STORES.json'));
    expect(fs.existsSync(PRIVATE_STORES_FILE)).toBe(true);
  });
});

describe('verifyVersionSurfaces — delegates to the existing single-source-of-truth check', () => {
  it('passes on the real repo (sync-version --check exits 0)', () => {
    const res = verifyVersionSurfaces();
    // evidence in the message: on a FAIL, the runner names the drifted surface instead of just 'FAIL'
    expect(res.status, res.evidence).toBe('PASS');
    expect(res.evidence).toContain('agree');
  });
});

describe('claims:verify read-only contract', () => {
  const PRUNE = new Set(['.git', '.swarm', 'node_modules', 'coverage', 'dist', 'clones']);

  // Git-independent on purpose: this catches creation or mutation of ignored/untracked artifacts
  // too (the exact regression was evals/runs/top-100-latest.json). Size + mtime is sufficient for
  // the purity boundary and avoids hashing the installed brain's hundreds of megabytes.
  function repoSnapshot() {
    const rows = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && PRUNE.has(ent.name)) continue;
        const absolute = path.join(dir, ent.name);
        const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
        if (ent.isDirectory()) {
          walk(absolute);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          const stat = fs.lstatSync(absolute);
          rows.push(`${relative}\0${stat.size}\0${stat.mtimeMs}`);
        }
      }
    };
    walk(ROOT);
    return rows.sort();
  }

  it('the CLI changes no repo file and creates no artifact', () => {
    const before = repoSnapshot();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'claims-verify.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        // Keep the check deterministic and cheap; absence is an intentional loud SKIP.
        RUVNET_BRAIN_KB: path.join(TMP, 'purity-absent-brain'),
      },
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(repoSnapshot()).toEqual(before);
  });
});
