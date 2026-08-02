/**
 * hook-contract.test.mjs — the test that would have caught the 2026-07-22 machine-wide Stop loop.
 *
 * WHY THIS FILE EXISTS.
 *
 * On 2026-07-22 a Stop hook continued every turn in every project on the machine until Claude Code
 * overrode it on the 9th consecutive continuation. It reached three separate repos. At that moment
 * this project had 1,429 passing tests, and the reason none of them caught it is exact and worth
 * stating: EVERY ONE tested a unit. The defect was not in a unit. It was in the CONTRACT — which
 * stream the harness reads, which exit code it honours, what it does with `additionalContext` at
 * Stop, and whether two registries register the same hook twice.
 *
 * Measured at the time of writing, before this file:
 *     test files mentioning stop_hook_active .... 0
 *     test files testing continuation-gate ...... 0
 *     test files referencing hooks.json ......... 2   (of 106)
 *
 * So the suite was green and structurally incapable of going red. A test that cannot fail on broken
 * code is not a test — and 1,429 of them still cannot catch a class of bug none of them models.
 *
 * WHAT THIS FILE DOES DIFFERENTLY: it invokes hooks the way CLAUDE CODE invokes them — as a
 * subprocess, with a JSON payload on stdin — and asserts on the three things the harness actually
 * reads: the exit code, stdout, and stderr, kept separate. No hook is imported as a module, because
 * importing it cannot observe the delivery contract that broke.
 *
 * THE CONTRACT, from code.claude.com/docs/en/hooks (verified 2026-07-22, not recalled):
 *   - exit 0 + stdout JSON `hookSpecificOutput.additionalContext`  → informs. At Stop it CONTINUES
 *     the turn and counts against the 8-consecutive-continuation cap.
 *   - exit 2 + stderr                                              → refuses. stdout is ignored.
 *   - `stop_hook_active` is true once Claude Code is already continuing because of a stop hook.
 *     Returning success while it is true is the documented way to avoid trapping the turn.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTINUATION_GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
const LESSON_HOOKS = path.join(ROOT, 'plugin/scripts/lesson-hooks.sh');
const PLUGIN_HOOKS_JSON = path.join(ROOT, 'plugin/hooks/hooks.json');

/** Invoke a hook exactly as the harness does: subprocess, JSON on stdin, streams kept apart. */
function fireHook(cmd, args, payload, env = {}) {
  const r = spawnSync(cmd, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // A FRESH lesson gate-state per call: lesson-hooks runs the frequency cap (3.9.28-29), and without
    // isolation these invocations wrote the user's REAL ~/.config gate-state and accumulated a fixture
    // lesson past MAX_SHOWS across suite runs. A unique temp path per call keeps every fire at count 0 —
    // deterministic, and it never touches the developer's real config.
    env: {
      ...process.env,
      RUVNET_LESSON_GATE_STATE: path.join(os.tmpdir(), `hc-gs-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      ...env,
    },
    timeout: 15000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tempLedger(items) {
  const p = path.join(os.tmpdir(), `hook-contract-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  // Default a FRESH `at` on every item unless the test sets one — mirrors reality (--commit-to always
  // stamps `at`), so the freshness TTL (which now treats a missing/invalid `at` as stale) doesn't
  // silently make an unstamped fixture non-forceable.
  const stamped = items.map((i) => ({ at: new Date().toISOString(), ...i }));
  fs.writeFileSync(p, JSON.stringify({ items: stamped }));
  return p;
}

describe('Stop-hook loop protection (the 2026-07-22 regression)', () => {
  it('goes SILENT when stop_hook_active is true — the documented loop guard', () => {
    const ledger = tempLedger([{ text: 'unfinished work', done: false }]);
    const r = fireHook('node', [CONTINUATION_GATE],
      { stop_hook_active: true, session_id: 'sess-guard' },
      { RUVNET_WORK_LEDGER: ledger });

    // The whole incident in one assertion: outstanding work AND already-continuing must yield silence.
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
  });

  it('emits a valid additionalContext envelope when work is genuinely outstanding', () => {
    const ledger = tempLedger([{ text: 'ship the fix', done: false }]);
    const r = fireHook('node', [CONTINUATION_GATE],
      { stop_hook_active: false, session_id: 'sess-fresh' },
      { RUVNET_WORK_LEDGER: ledger });

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);            // throws if the envelope is malformed
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('ship the fix');
  });

  it('delivers on STDOUT, never stderr — exit-0 stderr reaches nobody', () => {
    const ledger = tempLedger([{ text: 'visible item', done: false }]);
    const r = fireHook('node', [CONTINUATION_GATE],
      { stop_hook_active: false, session_id: 'sess-stream' },
      { RUVNET_WORK_LEDGER: ledger });

    // The original bug: 922 bytes of intervention written to a stream the harness does not read.
    expect(r.stdout).toContain('additionalContext');
    expect(r.stderr).not.toContain('visible item');
  });

  it('re-engages on every fresh natural stop — the "don\'t stop" fix (ADR-043)', () => {
    // ADR-043: the once-per-session `nudgedSession` guard silenced the gate after ONE nudge, so
    // re-engagement died and the model could stop mid-goal for the rest of a session with no push-back.
    // A fresh natural stop (stop_hook_active:false) with open work must nudge EVERY time. This is
    // bounded not by a per-session cap but by the stop_hook_active guard (tested above): the NEXT stop
    // in a forced-continuation chain carries stop_hook_active:true and goes silent, so each episode
    // forces exactly one continuation. The 2026-07-22 runaway was caused by IGNORING stop_hook_active,
    // not by re-engaging — so re-engagement is safe while that guard is live.
    // Cooldown disabled here so the two rapid fires test PURE re-engagement; the cooldown is proven
    // separately below. In production the two stops are minutes apart and the cooldown never bites.
    const ledger = tempLedger([{ text: 'repeat me', done: false }]);
    const env = { RUVNET_WORK_LEDGER: ledger, RUVNET_CONTINUATION_COOLDOWN_MS: '0' };
    const first = fireHook('node', [CONTINUATION_GATE], { stop_hook_active: false, session_id: 'sess-reengage' }, env);
    const second = fireHook('node', [CONTINUATION_GATE], { stop_hook_active: false, session_id: 'sess-reengage' }, env);

    expect(first.stdout).toContain('additionalContext');
    expect(second.stdout).toContain('additionalContext');   // was `toBe('')` — the once-per-session bug ADR-043 fixes
  });

  it('does NOT force when the stdin payload is unreadable — an EAGAIN must not launder into a loop (ADR-043)', () => {
    // Fable red-team #1: the old readHookInput returned {} on a parse failure, which under a forcing
    // gate reads as "fresh stop" → a machine-wide loop. Garbage on stdin must yield silence, not force.
    const ledger = tempLedger([{ text: 'real open work', done: false }]);
    const r = spawnSync('node', [CONTINUATION_GATE], {
      input: '}{ not json at all',
      encoding: 'utf8',
      env: { ...process.env, RUVNET_WORK_LEDGER: ledger, RUVNET_CONTINUATION_COOLDOWN_MS: '0' },
      timeout: 15000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout ?? '').toBe('');   // open work present, but the payload could not be confirmed → no force
  });

  it('suppresses a second force within the cooldown window — the self-owned loop cap (ADR-043)', () => {
    // Belt-and-braces beyond stop_hook_active: two forces cannot land inside COOLDOWN_MS (default 20s).
    const ledger = tempLedger([{ text: 'cooldown me', done: false }]);
    const env = { RUVNET_WORK_LEDGER: ledger };   // default cooldown, no override
    const first = fireHook('node', [CONTINUATION_GATE], { stop_hook_active: false, session_id: 'sess-cd' }, env);
    const second = fireHook('node', [CONTINUATION_GATE], { stop_hook_active: false, session_id: 'sess-cd' }, env);
    expect(first.stdout).toContain('additionalContext');   // first forces, records lastForcedAt
    expect(second.stdout).toBe('');                        // second within the window → suppressed
  });

  it('DOES force on an old item, and offers the honest exit instead of expiring it (ADR-043 resolved)', () => {
    // REVERSED 2026-07-24, with the reason recorded — this test was RIGHT about the risk and WRONG
    // about the remedy.
    //
    // Fable red-team #3: "a stale item pressuring every turn breeds mark-done-without-doing." True.
    // The first answer was a 24h TTL. Measured consequence on this machine: four GENUINELY OPEN
    // commitments aged 53-56h, `forceable` came back empty, and the gate went silent for ~30 hours —
    // enforcing the owner's most emphatic standing rule by not enforcing it, with no symptom at all.
    // ADR-043 logged this as an OPEN QUESTION (§Open questions #2), never a settled decision.
    //
    // Both risks are real and they are NOT opposites. The pressure to fake a completion comes from
    // being nagged with no legitimate way out. So: an item with a VALID timestamp forces regardless
    // of age, its age is LABELLED rather than hidden, and the nudge names clearing as an honest
    // answer. Unknown age (missing/unparseable `at`) is still refused — that was always the real
    // guard, and it is covered by tests/unit/continuation-gate.test.mjs.
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const ledger = tempLedger([{ text: 'ancient abandoned item', done: false, at: old }]);
    const r = fireHook('node', [CONTINUATION_GATE],
      { stop_hook_active: false, session_id: 'sess-stale' },
      { RUVNET_WORK_LEDGER: ledger, RUVNET_CONTINUATION_COOLDOWN_MS: '0' });
    expect(r.stdout, 'a real open commitment must never expire on a timer').toContain('additionalContext');
    expect(r.stdout, 'its age must be stated, not hidden').toMatch(/committed 2d ago/);
    expect(r.stdout, 'clearing must be offered as the honest alternative to faking it').toMatch(/CLEAR it/);
  });

  it('does NOT force on an empty {} payload — not a real Stop payload (GPT-5.6-Sol review)', () => {
    // An empty-but-parseable {} passes the __source check; a real Stop payload carries session_id.
    const ledger = tempLedger([{ text: 'real open work', done: false }]);
    const r = spawnSync('node', [CONTINUATION_GATE], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, RUVNET_WORK_LEDGER: ledger, RUVNET_CONTINUATION_COOLDOWN_MS: '0' },
      timeout: 15000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout ?? '').toBe('');   // no session_id → not a confirmed real stop → no force
  });

  it('does NOT force on an item with a MISSING timestamp — unknown age must not force forever (GPT-5.6-Sol)', () => {
    // A row without a valid `at` is now treated as STALE, not fresh — closes the TTL-bypass GPT-5.6-Sol found.
    const p = path.join(os.tmpdir(), `hc-noat-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify({ items: [{ text: 'no timestamp', done: false }] }));  // NO `at`
    const r = fireHook('node', [CONTINUATION_GATE],
      { stop_hook_active: false, session_id: 'sess-noat' },
      { RUVNET_WORK_LEDGER: p, RUVNET_CONTINUATION_COOLDOWN_MS: '0' });
    expect(r.stdout).toBe('');   // missing/invalid `at` → stale → no force
  });

  it('stays silent when nothing is outstanding — a guard that always fires carries no information', () => {
    const ledger = tempLedger([{ text: 'all done', done: true }]);
    const r = fireHook('node', [CONTINUATION_GATE],
      { stop_hook_active: false, session_id: 'sess-empty' },
      { RUVNET_WORK_LEDGER: ledger });
    expect(r.stdout).toBe('');
  });
});

describe('lesson dispatcher — Stop must not force a continuation', () => {
  it('produces NOTHING at Stop (continuation-gate owns that boundary)', () => {
    const r = fireHook('bash', [LESSON_HOOKS, 'Stop'], { stop_hook_active: false, session_id: 's' });
    // Any output here re-creates the incident: additionalContext at Stop continues the turn.
    expect(r.stdout.trim()).toBe('');
    expect(r.code).toBe(0);
  });

  it('still nudges at UserPromptSubmit, with a valid envelope naming the right event', () => {
    const r = fireHook('bash', [LESSON_HOOKS, 'UserPromptSubmit'], { prompt: 'hello' });
    expect(r.code).toBe(0);
    if (r.stdout.trim()) {
      const parsed = JSON.parse(r.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    }
  });

  it('fails OPEN on a corrupt store — a gate must never break what it guards', () => {
    const r = fireHook('bash', [LESSON_HOOKS, 'PreToolUse-bash'], {},
      { RUVNET_LESSON_OPTIN: '/nonexistent/path/optin.json' });
    expect(r.code).toBe(0);
  });
});

describe('registry hygiene', () => {
  const reg = JSON.parse(fs.readFileSync(PLUGIN_HOOKS_JSON, 'utf8'));

  it('registers no command twice for the same event AND matcher', () => {
    // Grouped by (event, matcher), not by event alone. SessionStart legitimately registers the same
    // command under `startup` and `resume` — mutually exclusive matchers that can never both fire
    // for one occurrence. An earlier version of this assertion grouped by event and flagged that as
    // a defect; the assertion was wrong, not the registry. Fixing code to satisfy a wrong test is
    // how a suite starts enforcing fiction.
    const byBucket = new Map();
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        const key = `${event}::${m.matcher ?? ''}`;
        for (const h of m.hooks ?? []) {
          const list = byBucket.get(key) ?? [];
          list.push(h.command);
          byBucket.set(key, list);
        }
      }
    }
    for (const [bucket, cmds] of byBucket) {
      expect(new Set(cmds).size, `duplicate command on ${bucket}`).toBe(cmds.length);
    }
  });

  it('never wraps a hook in `2>&1` — it merges stderr into the JSON envelope and corrupts it', () => {
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        for (const h of m.hooks ?? []) {
          expect(h.command, `${event} redirects stderr into stdout`).not.toContain('2>&1');
        }
      }
    }
  });

  it('keeps every timeout in SECONDS (a millisecond value here means no timeout at all)', () => {
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        for (const h of m.hooks ?? []) {
          if (h.timeout !== undefined) {
            // 3000 read as seconds is 50 minutes — indistinguishable from unbounded.
            expect(h.timeout, `${event} timeout ${h.timeout} looks like milliseconds`).toBeLessThanOrEqual(120);
          }
        }
      }
    }
  });

  it('EVERY hook declares an explicit timeout — a missing one is Claude Code\'s 60s default on a stranger\'s prompt', () => {
    // Found live by the 2026-07-26 F5×GPT-5.6 duel (both sides, independently): the three
    // unprompted-speech registrations shipped with NO timeout, so a deadlocked producer would have
    // stalled every prompt AND every file-write for 60 seconds — 12× the /rvbc hang that already
    // burned users. The old test above only bounds timeouts that EXIST; this one refuses absence.
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        for (const h of m.hooks ?? []) {
          expect(h.timeout, `${event} "${(m.matcher || '*')}" ships WITHOUT a timeout — 60s default on a user's machine`).toBeTypeOf('number');
        }
      }
    }
  });

  it('prompt-path hooks keep a bounded host timeout with cold-start headroom', () => {
    for (const [event, cap] of [['UserPromptSubmit', 10], ['PreToolUse', 5]]) {
      for (const m of reg.hooks[event] ?? []) {
        for (const h of m.hooks ?? []) {
          expect(h.timeout, `${event} "${m.matcher}" timeout ${h.timeout}s exceeds the ${cap}s prompt-path budget`).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  /**
   * THE PACKAGING TEST — the one that would have caught a hook that never ran anywhere.
   *
   * `${CLAUDE_PLUGIN_ROOT}` is the INSTALLED plugin directory, and installation FLATTENS `plugin/`
   * to the root. So `plugin/scripts/x.sh` installs as `scripts/x.sh`, and anything referenced as
   * `${CLAUDE_PLUGIN_ROOT}/../scripts/...` points at the versions directory — outside the plugin.
   *
   * continuation-gate.mjs was registered exactly that way. It resolved fine from a dev checkout
   * (where `plugin/../scripts/` is the repo's own scripts dir) and crashed with exit 1 and a node
   * stack trace in every installed copy. It had therefore NEVER run for any user, while SECURITY.md
   * documented the outside-the-plugin path as a deliberate quirk. Documented is not working.
   *
   * This asserts every registry path exists relative to the plugin root, which is what the harness
   * substitutes. It fails on any hook that cannot be found where its own registration says it is.
   */
  it('every registered command exists relative to the plugin root (packaged layout)', () => {
    const pluginRoot = path.join(ROOT, 'plugin');
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        for (const h of m.hooks ?? []) {
          const match = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"\s]*)/);
          if (!match) continue;
          const resolved = path.join(pluginRoot, match[1]);
          expect(
            resolved.startsWith(pluginRoot),
            `${event}: ${h.command} escapes the plugin root — it will not exist once installed`,
          ).toBe(true);
          expect(fs.existsSync(resolved), `${event}: missing file ${resolved}`).toBe(true);
        }
      }
    }
  });

  it('has exactly one hook registered on Stop', () => {
    const stopCmds = (reg.hooks.Stop ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command));
    expect(stopCmds.length).toBe(1);
  });

  /**
   * THE FAILSAFE CONTRACT — the belt to the packaging test's braces.
   *
   * The packaging test above proves a registered path EXISTS today. This proves that even when a
   * hook fails anyway — a bad path that slips through, a node crash, a corrupt store, an OOM — the
   * failure cannot reach the user's screen. Those are different guarantees, and the 2026-07-22
   * incident needed both: the Stop hook had the wrong path AND no failsafe, so every turn surfaced
   * a node stack trace. Fixing only the path would have left the class alive for the next mistake.
   *
   * `|| true` forces exit 0 no matter what the body does. For an ADVISORY hook that is always
   * correct: its whole job is to inform, and an informational hook that can break a turn is a net
   * negative. Claude Code reads hooks.json ONCE at session start, so a shipped mistake here keeps
   * running in every already-open session until each user restarts — it cannot be hotfixed. That
   * un-recallability is exactly why this belongs in a gate and not in a review checklist.
   *
   * The four BLOCKING hooks are the deliberate exception and are named explicitly, never inferred:
   * their exit codes ARE their contract (see hooks.json `_note` — mode:'blocking' in the shim's
   * dispatch table). `|| true` on those would silently disarm every wall in the product, so the
   * assertion is two-sided: advisory hooks MUST have it, blocking hooks MUST NOT. A one-sided test
   * would pass on a registry that had disarmed all three.
   *
   * THE LIST IS FOUR SHIM-DISPATCHED WALLS, and the fourth is `unprompted-speech` (ADR-040 /
   * DDD-0004). Until the 4.0 reroute the fourth entry was `lesson-hooks.sh` — a bare producer wired
   * straight into hooks.json that was blocking-capable by DESIGN (`lesson-hooks.sh:134` is
   * `[ "$CODE" -eq 2 ] && exit 2`). That bare wiring is now GONE: the unprompted producers
   * (anticipate + lesson-hooks) are spawned in candidate mode by `unprompted-runtime.mjs`, and the
   * ONLY thing hooks.json points at for them is `hook-shim.mjs unprompted-speech <CCEvent>`, a
   * mode:'blocking' entry in the shim's table. So the opted-in lesson refusal (exit 2) still
   * propagates — but through the runtime, unlike route-dispatch's host-limited audit, which is why
   * unprompted-speech joins the other three here and `lesson-hooks.sh` leaves (leaving it on the list
   * would be a STALE exemption — it is no longer registered — and the assertion below now proves that).
   *
   * unprompted-speech needs no `|| true` for the same reason the other three don't and MUST NOT have
   * one: the runtime fails toward SILENCE internally on every non-deliberate path (unknown event → 0,
   * no producers → 0, rogue raw bytes → 0, invalid candidate → 0), and exit 2 is reachable only from a
   * real, user-opted-in lesson block — proven at the real door by
   * tests/integration/unprompted-speech-registry.test.mjs. Unguarded at the registry, defensive on
   * the inside — the correct shape for a blocking hook. A `|| true` here would silently disarm every
   * opted-in refusal, the exact disarm the next assertion exists to prevent.
   */
  /**
   * THE FIFTH WALL (ADR-054 §3): `protect-state`. It is on this list for exactly the reason the four
   * above are — its exit code IS its contract. It refuses an agent Write/Edit to the two files that
   * record the user's own choice (the brain on/off sentinel, and the settings mirror plus its
   * backups and lock). `|| true` on it would turn "the model may not switch the brain back on" from
   * a wall into a suggestion, which is the state the duel's finding says does not hold.
   *
   * It is also the one hook in the registry whose offBehavior is 'run' *because* it protects OFF: a
   * consent guard that switched itself off when the user switched the brain off would guard nothing
   * at the only moment it is needed.
   */
  const BLOCKING = Object.freeze(['design-wall', 'unprompted-speech', 'protect-state']);
  const isBlocking = (cmd) => BLOCKING.some((b) => cmd.includes(b));

  it('gives every ADVISORY hook a `|| true` failsafe — a hook error must never reach the user', () => {
    const offenders = [];
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        for (const h of m.hooks ?? []) {
          if (isBlocking(h.command)) continue;
          if (!h.command.includes('|| true')) offenders.push(`${event}: ${h.command}`);
        }
      }
    }
    expect(
      offenders,
      `advisory hook(s) with no failsafe — a crash here surfaces a stack trace to the user every turn:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('leaves the BLOCKING hooks unguarded — `|| true` there would disarm every wall', () => {
    const disarmed = [];
    for (const [event, entries] of Object.entries(reg.hooks)) {
      for (const m of entries) {
        for (const h of m.hooks ?? []) {
          if (!isBlocking(h.command)) continue;
          if (h.command.includes('|| true')) disarmed.push(`${event}: ${h.command}`);
        }
      }
    }
    expect(disarmed, `blocking hook(s) disarmed by a failsafe:\n  ${disarmed.join('\n  ')}`).toEqual([]);
    // And the exemption list must not rot into fiction: every name on it is really registered.
    const all = Object.values(reg.hooks).flatMap((es) => es.flatMap((m) => (m.hooks ?? []).map((h) => h.command)));
    for (const b of BLOCKING) {
      expect(all.some((c) => c.includes(b)), `${b} is exempted but not registered — stale exemption`).toBe(true);
    }
  });
});
