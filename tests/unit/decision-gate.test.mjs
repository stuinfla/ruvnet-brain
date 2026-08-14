import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET_MS, MIN_HEADROOM_MS, decide, policiesFor, skipReason } from '../../plugin/scripts/decision-gate.mjs';

/**
 * ADR-067 — EXACTLY ONE HOOK MAY REFUSE A GIVEN TOOL CALL.
 *
 * Measured from hooks.json's own matchers on 2026-08-10, before this landed:
 *
 *     Write | Edit  →  hijack-ruvnet · ground-before-write · protect-state · unprompted-speech
 *     Bash          →  hijack-ruvnet · design-wall · unprompted-speech
 *
 * Four independent processes could refuse the same Write. No precedence, no shared context, no way
 * for any to know what the others thought — whichever exited 2 first won, and the user got that one's
 * reason with no hint that a second wall was standing behind it. That is the concrete form of
 * "constraints that break and collapse on each other".
 *
 * The structural test is the LAST one in this file: it reads hooks.json and fails if any event ever
 * regains a second refuser. Everything above it tests the composition rule that makes one refuser
 * sufficient.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(ROOT, 'plugin', 'scripts', 'decision-gate.mjs');
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8'));

const verdict = (id, code, stderr = '') => ({ id, code, stderr, stdout: '' });

/**
 * Fire the real gate the way PreToolUse does: argv sub-event, JSON on stdin, no tty.
 *
 * spawnSync, not execFileSync. The execFileSync version returned a HARDCODED `stderr: ''` on its
 * success branch — execFileSync forwards a child's stderr to the parent rather than capturing it
 * unless `stdio` says otherwise — so `expect(r.stderr).toBe('')` on the allow case below was
 * asserting a string literal against itself and could not fail on any gate, however noisy. A test
 * that cannot fail on broken code is not a test; spawnSync captures both streams on both paths and
 * makes that assertion load-bearing, which matters now that a blown budget writes to stderr.
 */
function fire(event, toolInput, toolName = 'Write', env = {}) {
  const payload = JSON.stringify({
    session_id: `dg-${Math.round(Number(process.env.VITEST_WORKER_ID || 1))}`,
    hook_event_name: 'PreToolUse', tool_name: toolName, cwd: ROOT, tool_input: toolInput,
  });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GATE, event], {
    input: payload, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), ms: Date.now() - t0 };
}

describe('ADR-067 — one decision, composed from many policies', () => {
  it('allows when no policy refuses', () => {
    expect(decide([verdict('a', 0), verdict('b', 0)])).toEqual({ allow: true, refusals: [] });
  });

  it('refuses with the winning policy\'s OWN words, not a summary of them', () => {
    // A policy wrote its message for exactly this moment. Replacing it with our own paraphrase loses
    // the specific instruction the user needs in order to proceed.
    const d = decide([verdict('protect-state', 2, '⛔ BLOCKED — that file is the user\'s own record.')]);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/that file is the user's own record/);
  });

  it('TEETH: names EVERY other policy that also refused', () => {
    // This is the user-visible payoff. Under four racing hooks you fixed the first refusal, re-ran,
    // and hit the second — one round-trip per wall, with no way to see them coming.
    const d = decide([
      verdict('protect-state', 2, 'consent boundary'),
      verdict('ground-before-write', 2, 'no fresh grounding stamp\nsecond line'),
      verdict('design-wall', 2, 'no design grade'),
    ]);
    expect(d.refusals).toEqual(['protect-state', 'ground-before-write', 'design-wall']);
    expect(d.reason).toMatch(/consent boundary/);
    expect(d.reason, 'the others must be named').toMatch(/Also refusing/);
    expect(d.reason).toMatch(/ground-before-write: no fresh grounding stamp/);
    expect(d.reason).toMatch(/design-wall: no design grade/);
    expect(d.reason, 'only the FIRST line of each secondary reason — the rest is noise here')
      .not.toMatch(/second line/);
  });

  it('TEETH: a non-zero code that is not 2 is an ERROR, never a refusal', () => {
    // lesson-gate.mjs had to learn this twice: exit 1 is a non-blocking hook error. Treating any
    // failure as a refusal would let a crashing policy block all work.
    expect(decide([verdict('broken', 1, 'stack trace')]).allow).toBe(true);
    expect(decide([verdict('broken', 127, 'command not found')]).allow).toBe(true);
  });

  it('precedence is a property of the policy, not of registry order', () => {
    // A future edit that lists policies in a different order in the registry must not silently
    // reorder which reason a user sees first.
    const scrambled = { write: ['ground-before-write', 'protect-state', 'hijack-ruvnet'] };
    expect(policiesFor('write', scrambled).map((p) => p.id))
      .toEqual(['protect-state', 'hijack-ruvnet', 'ground-before-write']);
  });

  it('an unknown event selects no policies', () => {
    expect(policiesFor('nonsense')).toEqual([]);
  });
});

/**
 * THE REAL-GATE CASES NEED BASH, and Windows CI does not have it.
 *
 * Every refusal policy is a `.sh` file. `resolveBash()` returns nothing on a runner without Git
 * Bash, so `runPolicy` contributes no verdict, nothing can refuse, and the gate correctly FAILS OPEN
 * — the same behaviour those four walls always had on a bashless host, where hook-shim already
 * declines to run bash hooks and says so once.
 *
 * So the product is right and the assertion was wrong: it demanded a refusal that cannot occur.
 * Skipped explicitly rather than left red, and the pure `decide()` / `policiesFor()` cases above —
 * which carry the precedence rule and the composition contract — still run on EVERY platform.
 */
const hasBash = process.platform !== 'win32' || Boolean(process.env.CLAUDE_CODE_GIT_BASH_PATH || process.env.RUVNET_BRAIN_BASH);
const withBash = hasBash ? describe : describe.skip;

withBash('ADR-067 — the real gate, fired the way the host fires it', () => {
  it('refuses a write to the user\'s protected settings, with byte-empty stdout', () => {
    const r = fire('write', { file_path: path.join(os.homedir(), '.config', 'ruvnet-brain', 'settings.json'), content: '{}' });
    expect(r.code, 'exit 2 is the only code the host reads as a refusal').toBe(2);
    expect(r.stdout, 'on a refusal the host ignores stdout — emitting any is a protocol violation').toBe('');
    expect(r.stderr).toMatch(/BLOCKED/);
  }, 40_000);

  it('TEETH: allows an ordinary write, and never writes to stderr while doing so', () => {
    // Without this the suite would pass on a gate that refused everything.
    const r = fire('write', { file_path: path.join(os.tmpdir(), 'ordinary.txt'), content: 'x' });
    expect(r.code).toBe(0);
    expect(r.stderr, 'stderr on an allow would surface as a spurious error to the user').toBe('');
  }, 40_000);

  it('an unknown sub-event allows rather than guessing', () => {
    expect(fire('nonsense', { file_path: '/tmp/x' }).code).toBe(0);
  }, 40_000);
});

describe('ADR-067 — the structural invariant, read from hooks.json', () => {
  /** Hook ids registered as able to refuse. Derived from the shim table, not restated here. */
  const SHIM = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'), 'utf8');
  const blockingIds = new Set(
    [...SHIM.matchAll(/'([a-z-]+)':\s*\{[^}]*mode:\s*'blocking'/g)].map((m) => m[1]),
  );

  it('sanity: the shim still declares some blocking hooks', () => {
    expect(blockingIds.size, 'a parse failure here would make the invariant vacuous').toBeGreaterThan(0);
  });

  it('no PreToolUse tool can be refused by more than ONE registered hook', () => {
    // The whole ADR in one assertion. If someone adds a second blocking PreToolUse entry, this fails
    // and points them at the policy registry instead.
    const refusers = (HOOKS.hooks.PreToolUse || [])
      .flatMap((entry) => entry.hooks.map((h) => ({ matcher: entry.matcher, id: idOf(h.command) })))
      .filter((h) => blockingIds.has(h.id));
    const perMatcher = new Map();
    for (const r of refusers) perMatcher.set(r.matcher, [...(perMatcher.get(r.matcher) || []), r.id]);
    const doubled = [...perMatcher].filter(([, ids]) => ids.length > 1);
    expect(doubled, 'two hooks that can refuse the same call is the defect ADR-067 removed').toEqual([]);
    // …and the one that remains is the gate.
    expect([...new Set(refusers.map((r) => r.id))]).toEqual(['decision-gate']);
  });

  it('the policies the gate consults are no longer registered as hooks of their own', () => {
    const registered = (HOOKS.hooks.PreToolUse || []).flatMap((e) => e.hooks.map((h) => idOf(h.command)));
    for (const owned of ['hijack-ruvnet', 'ground-before-write', 'protect-state', 'design-wall']) {
      expect(registered, `${owned} must be consulted BY the gate, not race it`).not.toContain(owned);
    }
  });
});

/** `node "…/hook-shim.mjs" <id> [arg] || true` → `<id>` */
function idOf(command) {
  const m = /hook-shim\.mjs"\s+([a-z-]+)/.exec(String(command || ''));
  return m ? m[1] : '';
}
