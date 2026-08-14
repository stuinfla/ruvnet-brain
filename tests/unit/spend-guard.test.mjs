import { describe, expect, it } from 'vitest';
import { FLEET_RUNNERS, METERED_KEYS, check } from '../../plugin/scripts/spend-guard.mjs';

/**
 * AGENT WORK RUNS ON THE SEATS THE OWNER ALREADY PAYS FOR.
 *
 * THE INCIDENT: proffesor-for-testing/agentic-qe#557, filed by the owner 2026-07-12. A QE fleet
 * spawned ~374 headless agents over 11 hours, each billing api.anthropic.com pay-per-token through
 * ANTHROPIC_API_KEY, while the Claude Max subscription sat unused. $1,600.
 *
 * WHY A GATE AND NOT A REMINDER, measured 2026-08-14 when the owner asked "is that rule stored and
 * hook created?" — the honest answer was half yes and half no:
 *
 *     rule stored              YES  lesson-subscription-seats-never-metered-api, user_claim, high
 *     rule fires               YES  at mutate-machine, ratified
 *     rule ENFORCED            NO   enforcement:checklist — it MENTIONS the rule
 *     hooks naming the keys    NONE
 *     blocking-optin.json      ABSENT — so every 'block' lesson on this machine is unarmed
 *     keys live in the shell   ALL THREE SET
 *
 * A high-severity rule about irreversible spend, delivered as advisory text, guarding a loss that
 * already happened. Advisory text is what gets skimmed.
 *
 * HALF THESE CASES ARE ABOUT WHAT IT MUST NOT REFUSE. A gate that fires on ordinary work is one the
 * owner disables, and a disabled gate protects nothing — a sibling hook refused every `git push` on
 * machines without ruflo the same week.
 */
describe('a fleet on metered keys is refused', () => {
  const metered = { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-proj-x' };

  it('TEETH: the exact shape that cost $1,600', () => {
    const r = check('aqe test --fleet 20', metered);
    expect(r.verdict).toBe('metered');
    expect(r.exposed).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    // A wall that reports a problem without the remedy gets routed around.
    expect(r.reason, 'must hand over the seat-based command').toMatch(/env -u ANTHROPIC_API_KEY/);
    expect(r.reason, 'must name the incident so the cost is concrete').toMatch(/\$1,600/);
  });

  it('covers every fleet runner, not just the one that burned', () => {
    for (const cmd of ['npx agentic-flow --agent coder', 'ruflo swarm init --max-agents 15', 'flow-nexus swarm']) {
      expect(check(cmd, metered).verdict, cmd).toBe('metered');
    }
    expect(FLEET_RUNNERS.length, 'the runner list must not silently shrink').toBeGreaterThanOrEqual(4);
  });
});

describe('it never blocks the seats, or ordinary work', () => {
  const metered = { ANTHROPIC_API_KEY: 'sk-ant-x' };

  it('TEETH: `claude` and `codex` are the SUBSCRIPTION and are never refused', () => {
    // The whole point is to route work HERE. Blocking these would invert the rule.
    for (const cmd of ['claude -p "do the thing"', 'codex exec "audit this"', 'claude --resume']) {
      expect(check(cmd, metered).verdict, cmd).toBe('not-applicable');
    }
  });

  it('TEETH: a fleet with NO metered key in the environment is allowed', () => {
    // This is the target state — the fleet running on seats. If this refused, the guard would be
    // blocking the very thing it exists to encourage.
    expect(check('aqe test --fleet 20', {}).verdict).toBe('ok');
  });

  it('TEETH: mentioning a runner is not invoking one', () => {
    // A sibling fix the same week globbed raw command text and read `grep -n "npm publish" docs/`
    // as a ship. Executable position is the truth-maker; quoted text is an argument.
    for (const cmd of ['grep -rn "agentic-flow" docs/', 'git commit -m "ran the aqe fleet"', 'echo "aqe"']) {
      expect(check(cmd, metered).verdict, cmd).toBe('not-applicable');
    }
  });

  it('ordinary commands are untouched', () => {
    for (const cmd of ['ls -la', 'npm test', 'git push origin main']) {
      expect(check(cmd, metered).verdict, cmd).toBe('not-applicable');
    }
  });

  it('the deliberate opt-in works, because a gate with no exit gets disabled entirely', () => {
    // The lesson's own wording allows it: "unless a human explicitly opts in for that run."
    expect(check('aqe test', { ...metered, RUVNET_ALLOW_METERED_SPEND: '1' }).verdict).toBe('opted-in');
  });

  it('OPENROUTER is metered but deliberately NOT blocked', () => {
    // This repo's cost-optimal routing exists to spend it, and the owner configured it for that.
    // Blast radius is cents against $1,600; a gate that fires on the feature you asked for is the
    // gate you switch off.
    expect(METERED_KEYS).not.toContain('OPENROUTER_API_KEY');
    expect(check('aqe test', { OPENROUTER_API_KEY: 'sk-or-x' }).verdict).toBe('ok');
  });
});
