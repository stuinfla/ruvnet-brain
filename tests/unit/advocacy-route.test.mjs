/**
 * advocacy-route.test.mjs — THE PROOF FIXTURE.
 *
 * The eight prompts below are the ones a real host was measured against on 2026-09-10 (six positive,
 * two negative controls). Each positive names the capability it MUST route to; each negative asserts
 * NO candidate at all. That mapping is the fixture — it is stated here rather than derived from the
 * matcher, so a matcher that drifts cannot quietly redefine what "correct" means.
 *
 * EVERY guard here is proved by breaking what it guards. A test that cannot go red on broken code is
 * not a test, so each block below also runs the mutation that must fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = path.join(ROOT, 'plugin', 'scripts', 'advocacy-route.mjs');

let dir;
let route;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advocacy-route-'));
  process.env.RUVNET_ADVOCACY_ROUTE_STATE = path.join(dir, 'state.json');
  process.env.RUVNET_ADVOCACY_OUTCOMES = path.join(dir, 'outcomes.jsonl');
  // Fresh module per test: STATE_FILE and the ledger path are read at module load, exactly as they
  // are in the real cold-start process this file is standing in for.
  route = await import(`${MOD}?t=${Date.now()}${Math.random()}`);
});
afterEach(() => {
  delete process.env.RUVNET_ADVOCACY_ROUTE_STATE;
  delete process.env.RUVNET_ADVOCACY_OUTCOMES;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const ledger = () => path.join(dir, 'outcomes.jsonl');

/**
 * Stand in for unprompted-runtime.mjs's DELIVERY step.
 *
 * decide() only DECIDES; the runtime is what records the OFFERED row, and only after the dial and the
 * DismissalLedger have both let the candidate through. The lifecycle downstream (applied / dismissed /
 * ignored) is gated on that row existing, so a test that skipped it would be testing a path production
 * does not have. This is the exact call unprompted-runtime.mjs makes (see its advocacy case).
 */
async function deliver(candidate) {
  const ao = await import(path.join(ROOT, 'plugin', 'scripts', 'advocacy-outcomes.mjs'));
  return ao.record(
    { id: candidate.findingId, action: ao.ACTIONS.OFFERED, severity: candidate.severity, stateHash: candidate.observationHash },
    { file: ledger() },
  );
}

/** decide() + deliver() — what one real prompt does end to end. */
function offer(prompt, sessionId) {
  const d = route.decide({ prompt, sessionId, file: ledger() });
  return d.candidate ? deliver(d.candidate).then(() => d) : Promise.resolve(d);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// THE FIXTURE — prompt → expected capability id (null = must stay silent)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
export const FIXTURE = [
  ['P1', 'search these docs by meaning instead of exact keywords', 'ruvector'],
  ['P2', 'this agent forgets everything between runs — give it durable memory', 'agentdb'],
  ['P3', 'several AI reviewers (security, performance, style) review every PR in parallel and merge findings', 'ruflo'],
  ['P4', 'opening this chatbot to customers next week — stop jailbreaks and leaks of other customers\' data', 'aidefence'],
  ['P5', 'tests are flaky and we don\'t know what\'s untested — trustworthy coverage and real quality gates', 'agentic-qe'],
  ['P6', 'our LLM bill doubled and most requests are simple — cut cost without hurting quality', 'agentic-flow'],
  ['N1', 'range(1,5) should include 5 — find the bug and the exact fix', null],
  ['N2', 'rename getUsr to getUser everywhere', null],
];

describe('the fixture: six ordinary requests route to a fitting capability, two controls stay silent', () => {
  it('recognizes the explicit retrieval action and meaning need without a keyword contrast', () => {
    expect(route.classify('search these docs by meaning')).toMatchObject({ capability: 'ruvector' });
    expect(route.classify('please search these docs by meaning')).toMatchObject({ capability: 'ruvector' });
    expect(route.classify('retrieve our notes by meaning')).toMatchObject({ capability: 'ruvector' });
    expect(route.classify('find my passages by meaning')).toMatchObject({ capability: 'ruvector' });
    for (const prompt of [
      'search these docs for exact keywords',
      'explain what searching these docs by meaning means',
      'do not search these docs by meaning',
      'rename these docs to describe what we mean',
    ]) expect(route.classify(prompt), prompt).toBeNull();
  });

  it.each([
    'search these docs for the exact keyword "embeddings"',
    'find my notes containing the literal word embeddings',
    'search these docs for the literal phrase "semantic search"; do not use meaning-based retrieval',
    'search these docs for exact keywords; retrieval by meaning is not requested',
  ])('literal document retrieval stays silent: %s', (prompt) => {
    expect(route.classify(prompt)).toBeNull();
  });

  for (const [label, prompt, expected] of FIXTURE) {
    it(`${label} → ${expected ?? 'SILENCE'}`, () => {
      const match = route.classify(prompt);
      if (expected === null) {
        expect(match, `${label} must produce no candidate — a negative control that speaks is the nag`).toBeNull();
        return;
      }
      expect(match, `${label} matched nothing`).not.toBeNull();
      expect(match.capability).toBe(expected);
      // Evidence-bound: the match must name the real cues that carried it, and there must be ≥2.
      expect(match.cues.length).toBeGreaterThanOrEqual(2);
    });
  }

  it('BREAK IT: a prompt with exactly ONE cue is silent — corroboration, not keyword spotting', () => {
    // "coverage" alone is a single test-quality cue and must not speak. Add a second cue and it does.
    expect(route.classify('bump the coverage threshold in the vitest config file please')).toBeNull();
    const two = route.classify('our coverage is untested in places and the suite is flaky as well');
    expect(two).not.toBeNull();
    expect(two.capability).toBe('agentic-qe');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LIFECYCLE — offered → applied | dismissed | ignored, with NO PreToolUse/PostToolUse hook
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('lifecycle: every transition is observed at a boundary that is actually still wired', () => {
  const P5 = FIXTURE.find(([l]) => l === 'P5')[1];

  it('a first prompt produces a candidate carrying the adapter fields DDD-0004 requires', () => {
    const { candidate, reason } = route.decide({ prompt: P5, sessionId: 's1', file: ledger() });
    expect(reason).toBeNull();
    expect(candidate.channel).toBe('advocacy');
    expect(candidate.effect).toBe('advisory');
    expect(candidate.findingId).toBe('recommend:agentic-qe');
    expect(candidate.severity).toBe('normal');
    expect(candidate.observationHash).toMatch(/^[a-f0-9]{16}$/);
    // availability, task fit, a safe next action, and an inverse — all four, or the offer is not one.
    expect(['installed', 'unknown']).toContain(candidate.availability);
    expect(candidate.fit.length).toBeGreaterThan(10);
    expect(candidate.nextAction).toMatch(/aqe coverage --gaps --risk/);
    expect(candidate.undo.length).toBeGreaterThan(5);
    // Delivery evidence for correlation.
    expect(candidate.promptHash).toMatch(/^[a-f0-9]{16}$/);
    expect(candidate.cues.length).toBeGreaterThanOrEqual(2);
  });

  it('the copy is an INSTRUCTION TO THE MODEL and is at most two lines', () => {
    const { candidate } = route.decide({ prompt: P5, sessionId: 's1', file: ledger() });
    expect(candidate.copy.split('\n').length).toBeLessThanOrEqual(2);
    expect(candidate.copy).toMatch(/tell the user in ONE sentence/);
    expect(candidate.copy).toMatch(/Consider agentic-qe —/);
    expect(candidate.copy).toMatch(/Say 'use agentic-qe' to proceed, or ignore this/);
  });

  it('a repeated prompt in the same session does NOT re-offer (session cap)', () => {
    const first = route.decide({ prompt: P5, sessionId: 's1', file: ledger() });
    expect(first.candidate).not.toBeNull();
    const second = route.decide({ prompt: P5, sessionId: 's1', file: ledger() });
    expect(second.candidate).toBeNull();
    expect(second.reason).toMatch(/session-cap|already-offered/);
  });

  it('TEETH: a DIFFERENT session offers again — the cap is per session, not permanent', () => {
    expect(route.decide({ prompt: P5, sessionId: 's1', file: ledger() }).candidate).not.toBeNull();
    expect(route.decide({ prompt: P5, sessionId: 's2', file: ledger() }).candidate).not.toBeNull();
  });
  it('the NEXT prompt accepting the offer records `applied`', async () => {
    await offer(P5, 's1');
    const res = route.resolvePriorOffers('ok, use agentic-qe on the api package', 's1', { file: ledger() });
    expect(res.applied).toEqual(['recommend:agentic-qe']);
    expect(res.dismissed).toEqual([]);
    const rows = fs.readFileSync(ledger(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.some((r) => r.id === 'recommend:agentic-qe' && r.action === 'applied')).toBe(true);
  });

  it('the NEXT prompt declining it records `dismissed`, and the dismissal then STICKS', async () => {
    await offer(P5, 's1');
    const res = route.resolvePriorOffers('no, skip agentic-qe for now', 's1', { file: ledger() });
    expect(res.dismissed).toEqual(['recommend:agentic-qe']);
    // A `normal` finding spends its whole budget on one dismissal — so a fresh session stays silent.
    const later = route.decide({ prompt: P5, sessionId: 's-later', file: ledger() });
    expect(later.candidate).toBeNull();
    expect(later.reason).toBe('suppressed');
  });

  it('BREAK IT: an unrelated next prompt resolves NOTHING (a coincidental "ok" cannot inflate precision)', async () => {
    await offer(P5, 's1');
    const res = route.resolvePriorOffers(
      'unrelated: please refactor the date parser and keep the public signature stable', 's1', { file: ledger() });
    expect(res.applied).toEqual([]);
    expect(res.dismissed).toEqual([]);
  });

  it('BREAK IT: an offer the runtime never DELIVERED cannot be credited applied (dial off, say)', async () => {
    // decide() ran and the state file remembers it, but no OFFERED row was ever written — which is
    // exactly what happens at advocacy=off. Accepting it must record nothing.
    route.decide({ prompt: P5, sessionId: 's1', file: ledger() });
    const res = route.resolvePriorOffers('use agentic-qe', 's1', { file: ledger() });
    expect(res.applied).toEqual([]);
    expect(fs.existsSync(ledger())).toBe(false);   // byte-exact: the ledger was never even created
  });

  it('a session that ends with no answer sweeps to `ignored` — never silently dropped', async () => {
    await offer(P5, 's1');
    const swept = route.sweepSession('s1', { file: ledger() });
    expect(swept).toEqual(['recommend:agentic-qe']);
    // Idempotent: the offer is resolved now, so a second sweep (a cron re-run) is a no-op.
    expect(route.sweepSession('s1', { file: ledger() })).toEqual([]);
  });

  it('precision is null below the sample floor, and says so rather than reporting 0', async () => {
    await offer(P5, 's1');
    route.resolvePriorOffers('use agentic-qe', 's1', { file: ledger() });
    const s = route.summary({ file: ledger() });
    expect(s.applied).toBe(1);
    expect(s.resolved).toBe(1);
    expect(s.sufficient).toBe(false);
    expect(s.precision).toBeNull();
    expect(s.reason).toMatch(/unknown, not zero/);
    expect(s.minSamples).toBe(10);
  });

  it('TEETH: ten independently changed observed states meet the unchanged precision floor', async () => {
    const ao = await import('../../scripts/advocacy-outcomes.mjs');
    const observation = path.join(dir, 'observed-source.json');
    const id = 'recommend:agentic-qe';
    for (let i = 0; i < 10; i++) {
      // Actual source fixture revisions, not repeated unchanged offers or edited counts.
      fs.writeFileSync(observation, JSON.stringify({ sourceRevision: i, observedTests: i + 1 }));
      const stateHash = ao.stateHashOf([fs.readFileSync(observation, 'utf8')]);
      expect(ao.shouldStillOffer(id, { file: ledger(), stateHash })).toBe(true);
      ao.record({ id, action: ao.ACTIONS.OFFERED, severity: 'normal', stateHash }, { file: ledger() });
      expect(ao.shouldStillOffer(id, { file: ledger(), stateHash })).toBe(false);
      const sid = `observed-${i}`;
      const state = { sessions: { [sid]: { offers: [{ id, capability: 'agentic-qe', at: new Date().toISOString(), severity: 'normal' }] } } };
      const accept = i < 8;
      const res = route.resolvePriorOffers(accept ? 'use agentic-qe' : 'no, skip agentic-qe', sid, { file: ledger(), state });
      expect(accept ? res.applied : res.dismissed).toEqual([id]);
    }
    const summary = route.summary({ file: ledger() });
    expect(summary.minSamples).toBe(10);
    expect(summary.resolved).toBe(10);
    expect(summary.sufficient).toBe(true);
    expect(summary.precision).toBe(0.8);
  });

  it('unchanged delivered suggestions cannot manufacture adequate precision samples across sessions', async () => {
    const first = await offer(P5, 'original');
    expect(first.candidate).not.toBeNull();
    expect(route.resolvePriorOffers('use agentic-qe', 'original', { file: ledger() }).applied).toEqual(['recommend:agentic-qe']);
    for (let i = 0; i < 12; i++) {
      const duplicate = await offer(P5, `duplicate-${i}`);
      expect(duplicate.candidate).toBeNull();
      expect(duplicate.reason).toBe('suppressed');
    }
    const summary = route.summary({ file: ledger() });
    expect(summary.minSamples).toBe(10);
    expect(summary.resolved).toBe(1);
    expect(summary.sufficient).toBe(false);
    expect(summary.precision).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FAIL-OPEN — every failure resolves toward SILENCE, never toward speaking or throwing
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('fail-open: a broken environment produces silence, never an exception and never a wrong claim', () => {
  const P1 = FIXTURE.find(([l]) => l === 'P1')[1];

  it('a non-directory state ancestor yields NO candidate (cannot remember ⇒ must not speak)', () => {
    const blocked = path.join(dir, 'blocked');
    // An actual filesystem failure on every OS; Windows does not enforce POSIX chmod bits.
    fs.writeFileSync(blocked, 'existing file must remain unchanged');
    process.env.RUVNET_ADVOCACY_ROUTE_STATE = path.join(blocked, 'sub', 'state.json');
    return import(`${MOD}?t=${Date.now()}b`).then((r) => {
      const { candidate, reason } = r.decide({ prompt: P1, sessionId: 's1', file: ledger() });
      expect(candidate).toBeNull();
      expect(reason).toBe('state-unwritable');
      expect(fs.readFileSync(blocked, 'utf8')).toBe('existing file must remain unchanged');
    });
  });

  it('a ledger write failure leaves the offer PENDING rather than reporting a false resolution', async () => {
    const d = route.decide({ prompt: P1, sessionId: 's1', file: ledger() });
    const ao = await import(path.join(ROOT, 'plugin', 'scripts', 'advocacy-outcomes.mjs'));
    ao.record({ id: d.candidate.findingId, action: ao.ACTIONS.OFFERED, severity: 'normal', stateHash: d.candidate.observationHash }, { file: ledger() });
    // A DIRECTORY where the ledger file must go: appendFileSync fails, record() returns {ok:false}
    // rather than throwing — the contract advocacy-outcomes states for an I/O failure.
    const bad = path.join(dir, 'bad-ledger.jsonl');
    fs.mkdirSync(bad);
    const res = route.resolvePriorOffers('use ruvector', 's1', { file: bad });
    expect(res.applied).toEqual([]);
    // Still pending against the REAL ledger, so the SessionEnd sweep can resolve it honestly.
    expect(route.sweepSession('s1', { file: ledger() })).toEqual(['recommend:ruvector']);
  });

  it('the budget is honoured: a start time already past BUDGET_MS yields silence', () => {
    const { candidate, reason } = route.decide({
      prompt: P1, sessionId: 's1', file: ledger(), startedAt: Date.now() - (route.BUDGET_MS + 50),
    });
    expect(candidate).toBeNull();
    expect(reason).toBe('budget-exceeded');
  });

  it('availability is never asserted as absence — a missing probe reports `unknown`', () => {
    process.env.RUVNET_ADVOCACY_ROUTE_ROOTS = path.join(dir, 'definitely-not-a-node-modules');
    return import(`${MOD}?t=${Date.now()}c`).then((r) => {
      const a = r.availabilityOf('agentic-qe');
      delete process.env.RUVNET_ADVOCACY_ROUTE_ROOTS;
      expect(a).toBe('unknown');
      const { candidate } = r.decide({ prompt: FIXTURE[4][1], sessionId: 'sx', file: ledger() });
      expect(candidate.availability).toBe('unknown');
      expect(candidate.copy).toMatch(/Install state unknown from here/);
    });
  });

  it('TEETH: a root that DOES contain the package reports `installed` (the probe is not vacuous)', () => {
    const root = path.join(dir, 'node_modules');
    fs.mkdirSync(path.join(root, 'agentic-qe'), { recursive: true });
    process.env.RUVNET_ADVOCACY_ROUTE_ROOTS = root;
    return import(`${MOD}?t=${Date.now()}d`).then((r) => {
      const a = r.availabilityOf('agentic-qe');
      delete process.env.RUVNET_ADVOCACY_ROUTE_ROOTS;
      expect(a).toBe('installed');
    });
  });
});


describe('P075 existing alternatives are usable choices with fit and tradeoffs', () => {
  it.each(['ruvector', 'agentdb', 'ruflo', 'aidefence', 'agentic-qe', 'agentic-flow', 'rulake'])('names a concrete alternative to %s without imposing installation', capability => {
    const candidate = route.buildCandidate({ prompt: 'private fixture task', match: { capability, intent: { id: 'fixture', fit: 'fixture' }, cues: [] }, availability: 'installed' });
    expect(candidate.copy).toContain('Alternative:'); expect(candidate.copy).toMatch(/suits /);
    expect(candidate.copy).toMatch(/but |without |delays /);
    expect(candidate.copy).toContain(`Say 'use ${capability}' to proceed, or ignore this`);
    expect(candidate.copy.split('\n')).toHaveLength(2); expect(candidate.copy.length).toBeLessThan(1500);
  });
});
