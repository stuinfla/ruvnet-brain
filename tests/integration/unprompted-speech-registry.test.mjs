/**
 * unprompted-speech-registry.test.mjs — the four break-the-guard tests that hold ADR-040 / DDD-0004
 * to its word, tested at the PROCESS boundary (spawn the runtime, JSON on stdin, streams kept apart),
 * never by importing it — because the whole point of the seam is which BYTES reach which stream, and
 * importing a module cannot observe that.
 *
 * WHY THIS FILE EXISTS. Until the 4.0 reroute the unprompted producers were wired BARE into
 * hooks.json: `bash anticipate.sh || true` and `bash lesson-hooks.sh <event>`, each writing user-
 * facing bytes straight to the terminal. DDD-0004 named that a protocol violation and ADR-040
 * introduced ONE runtime — plugin/scripts/unprompted-runtime.mjs — as the SOLE writer of those bytes.
 * DDD-0004 v1.1.0 claimed the seam was "proven by a registry test" while naming a test that did not
 * exist. This is that test. It is the gate ADR-040 stays "Accepted, not Implemented" until it passes.
 *
 * EVERY test here proves its invariant by BREAKING what it guards and watching the guard fire — a
 * test that cannot go red on broken code is not a test. Assertions bound MAGNITUDE (byte-exact
 * stdout === "", exit code === 2), never mere direction, and every measurement crosses a real process
 * boundary.
 *
 * THE CONTRACT (from unprompted-runtime.mjs's own header, verified against it, not recalled):
 *   advisory → exit 0, stdout = {"hookSpecificOutput":{"hookEventName","additionalContext"}}
 *   block    → exit 2, reason on stderr, stdout byte-EMPTY (a refusal is never swallowed)
 *   advocacy → honours the dial (off ⇒ drop) AND the DismissalLedger (dismissed ⇒ drop)
 *   lesson   → NEVER the dial; its own frequency cap + blocking opt-in
 *   alarm    → always delivered
 *   raw bytes / invalid candidate on the advisory path → silently dropped (nothing reaches the user)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_PROJECT = resolveProjectStore({ projectDir: ROOT }).projectRoot;
const RUNTIME = path.join(ROOT, 'plugin', 'scripts', 'unprompted-runtime.mjs');
const LESSON_HOOKS = path.join(ROOT, 'plugin', 'scripts', 'lesson-hooks.sh');
const HOOKS_JSON = path.join(ROOT, 'plugin', 'hooks', 'hooks.json');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-registry-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Fire the runtime exactly as hook-shim.mjs dispatches it: `node runtime <CCEvent>`, JSON on stdin,
 *  the three harness-observed channels (code, stdout, stderr) kept strictly apart. */
function fireRuntime(event, { producers, env = {}, payload, runtime = RUNTIME } = {}) {
  const r = spawnSync('node', [runtime, event], {
    input: JSON.stringify(payload ?? { prompt: 'a prompt long enough to look like a real goal statement', session_id: 's1' }),
    encoding: 'utf8',
    // TIMEOUT ORDERING (2026-07-27): the OUTER spawn timeout must exceed the INNER producer
    // deadline, or the outer SIGKILL lands first and the test sees EMPTY stdout — which reads as
    // 'the runtime chose silence' when it actually means 'we killed it mid-sentence'. It was
    // inverted here (outer 20000 < inner 30000), and integration-linux went red on a DIFFERENT
    // test each run — the tell that it was load, not logic. macOS never reproduced it.
    // Inner is now 8000: a `/bin/bash printf` needs milliseconds, so 8s is enormous headroom even
    // on a saturated runner, and it lets the runtime's OWN timeout handling fire and report
    // instead of dying to an external kill. A guard below pins outer > inner.
    timeout: 45000,
    env: {
      ...process.env,
      // The runtime gives ALL producers ONE 4s global deadline and then FAILS CLOSED — a producer
      // that misses it is killed and its output discarded (unprompted-runtime.mjs:91,163-180). That
      // is correct product behavior and is deliberately not weakened here; what is wrong is running
      // the assertions under it, because spawning bash inside a saturated 108-file suite regularly
      // costs more than 4s of wall clock.
      //
      // The visible symptom was one flaky failure: the single test asserting DELIVERY went red in 2
      // of 3 full-suite runs while passing 5 of 5 alone. The real damage was silent and larger — a
      // timeout yields exactly `code 0, stdout ''`, which is byte-identical to a correct drop, so
      // the EIGHT tests asserting `stdout === ''` passed under load no matter what the drop logic
      // did. Eight assertions that cannot fail on broken code are not tests, and they were the ones
      // guarding the "raw bytes never reach the user" protocol rule.
      //
      // A generous deadline restores the meaning of both halves. The 4s default still ships; only
      // the measurement environment changes, which is the one thing that was actually broken.
      RUVNET_UNPROMPTED_TIMEOUT_MS: '25000',
      ...(producers ? { RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify(producers) } : {}),
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A tiny candidate emitter: prints whatever candidate JSON (or raw bytes) it is handed via env, once
 *  per line. This IS a producer as far as the runtime is concerned — spawned captured, RUVNET_EMIT_
 *  CANDIDATES=1 set — so it exercises the real parse/policy/deliver path without a real detector. */
function emitter(name = 'emit.sh') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/bash\nprintf \'%s\\n\' "$CANDIDATE_LINE"\n');
  fs.chmodSync(p, 0o755);
  return { argv: ['/bin/bash', p], feedStdin: true };
}
const seam = (name) => [emitter(name)];

/** A versioned settings envelope in the shape user-settings.saveSettings() actually writes — the ONLY
 *  shape loadSettings() reads (it validates `parsed.settings`, so a bare {advocacy} is INVISIBLE). */
function writeSettings(advocacy) {
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, JSON.stringify({
    version: 1, updated: '2026-07-23T00:00:00Z',
    settings: { learningScope: 'project', advocacy, autoApply: false, newProjectDefaults: false },
  }));
  return p;
}

/** Append-only outcome rows, written directly as JSONL — the exact on-disk shape advocacy-outcomes.mjs
 *  loadOutcomes() reads (position-ordered; the last DISMISSED is `lastDismissal`). */
function writeLedger(rows) {
  const p = path.join(dir, 'advocacy-outcomes.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify({
    v: 1, id: r.id, action: r.action, at: r.at ?? '2026-07-23T00:00:00Z',
    project: r.project ?? 'p', severity: r.severity ?? null, stateHash: r.stateHash ?? null, scope: r.scope ?? null,
  })).join('\n') + '\n');
  return p;
}
function ledgerRows(file, id) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      .map((s) => JSON.parse(s)).filter((r) => r.id === id);
  } catch { return []; }
}

const advocacyCandidate = (over = {}) => JSON.stringify({
  channel: 'advocacy', effect: 'advisory', hookEventName: 'UserPromptSubmit',
  copy: 'FIXTURE ADVOCACY: "Vector Cache" is installed and OFF and serves this turn.',
  findingId: 'fixture-vector-cache', severity: 'high', observationHash: 'hashA', ...over,
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 1. CLOSED WORLD — every unprompted producer in the REAL hooks.json routes through the runtime, and a
//    bare unprompted line fails the validator. (Non-negotiable invariant #4.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('closed world: the real hooks.json routes every unprompted producer through the runtime', () => {
  // The unprompted producers are reached ONLY via the runtime; the runtime is reached ONLY via the
  // shim. So the rule that encodes "the runtime is the sole writer" is: (a) no known producer script is
  // invoked directly anywhere, and (b) at any unprompted-bearing event every command dispatches through
  // hook-shim.mjs. A bare `bash rogue.sh || true` fails (b); a re-added bare producer fails both.
  const KNOWN_PRODUCERS = ['anticipate.sh', 'lesson-hooks.sh'];
  const UNPROMPTED_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse']);

  function violations(hooks) {
    const v = [];
    let hasRuntimeRoute = false;
    for (const [event, entries] of Object.entries(hooks.hooks || {})) {
      for (const m of entries || []) {
        for (const h of m.hooks || []) {
          const cmd = h.command || '';
          for (const p of KNOWN_PRODUCERS) {
            if (cmd.includes(p)) v.push(`${event}: producer "${p}" invoked outside the runtime seam → ${cmd}`);
          }
          if (cmd.includes('unprompted-speech')) hasRuntimeRoute = true;
          if (UNPROMPTED_EVENTS.has(event) && !cmd.includes('hook-shim.mjs')) {
            v.push(`${event}: command bypasses hook-shim.mjs (the runtime seam) → ${cmd}`);
          }
        }
      }
    }
    if (!hasRuntimeRoute) v.push('no unprompted-speech route is registered — the runtime is wired to nothing');
    return v;
  }

  const realHooks = () => JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));

  it('the REAL hooks.json passes — no bare producer, every unprompted command through the shim', () => {
    expect(violations(realHooks())).toEqual([]);
  });

  it('an unprompted-speech route IS registered for each event that used to carry a bare producer', () => {
    const routes = Object.entries(realHooks().hooks).flatMap(([event, es]) =>
      es.flatMap((m) => (m.hooks || []).map((h) => h.command))
        .filter((c) => c.includes('unprompted-speech'))
        .map((c) => `${event}::${c.split('unprompted-speech')[1].trim()}`));
    // UserPromptSubmit is the ONE unprompted route registered in hooks.json, and this assertion is
    // the whole point of this file: without it the runtime is wired to nothing and every producer
    // behind it — anticipate, the recommendation route, the lesson gate — is dead code that tests
    // green through the RUVNET_UNPROMPTED_PRODUCERS seam.
    expect(routes).toContain('UserPromptSubmit::UserPromptSubmit');

    // THE PreToolUse EXPECTATION, AND WHY IT IS NOT A hooks.json ROUTE.
    //
    // Two separate things happened to PreToolUse and it is easy to read them as one. ADR-067 moved
    // the two PreToolUse speech routes BEHIND decision-gate, which spawns unprompted-runtime.mjs
    // with the same sub-event tokens. Then 4.3.17 retired the whole legacy interceptor collection —
    // roughly 34 hooks — after they were measured colliding with one another, leaving exactly two
    // permitted automatic handlers (SessionStart restore, guarded Stop) plus this UserPromptSubmit
    // route; plugin/scripts/continuity-hook-policy.mjs is that allowlist, and bin/install.mjs fails
    // the build on anything outside it.
    //
    // So there is deliberately NO `PreToolUse::PreToolUse-*` entry to assert here, and adding one
    // would fail hooks:check. What survives the retirement is the ROUTE INSIDE decision-gate, and
    // that is what the three assertions below pin: if someone deletes the gate's call into the
    // runtime, PreToolUse speech would silently escape the chokepoint rather than stop existing.
    const gate = fs.readFileSync(path.join(ROOT, 'plugin/scripts/decision-gate.mjs'), 'utf8');
    expect(gate, 'the gate must still route PreToolUse speech through the runtime')
      .toMatch(/unprompted-runtime\.mjs/);
    expect(gate).toMatch(/PreToolUse-bash/);
    expect(gate).toMatch(/PreToolUse-write/);
    // CORRECTED 2026-09-12: this pinned `PreToolUse` undefined, true only through 4.3.17. Since
    // ADR-0012/067 (decision-gate's write route, registered on Claude+Codex today), PreToolUse is
    // legitimately populated — that registration is the ONE process allowed to block a write, and it
    // is unrelated to unprompted speech. The real intent this line protects — no stray
    // speech-shaped hook reappears on PreToolUse — survives by pinning the registration to exactly
    // decision-gate's known-safe write matcher, not to emptiness.
    const preToolUse = realHooks().hooks.PreToolUse;
    // Observational capture also runs here; it must not become a second speech writer.
    expect(preToolUse).toHaveLength(2);
    const writeGate = preToolUse.find((entry) => entry.matcher === '^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$');
    expect(writeGate).toBeDefined();
    for (const entry of preToolUse) for (const hook of entry.hooks) {
      expect(hook.command, 'only the gate and observational capture may run here')
        .toMatch(/hook-shim\.mjs.*(?:decision-gate write|session-snapshot PreToolUse)/);
    }
  });

  it('BREAK IT: a bare `bash rogue-emitter.sh || true` unprompted line MUST fail the validator', () => {
    const bad = realHooks();
    bad.hooks.UserPromptSubmit.push({
      matcher: '*',
      hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/rogue-emitter.sh" || true' }],
    });
    const v = violations(bad);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join('\n')).toMatch(/bypasses hook-shim\.mjs/);
  });

  it('BREAK IT: re-adding a bare `bash anticipate.sh` line fails on BOTH the producer AND the bypass rule', () => {
    const bad = realHooks();
    bad.hooks.UserPromptSubmit.push({
      matcher: '*',
      hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/anticipate.sh" || true' }],
    });
    const v = violations(bad).join('\n');
    expect(v).toMatch(/producer "anticipate\.sh" invoked outside the runtime seam/);
    expect(v).toMatch(/bypasses hook-shim\.mjs/);
  });

  it('the validator is not vacuous — it distinguishes the two files (real passes, mutated fails)', () => {
    const bad = realHooks();
    bad.hooks.UserPromptSubmit.push({ matcher: '*', hooks: [{ type: 'command', command: 'bash /tmp/x.sh || true' }] });
    expect(violations(realHooks())).toEqual([]);          // real: clean
    expect(violations(bad).length).toBeGreaterThan(0);    // mutated: dirty
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 2. ADVOCACY DIAL — off is byte-exact silent; all speaks. (Non-negotiable invariant #2.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('advocacy channel: the dial is enforced centrally on the candidate', () => {
  it('advocacy=off → an advocacy candidate yields exit 0 and byte-EXACT stdout === "" (INV-2)', () => {
    const outcomes = path.join(dir, 'advocacy-outcomes.jsonl');   // never created if dropped before the ledger
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: {
        CANDIDATE_LINE: advocacyCandidate(),
        RUVNET_SETTINGS_FILE: writeSettings('off'),
        RUVNET_ADVOCACY_OUTCOMES: outcomes,
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');                       // magnitude: zero bytes, not "less"
    expect(r.stderr).toBe('');
    // And the denominator is NOT recorded — off drops before the ledger is ever touched.
    expect(ledgerRows(outcomes, 'fixture-vector-cache')).toEqual([]);
  });

  it('TEETH: the SAME candidate at advocacy=all → a non-empty envelope carrying the copy, exit 0', () => {
    const outcomes = path.join(dir, 'advocacy-outcomes.jsonl');
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: {
        CANDIDATE_LINE: advocacyCandidate(),
        RUVNET_SETTINGS_FILE: writeSettings('all'),
        RUVNET_ADVOCACY_OUTCOMES: outcomes,     // fresh → never offered → shouldStillOffer true
      },
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);            // throws if the envelope is malformed
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Vector Cache');
    // Delivered ⇒ the runtime records the OFFERED denominator centrally (moved out of anticipate.sh).
    const rows = ledgerRows(outcomes, 'fixture-vector-cache');
    expect(rows.some((x) => x.action === 'offered')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 3. DISMISSAL LEDGER — a dismissed finding is silent; a worse observation re-opens it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('advocacy channel: the DismissalLedger is enforced centrally, with the state-change reprieve', () => {
  // Two explicit declines are an absolute durable answer, regardless of severity/state.
  const spent = () => writeLedger([
    { id: 'fixture-vector-cache', action: 'offered', severity: 'high', stateHash: 'hashA' },
    { id: 'fixture-vector-cache', action: 'dismissed', severity: 'high', stateHash: 'hashA' },
    { id: 'fixture-vector-cache', action: 'dismissed', severity: 'high', stateHash: 'hashA' },
  ]);

  it('a dismissed finding + the SAME observationHash → silence (exit 0, stdout === "")', () => {
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: {
        CANDIDATE_LINE: advocacyCandidate({ observationHash: 'hashA' }),
        RUVNET_SETTINGS_FILE: writeSettings('all'),   // dial is ON — the LEDGER is what silences it
        RUVNET_ADVOCACY_OUTCOMES: spent(),
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('TEETH: two declines stay silent even when the observation changes)', () => {
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: {
        CANDIDATE_LINE: advocacyCandidate({ observationHash: 'hashB' }),   // the state changed
        RUVNET_SETTINGS_FILE: writeSettings('all'),
        RUVNET_ADVOCACY_OUTCOMES: spent(),
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('before the two-decline cap, changed evidence may reopen an exhausted weighted budget', () => {
    const history = writeLedger([
      { id: 'fixture-vector-cache', action: 'offered', severity: 'high', stateHash: 'hashA' },
      { id: 'fixture-vector-cache', action: 'dismissed', severity: 'high', stateHash: 'hashA' },
      ...Array.from({ length: 10 }, () => ({ id: 'fixture-vector-cache', action: 'ignored', severity: 'high', stateHash: 'hashA' })),
    ]);
    const r = fireRuntime('UserPromptSubmit', { producers: seam(), env: {
      CANDIDATE_LINE: advocacyCandidate({ observationHash: 'hashB' }),
      RUVNET_SETTINGS_FILE: writeSettings('all'), RUVNET_ADVOCACY_OUTCOMES: history,
    } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('Vector Cache');
  });

  it('an advocacy candidate with NO findingId is dropped (malformed → cannot be ledgered → silence)', () => {
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: {
        CANDIDATE_LINE: advocacyCandidate({ findingId: undefined }),
        RUVNET_SETTINGS_FILE: writeSettings('all'),
        RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'o.jsonl'),
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 4. LESSON CHANNEL — never the dial; its own frequency cap; opted-in block still refuses.
//    (Non-negotiable invariant #1.) Uses the REAL producer (lesson-hooks.sh → lesson-gate.mjs).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('lesson channel: the advocacy dial does NOT govern it (a ratified lesson is the user\'s own words)', () => {
  const realLessonProducer = [{ argv: ['/bin/bash', LESSON_HOOKS, 'UserPromptSubmit'], feedStdin: true }];

  // A pure ADVISORY lesson scoped to this exact canonical project identity.
  const advisoryLesson = {
    id: 'ADV-report-status-honestly',
    statement: 'Report status derived from a verifiable artifact, never asserted.',
    trigger: 'report-status', enforcement: 'inject', origin: 'user-stated', status: 'ratified',
    evidence: [{ observed: 'you said: prove it, do not claim it' }],
    projects: [FIXTURE_PROJECT], repeatCount: 12,
  };
  // A BLOCK lesson: user-stated, ratified, carries a check — and the opt-in file names its id.
  const blockLesson = {
    id: 'BLK-verify-capable-channel',
    statement: 'Verify through a channel capable of observing the change before claiming it works.',
    trigger: 'report-status', enforcement: 'block', origin: 'user-stated', status: 'ratified',
    check: 'a verification command ran against the real path',
    evidence: [{ observed: 'you said: the success check used a read-only connection' }],
    projects: [FIXTURE_PROJECT], repeatCount: 25,
  };

  function lessonEnv(lessons, { optIn = [], maxShows, gateState } = {}) {
    const store = path.join(dir, 'lessons.json');
    const optin = path.join(dir, 'blocking-optin.json');
    fs.writeFileSync(store, JSON.stringify({ version: 1, lessons }));
    fs.writeFileSync(optin, JSON.stringify({ version: 1, blocking: optIn }));
    return {
      RUVNET_LESSON_STORE: store,
      RUVNET_LESSON_OPTIN: optin,
      RUVNET_LESSON_GATE_STATE: gateState ?? path.join(dir, 'gate-state.json'),
      ...(maxShows ? { RUVNET_LESSON_MAX_SHOWS: String(maxShows) } : {}),
      // dial OFF, to prove the lesson channel ignores it
      RUVNET_SETTINGS_FILE: writeSettings('off'),
    };
  }

  it('a lesson candidate at advocacy=off STILL appears — then goes silent past RUVNET_LESSON_MAX_SHOWS', () => {
    const gateState = path.join(dir, 'gate-state.json');
    const env = lessonEnv([advisoryLesson], { maxShows: 1, gateState });
    const payload = { prompt: 'give me a long status update about where the build actually is', session_id: 'cap-sess' };

    // Fire 1 — dial is OFF, yet the lesson is delivered as an advisory envelope.
    const first = fireRuntime('UserPromptSubmit', { producers: realLessonProducer, env, payload });
    expect(first.code).toBe(0);
    expect(first.stdout).not.toBe('');
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain('Report status');

    // Fire 2 — same session, cap already spent (MAX_SHOWS=1) → the producer emits nothing → silence.
    const second = fireRuntime('UserPromptSubmit', { producers: realLessonProducer, env, payload });
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
  });

  it('an OPTED-IN blocking lesson → exit 2, byte-EMPTY stdout, reason on stderr (INV-1, never swallowed)', () => {
    const env = lessonEnv([blockLesson], { optIn: ['BLK-verify-capable-channel'] });
    const r = fireRuntime('UserPromptSubmit', {
      producers: realLessonProducer, env,
      payload: { prompt: 'let me report the current status of this work now', session_id: 'blk-sess' },
    });
    expect(r.code).toBe(2);                 // magnitude: the exact blocking code, not merely non-zero
    expect(r.stdout).toBe('');              // a refusal writes ZERO bytes to the stream exit 2 ignores
    expect(r.stderr.trim().length).toBeGreaterThan(0);
    expect(r.stderr).toMatch(/BLOCKED/);
  });

  it('the SAME block lesson WITHOUT the opt-in → advisory only (exit 0) — consent is necessary', () => {
    const env = lessonEnv([blockLesson], { optIn: [] });   // block-capable, not opted in
    const r = fireRuntime('UserPromptSubmit', {
      producers: realLessonProducer, env,
      payload: { prompt: 'let me report the current status of this work now', session_id: 'noopt-sess' },
    });
    expect(r.code).toBe(0);                 // no consent ⇒ no refusal
    expect(r.stdout).not.toBe('');          // still shown, as a nudge
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 5. CLOSED-WORLD, FUNCTIONALLY — the runtime's BUILT-IN registry (no test seam) spawns the REAL
//    producers, so the reroute is not merely static. The real lesson producer flows a candidate.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('closed world, functionally: the built-in registry reaches the real producers', () => {
  it('UserPromptSubmit with NO test seam → the real lesson producer delivers (dial off; anticipate stays quiet)', () => {
    const store = path.join(dir, 'lessons.json');
    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      lessons: [{
        id: 'ADV-builtin-registry',
        statement: 'The built-in registry wires the real lesson producer, not a fixture.',
        trigger: 'report-status', enforcement: 'inject', origin: 'user-stated', status: 'ratified',
        evidence: [{ observed: 'you said: prove the wiring end to end' }],
        projects: [FIXTURE_PROJECT], repeatCount: 9,
      }],
    }));
    const r = fireRuntime('UserPromptSubmit', {
      // NO `producers` → BUILTIN_REGISTRY drives it: [anticipate, lesson('UserPromptSubmit')].
      env: {
        RUVNET_LESSON_STORE: store,
        RUVNET_LESSON_OPTIN: path.join(dir, 'no-optin.json'),
        RUVNET_LESSON_GATE_STATE: path.join(dir, 'gate.json'),
        RUVNET_SETTINGS_FILE: writeSettings('off'),   // silences anticipate → only the lesson can speak
        RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'o.jsonl'),
      },
      payload: { prompt: 'report the real status of the wiring work in this project', session_id: 'builtin-sess' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toBe('');
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('built-in registry');
  });

  // ── THE RECOMMENDATION ROUTE, THROUGH THE REAL REGISTRY ───────────────────────────────────────
  // advocacy-route.mjs is a producer like any other: it is reached ONLY through BUILTIN_REGISTRY and
  // it writes ZERO bytes of its own. These two cases are the ones the 2026-09-10 host test measured
  // and the two negative controls that must stay silent — asserted here at the PROCESS boundary,
  // because "which bytes reached which stream" cannot be observed by importing a module.
  //
  // The candidate's `copy` is an INSTRUCTION TO THE MODEL, not a user-facing sentence: a
  // UserPromptSubmit hook's stdout becomes `additionalContext` in the model's window. So what this
  // proves is CANDIDATE EMITTED AND DELIVERED. Whether the user ever sees a sentence is the model's
  // behaviour and is measured separately, in a real-host run.
  const routeEnv = (dir) => ({
    RUVNET_SETTINGS_FILE: null,           // filled by the caller — writeSettings needs `dir`
    RUVNET_ADVOCACY_ROUTE_STATE: path.join(dir, 'route-state.json'),
    RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'route-outcomes.jsonl'),
    RUVNET_LESSON_STORE: path.join(dir, 'no-lessons.json'),
    RUVNET_LESSON_OPTIN: path.join(dir, 'no-optin.json'),
    RUVNET_LESSON_GATE_STATE: path.join(dir, 'route-gate.json'),
  });

  it('an ordinary quality-gates request → the real registry delivers a fitting recommendation', () => {
    const env = { ...routeEnv(dir), RUVNET_SETTINGS_FILE: writeSettings('all') };
    const r = fireRuntime('UserPromptSubmit', {
      // NO `producers` → BUILTIN_REGISTRY drives it, so this exercises the SHIPPED wiring.
      env,
      payload: {
        prompt: 'tests are flaky and we don\'t know what\'s untested — trustworthy coverage and real quality gates',
        session_id: 'reco-sess',
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout, 'the recommendation route emitted nothing through the real registry').not.toBe('');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Consider agentic-qe');
    expect(ctx).toMatch(/aqe coverage --gaps --risk/);          // a verified next action, not a guess
    expect(ctx).toMatch(/tell the user in ONE sentence/);        // addressed to the model, as designed
    // Delivered ⇒ the runtime recorded the OFFERED denominator centrally, under the namespaced id.
    const rows = ledgerRows(path.join(dir, 'route-outcomes.jsonl'), 'recommend:agentic-qe');
    expect(rows.some((x) => x.action === 'offered')).toBe(true);
  });

  it('BREAK IT: a negative control (an off-by-one bug fix) → byte-EXACT silence from the same wiring', () => {
    const env = { ...routeEnv(dir), RUVNET_SETTINGS_FILE: writeSettings('all') };
    const r = fireRuntime('UserPromptSubmit', {
      env,
      payload: { prompt: 'range(1,5) should include 5 — find the bug and the exact fix', session_id: 'neg-sess' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');   // magnitude: zero bytes. A recommender that pushes here is the nag.
    expect(r.stderr).toBe('');
    expect(fs.existsSync(path.join(dir, 'route-outcomes.jsonl'))).toBe(false);
  });

  it('advocacy=off silences the recommendation route entirely, through the real registry', () => {
    const env = { ...routeEnv(dir), RUVNET_SETTINGS_FILE: writeSettings('off') };
    const r = fireRuntime('UserPromptSubmit', {
      env,
      payload: {
        prompt: 'tests are flaky and we don\'t know what\'s untested — trustworthy coverage and real quality gates',
        session_id: 'off-sess',
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    // And nothing was ledgered — off drops before the denominator is ever touched.
    expect(ledgerRows(path.join(dir, 'route-outcomes.jsonl'), 'recommend:agentic-qe')).toEqual([]);
  });

  it('a relevant advocacy candidate is withheld when the OFFERED receipt cannot persist', () => {
    const outcomes = path.join(dir, 'outcomes-directory');
    fs.mkdirSync(outcomes);
    const env = { ...routeEnv(dir), RUVNET_SETTINGS_FILE: writeSettings('all'), RUVNET_ADVOCACY_OUTCOMES: outcomes };
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam('persistence-failure.sh'),
      env: { ...env, CANDIDATE_LINE: advocacyCandidate() },
      payload: { prompt: 'a relevant quality gates request', session_id: 'receipt-failure' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('a standalone copied plugin payload applies an actionable lesson without a marketplace fallback', () => {
    const payloadRoot = path.join(dir, 'standalone-plugin');
    fs.cpSync(path.join(ROOT, 'plugin'), payloadRoot, { recursive: true });

    const store = path.join(dir, 'standalone-lessons.json');
    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      lessons: [{
        id: 'ADV-standalone-action',
        statement: 'Pass a memory-search query with its required query flag, not through help discovery.',
        trigger: 'assert-fact', enforcement: 'checklist', origin: 'user-stated', status: 'ratified',
        evidence: [{ observed: 'the corrected command form was independently learned twice' }],
        projects: [FIXTURE_PROJECT], repeatCount: 4,
      }],
    }));

    const r = fireRuntime('UserPromptSubmit', {
      runtime: path.join(payloadRoot, 'scripts', 'unprompted-runtime.mjs'),
      env: {
        RUVNET_CONFIG_ROOT: path.join(dir, 'standalone-config'),
        RUVNET_LESSON_STORE: store,
        RUVNET_LESSON_OPTIN: path.join(dir, 'standalone-no-optin.json'),
        RUVNET_LESSON_GATE_STATE: path.join(dir, 'standalone-gate.json'),
        RUVNET_SETTINGS_FILE: writeSettings('off'),
        RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'standalone-outcomes.jsonl'),
      },
      payload: { prompt: 'recall the known memory note with the CLI now', session_id: 'standalone-sess' },
    });

    expect(r.code).toBe(0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('required query flag');
    expect(ctx).toMatch(/apply .*correction directly to the .*requested action/i);
    expect(ctx).toMatch(/do not replace .*requested action with .*help.*discovery/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 6. ROGUE RAW BYTES — a producer that prints prose instead of candidate JSON reaches NEITHER stream
//    on the advisory path. (Non-negotiable invariant #3.) And ALARM always gets through.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('the drop rule: raw bytes are a protocol violation; alarms bypass every gate', () => {
  it('a rogue producer printing raw prose → exit 0, and NOTHING on either user stream (INV-3)', () => {
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: { CANDIDATE_LINE: 'I am raw prose a naive detector printed, not a candidate object' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');   // the parse-drop happens before any byte can reach stdout
    expect(r.stderr).toBe('');
  });

  it('a candidate with an UNKNOWN channel is dropped (advisory path stays byte-empty)', () => {
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: { CANDIDATE_LINE: JSON.stringify({ channel: 'marketing', effect: 'advisory', copy: 'buy now' }) },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('an ALARM candidate is delivered no matter the dial (a broken install must not look healthy)', () => {
    const r = fireRuntime('UserPromptSubmit', {
      producers: seam(),
      env: {
        CANDIDATE_LINE: JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'BRAIN STORE UNREADABLE', hookEventName: 'UserPromptSubmit' }),
        RUVNET_SETTINGS_FILE: writeSettings('off'),   // dial off changes nothing for an alarm
        // Every other spawn in this file passes a temp ledger; this one did not, so the alarm path
        // recorded its OFFERED row into the user's real ~/.config ledger on every run. That is how
        // fixture-shaped data reached the live outcome record (found by an outside grader
        // 2026-07-24, then caught at its source by the new under-test guard in
        // advocacy-outcomes.record()). Omitting it is now a hard failure rather than silent
        // pollution — which is exactly why this line has to be here.
        RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'o.jsonl'),
      },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('BRAIN STORE UNREADABLE');
  });
});

describe('GPT-5.6-Sol REJECT → hardened: channel binding, fail-closed producers, capped synchronous delivery', () => {
  it('BREAK IT: a producer authorised ONLY for advocacy CANNOT emit an alarm (channel binding)', () => {
    const cand = JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'SPOOFED ALARM', hookEventName: 'UserPromptSubmit' });
    const producers = [{ ...emitter('spoof.sh'), channels: ['advocacy'] }];
    const r = fireRuntime('UserPromptSubmit', { producers, env: { CANDIDATE_LINE: cand } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');   // alarm from an advocacy-only producer → dropped, nothing delivered
  });

  it('TEETH: the SAME alarm from a producer authorised for alarm IS delivered (the check is not vacuous)', () => {
    const cand = JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'REAL ALARM', hookEventName: 'UserPromptSubmit' });
    const producers = [{ ...emitter('alarm.sh'), channels: ['alarm'] }];
    const r = fireRuntime('UserPromptSubmit', { producers, env: { CANDIDATE_LINE: cand } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('REAL ALARM');
  });

  it('BREAK IT: a producer that EXITS NON-ZERO has its partial output discarded (fail-closed)', () => {
    const cand = JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'FROM A CRASHED PRODUCER', hookEventName: 'UserPromptSubmit' });
    const p = path.join(dir, 'crash.sh');
    fs.writeFileSync(p, `#!/bin/bash\nprintf '%s\\n' '${cand}'\nexit 1\n`);
    fs.chmodSync(p, 0o755);
    const producers = [{ argv: ['/bin/bash', p], feedStdin: true, channels: ['alarm'] }];
    const r = fireRuntime('UserPromptSubmit', { producers });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');   // nonzero exit → untrustworthy output → discarded, never a fragment
  });

  it('BREAK IT: a producer that HANGS past the deadline is killed, and the turn survives as silence', () => {
    // The failure this pins is not "slow" — it is a wedged producer taking the TURN with it. The
    // runtime gives all producers ONE global deadline and fails closed on a signalled child, so a
    // hang must resolve to exit 0 with byte-empty stdout, not to a timeout the host has to break.
    // Deliberately a REAL hang (sleep 30) against a short deadline, measured at the process
    // boundary: a mocked timer would prove the mock, not the kill.
    const cand = JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'FROM A WEDGED PRODUCER', hookEventName: 'UserPromptSubmit' });
    const p = path.join(dir, 'hang.sh');
    fs.writeFileSync(p, `#!/bin/bash\nprintf '%s\\n' '${cand}'\nsleep 30\n`);
    fs.chmodSync(p, 0o755);
    const started = Date.now();
    const r = fireRuntime('UserPromptSubmit', {
      producers: [{ argv: ['/bin/bash', p], feedStdin: true, channels: ['alarm'] }],
      env: { RUVNET_UNPROMPTED_TIMEOUT_MS: '1500' },   // deliberately BELOW the 45s outer spawn timeout
    });
    const elapsed = Date.now() - started;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');     // a signalled child's output is untrustworthy → discarded whole
    // MAGNITUDE, not direction: the runtime's own deadline fired, not the harness's kill 45s later.
    expect(elapsed).toBeLessThan(15000);
  });

  it('BREAK IT: a 900KB copy is CAPPED to 8192 and delivered WHOLE (size cap + synchronous write)', () => {
    const cand = JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'X'.repeat(900000), hookEventName: 'UserPromptSubmit' });
    const candFile = path.join(dir, 'big.json');
    fs.writeFileSync(candFile, cand + '\n');
    const p = path.join(dir, 'big.sh');
    fs.writeFileSync(p, `#!/bin/bash\ncat "$BIGCAND"\n`);
    fs.chmodSync(p, 0o755);
    const producers = [{ argv: ['/bin/bash', p], feedStdin: true, channels: ['alarm'] }];
    const r = fireRuntime('UserPromptSubmit', { producers, env: { BIGCAND: candFile } });
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout);   // MUST parse — the old async write truncated a big envelope mid-JSON
    expect(env.hookSpecificOutput.additionalContext.length).toBe(8192);
  });
});

// ── ORDERING GUARD (2026-07-27) ──────────────────────────────────────────────────────────────────
// The defect this pins: the outer spawn timeout was SHORTER than the inner producer deadline, so an
// external SIGKILL beat the runtime's own timeout handling and the test observed empty stdout. Empty
// stdout is a MEANINGFUL value in this suite — several cases assert byte-exact silence — so an outer
// kill can make a broken run look like a correct one. That is a test which cannot fail on broken
// code, in the one suite whose job is proving silence is deliberate.
describe('the harness cannot kill the runtime before the runtime can answer', () => {
  it('every outer spawn timeout exceeds every inner producer deadline, in BOTH advocacy suites', () => {
    const files = ['tests/integration/unprompted-speech-registry.test.mjs',
                   'tests/integration/advocacy-dial-levels.test.mjs'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const outer = [...src.matchAll(/timeout:\s*(\d+)/g)].map((m) => Number(m[1]));
      const inner = [...src.matchAll(/RUVNET_UNPROMPTED_TIMEOUT_MS:\s*'(\d+)'/g)].map((m) => Number(m[1]));
      expect(outer.length, `${f}: no outer timeout found`).toBeGreaterThan(0);
      expect(inner.length, `${f}: no inner timeout found`).toBeGreaterThan(0);
      expect(Math.min(...outer), `${f}: outer must exceed inner`).toBeGreaterThan(Math.max(...inner));
    }
  });

  // 2026-09-27, found live on a real Windows host: the test above only checks test-suite-declared
  // timeouts against each other. It says nothing about the REAL default PRODUCER_TIMEOUT_MS against
  // this hook's REAL declared timeout in hooks.json/codex-hooks.json — and those two drifted apart
  // (a stale comment assumed a 5s hook budget; the actual registration is 3s), leaving no real
  // margin once selfcheck.mjs's 80%-margin rule and real per-producer spawnSync overhead are counted.
  // This is that missing check, against the actual production values, not a test's own fixtures.
  it('the runtime\'s own default producer budget leaves real margin under its DECLARED hook timeout', () => {
    const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
    const defaultMs = Number(runtimeSrc.match(/PRODUCER_TIMEOUT_MS\s*=\s*Number\([^)]*\)\s*\|\|\s*(\d+)/)?.[1]);
    expect(defaultMs, 'could not find the default PRODUCER_TIMEOUT_MS in the runtime source').toBeGreaterThan(0);
    for (const hooksFile of [HOOKS_JSON, path.join(ROOT, 'plugin', 'hooks', 'codex-hooks.json')]) {
      const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      const declaredTimeouts = (hooks.hooks?.UserPromptSubmit || [])
        .flatMap((r) => r.hooks || [])
        .filter((h) => /unprompted-speech/.test(h.command))
        .map((h) => h.timeout)
        .filter((t) => typeof t === 'number');
      if (!declaredTimeouts.length) continue; // this host file may not register it — fine
      const declaredMs = Math.min(...declaredTimeouts) * 1000;
      const TIMEOUT_MARGIN = 0.8; // selfcheck.mjs's own rule — kept in sync here, not re-derived
      expect(defaultMs, `${path.basename(hooksFile)}: default producer budget (${defaultMs}ms) leaves `
        + `no real margin under the declared ${declaredMs}ms hook timeout at the ${TIMEOUT_MARGIN * 100}% mark, `
        + 'even before Node startup or per-producer spawn overhead')
        .toBeLessThan(declaredMs * TIMEOUT_MARGIN * 0.9); // 10% extra headroom for startup/spawn cost
    }
  });
});


describe('unavailable preferences cannot authorize optional speech', () => {
  for (const shape of ['malformed', 'future', 'unreadable']) {
    it(shape, () => {
      const settings = path.join(dir, 'unknown-settings');
      if (shape === 'unreadable') fs.mkdirSync(settings);
      else fs.writeFileSync(settings, shape === 'malformed' ? '{' : JSON.stringify({ version: 999, settings: { advocacy: 5 } }));
      const r = fireRuntime('UserPromptSubmit', {
        producers: seam('unknown-consent.sh'),
        env: { RUVNET_SETTINGS_FILE: settings, RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'fresh-outcomes'), CANDIDATE_LINE: advocacyCandidate({ copy: 'UNAUTHORIZED OFFER', findingId: 'unknown-consent' }) },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    });
  }
});


it('unreadable dismissal history cannot authorize another offer', () => {
  const outcomes = path.join(dir, 'unreadable-outcomes');
  fs.mkdirSync(outcomes);
  const r = fireRuntime('UserPromptSubmit', {
    producers: seam('unknown-ledger.sh'),
    env: { RUVNET_SETTINGS_FILE: writeSettings('all'), RUVNET_ADVOCACY_OUTCOMES: outcomes, CANDIDATE_LINE: advocacyCandidate() },
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
});


it('lesson diagnostic reports degraded context without exposing raw private bytes', () => {
  const script = path.join(dir, 'lesson-error.sh');
  fs.writeFileSync(script, '#!/bin/bash\nprintf "PRIVATE_RAW_SECRET_PATH" >&2\n');
  const r = fireRuntime('UserPromptSubmit', { producers: [{ argv: ['/bin/bash', script], channels: ['lesson'] }] });
  expect(r.code).toBe(0);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  expect(context).toContain('Learning context is incomplete');
  expect(r.stdout + r.stderr).not.toContain('PRIVATE_RAW_SECRET_PATH');
});


describe('unsupported suppression records cannot authorize an offer', () => {
  for (const row of [null, [], { id: 'fixture-vector-cache', action: 'dismissed', v: 999 }, { id: 'fixture-vector-cache', action: 'unsupported' }]) {
    it(JSON.stringify(row), () => {
      const outcomes = path.join(dir, 'corrupt-outcomes');
      fs.writeFileSync(outcomes, JSON.stringify(row) + '\n');
      const r = fireRuntime('UserPromptSubmit', { producers: seam('invalid-history.sh'),
        env: { RUVNET_SETTINGS_FILE: writeSettings('all'), RUVNET_ADVOCACY_OUTCOMES: outcomes, CANDIDATE_LINE: advocacyCandidate() } });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    });
  }
});


it('a malformed reset cannot erase a permanent dismissal', () => {
  const outcomes = writeLedger([
    { id: 'fixture-vector-cache', action: 'dismissed', scope: 'forever' },
    { id: 'fixture-vector-cache', action: 'reset', scope: 'forever' },
  ]);
  const r = fireRuntime('UserPromptSubmit', { producers: seam('bad-reset.sh'),
    env: { RUVNET_SETTINGS_FILE: writeSettings('all'), RUVNET_ADVOCACY_OUTCOMES: outcomes, CANDIDATE_LINE: advocacyCandidate() } });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
});


describe('typed whole-block advisory admission', () => {
  it('an oversized deferred offer is not recorded OFFERED and emits no budget notice to the model', () => {
    const outcomes=path.join(dir,'byte-budget-offers.jsonl');
    const candidate=JSON.parse(advocacyCandidate());candidate.copy='完整建议'.repeat(1000);
    const r=fireRuntime('UserPromptSubmit',{producers:seam(),env:{HOME:dir,XDG_CACHE_HOME:path.join(dir,'cache'),RUVNET_HOOK_CONTEXT_BUDGET:'1',RUVNET_BRAIN_METER:'0',CANDIDATE_LINE:JSON.stringify(candidate),RUVNET_SETTINGS_FILE:writeSettings('all'),RUVNET_ADVOCACY_OUTCOMES:outcomes}});
    expect(r.code).toBe(0);expect(r.stdout).toBe('');expect(r.stderr).toBe('');
    expect(ledgerRows(outcomes,'fixture-vector-cache')).toEqual([]);
  });
  it('an explicitly typed alarm remains whole despite the routine advisory cap', () => {
    const copy='Mandatory safety information. '.repeat(1000);
    const r=fireRuntime('UserPromptSubmit',{producers:seam(),env:{HOME:dir,XDG_CACHE_HOME:path.join(dir,'cache'),RUVNET_HOOK_CONTEXT_BUDGET:'1',RUVNET_BRAIN_METER:'0',CANDIDATE_LINE:JSON.stringify({channel:'alarm',effect:'advisory',copy})}});
    expect(r.code).toBe(0);expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(copy.trim());
  });
});


describe('P037 concurrent actual delivery ownership', () => {
  it('concurrent sessions that all initially observe eligible state emit and record exactly once', async () => {
    const count = 6;
    const barrier = path.join(dir,'ready'); fs.mkdirSync(barrier);
    const ledgerPath = path.join(dir,'concurrent-outcomes.jsonl');
    const wrapper = path.join(dir,'observed-ledger.mjs');
    const actual = new URL('../../plugin/scripts/advocacy-outcomes.mjs', import.meta.url).href;
    fs.writeFileSync(wrapper, `export * from ${JSON.stringify(actual)};
      import {shouldStillOffer as actualCheck} from ${JSON.stringify(actual)};
      import fs from 'node:fs';import path from 'node:path';
      let first=true;export function shouldStillOffer(...args){
        const verdict=actualCheck(...args);
        if(first){first=false;fs.writeFileSync(path.join(process.env.P037_BARRIER,String(process.pid)),'ready');
          const deadline=Date.now()+10000;while(fs.readdirSync(process.env.P037_BARRIER).length<Number(process.env.P037_CHILDREN)){
            if(Date.now()>deadline)throw new Error('concurrency barrier not reached');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
        return verdict;}`);
    const producers = seam('concurrent-emitter.sh');
    const env = { ...process.env, RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify(producers),
      RUVNET_UNPROMPTED_TIMEOUT_MS:'20000', RUVNET_UNPROMPTED_ALLOW_TEST_TIMEOUT_OVERRIDE:'1',
      RUVNET_SETTINGS_FILE:writeSettings('all'), RUVNET_ADVOCACY_OUTCOMES:ledgerPath,
      RUVNET_ADVOCACY_OUTCOMES_MODULE:wrapper, CANDIDATE_LINE:advocacyCandidate({observationHash:'same-state'}),
      P037_BARRIER:barrier, P037_CHILDREN:String(count) };
    const results = await Promise.all(Array.from({length:count},(_,i)=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[RUNTIME,'UserPromptSubmit'],{env});let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('runtime deadline'));},25000);
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
      child.stdin.end(JSON.stringify({prompt:'a real concurrent prompt with sufficient task detail',session_id:'concurrent-'+i}));
    })));
    expect(fs.readdirSync(barrier)).toHaveLength(count);
    expect(results.every(r=>r.code===0)).toBe(true);
    expect(results.filter(r=>r.stdout.trim())).toHaveLength(1);
    const rows=fs.readFileSync(ledgerPath,'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.filter(r=>r.action==='offered')).toHaveLength(1);
  },30000);
});

it('P037 RESET serializes with a paused delivery and stale owner cleanup cannot remove its successor', async () => {
  const actual = new URL('../../plugin/scripts/advocacy-outcomes.mjs', import.meta.url).href;
  const ledgerPath=path.join(dir,'reset-overlap.jsonl');const wrapper=path.join(dir,'pause-owner.mjs');
  fs.writeFileSync(wrapper,`export * from ${JSON.stringify(actual)};
    import {shouldStillOffer as check,claimOffer as claim} from ${JSON.stringify(actual)};
    import fs from 'node:fs';let calls=0;
    export function claimOffer(...args){const owned=claim(...args);fs.writeFileSync(process.env.TOKEN_FILE,JSON.stringify(owned));return owned;}
    export function shouldStillOffer(...args){const result=check(...args);if(++calls===2){
      fs.writeFileSync(process.env.READY_FILE,'ready');const until=Date.now()+10000;
      while(!fs.existsSync(process.env.GO_FILE)){if(Date.now()>until)throw Error('paused owner deadline');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return result;}`);
  const producers=seam('reset-overlap-emitter.sh');const env={...process.env,RUVNET_UNPROMPTED_PRODUCERS:JSON.stringify(producers),
    RUVNET_UNPROMPTED_TIMEOUT_MS:'25000',RUVNET_SETTINGS_FILE:writeSettings('all'),RUVNET_ADVOCACY_OUTCOMES:ledgerPath,
    RUVNET_ADVOCACY_OUTCOMES_MODULE:wrapper,CANDIDATE_LINE:advocacyCandidate({observationHash:'unchanged-reset-state'})};
  const children=[];
  const start=(label,bin=process.execPath,args=[RUNTIME,'UserPromptSubmit'],extra={})=>{
    const child=spawn(bin,args,{env:{...env,READY_FILE:path.join(dir,label+'.ready'),GO_FILE:path.join(dir,label+'.go'),TOKEN_FILE:path.join(dir,label+'.token'),...extra}});children.push(child);
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
    child.stdin.end(JSON.stringify({prompt:'review this legitimate detailed goal',session_id:label}));return {child,done};};
  const wait=async file=>{const end=Date.now()+10000;while(!fs.existsSync(file)){if(Date.now()>end)throw Error('barrier absent '+file);await new Promise(r=>setTimeout(r,5));}};
  try {
    const a=start('owner-A');await wait(path.join(dir,'owner-A.ready'));
    const resetScript=`import fs from 'node:fs';import {record,ACTIONS} from ${JSON.stringify(actual)};fs.writeFileSync(process.env.RESET_STARTED,'started');console.log(JSON.stringify(record({id:'fixture-vector-cache',action:ACTIONS.RESET},{file:process.env.RUVNET_ADVOCACY_OUTCOMES})));`;
    const reset=start('reset',process.execPath,['--input-type=module','-e',resetScript],{RESET_STARTED:path.join(dir,'reset.started')});
    await wait(path.join(dir,'reset.started'));const b=start('contender-B');
    await new Promise(r=>setTimeout(r,150));fs.writeFileSync(path.join(dir,'owner-A.go'),'go');
    const first=await a.done;const resetResult=await reset.done;expect(first.code).toBe(0);expect(JSON.parse(resetResult.stdout).ok).toBe(true);
    fs.writeFileSync(path.join(dir,'contender-B.go'),'go');await b.done;
    const beforeSuccessor=fs.readFileSync(ledgerPath,'utf8').trim().split('\n').map(JSON.parse);
    const resetIndex=beforeSuccessor.findLastIndex(r=>r.action==='reset');
    expect(beforeSuccessor.slice(resetIndex+1).filter(r=>r.action==='offered').length).toBeLessThanOrEqual(1);
    const c=start('post-reset-C');await wait(path.join(dir,'post-reset-C.ready'));
    const stale=JSON.parse(fs.readFileSync(path.join(dir,'owner-A.token'),'utf8'));
    const ao=await import('../../plugin/scripts/advocacy-outcomes.mjs');
    expect(ao.releaseClaim('fixture-vector-cache',{dir:path.join(dir,'offer-claims'),ownership:stale})).toBe(false);
    expect(fs.readdirSync(path.join(dir,'offer-claims')).filter(f=>f.endsWith('.claim'))).toHaveLength(1);
    fs.writeFileSync(path.join(dir,'post-reset-C.go'),'go');const successor=await c.done;expect(successor.code).toBe(0);
    const rows=fs.readFileSync(ledgerPath,'utf8').trim().split('\n').map(JSON.parse);const lastReset=rows.findLastIndex(r=>r.action==='reset');
    expect(lastReset).toBeGreaterThanOrEqual(0);expect(rows.slice(lastReset+1).filter(r=>r.action==='offered')).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir,'offer-claims')).filter(f=>f.endsWith('.claim'))).toHaveLength(0);
  } finally {for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');}
},30000);
