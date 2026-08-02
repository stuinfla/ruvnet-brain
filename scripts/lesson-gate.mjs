#!/usr/bin/env node
/**
 * lesson-gate.mjs — the wire that makes a stored lesson actually change behaviour.
 *
 * THIS IS THE L3 STEP. ADR-029 mines which lessons are universal; ADR-030 says a lesson must
 * INTERRUPT at a decision point or it is prose. Both shipped. And nothing read the store: a grep for
 * `lessonsFor` across every gate returned zero. Lessons were written, schema-validated, weighted,
 * trust-boundaried — and consumed by nobody.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, 2026-07-22, and it is two separate corrections that happen to point the same way.
 *
 * CORRECTION 1 — THE BLOCK NEVER BLOCKED. Two independent reviewers found it; running it confirmed
 * it. The previous version printed the word "BLOCKED" and then allowed the action, in three
 * compounding ways:
 *
 *     scripts/lesson-gate.mjs:86     exited 1, not 2. Exit 1 is a NON-BLOCKING error: the live hooks
 *                                    doc says other non-zero codes show a "hook error" notice to the
 *                                    USER and "execution continues". Only exit 2 refuses anything.
 *     scripts/lesson-gate.mjs        15 console.log, 0 console.error. On exit 2 the doc is explicit:
 *                                    "Claude Code ignores stdout... stderr text is fed back to
 *                                    Claude". The refusal reason went to the one stream a refusal
 *                                    cannot use.
 *     plugin/scripts/lesson-hooks.sh `|| true` then exit 0 — discarding whatever code did survive.
 *
 * Measured before the fix:  `bash plugin/scripts/lesson-hooks.sh Stop` → printed "⛔ BLOCKED", exit 0.
 *
 * ADR-028 claimed "five gates exit 1 and refuse the action — proven by exit code". That proof was
 * obtained by running this file BY HAND on a terminal, which is the one caller that is not a hook.
 * The exit code was real; the claim that it blocked anything was not. This is L01 — verify through a
 * channel CAPABLE of observing the change — violated by the very file that enforces L01.
 *
 * CORRECTION 2 — AND WE DO NOT WANT IT TO BLOCK. The owner, the same day:
 *
 *     "Nudging somebody is very fair. Forcing them through a gate is not."
 *     "That respect for the individual and how they do it is a big part of the win."
 *
 * So the fix is NOT to turn six silent blocks into six real ones. That would ship, for the first
 * time, the product the owner has just rejected — and it would land on existing users as a machine
 * that suddenly started refusing work it accepted yesterday. Every ratified `block` lesson is now a
 * NUDGE. Blocking is a per-lesson decision the USER makes, in a file only the user writes.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT, verified against code.claude.com/docs/en/hooks on 2026-07-22 rather than recalled:
 *
 *   NUDGE  → exit 0 + JSON `hookSpecificOutput.additionalContext` on stdout.  Informs, never refuses.
 *   BLOCK  → exit 2 + reason on stderr.  Refuses. Opt-in per lesson, by the user, only.
 *
 * The nudge channel is NOT stderr, and this is the subtle part that a plausible-sounding design got
 * wrong twice. On exit 0 the doc says stdout "is written to the debug log but not shown in the
 * transcript" for most events, with only UserPromptSubmit / UserPromptExpansion / SessionStart as
 * exceptions — and it says nothing about exit-0 stderr at all, because exit-0 stderr is not a
 * delivery channel. A nudge written to stderr at Stop or PreToolUse reaches NOBODY: it would have
 * been the identical built-tested-unwired defect, rebuilt one file to the left.
 *
 * What actually works, quoted from the live doc:
 *
 *     "The `additionalContext` field passes a string from your hook into Claude's context window.
 *      Claude Code wraps the string in a system reminder and inserts it into the conversation at the
 *      point where the hook fired."
 *
 * and it is supported at every event this gate fires on — PreToolUse, Stop, UserPromptSubmit
 * included. (An adversarial review asserted a non-blocking nudge at Stop was IMPOSSIBLE because Stop
 * accepts only `decision: "block"`. The live doc contradicts it: "Stop and SubagentStop also accept
 * hookSpecificOutput.additionalContext for non-error feedback that continues the conversation." The
 * reviewer was reasoning from an older contract. Checked, not assumed — which is the whole rule.)
 *
 * That gives a nudge everything the block was supposed to have and the one thing it should not:
 * it reaches the model, at the decision point, carrying the user's own words — and it refuses nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DESIGN CONSTRAINT, unchanged and load-bearing: a gate must never break the thing it guards. Any
 * failure here — missing store, corrupt JSON, unreadable file — exits 0 silently. A lesson gate that
 * blocked a push because it could not read a config file would be worse than no lesson gate, and
 * would be switched off within a day, which is how every over-eager gate dies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLessons, lessonsFor, ENFORCEMENT, STATUS, ORIGIN, TRIGGERS } from './lesson-store.mjs';

// The two codes that mean something to the harness. Anything else is an error, and an error here
// must never be mistaken for a refusal — see ALLOW-on-failure throughout.
const EXIT_ALLOW = 0;
const EXIT_BLOCK = 2;

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
// --trigger is REPEATABLE. One real event carries several decision points at once (ending a turn is
// simultaneously "reporting status" and "claiming done"), and they must resolve to ONE verdict and
// ONE JSON object — two JSON documents on stdout is not JSON, and two node spawns on every event is
// latency on the hot path for no gain.
const allArgs = (f) => argv.reduce((acc, v, i) => (v === f && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const triggers = allArgs('--trigger');
const event = arg('--event');          // the real Claude Code event name → hook mode
const quiet = argv.includes('--quiet');
const json = argv.includes('--json');
// Session identity for the per-session frequency cap (below). The dispatcher passes the harness's
// real session_id; a caller that predates this (or a manual run) gets a cwd+day fallback so the cap
// is still BOUNDED — at worst it repeats an advisory once per project per day — rather than unbounded.
const session = arg('--session');
// NOT `arg('--command')`: that helper treats a falsy VALUE the same as an ABSENT flag
// (`argv[i+1] ? ... : d`), so a real event whose command happens to be "" would silently fall back to
// the unfiltered default — precisely the false-nag path this fix exists to close. Presence of the flag,
// not truthiness of its value, is what distinguishes "an old caller that never learned about this" from
// "the dispatcher, telling us the command text (however short)".
const commandIdx = argv.indexOf('--command');
const command = commandIdx >= 0 ? (argv[commandIdx + 1] ?? '') : null;

// CANDIDATE MODE (ADR-040 / DDD-0004 "the enforcement chokepoint"). Set by unprompted-runtime.mjs on
// every producer child. When on, hook mode writes ZERO user-facing bytes and NEVER exits 2 itself:
// it emits ONE JSON candidate per line on stdout and lets the runtime — the SOLE writer of user bytes
// — turn a `block` candidate into the real exit 2 + stderr and an `advisory` candidate into the
// nudge. Unset (every direct/legacy/CLI invocation, and every existing test), behaviour is byte-for-
// byte unchanged, exit-2 block semantics included. Purely additive.
const EMIT_CANDIDATES = process.env.RUVNET_EMIT_CANDIDATES === '1';

/**
 * THE MUTATE-MACHINE PREDICATE — narrows "about to change something outside this repo" to commands
 * that plausibly do that, instead of firing on every Bash call.
 *
 * THE BUG, found by an independent grader reading real session transcripts (2026-07-22/23): the
 * dispatcher maps `PreToolUse-bash` → `--trigger mutate-machine` UNCONDITIONALLY —
 * plugin/scripts/lesson-hooks.sh:98 — with no inspection of the command at all. Not a weak keyword
 * match: NO match. Every `ls`, `grep`, `wc`, `git status`, `git rev-parse` fired the identical L07
 * advisory, ~10x/session verbatim. A true finding repeated on false triggers is exactly the nagging
 * ADR-030's own P3 (nudge, never force) exists to prevent — a correct lesson trains itself to be
 * ignored by firing when it has nothing to say.
 *
 * THE FIX is an ALLOWLIST OF MUTATING PATTERNS, not a read-only allowlist — chosen because the
 * trigger's own label is "about to change something", so the honest default for an unrecognized
 * command is SILENCE, not suspicion. Under-firing on some obscure mutating command is the safe
 * failure mode for an advisory nudge; over-firing is the bug this whole fix exists to close.
 *
 * Every pattern is anchored to COMMAND POSITION (the leading word of a shell segment), never a bare
 * substring search — the same discipline verify-interface.sh already uses and for the identical
 * reason: an unanchored match fires on `grep -r "npm install -g" .` or `echo "curl -X POST"`, which
 * would reintroduce the exact false-positive nagging this fix removes, just spelled differently.
 *
 * Known, accepted limitation: command substitution (`$(rm -rf ~/x)`) and path traversal (`../../etc`)
 * are not resolved — this is a heuristic for an ADVISORY nudge, not a security boundary. It is
 * layered on top of the existing consent/ratification trust boundary (ORIGIN/STATUS/opt-in above),
 * which is where the real security property already lives.
 */
const REPO_ROOT = (() => {
  let d = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return process.cwd();
})();

/** Split on top-level `;`, `&&`, `||`, `&`, `|`, newline — NOT inside single/double quotes. One
 *  compound command ("cmd1 && rm -rf ~/x") must be judged by its most dangerous segment, not its first. */
function splitTopLevelSegments(cmd) {
  const segments = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { segments.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n') { segments.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Whitespace tokenizer that keeps a quoted argument ("a path with spaces") as ONE token. */
function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) { if (cur) { tokens.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const SYSTEM_PATH_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/private', '/var', '/opt'];
/** A path argument that targets a system-wide location — "chmod 777 /etc/x", never "chmod +x ./run.sh". */
function isSystemAbsolutePath(tok) {
  if (!tok || tok.startsWith('-')) return false;
  return SYSTEM_PATH_PREFIXES.some((p) => tok === p || tok.startsWith(p + '/'));
}
/** A path argument that resolves OUTSIDE this repo — a bare `~` reference, or an absolute path that
 *  is not rooted under REPO_ROOT. A relative path ("./tmp", "build") is inside the repo by construction. */
function isOutsideRepoPath(tok) {
  if (!tok || tok.startsWith('-')) return false;
  if (tok.startsWith('~')) return true;
  if (tok.startsWith('/')) return tok !== REPO_ROOT && !tok.startsWith(REPO_ROOT + path.sep);
  return false;
}
/** curl mutates when it names a non-GET verb or attaches a request body — "-X POST", "--data", etc. */
function curlMutates(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '-X' || t === '--request') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((tokens[i + 1] || '').toUpperCase())) return true;
    if (/^--request=/.test(t) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(t.split('=')[1].toUpperCase())) return true;
    if (t === '-d' || t === '--data' || /^--data(-raw|-binary|-urlencode)?$/.test(t) || t === '--upload-file' || t === '-T') return true;
  }
  return false;
}

const INSTALL_VERBS = new Set(['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un']);
const GLOBAL_FLAGS = new Set(['-g', '--global']);
const SECURITY_MUTATING = new Set([
  'create-keychain', 'delete-keychain', 'set-keychain-password', 'set-keychain-settings',
  'unlock-keychain', 'lock-keychain', 'import', 'add-generic-password', 'add-internet-password',
  'delete-generic-password', 'delete-internet-password', 'default-keychain',
]);
const BREW_MUTATING = new Set(['install', 'uninstall', 'remove', 'rm', 'upgrade', 'reinstall', 'tap', 'untap', 'link', 'unlink', 'pin', 'unpin', 'services']);
const PKG_MUTATING = new Set(['install', 'remove', 'purge', 'upgrade']);
const FS_MUTATING_VERBS = new Set(['rm', 'mv', 'cp', 'ln', 'shred', 'truncate', 'unlink']);

/** One shell segment → does its LEADING command plausibly mutate something outside this repo? */
function classifySegment(segment) {
  let tokens = tokenize(segment);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1); // FOO=bar cmd
  if (!tokens.length) return false;
  const lead = tokens[0];
  if (lead === 'sudo') return true; // elevated privilege is outside-repo blast radius by definition
  switch (lead) {
    case 'launchctl': return true; // any subcommand — LaunchAgents/system services, never repo-scoped
    case 'security': return SECURITY_MUTATING.has(tokens[1]);
    case 'defaults': return tokens[1] === 'write' || tokens[1] === 'delete';
    case 'npm': case 'pnpm': case 'yarn':
      return INSTALL_VERBS.has(tokens[1]) && tokens.some((t) => GLOBAL_FLAGS.has(t));
    case 'pip': case 'pip3': case 'pipx':
      return tokens[1] === 'install' || tokens[1] === 'uninstall';
    case 'brew': return BREW_MUTATING.has(tokens[1]);
    case 'gem': return tokens[1] === 'install' || tokens[1] === 'uninstall';
    case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'pacman': case 'port':
      return PKG_MUTATING.has(tokens[1]);
    case 'git': return tokens[1] === 'push';
    case 'curl': return curlMutates(tokens);
    case 'wget': return tokens.some((t) => t.startsWith('--post-data') || t.startsWith('--post-file'));
    case 'chmod': case 'chown': case 'chgrp':
      return tokens.slice(1).some(isSystemAbsolutePath);
    case 'dd': case 'mkfs': case 'diskutil': return true;
    case 'crontab': return tokens[1] === '-e' || tokens[1] === '-r';
    default:
      return FS_MUTATING_VERBS.has(lead) && tokens.slice(1).some(isOutsideRepoPath);
  }
}

/** Exported for the test suite: does this WHOLE command plausibly mutate something outside the repo? */
export function looksLikeOutsideRepoMutation(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return splitTopLevelSegments(cmd).some(classifySegment);
}

/**
 * THE CONSENT FILE — where "yes, actually refuse me" is recorded, and why it is not in the lesson store.
 *
 * Two reasons, and the first is a measured fact rather than a preference:
 *
 * 1. A per-lesson flag in the store WOULD NOT SURVIVE. `makeLesson()` destructures a fixed field set
 *    and returns a frozen object built from exactly those fields; any unknown key is silently
 *    dropped on load. Verified 2026-07-22 by construction — `makeLesson({...,userOptedIntoBlocking:
 *    true})` returns an object without it. A consent flag stored there would read back as absent on
 *    every load, i.e. consent that silently evaporates, which is the worst possible failure mode for
 *    a consent record.
 *
 * 2. It is the right trust boundary anyway. `lessons.json` is written by the MINING pipeline —
 *    unattended, over session transcripts, over content that may have been planted (ADR-031's whole
 *    subject). If "may block" lived in that file, anything that could get a lesson mined could grant
 *    itself the power to refuse the user's work. It lives in a file the pipeline never writes.
 *
 * Honest about what this is NOT: it is not a defence against a model that can run shell commands —
 * such a model can write any file on the machine. It is a boundary against MINED and IMPORTED
 * content reaching enforcement, which is the path the adversarial review actually found.
 *
 * The empty default is the point: no file, no blocking. Consent is never inferred from silence.
 */
export const OPTIN_PATH = process.env.RUVNET_LESSON_OPTIN
  || path.join(os.homedir(), '.config', 'ruvnet-brain', 'blocking-optin.json');

if (!triggers.length) {
  console.log('lesson-gate — surface the lessons in force at a decision point\n');
  console.log('  --trigger <key>   one of: ' + Object.values(TRIGGERS).map((t) => t.key).join(', '));
  console.log('                    repeatable; one event may carry several decision points');
  console.log('  --event <name>    Claude Code event (Stop, PreToolUse, UserPromptSubmit) → hook mode:');
  console.log('                    nudges emit JSON additionalContext (exit 0), blocks emit stderr (exit 2)');
  console.log('  --json            machine-readable');
  console.log('  --quiet           print nothing; exit code only\n');
  console.log('  blocking is OPT-IN per lesson: ' + OPTIN_PATH);
  process.exit(EXIT_ALLOW);
}

function loadBlockingOptIn(file = OPTIN_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Tolerant of both shapes because a human is expected to hand-edit this: a bare array reads
    // fine, and so does the documented object. Being fussy about a consent file's punctuation would
    // silently downgrade someone's explicit "yes" to a "no".
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.blocking) ? raw.blocking : [];
    return new Set(list.filter((x) => typeof x === 'string' && x.length));
  } catch { return new Set(); }   // absent or unparseable → nobody blocks. Never fail INTO refusing.
}

let lessons = [];
try { lessons = loadLessons(); } catch { process.exit(EXIT_ALLOW); }   // never break the caller

const optedIn = loadBlockingOptIn();

/**
 * THE PER-SESSION FREQUENCY CAP — because a true advisory repeated verbatim on every matching event is
 * the nag ADR-030 bans (measured 2026-07-22: the mutate-machine advisory rendered on every Bash call of
 * a session). anticipate.sh already caps its own nudges per session; this is the same discipline for the
 * lesson gate. A PURE-ADVISORY lesson is shown at most MAX_SHOWS times per session, then stays silent
 * until a new session.
 *
 * THE LOAD-BEARING INVARIANT: an actual REFUSAL is never capped. A lesson the user has opted into as a
 * block (isBlocking, below) exits 2 and refuses the action — the cap must never touch it. But a merely
 * block-CAPABLE lesson the user has NOT opted into renders as an ADVISORY (exit 0): it is a reminder, not
 * a refusal, and it is capped like any other advisory. An earlier version exempted block-capable lessons
 * too — which left exactly the lesson doing the nagging (the block-capable "gate on blast radius", never
 * opted in) repeating unbounded on every mutating command; an independent regrade caught it. Capping a
 * block-capable ADVISORY silences no refusal: a refusal exits 2 regardless of this file's display budget,
 * and the one-time "you could turn this into a refusal" offer needs to be seen a few times, not forever.
 *
 * FAIL-OPEN: any error reading or writing the state degrades to the pre-cap behaviour (show it), never to
 * suppression — a gate that goes quiet because it could not read a JSON file is worse than a repeat.
 */
const GATE_STATE_PATH = process.env.RUVNET_LESSON_GATE_STATE
  || path.join(os.homedir(), '.config', 'ruvnet-brain', 'lesson-gate-state.json');
const MAX_SHOWS = (() => {
  const n = Number(process.env.RUVNET_LESSON_MAX_SHOWS);
  return Number.isInteger(n) && n > 0 ? n : 3;
})();
const KEEP_SESSIONS = 20;   // bound the state file to the most-recent sessions, same as anticipate.sh
const SID = (typeof session === 'string' && session.trim())
  ? session.trim()
  : `fallback:${process.cwd()}:${new Date().toISOString().slice(0, 10)}`;
/**
 * BLOCKING = four conditions, all required; the user's opt-in is necessary and NOT sufficient. Defined
 * here (rather than at the emit site) because the frequency cap below must key its exemption on it: the
 * last two conditions are also guaranteed by makeLesson, and are re-asserted deliberately — this is the
 * one place the answer is "refuse the human's work", and a security invariant enforced only at a distance
 * is one refactor from being enforced nowhere.
 */
const isBlocking = (l) => optedIn.has(l.id)
  && l.enforcement === ENFORCEMENT.BLOCK
  && (l.status === STATUS.RATIFIED || l.status === STATUS.ACTIVE)
  && l.origin === ORIGIN.USER_STATED;
/** Exempt from the cap: ONLY a lesson that refuses RIGHT NOW (an opted-in block, exit 2). A block-capable
 *  lesson that is not opted in is an advisory and is capped like any other — see the invariant above. */
const capExempt = isBlocking;
function readGateState() {
  try { const s = JSON.parse(fs.readFileSync(GATE_STATE_PATH, 'utf8')); return s && typeof s === 'object' ? s : {}; }
  catch { return {}; }
}
function writeGateState(st) {
  try {
    fs.mkdirSync(path.dirname(GATE_STATE_PATH), { recursive: true });
    fs.writeFileSync(GATE_STATE_PATH, JSON.stringify(st));
    return true;
  } catch { return false; }
}
/** How many times THIS session has already surfaced a given advisory lesson (0 if never). */
function shownCount(st, id) {
  const c = st?.sessions?.[SID]?.shown?.[id];
  return Number.isInteger(c) && c > 0 ? c : 0;
}
// Read ONCE, up front — the same snapshot gates the filter and seeds the write below.
const gateState = event ? readGateState() : {};

// Merge every requested decision point into one ranked, de-duplicated list. A lesson registered at
// two triggers must appear once, or the model reads the same correction twice and learns to skim.
/**
 * PROJECT SCOPE — a lesson learned in one project has no standing to interrupt work in another.
 *
 * THE BREAKAGE, 2026-07-22: these hooks were installed machine-wide and 8 of 16 lessons were scoped
 * to a SINGLE project, yet fired everywhere. A WhitSentry session was being told about
 * ruvnet-brain's stop-and-report habit on every prompt. The owner's report was blunt: "I've got
 * other repos that are using this thing, and they're breaking."
 *
 * The rule is ADR-029's own promotion bar applied at read time: cross-project rediscovery is what
 * makes a lesson universal. Taught in ONE project, it is local knowledge — real, worth keeping, and
 * not entitled to speak elsewhere. Taught in two or more, it has earned the right to travel.
 *
 * This is P3 (nudge, never force) and P4 (the user is the arbiter) applied to OUR OWN footprint:
 * the fastest way to make someone uninstall a nudge is to nudge them about something that has
 * nothing to do with what they are doing.
 */
const HERE = (() => {
  let d = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) { d = process.cwd(); break; }
    d = up;
  }
  return path.basename(d);
})();
/** Does this lesson belong to the project we are standing in? Match is loose on purpose — stored
 *  names carry prefixes like `Code-` that the directory name does not. */
const isHome = (l) => {
  const ps = Array.isArray(l.projects) ? l.projects : [];
  if (!ps.length) return true;                       // unscoped: applies anywhere, by declaration
  return ps.some((p) => {
    const n = String(p).replace(/^Code-/, '');
    return n === HERE || String(p) === HERE || HERE.endsWith(n) || n.endsWith(HERE);
  });
};
const isUniversal = (l) => Array.isArray(l.projects) && l.projects.length >= 2;

// Apply the mutate-machine predicate defined above. `mutate-machine` is requested for EVERY Bash
// call (plugin/scripts/lesson-hooks.sh:98) — it is the ONLY trigger the dispatcher fires unconditionally
// on a tool, so it is the only one that needs narrowing here. When no `--command` was supplied (a bare
// CLI invocation, or a caller that predates this fix), behavior is UNCHANGED — fail open to the old,
// unfiltered behavior rather than silently swallow a trigger nobody asked to have filtered.
const MUTATE_KEY = TRIGGERS.MUTATE_MACHINE.key;
const effectiveTriggers = command === null
  ? triggers
  : triggers.filter((t) => t !== MUTATE_KEY || looksLikeOutsideRepoMutation(command));

const seen = new Set();
const candidates = [];
for (const t of effectiveTriggers) {
  for (const l of lessonsFor(t, lessons, { limit: 3 })) {
    if (seen.has(l.id)) continue;
    // Away from home, only a lesson with cross-project evidence may speak.
    if (!isHome(l) && !isUniversal(l)) continue;
    seen.add(l.id); candidates.push(l);
  }
}

/**
 * THE CHARACTER BUDGET — because an event can now carry four decision points.
 *
 * Measured 2026-07-22: UserPromptSubmit rendered 6 lessons / 3,757 characters, injected on EVERY
 * prompt. That is not a reminder, it is a wall, and a wall gets skimmed and then switched off —
 * which costs the user every lesson at once, including the ones that were working.
 *
 * Budget the COST, not the COUNT: a lesson is ~300 chars, so "three lessons" and "900 characters"
 * are the same rule until an unusually long lesson arrives, and then only the character rule holds.
 *
 * Ranked by repeatCount — how many times the user has actually had to say it — so the correction
 * they are most tired of repeating is the one that always survives the trim.
 *
 * AND THE TRIM IS ANNOUNCED. A silent truncation reads as "that is all there is", which is the same
 * lie as a silent cap one layer up. If something was dropped, the model is told how many and where
 * to read the rest.
 */
const NUDGE_CHAR_BUDGET = Number(process.env.RUVNET_NUDGE_BUDGET) || 1200;
// PER-SESSION FREQUENCY CAP (hook mode only — a human running the CLI asked to see everything). Drop a
// PURE-ADVISORY lesson already shown MAX_SHOWS times this session; a block-capable lesson passes untouched
// (capExempt), so a refusal the user opted into is never silenced to reduce noise.
const capped = event
  ? candidates.filter((l) => capExempt(l) || shownCount(gateState, l.id) < MAX_SHOWS)
  : candidates;
const ranked = [...capped].sort((a, b) => (b.repeatCount || 0) - (a.repeatCount || 0));

/* ONE VOICE PER DECISION POINT, BEFORE ANY SECOND VOICE.
 *
 * Ranking by repeatCount alone has a failure mode that hid a lesson for its entire life. An event can
 * carry several triggers at once — UserPromptSubmit now fires five — and the character budget is
 * spent strictly in repeat-count order. So the lessons attached to ONE trigger, if they happen to be
 * the most-repeated, consume the whole budget and every OTHER decision point that genuinely fired
 * goes silent.
 *
 * Measured 2026-07-24: L16-parallel-by-default (trigger `choose-work`, taught 4x, weight ~0.5) was
 * competing against L14-architecture-recipe (36x, 4.13) and L02-check-before-you-assert (28x, 4.50).
 * It could never win a slot — not because it was irrelevant to the moment, but because a DIFFERENT
 * aspect of the same moment had louder lessons. The owner had to supply that correction by hand a
 * fourth time, and the honest diagnosis was: the lesson was in force and structurally unseeable.
 *
 * repeatCount measures HOW OFTEN A LESSON HAS BEEN NEEDED. It does not measure how relevant it is to
 * the decision in front of us, and treating it as a global priority silently converts "taught most
 * often overall" into "the only thing you may be told right now."
 *
 * So: seed the set with the single highest-ranked lesson per DISTINCT TRIGGER that fired, then spend
 * whatever budget remains by rank as before. Each decision point that fired gets to say one thing;
 * the loudest lessons still fill the rest. The first-lesson overrun allowance is preserved.
 */
const seeded = [];
const seenTriggers = new Set();
for (const l of ranked) {
  if (seenTriggers.has(l.trigger)) continue;
  seenTriggers.add(l.trigger);
  seeded.push(l);
}
const order = [...seeded, ...ranked.filter((l) => !seeded.includes(l))];

const inForce = [];
let spent = 0;
for (const l of order) {
  const cost = renderLesson(l, '·').length;
  // Always admit the first lesson even if it alone exceeds the budget — a budget that can render
  // nothing is worse than a budget that overruns once.
  if (inForce.length && spent + cost > NUDGE_CHAR_BUDGET) continue;
  inForce.push(l); spent += cost;
}
const trimmed = capped.length - inForce.length;

/* EVERY DECISION POINT THAT FIRED GETS AT LEAST ONE LINE — compactly, if that is all that fits.
 *
 * Seeding one lesson per trigger (above) fixed the ORDER but not the outcome: a full render carries
 * statement + evidence + repeat-count, ~400-600 chars, so the 1200-char budget is spent after TWO of
 * them. Five triggers fire at UserPromptSubmit; three decision points still said nothing. Measured:
 * L16 was seeded first for `choose-work` and still never reached the page.
 *
 * The budget exists to stop flooding, and that is right. But "do not flood" and "stay silent about
 * three of the five things that just became relevant" are different policies, and the character cap
 * was quietly enforcing the second. The repo's own standing rule on this is explicit: budget the
 * COST, not the count, and a cap that trips is a signal to grow the container — never to drop the
 * knowledge.
 *
 * So: any trigger left unrepresented after the budget is spent gets a ONE-LINE compact entry —
 * statement only, clipped, no evidence, no counts. A clipped sentence the model actually reads beats
 * a perfectly-formatted one it never sees. Full renders still go to the highest-ranked lessons.
 */
const representedTriggers = new Set(inForce.map((l) => l.trigger));
const compactExtras = seeded.filter((l) => !representedTriggers.has(l.trigger));

// isBlocking is defined above (the frequency cap keys its exemption on it). BLOCKING = four ANDed
// conditions; the user's opt-in is necessary and NOT sufficient, and the security invariant lives there.
const blocking = inForce.filter(isBlocking);
// Lessons that COULD block if the user asked them to. Shown, because the entire product claim is
// that the user can see what is available and choose — not discover enforcement by being refused.
const blockCapable = inForce.filter((l) => !isBlocking(l)
  && (l.enforcement === ENFORCEMENT.BLOCK || l.intendedEnforcement === ENFORCEMENT.BLOCK));

/** Cut at the last word boundary inside the cap, with an ellipsis, rather than mid-word — the live
 *  output truncated "…the ris" (from "the risk"), which reads as a bug in the lesson, not a length
 *  cap. Falls back to a hard slice when there is no space to break on (a single very long token).
 *  Same rule anticipate.sh already applies to its `why`. */
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const brk = cut.lastIndexOf(' ');
  return `${(brk > max * 0.6 ? cut.slice(0, brk) : cut).trimEnd()}…`;
}

/** One lesson, rendered. Evidence is what makes this a lesson rather than a nag — it says why, from
 *  real history, in the user's own words. Counts come from the store; nothing here is invented. */
function renderLesson(l, mark) {
  const out = [`  ${mark} ${l.statement}`];
  if (l.evidence?.[0]?.observed) out.push(`      ${clip(String(l.evidence[0].observed), 150)}`);
  if (l.repeatCount >= 3) out.push(`      you have had to say this ${l.repeatCount} times across ${l.projects.length} project(s)`);
  return out.join('\n');
}

function renderBody() {
  const lines = [''];
  const label = Object.values(TRIGGERS).find((t) => t.key === triggers[0])?.label || triggers.join(', ');
  lines.push(`  ⚑ ${blocking.length ? 'BLOCKED' : 'Before you continue'} — you are ${label}.`);
  lines.push('');
  for (const l of inForce) {
    lines.push(renderLesson(l, isBlocking(l) ? '⛔' : '·'));
    lines.push('');
  }
  // The decision points that fired but lost the budget — one clipped line each, so none is silent.
  if (compactExtras.length) {
    lines.push('  Also live at this moment:');
    for (const l of compactExtras) lines.push(`  · ${clip(String(l.statement), 150)}`);
    lines.push('');
  }
  // Say it out loud when the budget trips. A silent truncation reads as "that is all there is".
  if (trimmed > 0) {
    lines.push(`  (${trimmed} further lesson${trimmed === 1 ? '' : 's'} also applies here, trimmed to keep this short —`);
    lines.push(`   see them all with: node scripts/lesson-ratify.mjs --list)`);
    lines.push('');
  }
  if (blockCapable.length && !blocking.length) {
    // Deliberately phrased as an available choice, not as a pending threat. The previous wording
    // ("would REFUSE this action once you ratify them") described enforcement arriving on its own.
    // It does not arrive on its own any more, and telling someone a refusal is coming when they
    // never asked for one is the coercive framing the owner rejected.
    lines.push(`  ${blockCapable.length} of these can REFUSE this action instead of mentioning it,`);
    lines.push(`  if you want that. Entirely your call — nothing changes unless you add the id:`);
    lines.push(`      ${OPTIN_PATH}`);
    lines.push('');
  }
  return lines.join('\n');
}

// A lesson that reaches context but does not govern the next decision is documentation, not learning.
// Keep this contract generic: the lesson owns the correction; this preamble only tells the agent how
// to use relevant knowledge it already received. Advisory remains non-blocking and user-overridable,
// but it does not mean replacing the requested action with discovery when the lesson supplies the form.
const ADVISORY_APPLICATION_CONTRACT = [
  'Your own recorded corrections apply at this moment. They are advisory: they do not refuse',
  "anything or override the user's current instruction or a safety boundary.",
  "Apply any relevant correction directly to the user's requested action.",
  'When a correction already provides the required form, do not replace the requested action with help, setup, status, or other discovery.',
  'If you intentionally take another path, state why.',
];

// ── Emit ─────────────────────────────────────────────────────────────────────────────────────────

if (json) {
  console.log(JSON.stringify({
    triggers, event: event ?? null, inForce,
    blocking: blocking.map((l) => l.id),
    blockCapable: blockCapable.map((l) => l.id),
    optInPath: OPTIN_PATH,
  }, null, 2));
  process.exit(blocking.length ? EXIT_BLOCK : EXIT_ALLOW);
}

if (event) {
  // RECORD what this session is about to SURFACE, so the frequency cap can act next time. Only
  // pure-advisory lessons count toward their own cap; block-capable lessons are exempt (capExempt) and
  // never recorded. Skipped when nothing will render (quiet with no block). Best-effort and fail-open —
  // a lost write repeats an advisory once more, it never suppresses one. Persisted BEFORE the streams
  // are touched, so a crash mid-emit under-counts (safe) rather than over-counts.
  const willRender = blocking.length > 0 || (inForce.length > 0 && !quiet);
  if (willRender) {
    const st = gateState && typeof gateState === 'object' ? gateState : {};
    st.sessions = st.sessions && typeof st.sessions === 'object' ? st.sessions : {};
    const prev = st.sessions[SID] && typeof st.sessions[SID] === 'object' ? st.sessions[SID] : {};
    const shown = prev.shown && typeof prev.shown === 'object' ? { ...prev.shown } : {};
    for (const l of inForce) {
      if (capExempt(l)) continue;
      shown[l.id] = (Number.isInteger(shown[l.id]) && shown[l.id] > 0 ? shown[l.id] : 0) + 1;
    }
    st.sessions[SID] = { shown, ts: Date.now() };
    // Bound the file to the most-recent sessions, same discipline as anticipate.sh.
    st.sessions = Object.fromEntries(
      Object.entries(st.sessions).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)).slice(0, KEEP_SESSIONS),
    );
    writeGateState(st);
  }

  // CANDIDATE MODE — emit JSON candidates, let the runtime own the real streams and the exit code.
  // A block DOMINATES exactly as in the stream contract below: when any opted-in block is in force we
  // emit only the block candidate and no advisory. The `copy` of each candidate is byte-identical to
  // what the legacy path would have written (renderBody() to stderr for a block; the advisory preamble
  // + renderBody() as additionalContext for a nudge), so the runtime's delivered bytes match. The
  // frequency-cap persist above already ran, so persist-before-speak holds here too.
  if (EMIT_CANDIDATES) {
    if (blocking.length) {
      process.stdout.write(JSON.stringify({
        channel: 'lesson', effect: 'block', copy: renderBody(), hookEventName: event,
      }) + '\n');
    } else if (inForce.length && !quiet) {
      process.stdout.write(JSON.stringify({
        channel: 'lesson', effect: 'advisory', hookEventName: event,
        copy: [
          ...ADVISORY_APPLICATION_CONTRACT,
          renderBody(),
        ].join('\n'),
      }) + '\n');
    }
    process.exit(EXIT_ALLOW);
  }

  // HOOK MODE — the streams are the contract, so nothing else may touch them.
  if (blocking.length) {
    // Exit 2: stdout is ignored by the harness, stderr becomes the model's error message. Writing
    // the reason anywhere but stderr is exactly the bug this file exists to fix.
    process.stderr.write(renderBody() + '\n');
    process.exit(EXIT_BLOCK);
  }
  if (inForce.length && !quiet) {
    // Exit 0 + additionalContext: reaches the model, at the decision point, refusing nothing.
    // hookEventName MUST name the firing event or the harness discards the envelope.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: [
          ...ADVISORY_APPLICATION_CONTRACT,
          renderBody(),
        ].join('\n'),
      },
    }));
  }
  process.exit(EXIT_ALLOW);
}

// ── CLI MODE (no --event) ────────────────────────────────────────────────────────────────────────
// Plain text on stdout, unchanged. version-bump-gate.sh captures this stdout verbatim and appends it
// to its own refusal under "── from your own lesson store ──"; changing the stream or the shape here
// would silently empty that section of the only gate in the system that genuinely works.
if (!quiet && inForce.length) console.log(renderBody());
process.exit(blocking.length ? EXIT_BLOCK : EXIT_ALLOW);
