#!/usr/bin/env node
// hook-shim.mjs — the Stable Spine's hook dispatcher (ADR-023, docs/INTELLIGENT-UPDATING.md §3).
//
// THE ONE JOB: make hook BEHAVIOR update without a Claude Code restart. CC freezes
// ${CLAUDE_PLUGIN_ROOT} at boot (a version-named cache dir), so any hook command pointing there is
// trapped at the boot-time version. This shim is the only thing hooks.json points at; it resolves
// the ACTIVE generation from ~/.cache/ruvnet-brain/active.json ONCE per invocation and executes the
// hook body from that immutable versions/<v>/ tree. Update = rewrite active.json (atomic, by
// scripts/update-apply.mjs) → the very next hook fire runs the new code. No restart.
//
// SHELL CONTRACT (this file is boot-frozen — treat as near-frozen ABI, per DDD-0003):
//   • Self-contained: node:fs/path/os/child_process/url builtins, plus the sibling
//     hook-shim-bash.mjs (bash-interpreter resolution, issue #38) — colocated in this same
//     boot-frozen scripts/ dir, never resolved from the spine. No imports from the hook BODY.
//   • Typed dispatch table (red-team findings 15/16/30): each hook declares its file, interpreter,
//     and mode. `blocking` hooks propagate their exact exit code (route-dispatch's deliberate
//     exit-2 wall survives by CONTRACT); `advisory` hooks can never block a turn — any failure,
//     including a missing file, exits 0.
//   • Containment (finding 13): a codeRoot is honored ONLY if it resolves under
//     ~/.cache/ruvnet-brain/versions/ — or is the explicit dev-mode checkout declared in
//     ~/.cache/ruvnet-brain/dev.json (finding 24).
//   • Loud fallback (finding 25): no spine / broken spine / missing body file → run the sibling in
//     ${CLAUDE_PLUGIN_ROOT} AND emit one stderr line naming the frozen fallback, so a broken spine
//     can never masquerade as health. First-install (spine never seeded) stays quiet.
//   • Per-invocation consistency (finding 14, accepted middle): active.json is read once; the whole
//     invocation runs from one immutable tree — a hook never straddles two generations.
//   • Brain OFF is a CONTRACT PER HOOK, not one early-exit (ADR-054 §3): each table entry declares
//     `offBehavior`, resolved ONCE per invocation against the sentinel (see BRAIN_OFF below).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBash, skipNoBash } from './hook-shim-bash.mjs';

const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const ACTIVE = path.join(BRAIN_HOME, 'active.json');
const DEV = path.join(BRAIN_HOME, 'dev.json');
const VERSIONS = path.join(BRAIN_HOME, 'versions');
// fileURLToPath, not URL.pathname: on Windows, pathname yields "/C:/…" which path.resolve mangles
// into "C:\C:\…" — the fallback silently pointed at a nonexistent tree (issue #38).
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── BRAIN OFF (ADR-054 §2/§4) — resolved ONCE, here, for the whole invocation. ──────────────────
//
// A bare existsSync on the sentinel, on purpose and by contract. This file is BOOT-FROZEN, so it may
// not import scripts/brain-state.mjs (that module lives in the spine, outside this frozen tree, and
// an import of it would reintroduce exactly the version-straddling this shim exists to prevent).
// The duplication is deliberate and is held by test, not by comment: tests/unit/brain-off.test.mjs
// drives the REAL shim against the REAL sentinel path, so a drift between the two copies goes red.
//
// The read happens once and is carried through the rest of the invocation (ADR-054 §4, per-operation
// snapshot) — a hook must never straddle a mid-flight flip any more than it straddles two generations.
// statSync, not existsSync: existsSync does not throw on EACCES, it returns false — so an unreadable
// state directory reported "no sentinel" and silently switched a user's brain back on. Only genuine
// absence (ENOENT/ENOTDIR) means ON; every other error means we cannot tell, and "cannot tell" must
// not override a choice the user already made. Same rule, same codes, as scripts/brain-state.mjs.
const BRAIN_STATE_DIR = process.env.RUVNET_BRAIN_STATE_DIR || path.join(os.homedir(), '.config', 'ruvnet-brain');
let BRAIN_OFF = false;
try { fs.statSync(path.join(BRAIN_STATE_DIR, 'brain-off')); BRAIN_OFF = true; }
catch (e) { BRAIN_OFF = !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }

// The dispatch table — hook id → { file (relative to <codeRoot>/plugin/scripts), interpreter, mode,
// offBehavior }. Adding a hook here is a SHELL change (requiresRestart); changing a BODY never is.
//
// `offBehavior` is the per-plane OFF contract (ADR-054 §3), as DATA rather than as ifs scattered
// through nine scripts. Both duel reviewers converged on why one boolean kill-switch is wrong: it
// either lies about being off (something keeps speaking) or it over-kills (it removes protections
// that have nothing to do with retrieval). So each hook states its own answer:
//
//   'silence' — this hook exists to advertise, ground, or learn. Off means it does not run at all
//               and writes ZERO bytes. Nothing downstream can tell it apart from not being installed.
//   'run'     — this is a SAFETY WALL that guards money or honesty, not retrieval. route-dispatch
//               stops a subagent fan-out inheriting an expensive model; design-wall stops an
//               ungraded surface shipping; protect-state guards the user's own consent record.
//               None becomes acceptable because retrieval is off.
//   'partial' — the hook splits INTERNALLY. session-start-core still runs the auto-updater heartbeat, the
//               GONG health alarm and the SLA banner (an off machine must still receive fixes,
//               otherwise the fix for an off-state bug can never arrive) while suppressing every
//               advertising byte. The snapshot is forwarded as RUVNET_BRAIN_OFF so the body reads
//               ONE resolved answer instead of racing the filesystem again mid-run.
const TABLE = {
  'session-start':    { file: 'session-start-core.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'partial' },
  'ground-ruvnet':    { file: 'ground-ruvnet.sh',    interpreter: 'bash', mode: 'advisory', offBehavior: 'silence' },
  'hijack-ruvnet':    { file: 'hijack-ruvnet.sh',    interpreter: 'bash', mode: 'advisory', offBehavior: 'silence' },
  'route-dispatch':   { file: 'route-dispatch.sh',   interpreter: 'bash', mode: 'blocking', offBehavior: 'run' },
  'ground-before-write': { file: 'ground-before-write.sh', interpreter: 'bash', mode: 'blocking', offBehavior: 'run' },
  'grounding-stamp': { file: 'grounding-stamp.sh', interpreter: 'bash', mode: 'advisory', offBehavior: 'silence' },
  'verify-interface': { file: 'verify-interface.sh', interpreter: 'bash', mode: 'advisory', offBehavior: 'silence' },
  'design-wall':      { file: 'design-wall.sh',      interpreter: 'bash', mode: 'blocking', offBehavior: 'run' },
  // The consent guard (ADR-054 §3): it protects the OFF state itself, so it is the one hook that
  // matters MORE while the brain is off. 'run', permanently.
  'protect-state':    { file: 'protect-brain-state.sh', interpreter: 'bash', mode: 'blocking', offBehavior: 'run' },
  'learn-capture':    { file: 'learn-capture.sh',    interpreter: 'bash', mode: 'advisory', offBehavior: 'silence' },
  'learn-flush':      { file: 'learn-flush.mjs',     interpreter: 'node', mode: 'advisory', offBehavior: 'silence' },
  'md-stamp':         { file: 'md-stamp.mjs',        interpreter: 'node', mode: 'advisory', offBehavior: 'silence' },
  // THE EXTERNAL-SIGNAL WATCH PLANE, W1 OBSERVED (ADR-058 §D3; DDD-0013 Context 2). PostToolUse,
  // matcher ^Bash$ (anchored — an unanchored matcher is F3/F4). Classifies gh/vercel/netlify/npm
  // publish/git push in EXECUTABLE POSITION (hook-input.mjs's findInvocations(), never a grep) and,
  // on a successful `git push`, opens a pending CI-verdict debt that scripts/signal-watch.mjs (a
  // SEPARATE process, SEPARATE cadence) resolves later via `gh run list`. offBehavior 'silence' per
  // the ADR's explicit instruction: this plane observes and advises, it never guards money or
  // honesty on its own — the git-push debt it opens is only ever SURFACED (never gated) by
  // session-start-core.mjs, and that surfacing already lives under SessionStart's 'partial' contract.
  'signal-watch':     { file: 'signal-watch.mjs',    interpreter: 'node', mode: 'advisory', offBehavior: 'silence' },
  'routing-outcome':  { file: 'routing-outcome-capture.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'run' },
  // The unprompted-speech chokepoint (ADR-040 / DDD-0004). ONE runtime is the sole writer of
  // user-facing bytes for every unprompted hook: it spawns the real producers (anticipate, lesson)
  // in candidate mode, applies the per-channel policy, and writes the final envelope itself. `channel`
  // marks it as the unprompted seam. It is mode:'blocking' on purpose — the runtime decides its own
  // exit code, and an opted-in lesson BLOCK must propagate as exit 2 (an advisory delivery is exit 0
  // and passes straight through; a spawn error is exit 1, which CC treats as a non-blocking notice).
  // The CC event name is forwarded to the runtime as an extra argv (see runHook's arg plumbing).
  'unprompted-speech': { file: 'unprompted-runtime.mjs', interpreter: 'node', mode: 'blocking', channel: 'unprompted', offBehavior: 'silence' },
  // THE LIFECYCLE PLANE (ADR-055 §2, build item 1). Stop was the ONE registered hook that bypassed
  // this table entirely — hooks.json pointed straight at continuation-gate.mjs, so it had no mode,
  // no offBehavior, and no spine resolution, contradicting this file's own `_note` and leaving
  // ADR-054's off-contract undefined for the only event that can force a turn to continue
  // (ADR-055 F5/F14). Routing it here costs nothing behaviourally — `mode:'advisory'` forces exit 0
  // exactly as the `|| true` it replaces did — and buys the two things F5 was about: a hot body via
  // the spine, and a declared answer to "what happens when the brain is off".
  //
  // offBehavior 'run', DECIDED (ADR-055 left this open by name: "Stop — undecided today, F5).
  // ADR-054's rule is the discriminator, applied literally: 'silence' is for hooks whose job is to
  // ADVERTISE, GROUND, or LEARN; 'run' is for walls that guard money or honesty rather than
  // retrieval. The continuation gate does none of the first three — it reads the user's own work
  // ledger, needs no corpus, no network and no brain — and it does the last: ADR-043 exists because
  // a turn ending clean on an open commitment is a dishonest turn. Switching retrieval off is not
  // consent to abandon work mid-goal, and a gate that disarmed itself there would be the ADR-054
  // over-kill failure exactly.
  // FORWARD NOTE, deliberately not pre-declared: ADR-055 §3.4 gives this gate a SECOND input —
  // grounding debt — which IS brain-dependent. When build item 6 lands, this entry becomes
  // 'partial' (work-ledger retained, grounding-debt bytes suppressed). Declaring 'partial' today
  // would declare a split that does not exist, which is the ceremony ADR-055 §4 refuses by name.
  'continuation-gate': { file: 'continuation-gate.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'run' },
};

const hookId = process.argv[2];
const entry = TABLE[hookId];
if (!entry) {
  process.stderr.write(`[hook-shim] unknown hook id: ${JSON.stringify(hookId)} — known: ${Object.keys(TABLE).join(', ')}\n`);
  process.exit(0); // an unknown id is a shell bug, but it must never block the user's turn
}

// The 'silence' contract, enforced before ANY work: no spine resolution, no spawn, no stderr — not
// even the loud-fallback line, because a broken spine is not news to a user who switched the brain
// off. Exit 0 unconditionally: a silenced hook is the absence of a hook, and the absence of a hook
// never blocks a turn. An unknown/absent offBehavior defaults to running, so a future entry that
// forgets to declare one fails toward the pre-ADR-054 behaviour rather than toward silent death.
if (BRAIN_OFF && entry.offBehavior === 'silence') process.exit(0);

// The ground hook is registered on every prompt. On Windows, starting Git Bash and then jq can
// consume most of the hook's five-second declaration before an unrelated prompt reaches the
// shell body's "emit nothing" verdict. Read a bounded copy here, in the Node process that is
// already running, and skip the interpreter entirely only when BOTH prompt intent and project
// state prove that no advisory can fire. The regex deliberately over-approximates the shell gates:
// false positives take the established body; false negatives would be a product defect.
let groundInput = null;
const GROUND_RELEVANT = /ruvnet|ruflo|ruvector|\brvf\b|agentdb|agenticow|rulake|ruview|rupixel|ruv-fann|agentic-flow|synthlang|dspy|qudag|safla|metaharness|cve-bench|sparc|swarm|claude-flow|pinecone|pgvector|chroma|weaviate|faiss|milvus|qdrant|hnswlib|annoy|vector|langchain|llama|autogen|crew-ai|semantic-kernel|embedding|retrieval|prompt compression|token cost|post-quantum|quantum-resistant|\badr\b|decision|architect|design|plan|spec|refactor|migrat|implement|build|write|add|change|fix|update|deploy|create|enhance|set up|setup|wire|integrate|test|coverage|audit|review|benchmark|lint|scan|debug|optimi|app|feature|service|system|backend|frontend|\bapi\b|module|pipeline|infra|database|schema|workflow|roadmap|milestone|autonomous|unattended|do not stop|keep working|keep going|soak run|harness|quality|readiness|evolve|self-improv|hardening|cheaper|cheap|lower cost|compute arbitrage|cascade|scorecard|score .*repo/i;

function projectCanSpeakWithoutPrompt() {
  if (process.env.RUVNET_AUTONOMOUS === '1') return true;
  try {
    if (fs.existsSync(path.join(process.cwd(), '.claude-flow')) ||
        fs.existsSync(path.join(process.cwd(), '.swarm'))) return true;
    for (const name of ['package.json', '.mcp.json']) {
      try {
        if (/claude-flow|ruflo/i.test(fs.readFileSync(path.join(process.cwd(), name), 'utf8'))) return true;
      } catch { /* absent/unreadable project metadata cannot create an advisory */ }
    }
  } catch { /* fail toward running the body below */ return true; }
  return false;
}

function readGroundInput() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let idle;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      process.stdin.pause();
      resolve(Buffer.concat(chunks));
    };
    const armIdle = () => {
      clearTimeout(idle);
      // Claude closes stdin immediately. The short idle boundary exists for malformed hosts and
      // selfcheck's intentionally-held pipe, so neither can freeze this already-running shim.
      idle = setTimeout(finish, 100);
      idle.unref?.();
    };
    process.stdin.on('data', (chunk) => {
      if (bytes < 32768) {
        const kept = chunk.subarray(0, 32768 - bytes);
        chunks.push(kept);
        bytes += kept.length;
      }
      armIdle();
    });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
    armIdle();
    process.stdin.resume();
  });
}

/** Resolve the active code root. Returns { root, source } or null (→ fallback). */
function resolveCodeRoot() {
  // Dev mode wins when explicitly declared and the target still looks like the checkout it names.
  try {
    const dev = JSON.parse(fs.readFileSync(DEV, 'utf8'));
    if (dev && dev.codeRoot && fs.existsSync(path.join(dev.codeRoot, 'scripts'))) {
      return { root: dev.codeRoot, source: 'dev' };
    }
  } catch { /* no dev mode */ }
  try {
    const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    if (!active || typeof active.codeRoot !== 'string') return null;
    const root = path.isAbsolute(active.codeRoot) ? active.codeRoot : path.join(BRAIN_HOME, active.codeRoot);
    const real = fs.realpathSync(root);
    // Containment: only ever execute from the immutable version store.
    if (!real.startsWith(fs.realpathSync(VERSIONS) + path.sep)) return null;
    return { root: real, source: `gen ${active.generation ?? '?'}` };
  } catch { return null; }
}

// Run one hook body. No shell is ever involved: spawnSync with an argument array, interpreter
// chosen from the typed table — never from input.
function runHook(file) {
  if (!fs.existsSync(file)) return 0; // nothing to run — never invent a failure
  let cmd;
  if (entry.interpreter === 'node') {
    cmd = process.execPath;
  } else {
    cmd = resolveBash();
    // No bash on this machine (issue #38, typically win32 without Git for Windows): skip the hook
    // rather than spawnSync ENOENT on every tool call. Both blocking and advisory modes return 0 —
    // an unsupported platform must not degrade the session.
    if (!cmd) return skipNoBash(BRAIN_HOME);
  }
  // Forward any argv AFTER the hook id to the hook body. Every current hooks.json line calls
  // `hook-shim.mjs <id>` with no trailing args, so slice(3) is empty and their behavior is unchanged.
  // The unprompted-speech chokepoint uses this to receive the CC event name:
  // `hook-shim.mjs unprompted-speech UserPromptSubmit` → `unprompted-runtime.mjs UserPromptSubmit`.
  const extraArgs = process.argv.slice(3);
  // Forward the ONE resolved OFF snapshot to a 'partial' body (ADR-054 §4). The native SessionStart
  // core also reads the sentinel because the POSIX compatibility launcher and bare installs invoke
  // it outside this shim. Passing the snapshot means the two readings cannot disagree within one
  // invocation if the user flips the switch while the hook is mid-run.
  const env = (BRAIN_OFF && entry.offBehavior === 'partial')
    ? { ...process.env, RUVNET_BRAIN_OFF: '1' }
    : process.env;
  const io = hookId === 'ground-ruvnet' && groundInput !== null
    ? { stdio: ['pipe', 'inherit', 'inherit'], input: groundInput }
    : { stdio: 'inherit' };
  const r = spawnSync(cmd, [file, ...extraArgs], { ...io, env });
  if (r.error) {
    process.stderr.write(`[hook-shim] ${entry.file}: ${r.error.message}\n`);
    return entry.mode === 'blocking' ? 1 : 0;
  }
  // Blocking hooks: the exit code IS the contract (route-dispatch's exit-2 wall). Advisory: always 0.
  return entry.mode === 'blocking' ? (r.status ?? 0) : 0;
}

function dispatchHook() {
  const fallbackFile = path.join(PLUGIN_ROOT, 'scripts', entry.file);
  const spine = resolveCodeRoot();
  if (spine) {
    // codeRoot IS a plugin-payload root (versions/<v>/ mirrors the plugin dir: scripts/, hooks/, mcp/).
    const spineFile = path.join(spine.root, 'scripts', entry.file);
    if (fs.existsSync(spineFile)) {
      return runHook(spineFile);
    }
    // Spine resolved but the body file is missing — fall back LOUDLY (finding 25).
    process.stderr.write(`[hook-shim] spine (${spine.source}) missing ${entry.file} — falling back to frozen plugin\n`);
    return runHook(fallbackFile);
  }
  // No spine at all. First-install is the normal quiet case; a previously-seeded-but-broken spine
  // still lands here — the seed marker distinguishes them so breakage is loud, first-run silent.
  if (fs.existsSync(path.join(BRAIN_HOME, '.spine-seeded'))) {
    process.stderr.write(`[hook-shim] spine unreadable — running frozen plugin fallback (run: node scripts/update-apply.mjs --doctor)\n`);
  }
  return runHook(fallbackFile);
}

if (hookId === 'ground-ruvnet') {
  readGroundInput().then((input) => {
    groundInput = input;
    let text = input.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      text = parsed?.prompt ?? parsed?.user_prompt ?? parsed?.input ?? text;
    } catch { /* raw/malformed input is classified as-is */ }
    if (!GROUND_RELEVANT.test(String(text)) && !projectCanSpeakWithoutPrompt()) process.exit(0);
    process.exit(dispatchHook());
  }).catch(() => process.exit(dispatchHook()));
} else {
  process.exit(dispatchHook());
}
