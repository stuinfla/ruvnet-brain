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
 * WHERE (ADR-0102 G-053, G-002): the store of the CANONICAL ADOPTED ROOT, resolved by
 * project-store-resolver.mjs — the main worktree of the git common dir (so a linked worktree writes to
 * its repository's store), or the non-git directory holding `.swarm/memory.db`. A store that is a
 * symlink, hard link, or escapes that root is REFUSED and nothing is written anywhere (no fallback). A
 * project with no store records NOTHING unless the machine setting `unadopted: "global"` opts in to the
 * machine-wide `~/.claude/global-memory/.swarm/memory.db` (the conservative default pending owner
 * decision D8). `.swarm` is NEVER created inside a project (session-snapshot-hook.mjs: trespass).
 *
 * PRIVACY (G-001): the record is redacted (continuity-events.mjs redactText) BEFORE anything is
 * written; the local `agentdb-turns.jsonl` index holds only {ts,key,hash,len}; the text reaches ruflo in
 * a 0600 spool file read by `ruflo memory import` (ruflo's `memory store` takes a value only on argv),
 * never on any process argv; ruflo runs in a private scratch dir that is removed afterwards. A
 * persistent opt-out lives in `<brain home>/turn-capture/settings.json` (turn-capture-state.mjs
 * `--capture off`, per machine or `--project <dir>`), read at every Stop, so it holds across restarts
 * and updates.
 *
 * TRUTH (G-014): a write is OK only when the row is read back by its exact key; the receipt carries
 * ruflo's first stderr line otherwise, and turnRecordingLine() reports "failing N/M" to doctor and
 * the SessionStart brief.
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
 * distill in order; the hook itself only reads, fingerprints and spawns. A breadcrumb line is
 * appended next to the db BEFORE the spawn, and the worker appends a receipt per step, so a lost
 * write is visible rather than silent. Advisory always: nothing here throws to the caller.
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
import { ensurePrivateDir, rufloRunDir } from './project-progression-store.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { appendPrivate, readTurnCaptureSettings } from './turn-capture-state.mjs';

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
  for (const o of recs.slice(start)) {
    if ((o?.message?.role || o?.role) !== 'assistant') continue;
    const c = o.message?.content;
    const t = textOf(c).trim();
    if (t) texts.push(t);
    if (!Array.isArray(c)) continue;
    for (const u of c) {
      if (!u || u.type !== 'tool_use') continue;
      const inp = u.input || {};
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
  return { finalText, files: [...files], actions };
}

function readTail(file, bytes = TRANSCRIPT_TAIL_BYTES) {
  const size = fs.statSync(file).size;
  const offset = Math.max(0, size - bytes);
  const handle = fs.openSync(file, 'r');
  try {
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
    const now = fs.statSync(file).size;
    if (now === size || Date.now() >= deadline) break;
    size = now;
    pause(Math.min(stableMs, Math.max(0, deadline - Date.now())));
  }
  return readTail(file);
}

/** Redact the WHOLE turn first (continuity-events.mjs redactText), only then collapse and bound it. */
export function buildTurnRecord({ turn, project, host, session, at = new Date() }) {
  const clean = (text) => redactText(text).replace(/\s+/g, ' ').trim();
  const parts = [`[turn ${at.toISOString()} project=${project} host=${host}]`,
    `OUTCOME: ${clean(turn.finalText).slice(0, 2500)}`];
  if (turn.files.length) parts.push(`FILES CHANGED: ${turn.files.slice(0, 25).map(clean).join(', ')}`);
  if (turn.actions.length) parts.push(`ACTIONS: ${turn.actions.slice(-15).map(clean).join(' • ')}`);
  parts.push(`SESSION: ${clean(session || '?')}`);
  return redactText(parts.join('  ||  ').slice(0, 4000));
}

const lstat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };

/**
 * Why `db` is NOT a store this writer may touch, or null when it is: its directory must be a real
 * directory at its own canonical path (no symlinked ancestor), and the db and its SQLite side files
 * regular files that are not symlinks or hard links (a hard link would write into a foreign inode).
 */
export function storeContainmentProblem(db, { allowMissing = false } = {}) {
  const dir = path.dirname(db);
  const d = lstat(dir);
  if (!d) return 'store directory is missing';
  if (d.isSymbolicLink() || !d.isDirectory()) return 'store directory is a symlink or not a directory';
  let real;
  try { real = fs.realpathSync.native(dir); } catch { return 'store directory cannot be resolved'; }
  if (real !== dir) return 'store directory resolves outside its canonical path (symlinked ancestor)';
  const f = lstat(db);
  if (!f) return allowMissing ? null : 'store file is missing';
  if (f.isSymbolicLink() || !f.isFile()) return 'store file is a symlink or not a regular file';
  if (f.nlink > 1) return 'store file is hard-linked';
  for (const side of ['-wal', '-shm', '-journal']) {
    const s = lstat(`${db}${side}`);
    if (s && (s.isSymbolicLink() || !s.isFile() || s.nlink > 1)) return `store ${side} file is a symlink, hard link or not a regular file`;
  }
  return null;
}

const projectName = (dir) => path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
const globalDbOf = ({ home, env }) => env.RUVNET_TURN_GLOBAL_DB || path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db');

/**
 * The store of the canonical adopted root (G-053), or why there is none. Never falls back to the
 * machine-wide store on a refusal; a project without a store uses it only when opted in (G-002).
 */
export function resolveTurnDb({ projectDir, home = os.homedir(), env = process.env, settings = {} } = {}) {
  let resolution;
  try { resolution = resolveProjectStore({ projectDir }); } catch (error) {
    return { db: null, scope: 'refused', reason: `store refused: ${error.message}` };
  }
  const db = resolution.canonicalAgentDbPath;
  const base = { projectRoot: resolution.projectRoot, project: projectName(resolution.projectRoot) };
  if (lstat(db)) {
    const problem = storeContainmentProblem(db);
    return problem ? { ...base, db: null, canonicalDb: db, scope: 'refused', reason: `store refused: ${problem}` }
      : { ...base, db, scope: 'project' };
  }
  if (settings.unadopted === 'global') return { ...base, db: globalDbOf({ home, env }), scope: 'global' };
  return { ...base, db: null, scope: 'none',
    reason: 'project has not adopted an AgentDB store (.swarm/memory.db): nothing recorded (machine-wide opt-in: --unadopted global)' };
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Detached worker launch: the hook returns immediately; the worker runs the steps in order. No turn
 * text is in this argv: a store step names its 0600 spool file, never the value. */
export function launchDetached(steps, { receipts }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run-steps', JSON.stringify({ steps, receipts })], {
    cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...RUFLO_ENV },
  });
  child.unref();
  return { launched: true, pid: child.pid };
}

function sameTurnSeen(stateFile, sessionKey, fingerprint) {
  let last = {};
  try { last = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* first run */ }
  if (last[sessionKey] === fingerprint) return true;
  const keys = Object.keys(last);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete last[k];
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({ ...last, [sessionKey]: fingerprint }), { mode: 0o600 });
  } catch { /* dedupe is best effort; a duplicate record beats a lost one */ }
  return false;
}

function appendReceipt(receipts, row) {
  try {
    fs.mkdirSync(path.dirname(receipts), { recursive: true, mode: 0o700 });
    appendPrivate(receipts, `${JSON.stringify(row)}\n`);
  } catch { /* receipts are best effort */ }
}

/**
 * Capture this turn's outcome (Stop) and/or queue distillation (SessionEnd, PreCompact).
 * Returns a plain report; `skipped` / `distill.skipped` carry the reason whenever nothing is queued.
 * `queued` means handed to the worker — never "recorded": only the worker's read-back proves that.
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
  const skip = (reason) => ({ ...report, skipped: reason, distill: { queued: false, skipped: reason } });
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') return skip('RUVNET_TURN_CAPTURE=off');
  const settingsFile = path.join(brainHome, 'turn-capture', 'settings.json');
  const read = readTurnCaptureSettings(settingsFile);
  if (!read.ok) return skip(`turn capture settings ${settingsFile} are ${read.reason}: recording nothing until fixed`);
  if (read.settings.capture === 'off') return skip(`turn capture is off on this machine (${settingsFile})`);
  if (!ruflo) return skip('ruflo not found');
  const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
  const target = resolveTurnDb({ projectDir, home, env, settings: read.settings });
  const { db, scope, project } = target;
  Object.assign(report, { db, scope });
  if (target.projectRoot && read.settings.projects?.[target.projectRoot] === 'off') {
    return skip(`turn capture is off for ${target.projectRoot} (${settingsFile})`);
  }
  if (!db) {
    // A refused store is a security event, so it is a failing receipt (doctor shows it); a project that
    // never adopted a store is simply not recorded.
    if (scope === 'refused' && event === 'Stop') {
      appendReceipt(receipts, { at: now().toISOString(), kind: 'store', db: target.canonicalDb || null, ok: false, status: null, error: target.reason });
    }
    return skip(target.reason);
  }
  const steps = [];

  // ONE WRITER PER TURN (ADR-100 §3). Measured 2026-10-01 on this repo's real store: 624 `turns` rows
  // in five days for 323 distinct outcomes — this writer (host-tagged) and the owner's user-level
  // ~/.claude/hooks/agentdb-turn-capture.mjs both recorded every Claude turn. The user-level hook is
  // the owner's and is never edited by the product, so where it is registered the product DEFERS
  // (RUVNET_TURN_CAPTURE=force keeps both). Codex turns are not seen by that Claude-only hook.
  const deferTo = event === 'Stop' && host === 'claude' && String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() !== 'force'
    && userLevelAgentdbHooks({ home }).turnCapture;
  let record = null;
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
    if (!sessionKey) report.skipped = 'no session identity in the host payload';
    else if (turn.finalText.length < MIN_OUTCOME_CHARS && !turn.files.length) {
      report.skipped = host === 'codex' && !message ? 'codex payload carried no last_assistant_message' : 'trivial turn';
    } else {
      const fingerprint = sha256(JSON.stringify([turn.finalText, turn.files]));
      const stateFile = path.join(brainHome, 'turn-capture', 'last-turn.json');
      if (sameTurnSeen(stateFile, `${host}:${sha256(sessionKey)}`, fingerprint)) report.skipped = 'same turn outcome already recorded';
      else {
        const at = now();
        const key = `turn-${project}-${at.getTime()}`;
        record = { key, value: buildTurnRecord({ turn, project, host, session: payload.session_id, at }), at };
      }
    }
  } else report.skipped = `turn outcomes are recorded at Stop, not ${event}`;

  try {
    if (record) {
      // The machine-wide db lives outside every repository; its directory is created on first use when
      // opted in. A project's `.swarm` is never created (it must already exist to be chosen).
      if (scope === 'global') fs.mkdirSync(path.dirname(db), { recursive: true, mode: 0o700 });
      const hash = sha256(record.value);
      appendPrivate(path.join(path.dirname(db), 'agentdb-turns.jsonl'),
        `${JSON.stringify({ ts: record.at.getTime(), key: record.key, hash, len: record.value.length })}\n`);
      const spoolDir = path.join(brainHome, 'turn-capture', 'spool');
      fs.mkdirSync(path.dirname(spoolDir), { recursive: true, mode: 0o700 });
      ensurePrivateDir(spoolDir);
      for (const name of fs.readdirSync(spoolDir)) { // a worker that never ran leaves its spool: swept after 1h
        const stale = lstat(path.join(spoolDir, name));
        if (stale && now().getTime() - stale.mtimeMs > 3_600_000) fs.rmSync(path.join(spoolDir, name), { force: true });
      }
      const spool = path.join(spoolDir, `${record.key}-${crypto.randomBytes(6).toString('hex')}.json`);
      fs.writeFileSync(spool, JSON.stringify({ entries: [{ key: record.key, namespace: TURN_NAMESPACE, value: record.value }] }), { mode: 0o600, flag: 'wx' });
      steps.push({ kind: 'store', ruflo, db, scope, key: record.key, spool, hash });
      Object.assign(report, { queued: true, key: record.key, hash, len: record.value.length });
    }
    if (event === 'SessionEnd' || event === 'PreCompact') {
      if (!fs.existsSync(db)) report.distill = { queued: false, skipped: 'no memory db to distill yet' };
      else {
        steps.push({ kind: 'distill', ruflo, db, scope, args: ['memory', 'distill', 'run', '--db', db, '--namespace', TURN_NAMESPACE, '--max-entries', '500'] });
        report.distill = { queued: true, db };
      }
    }
    if (!steps.length) return report;
    report.launch = launch(steps, { receipts });
  } catch (error) {
    const reason = `launch failed: ${redactText(error.message).slice(0, 200)}`;
    if (record) appendReceipt(receipts, { at: now().toISOString(), kind: 'store', db, key: record.key, ok: false, status: null, error: reason });
    return { ...report, queued: false, distill: { queued: false, skipped: reason }, skipped: reason };
  }
  return report;
}

const firstLine = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const safeLine = (text) => redactText(firstLine(text)).slice(0, 200);

function runRuflo(run, step, args) {
  // CONTAINMENT (measured 2026-09-29, ruflo 3.48.0; 3.51.1 also copies the value into
  // <cwd>/agentdb-memory.db-wal): ruflo writes `.swarm/`, `ruvector.db` and a copy of the value relative
  // to its CWD even with --path. Every call runs in a fresh private run dir (project-progression-store
  // rufloRunDir) that is removed afterwards, so neither the repository nor a lasting scratch holds it.
  const cwd = rufloRunDir(step.db);
  try {
    const { executable, args: argv } = rufloInvocation(step.ruflo, args);
    return run(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: STEP_TIMEOUT_MS, cwd, windowsHide: true,
      env: { ...process.env, ...RUFLO_ENV, CLAUDE_FLOW_MEMORY_PATH: cwd } });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

/** The stored row by exact key: node:sqlite first, the ruflo CLI when that reader is unavailable. */
function readBackRow(run, step) {
  const fast = withProgressionReader(step.db, (reader) => reader.readContent(TURN_NAMESPACE, step.key));
  if (fast.ok) return fast.value;
  const r = runRuflo(run, step, ['memory', 'retrieve', '--key', step.key, '--namespace', TURN_NAMESPACE, '--value-only', '--path', step.db]);
  return r.status === 0 ? String(r.stdout || '') : null;
}

/** The detached worker: run each step in order, bounded, and append one receipt per step. */
export function runSteps({ steps = [], receipts } = {}, { run = spawnSync } = {}) {
  const results = [];
  for (const step of steps) {
    const row = { at: new Date().toISOString(), kind: step.kind, db: step.db, key: step.kind === 'store' ? step.key : undefined,
      ok: false, status: null, error: null };
    let value = null;
    try {
      if (step.kind === 'store') {
        const doc = JSON.parse(fs.readFileSync(step.spool, 'utf8'));
        value = doc?.entries?.[0]?.value;
        if (typeof value !== 'string' || sha256(value) !== step.hash) throw new Error('spool does not hold the queued record');
      }
      // RE-CHECKED HERE (replacement race): the store may have been swapped for a link since the hook chose it.
      const problem = storeContainmentProblem(step.db, { allowMissing: step.scope === 'global' });
      if (problem) row.error = `refused before write: ${problem}`;
      else if (step.kind === 'store') {
        const r = runRuflo(run, step, ['memory', 'import', '-i', step.spool, '-n', TURN_NAMESPACE, '--path', step.db]);
        row.status = Number.isInteger(r.status) ? r.status : null;
        const said = safeLine(r.stderr) || safeLine(String(r.stdout || '').split(/\r?\n/).filter((l) => /skipped|error|fail|refus/i.test(l)).join('\n'));
        if (r.error) row.error = safeLine(r.error.message);
        else if (row.status !== 0) row.error = said || `ruflo exited ${row.status}`;
        else {
          // `memory import` exits 0 even when it skipped the entry (measured, ruflo 3.51.1): only an exact
          // read-back of the same bytes proves the record exists.
          const back = readBackRow(run, step);
          row.readBack = back === null ? 'missing' : sha256(back) === step.hash ? 'verified' : 'different';
          if (row.readBack === 'verified') row.ok = true;
          else row.error = `ruflo exited 0 but the row was ${row.readBack === 'missing' ? 'not found' : 'different'} on exact read-back${said ? ` (${said})` : ''}`;
        }
      } else {
        const r = runRuflo(run, step, step.args);
        row.status = Number.isInteger(r.status) ? r.status : null;
        row.ok = row.status === 0 && !r.error;
        if (!row.ok) row.error = safeLine(r.stderr) || (r.error ? safeLine(r.error.message) : `ruflo exited ${row.status}`);
      }
    } catch (e) { row.error = safeLine(e.message); } finally {
      if (step.spool) { try { fs.rmSync(step.spool, { force: true }); } catch { /* swept below */ } }
    }
    results.push(row);
    if (receipts) appendReceipt(receipts, row);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--run-steps') {
    try { runSteps(JSON.parse(process.argv[3] || '{}')); } catch { /* a detached worker has no one to report to */ }
    process.exit(0);
  }
}
