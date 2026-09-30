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
 * WHERE: the project's `.swarm/memory.db` when it exists, else the machine-wide
 * `~/.claude/global-memory/.swarm/memory.db` (outside every repository). `.swarm` is NEVER created
 * inside a project — see session-snapshot-hook.mjs's writeSessionSnapshot for why that is trespass.
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
 * CODEX: codex-cli 0.158.0's own `stop.command.input` schema — see `CODEX_STOP_SCHEMA_FIELDS` in
 * ./codex-hook-events.mjs for the full field list as read from the installed binary (2026-09-29;
 * that constant's own header explains why it, not another hand-copied citation, is the source of
 * record). The two fields this function actually reads are `session_id` (the PRIMARY turn-identity
 * key, ahead of `transcript_path`) and `last_assistant_message` (nullable).
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

export function buildTurnRecord({ turn, project, host, session, at = new Date() }) {
  const parts = [`[turn ${at.toISOString()} project=${project} host=${host}]`,
    `OUTCOME: ${turn.finalText.replace(/\s+/g, ' ').slice(0, 2500)}`];
  if (turn.files.length) parts.push(`FILES CHANGED: ${turn.files.slice(0, 25).join(', ')}`);
  if (turn.actions.length) parts.push(`ACTIONS: ${turn.actions.slice(-15).join(' • ')}`);
  parts.push(`SESSION: ${session || '?'}`);
  return parts.join('  ||  ').slice(0, 4000);
}

/** Project db if the project already has one; otherwise the machine-wide db outside every repo. */
export function resolveTurnDb({ projectDir, home = os.homedir(), env = process.env } = {}) {
  const projectDb = path.join(projectDir, '.swarm', 'memory.db');
  try { if (fs.statSync(projectDb).isFile()) return { db: projectDb, scope: 'project' }; } catch { /* absent */ }
  const globalDb = env.RUVNET_TURN_GLOBAL_DB || path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db');
  return { db: globalDb, scope: 'global' };
}

const projectName = (projectDir) => path.basename(path.resolve(projectDir)).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';

/** Detached worker launch: the hook returns immediately; the worker runs the steps in order. */
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

/**
 * Capture this turn's outcome (Stop) and/or queue distillation (SessionEnd, PreCompact).
 * Returns a plain report; `skipped` / `distill.skipped` carry the reason whenever nothing is written.
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
  const report = { event, host, recorded: false, distill: { queued: false } };
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') {
    return { ...report, skipped: 'RUVNET_TURN_CAPTURE=off', distill: { queued: false, skipped: 'RUVNET_TURN_CAPTURE=off' } };
  }
  if (!ruflo) return { ...report, skipped: 'ruflo not found', distill: { queued: false, skipped: 'ruflo not found' } };
  const { db, scope } = resolveTurnDb({ projectDir, home, env });
  Object.assign(report, { db, scope });
  const steps = [];
  const project = projectName(projectDir);
  const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');

  if (event === 'Stop') {
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
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([turn.finalText, turn.files])).digest('hex');
      const stateFile = path.join(brainHome, 'turn-capture', 'last-turn.json');
      if (sameTurnSeen(stateFile, `${host}:${sessionKey}`, fingerprint)) report.skipped = 'same turn outcome already recorded';
      else {
        const at = now();
        const key = `turn-${project}-${at.getTime()}`;
        const value = buildTurnRecord({ turn, project, host, session: payload.session_id, at });
        steps.push({ kind: 'store', ruflo, args: ['memory', 'store', '-k', key, '--value', value, '-n', TURN_NAMESPACE,
          '--path', db, '--tags', `project=${project},host=${host}`, '--provenance', 'agent_output'] });
        Object.assign(report, { recorded: true, key, value });
      }
    }
  } else report.skipped = `turn outcomes are recorded at Stop, not ${event}`;

  if (event === 'SessionEnd' || event === 'PreCompact') {
    if (!fs.existsSync(db)) report.distill = { queued: false, skipped: 'no memory db to distill yet' };
    else {
      steps.push({ kind: 'distill', ruflo, args: ['memory', 'distill', 'run', '--db', db, '--namespace', TURN_NAMESPACE, '--max-entries', '500'] });
      report.distill = { queued: true, db };
    }
  }
  if (!steps.length) return report;

  try {
    // The machine-wide db lives outside every repository; its directory is created on first use so a
    // fresh machine records from its first turn. A project's `.swarm` is never created (scope check).
    if (scope === 'global') fs.mkdirSync(path.dirname(db), { recursive: true, mode: 0o700 });
    if (report.recorded) {
      fs.appendFileSync(path.join(path.dirname(db), 'agentdb-turns.jsonl'),
        `${JSON.stringify({ ts: Date.now(), key: report.key, project, host, value: report.value })}\n`, { mode: 0o600 });
    }
    report.launch = launch(steps, { receipts });
  } catch (error) {
    return { ...report, recorded: false, distill: { queued: false, skipped: `launch failed: ${error.message}` }, skipped: `launch failed: ${error.message}` };
  }
  return report;
}

/** The detached worker: run each step in order, bounded, and append one receipt per step. */
export function runSteps({ steps = [], receipts } = {}, { run = spawnSync } = {}) {
  const results = [];
  for (const step of steps) {
    let status = null;
    let error = null;
    const db = step.args[step.args.indexOf(step.kind === 'store' ? '--path' : '--db') + 1];
    try {
      const { executable, args } = rufloInvocation(step.ruflo, step.args);
      // CONTAINMENT (measured 2026-09-29, ruflo 3.48.0): even with an explicit --path, `memory store`
      // writes `.swarm/hnsw.index` and `ruvector.db` relative to its CWD. Run from an inherited cwd,
      // that planted `.swarm/` + `ruvector.db` in a repository that never adopted the brain — the
      // exact trespass session-snapshot-hook.mjs forbids. So every step runs INSIDE the db's own
      // directory, with ruflo's memory root pinned there too.
      const home = path.dirname(db);
      const r = run(executable, args, { stdio: 'ignore', timeout: STEP_TIMEOUT_MS, cwd: home, windowsHide: true,
        env: { ...process.env, ...RUFLO_ENV, CLAUDE_FLOW_MEMORY_PATH: home } });
      status = r.status;
      if (r.error) error = r.error.message;
    } catch (e) { error = e.message; }
    const row = { at: new Date().toISOString(), kind: step.kind, db,
      key: step.kind === 'store' ? step.args[step.args.indexOf('-k') + 1] : undefined, status, error };
    results.push(row);
    if (receipts) {
      try {
        fs.mkdirSync(path.dirname(receipts), { recursive: true, mode: 0o700 });
        fs.appendFileSync(receipts, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      } catch { /* receipts are best effort */ }
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--run-steps') {
  try { runSteps(JSON.parse(process.argv[3] || '{}')); } catch { /* a detached worker has no one to report to */ }
  process.exit(0);
}
