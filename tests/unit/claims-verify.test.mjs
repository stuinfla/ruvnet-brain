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
import { fileURLToPath } from 'node:url';
import {
  ledger,
  verifyBaseline,
  verifyHeldOutStrata,
  verifyCheaperFactor,
  verifyCoverageBadge,
  verifyVersionSurfaces,
  EXPECTED_STRATA,
  BADGE_NEEDLE,
} from '../../scripts/claims-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-verify-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const writeTmp = (name, content) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
};

describe('ledger shape', () => {
  it('has five claims, each with claim/source/verify', () => {
    expect(ledger.length).toBe(5);
    for (const entry of ledger) {
      expect(typeof entry.claim).toBe('string');
      expect(typeof entry.source).toBe('string');
      expect(typeof entry.verify).toBe('function');
    }
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
});

describe('verifyCoverageBadge — README and vitest.config must drift together or not at all', () => {
  it('passes on the real repo artifacts', () => {
    expect(verifyCoverageBadge().status).toBe('PASS');
  });

  it('fails when the badge string is absent from the README', () => {
    const readme = writeTmp('README-no-badge.md', '# RuvNet Brain\n\nNo badge here.\n');
    const res = verifyCoverageBadge(readme, path.join(ROOT, 'vitest.config.mjs'));
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain(BADGE_NEEDLE);
    expect(res.evidence).toContain('re-run');
  });

  it('fails when vitest.config no longer sets all: true, even with the badge intact', () => {
    const vitestCfg = writeTmp('vitest-no-all.config.mjs', 'export default { test: { coverage: { all: false } } };\n');
    const res = verifyCoverageBadge(path.join(ROOT, 'README.md'), vitestCfg);
    expect(res.status).toBe('FAIL');
    expect(res.evidence).toContain('all: true');
  });
});

describe('verifyVersionSurfaces — delegates to the existing single-source-of-truth check', () => {
  it('passes on the real repo (sync-version --check exits 0)', () => {
    const res = verifyVersionSurfaces();
    expect(res.status).toBe('PASS');
    expect(res.evidence).toContain('agree');
  });
});
