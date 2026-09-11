/**
 * advocacy-catalog.test.mjs — THE GROUNDING GATE for what this product is allowed to recommend.
 *
 * The rule this file makes mechanical: a capability may be named to a user ONLY if this repo holds a
 * grounded card describing it. Without that, "Consider X" is a package name recalled from training
 * data, which is the exact failure class the repo's own standing order names ("never hand-roll what
 * rUv ships, never claim what you have not checked"). A missing card fails CI here, at authoring
 * time, instead of reaching a user as a confident sentence about something that may not exist.
 *
 * It cannot be satisfied by editing this file: the assertion reads kb/capability-cards.md, which is
 * generated from the repos' own primers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, INTENTS, MIN_CUES } from '../../plugin/scripts/advocacy-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARDS = path.join(ROOT, 'kb', 'capability-cards.md');

const headings = () => new Set(
  fs.readFileSync(CARDS, 'utf8').split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim()),
);

describe('grounding: every capability this route can name has a card in kb/capability-cards.md', () => {
  const have = headings();

  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    it(`${id} is grounded in the "## ${cap.card}" card`, () => {
      expect(have.has(cap.card), `kb/capability-cards.md has no "## ${cap.card}" heading`).toBe(true);
    });
  }

  it('BREAK IT: a capability whose card does not exist fails this gate', () => {
    expect(have.has('a-capability-nobody-ever-wrote-a-card-for')).toBe(false);
  });

  it('the card file is real and substantial — the gate is not passing against an empty set', () => {
    expect(have.size).toBeGreaterThan(50);
  });
});

describe('every intent is well formed and points at a capability that exists', () => {
  it('each intent has a capability, a fit sentence, and at least MIN_CUES cues to reach', () => {
    for (const intent of INTENTS) {
      expect(CAPABILITIES[intent.capability], `intent ${intent.id} names unknown capability`).toBeTruthy();
      expect(intent.fit.length, `intent ${intent.id} has no fit sentence`).toBeGreaterThan(10);
      expect(intent.cues.length, `intent ${intent.id} cannot reach the two-cue floor`).toBeGreaterThanOrEqual(MIN_CUES);
      for (const cue of intent.cues) expect(cue).toBeInstanceOf(RegExp);
    }
  });

  it('every intent id and capability id is unique — one intent, one answer', () => {
    const ids = INTENTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the two-cue floor is 2 — one cue is a coincidence, two is a statement', () => {
    expect(MIN_CUES).toBe(2);
  });
});

describe('every remedy is executable and reversible, or says so in those words', () => {
  it('each capability carries a concrete next action and an inverse', () => {
    for (const [id, cap] of Object.entries(CAPABILITIES)) {
      expect(cap.nextAction, `${id} has no next action`).toBeTruthy();
      expect(cap.nextAction.length).toBeGreaterThan(10);
      expect(cap.undo, `${id} has no inverse`).toBeTruthy();
      // The benefit must be a benefit, not a feature list: no semicolon-separated inventory.
      expect(cap.benefit.length).toBeGreaterThan(30);
    }
  });

  it('BREAK IT: no remedy smuggles in a destructive verb as its "safe first step"', () => {
    for (const [id, cap] of Object.entries(CAPABILITIES)) {
      expect(cap.nextAction, `${id}'s next action is destructive`).not.toMatch(/\brm -rf\b|\bdrop table\b|--force\b/i);
    }
  });
});
