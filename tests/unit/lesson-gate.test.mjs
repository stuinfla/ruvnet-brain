/**
 * lesson-gate.test.mjs — the enforcement CONTRACT, tested at the process boundary.
 *
 * WHY THESE TESTS EXIST, and why they look the way they do.
 *
 * On 2026-07-22 this system shipped a gate that printed "⛔ BLOCKED" and then allowed the action.
 * It survived review because it had been "proven by exit code" — proven by a human running
 * `node scripts/lesson-gate.mjs` on a terminal and reading the number. That is the one caller which
 * is NOT a hook, and it was the only caller that ever looked correct.
 *
 * So every test here asserts on THREE things at once — exit code, stdout, and stderr, from a real
 * spawned process — because the bug was invisible to any test that checked fewer. The gate exited 1
 * (an error, not a refusal), wrote its reason to stdout (which exit-2 discards), and the dispatcher
 * threw the code away with `|| true`. Each layer was individually plausible. Only the combination of
 * streams and code tells the truth, which is L01 — "verify through a channel CAPABLE of observing
 * the change" — applied to the file that enforces L01.
 *
 * Nothing here mocks the gate, the store, or the shell. Temp stores, real processes, real pipes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = path.join(ROOT, 'scripts', 'lesson-gate.mjs');
const DISPATCH = path.join(ROOT, 'plugin', 'scripts', 'lesson-hooks.sh');

let dir, storePath, optInPath, gateStatePath;

/** A lesson the store will accept as blocking: user-stated, ratified, and carrying a real check.
 *  makeLesson refuses any weaker combination, so this mirrors what the live store actually holds. */
const blockLesson = (over = {}) => ({
  id: 'T01-verify-with-a-capable-channel',
  statement: 'Verify through a channel capable of observing the change before claiming it works.',
  trigger: 'claim-done',
  enforcement: 'block',
  origin: 'user-stated',
  status: 'ratified',
  check: 'a verification command ran against the real path',
  evidence: [{ observed: 'you said: the success check used a read-only connection' }],
  projects: ['alpha', 'beta', 'gamma'],
  repeatCount: 25,
  ...over,
});

function writeStore(lessons) {
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, lessons }, null, 2));
}
function writeOptIn(ids) {
  fs.writeFileSync(optInPath, JSON.stringify({ version: 1, blocking: ids }, null, 2));
}

/** Run the gate as a real process. Returns the full truth: code AND both streams, never one. */
function runGate(args, env = {}) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RUVNET_LESSON_STORE: storePath, RUVNET_LESSON_OPTIN: optInPath,
      RUVNET_LESSON_GATE_STATE: gateStatePath, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run the dispatcher the way hooks.json runs it — bash, one event argument. */
function runDispatch(event, env = {}) {
  const r = spawnSync('bash', [DISPATCH, event], {
    encoding: 'utf8',
    env: { ...process.env, RUVNET_LESSON_STORE: storePath, RUVNET_LESSON_OPTIN: optInPath,
      RUVNET_LESSON_GATE_STATE: gateStatePath, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-gate-'));
  storePath = path.join(dir, 'lessons.json');
  optInPath = path.join(dir, 'blocking-optin.json');
  gateStatePath = path.join(dir, 'gate-state.json');   // per-test → the frequency cap starts fresh, never the real home
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('canonical lesson runtime module boundaries', () => {
  test('every self-contained plugin source stays below the repository 500-line ceiling', () => {
    const files = [
      'lesson-gate.mjs',
      'lesson-command-scope.mjs',
      'lesson-presentation.mjs',
      'lesson-store.mjs',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', file), 'utf8');
      expect(source.split('\n').length, `${file} must remain under 500 lines`).toBeLessThan(500);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('a NUDGE informs and never refuses', () => {
  test('exits 0 — the action is allowed', () => {
    writeStore([blockLesson()]);
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
  });

  test('reaches the model via additionalContext, carrying the lesson and its evidence', () => {
    // The channel is verified, not assumed. Per code.claude.com/docs/en/hooks (2026-07-22):
    // "The additionalContext field passes a string from your hook into Claude's context window."
    // On exit 0, plain stdout goes to the DEBUG LOG for Stop/PreToolUse — so a nudge that is merely
    // printed reaches nobody. The JSON envelope is what makes it a nudge rather than a no-op.
    writeStore([blockLesson()]);
    const { stdout } = runGate(['--event', 'Stop', '--trigger', 'claim-done']);
    const payload = JSON.parse(stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(payload.hookSpecificOutput.additionalContext).toContain('channel capable of observing');
    expect(payload.hookSpecificOutput.additionalContext).toContain('read-only connection');
  });

  test('says out loud that it is advisory, so the model does not read it as a refusal', () => {
    writeStore([blockLesson()]);
    const { stdout } = runGate(['--event', 'Stop', '--trigger', 'claim-done']);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(/advisory/i);
  });

  test('applies an actionable correction instead of replacing the requested action with help discovery', () => {
    writeStore([blockLesson({
      id: 'T02-apply-known-command-form',
      statement: 'Pass a memory-search query with the required query flag, not as a positional phrase.',
      trigger: 'assert-fact',
      enforcement: 'checklist',
      check: 'the requested memory search runs with its query flag',
    })]);
    const { stdout } = runGate(['--event', 'UserPromptSubmit', '--trigger', 'assert-fact']);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/apply .*correction directly to the .*requested action/i);
    expect(ctx).toMatch(/do not replace .*requested action with .*help.*discovery/i);
  });

  test('truncates long evidence at a WORD boundary, never mid-word', () => {
    // The live defect: the evidence line ended "…the ris" (from "the risk"), which reads as a bug in
    // the lesson, not a length cap. A recognizable marker word is placed so that char 150 falls INSIDE
    // it: the old slice(0,150) leaked the fragment "ZZUNMISTA"; the fixed clip() drops the whole word
    // and ends on an ellipsis. This test FAILS on the pre-fix code — which is the only kind worth having.
    const head = 'x'.repeat(140) + ' ';                 // one space, at index 140
    const observed = `${head}ZZUNMISTAKABLEWORDZZ and a tail that follows well past the cap`;
    writeStore([blockLesson({ evidence: [{ observed }] })]);
    const ctx = JSON.parse(runGate(['--event', 'Stop', '--trigger', 'claim-done']).stdout)
      .hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain('ZZUNMISTA');             // no mid-word fragment (the pre-fix bug)
    expect(ctx).not.toContain('ZZUNMISTAKABLEWORDZZ');  // and not the whole straddling word either
    expect(ctx).toContain('…');                          // it announced the cut instead of hiding it
  });

  test('hookEventName names the REAL harness event, or the envelope is discarded', () => {
    // "PreToolUse-write" is our internal key. Emitting it here would produce a well-formed JSON
    // document the harness throws away — a nudge that tests green and delivers nothing.
    writeStore([blockLesson({ id: 'T02-real-tool', trigger: 'write-code' })]);
    const { stdout } = runDispatch('PreToolUse-write');
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  test('writes NOTHING to stderr — stderr on exit 0 is a dead channel, and noise there reads as an error', () => {
    writeStore([blockLesson()]);
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).stderr).toBe('');
  });

  test('emits ONE json document when an event carries several decision points', () => {
    // Stop is simultaneously report-status and claim-done. Two objects concatenated on stdout parse
    // as neither, so the whole nudge would be silently dropped by the harness.
    writeStore([
      blockLesson(),
      blockLesson({ id: 'T03-status-is-a-table', trigger: 'report-status', enforcement: 'checklist', check: null }),
    ]);
    // UserPromptSubmit, not Stop. Stop was made DELIBERATELY INERT on 2026-07-22: a non-blocking
    // nudge emitted at Stop reaches nobody (the harness surfaces stdout as context only at
    // UserPromptSubmit / SessionStart), so report-status and claim-done were moved onto
    // UserPromptSubmit where they are actually delivered. Testing Stop here would assert a channel
    // that does not exist — the same "verified through a channel incapable of observing it" error
    // this very lesson is about.
    const { stdout, code } = runDispatch('UserPromptSubmit');
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('channel capable of observing');
    expect(ctx).toContain('Verify through');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('CONSENT: a ratified block lesson is a nudge until the user says otherwise', () => {
  test('a ratified enforcement:block lesson does NOT block without opt-in', () => {
    // The reframe, in one assertion. The owner: "Nudging somebody is very fair. Forcing them through
    // a gate is not." Six ratified block lessons ship today; none of them may refuse work on their
    // own authority. Turning the broken blocks into working ones would have shipped, for the first
    // time, the product that was explicitly rejected.
    writeStore([blockLesson()]);
    const { code, stderr } = runGate(['--event', 'Stop', '--trigger', 'claim-done']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  test('absent consent file means nudge, never block — consent is never inferred from silence', () => {
    writeStore([blockLesson()]);
    expect(fs.existsSync(optInPath)).toBe(false);
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
  });

  test('the nudge tells the user blocking is available, as a choice rather than a threat', () => {
    writeStore([blockLesson()]);
    const ctx = JSON.parse(runGate(['--event', 'Stop', '--trigger', 'claim-done']).stdout)
      .hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/can REFUSE/);
    expect(ctx).toMatch(/your call/i);
    expect(ctx).toContain(optInPath);
  });

  test('opting in one lesson does not opt in any other', () => {
    writeStore([
      blockLesson(),
      blockLesson({ id: 'T04-use-the-real-tool', trigger: 'write-code' }),
    ]);
    writeOptIn(['T04-use-the-real-tool']);
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
    expect(runGate(['--event', 'PreToolUse', '--trigger', 'write-code']).code).toBe(2);
  });

  test('opt-in cannot promote a lesson the store would never let block', () => {
    // Consent is necessary, not sufficient. A checklist lesson named in the consent file stays a
    // nudge: the user consents to enforcement, they do not get to invent enforceability. Without
    // this, editing one JSON file would turn any advisory note into a wall.
    writeStore([blockLesson({ id: 'T05-soft', enforcement: 'checklist', check: null })]);
    writeOptIn(['T05-soft']);
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
  });

  test('a model-inferred lesson can never block, even if named in the consent file', () => {
    // The injection path ADR-031 exists to close. makeLesson already refuses to CONSTRUCT such a
    // lesson at enforcement:block; this asserts the gate refuses to ACT on one regardless, so a
    // future loosening upstream cannot silently open the path.
    writeStore([blockLesson({ id: 'T06-planted', origin: 'model-inferred', enforcement: 'checklist', check: null })]);
    writeOptIn(['T06-planted']);
    const { code, stderr } = runGate(['--event', 'Stop', '--trigger', 'claim-done']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('an opted-in BLOCK actually refuses', () => {
  beforeEach(() => { writeStore([blockLesson()]); writeOptIn(['T01-verify-with-a-capable-channel']); });

  test('exits 2 — the only code the harness treats as a refusal', () => {
    // Exit 1 was the original bug: the live doc says any other non-zero is "a non-blocking error...
    // Execution continues." A gate exiting 1 has not blocked anything; it has merely complained.
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(2);
  });

  test('the reason goes to STDERR, because exit 2 discards stdout', () => {
    // "Claude Code ignores stdout and any JSON in it. Instead, stderr text is fed back to Claude as
    // an error message." The original wrote 15 console.log and 0 console.error — the refusal reason
    // was sent to the one stream a refusal cannot use.
    const { stdout, stderr } = runGate(['--event', 'Stop', '--trigger', 'claim-done']);
    expect(stderr).toContain('BLOCKED');
    expect(stderr).toContain('channel capable of observing');
    expect(stdout).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the dispatcher propagates faithfully in BOTH directions', () => {
  test('propagates a block: exit 2 with the reason on stderr', () => {
    // `|| true` plus `exit 0` used to erase this. The dispatcher printed the word BLOCKED and
    // returned ALLOW — the single most misleading state the system could be in.
    writeStore([blockLesson()]);
    writeOptIn(['T01-verify-with-a-capable-channel']);
    const { code, stderr, stdout } = runDispatch('UserPromptSubmit');
    expect(code).toBe(2);
    expect(stderr).toContain('BLOCKED');
    expect(stdout).toBe('');
  });

  test('propagates a nudge: exit 0 with json on stdout', () => {
    writeStore([blockLesson()]);
    const { code, stdout, stderr } = runDispatch('UserPromptSubmit');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    // The event name must match the event the dispatcher was CALLED with — the harness keys on it,
    // and a mismatched name means the context is attached to the wrong event or silently discarded.
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });

  test('never says BLOCKED while returning 0 — the exact shipped defect', () => {
    // The regression test for the headline bug, stated as the invariant rather than the symptom:
    // saying "blocked" and allowing is a lie the product may not tell.
    //
    // THIS ASSERTION WAS WRONG ONCE, and the way it was wrong is worth keeping. It first searched
    // for the literal "⛔ BLOCKED" — a string that occurs in NEITHER version, because the header
    // renders "⚑ BLOCKED" (pennant) while "⛔" only ever prefixes an individual statement line. It
    // therefore passed against the known-broken code, which is the definition of a vacuous test:
    // green, specific-looking, and incapable of observing the failure it named. Caught only by
    // running the suite against the old implementation and noticing this one did not go red.
    writeStore([blockLesson()]);
    const { code, stdout, stderr } = runDispatch('UserPromptSubmit');
    expect(code).toBe(0);
    expect(stdout + stderr).not.toContain('BLOCKED');
  });

  test('an unmapped event stays silent and allows', () => {
    writeStore([blockLesson()]);
    writeOptIn(['T01-verify-with-a-capable-channel']);
    const { code, stdout } = runDispatch('SessionStart');
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('FAILS OPEN on malfunction — but never on a decision', () => {
  test('a corrupt store allows the action', () => {
    fs.writeFileSync(storePath, '{ not json at all');
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
    expect(runDispatch('UserPromptSubmit').code).toBe(0);
  });

  test('a missing store allows the action', () => {
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
  });

  test('an unparseable consent file downgrades to nudge, never up to block', () => {
    // Failing INTO refusal would be the worst possible direction: a typo in a config file would
    // start refusing the user's work with no way to tell why.
    writeStore([blockLesson()]);
    fs.writeFileSync(optInPath, 'nonsense{{{');
    expect(runGate(['--event', 'Stop', '--trigger', 'claim-done']).code).toBe(0);
  });

  test('no lessons at a trigger produces no output at all', () => {
    writeStore([]);
    const { code, stdout, stderr } = runGate(['--event', 'Stop', '--trigger', 'claim-done']);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('mutate-machine: narrowed to commands that PLAUSIBLY mutate outside this repo', () => {
  /**
   * WHY THIS DESCRIBE BLOCK EXISTS. An independent grader reading real session transcripts (2026-07-
   * 22/23) found L07 ("about to change something outside this repo") firing ~10x/session, VERBATIM,
   * on `ls`, `grep`, `wc`, `git status`, `git rev-parse` — read-only Bash calls with nothing outside
   * this repo to change. Root cause: plugin/scripts/lesson-hooks.sh:98 mapped `PreToolUse-bash` to
   * `--trigger mutate-machine` UNCONDITIONALLY. Not a weak keyword match — no inspection of the
   * command existed AT ALL. A true finding repeated on false triggers trains the user to ignore it,
   * which is the exact nagging ADR-030's "nudge, never force" principle exists to prevent.
   *
   * The fix: scripts/lesson-gate.mjs now takes `--command <text>` and narrows `mutate-machine` via
   * `looksLikeOutsideRepoMutation()` — an allowlist of mutating patterns anchored to command
   * position, never a substring search. Every test below asserts through `--json`, on the `inForce`
   * array of ACTUAL lesson objects — never on rendered prose — so a wording change to L07's statement
   * can never make a real regression here read as green.
   */
  const MUTATE_ID = 'L07-blast-radius-not-social-comfort';
  const mutateLesson = () => blockLesson({
    id: MUTATE_ID,
    trigger: 'mutate-machine',
    statement: 'Gate on blast radius, not on how awkward an action feels — ask if it is reversible and outward-facing.',
  });

  beforeEach(() => writeStore([mutateLesson()]));

  /** Runs the gate exactly as the dispatcher does post-fix: one trigger, one command, --json. */
  function classify(cmd) {
    const { stdout, code } = runGate(['--trigger', 'mutate-machine', '--command', cmd, '--json']);
    expect(code).toBe(0); // a nudge on an un-opted-in lesson never blocks — see the CONSENT suite above
    return JSON.parse(stdout);
  }

  describe('TEETH: the pre-fix dispatcher fired unconditionally — reproduced literally, not asserted', () => {
    test('--trigger mutate-machine with NO --command (the exact old invocation) fires regardless of intent', () => {
      // plugin/scripts/lesson-hooks.sh used to run `node lesson-gate.mjs --event PreToolUse --trigger
      // mutate-machine` with no way to name the command at all. This IS that call, byte for byte
      // (module for module) — reproducing the bug's own shape rather than asserting it happened.
      const { stdout } = runGate(['--trigger', 'mutate-machine', '--json']);
      const j = JSON.parse(stdout);
      expect(j.inForce.map((l) => l.id)).toContain(MUTATE_ID);
    });
  });

  describe('READ-ONLY commands: silent (would have fired under the old, unfiltered dispatcher above)', () => {
    for (const cmd of ['ls', 'ls -la', 'wc -l README.md', 'grep -rn "TODO" .', 'git status', 'git rev-parse HEAD', 'node test.mjs', 'npm run test']) {
      test(`"${cmd}"`, () => expect(classify(cmd).inForce).toEqual([]));
    }

    test('a read-only command that merely MENTIONS a mutating pattern stays silent — anchored to command position, never a bare substring search', () => {
      // The naive fix (search the whole string for "npm install -g" or "curl -X POST") would have
      // reintroduced false positives one substring later: a grep for the pattern, or an echo of it.
      expect(classify('grep -rn "npm install -g" .').inForce).toEqual([]);
      expect(classify('echo "curl -X POST is dangerous"').inForce).toEqual([]);
    });

    test('a compound command of only read-only segments stays silent', () => {
      expect(classify('git status; git log -1; ls').inForce).toEqual([]);
    });

    test('rm scoped INSIDE the repo stays silent — the trigger means OUTSIDE this repo, not "any deletion"', () => {
      expect(classify('rm -rf ./build').inForce).toEqual([]);
    });
  });

  describe('MUTATING commands: still fire — the fix narrows, it does not silence', () => {
    for (const cmd of ['rm -rf ~/x', 'npm install -g some-pkg', 'launchctl bootstrap system /Library/LaunchDaemons/x.plist', 'git push origin main', 'chmod 777 /etc/x', 'curl -X POST https://example.com/api']) {
      test(`"${cmd}"`, () => expect(classify(cmd).inForce.map((l) => l.id)).toContain(MUTATE_ID));
    }

    test('a compound command fires if ANY segment mutates outside the repo, even a trailing one', () => {
      expect(classify('ls -la && rm -rf ~/x').inForce.map((l) => l.id)).toContain(MUTATE_ID);
    });
  });

  describe('END-TO-END through the real dispatcher — stdin JSON, real bash process, no shortcuts', () => {
    function runDispatchBash(cmd, env = {}) {
      const r = spawnSync('bash', [DISPATCH, 'PreToolUse-bash'], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }),
        encoding: 'utf8',
        // RUVNET_LESSON_GATE_STATE isolated per-test, same as runGate/runDispatch above. Without it this
        // helper read the REAL ~/.config gate-state, and once the frequency cap (3.9.28) started counting
        // block-capable advisories too (3.9.29), repeated suite runs accumulated the fixture lesson past
        // MAX_SHOWS in the shared fallback session and this test flaked to empty stdout. A test that
        // depends on how many times the suite ran today is not a test.
        env: { ...process.env, RUVNET_LESSON_STORE: storePath, RUVNET_LESSON_OPTIN: optInPath,
          RUVNET_LESSON_GATE_STATE: gateStatePath, ...env },
      });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }

    test('a real read-only Bash call produces NOTHING on stdout', () => {
      const { stdout, code } = runDispatchBash('git rev-parse HEAD');
      expect(code).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    test('a real mutating Bash call still reaches the model via additionalContext', () => {
      const { stdout, code } = runDispatchBash('git push origin main');
      expect(code).toBe(0);
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('Gate on blast radius');
    });

    test('a malformed/empty stdin payload degrades to silence, never a crash or a false fire', () => {
      const r = spawnSync('bash', [DISPATCH, 'PreToolUse-bash'], {
        input: 'not json at all',
        encoding: 'utf8',
        env: { ...process.env, RUVNET_LESSON_STORE: storePath, RUVNET_LESSON_OPTIN: optInPath },
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? '').trim()).toBe('');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('CLI mode stays backward compatible', () => {
  test('plain text on stdout, because version-bump-gate.sh embeds it verbatim', () => {
    // plugin/scripts/version-bump-gate.sh:78 captures this stdout and appends it under
    // "── from your own lesson store ──". Emitting JSON here, or moving it to stderr, would silently
    // empty that section of the only gate in this system that genuinely works.
    writeStore([blockLesson({ id: 'T07-version', trigger: 'ship' })]);
    const { stdout, code } = runGate(['--trigger', 'ship']);
    expect(code).toBe(0);
    expect(stdout).toContain('Verify through');
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test('--json stays machine-readable and reports the consent path', () => {
    writeStore([blockLesson()]);
    const { stdout } = runGate(['--trigger', 'claim-done', '--json']);
    const j = JSON.parse(stdout);
    expect(j.blocking).toEqual([]);
    expect(j.blockCapable).toContain('T01-verify-with-a-capable-channel');
    expect(j.optInPath).toBe(optInPath);
  });

  test('no trigger prints usage and exits 0', () => {
    const { code, stdout } = runGate([]);
    expect(code).toBe(0);
    expect(stdout).toContain('--trigger');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('PER-SESSION FREQUENCY CAP: a reminder stops repeating; a refusal never does', () => {
  /** A pure-advisory (cappable) lesson — enforcement:checklist, like the T03/T05/T06 fixtures above.
   *  Neither block nor block-capable, so the frequency cap governs it. Carries a unique marker so the
   *  test can tell "shown" from "suppressed" by looking at the injected context. */
  // The statement must be a real actionable sentence (loadLessons rejects a bare token as "must say
  // what to DO, specifically"), so the marker is embedded in one. ADVMARK<x> is what the test greps for.
  const advisory = (marker) => blockLesson({
    id: `ADV-${marker}`,
    statement: `Verify the change through a capable channel before you claim ADVMARK${marker} is done.`,
    trigger: 'claim-done', enforcement: 'checklist', check: null,
  });
  const fireAdvisory = (sid, env = {}) =>
    runGate(['--event', 'PreToolUse', '--trigger', 'claim-done', '--session', sid], env);
  const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return ''; } };

  test('THE INVARIANT: an opted-in BLOCK lesson refuses EVERY time, far past the cap', () => {
    // This is the load-bearing test. The cap must never touch a refusal — if capExempt were removed,
    // the block would be suppressed after MAX_SHOWS and this loop's later iterations would exit 0.
    writeStore([blockLesson()]);                             // enforcement:block, user-stated, ratified
    writeOptIn(['T01-verify-with-a-capable-channel']);       // opted in → it actually refuses
    for (let i = 0; i < 6; i += 1) {                          // 6 >> MAX_SHOWS (default 3)
      const r = runGate(['--event', 'PreToolUse', '--trigger', 'claim-done', '--session', 'blk'],
        { RUVNET_LESSON_MAX_SHOWS: '2' });
      expect(r.code).toBe(2);                                // refuses, every single time
      expect(r.stderr).toContain('channel capable of observing');
    }
  });

  test('a BLOCK-CAPABLE but NOT opted-in lesson is an ADVISORY, and IS capped like one', () => {
    // The regression an independent regrade caught: enforcement:block WITHOUT an opt-in renders as a
    // nudge (exit 0) carrying the "you could turn this into a refusal" offer — it is a reminder, not a
    // refusal. The first build exempted it from the cap (capExempt keyed on block-CAPABILITY), so the
    // live "gate on blast radius" lesson nagged unbounded. It must now be capped; capping it silences no
    // refusal (a refusal exits 2, which this lesson never does until opted in). FAILS on the old capExempt.
    writeStore([blockLesson()]);                              // enforcement:block, ratified — but NO writeOptIn
    const fire = () => runGate(['--event', 'PreToolUse', '--trigger', 'claim-done', '--session', 'bc'],
      { RUVNET_LESSON_MAX_SHOWS: '2' });
    const r1 = fire();
    expect(r1.code).toBe(0);                                 // advisory, never a refusal (not opted in)
    expect(ctxOf(r1)).toContain('channel capable of observing');   // show 1 of 2
    expect(ctxOf(fire())).toContain('channel capable of observing'); // show 2 of 2
    const r3 = fire();
    expect(r3.code).toBe(0);
    expect(ctxOf(r3)).not.toContain('channel capable of observing'); // capped — the nag stops
  });

  test('a pure-advisory lesson stops repeating after MAX_SHOWS in the same session', () => {
    writeStore([advisory('A')]);
    const env = { RUVNET_LESSON_MAX_SHOWS: '2' };
    expect(ctxOf(fireAdvisory('s', env))).toContain('ADVMARKA');   // show 1 of 2
    expect(ctxOf(fireAdvisory('s', env))).toContain('ADVMARKA');   // show 2 of 2
    expect(ctxOf(fireAdvisory('s', env))).not.toContain('ADVMARKA'); // capped — silent now
    expect(ctxOf(fireAdvisory('s', env))).not.toContain('ADVMARKA'); // stays silent
  });

  test('the cap is PER-SESSION — a different session_id starts fresh', () => {
    writeStore([advisory('B')]);
    const env = { RUVNET_LESSON_MAX_SHOWS: '1' };
    expect(ctxOf(fireAdvisory('one', env))).toContain('ADVMARKB');      // session one, show 1
    expect(ctxOf(fireAdvisory('one', env))).not.toContain('ADVMARKB'); // session one, capped
    expect(ctxOf(fireAdvisory('two', env))).toContain('ADVMARKB');      // session two — fresh, shows
  });

  test('FAIL-OPEN — when the state file cannot be written, it shows every time, never suppresses', () => {
    writeStore([advisory('C')]);
    // Make the state path unwritable: put a FILE where the state\'s parent directory would need to be,
    // so mkdirSync/writeFileSync both fail and no count is ever persisted.
    const wall = path.join(dir, 'wall');
    fs.writeFileSync(wall, 'x');
    const env = { RUVNET_LESSON_GATE_STATE: path.join(wall, 'state.json'), RUVNET_LESSON_MAX_SHOWS: '1' };
    expect(ctxOf(fireAdvisory('fo', env))).toContain('ADVMARKC');   // shows
    expect(ctxOf(fireAdvisory('fo', env))).toContain('ADVMARKC');   // and STILL shows — never suppressed
  });

  test('the CLI mode (no --event) is never capped — a human asking sees everything', () => {
    writeStore([advisory('D')]);
    const env = { RUVNET_LESSON_MAX_SHOWS: '1' };
    // Same session-less CLI call many times: every one prints the advisory, because the cap is a
    // hook-mode concern and a human at a terminal explicitly asked.
    for (let i = 0; i < 4; i += 1) {
      const r = runGate(['--trigger', 'claim-done'], env);
      expect(r.stdout).toContain('ADVMARKD');
    }
  });
});
