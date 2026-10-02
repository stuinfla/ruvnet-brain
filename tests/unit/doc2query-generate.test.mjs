// tests/unit/doc2query-generate.test.mjs — ADR-099 arm A generation: the prompt shape and the
// deterministic leak rules every generated question must pass.
import { describe, expect, it } from 'vitest';
import { d2qPrompt, leakReason, sharedRun } from '../../scripts/oracle/doc2query-generate.mjs';

const doc = { store: 'ruflo', path: '.agents/skills/swarm-init/SKILL.md',
  excerpt: 'Every agent spawned must write its starting status to the coordination namespace and update progress after each step.' };

describe('leak rules', () => {
  it('measures the longest run of consecutive words shared with the excerpt', () => {
    expect(sharedRun('how should every agent spawned report what it does', doc.excerpt)).toBe(3);
    expect(sharedRun('nothing in common here at all', doc.excerpt)).toBe(0);
  });
  it('keeps a plain need and rejects names, identifiers, copying and bad length', () => {
    expect(leakReason('I run several AI helpers at once and they keep stepping on each other; how should each one report its progress?', doc)).toBeNull();
    expect(leakReason('How do I make ruflo helpers report their progress to each other while they run in parallel?', doc)).toBe('names-source');
    expect(leakReason('Can my helpers keep their shared notes in agentdb so they survive when the laptop restarts tonight?', doc)).toBe('names-source');
    expect(leakReason('How do I call writeStatus so that several helpers report their progress to each other?', doc)).toBe('identifier');
    expect(leakReason('Where is SKILL.md that explains how several helpers report their progress to each other?', doc)).toBe('identifier');
    expect(leakReason('Must write its starting status to the coordination namespace so the others can see what happens next?', doc)).toBe('copies-source');
    expect(leakReason('Too short?', doc)).toBe('length');
  });
});

describe('d2qPrompt', () => {
  it('lists every document with its id and never anything else', () => {
    const p = d2qPrompt([{ docId: 'd0', title: 'Swarm init', excerpt: 'text A' }, { docId: 'd1', title: 'Other', excerpt: 'text B' }], 3);
    expect(p).toContain('===DOC docId=d0\ntitle: Swarm init\ntext A\n===END');
    expect(p).toContain('===DOC docId=d1');
    expect(p).toMatch(/write 3 different questions/);
  });
});
