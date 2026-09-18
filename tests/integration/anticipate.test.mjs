/**
 * anticipate.sh — the L4 delivery surface (ADR-028 "Anticipatory", ADR-027 anti-nag).
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING. A goal matcher that nothing calls is worthless, and this
 * repo has shipped built-tested-unwired code repeatedly. So the first test here is the delivery
 * test: given a real hook payload on stdin, does a line actually come out of stdout? Everything
 * after it is the other half of the bargain — proving the thing that speaks knows how to shut up.
 *
 * THE ASYMMETRY THAT SHAPES THE WHOLE FILE. A missed suggestion costs one suggestion. A hook that
 * speaks when it should not gets disabled, and a disabled hook protects nothing — ADR-028 fixes a
 * precision floor of 0.60 and calls frequency "a feature with a hard ceiling, not a dial to turn
 * up". So the silence tests outnumber the firing tests here on purpose, and each one names the
 * specific way it could go wrong.
 *
 * WHY THE MODULES ARE FIXTURES. goal-match.mjs is another agent's file with its own tests, and did
 * not exist when this hook was written. These tests exercise the DELIVERY CONTRACT — payload in,
 * dormancy filtering, anti-nag state, at most one line out — against fixture modules injected
 * through the same env overrides the rest of this repo uses (RUVNET_LESSON_STORE, etc.). That the
 * real matcher ranks well is its own file's claim to prove, not this one's. The one thing tested
 * against the world as it actually is: a MISSING matcher must degrade silently, which is the
 * documented contract and, until goal-match.mjs lands, the live behaviour on every machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'anticipate.sh');

let home;      // scratch HOME — the state file and any stray write both land here
let work;      // scratch cwd — a hook must not litter the project it observes
let fx;        // fixture modules

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-work-'));
  fx = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-fx-'));
});
afterEach(() => {
  for (const d of [home, work, fx]) fs.rmSync(d, { recursive: true, force: true });
});

const STATE = () => path.join(home, '.config', 'ruvnet-brain', 'anticipate-state.json');
const OUTCOMES = () => path.join(home, '.config', 'ruvnet-brain', 'advocacy-outcomes.jsonl');

/** Parse the ledger's JSONL rows for one id — the single source of truth suppression now reads. */
function ledgerRows(id) {
  let raw;
  try { raw = fs.readFileSync(OUTCOMES(), 'utf8'); } catch { return []; }
  return raw.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.id === id);
}

/**
 * A capability registry fixture. Rows carry the exact shape auditAll() returns, including the
 * `state` vocabulary from capability-registry.mjs STATE — 'off' | 'on' | 'unknown' | 'absent'.
 */
function writeRegistry(rows) {
  const p = path.join(fx, 'reg.mjs');
  fs.writeFileSync(p, `export function auditAll() { return ${JSON.stringify(rows)}; }\n`);
  return p;
}

/** A matcher fixture: returns `results` for any prompt containing `needle`, else nothing. */
function writeMatcher(needle, results) {
  const p = path.join(fx, 'gm.mjs');
  fs.writeFileSync(p, `export function matchGoal(prompt, caps) {
  if (!new RegExp(${JSON.stringify(needle)}, 'i').test(prompt)) return [];
  const keys = new Set(caps.map((c) => c.key));
  return ${JSON.stringify(results)}.filter((r) => keys.has(r.capability));
}\n`);
  return p;
}

const DORMANT_ROW = {
  key: 'learning-hooks',
  label: 'Learning hooks',
  whatItBuysYou: 'Your AI reuses the approach that actually worked instead of re-deriving it.',
  scope: 'machine',
  turnOn: { cmd: 'ruflo hooks enable' },
  state: 'off',
  evidence: 'installed, switched off',
};
const GOOD_MATCH = { capability: 'learning-hooks', why: 'you are asking it to remember what worked', confidence: 0.9 };
const PROMPT = 'can you make this project remember what actually worked between sessions';

/** Run the hook exactly as Claude Code does: JSON on stdin, everything else in the environment. */
function run({ event, registry, matcher, args = [], env = {} } = {}) {
  const res = spawnSync('/bin/sh', [HOOK, ...args], {
    input: typeof event === 'string' ? event : JSON.stringify(event ?? {}),
    cwd: work,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...(registry ? { RUVNET_CAPABILITY_REGISTRY: registry } : {}),
      ...(matcher ? { RUVNET_GOAL_MATCH: matcher } : {}),
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Everything a run left behind, relative to a root — the footprint assertion's raw material. */
function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('anticipate.sh — it delivers', () => {
  it('preserves a command prerequisite in the delivered suggestion without executing it', () => {
    const marker = path.join(work, 'must-not-execute');
    const row = { ...DORMANT_ROW, turnOn: {
      cmd: `touch '${marker}'`, human: 'Requires OPENROUTER_API_KEY; read-only scoring is free',
    } };
    const { status, stdout } = run({
      event: { session_id: 'prerequisite', prompt: PROMPT },
      registry: writeRegistry([row]), matcher: writeMatcher('remember', [GOOD_MATCH]),
    });
    expect(status).toBe(0);
    expect(stdout).toContain(row.turnOn.cmd);
    expect(stdout).toContain(row.turnOn.human);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('fires on a genuinely matching prompt, naming only derived values', () => {
    const { status, stdout } = run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: writeMatcher('remember', [GOOD_MATCH]),
    });

    expect(status).toBe(0);
    // The delivery claim: something actually came out of stdout, which is what the harness injects.
    expect(stdout.trim()).not.toBe('');
    // Every substantive token is DERIVED — the label, the payoff and the command all come off the
    // audited row, and the reason comes off the match. Nothing here is authored by the hook.
    expect(stdout).toContain(DORMANT_ROW.label);
    expect(stdout).toContain(DORMANT_ROW.turnOn.cmd);
    expect(stdout).toContain(GOOD_MATCH.why);
    // AT MOST ONE LINE. The ceiling is the feature; a hook that grows to a paragraph is the
    // "dashboard with better copy" ADR-028 exists to kill.
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });

  it('never prints the payoff twice, and caps a verbose matcher', () => {
    /**
     * Both defects here were invisible to fixtures and only appeared on the first real end-to-end
     * run: goal-match.mjs's explain() already folds `whatItBuysYou` into its `why`, so the line
     * printed the identical sentence twice. And a `why` is matcher-authored text injected on every
     * matching prompt — unbounded, it is a wall of context the token meter would have to eat.
     */
    const registry = writeRegistry([DORMANT_ROW]);

    const dup = run({
      event: { session_id: 'dup', prompt: PROMPT },
      registry,
      matcher: writeMatcher('remember', [{
        ...GOOD_MATCH,
        why: `serves that goal: ${DORMANT_ROW.whatItBuysYou}`,
      }]),
    });
    const occurrences = dup.stdout.split(DORMANT_ROW.whatItBuysYou).length - 1;
    expect(occurrences).toBe(1);

    const long = run({
      event: { session_id: 'long', prompt: PROMPT },
      registry,
      matcher: writeMatcher('remember', [{ ...GOOD_MATCH, why: 'w'.repeat(5000) }]),
    });
    expect(long.stdout).not.toContain('w'.repeat(1000));
    expect(long.stdout.length).toBeLessThan(1200);
  });

  it('uses the matcher\'s own confidence floor rather than competing with it', () => {
    // The hook must not apply a second, invisible threshold: a match the matcher deliberately
    // surfaced at its published floor has to survive. Hardcoding 0.7 here silently discarded
    // everything the real matcher returned between 0.6 and 0.69.
    const registry = writeRegistry([DORMANT_ROW]);
    const p = path.join(fx, 'floored.mjs');
    fs.writeFileSync(p, `export const CONFIDENCE_FLOOR = 0.6;
export function matchGoal(prompt, caps) {
  const keys = new Set(caps.map((c) => c.key));
  return [{ capability: 'learning-hooks', why: 'right at the floor', confidence: 0.61 }].filter((r) => keys.has(r.capability));
}\n`);
    expect(run({ event: { session_id: 'floor', prompt: PROMPT }, registry, matcher: p }).stdout)
      .toContain(DORMANT_ROW.label);

    // ...and a match BELOW the matcher's own floor is still refused.
    const under = path.join(fx, 'under.mjs');
    fs.writeFileSync(under, `export const CONFIDENCE_FLOOR = 0.6;
export function matchGoal() { return [{ capability: 'learning-hooks', why: 'too weak', confidence: 0.4 }]; }\n`);
    expect(run({ event: { session_id: 'under', prompt: PROMPT }, registry, matcher: under }).stdout).toBe('');
  });

  it('tells the user how to silence it, and that instruction really works (executor + undo)', () => {
    const registry = writeRegistry([DORMANT_ROW]);
    const matcher = writeMatcher('remember', [GOOD_MATCH]);

    const first = run({ event: { session_id: 's1', prompt: PROMPT }, registry, matcher });
    expect(first.stdout).toContain('--dismiss learning-hooks');

    // Run the exact instruction that was printed. A control we render must have a real executor —
    // this repo has shipped a dead button before, and the fix is to make the test press it.
    const dismissed = run({ args: ['--dismiss', 'learning-hooks'], registry, matcher });
    expect(dismissed.status).toBe(0);
    // THE SINGLE SUPPRESSION POLICY (2026-07-23): the local anticipate-state.json `dismissed` array
    // is gone — advocacy-outcomes.mjs's ledger is the only place a dismissal is recorded now, and
    // DORMANT_ROW carries no `severity`, so it is 'normal' (budget 1): one dismissal fully spends it.
    expect(ledgerRows('learning-hooks').map((r) => r.action)).toContain('dismissed');
    expect(dismissed.stdout).toMatch(/will not be raised again/);

    // Dismissed means dismissed — even in a brand-new session that has said nothing yet.
    const after = run({ event: { session_id: 'brand-new', prompt: PROMPT }, registry, matcher });
    expect(after.stdout.trim()).toBe('');

    // ...and the undo genuinely restores it. A dismissal with no inverse is a one-way door. The undo
    // is a RESET record, not a deletion — append-only, same as every other write to this ledger.
    const undo = run({ args: ['--undismiss', 'learning-hooks'], registry, matcher });
    expect(undo.status).toBe(0);
    expect(ledgerRows('learning-hooks').map((r) => r.action)).toEqual(['offered', 'dismissed', 'reset']);
    const again = run({ event: { session_id: 'later', prompt: PROMPT }, registry, matcher });
    expect(again.stdout).toContain(DORMANT_ROW.label);
  });
});

describe('anticipate.sh — the dismissal budget is severity-weighted (the single suppression policy)', () => {
  // THE DEFECT THIS PROVES FIXED. Before this build, anticipate.sh kept its OWN dismissed-Set: ONE
  // --dismiss call muted a capability forever, at every severity, and advocacy-outcomes.mjs's
  // DISMISSAL_BUDGET (1 for normal, 3 for high) sat completely uncalled — two disconnected
  // suppression policies for one decision. These tests drive the REAL hook end-to-end (spawnSync,
  // real advocacy-outcomes.mjs, real ledger file) and would fail against the old policy: a
  // high-severity finding would have gone silent after the FIRST dismissal instead of surviving two.

  it('a NORMAL finding (no severity field) is muted by its first dismissal', () => {
    const registry = writeRegistry([DORMANT_ROW]);   // no `severity` → weightClass() resolves 'normal'
    const matcher = writeMatcher('remember', [GOOD_MATCH]);

    expect(run({ event: { session_id: 'n1', prompt: PROMPT }, registry, matcher }).stdout)
      .toContain(DORMANT_ROW.label);

    const d1 = run({ args: ['--dismiss', DORMANT_ROW.key], registry, matcher });
    expect(d1.status).toBe(0);
    expect(d1.stdout, 'a normal finding spends its whole budget (1) on the first click').toMatch(/will not be raised again/);
    expect(ledgerRows(DORMANT_ROW.key).find((r) => r.action === 'dismissed').severity).toBe('normal');

    // A brand-new session — dismissed means dismissed, immediately.
    expect(run({ event: { session_id: 'n2', prompt: PROMPT }, registry, matcher }).stdout.trim()).toBe('');
  });

  it('a HIGH-severity finding survives one and two dismissals, and only the third silences it', () => {
    const HIGH_ROW = {
      ...DORMANT_ROW, key: 'repair-memory-index', label: 'Repair memory index', severity: 'high',
      turnOn: { cmd: 'ruflo memory repair' }, evidence: 'integrity_check: 1 corrupt index',
    };
    const HIGH_MATCH = { capability: HIGH_ROW.key, why: 'your memory index looks corrupt', confidence: 0.9 };
    const registry = writeRegistry([HIGH_ROW]);
    const matcher = writeMatcher('remember', [HIGH_MATCH]);

    expect(run({ event: { session_id: 'h1', prompt: PROMPT }, registry, matcher }).stdout)
      .toContain(HIGH_ROW.label);

    const d1 = run({ args: ['--dismiss', HIGH_ROW.key], registry, matcher });
    expect(d1.stdout, 'the first dismissal must know it is high-severity, not fall back to normal')
      .toMatch(/1\/3 for a high-severity finding/);
    expect(run({ event: { session_id: 'h2', prompt: PROMPT }, registry, matcher }).stdout,
      'dismissal 1 of 3 must not yet suppress a high-severity finding').toContain(HIGH_ROW.label);

    const d2 = run({ args: ['--dismiss', HIGH_ROW.key], registry, matcher });
    expect(d2.stdout).toMatch(/2\/3 for a high-severity finding/);
    expect(run({ event: { session_id: 'h3', prompt: PROMPT }, registry, matcher }).stdout,
      'dismissal 2 of 3 must not yet suppress a high-severity finding').toContain(HIGH_ROW.label);

    const d3 = run({ args: ['--dismiss', HIGH_ROW.key], registry, matcher });
    expect(d3.stdout, 'the third dismissal spends the high-severity budget').toMatch(/will not be raised again/);
    expect(run({ event: { session_id: 'h4', prompt: PROMPT }, registry, matcher }).stdout).toBe('');

    expect(ledgerRows(HIGH_ROW.key).filter((r) => r.action === 'dismissed')).toHaveLength(3);
  });

  it('a missing advocacy-outcomes module is silence for `suggest`, and an honest failure for the CLI modes', () => {
    const registry = writeRegistry([DORMANT_ROW]);
    const matcher = writeMatcher('remember', [GOOD_MATCH]);
    const missingModule = path.join(fx, 'no-advocacy-outcomes.mjs');

    const suggest = run({
      event: { session_id: 's1', prompt: PROMPT }, registry, matcher,
      env: { RUVNET_ADVOCACY_OUTCOMES_MODULE: missingModule },
    });
    expect(suggest.status).toBe(0);
    expect(suggest.stdout).toBe('');

    const dismiss = run({
      args: ['--dismiss', 'learning-hooks'], registry, matcher,
      env: { RUVNET_ADVOCACY_OUTCOMES_MODULE: missingModule },
    });
    expect(dismiss.status).toBe(0);
    expect(dismiss.stderr + dismiss.stdout).toMatch(/advocacy-outcomes module (not found|unavailable)/);
  });
});

describe('anticipate.sh — it shuts up (the half that keeps it installed)', () => {
  it('is SILENT on an unrelated prompt', () => {
    const { status, stdout } = run({
      event: { session_id: 's1', prompt: 'what is the capital of France, and why is it the capital' },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: writeMatcher('remember', [GOOD_MATCH]),
    });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('is SILENT the second time, in the same session, for the same capability', () => {
    const registry = writeRegistry([DORMANT_ROW]);
    const matcher = writeMatcher('remember', [GOOD_MATCH]);
    const event = { session_id: 'same-session', prompt: PROMPT };

    expect(run({ event, registry, matcher }).stdout).toContain(DORMANT_ROW.label);
    // Identical payload, identical session: the second turn must produce nothing at all.
    expect(run({ event, registry, matcher }).stdout).toBe('');
    expect(run({ event, registry, matcher }).stdout).toBe('');

    // ...but a genuinely new session may hear it once. "Once per session", not "once ever" —
    // otherwise dismissal and exhaustion become the same thing and the user loses the distinction.
    const next = run({ event: { session_id: 'a-different-session', prompt: PROMPT }, registry, matcher });
    expect(next.stdout).toContain(DORMANT_ROW.label);
  });

  it('NEVER speaks for a capability whose state is unknown', () => {
    // THE NON-NEGOTIABLE. A detector that could not tell must never be rendered as a fault: the
    // "26 hooks off" incident reported exactly that while the learner held 457 trajectories. Here
    // the matcher is eager and would happily return the row — the hook must refuse it anyway.
    const rows = [
      { ...DORMANT_ROW, key: 'unknowable', label: 'Unknowable', state: 'unknown', evidence: 'this check could not run' },
      { ...DORMANT_ROW, key: 'not-installed', label: 'Not installed', state: 'absent', evidence: 'not on this machine' },
      { ...DORMANT_ROW, key: 'already-on', label: 'Already on', state: 'on', evidence: 'running' },
    ];
    const { status, stdout } = run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry(rows),
      matcher: writeMatcher('remember', [
        { capability: 'unknowable', why: 'w', confidence: 0.99 },
        { capability: 'not-installed', why: 'w', confidence: 0.99 },
        { capability: 'already-on', why: 'w', confidence: 0.99 },
      ]),
    });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('is SILENT on a match with no reason, and on one with weak or missing confidence', () => {
    const registry = writeRegistry([DORMANT_ROW]);

    // No evidence, no speech — the discipline console-engine.makeRecommendation() enforces by throwing.
    expect(run({
      event: { session_id: 'a', prompt: PROMPT },
      registry,
      matcher: writeMatcher('remember', [{ capability: 'learning-hooks', why: '   ', confidence: 0.99 }]),
    }).stdout).toBe('');

    // Below the floor.
    expect(run({
      event: { session_id: 'b', prompt: PROMPT },
      registry,
      matcher: writeMatcher('remember', [{ ...GOOD_MATCH, confidence: 0.2 }]),
    }).stdout).toBe('');

    // A matcher that cannot say how sure it is does not get the benefit of the doubt.
    expect(run({
      event: { session_id: 'c', prompt: PROMPT },
      registry,
      matcher: writeMatcher('remember', [{ capability: 'learning-hooks', why: 'w' }]),
    }).stdout).toBe('');
  });

  it('caps a single session even when many different capabilities match', () => {
    // Once-per-capability alone still permits one interruption per capability in the registry.
    // Eleven interruptions in a session is a nag by any honest reading of the precision floor.
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...DORMANT_ROW, key: `cap-${i}`, label: `Cap ${i}` }));
    const registry = writeRegistry(rows);
    const matcher = writeMatcher('remember', rows.map((r, i) => ({
      capability: r.key, why: 'relevant', confidence: 0.9 - i * 0.01,
    })));
    const event = { session_id: 'chatty', prompt: PROMPT };

    let spoke = 0;
    for (let i = 0; i < 6; i += 1) if (run({ event, registry, matcher }).stdout.trim()) spoke += 1;
    expect(spoke).toBeGreaterThan(0);      // it is not mute
    expect(spoke).toBeLessThanOrEqual(2);  // and it is not a nag
  }, 30_000);

  it('is SILENT when it cannot record having spoken — forgetting is how a hook becomes a nag', () => {
    // If the state write fails, speaking would repeat on the very next prompt forever. Silence is
    // the only safe branch, so the config dir is made unwritable and the hook must decline to talk.
    const cfg = path.join(home, '.config', 'ruvnet-brain');
    fs.mkdirSync(cfg, { recursive: true });
    fs.chmodSync(cfg, 0o500);
    try {
      const { status, stdout } = run({
        event: { session_id: 's1', prompt: PROMPT },
        registry: writeRegistry([DORMANT_ROW]),
        matcher: writeMatcher('remember', [GOOD_MATCH]),
      });
      expect(status).toBe(0);
      expect(stdout).toBe('');
    } finally {
      fs.chmodSync(cfg, 0o700);
    }
  });

  it('honours the RUVNET_ANTICIPATE=0 kill switch', () => {
    const { status, stdout } = run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: writeMatcher('remember', [GOOD_MATCH]),
      env: { RUVNET_ANTICIPATE: '0' },
    });
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(fs.existsSync(STATE())).toBe(false);   // switched off means it did not run at all
  });
});

describe('anticipate.sh — it can never cost the user a turn', () => {
  /**
   * Each of these is a way the world is genuinely broken on someone's machine. A UserPromptSubmit
   * hook that fails a turn is worse than any capability it could advertise, so every one of them
   * must produce exit 0 and no stdout — including the several that would throw inside node.
   */
  const broken = {
    'no stdin at all': { event: '' },
    'stdin that is not JSON': { event: 'not json at all, just some words the user typed' },
    'JSON with no prompt field': { event: { session_id: 's1', hook_event_name: 'UserPromptSubmit' } },
    'a prompt that is not a string': { event: { session_id: 's1', prompt: { nested: true } } },
    'JSON that is an array': { event: [1, 2, 3] },
    'no session_id': { event: { prompt: PROMPT } },
  };

  for (const [label, payload] of Object.entries(broken)) {
    it(`exits 0 and stays quiet: ${label}`, () => {
      const { status, stdout } = run({
        ...payload,
        registry: writeRegistry([DORMANT_ROW]),
        matcher: writeMatcher('remember', [GOOD_MATCH]),
      });
      expect(status).toBe(0);
      // A missing session_id still legitimately fires (it falls back to a bounded cwd+day key), so
      // only the exit code is universal here — the point of this block is that nothing CRASHES.
      if (label !== 'no session_id') expect(stdout).toBe('');
    });
  }

  it('exits 0 and stays quiet when the matcher module does not exist', () => {
    // THE LIVE CASE. Until goal-match.mjs lands, this is what runs on every machine, and it is the
    // documented degradation: no module, no work, no noise.
    const { status, stdout } = run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: path.join(fx, 'does-not-exist.mjs'),
    });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 when the matcher or the registry throws', () => {
    const boom = path.join(fx, 'boom.mjs');
    fs.writeFileSync(boom, 'export function matchGoal() { throw new Error("matcher exploded"); }\n');
    expect(run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: boom,
    }).status).toBe(0);

    const badReg = path.join(fx, 'badreg.mjs');
    fs.writeFileSync(badReg, 'export function auditAll() { throw new Error("audit exploded"); }\n');
    expect(run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: badReg,
      matcher: writeMatcher('remember', [GOOD_MATCH]),
    }).status).toBe(0);

    // Syntactically broken modules fail at import, not at call — a different code path.
    const syntax = path.join(fx, 'syntax.mjs');
    fs.writeFileSync(syntax, 'export function matchGoal( { <<< not javascript\n');
    expect(run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: syntax,
    }).status).toBe(0);
  });

  it('exits 0 on a corrupt state file rather than inheriting the corruption', () => {
    fs.mkdirSync(path.dirname(STATE()), { recursive: true });
    fs.writeFileSync(STATE(), '{ this is not json');
    const { status } = run({
      event: { session_id: 's1', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: writeMatcher('remember', [GOOD_MATCH]),
    });
    expect(status).toBe(0);
  });

  it('survives a very large pasted prompt without failing the turn', () => {
    // The payload travels in the environment, so a big paste is the case that would break an argv
    // based design. It must degrade to silence at worst, never to a failed exec that errors a turn.
    const { status } = run({
      event: { session_id: 's1', prompt: `${PROMPT} ${'x'.repeat(200_000)}` },
      registry: writeRegistry([DORMANT_ROW]),
      matcher: writeMatcher('remember', [GOOD_MATCH]),
    });
    expect(status).toBe(0);
  });
});

describe('anticipate.sh — footprint', () => {
  it('writes NOTHING outside ~/.config/ruvnet-brain, and nothing at all into the project', () => {
    /**
     * The bill for getting this wrong is on the record: an earlier capability check shelled out to
     * a tool that daemonized, leaving a live background process and four files written into HOME
     * (.claude-flow/daemon.pid, daemon-state.json, logs/daemon.log, update-state.json). Hundreds of
     * people must not each acquire a polluted home directory as the price of a suggestion. This is
     * the test that would have caught it: snapshot both trees, run the firing path, diff.
     */
    const registry = writeRegistry([DORMANT_ROW]);
    const matcher = writeMatcher('remember', [GOOD_MATCH]);
    const beforeWork = tree(work);

    run({ event: { session_id: 's1', prompt: PROMPT }, registry, matcher });
    run({ event: { session_id: 's2', prompt: PROMPT }, registry, matcher });
    run({ args: ['--dismiss', 'learning-hooks'], registry, matcher });
    run({ args: ['--status'], registry, matcher });

    // The project directory the user is standing in is untouched — no .ruvnet-brain, no stray dot-dir.
    expect(tree(work)).toEqual(beforeWork);

    // In HOME, exactly TWO files and no others — both under .config/ruvnet-brain, both deliberate.
    // Not a temp file, not a log, not a daemon pid.
    //
    // The outcome ledger was ADDED on 2026-07-22 and this assertion caught it, which is the point:
    // a footprint change must be a decision someone wrote down, never a thing that quietly appears.
    // It is here because L5 (does advocacy actually help?) was previously unmeasurable — the ledger
    // had zero callers, so precision = applied ÷ offered had no denominator and would have read 0
    // forever while looking implemented.
    expect(tree(home).sort()).toEqual([
      path.join('.config', 'ruvnet-brain', 'advocacy-outcomes.jsonl'),
      path.join('.config', 'ruvnet-brain', 'anticipate-state.json'),
    ].sort());
  });

  it('keeps the state file bounded as sessions accumulate', () => {
    // Sessions are worthless once they end, and an unbounded file is a slow leak in a path that is
    // read on every single prompt.
    //
    // 26, not 40, and an explicit timeout: every iteration is a real subprocess, and at 40 this
    // measured 3.14s idle — 63% of vitest's 5s default before a CI runner has any load on it. It
    // duly blew past the default the moment the suite was run under load. 26 still proves the only
    // thing at stake (that the file stops growing past 20) with margin the runner cannot eat.
    const registry = writeRegistry([DORMANT_ROW]);
    const matcher = writeMatcher('remember', [GOOD_MATCH]);
    for (let i = 0; i < 26; i += 1) {
      run({ event: { session_id: `s-${i}`, prompt: PROMPT }, registry, matcher });
    }
    const st = JSON.parse(fs.readFileSync(STATE(), 'utf8'));
    expect(Object.keys(st.sessions).length).toBeLessThanOrEqual(20);
  }, 60_000);

  it('adds negligible latency on the common path — no matcher installed, nothing to do', () => {
    // This runs on EVERY prompt inside a 5s budget already partly spent by ground-ruvnet.sh. With
    // no matcher on disk the hook must not even reach node. Generous bound: the assertion is about
    // catching an accidental subprocess on the hot path, not about micro-benchmarking a CI runner.
    const registry = writeRegistry([DORMANT_ROW]);
    const missing = path.join(fx, 'nope.mjs');
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      run({ event: { session_id: `x-${i}`, prompt: PROMPT }, registry, matcher: missing });
    }
    expect((Date.now() - t0) / 5).toBeLessThan(300);
  }, 30_000);
});

describe('anticipate.sh — continuous reconciliation (the L5 loop runs on the PUSH surface)', () => {
  /**
   * THE DEDUCTION THIS CLOSES. The precision metric ADR-028 uses to separate advocating from nagging
   * was only ever reconciled when someone opened the console and it polled /api/capabilities — a PULL
   * surface guarding an anti-pull metric, ADR-028's own named failure. These tests prove the credit
   * now happens on the hook that already fires every prompt, with no console visit anywhere in sight.
   *
   * They FAIL if the reconcileApplied() call is removed from anticipate.sh: nothing else writes an
   * APPLIED in this harness, so the assertion drops to zero. That is the point — a test that could not
   * fail on the un-wired code would be defending nothing.
   */
  const advocacyModule = () =>
    import(pathToFileURL(path.join(ROOT, 'scripts', 'advocacy-outcomes.mjs')).href);

  it('carries one induced dormant capability through offer → user action → ON → APPLIED', async () => {
    const matcher = writeMatcher('remember', [GOOD_MATCH]);

    const offered = run({
      event: { session_id: 'induced-offer', prompt: PROMPT },
      registry: writeRegistry([DORMANT_ROW]),
      matcher,
    });
    expect(offered.status).toBe(0);
    expect(offered.stdout).toContain(DORMANT_ROW.label);
    expect(ledgerRows(DORMANT_ROW.key).filter((r) => r.action === 'offered')).toHaveLength(1);

    // The user's action is represented by the same observable the product trusts in production:
    // the next capability audit sees the offered capability ON. The hook then reconciles that
    // transition into the real append-only outcome ledger without a console poll or hand-seeded row.
    const acted = run({
      event: { session_id: 'induced-applied', prompt: 'confirm the learning hooks I enabled are active now' },
      registry: writeRegistry([{ ...DORMANT_ROW, state: 'on', evidence: 'enabled by user' }]),
      matcher: writeMatcher('will-not-match', []),
    });
    expect(acted.status).toBe(0);

    const rows = ledgerRows(DORMANT_ROW.key);
    expect(rows.filter((r) => r.action === 'applied')).toHaveLength(1);
    const mod = await advocacyModule();
    expect(mod.precision({ file: OUTCOMES() })).toMatchObject({
      offered: 1,
      applied: 1,
      precision: 1,
    });
  });

  /** Seed an OFFER through the REAL recorder, so the row is exactly the shape reconcileApplied reads —
   *  a hand-written JSONL line would be testing a schema the module might never accept. */
  async function seedOffer(id) {
    fs.mkdirSync(path.dirname(OUTCOMES()), { recursive: true });
    const mod = await advocacyModule();
    const res = mod.record({ id, action: mod.ACTIONS.OFFERED, severity: 'normal' }, { file: OUTCOMES() });
    expect(res.ok).toBe(true);
    return mod;
  }

  it('credits an APPLIED for an offered capability that is now switched on — no console poll involved', async () => {
    const mod = await seedOffer('learning-hooks');
    expect(ledgerRows('learning-hooks').filter((r) => r.action === mod.ACTIONS.APPLIED)).toHaveLength(0);

    // The capability is ON now, so it is NOT dormant and the offer path cannot fire again — any APPLIED
    // that appears came from reconciliation, not from a fresh offer. A real matcher fixture is required
    // only because the hook refuses to run without one; it is never consulted (dormant is empty).
    const { status } = run({
      event: { session_id: 'reconcile', prompt: 'a prompt matching no dormant goal at all' },
      registry: writeRegistry([{ ...DORMANT_ROW, state: 'on' }]),
      matcher: writeMatcher('unrelated-needle', []),
    });
    expect(status).toBe(0);

    const applied = ledgerRows('learning-hooks').filter((r) => r.action === mod.ACTIONS.APPLIED);
    expect(applied).toHaveLength(1);
  });

  it('is idempotent — a second substantive prompt in the same on-state never double-credits', async () => {
    // Prompts must clear the hook's own >=12-char substantive-prompt guard (anticipate.sh:325) — the
    // same bar a nudge clears. Reconciliation piggybacks on the hook's real work rather than paying to
    // audit on every "ok"/"yes", so a trivial prompt is deliberately not a reconciliation point. Two
    // real prompts here: the first credits the APPLIED, the second must find nothing pending.
    const mod = await seedOffer('learning-hooks');
    const registry = writeRegistry([{ ...DORMANT_ROW, state: 'on' }]);
    const matcher = writeMatcher('unrelated-needle', []);
    run({ event: { session_id: 'r1', prompt: 'first substantive prompt for reconciliation' }, registry, matcher });
    run({ event: { session_id: 'r2', prompt: 'second substantive prompt for reconciliation' }, registry, matcher });
    const applied = ledgerRows('learning-hooks').filter((r) => r.action === mod.ACTIONS.APPLIED);
    expect(applied).toHaveLength(1);
  });

  it('credits nothing when the capability is still off — reconciliation is not a fabricated apply', async () => {
    const mod = await seedOffer('learning-hooks');
    // Still OFF: the user has not acted, so there is no APPLIED to record. (The offer path is separately
    // suppressed by the matcher returning nothing, so this run neither offers nor applies.)
    run({
      event: { session_id: 'stilloff', prompt: 'a prompt matching no dormant goal at all' },
      registry: writeRegistry([{ ...DORMANT_ROW, state: 'off' }]),
      matcher: writeMatcher('unrelated-needle', []),
    });
    expect(ledgerRows('learning-hooks').filter((r) => r.action === mod.ACTIONS.APPLIED)).toHaveLength(0);
  });
});
