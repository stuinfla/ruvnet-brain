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
import { createHash } from 'node:crypto';
import { learningFixture } from '../helpers/learning-fixture.mjs';
import { takeQueueLock, releaseQueueLock } from '../../plugin/scripts/learning-queue.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCRIPTS = path.join(REPO, 'plugin', 'scripts');
const detachRows = home => {
  try { return fs.readFileSync(path.join(home, 'cache/ruvnet-brain/detached-jobs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
  catch { return []; }
};
async function detachFixture(body, { ttl = '0.15', preload = '' } = {}) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'detach-truth-')));
  const job = path.join(home, 'job.mjs'); fs.writeFileSync(job, body);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'),
    RUVNET_DETACH_SUPERVISOR: '1', RUVNET_DETACH_PAYLOAD_B64: '' };
  if (preload) { const file = path.join(home, 'preload.cjs'); fs.writeFileSync(file, preload); env.NODE_OPTIONS = `--require=${file}`; }
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'detach.mjs'), ttl, '-', process.execPath, job], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const started = Date.now();
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('finite supervisor did not return')); }, 8000);
      child.once('close', code => { clearTimeout(timer); resolve(code); }); child.once('error', reject);
    });
    return { home, code, stderr, elapsedMs: Date.now() - started, rows: detachRows(home) };
  } catch (error) { cleanupDetach(home); throw error; }
}
function cleanupDetach(home) {
  if (detachRows(home).some(row => row.groupRetirementConfirmed === true || row.rootObservation?.state === 'gone')) {
    fs.rmSync(home, { recursive: true, force: true }); return;
  }
  for (const row of detachRows(home).filter(row => row.state === 'started' && Number.isInteger(row.pid))) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(row.pid), '/T', '/F'], { timeout: 2000, stdio: 'ignore' });
      else process.kill(-row.pid, 'SIGKILL');
    } catch { /* only exact fixture-owned groups; already absent is normal */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
}
describe('detached maintenance retirement truth', () => {
  it.skipIf(process.platform === 'win32')('retains the finite supervisor after parent exit and observes a surviving child group retire', async () => {
    const body = `import {spawn} from 'node:child_process';import fs from 'node:fs';
      const leaf=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      fs.writeFileSync(process.env.HOME+'/leaf.pid',String(leaf.pid));setTimeout(()=>process.exit(0),80);`;
    const f = await detachFixture(body, { ttl: '0.3' });
    try {
      expect(f.code, f.stderr).toBe(0); expect(f.elapsedMs).toBeLessThan(7000);
      expect(f.rows.some(row => row.state === 'parent-exited')).toBe(true);
      const result = f.rows.at(-1); expect(result.groupObservation?.state).toBe('gone'); expect(result.groupRetirementConfirmed).toBe(true);
      const pid = Number(fs.readFileSync(path.join(f.home, 'leaf.pid'), 'utf8')); let kernelError;
      try { process.kill(pid, 0); } catch (error) { kernelError = error; }
      expect(kernelError?.code).toBe('ESRCH');
      expect(result.scope).toBe('posix-process-group'); expect(result.retirementConfirmed).toBe(false); expect(result.retirementRequired).toBe(true);
      expect(result.retirementState).toBe('UNKNOWN'); expect(f.rows.some(row => row.state === 'killed-at-ttl')).toBe(false);
    } finally { cleanupDetach(f.home); }
  }, 10000);
  it.skipIf(process.platform === 'win32')('records kill failure and retains UNKNOWN instead of claiming a TTL kill', async () => {
    const preload = `const kill=process.kill;process.kill=(pid,signal)=>{if(pid<0&&signal!==0){const e=new Error('fixture denied');e.code='EPERM';throw e;}return kill(pid,signal);};`;
    const f = await detachFixture('setInterval(()=>{},1000);', { preload });
    try {
      const result = f.rows.at(-1); expect(result.state).toBe('retirement-unknown'); expect(result.groupObservation.state).toBe('alive');
      expect(() => process.kill(-result.pid, 0)).not.toThrow();
      expect(result.killErrors.map(row => row.error)).toEqual(['EPERM', 'EPERM']); expect(result.retirementRequired).toBe(true);
      expect(result.retirementConfirmed).toBe(false); expect(f.rows.some(row => row.state === 'killed-at-ttl')).toBe(false);
    } finally { cleanupDetach(f.home); }
  }, 10000);
  it.skipIf(process.platform === 'win32')('uses the Windows tree command and records its failure without negative-PID signals or a native Windows claim', async () => {
    const preload = `const cp=require('node:child_process'),fs=require('node:fs');Object.defineProperty(process,'platform',{value:'win32'});
      const original=cp.spawnSync;cp.spawnSync=(file,args,options)=>{if(file==='taskkill'){fs.writeFileSync(process.env.HOME+'/taskkill.json',JSON.stringify(args));return{status:1};}return original(file,args,options);};require('node:module').syncBuiltinESMExports();
      const kill=process.kill;process.kill=(pid,signal)=>{if(pid<0)throw new Error('negative Windows pid');return kill(pid,signal);};`;
    const f = await detachFixture('setInterval(()=>{},1000);', { preload });
    try {
      const result = f.rows.at(-1); expect(result.scope).toBe('windows-taskkill-tree-attempt'); expect(result.taskkill).toMatchObject({ status: 1 });
      expect(() => process.kill(result.pid, 0)).not.toThrow();
      expect(result.rootObservation.state).toBe('alive'); expect(result.retirementConfirmed).toBe(false); expect(result.retirementRequired).toBe(true);
      const args = JSON.parse(fs.readFileSync(path.join(f.home, 'taskkill.json'), 'utf8')); expect(args).toContain('/T'); expect(args).toContain('/F');
      expect(f.rows.some(row => row.state === 'killed-at-ttl')).toBe(false);
    } finally { cleanupDetach(f.home); }
  });
  it.skipIf(process.platform !== 'win32')('records the actual native Windows taskkill result while leaving complete descendant proof UNKNOWN', async () => {
    const f = await detachFixture('setInterval(()=>{},1000);');
    try {
      const result = f.rows.at(-1); expect(result.scope).toBe('windows-taskkill-tree-attempt'); expect(result.taskkill.status).toBe(0);
      expect(result.rootObservation.state).toBe('gone'); expect(result.retirementConfirmed).toBe(false); expect(result.retirementRequired).toBe(true);
    } finally { cleanupDetach(f.home); }
  });
});
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
  // USERPROFILE as well as HOME (25cda46's class, measured here). update-apply.mjs, learn-flush.mjs,
  // detach.mjs, lesson-store.mjs and ruflo-bin.mjs all resolve their state root from os.homedir(),
  // which reads USERPROFILE on Windows and ignores HOME. MEASURED under Windows homedir semantics
  // before this line: the suite went RED **and** wrote 83 files — a staged version tree, an update
  // transaction and its lock — into the runner's real profile. An isolated HOME that isolates
  // nothing is worse than no isolation, because it reports success while doing it.
  USERPROFILE: tmpHome,
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
const learningFixtures = [];
const adoptedLearning = () => { const f = learningFixture('user'); learningFixtures.push(f); return f; };
afterEach(() => learningFixtures.splice(0).forEach(f => f.cleanup()));
const learningContextFor = f => ({ scope: 'user', home: f.home, projectDir: f.project, queueDir: f.queue });
const captureLearning = (f, sid, command) => f.run('plugin/scripts/learn-capture.mjs', [], {}, {
  session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { success: true },
});
const learningFiles = f => fs.readdirSync(f.queue).filter(name => name.endsWith('.jsonl')).sort();
const sidHash = sid => createHash('sha256').update(sid).digest('hex').slice(0, 24);

describe('learn-flush respects the finite canonical worker deadline', () => {
  it('a slow learner stops at the actual deadline and preserves every original queued observation', () => {
    const f = adoptedLearning(); const file = f.write('deadline-sess', (JSON.stringify({ tool: 'Bash', action: 'npm test' }) + '\n').repeat(147));
    const before = fs.readFileSync(file); const started = Date.now();
    const result = f.run('plugin/scripts/learn-flush.mjs', ['--sync'], { TEST_SLEEP: '4000', LEARN_FLUSH_DEADLINE_MS: '500' });
    expect(result.status, result.stdout + result.stderr).toBe(0); expect(Date.now() - started).toBeLessThan(2500);
    expect(f.readCalls().length).toBeGreaterThan(0); expect(f.depth()).toBe(147); expect(fs.readFileSync(file)).toEqual(before);
  }, 10000);
  it('TEETH: the same adopted canonical learner makes eight verified deliveries and retains four pending', () => {
    const f = adoptedLearning(); const file = f.write('fast-sess', (JSON.stringify({ tool: 'Bash', action: 'npm test' }) + '\n').repeat(12));
    const before = fs.readFileSync(file); const result = f.run('plugin/scripts/learn-flush.mjs', ['--sync'], { LEARN_FLUSH_DEADLINE_MS: '5000' });
    expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toMatch(/fed 8; acknowledged 8; failed 0/);
    expect(f.readCalls()).toHaveLength(8); expect(f.depth()).toBe(4); expect(fs.readFileSync(file)).toEqual(before);
  }, 10000);
});

describe('the learning queue is PER SESSION with private session identifiers', () => {
  it('two payload session_ids create distinct safe files without exposing their raw IDs', () => {
    const f = adoptedLearning(); takeQueueLock(learningContextFor(f));
    captureLearning(f, 'alpha', 'git push'); captureLearning(f, 'beta', 'npm test'); const files = learningFiles(f);
    expect(files).toHaveLength(2); expect(files.some(name => name.includes(sidHash('alpha')))).toBe(true); expect(files.some(name => name.includes(sidHash('beta')))).toBe(true);
    expect(files.join(' ')).not.toMatch(/alpha|beta/);
  });
  it('capture and canonical flush address the same selected user queue and retain its original bytes', () => {
    const f = adoptedLearning(); const context = learningContextFor(f); const token = takeQueueLock(context); captureLearning(f, 'gamma', 'git status');
    const file = path.join(f.queue, learningFiles(f)[0]); const before = fs.readFileSync(file); releaseQueueLock(context, token);
    const result = f.run('plugin/scripts/learn-flush.mjs', ['--sync']); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/fed 1; acknowledged 1; failed 0/); expect(f.depth()).toBe(0); expect(fs.readFileSync(file)).toEqual(before);
    expect(f.readCalls()[0].args).toContain(path.join(f.home, '.claude/global-memory/.swarm/memory.db'));
  });
  it('a hostile session_id remains inside the queue and never becomes a traversal filename', () => {
    const f = adoptedLearning(); takeQueueLock(learningContextFor(f)); captureLearning(f, '../../../../etc/pwn', 'git push');
    const files = learningFiles(f); expect(files).toHaveLength(1); expect(files[0]).not.toContain('..'); expect(files[0]).not.toContain('/');
  });
});

describe('learn-capture records a privacy-safe command VERB as parseable JSON', () => {
  const captured = command => {
    const f = adoptedLearning(); takeQueueLock(learningContextFor(f)); captureLearning(f, 'verb', command);
    const raw = fs.readFileSync(path.join(f.queue, learningFiles(f)[0]), 'utf8').trim(); return { raw, parsed: JSON.parse(raw) };
  };
  it('a quoted argument cannot corrupt the JSON verb', () => { expect(captured('cd "/tmp/some dir"').parsed.action).toBe('cd'); });
  it('escaped quotes keep the allowed command chain parseable', () => { expect(captured('git commit -m "fix \\"quoted\\" thing"').parsed.action).toBe('git commit'); });
  it('TEETH: ordinary allowed commands retain their workflow vocabulary', () => { expect(captured('git push').parsed.action).toBe('git push'); });
  it('an opaque quoted executable records only a generic action', () => { expect(captured('"/opt/my app/bin" --go').parsed.action).toBe('command'); });
  it('secret-bearing commands keep only their allowlisted verb and contain no inline private data', () => {
    const value = captured('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI && psql postgres://admin:Hunter2@db/prod');
    expect(value.parsed.action).toBe('export'); expect(value.raw).not.toMatch(/wJalr|Hunter2|postgres|AWS_SECRET/);
  });
});

describe('learning capture requires explicit user adoption and honors revocation', () => {
  it.each(['missing-store', 'missing-consent', 'off'])('%s creates zero capture bytes and invokes no learner', mode => {
    const f = adoptedLearning(); fs.rmSync(f.queue, { recursive: true });
    if (mode === 'missing-store') fs.rmSync(path.join(f.home, '.claude/global-memory'), { recursive: true });
    if (mode === 'missing-consent') fs.rmSync(path.join(f.home, '.config/ruvnet-brain/settings.json'));
    if (mode === 'off') fs.writeFileSync(path.join(f.home, '.config/ruvnet-brain/settings.json'), '{"learningScope":"off"}');
    const result = captureLearning(f, 'denied', 'npm test'); expect(result.status).toBe(0); expect(fs.existsSync(f.queue)).toBe(false); expect(f.readCalls()).toEqual([]);
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

  it('TEETH: SessionStart stays neutral while the prompt gate carries its compact L4 contract', () => {
    const out = session().stdout;
    expect(out).toContain('RuvNet Brain active');
    expect(out).not.toContain('standing build playbook');
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
// `protect-state 10020ms KILLED@guard`, `route-dispatch 10011ms KILLED@guard`. Nothing but the
// harness's own kill ends them.
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
    'learn-capture.sh', 'ground-before-write.sh', 'grounding-stamp.sh',
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
