import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATIONAL_FIXTURES,
  gradeOperationalFixture,
  latencyDistribution,
  verifyFixtureSourceSupport,
} from '../../evals/operational-benchmark.v2.mjs';

const fixtureHash = createHash('sha256').update(JSON.stringify(OPERATIONAL_FIXTURES)).digest('hex');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const citation = (repo, docPath, ce = 1) => ({ rank: 1, repo, fullPath: `${repo}/${docPath}`, docPath, ce });

describe('independently authored operational benchmark', () => {
  it('freezes broad, named, negative, and ambiguity queries plus their source-fact oracles', () => {
    expect(fixtureHash).toBe('f87263ea8096e90aa489ed21ce3075508a5ef97636018002aa16756923a24dfd');
    expect(new Set(OPERATIONAL_FIXTURES.map((item) => item.class))).toEqual(new Set(['broad', 'named', 'negative', 'ambiguity']));
    for (const item of OPERATIONAL_FIXTURES.filter((entry) => ['broad', 'named'].includes(entry.class) && !entry.availability)) {
      expect(item.expectedRepos.length, item.id).toBeGreaterThan(0);
      expect(item.expectedFact, item.id).toBeTruthy();
    }
    for (const item of OPERATIONAL_FIXTURES.filter((entry) => ['negative', 'ambiguity'].includes(entry.class))) {
      expect(item.expectedRepos, item.id).toEqual([]);
      expect(item.expectedFact, item.id).toBeNull();
    }
  });

  it('keeps every positive oracle anchored in the checked-in source cards', () => {
    for (const fixture of OPERATIONAL_FIXTURES.filter((item) => item.expectedFact)) {
      const cards = fs.readFileSync(path.join(ROOT, fixture.oraclePath || 'kb/capability-cards.md'), 'utf8').replace(/\s+/g, ' ');
      expect(cards, fixture.id).toContain(fixture.expectedFact.replace(/\s+/g, ' '));
    }
  });

  it('distinguishes same-project continuity from cross-project learning and binds IPFS evidence to a pinned public source', () => {
    const sameProject = OPERATIONAL_FIXTURES.find((item) => item.id === 'broad-next-session-learning');
    const crossProject = OPERATIONAL_FIXTURES.find((item) => item.id === 'broad-cross-project-learning-status');
    const ipfs = OPERATIONAL_FIXTURES.find((item) => item.id === 'named-ruflo-ipfs');
    expect(sameProject.expectedFact).not.toBe(crossProject.expectedFact);
    expect(crossProject.oraclePath).toBe('docs/4.0-EXPLAINER-BRIEF.md');
    expect(ipfs).toMatchObject({ class: 'named', expectedFact: 'IPFS-based cross-project pattern transfer', oraclePath: 'evals/oracles/ruflo-ipfs-plugin.json' });
    expect(OPERATIONAL_FIXTURES.find((item) => item.id === 'named-cognitum-ruos')?.expectedFact).toBe('agentic Linux operating system for AI workstations');
  });

  it('accepts source support only when the exact span exists in the cited stored passage bytes', async () => {
    const fixture = OPERATIONAL_FIXTURES[0];
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-eval-source-'));
    try {
      const file = path.join(kb, 'concepts.passages.jsonl');
      const hit = citation('concepts', 'ruvector/CARD/rvf');
      const verification = { grounded: true, citations: [hit], receipt: { repo: 'concepts', path: hit.fullPath } };
      const raw = `#1  repo=concepts ce=1.2\npath : ${hit.fullPath}\n${fixture.expectedFact}`;
      fs.writeFileSync(file, `${JSON.stringify({ path: hit.docPath, text: 'This source only discusses bananas.' })}\n`);
      const fabricatedSpan = await verifyFixtureSourceSupport(fixture, verification, kb);
      expect(fabricatedSpan).toMatchObject({ checked: true, supported: false });
      expect(gradeOperationalFixture(fixture, { output: raw, verification, sourceSupport: fabricatedSpan, processOk: true }).pass).toBe(false);

      fs.writeFileSync(file, `${JSON.stringify({ path: hit.docPath, text: `Source fact: ${fixture.expectedFact}` })}\n`);
      const sourceBacked = await verifyFixtureSourceSupport(fixture, verification, kb);
      expect(sourceBacked).toMatchObject({ supported: true, repo: 'concepts', citedPath: hit.fullPath });
      expect(gradeOperationalFixture(fixture, { output: raw, verification, sourceSupport: sourceBacked, processOk: true })).toMatchObject({ pass: true, routed: true, sourceFactPresent: true });

      const negativeHit = citation('concepts', hit.docPath, -2.66);
      const negativeSupport = await verifyFixtureSourceSupport(fixture, { grounded: true, citations: [negativeHit] }, kb);
      expect(negativeSupport.supported).toBe(false);

      const wrongOwnerHit = citation('ruflo', 'unrelated');
      const wrongOwner = await verifyFixtureSourceSupport(fixture, {
        grounded: true, citations: [wrongOwnerHit], receipt: { repo: 'ruflo', path: wrongOwnerHit.fullPath },
      }, kb);
      expect(wrongOwner.supported).toBe(false);
    } finally {
      fs.rmSync(kb, { recursive: true, force: true });
    }
  });

  it('lets a well-qualified refusal pass a negative control but not a positive answer', () => {
    const fixture = OPERATIONAL_FIXTURES.find((item) => item.class === 'negative');
    const refused = gradeOperationalFixture(fixture, { output: 'EVIDENCE: THIN. No source found.', verification: { grounded: false, citations: [], receipt: null }, processOk: true });
    expect(refused).toMatchObject({ pass: true, abstained: true });
    const fabricated = gradeOperationalFixture(fixture, { output: '#1 repo=ruvector ce=1.7\npath : ruvector/card\nEVIDENCE: THIN', verification: { grounded: true, citations: [citation('ruvector', 'card', 1.7)], receipt: { repo: 'ruvector' } }, processOk: true });
    expect(fabricated.pass).toBe(false);
  });

  it('never grades partial stdout from a nonzero, timed-out, or crashed process as a pass', async () => {
    const fixture = OPERATIONAL_FIXTURES[0];
    const hit = citation('concepts', 'ruvector/card');
    const verification = { grounded: true, citations: [hit], receipt: { repo: 'concepts', path: hit.fullPath } };
    const sourceSupport = { checked: true, supported: true, repo: 'concepts', citedPath: hit.fullPath };
    const partial = `#1 repo=concepts ce=1\npath : ${hit.fullPath}\n${fixture.expectedFact}`;
    expect(gradeOperationalFixture(fixture, { output: partial, verification, sourceSupport, processOk: false }).pass).toBe(false);

    const negative = OPERATIONAL_FIXTURES.find((item) => item.class === 'negative');
    expect(gradeOperationalFixture(negative, {
      output: 'EVIDENCE: THIN. No source found.', verification: { grounded: false, citations: [], receipt: null }, processOk: false,
    }).pass).toBe(false);
  });

  it('reports latency distributions by actual observations, including tail latency', () => {
    expect(latencyDistribution([18, 4, 7, 90, 11])).toEqual({ n: 5, p50Ms: 11, p95Ms: 90, p99Ms: 90, maxMs: 90 });
    expect(latencyDistribution([])).toEqual({ n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  });
});
