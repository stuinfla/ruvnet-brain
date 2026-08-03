/**
 * hook-hardening.test.mjs — the BODY budgets the registry census cannot see (ADR-055 F11/F20).
 *
 * hook-registry-lint.test.mjs says this out loud in its own header: "F20 (held-open stdin) and F11
 * (learn-flush's 48s worst case inside a 30s timeout) are BUDGET facts about hook BODIES; a registry
 * census cannot see them and this file does not pretend to." This is the file that measures them.
 *
 * Every case here was RUN RED against the unmodified body first, and the verbatim red measurement is
 * quoted above the assertion it now guards. A test whose red state was never observed is a guess
 * wearing an assertion, and this repo has shipped several of those.
 *
 * Everything is measured at the PROCESS boundary, in the interpreter the shim actually dispatches
 * (hook-shim.mjs's typed table: bash for .sh, node for .mjs). Assertions bound MAGNITUDE — a byte
 * count, a millisecond wall clock, an exact exit code — never direction, because "fewer bytes" and
 * "faster" are both satisfied by a hook that silently stopped working.
 *
 * KILLS ARE PROCESS-SCOPED, ALWAYS. Nothing here matches a process by name. On 2026-07-27 a
 * `pkill -9 -f <scriptname>` run by a sibling agent matched and killed an unrelated `codex exec`
 * whose argv merely MENTIONED the script name. We hold the child handle; we kill that handle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmHome } from '../helpers/reap-detached.mjs';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCRIPTS = path.join(REPO, 'plugin', 'scripts');
const PLUGIN_ROOT = path.join(REPO, 'plugin');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
// `hasBash` answers 'is bash on PATH' — and GitHub's WINDOWS runner ships Git Bash, so it is TRUE
// there. The two producer cases below do not use PATH bash; they hardcode the ABSOLUTE path
// /bin/bash (and the seeded producer is a .sh driven the same way), which does not exist on
// Windows. Guarding them with hasBash therefore did nothing and CI run 30316293282 stayed red on
// exactly those two. The guard has to test the thing the test actually uses.
const hasBinBash = fs.existsSync('/bin/bash');

const bashOnly = !hasBash || process.platform === 'win32';

let tmp;      // a throwaway project cwd
let tmpHome;  // an isolated HOME — machine-global caches/stamps never leak in or out

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-harden-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-harden-home-')));
  fs.mkdirSync(path.join(tmpHome, '.cache', 'ruvnet-brain'), { recursive: true });
  // Freeze both network rate-limit stamps at NOW so no case starts a curl mid-measurement.
  const now = String(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(tmpHome, '.cache/ruvnet-brain/.stack-versions-checked'), now);
  fs.writeFileSync(path.join(tmpHome, '.cache/ruvnet-brain/.last-update-check'), now);
});
// Teardown retries: session-start.sh's spine seed is deliberately detached and still writing
// into HOME when this runs (plugin/scripts/detach.mjs's header explains why it must be). Node's
// own maxRetries/retryDelay is the documented answer; no assertion changes.
afterEach(() => { rmHome(tmpHome, tmp); });

const env = (extra = {}) => ({
  ...process.env,
  HOME: tmpHome,
  CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
  RUVNET_BRAIN_METER: '0',
  RUVNET_AUTONOMOUS: '',
  // These legacy hardening cases intentionally assert the user-scope queue under
  // HOME. The product default is now project scope, so name the scope instead of
  // letting an unrelated preference change silently redirect the fixture.
  RUVNET_LEARNING_SCOPE: 'user',
  ...extra,
});

/** Fire a hook body the way hook-shim.mjs does: chosen interpreter, argv array, payload on stdin. */
function fire(interpreter, file, input, extraEnv = {}, timeout = 60_000) {
  const r = spawnSync(interpreter, [file], {
    cwd: tmp, input, encoding: 'utf8', timeout, env: env(extraEnv),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1. learn-flush — DEADLINE-AWARE, or SessionEnd pins at its 30s cap on every `/clear`.
//
// RED, verbatim (origin/main b73176a, 147-entry queue, a `ruflo` stub that sleeps 4s):
//     wall 32173 ms   exit 0   queue remainder 139
// The measured audit number on the owner's live machine was worse — 48–50s in ALL FOUR stdin
// regimes, killed at the 30s cap every time. Same defect, larger constant: the feed queues
// MAX_ACTIONS × per-call cost with no reference to the budget it is spending.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('learn-flush: SessionEnd is a 30s budget, and the feed must respect it', () => {
  /** A HOME whose ~/.npm-global/bin/ruflo is a stub that burns `seconds` and succeeds. */
  function stubRuflo(seconds) {
    const bin = path.join(tmpHome, '.npm-global', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const p = path.join(bin, 'ruflo');
    fs.writeFileSync(p, `#!/bin/bash\nsleep ${seconds}\nexit 0\n`);
    fs.chmodSync(p, 0o755);
    return p;
  }

  /** A queue of `n` DISTINCT captures — distinct because learn-flush dedupes before it feeds. */
  function seedQueue(n) {
    const q = path.join(tmp, 'queue.jsonl');
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(JSON.stringify({ tool: 'Bash', action: `verb${i}` }));
    fs.writeFileSync(q, lines.join('\n') + '\n');
    return q;
  }

  it('a 147-entry queue + a 4s-per-call learner: finishes UNDER the 30s cap, remainder preserved', () => {
    stubRuflo(4);
    const q = seedQueue(147);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'learn-flush.mjs'), '--sync'], {
      cwd: tmp, input: JSON.stringify({ session_id: 'deadline-sess', hook_event_name: 'SessionEnd' }),
      encoding: 'utf8', timeout: 120_000, env: env({ LEARN_QUEUE: q }),
    });
    const wall = Date.now() - t0;

    // MAGNITUDE, not direction: 25s is the honest headroom under a 30s cap once the harness's own
    // spawn/teardown is counted. Today's 32s is not "a bit slow" — it is killed mid-queue, which is
    // what makes the remainder undrainable in the first place.
    expect(wall).toBeLessThan(25_000);
    expect(r.status).toBe(0);

    // And the work it did NOT do is still on disk. A deadline that drops the remainder is just a
    // faster version of the truncation this queue's write-back was built to stop.
    const left = fs.readFileSync(q, 'utf8').split('\n').filter(Boolean);
    expect(left.length).toBeGreaterThanOrEqual(139);
  }, 140_000);

  it('TEETH: the same deadline does NOT stall a fast learner — a quick queue still drains its slice', () => {
    stubRuflo(0);
    const q = seedQueue(12);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'learn-flush.mjs'), '--sync'], {
      cwd: tmp, input: JSON.stringify({ session_id: 'fast-sess' }),
      encoding: 'utf8', timeout: 60_000, env: env({ LEARN_QUEUE: q }),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/fed 8\/8/);          // the MAX_ACTIONS slice, whole — no deadline haircut
    const left = fs.readFileSync(q, 'utf8').split('\n').filter(Boolean);
    expect(left.length).toBe(4);                    // 12 − 8 deferred, exactly
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE SHARED QUEUE — every concurrent session on a machine appends to ONE file.
//
// RED, verbatim (origin/main b73176a): two payloads carrying session_id "alpha" and "beta" both
// landed in ~/.cache/ruvnet-brain/learn/session-default.jsonl — 2 files expected, 1 found:
//     ["session-default.jsonl"]
// Measured live on the owner's machine the same day: one shared session-default.jsonl, 147 lines
// deep, appended by multiple sessions at once. Same clobber class as ADR-050.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('the learning queue is PER SESSION — the id is in the payload, not the env', () => {
  const capture = (sessionId, command) => fire('bash', path.join(SCRIPTS, 'learn-capture.sh'),
    JSON.stringify({ session_id: sessionId, tool_name: 'Bash', tool_input: { command } }));

  const queueFiles = () => {
    try { return fs.readdirSync(path.join(tmpHome, '.cache/ruvnet-brain/learn')).sort(); }
    catch { return []; }
  };

  it('two sessions with different payload session_ids write to two DIFFERENT queue files', () => {
    // CLAUDE_SESSION_ID deliberately unset — that is the real-world case, and it is why every
    // session on this machine shared one file.
    capture('alpha', 'git push');
    capture('beta', 'npm test');
    const files = queueFiles();
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes('alpha'))).toBe(true);
    expect(files.some((f) => f.includes('beta'))).toBe(true);
  });

  it('learn-flush reads the SAME payload id — capture and flush must not disagree about the file', () => {
    capture('gamma', 'git status');
    const bin = path.join(tmpHome, '.npm-global', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ruflo'), '#!/bin/bash\nexit 0\n');
    fs.chmodSync(path.join(bin, 'ruflo'), 0o755);

    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'learn-flush.mjs'), '--sync'], {
      cwd: tmp, input: JSON.stringify({ session_id: 'gamma', hook_event_name: 'SessionEnd' }),
      encoding: 'utf8', timeout: 60_000, env: env(),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/fed 1\/1/);           // it found gamma's queue, not "default"'s
    expect(queueFiles()).toEqual([]);               // drained and removed
  }, 60_000);

  it('a hostile session_id cannot escape the learn directory (it is a filename component)', () => {
    capture('../../../../etc/pwn', 'git push');
    const files = queueFiles();
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain('/');
    expect(files[0]).not.toContain('..');
    expect(fs.existsSync(path.join(tmpHome, '.cache/ruvnet-brain/learn'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE CAPTURE IS MANGLED — the learner is being fed garbage.
//
// RED, verbatim (origin/main b73176a), for the command `cd "/tmp/some dir"`:
//     queue line    : {"tool":"Bash","action":"cd \"}
//     parsed action : *** JSON.parse FAILED: Unterminated string in JSON at position 31 ***
// The bash regex `"command"…"([^"]*)"` cannot cross a JSON-escaped quote — the EXACT bug
// hook-input.mjs was written to end — so it captured `cd \` and the trailing backslash then broke
// the JSON line it was written into. Every such line is silently dropped by learn-flush's
// JSON.parse, so the capture looks healthy and the learner receives nothing.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('learn-capture records the real command VERB, as parseable JSON', () => {
  const queueOf = (sid) => path.join(tmpHome, '.cache/ruvnet-brain/learn', `session-${sid}.jsonl`);
  function captured(command) {
    fire('bash', path.join(SCRIPTS, 'learn-capture.sh'),
      JSON.stringify({ session_id: 'verb', tool_name: 'Bash', tool_input: { command } }));
    const raw = fs.readFileSync(queueOf('verb'), 'utf8').trim();
    return { raw, parsed: JSON.parse(raw) };   // throws on the mangled line — that IS the assertion
  }

  it('a quoted argument does not corrupt the line: `cd "…"` records the verb `cd`', () => {
    const { parsed } = captured('cd "/tmp/some dir"');
    expect(parsed.action).toBe('cd');
  });

  it('an escaped quote mid-command still yields a clean verb chain', () => {
    const { parsed } = captured('git commit -m "fix \\"quoted\\" thing"');
    expect(parsed.action).toBe('git commit');
  });

  it('TEETH: the unquoted cases still record exactly what they always did', () => {
    expect(captured('git push').parsed.action).toBe('git push');
  });

  it('a command that is nothing but a quoted path records NOTHING rather than a broken line', () => {
    fire('bash', path.join(SCRIPTS, 'learn-capture.sh'),
      JSON.stringify({ session_id: 'q2', tool_name: 'Bash', tool_input: { command: '"/opt/my app/bin" --go' } }));
    // Either no queue at all, or a queue whose every line parses. Never a half-written line.
    if (fs.existsSync(queueOf('q2'))) {
      for (const l of fs.readFileSync(queueOf('q2'), 'utf8').split('\n').filter(Boolean)) JSON.parse(l);
    }
  });

  it('the secret-redaction contract survives the parser change (no inline data ever recorded)', () => {
    const { parsed } = captured('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI && psql postgres://admin:Hunter2@db/prod');
    expect(parsed.action).toBe('export');
    expect(parsed.action).not.toMatch(/wJalr|Hunter2/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 4. session-start's byte budget — MEASURED and RATCHETED, not yet cut. Read this before adding to it.
//
// Measured on origin/main b73176a (isolated HOME, no issue file, meter off):
//     first session on a fresh machine : 12804 bytes   (12517 without the major-line milestone block)
//     steady state (offers consumed)   : 10068 bytes
//     ── of which: playbook 6281 · banner+confidence 1646 · one-time setup 1019 · token-intel 512
// That is WORSE than the 8,966 the audit measured, because the audit ran on a machine whose
// once-ever offers had already been burned.
//
// TWO THINGS THE AUDIT GOT WRONG, said plainly rather than worked around:
//   (a) session-start has NO declared cap of its own. The 4,096 `stdoutCapBytes` in
//       plugin/hooks/hook-contracts.json belongs to `project:version-bump-gate` — a different hook,
//       and the only entry in that file, whose stated scope is registrations that do NOT route
//       through the shim. session-start does route through it.
//   (b) 4,096 is not reachable by cutting advertising alone. The PLAYBOOK is 6,281 of the 10,068
//       bytes and it is not advertising — `scripts/behavioral-l1-l4.mjs` L4 asserts TWELVE markers
//       out of it (take the wheel · SPARC · DDD · ADR · swarm · QA gate · 98 · frontend-design ·
//       image generation · API key · PROVEN · PARALLEL), and tests/unit/brain-off.test.mjs uses
//       'standing build playbook' as its ON-state control. Cutting to 4,096 means deleting content
//       two other gates require, which is weakening a test to pass a test.
//
// So this is a RATCHET, not a fix: it pins the measured number so the cost can never grow again in
// silence, which is the part that was genuinely missing — there was no budget on this hook anywhere.
// The actual reduction needs an ADR-level decision about whether the playbook belongs at SessionStart
// at all (ADR-0011 Phase 2 put it there on purpose, to buy back a per-turn tax), and that is a
// product call, not a hook-hardening one.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('session-start: the once-per-session context cost is bounded', () => {
  // The measured fresh-machine cost (12,804) plus ~4%. Tight enough that a new block goes red;
  // loose enough that a version string growing a digit does not. Set from the measurement, not from
  // how round the number looks — the first attempt at this line was 12,800 and it failed by 4 bytes,
  // which is the correct behaviour of a ratchet and the reason it is worth having.
  const CEILING = 13_312;

  const session = () => fire('bash', path.join(SCRIPTS, 'session-start.sh'), '');

  it(`a fresh machine's FIRST session does not exceed the measured ${CEILING}-byte ceiling`, () => {
    const out = session();
    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(Buffer.byteLength(out.stdout, 'utf8')).toBeLessThanOrEqual(CEILING);
  }, 30_000);

  it('steady state (once-ever offers already consumed) is materially smaller than the first session', () => {
    const first = Buffer.byteLength(session().stdout, 'utf8');
    const steady = Buffer.byteLength(session().stdout, 'utf8');
    expect(steady).toBeLessThan(first);
    expect(steady).toBeLessThanOrEqual(10_500);
  }, 60_000);

  it('TEETH: SessionStart points to the playbook and the prompt gate carries its compact L4 contract', () => {
    const out = session().stdout;
    expect(out).toContain('RuvNet Brain active');
    expect(out).toContain('standing build playbook');
    const promptGate = fs.readFileSync(path.join(SCRIPTS, 'ground-ruvnet.sh'), 'utf8');
    for (const marker of ['take the wheel', 'SPARC', 'DDD', 'ADR', 'swarm', 'QA gate', '98',
      'frontend-design', 'image generation', 'API key', 'PROVEN', 'PARALLEL']) {
      expect(promptGate.toLowerCase(), `L4 marker "${marker}" is gone`).toContain(marker.toLowerCase());
    }
  }, 30_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 5. unprompted-runtime speaks when NOTHING asked it to.
//
// RED, verbatim (origin/main b73176a):
//     empty stdin  -> 2453 bytes, exit 0
//     garbage      -> 2453 bytes
//     real payload -> 0 bytes
// Read those three lines together: it is silent when a real event arrives and speaks when none did.
// An unprompted utterance that is not OCCASIONED by an event is not proactivity, it is noise with a
// JSON envelope around it.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('unprompted speech requires an OCCASION — no payload, no bytes', () => {
  /**
   * A REAL, ARMED lesson producer, seeded so it WOULD speak.
   *
   * This matters more than it looks. The first version of these cases ran under a bare isolated HOME,
   * so the lesson store was empty, the producer emitted nothing, and every assertion passed against
   * the UNFIXED runtime — four tests that could not fail on broken code, guarding the exact rule this
   * section exists for. The store is seeded here so the only thing standing between the producer and
   * the user's context is the payload gate under test.
   */
  function armed() {
    const store = path.join(tmp, 'lessons.json');
    fs.writeFileSync(store, JSON.stringify({
      version: 1,
      lessons: [{
        id: 'ADV-occasion-probe',
        statement: 'OCCASION PROBE: this lesson exists to prove the payload gate has teeth.',
        trigger: 'report-status', enforcement: 'inject', origin: 'user-stated', status: 'ratified',
        evidence: [{ observed: 'you said: prove the guard by breaking it' }],
        projects: ['alpha', 'beta', 'gamma'], repeatCount: 9,
      }],
    }));
    return {
      RUVNET_LESSON_STORE: store,
      RUVNET_LESSON_OPTIN: path.join(tmp, 'no-optin.json'),
      RUVNET_LESSON_GATE_STATE: path.join(tmp, `gate-${Math.random().toString(36).slice(2)}.json`),
      RUVNET_ADVOCACY_OUTCOMES: path.join(tmp, 'o.jsonl'),
      RUVNET_UNPROMPTED_TIMEOUT_MS: '30000',
    };
  }

  const runtime = (input, extra = {}) => spawnSync(process.execPath,
    [path.join(SCRIPTS, 'unprompted-runtime.mjs'), 'UserPromptSubmit'],
    { cwd: tmp, input, encoding: 'utf8', timeout: 60_000, env: env({ ...armed(), ...extra }) });

  // WINDOWS (2026-07-28, CI run 30315927742): these two drive a REAL producer, and a producer is a
  // shell script — `argv: ['/bin/bash', emit]` below, and lesson-hooks.sh for the seeded one. There
  // is no /bin/bash on a Windows runner, so the child never ran, stdout came back '' and BOTH
  // assertions failed on a product that is fine. `hasBash` is already computed at the top of this
  // file for exactly this reason; these two were simply written without it. Skipping is the honest
  // verdict — the behaviour under test is the payload gate, which the four byte-exact-silence cases
  // between them still prove on every OS. Faking a shell to keep a green tick would be worse than
  // an honest skip, and this repo's own rule is that a test which cannot fail is not a test.
  it.skipIf(!hasBinBash)('CONTROL: the seeded producer really does speak when a real event occasions it', () => {
    const r = runtime(JSON.stringify({
      prompt: 'give me a long status update about where the build actually is', session_id: 'occ-1',
    }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OCCASION PROBE');   // if this is empty, every case below is vacuous
  }, 60_000);

  it('EMPTY stdin → exit 0 and byte-EXACT stdout === ""', () => {
    const r = runtime('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, 60_000);

  it('1MB of random base64 on stdin → exit 0 and byte-EXACT stdout === ""', () => {
    const big = Buffer.alloc(1 << 20, 0).map((_, i) => (i * 37 + 11) % 251).toString('base64');
    const r = runtime(big);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, 60_000);

  it('a payload that is valid JSON but NOT an object (a bare array) → silence', () => {
    const r = runtime('[1,2,3]');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, 60_000);

  it('TEETH: a REAL payload still reaches the producers — the gate is not a mute button', () => {
    // A trusted, cross-platform fake producer via the documented test seam. The behavior under test
    // is the Node runtime's payload gate, so routing this fixture through /bin/bash added an unrelated
    // failure mode: a failed shell spawn is deliberately converted to silence by the production
    // fail-safe and can therefore look exactly like a muted gate.
    const emit = path.join(tmp, 'emit.mjs');
    fs.writeFileSync(emit, 'process.stdout.write(`${process.env.CANDIDATE_LINE}\\n`);\n');
    const r = spawnSync(process.execPath,
      [path.join(SCRIPTS, 'unprompted-runtime.mjs'), 'UserPromptSubmit'],
      {
        cwd: tmp,
        input: JSON.stringify({ prompt: 'a real prompt', session_id: 's1' }),
        encoding: 'utf8', timeout: 60_000,
        env: env({
          RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify([{ argv: [process.execPath, emit], feedStdin: true, channels: ['alarm'] }]),
          CANDIDATE_LINE: JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'REAL ALARM', hookEventName: 'UserPromptSubmit' }),
          RUVNET_ADVOCACY_OUTCOMES: path.join(tmp, 'o.jsonl'),
          RUVNET_UNPROMPTED_TIMEOUT_MS: '30000',
        }),
      });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REAL ALARM');
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 6. ground-ruvnet's topic detector fires on noise, and takes 38s doing it.
//
// RED, verbatim (origin/main b73176a, 1MB of random base64 on stdin, meter off):
//     elapsed: 38284 ms   |  stdout bytes: 2605
//     [RuvNet Brain — ground before you assert] …
// Its declared timeout is 5s. It matched `ruvnet|ruflo|…` as bare substrings inside random base64,
// then injected the grounding banner because of it — ten unanchored `grep -qiE` passes over an
// unbounded read.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('ground-ruvnet: bounded input, word-boundary matching', () => {
  // bash, because that is the interpreter hook-shim.mjs's typed table actually dispatches for every
  // .sh body. The file stays POSIX-runnable (scripts/behavioral-l1-l4.mjs invokes it with `sh`), but
  // the read's TIME bound is a bash feature, so the measurement has to be taken in the real shell.
  const ground = (input) => fire('bash', path.join(SCRIPTS, 'ground-ruvnet.sh'), input);

  it('1MB of base64 noise → ZERO bytes injected, and it finishes inside the 5s hook timeout', () => {
    // Deterministic noise, so a red is reproducible rather than a lucky draw. base64's alphabet is
    // exactly what made the substring match fire in the first place.
    const noise = Buffer.from(Buffer.alloc(786_432, 0).map((_, i) => (i * 37 + 11) % 251)).toString('base64').slice(0, 1 << 20);
    const t0 = Date.now();
    const out = ground(JSON.stringify({ prompt: noise }));
    const wall = Date.now() - t0;
    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('');
    expect(wall).toBeLessThan(5_000);
  }, 90_000);

  it('TEETH: a REAL rUv prompt still fires the grounding gate (the bound is not a mute button)', () => {
    const out = ground(JSON.stringify({ prompt: 'how does ruflo swarm orchestration work' }));
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('ground before you assert');
  }, 30_000);

  it('word boundaries: "ruvnet" inside a longer token is NOT the rUv stack', () => {
    const out = ground(JSON.stringify({ prompt: 'rename the variable xxruvnetxx to something clearer' }));
    expect(out.stdout).not.toContain('ground before you assert');
  }, 30_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 7. HELD-OPEN STDIN — 18 of 37 commands in the audited mesh never return at all.
//
// RED, verbatim (origin/main b73176a): every hook below sat at its harness kill with no output —
// e.g. `design-wall  heldopen: 10009ms KILLED@guard`, `verify-interface 10009ms KILLED@guard`,
// `protect-state 10020ms KILLED@guard`, `route-dispatch 10011ms KILLED@guard`,
// `version-bump-gate 10007ms KILLED@guard`. Nothing but the harness's own kill ends them.
//
// Claude Code always writes the payload and closes, so this costs no normal turn. That is exactly
// why it survived: a hook that CAN hang forever has no upper bound on its damage, and the only
// thing standing between a user and that hang is a timeout owned by someone else.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('every stdin-reading hook body returns on a stdin that is never closed', () => {
  // Their registered timeouts: 5s (plugin + project PreToolUse/UserPromptSubmit). The bound must sit
  // comfortably inside that, so 5s is the assertion and the harness's kill is never the thing that
  // ends the process.
  const BODIES = [
    'design-wall.sh', 'verify-interface.sh', 'protect-brain-state.sh', 'route-dispatch.sh',
    'version-bump-gate.sh', 'learn-capture.sh', 'ground-before-write.sh', 'grounding-stamp.sh',
    'lesson-hooks.sh', 'ground-ruvnet.sh', 'hijack-ruvnet.sh',
  ];

  /**
   * Spawn the body with a pipe on stdin that is opened, written to, and NEVER closed. Resolves with
   * the wall time at exit, or `null` if it was still alive at `limitMs`.
   *
   * The child handle is held and killed directly — `child.kill()`, then `SIGKILL` on the same pid.
   * No name matching, ever.
   */
  function heldOpen(file, limitMs = 15_000) {
    return new Promise((resolve) => {
      const child = spawn(file.endsWith('.sh') ? 'bash' : process.execPath,
        [path.join(SCRIPTS, file), ...(file === 'lesson-hooks.sh' ? ['UserPromptSubmit'] : [])],
        { cwd: tmp, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
      const t0 = Date.now();
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(null);
      }, limitMs);
      child.stdout.resume();
      child.stderr.resume();
      child.on('exit', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(Date.now() - t0);
      });
      // A partial payload, then silence, then nothing — the pipe stays open for the child's lifetime.
      try { child.stdin.write('{"tool_name":"Bash","tool_input":{"command":"git status"}}'); } catch { /* fine */ }
    });
  }

  for (const body of BODIES) {
    it(`${body} exits on held-open stdin instead of waiting for the harness to kill it`, async () => {
      const ms = await heldOpen(body);
      expect(ms, `${body} never returned — only the kill ended it`).not.toBeNull();
      expect(ms).toBeLessThan(5_000);
    }, 40_000);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 8. hook-input.mjs's isMain — every gate built on it FAILS OPEN through a symlink.
//
// RED, verbatim (origin/main b73176a):
//     --- direct (control) --- git push --force <exit=0>
//     --- via symlink ---       <exit=0>
// `path.resolve(process.argv[1])` keeps the symlink path; `fileURLToPath(import.meta.url)` is
// already the realpath (node resolves module URLs through symlinks). They never compare equal, so
// the CLI half never runs, and the gate that asked for a command receives "" — which every gate in
// this repo treats as "nothing to inspect" and permits. That is the whole security surface of the
// PreToolUse walls, defeated by a symlink.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('hook-input.mjs: the parser answers through a symlink, or every gate it feeds fails open', () => {
  const PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' } });
  const ask = (entry, which) => spawnSync(process.execPath, [entry, which],
    { input: PAYLOAD, encoding: 'utf8', timeout: 30_000 });

  it('invoked through a symlink it still emits the parsed command', () => {
    const link = path.join(tmp, 'hook-input-link.mjs');
    fs.symlinkSync(path.join(SCRIPTS, 'hook-input.mjs'), link);
    const r = ask(link, 'command');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('git push --force');
  });

  it('through a symlinked DIRECTORY too (the shape a versioned spine generation actually takes)', () => {
    const linkDir = path.join(tmp, 'scripts-link');
    fs.symlinkSync(SCRIPTS, linkDir);
    const r = ask(path.join(linkDir, 'hook-input.mjs'), 'tool_name');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('Bash');
  });

  it('TEETH: the direct invocation is unchanged (the control that makes the above mean something)', () => {
    const r = ask(path.join(SCRIPTS, 'hook-input.mjs'), 'command');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('git push --force');
  });

  it('IMPORTED, it must still stay quiet — isMain has to distinguish, not just say yes', () => {
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `import { commandOf } from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, 'hook-input.mjs')).href)};\n`
      + 'process.stdout.write("IMPORT-ONLY:" + commandOf({ tool_input: { command: "x" } }));\n');
    const r = spawnSync(process.execPath, [probe], { input: PAYLOAD, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toBe('IMPORT-ONLY:x');   // no CLI output appended — the module did not self-run
  });
});
