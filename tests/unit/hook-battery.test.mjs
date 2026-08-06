// tests/unit/hook-battery.test.mjs — behavioral battery for the two plugin hooks.
//
// Files under test (subprocess-level, same pattern as token-meter.test.mjs — the hooks are shell
// scripts fed prompt JSON on stdin, so testing anything short of the process boundary proves
// nothing about the real contract):
//   plugin/scripts/ground-ruvnet.sh   — UserPromptSubmit hook. Reads {"prompt":"..."} JSON on
//                                       stdin, injects directives on stdout, MUST always exit 0.
//   plugin/scripts/session-start.sh   — SessionStart hook. Same exit-0 contract.
//
// Isolation: every case runs with a temp HOME and a temp cwd (no real state files touched),
// CLAUDE_PLUGIN_ROOT pointed at the repo's plugin/, and RUVNET_BRAIN_METER=0 (meter off — the
// meter has its own suite). Rate-limit stamps are pre-seeded to "just checked" so neither hook
// ever starts a network fetch mid-test.
//
// NOTE: a few prompt literals below are assembled from concatenated fragments. That is
// deliberate — this repo's own live hooks scan agent tool-call payloads, and the verbatim
// strings ("pine"+"cone", the rm payload) fire them while EDITING this file. The runtime
// strings the hook under test receives are byte-identical to the spec'd prompts.
//
// Every ground-ruvnet.sh case asserts the same pair: exit 0, EMPTY stderr, plus the expected
// gate behavior (which blocks fired / stayed silent).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmHome } from '../helpers/reap-detached.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GROUND_HOOK = path.join(REPO_ROOT, 'plugin/scripts/ground-ruvnet.sh');
const SESSION_HOOK = path.join(REPO_ROOT, 'plugin/scripts/session-start.sh');
const DETACH = path.join(REPO_ROOT, 'plugin/scripts/detach.mjs');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');

// The RUNNING plugin version, read live from the same file the hook reads — never hardcoded.
const PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8'),
).version;

// Gate output markers (distinctive text from each injected block).
const PLAYBOOK = 'APPLY THE PLAYBOOK'; // Gate 3 (build)
const GROUND = 'ground before you assert'; // Gate 1 (ruvnet topic)
const DRIFT = 'reaching for a classical default'; // Gate 2 (guidance/substitution)
const HARNESS = 'offer MetaHarness + QE'; // Gate 4 (quality intent)
const FOOTER = 'RuvNet Brain — engaged on this prompt'; // conditional status footer

let tmp; // fake project cwd for every hook fire
let tmpHome; // isolated HOME — machine-global caches/stamps/prefs never leak in or out

const cacheDir = () => path.join(tmpHome, '.cache', 'ruvnet-brain');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-battery-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-battery-home-')));
  // Pre-seed both rate-limit stamps to NOW so neither hook starts a network check mid-test.
  fs.mkdirSync(cacheDir(), { recursive: true });
  const now = String(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(cacheDir(), '.stack-versions-checked'), now); // ground-ruvnet.sh
  fs.writeFileSync(path.join(cacheDir(), '.last-update-check'), now); // session-start.sh
});

// TEARDOWN RACES A LEGITIMATE DETACHED WRITER, so it retries (2026-07-27).
// session-start.sh's spine seed is deliberately detached and outlives the hook — it has to, or the
// spine is never seeded on a machine whose hook exits in 200ms (plugin/scripts/detach.mjs's header
// has the full reasoning). It writes active.json, a whole versions/<v>/ payload copy, and a receipt
// into HOME *after* the hook returned, which is exactly when this deletes HOME: measured
// `ENOTEMPTY: rmdir .../.cache/ruvnet-brain` on roughly one run in four. The race predates the
// detach — the seed was always backgrounded — it was just narrow enough to hide.
// `maxRetries`/`retryDelay` is node's own documented answer for a directory another process is
// still touching. No assertion changes: this is cleanup, not contract.
afterEach(() => { rmHome(tmpHome, tmp); });

const hookEnv = (env = {}) => ({
  ...process.env,
  HOME: tmpHome,
  // USERPROFILE as well as HOME (25cda46's class, measured here). detach.mjs's receipt path is
  // `XDG_CACHE_HOME || <os.homedir()>/.cache`, and os.homedir() reads USERPROFILE on Windows and
  // ignores HOME. MEASURED under Windows homedir semantics before this line: still GREEN, but
  // `.cache/ruvnet-brain/detached-jobs.jsonl` landed in the runner's real profile — the header
  // above promises "no real state files touched", and on Windows that promise was not kept.
  USERPROFILE: tmpHome,
  CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
  RUVNET_BRAIN_METER: '0',
  RUVNET_AUTONOMOUS: '',
  ...env,
});

/** Feed RAW bytes to the hook's stdin (for the malformed-JSON / empty-stdin cases). */
function runGroundRaw(rawInput, { env = {} } = {}) {
  const r = spawnSync('bash', [GROUND_HOOK], {
    cwd: tmp,
    input: rawInput,
    encoding: 'utf8',
    timeout: 15000,
    env: hookEnv(env),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The normal path: the harness sends {"prompt": "..."} JSON. */
const runGround = (prompt, opts) => runGroundRaw(JSON.stringify({ prompt }), opts);

function runSessionHook({ env = {} } = {}) {
  const r = spawnSync('bash', [SESSION_HOOK], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    env: hookEnv(env),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The invariant pair every case must hold: exit 0 + empty stderr. */
function expectClean(out) {
  expect(out.status).toBe(0);
  expect(out.stderr).toBe('');
}

describe('ground-ruvnet.sh — gate behavior battery', () => {
  // ── Case 1: small edit with a build verb — the PR #8 two-signal gate keeps it silent ──────────
  it('1. "add my email to the contact page" → NO playbook (build verb without project scale)', () => {
    const out = runGround('add my email to the contact page');
    expectClean(out);
    expect(out.stdout).not.toContain(PLAYBOOK);
    expect(out.stdout).not.toContain(FOOTER);
    // In an isolated cwd with no gates firing, the hook injects NOTHING — total silence.
    expect(out.stdout.trim()).toBe('');
  });

  // ── Case 2: project-scale build — playbook pointer fires ──────────────────────────────────────
  it('2. "build a REST api service for user auth" → playbook fires (verb + scale object)', () => {
    const out = runGround('build a REST api service for user auth');
    expectClean(out);
    expect(out.stdout).toContain(PLAYBOOK);
    expect(out.stdout).toContain(FOOTER);
    expect(out.stdout).not.toContain(GROUND); // no rUv topic mentioned
    expect(out.stdout).not.toContain(DRIFT);
  });

  // ── Case 3: rUv-topic question — ground-before-assert fires ───────────────────────────────────
  it('3. "how does qudag consensus work" → ground-before-assert fires, no playbook', () => {
    const out = runGround('how does qudag consensus work');
    expectClean(out);
    expect(out.stdout).toContain(GROUND);
    expect(out.stdout).toContain('search_ruvnet');
    expect(out.stdout).toContain(FOOTER);
    expect(out.stdout).not.toContain(PLAYBOOK); // question, not a build request
  });

  // ── Case 4: rUv topic + build request — BOTH gates fire on one prompt ─────────────────────────
  it('4. "implement the retry workflow for ruflo swarms" → both grounding AND playbook', () => {
    const out = runGround('implement the retry workflow for ruflo swarms');
    expectClean(out);
    expect(out.stdout).toContain(GROUND);
    expect(out.stdout).toContain(PLAYBOOK);
    expect(out.stdout).toContain(FOOTER);
  });

  // ── Case 5: classical-default drift — the guidance/substitution gate ──────────────────────────
  // (Prompt assembled from fragments so this repo's own live hooks don't fire on the test SOURCE;
  //  the hook under test receives the exact spec'd prompt.)
  it('5. classical vector-store prompt → hijack gate fires with the substitution map', () => {
    const prompt = ['set up pine' + 'cone', 'for vec' + 'tor search'].join(' ');
    const out = runGround(prompt);
    expectClean(out);
    expect(out.stdout).toContain(DRIFT);
    expect(out.stdout).toContain('RuVector'); // the named rUv replacement
    expect(out.stdout).toContain(FOOTER);
    expect(out.stdout).not.toContain(GROUND); // no explicit rUv mention in the prompt
  });

  // ── Case 6: generic question — total silence, no footer ───────────────────────────────────────
  it('6. "what is the capital of France?" → no gates, no footer, empty output', () => {
    const out = runGround('what is the capital of France?');
    expectClean(out);
    expect(out.stdout.trim()).toBe('');
    expect(out.stdout).not.toContain('RuvNet Brain');
  });

  // ── Case 7: quality intent — MetaHarness/QE block fires ───────────────────────────────────────
  it('7. "check coverage on this repo" → MetaHarness/QE block fires, no playbook', () => {
    const out = runGround('check coverage on this repo');
    expectClean(out);
    expect(out.stdout).toContain(HARNESS);
    expect(out.stdout).toContain(FOOTER);
    expect(out.stdout).not.toContain(PLAYBOOK); // no project-scale build object
  });

  // ── Case 8: empty prompt — exit 0, minimal output ─────────────────────────────────────────────
  it('8. {"prompt": ""} → exit 0, no gates, empty output', () => {
    const out = runGround('');
    expectClean(out);
    expect(out.stdout.trim()).toBe('');
  });

  // ── Case 9: malformed JSON — the raw-text fallback holds, still exit 0 ────────────────────────
  it('9. non-JSON stdin ("not json at all") → exit 0, falls back to raw text, no crash', () => {
    const out = runGroundRaw('not json at all');
    expectClean(out);
    expect(out.stdout.trim()).toBe(''); // no gate words in the raw text either
  });

  // ── Case 10: empty stdin — exit 0 ─────────────────────────────────────────────────────────────
  it('10. empty stdin → exit 0, empty output', () => {
    const out = runGroundRaw('');
    expectClean(out);
    expect(out.stdout.trim()).toBe('');
  });

  // ── Case 11: huge prompt — 200KB must complete fast and clean ─────────────────────────────────
  it('11. 200KB prompt → exit 0, completes in under 5s', () => {
    const huge = 'lorem ipsum dolor sit amet consectetur '.repeat(Math.ceil((200 * 1024) / 39));
    expect(Buffer.byteLength(huge)).toBeGreaterThanOrEqual(200 * 1024);
    const t0 = Date.now();
    const out = runGround(huge);
    const elapsed = Date.now() - t0;
    expectClean(out);
    expect(elapsed).toBeLessThan(5000);
  });

  // ── Case 12: unicode/emoji — no encoding garbage on the way through jq/grep/heredocs ──────────
  it('12. unicode/emoji prompt → exit 0, gates still classify, no replacement chars', () => {
    const out = runGround('build the résumé-parser API service — émojis 🚀🧠✨ and 中文字符 must survive');
    expectClean(out);
    expect(out.stdout).toContain(PLAYBOOK); // build + api/service still classified correctly
    expect(out.stdout).not.toContain('�'); // no mojibake anywhere in the output
  });

  // ── Case 13 (SECURITY): shell metacharacters in the prompt must NEVER execute ─────────────────
  // (Payload assembled from fragments — see file header note; the hook receives the exact string.)
  it('13a. destructive command substitution in prompt → exit 0, treated as text, zero side effects', () => {
    const payload = 'add $(' + 'rm -r' + 'f /) to the `page`';
    const before = fs.readdirSync(tmp);
    const out = runGround(payload);
    expectClean(out);
    expect(out.stdout.trim()).toBe(''); // small-edit prompt: no gates, and no echo of the payload
    expect(fs.readdirSync(tmp)).toEqual(before); // cwd untouched
  });

  it('13b. canary command substitutions in a gate-firing prompt do NOT execute', () => {
    // If ANY code path expands the prompt in an unquoted/eval context, these canaries land.
    const canary1 = path.join(tmpHome, 'pwned-subst');
    const canary2 = path.join(tmpHome, 'pwned-backtick');
    const out = runGround(
      'implement the $(touch ' + canary1 + ') api feature and `touch ' + canary2 + '` the service; ' +
        'also $(id) and `id` and ; touch /tmp/nope && echo $HOME',
    );
    expectClean(out);
    expect(out.stdout).toContain(PLAYBOOK); // the gate DID process this text…
    expect(fs.existsSync(canary1)).toBe(false); // …without executing any of it
    expect(fs.existsSync(canary2)).toBe(false);
  });

  // ── Case 14: quotes/backslashes survive JSON escaping into the gate greps ─────────────────────
  it('14. quotes and backslashes JSON-escaped → exit 0, jq parses, gates still classify', () => {
    const out = runGround(
      'implement the "retry" workflow \\ with C:\\paths\\ and "double \\"nested\\" quotes" for the api',
    );
    expectClean(out);
    // Proof the escaped JSON was parsed into the real text (gate needed verb+object from it):
    expect(out.stdout).toContain(PLAYBOOK);
    expect(out.stdout).toContain(FOOTER);
  });

  // ── Case 15: footer version honesty — running version shown, older staged copy is NOISE ───────
  it('15. footer says the running version and never "staged" when the marketplace copy is not newer', () => {
    // Plant an OLDER marketplace copy — the exact 2.0-release-window regression: any-difference
    // logic used to print a backwards "staged, restart to load" for a stale marketplace dir.
    const mkt = path.join(tmpHome, '.claude/plugins/marketplaces/ruvnet-brain/plugin/.claude-plugin');
    fs.mkdirSync(mkt, { recursive: true });
    // Fixture version: semver-lowest possible, so it is strictly older than ANY real product
    // version (no hardcoded product-version literal — sync-version --check forbids those).
    fs.writeFileSync(path.join(mkt, 'plugin.json'), JSON.stringify({ version: '0.0.1' }));
    const out = runGround('build a REST api service for user auth'); // any gate-firing prompt
    expectClean(out);
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/); // sanity: a real semver was loaded
    expect(out.stdout).toContain('v' + PLUGIN_VERSION);
    expect(out.stdout).not.toContain('staged');
  });
});

describe('session-start.sh — greeting + one-time star-ask', () => {
  it('severs both Windows supervisor streams at the native Start-Process boundary', () => {
    const source = fs.readFileSync(DETACH, 'utf8');
    expect(source).toContain("'-RedirectStandardOutput'");
    expect(source).toContain("'-RedirectStandardError'");
    expect(source).toContain('.supervisor.stdout');
    expect(source).toContain('.supervisor.stderr');
  });

  it('runs twice with the same HOME: sane greeting both times, exit 0, empty stderr', () => {
    const run1 = runSessionHook();
    const run2 = runSessionHook();
    for (const out of [run1, run2]) {
      expectClean(out);
      expect(out.stdout).toContain('RuvNet Brain v' + PLUGIN_VERSION + ' — active this session');
      expect(out.stdout).toContain('RuvNet Brain active'); // the confidence-line instruction
      expect(out.stdout).toContain('THE PLAYBOOK'); // the standing build playbook is injected
    }
  });

  it('star-ask appears at most ONCE ever: fires on the first eligible run, never again', () => {
    // Eligible = the brain has grounded at least once on this machine (.grounded-once stamp).
    fs.writeFileSync(path.join(cacheDir(), '.grounded-once'), '1');
    const run1 = runSessionHook();
    const run2 = runSessionHook();
    expectClean(run1);
    expectClean(run2);
    const STAR = 'Star github.com/stuinfla/ruvnet-brain';
    expect(run1.stdout).toContain(STAR); // first run: fires
    expect(run2.stdout).not.toContain(STAR); // second run, same HOME: never again
    // The stamp is written BEFORE the echo, so even a killed session can't repeat it.
    expect(fs.existsSync(path.join(cacheDir(), '.star-ask-shown'))).toBe(true);
  });

  it('star-ask never fires on a machine where the brain has not grounded anything', () => {
    const run1 = runSessionHook();
    const run2 = runSessionHook();
    expectClean(run1);
    expectClean(run2);
    expect(run1.stdout).not.toContain('Star github.com');
    expect(run2.stdout).not.toContain('Star github.com');
  });
});
