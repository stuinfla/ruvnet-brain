import { describe, expect, it } from 'vitest';
import { selectResults } from '../../kb/forge-ask-all.mjs';
import { answerFromCards } from '../../kb/card-lane.mjs';
import { groundedToolResult } from '../../kb/grounded-response.mjs';
import {
  assessImplementation,
  implementationNotice,
  requiresImplementationProof,
} from '../../kb/implementation-evidence.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KB = path.join(ROOT, 'kb');

function ranked(kind, path_, text, score = 8) {
  return [{
    repo: 'fictional-ruv-project',
    kind,
    path: path_,
    title: 'Plausible capability',
    fullText: text,
    text,
    ceScore: score,
    bestDistance: 0.1,
  }];
}

describe('implementation truth gate — design intent is never built-state proof', () => {
  it.each([2.757, null])('acknowledges retrieved source without proof at relevance %s', (score) => {
    const out = assessImplementation(
      'In Ruflo source which functions implement autopilot progress persistence task completion detection and re-engagement after a blocked or interrupted coding session?',
      [{
        ...ranked('source', 'v3/@claude-flow/cli/src/commands/autopilot.ts',
          '// Classification fixture, not a capability claim.', score)[0],
        repo: 'ruflo',
      }],
    );
    expect(out.results[0].evidenceClass).toBe('implementation');
    expect(out.implementation).toMatchObject({
      required: true,
      verdict: 'unproven',
      implementationSources: [],
      retrievedImplementationSources: ['ruflo/v3/@claude-flow/cli/src/commands/autopilot.ts'],
      unprovenReason: 'insufficient-relevance',
    });
    const notice = implementationNotice(out.implementation);
    expect(notice).toMatch(/source or manifest was retrieved/i);
    expect(notice).toMatch(/relevance.*proof threshold/i);
    expect(notice).not.toMatch(/contains no implementation-bearing/);
    expect(notice).toMatch(/Do not tell the user.*built, shipped, implemented/s);
  });

  it('preserves the implementation proof threshold at exactly 4', () => {
    const out = selectResults({
      query: 'Does this project implement orbital deployment?',
      ranked: ranked('source', 'src/orbital_deployment.rs', 'pub struct OrbitalDeployment;', 4),
    });
    expect(out.implementation).toMatchObject({
      verdict: 'proven',
      implementationSources: ['fictional-ruv-project/src/orbital_deployment.rs'],
      unprovenReason: null,
    });
    expect(implementationNotice(out.implementation)).toMatch(/IMPLEMENTATION EVIDENCE: PROVEN/);
  });

  it('distinguishes documentation-only retrieval from low-relevance source', () => {
    const out = selectResults({
      query: 'Does this project implement orbital deployment?',
      ranked: ranked('doc', 'README.md', 'Orbital deployment design documentation.', 8),
    });
    expect(out.implementation).toMatchObject({
      verdict: 'unproven',
      implementationSources: [],
      retrievedImplementationSources: [],
      unprovenReason: 'no-implementation-source',
    });
    expect(implementationNotice(out.implementation)).toMatch(/contains no implementation-bearing source or manifest/);
  });

  it('marks a strong Proposed ADR hit unproven for a built-state question', () => {
    const out = selectResults({
      query: 'Did Reuven build and ship autonomous orbital deployment in this project?',
      ranked: ranked(
        'adr',
        'docs/adr/ADR-900-orbital-deployment.md',
        'Status: Proposed\n\nThis ADR proposes autonomous orbital deployment.',
      ),
    });

    expect(out.implementation).toMatchObject({
      required: true,
      verdict: 'unproven',
      implementationSources: [],
    });
    expect(out.results[0].evidenceClass).toBe('design-intent');
    expect(out.results[0].lifecycleStatus).toBe('proposed');
  });

  it('proves built-state only from implementation-bearing source or a manifest', () => {
    const out = selectResults({
      query: 'Does this project implement orbital deployment?',
      ranked: ranked(
        'source',
        'src/orbital_deployment.rs',
        'pub struct OrbitalDeployment;\nimpl OrbitalDeployment { pub fn deploy(&self) {} }',
      ),
    });

    expect(out.implementation).toMatchObject({
      required: true,
      verdict: 'proven',
      implementationSources: ['fictional-ruv-project/src/orbital_deployment.rs'],
    });
    expect(out.results[0].evidenceClass).toBe('implementation');
  });

  it('does not use an irrelevant source hit as proof merely because it is code', () => {
    const out = selectResults({
      query: 'Does this project implement orbital deployment?',
      ranked: ranked('source', 'src/unrelated.rs', 'pub fn unrelated() {}', 1),
    });
    expect(out.implementation.verdict).toBe('unproven');
    expect(out.implementation.implementationSources).toEqual([]);
  });

  it('does not treat an Accepted ADR as implementation evidence', () => {
    const out = selectResults({
      query: 'Has this project implemented orbital deployment?',
      ranked: ranked(
        'adr',
        'docs/adr/ADR-901-orbital-deployment.md',
        'Status: Accepted\n\nThe team accepts this deployment design.',
      ),
    });
    expect(out.implementation.verdict).toBe('unproven');
    expect(out.results[0]).toMatchObject({
      evidenceClass: 'design-intent',
      lifecycleStatus: 'accepted',
    });
  });

  it('does not infer a source extension from a documentation anchor fragment', () => {
    const out = selectResults({
      query: 'Does this project implement a TypeScript pipeline?',
      ranked: ranked(
        'doc',
        'capability-cards.md#example.ts',
        'A curated capability description for the example.ts project.',
      ),
    });

    expect(out.implementation).toMatchObject({
      required: true,
      verdict: 'unproven',
      implementationSources: [],
    });
    expect(out.results[0].evidenceClass).toBe('documentation');
  });

  it('does not let a capability card answer a built/shipped capability claim', () => {
    const hit = answerFromCards('Did Reuven build and ship agent swarms in ruflo?', KB);
    expect(hit.hit).toBe(false);
    expect(hit.reason).toMatch(/implementation evidence/i);
  });

  it('also requires proof for ordinary capability wording, not only the word "built"', () => {
    const hit = answerFromCards('Can ruflo orchestrate agent swarms?', KB);
    expect(hit.hit).toBe(false);
    expect(hit.reason).toMatch(/implementation evidence/i);
  });

  it('applies the same proof gate to plural what-are capability inventories', () => {
    expect(requiresImplementationProof('What are AgentDB core concepts and controllers?')).toBe(true);
  });

  it('does not mistake agents working in parallel for an operational-status claim', () => {
    expect(requiresImplementationProof(
      'What coordinates several coding agents working at the same time on one task?',
    )).toBe(false);
    expect(requiresImplementationProof('Are the coding agents working?')).toBe(true);
  });

  it('does not mistake "the code does another" background context for a built-state question', () => {
    expect(requiresImplementationProof(
      'Our ADRs say one thing and the code does another; we want decision records treated as living plans and checked against reality.',
    )).toBe(false);
    expect(requiresImplementationProof(
      'Does ruflo implement ADR compliance checking against source code?',
    )).toBe(true);
  });

  it('does not mistake a team workflow complaint for a product shipped-state claim', () => {
    expect(requiresImplementationProof(
      'The team ships code with no specs and QA finds the gaps too late; we want a phased method with hard gates from requirements to completion.',
    )).toBe(false);
    expect(requiresImplementationProof('Does SPARC ship code without specs?')).toBe(true);
  });

  it('does not mistake a no-Python deployment constraint for a shipped-state claim', () => {
    expect(requiresImplementationProof(
      "A sensor box with 256MB RAM needs a small trainable classifier, and we can't ship Python.",
    )).toBe(false);
    expect(requiresImplementationProof('Can ruv-fann ship Python?')).toBe(true);
  });
});

describe('MCP grounded response — a receipt without inspectable evidence is impossible', () => {
  it('duplicates the answer into structured content so structured-only hosts still see it', () => {
    const result = groundedToolResult({
      body: 'SOURCE: ruflo/src/swarm.ts\nThe implementation exports SwarmCoordinator.',
      grounding: { receiptId: 'receipt-1', sources: [{ path: 'ruflo/src/swarm.ts' }] },
      implementation: { required: true, verdict: 'proven' },
    });

    expect(result.content[0].text).toContain('SwarmCoordinator');
    expect(result.structuredContent.answer).toBe(result.content[0].text);
    expect(result.structuredContent.grounding.receiptId).toBe('receipt-1');
  });

  it('refuses an empty answer even when a grounding receipt exists', () => {
    expect(() => groundedToolResult({
      body: '',
      grounding: { receiptId: 'receipt-without-evidence' },
    })).toThrow(/inspectable answer/i);
  });

  it('gives the host an explicit non-assertion instruction when proof is absent', () => {
    const notice = implementationNotice({
      required: true,
      verdict: 'unproven',
      implementationSources: [],
    });
    expect(notice).toMatch(/NOT PROVEN/);
    expect(notice).toMatch(/Do not tell the user.*built, shipped, implemented/s);
  });
});
