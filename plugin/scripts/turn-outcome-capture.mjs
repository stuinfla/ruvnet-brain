/**
 * turn-outcome-capture.mjs — record what each turn CONCLUDED, and make it recallable knowledge.
 *
 * Called from session-snapshot-hook.mjs's hook entry, so it rides the capture boundary
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
 * CODEX: native response_item JSONL is normalized mechanically through native-turn-transcript.
 * SessionEnd and PreCompact recover a closing outcome when Stop payload text is absent. Tool IDs
 * correlate observable gate outcomes; opaque custom orchestration inputs remain unclassified.
 *
 * LATENCY AND FAILURE (owner ruling 2026-10-12): the turn is written DIRECTLY with one bounded
 * `ruflo memory store` and proven by exact-key readback inside the hook's deadline (~0.5-1.3 s measured
 * on a live-size store). There is no journal, outbox or replay worker. A refused or unverified write is
 * recorded in the hook-failures ledger, which the next SessionStart summarizes. Only `memory distill run`
 * (SessionEnd/PreCompact) is detached. Advisory always: nothing here throws to the caller.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeTurnLines } from './native-turn-transcript.mjs';
import { resolveRuflo, rufloInvocation, rufloRunDir, rufloScratchRoot } from './ruflo-bin.mjs';
import { resolveBatchTarget } from './agentdb-recall-process.mjs';
import { redactText } from './continuity-events.mjs';
import { resolveProjectStore, globalEnrollmentAllowed, storeEncryptedAtRest, ENCRYPTED_STORE_REASON } from './project-store-resolver.mjs';
import { recordHookFailure } from './hook-failures.mjs';

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
function appendReceipt(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if (fs.statSync(file).size > RECEIPTS_MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* absent */ } // bounded like hook-failures
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
const flagValue = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
import { contentPathExcludes, pathIsExcluded, privateTurn, maskExcludedPaths, captureFailureReason, firstTurnCaptureNotice } from './turn-capture-privacy.mjs';
import { isDirectInvocation } from './entrypoint.mjs';

export const TURN_NAMESPACE = 'turns';
export const MIN_OUTCOME_CHARS = 200;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const STEP_TIMEOUT_MS = 60_000;
export const RECEIPTS_MAX_BYTES = 256 * 1024;
export const RECEIPTS_READ_BYTES = 512 * 1024;
const DETACH_BUDGET_THRESHOLD_MS = 2_600;
const MAX_ACTIVE_TURN_LEASES = 2;
const MAX_WAITING_TURN_SLOTS = 8;
const DETACHED_EXEC_CAP_MS = 30_000;
const DETACHED_WAIT_CAP_MS = 60_000;
const TURN_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
export const TURN_STATUS_FRESH_MS /* ✓ only when the newest receipt is verified and younger */ = 24 * 3_600_000;
const RUFLO_ENV = { RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false' };

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

export function resolveTurnDb({ projectDir, brainHome, requestedStorePath, gitTimeoutMs = 1000, unknownOriginalPath = false, deadlineAt = Infinity, signal, enrollmentRoots = {} } = {}) {
  if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('restore deadline exceeded');
  const resolved = resolveProjectStore({ projectDir, requestedStorePath, gitTimeoutMs, deadlineAt });
  if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('restore deadline exceeded');
  const capturePath = fs.realpathSync.native(projectDir);
  let policy = {};
  const file = brainHome && turnCapturePolicyFile(brainHome);
  if (file && fs.existsSync(file)) {
    try {
      policy = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (policy?.schemaVersion !== 1 || !consentMap(policy.projects)
        || (Object.hasOwn(policy, 'default') && !['on', 'off'].includes(policy.default))
        || (Object.hasOwn(policy, 'paths') && !consentMap(policy.paths))) throw new Error('invalid policy');
      contentPathExcludes(policy.contentPathExcludes);
    } catch { return { skipped: 'turn capture policy unreadable or invalid', projectRoot: resolved.projectRoot }; }
  }
  // A path rule wins over a project rule, allowing a linked checkout/subdirectory to opt out.
  const explicitSetting = policy.paths?.[capturePath] ?? policy.projects?.[resolved.projectRoot];
  const setting = explicitSetting ?? policy.default;
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
  if (!exists && setting === 'on' && explicitSetting !== 'on' && !globalEnrollmentAllowed({ resolution: resolved, brainHome, ...enrollmentRoots })) {
    return { db, scope: 'project', capturePath, projectRoot: resolved.projectRoot, skipped: 'global capture consent requires a safe Git project root; explicit project/path opt-in required' };
  }
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
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run-steps', JSON.stringify({ steps, receipts })], {
    cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, ...RUFLO_ENV, ...(brainHome ? { RUVNET_BRAIN_HOME: brainHome } : {}), ...(projectDir ? { RUVNET_TURN_PROJECT_DIR: projectDir } : {}) },
  });
  child.unref();
  return { launched: true, pid: child.pid };
}

const readTurnState = (stateFile) => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; } };

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

const isLivePending = (row, now = Date.now()) => Boolean(
  row?.pending === true
  && Number.isInteger(row.pid) && row.pid > 0
  && Number.isFinite(Number(row.deadlineAt)) && Number(row.deadlineAt) > now
  && isPidAlive(row.pid)
);

/** Bounded JSONL reader across rotated `.1` and live file; tracks existence, readability, oversize and malformed rows. */
export function readBoundedReceipts(receiptsPath, maxBytes = RECEIPTS_READ_BYTES) {
  const candidates = [{ file: `${receiptsPath}.1`, fileOrder: 0 }, { file: receiptsPath, fileOrder: 1 }];
  let exists = false;
  let unreadable = false;
  let oversized = false;
  let malformedCount = 0;
  const rows = [];
  for (const { file, fileOrder } of candidates) {
    let handle;
    try { handle = fs.openSync(file, 'r'); } catch (error) {
      if (error?.code !== 'ENOENT') { exists = true; unreadable = true; }
      continue;
    }
    exists = true;
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile()) { unreadable = true; continue; }
      const size = stat.size;
      if (size > maxBytes) oversized = true;
      const offset = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - offset);
      fs.readSync(handle, buf, 0, buf.length, offset);
      const lines = buf.toString('utf8').split(/\r?\n/);
      if (offset > 0) lines.shift();
      lines.forEach((line, lineOrder) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push({ row: parsed, fileOrder, lineOrder });
          else malformedCount += 1;
        } catch {
          malformedCount += 1;
        }
      });
    } catch {
      unreadable = true;
    } finally {
      try { fs.closeSync(handle); } catch { /* closed */ }
    }
  }
  return { exists, unreadable, oversized, malformedCount, rows };
}

/** The newest store receipt for this exact key across rotated and active receipt tails. */
const storeReceipt = (receipts, key) => {
  const { rows } = readBoundedReceipts(receipts);
  const matches = rows.filter(({ row }) => row.kind === 'store' && row.key === key);
  if (!matches.length) return null;
  matches.sort((a, b) => (Date.parse(a.row.at) || 0) - (Date.parse(b.row.at) || 0) || a.fileOrder - b.fileOrder || a.lineOrder - b.lineOrder);
  return matches.at(-1).row;
};
const verifiedReceipt = (r) => r?.status === 0 && r.verified === true;

const leaseBaseDir = (brainHome) => path.join(brainHome, 'turn-capture', 'leases');

function claimLeaseSlot(baseDir, prefix, cap, staleMs, token, now = Date.now()) {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < cap; i += 1) {
    const slotDir = path.join(baseDir, `${prefix}-${i}`);
    const ownerFile = path.join(slotDir, 'owner.json');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.mkdirSync(slotDir, { mode: 0o700 });
        try {
          fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, birth: now, token }), { mode: 0o600 });
        } catch (err) {
          try { fs.rmSync(slotDir, { recursive: true, force: true }); } catch { /* ignore */ }
          throw err;
        }
        return slotDir;
      } catch (err) {
        if (err?.code !== 'EEXIST') break;
        let stale = false;
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          if (!Number.isInteger(owner?.pid) || now - Number(owner.birth) > staleMs || !isPidAlive(owner.pid)) stale = true;
        } catch {
          try { if (now - fs.statSync(slotDir).mtimeMs > Math.min(staleMs, 1500)) stale = true; } catch { /* gone */ }
        }
        if (!stale) break;
        try { fs.rmSync(slotDir, { recursive: true, force: true }); } catch { break; }
      }
    }
  }
  return null;
}

function updateLeasePid(slotDir, pid, token) {
  if (!slotDir || !Number.isInteger(pid) || pid <= 0) return;
  const ownerFile = path.join(slotDir, 'owner.json');
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (token && owner?.token !== token) return;
    fs.writeFileSync(ownerFile, JSON.stringify({ pid, birth: owner.birth || Date.now(), token: owner.token }), { mode: 0o600 });
  } catch { /* slot released */ }
}

function releaseLeaseSlot(slotDir, token) {
  if (!slotDir) return;
  const ownerFile = path.join(slotDir, 'owner.json');
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (token && owner?.token !== token) return;
    fs.rmSync(slotDir, { recursive: true, force: true });
  } catch { /* already gone */ }
}

function detachTurnStore(step, { receipts, event, brainHome, projectDir, env, key, db, projectRoot, sessionHash }) {
  const token = crypto.randomBytes(12).toString('hex');
  const leases = leaseBaseDir(brainHome);
  const storeId = digest(db).slice(0, 16);
  const projectId = digest(projectRoot).slice(0, 16);
  const recordFail = (errMsg) => {
    const row = { at: new Date().toISOString(), kind: 'store', db: redactText(db), storeIdentity: digest(db), key, status: 1, verified: false, error: errMsg };
    try { appendReceipt(receipts, row); } catch { /* report via hook-failures */ }
    recordHookFailure({ hook: 'turn-capture', event, error: errMsg.slice(0, 160), store: storeId, project: projectId, ...(sessionHash ? { session: sessionHash } : {}), key }, { brainHome });
    return { recorded: false, detached: false, skipped: errMsg, receipt: row };
  };
  let waitDir;
  try {
    waitDir = claimLeaseSlot(leases, 'wait', MAX_WAITING_TURN_SLOTS, DETACHED_WAIT_CAP_MS, token);
  } catch (error) {
    return recordFail(`detached turn capture lease failed: ${redactText(error.message).slice(0, 120)}`);
  }
  if (!waitDir) return recordFail('detached turn capture capacity reached');
  const childDeadlineAt = Date.now() + DETACHED_WAIT_CAP_MS + DETACHED_EXEC_CAP_MS;
  let child;
  let spawned = false;
  let failedOnce = false;
  const failOnce = (errMsg) => {
    if (failedOnce) return null;
    failedOnce = true;
    releaseLeaseSlot(waitDir, token);
    return recordFail(errMsg);
  };
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run-turn-detached'], {
      cwd: os.tmpdir(),
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: {
        ...env,
        ...RUFLO_ENV,
        RUVNET_BRAIN_HOME: brainHome,
        RUVNET_TURN_PROJECT_DIR: projectDir,
        RUVNET_TURN_WAIT_SLOT: waitDir,
        RUVNET_TURN_TOKEN: token,
        RUVNET_TURN_RECEIPTS: receipts,
        RUVNET_TURN_EVENT: event,
        RUVNET_TURN_DEADLINE_AT: String(childDeadlineAt),
      },
    });
  } catch (error) {
    return failOnce(`detached turn capture spawn failed: ${redactText(error.message).slice(0, 120)}`);
  }
  child.stdin?.on('error', () => { /* child exited before pipe finished */ });
  child.once('spawn', () => {
    spawned = true;
    if (Number.isInteger(child.pid)) updateLeasePid(waitDir, child.pid, token);
  });
  child.once('error', (error) => {
    if (!spawned) failOnce(`detached turn capture spawn error: ${redactText(error?.message || error).slice(0, 120)}`);
  });
  if (!Number.isInteger(child?.pid)) {
    child.stdin?.destroy();
    return failOnce('detached turn capture did not yield a child pid');
  }
  updateLeasePid(waitDir, child.pid, token);
  const liveReceipt = {
    at: new Date().toISOString(),
    kind: 'store',
    db: redactText(db),
    storeIdentity: digest(db),
    store: storeId,
    key,
    status: null,
    verified: false,
    pending: true,
    pid: child.pid,
    deadlineAt: childDeadlineAt,
    error: null,
  };
  try { appendReceipt(receipts, liveReceipt); } catch { /* status remains inspectable via child outcome */ }
  child.stdin.end(JSON.stringify({ step, receipts, event }));
  child.unref();
  return { recorded: false, detached: true, pid: child.pid, receipt: liveReceipt };
}

function sameTurnSeen(stateFile, sessionKey, fingerprint, receipts) {
  const previous = readTurnState(stateFile)[sessionKey];
  if (previous?.fingerprint !== fingerprint) return false;
  const receipt = storeReceipt(receipts, previous.key);
  // No receipt yet: an in-flight worker gets a bounded grace period; a killed/lost worker cannot consume the turn forever.
  return receipt ? verifiedReceipt(receipt) : Date.now() - previous.at < 2 * STEP_TIMEOUT_MS + 10_000;
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
 * Capture this turn's outcome (Stop) and/or start distillation (SessionEnd, PreCompact). Returns a plain report:
 * `queued` means a request, never proof the store committed; `skipped` / `distill.skipped` carry the reason.
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
  deadlineAt,
  run,
  write = runSteps,
} = {}) {
  const report = { event, host, queued: false, recorded: false, distill: { queued: false } };
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') {
    return { ...report, skipped: 'RUVNET_TURN_CAPTURE=off', distill: { queued: false, skipped: 'RUVNET_TURN_CAPTURE=off' } };
  }
  // Review M1: a capture that cannot happen is LOUD (a ledger row with a fixed reason, never turn text).
  const loud = (reason, store, extras = {}) => {
    recordHookFailure({
      hook: 'turn-capture',
      event,
      error: reason.slice(0, 160),
      ...(store ? { store: digest(store).slice(0, 16) } : {}),
      ...extras,
    }, { brainHome });
    return reason;
  };
  const baseProjectCorr = { project: digest(projectDir).slice(0, 16), ...(payload?.session_id ? { session: digest(payload.session_id).slice(0, 16) } : {}) };
  let target;
  try { target = resolveTurnDb({ projectDir, brainHome, ...(deadlineAt ? { deadlineAt } : {}) }); } catch (error) { return { ...report, skipped: loud(`store resolution failed: ${redactText(error.message)}`, undefined, baseProjectCorr) }; }
  const { db, scope, projectRoot } = target;
  Object.assign(report, { db, scope });
  if (target.skipped) return { ...report, skipped: target.skipped, distill: { queued: false, skipped: target.skipped } };
  const steps = [];
  const rootStat = fs.statSync(projectRoot);
  const binding = { projectRoot, projectDir: fs.realpathSync.native(projectDir), brainHome, rootIdentity: `${rootStat.dev}:${rootStat.ino}` };
  let dedupe;
  const project = projectName(projectRoot);
  const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
  const sessionHash = payload?.session_id ? digest(payload.session_id).slice(0, 16) : undefined;
  const corr = { project: digest(projectRoot).slice(0, 16), ...(sessionHash ? { session: sessionHash } : {}) };

  // ONE WRITER PER TURN (ADR-105 §7): the product is the only writer of project turn history. The
  // former deferral to a user-level ~/.claude hook (ADR-100 §3) could never fire — its probe never
  // reported a writer — and cost a git call on every Stop, so it was removed (ADR-106).
  if (['Stop', 'SessionEnd', 'PreCompact'].includes(event)) {
    const sessionKey = String(payload.session_id || payload.transcript_path || '');
    const message = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
    let turn = { finalText: '', files: [], actions: [] };
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      // With the closing message in hand, the transcript is read immediately (tool calls are already
      // flushed); without it, wait for the closing message to land, bounded.
      try { turn = claudeTurn(nativeTurnLines(readTranscript(payload.transcript_path, { maxMs: message || event !== 'Stop' ? 0 : settleMs }), host)); } catch { /* unreadable */ }
    }
    if (message && (message.length >= MIN_OUTCOME_CHARS || message.length >= turn.finalText.length)) turn.finalText = message;
    turn = privateTurn(turn, target.contentPathExcludes, target.capturePath);
    if (!sessionKey) report.skipped = 'no session identity in the host payload';
    else if (turn.finalText.length < MIN_OUTCOME_CHARS && !turn.files.length) {
      report.skipped = turn.excludedResource ? 'turn content withheld: explicitly excluded resource' : host === 'codex' && !message ? 'codex payload carried no last_assistant_message' : 'trivial turn';
    } else if (storeEncryptedAtRest(db)) report.skipped = loud(`${ENCRYPTED_STORE_REASON}; turn not written (opt out: RUVNET_TURN_CAPTURE=off)`, db, corr); // #439: no ruflo spawn that can only be refused
    else {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([turn.finalText, turn.files])).digest('hex');
      const stateFile = path.join(brainHome, 'turn-capture', 'last-turn.json');
      const identity = crypto.createHash('sha256').update(`${host}:${db}:${sessionKey}`).digest('hex');
      const key = `turn-${project}-${digest(`${identity}:${fingerprint}`).slice(0, 40)}`;
      const existingReceipt = storeReceipt(receipts, key);
      if (sameTurnSeen(stateFile, identity, fingerprint, receipts)) report.skipped = 'same turn outcome already queued or verified';
      // Proven at Stop already: SessionEnd/PreCompact must not re-send it (2026-10-19/20: each re-send was an "append rejected" row).
      else if (verifiedReceipt(existingReceipt)) report.skipped = 'turn key already verified at an earlier boundary';
      else if (isLivePending(existingReceipt, Date.now())) report.skipped = 'turn key already pending verification';
      else {
        const at = now();
        dedupe = { stateFile, identity, fingerprint, key };
        const value = buildTurnRecord({ turn, project, host, session: payload.session_id, at });
        steps.push({ ...binding, kind: 'store', ruflo, sessionHash,
          turnInput: { turn, project, host, session: payload.session_id, at: at.toISOString() },
          args: ['memory', 'store', '--key', key, '--value', value, '--namespace', TURN_NAMESPACE,
            '--path', db, '--no-upsert', '--require-native', '--append-only', '--tags', `project=${project},host=${host}`, '--provenance', 'agent_output'] });
        Object.assign(report, { queued: true, key, value });
      }
    }
  } else report.skipped = `no turn outcome capture at ${event}`;

  if (event === 'SessionEnd' || event === 'PreCompact') {
    if (!fs.existsSync(db)) report.distill = { queued: false, skipped: 'no memory db to distill yet' };
    else {
      steps.push({ ...binding, kind: 'distill', ruflo, sessionHash, args: ['memory', 'distill', 'run', '--db', db, '--namespace', TURN_NAMESPACE, '--max-entries', '500'] });
      report.distill = { queued: true, db };
    }
  }
  if (!steps.length) return report;
  if (!ruflo) return { ...report, queued: false, skipped: loud('ruflo not found', db, { ...corr, ...(report.key ? { key: report.key } : {}) }), distill: { queued: false, skipped: 'ruflo not found' } };

  try {
    // Only explicit persisted consent permits creating a project store directory.
    if (target.optedIn) fs.mkdirSync(path.dirname(db), { recursive: true, mode: 0o700 });
    // The turn is written NOW, bounded by the hook's deadline, and proven by exact-key readback (owner
    // ruling 2026-10-12: no outbox, no journal, no replay). A refusal is recorded by runSteps in the
    // hook-failures ledger, so SessionStart reports it. Under a tight SessionEnd budget (< 2600 ms),
    // first-attempt capture hands off over stdin to one bounded detached worker.
    const store = steps.filter((item) => item.kind === 'store');
    if (store.length) {
      const tightDeadline = event === 'SessionEnd' && Number.isFinite(deadlineAt) && (deadlineAt - Date.now() < DETACH_BUDGET_THRESHOLD_MS);
      if (tightDeadline && write === runSteps && run === undefined) {
        const detachedStore = detachTurnStore(store[0], { receipts, event, brainHome, projectDir: binding.projectDir, env, key: report.key, db, projectRoot, sessionHash });
        Object.assign(report, detachedStore);
      } else {
        const [row] = write({ steps: store, receipts, event }, { env, home, projectDir: binding.projectDir, brainHome,
          ...(deadlineAt ? { deadlineMs: deadlineAt } : {}), ...(run ? { run } : {}) });
        Object.assign(report, {
          recorded: row?.verified === true,
          receipt: row,
          ...(row?.alreadyRecorded ? {
            alreadyRecorded: true,
            committedAt: row.committedAt,
            committedValueSha256: row.committedValueSha256,
          } : {}),
        });
        if (row?.verified && dedupe) markTurnQueued(dedupe.stateFile, dedupe.identity, dedupe.fingerprint, dedupe.key);
      }
    }
    const detached = steps.filter((item) => item.kind !== 'store');
    if (detached.length) report.launch = launch(detached, { receipts, brainHome, projectDir: binding.projectDir, env });
  } catch (error) {
    const reason = loud(`launch failed: ${redactText(error.message)}`, db, { ...corr, ...(report.key ? { key: report.key } : {}) });
    return { ...report, queued: false, recorded: false, distill: { queued: false, skipped: reason }, skipped: reason };
  }
  return report;
}

const SINGLE_CHILD_STORE_CODE = `
import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, ...rest) => process.stderr.write(c, ...rest);
let out;
try {
  const mod = await import(req.moduleUrl);
  if (typeof mod.storeEntry !== 'function' || typeof mod.getEntry !== 'function' || typeof mod.resolveDbPath !== 'function') {
    out = { fallback: true };
  } else {
    const dbPath = mod.resolveDbPath(req.db);
    let store;
    try {
      store = await mod.storeEntry({
        key: req.key,
        value: req.value,
        namespace: req.namespace,
        generateEmbeddingFlag: true,
        requireNative: true,
        appendOnly: true,
        tags: [],
        upsert: false,
        provenanceType: 'agent_output',
        dbPath,
      });
    } catch (storeError) {
      store = { success: false, error: String(storeError?.message || storeError) };
    }
    const dup = store?.success === false && /already exists/i.test(String(store.error || ''));
    const get = (store?.success === true || dup)
      ? await mod.getEntry({ key: req.key, namespace: req.namespace, dbPath })
      : null;
    out = {
      fallback: false,
      store: { success: store?.success === true, error: store?.error || null },
      get: get ? { success: get.success === true, found: get.found === true, entry: get.entry ? { content: get.entry.content } : null } : null,
    };
  }
} catch (error) {
  out = { fallback: false, store: { success: false, error: String(error?.message || error) }, get: null };
}
await new Promise((resolve) => {
  try { realWrite(JSON.stringify(out) + '\\n', () => resolve()); } catch { resolve(); }
});
process.exit(0);
`;

/** Exact (namespace, key, content) readback. Strips at most one trailing newline; exit zero alone never proves capture. */
function readBack({ ruflo, db, key, run, options }) {
  const invocation = rufloInvocation(ruflo, ['memory', 'retrieve', '--key', key, '--namespace', TURN_NAMESPACE, '--value-only', '--path', db]);
  const result = run(invocation.executable, invocation.args, options);
  return result.status === 0 ? String(result.stdout || '').replace(/\r?\n$/, '') : null;
}

/** The worker: bounded steps, safe error evidence, exact content readback. */
export function runSteps({ steps = [], receipts, event = '' } = {}, { run: suppliedRun = spawnSync, read = readBack,
  env = process.env, deadlineMs, home = os.homedir(),
  projectDir = env.RUVNET_TURN_PROJECT_DIR || process.cwd(),
  brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain') } = {}) {
  const run = (binary, args, options) => {
    if (deadlineMs === undefined) return suppliedRun(binary, args, options);
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return { status: 1, error: new Error('turn write deadline exhausted') };
    return suppliedRun(binary, args, { ...options, timeout: Math.min(options.timeout, remaining) });
  };
  const customSeam = suppliedRun !== spawnSync || read !== readBack;
  const results = [];
  for (const queued of steps) {
    let status = 1; let error = null; let skipped = null; let verified = false; let db = ''; let key; let privacyPatterns = []; let scratchRun = null;
    let alreadyRecorded = false; let committedAt; let committedValueSha256;
    let projectRootForCorr;
    const kind = queued.kind;
    try {
      if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') throw new Error('RUVNET_TURN_CAPTURE=off');
      if (kind === 'store') { key = flagValue(queued.args, '--key'); db = flagValue(queued.args, '--path'); }
      if ((!queued.projectRoot || !queued.projectDir || !queued.brainHome)) throw new Error('queued step has no canonical project binding');
      const bound = deadlineMs === undefined ? {} : { deadlineAt: deadlineMs }; // review M4: git obeys the hook deadline
      const target = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: 1000, ...bound });
      if (target.skipped) throw new Error(target.skipped);
      privacyPatterns = target.contentPathExcludes;
      db = target.db;
      projectRootForCorr = target.projectRoot;
      let args; let value; let binding;
      if (kind === 'store') {
        const data = { key: flagValue(queued.args, '--key'), value: flagValue(queued.args, '--value'), db: flagValue(queued.args, '--path') };
        if (typeof data.key !== 'string' || typeof data.value !== 'string') throw new Error('invalid turn store step');
        if (data.db !== db) throw new Error('foreign turn store rejected');
        if (storeEncryptedAtRest(db)) throw new Error(ENCRYPTED_STORE_REASON);
        if (queued.brainHome !== brainHome) throw new Error('turn consent settings differ from trusted caller');
        binding = queued;
        key = data.key; value = maskExcludedPaths(redactText(data.value), target.contentPathExcludes, target.capturePath);
        if (value !== redactText(data.value)) throw new Error('content exclusions changed; turn not written');
        args = ['memory', 'store', '--key', key, '--value', value, '--namespace', TURN_NAMESPACE, '--path', db, '--no-upsert', '--require-native', '--append-only', '--provenance', 'agent_output'];
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
      const origin = resolveTurnDb({ projectDir: binding.projectDir, brainHome, requestedStorePath: db, gitTimeoutMs: 1000, ...bound });
      if (origin.skipped) throw new Error(origin.skipped);
      if (origin.projectRoot !== target.projectRoot || origin.db !== db) throw new Error('queued canonical capture origin changed');
      const ruflo = resolveRuflo({ env, home });
      if (!ruflo) throw new Error('ruflo not found');
      const remaining = deadlineMs === undefined ? STEP_TIMEOUT_MS : deadlineMs - Date.now();
      if (remaining <= 0) throw new Error('turn write deadline exhausted');
      // Measured 2026-10-10 with global Ruflo 3.56.3: cwd=<project>/.swarm litters ruvector.db/.claude-flow there, and
      // CLAUDE_FLOW_MEMORY_PATH=<.swarm> makes Ruflo create a second agentdb-memory.db beside the canonical store.
      // The explicit --path already binds the store, so run from private scratch with neither. One fresh run-* directory
      // per call, removed after it (ruflo-bin rufloRunDir): the shared project scratch dir used here before kept ruflo's
      // ruvector.db/.swarm/.claude-flow copies between turns, which --doctor counted as cruft after every turn (2026-10-30).
      scratchRun = rufloRunDir(db, { root: rufloScratchRoot({ ...env, RUVNET_BRAIN_HOME: brainHome }) });
      const options = { encoding: 'utf8', timeout: Math.min(STEP_TIMEOUT_MS, remaining), windowsHide: true,
        cwd: scratchRun,
        maxBuffer: 1024 * 1024, env: { ...env, ...RUFLO_ENV } };
      delete options.env.CLAUDE_FLOW_MEMORY_PATH;

      const ti = queued.turnInput;
      const judgeReadback = (readVal, duplicate) => {
        if (readVal === null) return { matched: false };
        if (readVal === value) return { matched: true, alreadyRecorded: false };
        if (!duplicate || !ti || typeof ti !== 'object') return { matched: false };
        const m = /^\[turn (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z) /.exec(readVal);
        if (!m) return { matched: false };
        const committedTs = m[1];
        const committedDate = new Date(committedTs);
        const currentDate = new Date(ti.at);
        if (!Number.isFinite(committedDate.getTime()) || !Number.isFinite(currentDate.getTime())) return { matched: false };
        const rebuild = (atDate) => maskExcludedPaths(redactText(buildTurnRecord({
          turn: ti.turn, project: ti.project, host: ti.host, session: ti.session, at: atDate,
        })), target.contentPathExcludes, target.capturePath);
        if (rebuild(currentDate) !== value) return { matched: false };
        if (rebuild(committedDate) !== readVal) return { matched: false };
        return { matched: true, alreadyRecorded: true, committedAt: committedTs, committedValueSha256: digest(readVal) };
      };

      const batchTarget = (kind === 'store' && !env.RUFLO_MEMORY_SCAN_ON_WRITE && !customSeam)
        ? resolveBatchTarget(ruflo, { env, deadlineAt: deadlineMs ?? (Date.now() + options.timeout) })
        : null;
      let usedSingleChild = false;
      if (batchTarget) {
        const single = run(batchTarget.node, ['--input-type=module', '-e', SINGLE_CHILD_STORE_CODE], {
          ...options,
          killSignal: 'SIGKILL',
          input: JSON.stringify({ moduleUrl: batchTarget.moduleUrl, db, namespace: TURN_NAMESPACE, key, value }),
        });
        let parsed = null;
        if (single.stdout) {
          const outLines = String(single.stdout).trim().split(/\r?\n/).filter(Boolean);
          for (let i = outLines.length - 1; i >= 0; i -= 1) {
            try { parsed = JSON.parse(outLines[i]); break; } catch { /* scan earlier line */ }
          }
        }
        if (parsed && parsed.fallback === true) {
          usedSingleChild = false;
        } else {
          usedSingleChild = true;
          const storeRes = parsed?.store;
          const getRes = parsed?.get;
          status = single.error || single.status !== 0 ? 1 : (storeRes?.success === true ? 0 : 1);
          const storeErrText = String(storeRes?.error || '');
          const duplicate = status !== 0 && /already exists/i.test(storeErrText);
          const readVal = (status === 0 || duplicate)
            && getRes?.success === true && getRes?.found === true && typeof getRes?.entry?.content === 'string'
            ? getRes.entry.content : null;
          if (status === 0 || duplicate) {
            const verdict = judgeReadback(readVal, duplicate);
            if (verdict.matched) {
              verified = true; status = 0;
              if (verdict.alreadyRecorded) {
                alreadyRecorded = true;
                committedAt = verdict.committedAt;
                committedValueSha256 = verdict.committedValueSha256;
              }
            }
          }
          if (!verified && duplicate) error = readVal === null ? 'duplicate turn key readback unavailable' : 'duplicate turn key holds different content';
          else if (!verified && (single.error || status !== 0)) {
            error = storeErrText
              ? captureFailureReason({ stderr: storeErrText }, status)
              : captureFailureReason(parsed ? { error: single.error, stderr: single.stderr } : single, status);
          } else if (!verified) { status = 1; error = 'exact turn key/content readback failed'; }
        }
      }

      if (!usedSingleChild) {
        const invocation = rufloInvocation(ruflo, args);
        const r = run(invocation.executable, invocation.args, options);
        status = Number.isInteger(r.status) ? r.status : 1;
        const duplicate = kind === 'store' && status !== 0 && /already exists/i.test(captureFailureReason(r, status)); // append-only refusal
        let readVal = null;
        if (kind === 'store' && (status === 0 || duplicate)) {
          readVal = read({ ruflo, db, key, run, options });
          const verdict = judgeReadback(readVal, duplicate);
          if (verdict.matched) {
            verified = true; status = 0;
            if (verdict.alreadyRecorded) {
              alreadyRecorded = true;
              committedAt = verdict.committedAt;
              committedValueSha256 = verdict.committedValueSha256;
            }
          }
        }
        if (kind === 'distill' && status === 0) {
          const match = /(?:^|\n)\s*skipped:\s*([^\n]+)/i.exec(String(r.stdout || '').replace(/\x1b\[[0-9;]*m/g, ''));
          if (match) skipped = redactText(match[1]).slice(0, 300);
        }
        if (!verified && duplicate) error = readVal === null ? 'duplicate turn key readback unavailable' : 'duplicate turn key holds different content';
        else if (!verified && (r.error || status !== 0)) error = captureFailureReason(r, status);
        else if (kind === 'store' && !verified) { status = 1; error = 'exact turn key/content readback failed'; }
      }
    } catch (e) { status = 1; error = redactText(e.message).slice(0, 300); }
    if (scratchRun) { try { fs.rmSync(scratchRun, { recursive: true, force: true }); } catch { /* a stale run-* is swept by the next rufloRunDir */ } }
    if (error) error = maskExcludedPaths(error, privacyPatterns, projectDir);
    const row = {
      at: new Date().toISOString(),
      kind,
      db: redactText(db),
      storeIdentity: digest(db),
      key,
      status,
      error,
      ...(kind === 'store' ? { verified } : {}),
      ...(alreadyRecorded ? { alreadyRecorded: true, committedAt, committedValueSha256 } : {}),
      ...(skipped ? { skipped } : {}),
    };
    results.push(row);
    if (receipts) { try { appendReceipt(receipts, row); } catch { /* the ledger row below still reports a failure */ } }
    if (error || (kind === 'store' && !verified)) {
      const sessionCorr = queued.turnInput?.session
        ? digest(queued.turnInput.session).slice(0, 16)
        : (queued.sessionHash || undefined);
      const projCorr = projectRootForCorr || queued.projectRoot || projectDir;
      recordHookFailure({
        hook: kind === 'store' ? 'turn-capture' : 'turn-distill',
        event,
        error: String(error || 'exact turn key/content readback failed').slice(0, 160),
        ...(db ? { store: digest(db).slice(0, 16) } : {}),
        ...(projCorr ? { project: digest(projCorr).slice(0, 16) } : {}),
        ...(sessionCorr ? { session: sessionCorr } : {}),
        ...(key ? { key } : {}),
      }, { brainHome });
    }
  }
  return results;
}

/** Bounded recent evidence, isolated by canonical db. A continuity success cannot mask turn failures. */
export function turnRecordingStatus({ projectDir = process.cwd(), env = process.env, home = os.homedir(), now = Date.now(), noticeOnFirstUse = false } = {}) {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  let target;
  try { target = resolveTurnDb({ projectDir, brainHome }); } catch { return { state: 'unknown', line: 'turn recording unavailable: canonical store resolution failed' }; }
  if (String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off' || target.skipped) return { state: 'unknown', line: `turn recording n/a — ${target.skipped || 'RUVNET_TURN_CAPTURE=off'}` };
  if (storeEncryptedAtRest(target.db)) return { state: 'warn', line: `turn recording off for this store — ${ENCRYPTED_STORE_REASON}. Keep this project's store unencrypted, or set RUVNET_TURN_CAPTURE=off to stop trying` };
  const notice = noticeOnFirstUse ? firstTurnCaptureNotice({ target, brainHome, policyFile: turnCapturePolicyFile(brainHome), env }) : null;
  const status = (value) => ({ ...value, ...(notice ? { notice } : {}) });
  const receiptsPath = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
  const receiptData = readBoundedReceipts(receiptsPath, RECEIPTS_READ_BYTES);
  const storeHash = digest(target.db);
  const id = storeHash.slice(0, 16);
  const canonical = receiptData.rows
    .filter(({ row: r }) => r.kind === 'store' && (r.storeIdentity === storeHash || r.db === target.db) && now - Date.parse(r.at) < 7 * 86_400_000)
    .sort((a, b) => (Date.parse(a.row.at) || 0) - (Date.parse(b.row.at) || 0) || a.fileOrder - b.fileOrder || a.lineOrder - b.lineOrder);
  const byKey = new Map();
  for (const { row, fileOrder, lineOrder } of canonical) {
    const k = row.key ? `key:${row.key}` : `anon:${fileOrder}:${lineOrder}`;
    if (byKey.has(k)) byKey.delete(k);
    byKey.set(k, row);
  }
  const rows = [...byKey.values()].slice(-20);
  const ledgerPath = path.join(brainHome, 'hook-failures.jsonl');
  const ledgerData = readBoundedReceipts(ledgerPath, RECEIPTS_READ_BYTES);
  const integrityIssues = [];
  if (receiptData.unreadable) integrityIssues.push('receipts unreadable');
  if (receiptData.oversized) integrityIssues.push('receipts oversized');
  if (receiptData.malformedCount > 0) integrityIssues.push(`${receiptData.malformedCount} malformed receipt row(s)`);
  if (ledgerData.unreadable) integrityIssues.push('hook ledger unreadable');
  if (ledgerData.oversized) integrityIssues.push('hook ledger oversized');
  if (ledgerData.malformedCount > 0) integrityIssues.push(`${ledgerData.malformedCount} malformed hook-ledger row(s)`);
  const integritySuffix = integrityIssues.length ? `; ${integrityIssues.join(', ')}` : '';
  const inFlight = rows.filter((r) => r.pending === true && isLivePending(r, now));
  const historical = rows.filter((r) => !r.pending && r.status === 0 && r.verified === undefined);
  const failed = rows.filter((r) => (r.pending === true ? !isLivePending(r, now) : (r.status !== 0 || r.verified === false)));
  if (failed.length) {
    const latestFail = failed.at(-1);
    const reason = redactText(latestFail.error || (latestFail.pending ? 'detached turn capture timed out or died' : 'write has no exact readback evidence')).slice(0, 220);
    const meta = [`store:${id.slice(0, 8)}`];
    if (latestFail.key) meta.push(`key:${digest(latestFail.key).slice(0, 8)}`);
    if (latestFail.at) meta.push(`at ${latestFail.at}`);
    return status({ state: 'warn', line: `turn recording failing ${failed.length}/${rows.length} — ${reason} (${meta.join(', ')})${integritySuffix}` });
  }
  // Review M1: ✓ needs the NEWEST receipt verified, < TURN_STATUS_FRESH_MS old, and no later turn-capture ledger row.
  const newest = rows.filter((r) => !r.pending).at(-1) || rows.at(-1);
  const newestAt = newest ? Date.parse(newest.at) : -Infinity;
  const ledgerRows = ledgerData.rows
    .map((entry) => entry.row)
    .filter((r) => {
      if (r.hook !== 'turn-capture') return false;
      if (!newest) return true;
      const rAt = Date.parse(r.at);
      return !Number.isFinite(rAt) || !Number.isFinite(newestAt) || rAt > newestAt;
    });
  const laterFailure = ledgerRows.findLast((r) => r.store === id);
  const laterUnscoped = ledgerRows.findLast((r) => !r.store);
  if (laterFailure) {
    return status({ state: 'warn', line: `turn recording failing — ${redactText(String(laterFailure.error || 'capture skipped')).slice(0, 200)} (since ${laterFailure.at}, store:${id.slice(0, 8)})${integritySuffix}` });
  }
  if (laterUnscoped) {
    return status({ state: 'unknown', line: `turn recording status uncertain — unscoped turn-capture failure (${redactText(String(laterUnscoped.error || 'capture skipped')).slice(0, 120)} at ${laterUnscoped.at}; applicability unknown)${integritySuffix}` });
  }
  if (receiptData.unreadable || ledgerData.unreadable) return status({ state: 'unknown', line: `turn recording history unreadable (${integrityIssues.join(', ')})` });
  if (inFlight.length) return status({ state: 'unknown', line: `turn recording pending (${inFlight.length} in-flight detached capture${inFlight.length === 1 ? '' : 's'} — not yet verified${integritySuffix})` });
  if (historical.length) return status({ state: 'unknown', line: `turn recording unverified historical (${historical.length} receipts without exact readback evidence${integritySuffix})` });
  if (receiptData.malformedCount > 0 || receiptData.oversized || ledgerData.malformedCount > 0 || ledgerData.oversized) {
    return status({ state: 'unknown', line: `turn recording unverified (${integrityIssues.join(', ')})` });
  }
  if (newest && now - Date.parse(newest.at) >= TURN_STATUS_FRESH_MS) return status({ state: 'unknown', line: `turn recording not proven recently — newest exact readback ${newest.at}` });
  return status(rows.length ? { state: 'ok', line: `turn recording ✓ (${rows.length}/${rows.length} exact readbacks)` }
    : { state: 'unknown', line: 'turn recording not yet proven — no exact readback receipt' });
}

async function runDetachedTurn() {
  const token = process.env.RUVNET_TURN_TOKEN || '';
  const waitDir = process.env.RUVNET_TURN_WAIT_SLOT || '';
  const brainHome = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  const receipts = process.env.RUVNET_TURN_RECEIPTS || path.join(brainHome, 'turn-capture', 'receipts.jsonl');
  const event = process.env.RUVNET_TURN_EVENT || 'SessionEnd';
  const deadlineEnv = Number(process.env.RUVNET_TURN_DEADLINE_AT);
  let step = null;
  try {
    const input = fs.readFileSync(0, 'utf8');
    const parsed = JSON.parse(input || '{}');
    step = parsed.step || null;
  } catch { step = null; }
  if (!step) { releaseLeaseSlot(waitDir, token); return; }
  const leases = leaseBaseDir(brainHome);
  const waitUntil = Math.min(Date.now() + DETACHED_WAIT_CAP_MS, Number.isFinite(deadlineEnv) && deadlineEnv > 0 ? deadlineEnv : Infinity);
  let execDir = null;
  while (!execDir && Date.now() < waitUntil) {
    execDir = claimLeaseSlot(leases, 'exec', MAX_ACTIVE_TURN_LEASES, DETACHED_EXEC_CAP_MS, token);
    if (!execDir) Atomics.wait(TURN_WAIT_BUF, 0, 0, 25);
  }
  releaseLeaseSlot(waitDir, token);
  const key = flagValue(step.args || [], '--key');
  const db = flagValue(step.args || [], '--path') || '';
  if (!execDir) {
    const err = 'detached turn capture wait timed out';
    const row = { at: new Date().toISOString(), kind: 'store', db: redactText(db), storeIdentity: digest(db), key, status: 1, verified: false, error: err };
    try { appendReceipt(receipts, row); } catch { /* report via ledger */ }
    recordHookFailure({
      hook: 'turn-capture',
      event,
      error: err,
      ...(db ? { store: digest(db).slice(0, 16) } : {}),
      ...(step.projectRoot ? { project: digest(step.projectRoot).slice(0, 16) } : {}),
      ...(step.sessionHash ? { session: step.sessionHash } : {}),
      ...(key ? { key } : {}),
    }, { brainHome });
    return;
  }
  try {
    const execDeadline = Math.min(Date.now() + DETACHED_EXEC_CAP_MS, Number.isFinite(deadlineEnv) && deadlineEnv > 0 ? deadlineEnv : Infinity);
    runSteps({ steps: [step], receipts, event }, { env: process.env, brainHome, projectDir: step.projectDir, deadlineMs: execDeadline });
  } finally {
    releaseLeaseSlot(execDir, token);
  }
}

if (isDirectInvocation(import.meta.url) && process.argv[2] === '--run-steps') {
  try { runSteps(JSON.parse(process.argv[3] || '{}')); } catch { /* a detached worker has no one to report to */ }
  process.exit(0);
} else if (isDirectInvocation(import.meta.url) && process.argv[2] === '--run-turn-detached') {
  try { await runDetachedTurn(); } catch { /* a detached worker reports via receipt/ledger */ }
  process.exit(0);
}
