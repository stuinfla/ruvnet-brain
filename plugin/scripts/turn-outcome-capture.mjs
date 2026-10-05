/**
 * turn-outcome-capture.mjs — record what each turn CONCLUDED, and make it recallable knowledge.
 *
 * Called from session-snapshot-hook.mjs's runSessionSnapshotHook, so it rides the capture boundary
 * both hosts already register (Claude: hooks.json; Codex: codex-hooks.json via codex-hook-adapter,
 * which sets RUVNET_HOOK_HOST=codex). Two jobs:
 *
 *   Stop                  → one AgentDB record per distinct turn outcome, namespace `turns`
 *   SessionEnd/PreCompact → `ruflo memory distill run` on the same db (ruflo ADR-174: memory_entries
 *                           is the RECORDING tier; distill mines it into episodes/reasoning_patterns/
 *                           causal_edges, the KNOWLEDGE tier, which stays empty unless it is run)
 *
 * WHERE: only the canonical project's `.swarm/memory.db` (including linked worktrees).
 * An absent store requires persisted opt-in; there is no automatic machine-wide fallback.
 *
 * WHAT (measured facts carried over from the owner's local Claude hook, 2026-09-29):
 *   • The Brain's continuation gate continues most turns, so the turn's REAL final Stop carries
 *     stop_hook_active=true. It is NOT skipped; exact repeats are dropped by a per-session
 *     fingerprint of (finalText, files) instead.
 *   • The transcript may not contain the closing message yet when Stop fires, so the payload's
 *     `last_assistant_message` wins when present; only without it is the transcript waited on
 *     (bounded) until it stops growing.
 *   • Content = assistant outcome text, files changed, Bash descriptions. NEVER raw user text (a
 *     2026-07-13 measurement: prompt echoes made 87% of a store noise). Trivial turns are skipped.
 *
 * CODEX: codex-cli 0.158.0's own `stop.command.input` schema (read from the installed binary
 * 2026-09-29) carries `last_assistant_message` (nullable) and `transcript_path` (nullable).
 * The Codex rollout format is NOT parsed: project-progression-sources.mjs already declares it
 * unknown, and the rollout records observed locally (custom_tool_call / function_call with free-form
 * inputs) give no stable file-change shape. Codex records therefore carry the outcome text only.
 *
 * LATENCY: Stop runs synchronously in the host's turn, and one `ruflo memory store` costs ~0.7s
 * (measured). So the writes run in ONE detached worker (this file, `--run-steps`), store then
 * distill in order; the hook itself only reads, fingerprints and spawns. A project-local journal containing redacted content and canonical binding is fsynced BEFORE
 * spawning; fresh sessions replay stable keys without upsert and require exact readback receipts. Advisory always: nothing here throws to the caller.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRuflo, rufloInvocation } from './ruflo-bin.mjs';
import { redactText, userLevelAgentdbHooks } from './continuity-events.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { digest, journalTurn, readJournal, pendingTurnFiles, acknowledgeJournal, appendReceipt, storeData } from './turn-transport-journal.mjs';
import { contentPathExcludes, pathIsExcluded, privateTurn, maskExcludedPaths, captureFailureReason, firstTurnCaptureNotice } from './turn-capture-privacy.mjs';

export const TURN_NAMESPACE = 'turns';
export const MIN_OUTCOME_CHARS = 200;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const STEP_TIMEOUT_MS = 60_000;
const RUFLO_ENV = { RUFLO_DAEMON_AUTOSTART: '0' };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

function patchFiles(patch) {
  const out = new Set();
  for (const line of String(patch || '').split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) || /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) out.add(m[1].trim());
  }
  return [...out];
}

/**
 * The current turn of a Claude JSONL transcript = every record after the last genuine user message
 * (a user record carrying text, not a tool_result). User text is used ONLY to find that boundary.
 */
export function claudeTurn(lines) {
  const recs = [];
  for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* partial or foreign line */ } }
  let start = 0;
  recs.forEach((o, i) => {
    const role = o?.message?.role || o?.role;
    const c = o?.message?.content;
    const isToolResult = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result');
    if (role === 'user' && !isToolResult && textOf(c).trim()) start = i + 1;
  });
  const texts = [];
  const files = new Set();
  const actions = [];
  const resources = []; const resourceTexts = [];
  for (const o of recs.slice(start)) {
    if ((o?.message?.role || o?.role) !== 'assistant') continue;
    const c = o.message?.content;
    const t = textOf(c).trim();
    if (t) texts.push(redactText(t));
    if (!Array.isArray(c)) continue;
    for (const u of c) {
      if (!u || u.type !== 'tool_use') continue;
      const inp = u.input || {};
      const resource = inp.file_path || inp.notebook_path || inp.path; if (typeof resource === 'string' && resource) resources.push(resource);
      if (u.name === 'Bash' && typeof inp.command === 'string') resourceTexts.push(inp.command);
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(u.name)) {
        const f = inp.file_path || inp.notebook_path;
        if (typeof f === 'string' && f) files.add(f);
      } else if (u.name === 'apply_patch') {
        for (const f of patchFiles(typeof inp === 'string' ? inp : inp.command || inp.input)) files.add(f);
      } else if (u.name === 'Bash' && typeof inp.description === 'string' && inp.description) {
        actions.push(inp.description);
      }
    }
  }
  // The closing message usually carries the outcome; when it is short (a tool-heavy turn) the turn's
  // other assistant text is kept too, newest last, so the record still says what happened.
  const last = texts.length ? texts[texts.length - 1] : '';
  const finalText = last.length >= MIN_OUTCOME_CHARS ? last : texts.join('\n').slice(-2500);
  return { finalText, files: [...files], actions, resources, resourceTexts };
}

function readTail(file, bytes = TRANSCRIPT_TAIL_BYTES) {
  const handle = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error('Transcript must be a regular file');
    const size = stat.size;
    const offset = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - offset);
    fs.readSync(handle, buf, 0, buf.length, offset);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (offset > 0) lines.shift(); // the first line of a tail is almost always cut mid-record
    return lines;
  } finally { fs.closeSync(handle); }
}

/** Wait (bounded) until the transcript stops growing, then return its tail lines. */
export function readSettledTranscript(file, { stableMs = 400, maxMs = 2000, sleep } = {}) {
  const pause = sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const deadline = Date.now() + Math.max(0, maxMs);
  let size = -1;
  for (;;) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Transcript must be a regular file');
    const now = stat.size;
    if (now === size || Date.now() >= deadline) break;
    size = now;
    pause(Math.min(stableMs, Math.max(0, deadline - Date.now())));
  }
  return readTail(file);
}

export function buildTurnRecord({ turn, project, host, session, at = new Date() }) {
  const parts = [`[turn ${at.toISOString()} project=${project} host=${host}]`,
    `OUTCOME: ${redactText(turn.finalText).replace(/\s+/g, ' ').slice(0, 2500)}`];
  if (turn.files.length) parts.push(`FILES CHANGED: ${turn.files.slice(0, 25).map(redactText).join(', ')}`);
  if (turn.actions.length) parts.push(`ACTIONS: ${turn.actions.slice(-15).map(redactText).join(' • ')}`);
  parts.push(`SESSION: ${session || '?'}`);
  return redactText(parts.join('  ||  ')).slice(0, 4000);
}

/** Persisted per-canonical-project/per-path consent, reread at every boundary (no restart). */
export function turnCapturePolicyFile(brainHome) {
  return path.join(brainHome, 'turn-capture', 'policy.json');
}

const consentMap = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.values(value).every((setting) => setting === 'on' || setting === 'off');

export function resolveTurnDb({ projectDir, brainHome, requestedStorePath, gitTimeoutMs = 1000, unknownOriginalPath = false } = {}) {
  const resolved = resolveProjectStore({ projectDir, requestedStorePath, gitTimeoutMs });
  const capturePath = fs.realpathSync.native(projectDir);
  let policy = {};
  const file = brainHome && turnCapturePolicyFile(brainHome);
  if (file && fs.existsSync(file)) {
    try {
      policy = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (policy?.schemaVersion !== 1 || !consentMap(policy.projects)
        || (Object.hasOwn(policy, 'paths') && !consentMap(policy.paths))) throw new Error('invalid policy');
      contentPathExcludes(policy.contentPathExcludes);
    } catch { return { skipped: 'turn capture policy unreadable or invalid', projectRoot: resolved.projectRoot }; }
  }
  // A path rule wins over a project rule, allowing a linked checkout/subdirectory to opt out.
  const setting = policy.paths?.[capturePath] ?? policy.projects?.[resolved.projectRoot];
  if (setting !== undefined && !['on', 'off'].includes(setting)) return { skipped: 'invalid turn capture consent', projectRoot: resolved.projectRoot };
  const db = resolved.canonicalAgentDbPath;
  const exclusions = contentPathExcludes(policy.contentPathExcludes);
  if ([db, capturePath].some((binding) => pathIsExcluded(binding, exclusions, capturePath))) return { skipped: 'content exclusion conflicts with canonical source/store binding', projectRoot: resolved.projectRoot };
  if (unknownOriginalPath && Object.entries(policy.paths || {}).some(([origin, choice]) => choice === 'off'
    && (origin === resolved.checkoutRoot || origin.startsWith(`${resolved.checkoutRoot}${path.sep}`)))) {
    return { db, scope: 'project', capturePath, projectRoot: resolved.projectRoot, skipped: 'capture origin cannot be verified under path opt-out' };
  }
  assertTurnStoreFiles(db);
  if (setting === 'off') return { db, scope: 'project', capturePath, projectRoot: resolved.projectRoot, skipped: 'persisted turn capture opt-out' };
  let exists = false;
  try { exists = fs.statSync(db).isFile(); } catch { /* absent */ }
  if (!exists && setting !== 'on') return { db, scope: 'project', capturePath, projectRoot: resolved.projectRoot, skipped: 'no project memory db; persisted opt-in required' };
  return { db, scope: 'project', capturePath, projectRoot: resolved.projectRoot, optedIn: setting === 'on',
    contentPathExcludes: exclusions };
}

// Revalidation narrows the queue-to-launch window; it does not make SQLite's later open atomic.
function assertTurnStoreFiles(db) {
  const directory = path.dirname(db);
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory)) {
    throw new Error('store directory is not a canonical regular directory');
  }
  for (const file of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) {
    let entry;
    try { entry = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1)) {
      throw new Error('store or SQLite side file is a symlink, hard link or non-regular file');
    }
  }
}

const projectName = (projectDir) => redactText(path.basename(path.resolve(projectDir))).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';

/** Detached worker launch: the hook returns immediately; the worker runs the steps in order. */
export function launchDetached(steps, { receipts, brainHome, projectDir, env = process.env }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run-steps', JSON.stringify({ steps: steps.map((step) => step.kind === 'store' && step.journalFile ? { kind: 'journal', journalFile: step.journalFile, db: step.args[step.args.indexOf('--path') + 1] } : step), receipts })], {
    cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, ...RUFLO_ENV, ...(brainHome ? { RUVNET_BRAIN_HOME: brainHome } : {}), ...(projectDir ? { RUVNET_TURN_PROJECT_DIR: projectDir } : {}) },
  });
  child.unref();
  return { launched: true, pid: child.pid };
}

function readTurnState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; }
}

function sameTurnSeen(stateFile, sessionKey, fingerprint, receipts) {
  const previous = readTurnState(stateFile)[sessionKey];
  if (previous?.fingerprint !== fingerprint) return false;
  try {
    const rows = readTail(receipts, 128 * 1024).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const receipt = rows.findLast((r) => r.kind === 'store' && r.key === previous.key);
    if (receipt) return receipt.status === 0 && receipt.verified === true;
  } catch { /* queued worker has no receipt yet */ }
  // An in-flight worker gets a bounded grace period; a killed/lost worker cannot consume the turn forever.
  return Date.now() - previous.at < 2 * STEP_TIMEOUT_MS + 10_000;
}

function markTurnQueued(stateFile, sessionKey, fingerprint, key) {
  const last = readTurnState(stateFile);
  const keys = Object.keys(last);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete last[k];
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({ ...last, [sessionKey]: { fingerprint, key, at: Date.now() } }), { mode: 0o600 });
  } catch { /* dedupe is best effort; a duplicate record beats a lost one */ }
}

/**
 * Capture this turn's outcome (Stop) and/or queue distillation (SessionEnd, PreCompact).
 * Returns a plain report; `queued` means a worker request, never proof the store committed.
 * `skipped` / `distill.skipped` carry the reason whenever nothing is requested.
 */
export function captureTurnOutcome({
  projectDir, event, payload = {}, host = 'claude',
  env = process.env, home = os.homedir(),
  brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain'),
  ruflo = resolveRuflo({ env, home }),
  launch = launchDetached,
  readTranscript = readSettledTranscript,
  settleMs = 2000,
  now = () => new Date(),
} = {}) {
  const report = { event, host, queued: false, recorded: false, distill: { queued: false } };
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') {
    return { ...report, skipped: 'RUVNET_TURN_CAPTURE=off', distill: { queued: false, skipped: 'RUVNET_TURN_CAPTURE=off' } };
  }
  if (!ruflo) return { ...report, skipped: 'ruflo not found', distill: { queued: false, skipped: 'ruflo not found' } };
  let target;
  try { target = resolveTurnDb({ projectDir, brainHome }); } catch (error) { return { ...report, skipped: `store resolution failed: ${redactText(error.message)}` }; }
  const { db, scope, projectRoot } = target;
  Object.assign(report, { db, scope });
  if (target.skipped) return { ...report, skipped: target.skipped, distill: { queued: false, skipped: target.skipped } };
  const steps = [];
  const rootStat = fs.statSync(projectRoot);
  const binding = { projectRoot, projectDir: fs.realpathSync.native(projectDir), brainHome, rootIdentity: `${rootStat.dev}:${rootStat.ino}` };
  let dedupe;
  const project = projectName(projectRoot);
  const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');

  // ONE WRITER PER TURN (ADR-100 §3). Measured 2026-10-01 on this repo's real store: 624 `turns` rows
  // in five days for 323 distinct outcomes — this writer (host-tagged) and the owner's user-level
  // ~/.claude/hooks/agentdb-turn-capture.mjs both recorded every Claude turn. The user-level hook is
  // the owner's and is never edited by the product, so where it is registered the product DEFERS
  // (RUVNET_TURN_CAPTURE=force keeps both). Codex turns are not seen by that Claude-only hook.
  const deferTo = event === 'Stop' && host === 'claude' && String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() !== 'force'
    && userLevelAgentdbHooks({ home }).turnCapture;
  if (deferTo) {
    report.skipped = 'deferred: the user-level ~/.claude/hooks/agentdb-turn-capture.mjs records this turn (one writer per turn)';
    report.deferredToUserLevel = true;
  } else if (event === 'Stop') {
    const sessionKey = String(payload.session_id || payload.transcript_path || '');
    const message = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
    let turn = { finalText: '', files: [], actions: [] };
    if (host === 'claude' && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      // With the closing message in hand, the transcript is read immediately (tool calls are already
      // flushed); without it, wait for the closing message to land, bounded.
      try { turn = claudeTurn(readTranscript(payload.transcript_path, { maxMs: message ? 0 : settleMs })); } catch { /* unreadable */ }
    }
    if (message && (message.length >= MIN_OUTCOME_CHARS || message.length >= turn.finalText.length)) turn.finalText = message;
    turn = privateTurn(turn, target.contentPathExcludes, target.capturePath);
    if (!sessionKey) report.skipped = 'no session identity in the host payload';
    else if (turn.finalText.length < MIN_OUTCOME_CHARS && !turn.files.length) {
      report.skipped = turn.excludedResource ? 'turn content withheld: explicitly excluded resource' : host === 'codex' && !message ? 'codex payload carried no last_assistant_message' : 'trivial turn';
    } else {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([turn.finalText, turn.files])).digest('hex');
      const stateFile = path.join(brainHome, 'turn-capture', 'last-turn.json');
      const identity = crypto.createHash('sha256').update(`${host}:${db}:${sessionKey}`).digest('hex');
      if (sameTurnSeen(stateFile, identity, fingerprint, receipts)) report.skipped = 'same turn outcome already queued or verified';
      else {
        const at = now();
        const key = `turn-${project}-${digest(`${identity}:${fingerprint}`).slice(0, 40)}`;
        dedupe = { stateFile, identity, fingerprint, key };
        let value = buildTurnRecord({ turn, project, host, session: payload.session_id, at });
        // Retry uses the original durable content (including its timestamp), never a new value.
        const pendingFile = path.join(path.dirname(db), 'turn-outbox', `${digest(key)}.json`);
        if (fs.existsSync(pendingFile)) {
          try { const pending = readJournal(pendingFile, db); value = pending.value; }
          catch (error) { return { ...report, skipped: `durable turn queue invalid: ${redactText(error.message)}` }; }
        }
        steps.push({ ...binding, kind: 'store', ruflo, args: ['memory', 'store', '-k', key, '--value', value, '-n', TURN_NAMESPACE,
          '--path', db, '--no-upsert', '--tags', `project=${project},host=${host}`, '--provenance', 'agent_output'] });
        // This synchronous boundary proves only queuing; the worker's exact receipt proves recording.
        Object.assign(report, { queued: true, key, value });
      }
    }
  } else report.skipped = `turn outcomes are recorded at Stop, not ${event}`;

  if (event === 'SessionEnd' || event === 'PreCompact') {
    if (!fs.existsSync(db)) report.distill = { queued: false, skipped: 'no memory db to distill yet' };
    else {
      steps.push({ ...binding, kind: 'distill', ruflo, args: ['memory', 'distill', 'run', '--db', db, '--namespace', TURN_NAMESPACE, '--max-entries', '500'] });
      report.distill = { queued: true, db };
    }
  }
  if (!steps.length) return report;

  try {
    // Only explicit persisted consent permits creating a project store directory.
    if (target.optedIn) fs.mkdirSync(path.dirname(db), { recursive: true, mode: 0o700 });
    if (report.queued) {
      const step = steps.find((item) => item.kind === 'store');
      step.journalFile = journalTurn(step, db, report.key, { onDurability: (evidence) => { report.durability = evidence; } });
      fs.appendFileSync(path.join(path.dirname(db), 'agentdb-turns.jsonl'),
        `${JSON.stringify({ ts: Date.now(), key: report.key, hash: crypto.createHash('sha256').update(report.value).digest('hex'), len: report.value.length })}\n`, { mode: 0o600 });
    }
    report.launch = launch(steps, { receipts, brainHome, projectDir: binding.projectDir, env });
    if (dedupe) markTurnQueued(dedupe.stateFile, dedupe.identity, dedupe.fingerprint, dedupe.key);
  } catch (error) {
    return { ...report, queued: false, recorded: false, distill: { queued: false, skipped: `launch failed: ${redactText(error.message)}` }, skipped: `launch failed: ${redactText(error.message)}` };
  }
  return report;
}

/** Exact (namespace, key, content) readback. Exit zero alone never proves capture. */
function readBack({ ruflo, db, key, run, options }) {
  const invocation = rufloInvocation(ruflo, ['memory', 'retrieve', '--key', key, '--namespace', TURN_NAMESPACE, '--value-only', '--path', db]);
  const result = run(invocation.executable, invocation.args, options);
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

/** The detached worker: bounded steps, safe error evidence, exact content readback. */
export function runSteps({ steps = [], receipts } = {}, { run: suppliedRun = spawnSync, read = readBack,
  env = process.env, deadlineMs, home = os.homedir(),
  projectDir = env.RUVNET_TURN_PROJECT_DIR || process.cwd(),
  brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain') } = {}) {
  const run = (binary, args, options) => {
    if (deadlineMs === undefined) return suppliedRun(binary, args, options);
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return { status: 1, error: new Error('turn replay deadline exhausted') };
    return suppliedRun(binary, args, { ...options, timeout: Math.min(options.timeout, remaining) });
  };
  const results = [];
  for (const queued of steps) {
    let status = 1; let error = null; let verified = false; let db = ''; let key; let privacyPatterns = [];
    const kind = queued.kind === 'journal' ? 'store' : queued.kind;
    try {
      if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') throw new Error('RUVNET_TURN_CAPTURE=off');
      if (kind === 'store' && queued.kind !== 'journal') { const data = storeData(queued); key = data.key; db = data.db; }
      if (queued.kind !== 'journal' && (!queued.projectRoot || !queued.projectDir || !queued.brainHome)) throw new Error('queued step has no canonical project binding');
      const target = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: 1000 });
      if (target.skipped) throw new Error(target.skipped);
      privacyPatterns = target.contentPathExcludes;
      db = target.db;
      let args; let value; let binding;
      if (kind === 'store') {
        const data = queued.kind === 'journal' ? readJournal(queued.journalFile, db) : storeData(queued);
        if (queued.kind === 'journal' && queued.db !== db) throw new Error('foreign turn queue store rejected');
        if (queued.kind !== 'journal' && data.db !== db) throw new Error('foreign turn store rejected');
        if (data.legacyBrainHome && data.legacyBrainHome !== brainHome) throw new Error('queued consent settings differ from trusted caller');
        if (queued.kind !== 'journal' && queued.brainHome !== brainHome) throw new Error('queued consent settings differ from trusted caller');
        binding = queued.kind === 'journal' ? data.binding : queued;
        key = data.key; value = maskExcludedPaths(redactText(data.value), target.contentPathExcludes, target.capturePath);
        if (value !== redactText(data.value)) throw new Error('content exclusions changed; immutable turn retained');
        args = ['memory', 'store', '-k', key, '--value', value, '-n', TURN_NAMESPACE, '--path', db, '--no-upsert', '--provenance', 'agent_output'];
      } else if (kind === 'distill') {
        if (queued.brainHome !== brainHome) throw new Error('queued consent settings differ from trusted caller');
        const recipe = queued.args;
        if (!Array.isArray(recipe) || recipe.slice(0, 3).join(' ') !== 'memory distill run') throw new Error('invalid turn distill operation');
        const seen = new Set();
        for (let i = 3; i < recipe.length; i += 2) {
          const flag = recipe[i]; const value = recipe[i + 1];
          if (seen.has(flag) || !['--db', '--namespace', '--max-entries'].includes(flag) || typeof value !== 'string') throw new Error('invalid turn distill flags');
          seen.add(flag);
          if (flag === '--db' && value !== db || flag === '--namespace' && value !== TURN_NAMESPACE || flag === '--max-entries' && value !== '500') throw new Error('invalid turn distill scope');
        }
        if (!seen.has('--db')) throw new Error('missing turn distill database');
        binding = queued;
        args = ['memory', 'distill', 'run', '--db', db, '--namespace', TURN_NAMESPACE, '--max-entries', '500'];
      } else throw new Error('invalid turn worker operation');
      if (!binding.projectRoot || !binding.projectDir) throw new Error('queued step has no canonical project binding');
      const rootStat = fs.statSync(target.projectRoot);
      if (binding.rootIdentity && binding.rootIdentity !== `${rootStat.dev}:${rootStat.ino}`) throw new Error('queued canonical project identity changed');
      if (binding.projectRoot !== target.projectRoot) throw new Error('queued canonical project/store identity changed');
      const origin = resolveTurnDb({ projectDir: binding.projectDir, brainHome, requestedStorePath: db, gitTimeoutMs: 1000 });
      if (origin.skipped) throw new Error(origin.skipped);
      if (origin.projectRoot !== target.projectRoot || origin.db !== db) throw new Error('queued canonical capture origin changed');
      const ruflo = resolveRuflo({ env, home });
      if (!ruflo) throw new Error('ruflo not found for durable replay');
      const invocation = rufloInvocation(ruflo, args);
      const remaining = deadlineMs === undefined ? STEP_TIMEOUT_MS : deadlineMs - Date.now();
      if (remaining <= 0) throw new Error('turn replay deadline exhausted');
      const options = { encoding: 'utf8', timeout: Math.min(STEP_TIMEOUT_MS, remaining), cwd: path.dirname(db), windowsHide: true,
        maxBuffer: 1024 * 1024, env: { ...env, ...RUFLO_ENV, CLAUDE_FLOW_MEMORY_PATH: path.dirname(db) } };
      const existing = kind === 'store' && queued.journalFile ? read({ ruflo, db, key, run, options }) : null;
      if (existing !== null && existing !== value) throw new Error('existing turn key content differs; no upsert permitted');
      verified = kind === 'store' && existing === value;
      const r = verified ? { status: 0 } : run(invocation.executable, invocation.args, options);
      status = Number.isInteger(r.status) ? r.status : 1;
      if (kind === 'store' && !verified) verified = read({ ruflo, db, key, run, options }) === value;
      if (verified) status = 0;
      if (!verified && (r.error || status !== 0)) error = captureFailureReason(r, status);
      else if (kind === 'store' && !verified) { status = 1; error = 'exact turn key/content readback failed'; }
    } catch (e) { status = 1; error = redactText(e.message).slice(0, 300); }
    if (error) error = maskExcludedPaths(error, privacyPatterns, projectDir);
    const row = { at: new Date().toISOString(), kind, db: redactText(db), storeIdentity: digest(db), key, status, error,
      ...(kind === 'store' ? { verified } : {}) };
    results.push(row);
    if (receipts) {
      try { appendReceipt(receipts, row); if (verified && queued.journalFile) acknowledgeJournal(queued.journalFile, db); }
      catch { /* failed receipt persistence retains the journal for exact-key retry */ }
    }
  }
  return results;
}

/** Replay only bounded canonical project entries; consent suspends rather than deletes them. */
export function replayTurnQueue({ projectDir = process.cwd(), env = process.env, home = os.homedir(),
  brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain'), limit = 10,
  launch = launchDetached, synchronous = false, runner, deadlineMs } = {}) {
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') return { queued: false, skipped: 'RUVNET_TURN_CAPTURE=off' };
  try {
    const target = resolveTurnDb({ projectDir, brainHome });
    if (target.skipped) return { queued: false, skipped: target.skipped };
    const steps = pendingTurnFiles(target.db, limit).map((journalFile) => ({ kind: 'journal', journalFile, db: target.db }));
    if (!steps.length) return { queued: false, count: 0 };
    if (synchronous) {
      const results = runSteps({ steps, receipts: path.join(brainHome, 'turn-capture', 'receipts.jsonl') }, { env, home, projectDir, brainHome, ...(runner ? { run: runner } : {}), deadlineMs });
      const pending = pendingTurnFiles(target.db, 25).length;
      return { queued: false, count: steps.length, pending, failed: results.filter((row) => row.status !== 0).length, verified: results.filter((row) => row.verified === true).length, results };
    }
    return { queued: true, count: steps.length, pending: steps.length, launch: launch(steps, { receipts: path.join(brainHome, 'turn-capture', 'receipts.jsonl'), projectDir, brainHome, env }) };
  } catch (error) { return { queued: false, skipped: redactText(error.message) }; }
}

/** Bounded recent evidence, isolated by canonical db. A continuity success cannot mask turn failures. */
export function turnRecordingStatus({ projectDir = process.cwd(), env = process.env, home = os.homedir(), now = Date.now(), noticeOnFirstUse = false } = {}) {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  let target;
  try { target = resolveTurnDb({ projectDir, brainHome }); } catch { return { state: 'unknown', line: 'turn recording unavailable: canonical store resolution failed' }; }
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off' || target.skipped) return { state: 'unknown', line: `turn recording n/a — ${target.skipped || 'RUVNET_TURN_CAPTURE=off'}` };
  const deferred = String(env.RUVNET_HOOK_HOST || 'claude') === 'claude' && String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() !== 'force' && userLevelAgentdbHooks({ home }).turnCapture;
  const notice = noticeOnFirstUse && !deferred ? firstTurnCaptureNotice({ target, brainHome, policyFile: turnCapturePolicyFile(brainHome), env }) : null;
  const status = (value) => ({ ...value, ...(notice ? { notice } : {}) });
  let rows = [];
  try {
    rows = readTail(path.join(brainHome, 'turn-capture', 'receipts.jsonl'), 128 * 1024).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((r) => r.kind === 'store' && (r.storeIdentity === crypto.createHash('sha256').update(target.db).digest('hex') || r.db === target.db) && now - Date.parse(r.at) < 7 * 86_400_000).slice(-20);
  } catch { /* first run */ }
  rows = [...new Map(rows.map((row) => [row.key || row.at, row])).values()];
  let pending = 0;
  try { pending = pendingTurnFiles(target.db, 25).length; } catch { return status({ state: 'warn', line: 'turn recording durable queue unsafe or unreadable' }); }
  const historical = rows.filter((r) => r.status === 0 && r.verified === undefined);
  const failed = rows.filter((r) => r.status !== 0 || r.verified === false);
  if (failed.length) return status({ state: 'warn', line: `turn recording failing ${failed.length}/${rows.length} — ${redactText(failed.at(-1).error || 'write has no exact readback evidence').slice(0, 300)}` });
  if (historical.length) return status({ state: 'unknown', line: `turn recording unverified historical (${historical.length} receipts without exact readback evidence)` });
  if (pending) return status({ state: 'unknown', line: `turn recording pending durable replay (${pending} entries); not yet proven` });
  return status(rows.length ? { state: 'ok', line: `turn recording ✓ (${rows.length}/${rows.length} exact readbacks)` }
    : { state: 'unknown', line: 'turn recording not yet proven — no exact readback receipt' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--run-steps') {
  try { runSteps(JSON.parse(process.argv[3] || '{}')); } catch { /* a detached worker has no one to report to */ }
  process.exit(0);
}
