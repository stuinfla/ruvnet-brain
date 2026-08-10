#!/usr/bin/env node
// onboarding-console.mjs — the Onboarding Console server (ADR-0013 / DDD-0002).
//
// A locally-served page that renders RuvNet Brain's view of YOUR machine from real, measured state,
// and — only when you explicitly click, and only after telling you in plain words what it does —
// applies reversible fixes.
//
// The design law, encoded here rather than promised:
//   • READ-ONLY BY DEFAULT. Serving the page and building /api/state writes nothing. (The stack
//     audit reaches the npm registry over the network but mutates no user file.) Provable by running
//     against a read-only filesystem: nothing in the render path opens a file for writing.
//   • THE ONLY WRITER is the apply/save path, reached only by an authenticated POST the user triggered.
//   • RE-VERIFY BEFORE WRITE. Apply re-measures the world and refuses any item that is no longer true
//     (already fixed, or the machine moved) — the stale-read-then-write pattern that clobbered a memory
//     checkpoint on 2026-07-12 is structurally avoided.
//   • RECORD THE INVERSE FIRST. The undo is journalled before the mutation runs.
//   • NEVER RE-IMPLEMENT A MUTATION. Every machine change dispatches to a script that already backs up,
//     verifies against disk, and is idempotent (stack-sync.mjs --sync, reconcile-project.mjs --apply).
//   • Bind 127.0.0.1 only; mint a random per-launch token; every mutating POST must echo it (else 403).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync, spawn } from 'node:child_process';

import { auditModel, installedVersion } from './stack-sync.mjs';
import { candidateRoots, findStores, diagnose } from './memory-doctor.mjs';
import { buildStackRecommendations, buildWiringRecommendations, summarizeWiring, scoreMemoryHealth, buildHealthRecommendations, buildCapabilityRecommendations } from './console-engine.mjs';
import { planFor } from './remedy-registry.mjs';
import { auditAll as capabilityAuditAll } from './capability-registry.mjs';
import { getVersion } from './version.mjs';
import { consoleRuntimeDigest } from './console-runtime-identity.mjs';
// L5 (ADR-028): the audit is the one place that observes live capability state, so it is where an
// OFFERED-then-now-`on` transition becomes an APPLIED — the numerator of the precision metric that
// tells the owner whether advocacy is landing or nagging. Both are pure reads/appends and never throw.
import { reconcileApplied, reconcileIgnored, pendingOffers, precision as advocacyPrecision } from './advocacy-outcomes.mjs';
import { recordObservation as recordCapabilityStates } from './latency-to-surface.mjs';
import { loadCatalog as engineCatalog, catalogSource as engineCatalogSource, loadProfile as engineProfile, applyProfile, PROFILE_PATH } from './model-router-engine.mjs';
import { effectivePrices, loadLabelledRows, MIN_LABELS, OUTCOMES } from './metaharness-router.mjs';
import { utilization } from './router-utilization.mjs';
import { loadCatalog, detectProvider, frontierFor } from './model-catalog.mjs';
import { providerAvailability } from './provider-availability.mjs';
import { inspectSessionSnapshots } from './session-snapshot-contract.mjs';
import { learnings } from './learnings.mjs';
import { gatesSurvey } from './gates.mjs';
// The write-safety primitives, borrowed rather than re-implemented. See saveConfig for why.
import { withLock, writeAtomic, LOCK_WAIT_MS, loadSettings, saveSettings, SETTINGS_SCHEMA as USER_SETTINGS_SCHEMA } from './user-settings.mjs';
// The brain on/off switch (ADR-054). The sentinel is the enforcement artifact; settings.json holds
// only a mirror. The console is the ONE surface allowed to flip it — protect-brain-state.sh walls
// the file off from agent edits — so both halves of the write live here, in saveBrainPower().
import { isBrainOff, readOffState, setBrainOff, setBrainOn, disagreement } from './brain-state.mjs';
import {
  PROFILE_COMPLETE,
  PROFILE_RUVECTOR,
  applyBrainProfile,
  discoverStoreFamilies,
  measureBrainProfile,
  restoreCompleteProfile,
} from '../kb/brain-profile.mjs';
// Lessons: read model + the two user verbs. Every mutation goes through lesson-store's own
// updateLessons/ratify/demote/restore — this file adds a SURFACE, never a second writer.
import { loadLessons, updateLessons, ratify, demote, restore, pending, weightOf, TRIGGERS, ENFORCEMENT, ORIGIN, SOURCE_CLASS, STATUS } from './lesson-store.mjs';
import {
  openRouterCredentialStatus,
  saveOpenRouterCredential,
} from '../plugin/scripts/runtime-preferences.mjs';
import { applyNightlyChoice, nightlyStatus } from './nightly-controller.mjs';
// One canonical answer to "which directory is this, and have I counted it already?" — shared with
// the PreCompact snapshot producer (#85) and with memory-doctor's root scan (#107).
import { canonicalPath, pathIdentity, projectDirectory } from '../plugin/scripts/project-identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);
const CONSOLE_DIR = path.join(REPO, 'console');
const SYSTEM_HOME = os.homedir();

/**
 * The console's explicit root boundary. It scopes only console-owned configuration, state, cache,
 * and discovery; global binaries, account credentials, and external tool state retain SYSTEM_HOME.
 */
export function consoleRootFromEnvironment(env = process.env, systemHome = SYSTEM_HOME) {
  const configured = env.RUVNET_CONSOLE_ROOT;
  if (!configured) return systemHome;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw new Error('RUVNET_CONSOLE_ROOT must be an absolute path');
  }
  return path.resolve(configured);
}

// A test or an embedded caller can isolate the console's owned files and discovery roots without
// redefining the operating-system home directory. Normal launches retain the OS home exactly.
const CONSOLE_ROOT = consoleRootFromEnvironment();
const NPM_PREFIX = path.join(SYSTEM_HOME, '.npm-global');
const CONFIG_DIR = path.join(CONSOLE_ROOT, '.claude/ruvnet-brain');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const UNDO_JOURNAL = path.join(CONSOLE_ROOT, '.cache/ruvnet-brain/console-undo.jsonl');
const INSTALLED_KB = process.env.RUVNET_BRAIN_KB
  || path.join(CONSOLE_ROOT, '.cache', 'ruvnet-brain', 'kb');
const COMPLETE_BRAIN_SOURCE = process.env.RUVNET_BRAIN_COMPLETE_SOURCE
  || path.join(REPO, 'dist', 'ruvnet-brain');
const TOKEN = crypto.randomBytes(24).toString('hex');
const RUNTIME_RECEIPT_DIR = path.join(CONSOLE_ROOT, '.cache', 'ruvnet-brain', 'console-instances');
const RUNTIME_PRODUCT = 'ruvnet-brain-console';
const RUNTIME_SCHEMA = 1;
const RUNTIME_API_CONTRACT = 1;
const RUNTIME_SCRIPT = fs.realpathSync(fileURLToPath(import.meta.url));
// The generation this process IS, derived from every byte it executes and serves — not from this one
// file. #79: a Console whose entrypoint was unchanged but whose imported modules and frontend had been
// replaced reported the same identity as the candidate that replaced it, so the launcher reused a
// pre-update router behind a post-update page. Same function, same surface, same list as the installer
// stages (scripts/console-runtime-identity.mjs), so the two halves of this fact cannot drift.
const RUNTIME_SOURCE_SHA256 = consoleRuntimeDigest(REPO);

function consoleCandidateRoots() {
  return candidateRoots({ home: CONSOLE_ROOT, configPath: CONFIG_PATH });
}

function canonicalScope(cwd = process.cwd()) {
  return canonicalPath(cwd) ?? path.resolve(cwd);
}

function runtimeReceiptPath(cwd = process.cwd()) {
  const scope = canonicalScope(cwd);
  const scopeId = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return path.join(RUNTIME_RECEIPT_DIR, `${scopeId}.json`);
}

function runtimeIdentity({ port, cwd = process.cwd(), pid = process.pid, startedAt = new Date().toISOString() }) {
  return {
    product: RUNTIME_PRODUCT,
    schema: RUNTIME_SCHEMA,
    apiContract: RUNTIME_API_CONTRACT,
    pid,
    port,
    startedAt,
    scope: canonicalScope(cwd),
    scriptRealpath: RUNTIME_SCRIPT,
    runtimeVersion: brainVersionOnDisk(),
    sourceSha256: RUNTIME_SOURCE_SHA256,
  };
}

function validRuntimeReceipt(receipt, file) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (process.platform !== 'win32') {
    try { if ((fs.statSync(file).mode & 0o777) !== 0o600) return false; } catch { return false; }
  }
  return receipt.product === RUNTIME_PRODUCT
    && receipt.schema === RUNTIME_SCHEMA
    && receipt.apiContract === RUNTIME_API_CONTRACT
    && Number.isInteger(receipt.pid) && receipt.pid > 0
    && Number.isInteger(receipt.port) && receipt.port > 0 && receipt.port <= 65535
    && typeof receipt.startedAt === 'string'
    && typeof receipt.scope === 'string'
    && typeof receipt.scriptRealpath === 'string'
    && typeof receipt.runtimeVersion === 'string'
    && /^[a-f0-9]{64}$/.test(receipt.sourceSha256 || '')
    && /^[a-f0-9]{48}$/.test(receipt.controlToken || '');
}

function publicRuntimeIdentity(receipt) {
  const { controlToken: _secret, ...identity } = receipt;
  return identity;
}

function writeRuntimeReceipt(receipt, file = runtimeReceiptPath(receipt.scope)) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
  return file;
}

function removeOwnedRuntimeReceipt(file, controlToken) {
  const current = readJSON(file);
  if (!current || current.controlToken !== controlToken) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function sameRuntimeIdentity(left, right) {
  return ['product', 'schema', 'apiContract', 'pid', 'port', 'startedAt', 'scope',
    'scriptRealpath', 'runtimeVersion', 'sourceSha256'].every((key) => left?.[key] === right?.[key]);
}

function probeRuntime(port, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/runtime', timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16_384) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function probeHttpEndpoint(port, endpoint = '/api/runtime', timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: endpoint, timeout }, (res) => {
      res.resume();
      res.on('end', () => resolve({ reachable: true, status: res.statusCode }));
    });
    req.on('error', () => resolve({ reachable: false, status: null }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, status: null }); });
  });
}

function requestRuntimeShutdown(port, controlToken, timeout = 1_500) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ controlToken });
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/runtime/shutdown', method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 202));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

async function waitForRuntimeToStop(port, timeout = 3_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (!await probeRuntime(port, 150)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function inspectConsoleRuntime({ cwd = process.cwd(), preferredPort = Number(process.env.CONSOLE_PORT) || 7411 } = {}) {
  const receiptFile = runtimeReceiptPath(cwd);
  if (!fs.existsSync(receiptFile)) {
    const endpoint = await probeHttpEndpoint(preferredPort);
    return endpoint.reachable
      ? { state: 'foreign-port', scope: canonicalScope(cwd), port: preferredPort }
      : { state: 'not-running', scope: canonicalScope(cwd) };
  }
  const receipt = readJSON(receiptFile);
  if (!validRuntimeReceipt(receipt, receiptFile)) return { state: 'receipt-invalid', scope: canonicalScope(cwd) };
  const live = await probeRuntime(receipt.port);
  if (!live) {
    const endpoint = await probeHttpEndpoint(receipt.port);
    return endpoint.reachable
      ? { state: 'legacy-unowned', scope: canonicalScope(cwd), port: receipt.port }
      : { state: 'stale-receipt', scope: canonicalScope(cwd), port: receipt.port };
  }
  if (!sameRuntimeIdentity(live, publicRuntimeIdentity(receipt))) {
    return { state: 'legacy-unowned', scope: canonicalScope(cwd), port: receipt.port };
  }
  const candidate = runtimeIdentity({ port: receipt.port, cwd, pid: receipt.pid, startedAt: receipt.startedAt });
  const current = sameRuntimeIdentity(live, candidate);
  return {
    state: current ? 'current' : 'stale-running',
    scope: canonicalScope(cwd),
    port: receipt.port,
    live,
    candidate: publicRuntimeIdentity(candidate),
  };
}

async function launchConsole({ port = Number(process.env.CONSOLE_PORT) || 7411, open = false, cwd = process.cwd() } = {}) {
  const status = await inspectConsoleRuntime({ cwd, preferredPort: port });
  if (status.state === 'current') {
    const url = `http://127.0.0.1:${status.port}/`;
    console.log(`\n  🧠  RuvNet Brain — Onboarding Console (already running)\n      ${url}\n`);
    if (open) openBrowser(url);
    return { reused: true, port: status.port };
  }

  if (status.state === 'stale-running') {
    const receiptFile = runtimeReceiptPath(cwd);
    const receipt = readJSON(receiptFile);
    const stopped = validRuntimeReceipt(receipt, receiptFile)
      && await requestRuntimeShutdown(receipt.port, receipt.controlToken)
      && await waitForRuntimeToStop(receipt.port);
    if (stopped) {
      console.log(`  replacing owned stale Console on port ${receipt.port}…`);
      return { reused: false, server: startServer({ port: receipt.port, open, cwd }) };
    }
    console.error('  owned stale Console did not release its port — starting the current Console separately');
  }

  if (status.state === 'stale-receipt' || status.state === 'receipt-invalid') {
    try { fs.unlinkSync(runtimeReceiptPath(cwd)); } catch { /* already gone or unreadable */ }
  }
  return { reused: false, server: startServer({ port, open, cwd }) };
}

const NPX_RUV = /npx\s+(?:-y\s+|--yes\s+)?(?:@claude-flow\/[\w-]+|claude-flow|ruflo|ruvector|ruv-swarm|flow-nexus|metaharness|@metaharness\/[\w-]+|agentic-qe|aqe)(?:@[\w.-]+)?/;

// ── tiny read helpers (all read-only) ────────────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
// Read-only sqlite scalar with a WAL-safe fallback. A database being actively WRITTEN right now — the
// current project's OWN store, mid-session — can refuse a plain read-only open with SQLITE_CANTOPEN(14)
// because it cannot set up the -wal/-shm shared memory read-only. That is a sign of a LIVE, in-use
// store, NOT a broken one (misreading it as "broken" is the exact false-alarm memory-doctor's header
// warns against). So we retry with immutable=1, which reads the main file directly without WAL/SHM,
// and only give up if BOTH fail. Never throws, never writes. Returns { ok, value, mode }.
function robustRead(db, sql) {
  let lastErr = null;
  for (const mode of ['mode=ro', 'immutable=1']) {
    try {
      const uri = `file:${encodeURI(db)}?${mode}`;
      const v = execFileSync('sqlite3', [uri, sql], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return { ok: true, value: v === '' ? null : v, mode };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, value: null, mode: null, err: String(lastErr && lastErr.message || 'unreadable') };
}
// Row-returning sibling of robustRead: same WAL-safe two-mode ladder, `sqlite3 -json` output.
function robustReadJSON(db, sql) {
  for (const mode of ['mode=ro', 'immutable=1']) {
    try {
      const uri = `file:${encodeURI(db)}?${mode}`;
      const v = execFileSync('sqlite3', ['-json', uri, sql], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return { ok: true, rows: v ? JSON.parse(v) : [], mode };
    } catch { /* try next mode */ }
  }
  return { ok: false, rows: [], mode: null };
}

// ── Wiring survey (read-only): how do this machine's projects launch rUv tools? ───────────────────
// Directories that are somebody else's code sitting on your disk. Their hook wiring is not YOUR
// wiring: you will never "fix" it, and counting it makes the card describe a machine you don't have.
// `ruvnet-repos` was the expensive omission — 98 of 768 sites (13% of the card) came from clones of
// rUv's OWN repos, including a directory literally named tests/init-test, and 18 of the 21 npx call
// sites the card warned about were his test fixtures rather than anything Stuart configured.
const VENDOR = ['/clones/', '/node_modules/', '/vendor/', '/upstream/', '.claude-backup', '_snapshots',
  '/ruvnet-repos/', '/ruvnet_repos/'];

// memory-doctor.mjs owns candidate-root policy for the standalone CLI, Console, and other callers.
// Keeping one exported implementation prevents a new project-root convention from fixing one
// surface while another continues to print a confident but incomplete machine-wide count (#81).
function findProjects(root) {
  const out = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (VENDOR.some((m) => (p + '/').includes(m))) continue;
      if (e.isDirectory()) {
        if (e.name === '.claude') { out.add(dir); continue; }
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        walk(p, depth + 1);
      } else if (e.name === '.mcp.json') out.add(dir);
    }
  };
  walk(root, 0);
  return [...out].sort();
}
// Text that PRINTS the word npx is not an npx call site. Two of the sites this card warned about were
// `echo "Session ended. Run: npx aqe learn status"` — advice being displayed to the user, matched as
// though the machine were executing it. Strip quoted echo/printf payloads before classifying.
const stripPrinted = (cmd) => String(cmd)
  .replace(/\b(?:echo|printf)\s+(['"])(?:\\.|(?!\1)[\s\S])*?\1/g, ' ')
  .replace(/\b(?:echo|printf)\s+[^|;&]*/g, ' ');
function classifyCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (NPX_RUV.test(stripPrinted(cmd))) return 'NPX';
  if (/\.npm-global\/bin\/(ruflo|ruvector|ruv-swarm|flow-nexus)/.test(cmd) || /hook-handler\.cjs/.test(cmd)) return 'GLOBAL_BINARY';
  if (/CLAUDE_PLUGIN_ROOT/.test(cmd)) return 'PLUGIN';
  return null;
}
function wiringSurvey() {
  const sites = [];
  // Scan every candidate root (issue #19), de-duped by resolved path — a symlinked or nested root
  // must never count the same project twice.
  const seenProjects = new Set();
  const projects = [];
  for (const root of consoleCandidateRoots()) {
    for (const proj of findProjects(root)) {
      const resolved = pathIdentity(proj) ?? path.resolve(proj);
      if (seenProjects.has(resolved)) continue;
      seenProjects.add(resolved);
      projects.push({ proj, root });
    }
  }
  for (const { proj, root } of projects) {
    // Relative to the root it was actually found under, so "myproj" stays "myproj" instead of
    // becoming an ugly full path when the machine only has one root (the common case).
    const projName = path.relative(root, proj);
    for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
      const s = readJSON(path.join(proj, f));
      if (!s?.hooks) continue;
      for (const [event, groups] of Object.entries(s.hooks)) {
        const list = Array.isArray(groups) ? groups : [groups];
        for (const g of list) {
          const hookArr = Array.isArray(g?.hooks) ? g.hooks : (g?.command ? [g] : []);
          for (const h of hookArr) {
            const mech = classifyCommand(h?.command);
            if (mech) sites.push({ scope: 'project', project: projName, file: f, event, matcher: g?.matcher ?? '*', spec: String(h.command).slice(0, 160), mechanism: mech });
          }
        }
      }
    }
    const mcp = readJSON(path.join(proj, '.mcp.json'));
    for (const [name, v] of Object.entries(mcp?.mcpServers || {})) {
      const full = [v.command, ...(v.args || [])].join(' ');
      const mech = NPX_RUV.test(full) ? 'NPX' : (/\bnpx\b/.test(full) ? null : 'MCP');
      if (mech) sites.push({ scope: 'project', project: projName, file: '.mcp.json', event: 'MCP', matcher: name, spec: full.slice(0, 160), mechanism: mech });
    }
  }
  return { sites, summary: summarizeWiring(sites) };
}

// ── Memory health (read-only probes for the project the console was launched from) ────────────────
function sessionHookExists() {
  return fs.existsSync(path.join(CONSOLE_ROOT, '.claude/hooks/agentdb-ensure.sh')) || fs.existsSync(path.join(CONSOLE_ROOT, '.claude/hooks'));
}
// WHICH FILE IS THE PROJECT'S MEMORY STORE IS NOT A CONSTANT (issue #127).
//
// This probed only `.swarm/memory.db`. A reporter on ruflo 3.34.0 measured their live store — 31MB
// with a fresh project-state checkpoint — sitting in `.swarm/agentdb-memory.db`, so the card scored
// the project on an empty file and reported "no project-state checkpoint found" and "liveness: 1
// entries" about a store that had neither problem. The card's own remedy could not fix it, because
// the data was never missing; the probe was looking elsewhere.
//
// I could NOT reproduce their attribution on this machine: same ruflo 3.34.0, both with and without
// an explicit --path, a fresh `ruflo memory store` lands in `.swarm/memory.db` (proven by exact-key
// SQL against both files). So which name the CLI picks is evidently config- or environment-
// dependent, and hard-coding EITHER name is how this breaks again on the next machine.
//
// So the probe stops guessing and asks the filesystem: consider both known names, and use whichever
// actually holds rows. That is correct on their machine and on mine without knowing why they differ.
const MEMORY_DB_NAMES = ['memory.db', 'agentdb-memory.db'];
export function resolveMemoryDb(projectDir) {
  const candidates = MEMORY_DB_NAMES
    .map((name) => path.join(projectDir, '.swarm', name))
    .filter((file) => fs.existsSync(file));
  if (!candidates.length) return path.join(projectDir, '.swarm/memory.db'); // canonical name for the "absent" message
  if (candidates.length === 1) return candidates[0];
  // Both present: prefer the one with real content. Size is a proxy for rows that costs no query and
  // cannot throw on a locked or WAL-mode database — this runs inside a UI probe that must never hang.
  return candidates.sort((a, b) => {
    const sa = (() => { try { return fs.statSync(a).size; } catch { return 0; } })();
    const sb = (() => { try { return fs.statSync(b).size; } catch { return 0; } })();
    return sb - sa;
  })[0];
}

function probeMemory(projectDir) {
  const db = resolveMemoryDb(projectDir);
  const probes = {};
  // compaction survival + session surfacing are filesystem facts, always checkable
  const snapshot = inspectSessionSnapshots(projectDir);
  const snapshotDetail = snapshot.kind === 'canonical'
    ? 'a fresh versioned PreCompact snapshot is present in .swarm/agentdb-sessions.jsonl'
    : snapshot.kind === 'legacy'
      ? 'a fresh supported Ruflo session snapshot is present (legacy path; migration recommended)'
      : snapshot.kind === 'malformed'
        ? 'snapshot files were found but none matched the supported schema'
        : snapshot.kind !== 'absent'
          ? 'the newest supported snapshot is stale'
          : 'no supported PreCompact snapshot found for this project yet';
  probes.compactionSurvival = snapshot.fresh
    ? { status: 'ok', detail: snapshotDetail, artifact: snapshot.kind }
    : { status: 'warn', detail: snapshotDetail, artifact: snapshot.kind };
  probes.sessionSurfacing = sessionHookExists() ? { status: 'ok', detail: 'the global SessionStart hook surfaces project state at launch' } : { status: 'warn', detail: 'no SessionStart recall hook found' };
  // recall quality: honestly NOT probed at render (a true probe needs an embedding query; left for an explicit deep test)
  probes.recallQuality = { status: 'notTested', detail: 'not checked this session — a real recall probe needs an embedding round-trip, which render deliberately avoids' };

  if (!fs.existsSync(db)) {
    probes.liveness = { status: 'fail', detail: 'this project has no memory store (.swarm/memory.db) yet' };
    probes.coverage = { status: 'warn', detail: 'no checkpoint — no store has been created here' };
    return probes;
  }
  // Liveness from a WAL-safe read. Existing-but-unopenable means the store is being written RIGHT NOW
  // (a live store) — reported as "not checked this instant", never as a capping failure. Only a real
  // corruption (integrity_check ≠ ok) is a fail.
  const integ = robustRead(db, 'PRAGMA integrity_check;');
  if (!integ.ok) {
    probes.liveness = { status: 'notTested', detail: 'store is in active use right now — could not open a read-only snapshot this instant (normal for a live database being written; not a failure)' };
    probes.coverage = { status: 'notTested', detail: 'store busy this instant — checkpoint presence not checked' };
    return probes;
  }
  const integrity = (integ.value || '').split('\n')[0] || 'unknown';
  const totalR = robustRead(db, 'SELECT count(*) FROM memory_entries;');
  const embR = robustRead(db, "SELECT count(*) FROM memory_entries WHERE embedding IS NOT NULL AND length(embedding)>0;");
  const total = totalR.ok ? (totalR.value === null ? 0 : parseInt(totalR.value, 10)) : null;
  const embedded = embR.ok && embR.value !== null ? parseInt(embR.value, 10) : null;
  const liveNote = integ.mode === 'immutable=1' ? ' and in active use' : '';
  if (integrity !== 'ok') probes.liveness = { status: 'fail', detail: `store is corrupt (integrity_check: ${integrity})` };
  else if (total === null) probes.liveness = { status: 'notTested', detail: 'store opened but counts were unavailable this instant' };
  else if (total > 0) probes.liveness = { status: 'ok', detail: `store is live${liveNote}, integrity ok, ${total} entries${embedded != null && total ? `, ${Math.round((embedded / total) * 100)}% embedded` : ''} (read-only)` };
  else probes.liveness = { status: 'warn', detail: 'store exists but is empty' };

  const cp = robustRead(db, "SELECT max(updated_at) FROM memory_entries WHERE key LIKE 'project-state-current%';");
  if (cp.ok && cp.value) {
    const ageH = (Date.now() - Number(cp.value) * (String(cp.value).length <= 10 ? 1000 : 1)) / 3.6e6;
    probes.coverage = Number.isFinite(ageH) && ageH < 48
      ? { status: 'ok', detail: `project checkpoint present, ~${Math.max(0, ageH).toFixed(0)}h old` }
      : { status: 'warn', detail: 'project checkpoint present but stale (>2 days)' };
  } else if (cp.ok) {
    probes.coverage = { status: 'warn', detail: 'no project-state checkpoint found in this store' };
  } else {
    probes.coverage = { status: 'notTested', detail: 'store busy this instant — checkpoint presence not checked' };
  }
  return probes;
}
// The fleet-wide scan opens and queries every memory store on the machine — ~90ms each, and a real
// machine has 100+. That is far too slow to sit on the page's first paint, so it is its own endpoint
// (/api/memory) and hydrates late, exactly like the stack audit does.
function scanFleet() {
  const stores = findStores();
  const fleet = [];
  for (const db of stores) {
    const d = diagnose(db);
    if (d.unreadable || d.schemaless) { fleet.push({ name: d.name, unreadable: d.unreadable || 'no memory schema', total: 0, learns: false, findings: d.findings }); continue; }
    if ((d.total || 0) === 0) continue;
    fleet.push({ name: d.name, total: d.total, embedded: d.embedded, coverPct: +(d.cover * 100).toFixed(1), patterns: d.patterns ?? 0, learns: !!d.learns, findings: d.findings });
  }
  fleet.sort((a, b) => (b.total || 0) - (a.total || 0));
  return fleet;
}
function gatherMemory(cwd, { fleet = true } = {}) {
  // health = for the project the console was launched from (fall back to this repo). The scope is
  // resolved through projectDirectory() — the same call the PreCompact producer makes — so a console
  // launched from a subdirectory probes the project root the hook actually wrote to, instead of
  // warning that a snapshot it can see on disk does not exist (#85).
  const scope = projectDirectory({ cwd });
  const project = fs.existsSync(path.join(scope, '.swarm/memory.db')) ? scope : REPO;
  const projName = project.replace(CONSOLE_ROOT + '/Code/', '').replace(CONSOLE_ROOT + '/', '~/');
  const health = scoreMemoryHealth({ project: projName, probes: probeMemory(project) });
  return { fleet: fleet ? scanFleet() : null, health };
}

// ── Savings ledger (receipts only) ────────────────────────────────────────────────────────────────
function gatherSavings() {
  // Primary source is the real routing-receipts ledger written by scripts/route-cheap.mjs.
  const files = [
    path.join(SYSTEM_HOME, '.claude/metaharness/routing-receipts.jsonl'),
    path.join(SYSTEM_HOME, '.cache/ruvnet-brain/metaharness-receipts.jsonl'),
    // Canonical user-level ledger (issue #36 — the hooks no longer scatter per-CWD copies).
    path.join(SYSTEM_HOME, '.cache/ruvnet-brain/token-ledger.jsonl'),
    // Legacy location, still read so an existing user's history is not orphaned by the move.
    path.join(REPO, 'plugin/scripts/.ruvnet-brain/token-ledger.jsonl'),
  ];
  const receipts = [];
  let baselineUsd = 0;
  let skippedUnmeasured = 0; // rows with neither a $ nor a time saving — counted so labels can say so
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = (() => { try { return JSON.parse(line); } catch { return null; } })();
      if (!r) continue;
      // MEASURED $ saved: explicit field, else frontier cost minus chosen cost.
      let usd = Number(r.measuredUsd ?? r.savedUsd ?? r.usd ?? r.saved);
      if (!Number.isFinite(usd) && Number.isFinite(Number(r.est_frontier_cost)) && Number.isFinite(Number(r.est_cost))) {
        usd = Number(r.est_frontier_cost) - Number(r.est_cost);
      }
      // MEASURED time saved: explicit field, else baseline duration minus routed duration.
      let ms = Number(r.measuredMs ?? r.savedMs ?? r.ms);
      if (!Number.isFinite(ms) && Number.isFinite(Number(r.baseline_duration_ms)) && Number.isFinite(Number(r.duration_ms))) {
        ms = Number(r.baseline_duration_ms) - Number(r.duration_ms);
      }
      if (!Number.isFinite(usd) && !Number.isFinite(ms)) { skippedUnmeasured += 1; continue; }
      const base = Number(r.est_frontier_cost);
      if (Number.isFinite(base)) baselineUsd += base;
      receipts.push({
        at: r.at ?? r.ts ?? null,
        capability: r.capability ?? r.tool ?? r.source ?? 'routing',
        task: r.task ?? r.label ?? '',
        chosenTier: r.chosenTier ?? r.tier ?? r.model ?? '',
        baselineTier: r.baselineTier ?? r.baseline ?? r.frontier_ref ?? '',
        measuredMs: Number.isFinite(ms) ? ms : null,
        measuredUsd: Number.isFinite(usd) ? usd : null,
      });
    }
  }
  const usdSaved = +receipts.reduce((a, r) => a + (r.measuredUsd || 0), 0).toFixed(4);
  const totals = receipts.length ? {
    count: receipts.length,
    usdSaved,
    msSaved: receipts.reduce((a, r) => a + (r.measuredMs || 0), 0),
    baselineUsd: +baselineUsd.toFixed(4),
    pctSaved: baselineUsd > 0 ? Math.round((usdSaved / baselineUsd) * 100) : null,
  } : null;
  return { totals, note: 'receipts only — no modelled, projected, or “up to” savings', skippedUnmeasured, receipts: receipts.slice(-25).reverse() };
}

// ── Config (user-level) ──────────────────────────────────────────────────────────────────────────
const CONFIG_SCHEMA = [
  { key: 'openrouterKey', label: 'OpenRouter API key', type: 'secret', secret: true, help: 'Unlocks cheap-model routing and the self-improvement loop. Stored only in your user folder.' },
  { key: 'provider', label: 'Your model house', type: 'enum', options: ['auto', 'anthropic', 'openai', 'codex', 'google', 'xai'], help: 'Which stack is yours? Sets your frontier model + savings baseline — Claude → Fable 5, ChatGPT → GPT-5.6 Sol, Codex → Sol, Gemini → 3.1 Pro, Grok → 4.5. “auto” detects from your keys.' },
  { key: 'nightly', label: 'Nightly brain refresh', type: 'bool', help: 'Rebuild the knowledge base from pinned versions overnight so answers stay current.' },
  { key: 'routing', label: 'Token-smart routing', type: 'enum', options: ['auto', 'off'], help: 'Send cheap, mechanical tasks to smaller, cheaper models automatically.' },
  { key: 'qeFleet', label: 'On-demand QE test fleet', type: 'bool', help: 'Let RuvNet Brain spin up an Agentic-QE test fleet when you ask it to.' },
];

// Every field below has a runtime owner. Platform-specific controls (currently the macOS nightly
// scheduler) are removed from the editable schema when that owner is unavailable and are reported
// honestly through `unavailable`.
const CONFIG_CONTROL_SUPPORT = Object.freeze({});

function unsupportedConfigControls() {
  return CONFIG_SCHEMA
    .filter((field) => Object.hasOwn(CONFIG_CONTROL_SUPPORT, field.key))
    .map((field) => ({ key: field.key, label: field.label, reason: CONFIG_CONTROL_SUPPORT[field.key] }));
}
/**
 * NOT-CHOSEN IS ITS OWN ANSWER, and collapsing it into "on" was this file's version of the exact lie
 * the whole console was built to kill.
 *
 * `nightly: cfg.nightly !== false` and `routing: cfg.routing === 'off' ? 'off' : 'auto'` both derive
 * ON from the ABSENCE of a key. On a machine with no config file at all — the empty-first case the
 * bar names explicitly — that produced three contradictory answers to one question in a single render:
 *
 *   Savings card       ->  green chip "✓ Smart routing: ON"
 *   Capabilities card  ->  "cheap-model-routing: absent — agentic-flow is not installed and no
 *                           routing receipts exist"
 *   That card's own
 *   subtitle           ->  "Off by default — rUv would rather you chose it"
 *
 * Worse, these two keys are PREFERENCES, not switches: nothing outside this console reads either one
 * (grepped — the only readers are gatherConfig and the savings CTA). So "ON" was not even reporting a
 * setting that did something; it was reporting a default the user had never seen, about a feature
 * that was not installed.
 *
 * `null` means the person has not chosen. It is rendered as "not chosen", never as on and never as
 * off, and the Settings form shows the shipped default beside it as a recommendation rather than as
 * a fact about their machine.
 */
function gatherConfig() {
  const cfg = readJSON(CONFIG_PATH) || {};
  const credential = openRouterCredentialStatus({ cwd: process.cwd() });
  const schedule = nightlyStatus();
  const bool = (v) => (v === true ? true : v === false ? false : null);
  const unavailable = unsupportedConfigControls();
  if (!schedule.artifact.supported) {
    unavailable.push({
      key: 'nightly',
      label: 'Nightly brain refresh',
      reason: schedule.evidence,
    });
  }
  return {
    path: CONFIG_PATH.replace(CONSOLE_ROOT, '~'),
    exists: fs.existsSync(CONFIG_PATH),
    values: {
      openrouterKey: credential.configured,                // boolean only — never the secret itself
      provider: typeof cfg.provider === 'string' && cfg.provider ? cfg.provider : null,
      nightly: schedule.state === 'on' ? true : schedule.state === 'off' ? false : null,
      routing: cfg.routing === 'off' ? 'off' : cfg.routing === 'auto' ? 'auto' : null,
      qeFleet: bool(cfg.qeFleet),
    },
    // What the project would pick FOR you, kept separate from what you actually picked. The form can
    // then say "recommended: on" without ever claiming that is the current state.
    defaults: { provider: 'auto', nightly: true, routing: 'auto', qeFleet: false },
    schema: CONFIG_SCHEMA.filter((field) =>
      !Object.hasOwn(CONFIG_CONTROL_SUPPORT, field.key)
      && (field.key !== 'nightly' || schedule.artifact.supported)),
    unavailable,
    runtime: {
      openrouterKey: credential,
      nightly: schedule,
    },
  };
}

/**
 * ── The advocacy dial (user-settings.mjs) — a SEPARATE store from config.json, on purpose ─────────
 *
 * `advocacy` lives in ~/.config/ruvnet-brain/settings.json (user-settings.mjs STORE_PATH), not this
 * console's own CONFIG_PATH — because anticipate.sh, the one emitter that gates on it, reads that
 * exact file. Folding it into CONFIG_SCHEMA/saveConfig would give the console its own copy of the
 * value, free to drift from the one the emitter actually reads. So this reads and writes through
 * user-settings.mjs's own `loadSettings`/`saveSettings` — the same functions its CLI (`node
 * user-settings.mjs`) and its test suite already exercise — rather than growing a second writer.
 *
 * All four ordinary user preferences are served now. Their consumers are: learning capture/flush,
 * the advocacy hook, the console's guarded remedy loop, and SessionStart project-default seeding.
 */
const LIVE_USER_SETTING_KEYS = Object.freeze(['learningScope', 'advocacy', 'autoApply', 'newProjectDefaults']);
const LIVE_USER_FIELDS = USER_SETTINGS_SCHEMA.filter((field) => LIVE_USER_SETTING_KEYS.includes(field.key));

function gatherAdvocacy() {
  const state = loadSettings(); // validated: respects RUVNET_SETTINGS_FILE, degrades on corrupt/future files
  // NOT-CHOSEN IS ITS OWN ANSWER — same rule gatherConfig() applies above. loadSettings() always hands
  // back a COMPLETE values object (defaults filled in for any key the file never mentions), so the only
  // way to tell "the user picked the default on purpose" apart from "the user never touched this key"
  // is to peek at what was actually written, the same way gatherConfig() reads CONFIG_PATH raw.
  const raw = readJSON(state.path);
  const chosen = raw && typeof raw === 'object' && raw.settings && typeof raw.settings === 'object'
    ? raw.settings : {};
  return {
    path: state.path.replace(CONSOLE_ROOT, '~'),
    exists: state.exists,
    values: Object.fromEntries(LIVE_USER_FIELDS.map((field) => [
      field.key,
      Object.hasOwn(chosen, field.key) ? state.values[field.key] : null,
    ])),
    defaults: Object.fromEntries(LIVE_USER_FIELDS.map((field) => [field.key, field.default])),
    schema: LIVE_USER_FIELDS,
    unavailable: [],
  };
}

/**
 * SAVE — through user-settings.mjs's own `saveSettings`, never a hand-rolled second writer. That
 * function already owns the lock, the atomic rename and the backup-before-write for this exact file;
 * re-implementing any of it here would be the precise duplication saveConfig's own header warns about.
 *
 * Takes a `values` object, the SAME shape saveConfig() takes, so the console's settings form can post
 * to either endpoint with identical client code — only the URL and the target file differ.
 */
function saveAdvocacy(values) {
  const supplied = values && typeof values === 'object'
    ? Object.fromEntries(Object.entries(values).filter(([key]) => LIVE_USER_SETTING_KEYS.includes(key)))
    : {};
  if (!Object.keys(supplied).length) {
    return { ok: false, log: 'nothing was saved — no recognised settings were supplied' };
  }
  const rejected = [];
  for (const [key, value] of Object.entries(supplied)) {
    const field = LIVE_USER_FIELDS.find((candidate) => candidate.key === key);
    if (field.type === 'bool' && typeof value !== 'boolean') {
      rejected.push({ key, reason: `expected true or false, got ${JSON.stringify(value)}` });
    } else if (field.type === 'enum' && !field.options.includes(value)) {
      rejected.push({ key, reason: `expected one of ${field.options.join(', ')}, got ${JSON.stringify(value)}` });
    }
  }
  if (rejected.length) {
    return {
      ok: false,
      rejected,
      log: `nothing was saved — ${rejected.map((entry) => `${entry.key}: ${entry.reason}`).join('; ')}`,
    };
  }
  const result = saveSettings(supplied);
  if (!result.ok) return { ok: false, rejected: result.errors || [], log: result.log };
  publishSettingsToCache();
  return {
    ok: true,
    backup: result.backup ? result.backup.replace(CONSOLE_ROOT, '~') : null,
    values: Object.fromEntries(LIVE_USER_SETTING_KEYS.map((key) => [key, result.values[key]])),
    log: result.log,
  };
}

/**
 * ── THE MASTER SWITCH (ADR-054) — its OWN section, deliberately not folded into the dial above ───
 *
 * `brainEnabled` lives in the SAME settings.json as `advocacy`, but it is served and saved
 * separately, and the separation is the design rather than an accident of growth:
 *
 *   1. IT IS NOT A SETTING, IT IS A SWITCH. The enforcement artifact is the sentinel file
 *      (scripts/brain-state.mjs); the settings key is a MIRROR kept so the choice is visible where a
 *      user looks for their choices. Saving it therefore has to write TWO things, and a save path
 *      that writes two things must not be the same one that writes the ordinary dials — the moment
 *      it is, an unrelated dial save starts touching the switch.
 *   2. THE TWO CAN LEGITIMATELY DISAGREE (an older release drops the mirror key — see gate test 1),
 *      so this section carries `disagreement` and the ordinary dial section has nothing like it.
 *   3. IT MUST DISCLOSE WHAT KEEPS RUNNING. `notes` carries the maintenance-continues line, because
 *      the one thing worse than background work while "off" is UNDISCLOSED background work — GPT-5.6's
 *      half of the duel's single genuine disagreement.
 *
 * Same widget, same consent gate, same save/undo handling as the advocacy dial (the page renders it
 * through the shared buildSettingsForm), just a different endpoint and a different store semantics.
 */
const BRAIN_FIELD = USER_SETTINGS_SCHEMA.find((s) => s.key === 'brainEnabled');
const BRAIN_PROFILE_FIELD = USER_SETTINGS_SCHEMA.find((s) => s.key === 'brainProfile');

function gatherBrainProfile() {
  const settings = loadSettings();
  const installed = measureBrainProfile(INSTALLED_KB);
  const actual = !installed.stores.includes(PROFILE_RUVECTOR)
    ? null
    : installed.stores.length === 1
      ? PROFILE_RUVECTOR
      : PROFILE_COMPLETE;
  const source = measureBrainProfile(COMPLETE_BRAIN_SOURCE);
  const updaterAvailable = fs.existsSync(path.join(INSTALLED_KB, 'forge-update.mjs'));
  return {
    path: INSTALLED_KB.replace(CONSOLE_ROOT, '~'),
    values: { brainProfile: actual },
    stored: settings.values.brainProfile,
    disagreement: settings.values.brainProfile !== actual,
    defaults: { brainProfile: BRAIN_PROFILE_FIELD.default },
    schema: [BRAIN_PROFILE_FIELD],
    installed,
    choices: {
      complete: {
        available: (source.stores.includes(PROFILE_RUVECTOR) && source.storeCount > 1)
          || updaterAvailable,
        storeCount: source.storeCount,
        bytes: source.bytes,
      },
      ruvector: {
        available: installed.stores.includes(PROFILE_RUVECTOR)
          || source.stores.includes(PROFILE_RUVECTOR),
        storeCount: 1,
        bytes: installed.byStore.ruvector ?? source.byStore.ruvector ?? null,
      },
    },
    restoreSource: COMPLETE_BRAIN_SOURCE.replace(CONSOLE_ROOT, '~'),
  };
}

function gatherBrainPower() {
  const state = readOffState();
  const settings = loadSettings();
  return {
    off: state.off,
    since: state.since,
    reason: state.reason,
    switchPath: state.path.replace(CONSOLE_ROOT, '~'),
    // The RESOLVED answer — what the machine actually does — not the mirror's opinion of it.
    values: { brainEnabled: !state.off },
    defaults: { brainEnabled: BRAIN_FIELD.default },
    schema: [BRAIN_FIELD],
    profile: gatherBrainProfile(),
    disagreement: disagreement(settings.values.brainEnabled),
    // Stated on the surface, not buried in a doc. Every line here is a thing that KEEPS HAPPENING
    // while the brain is off; if one of them ever stops being true, this list is what has to change.
    notes: state.off
      ? [
        'Still running while off: version updates, the health alarm, and the open-issue banner — an off machine has to be able to receive the fix for an off-state bug.',
        'Stopped while off: retrieval from rUv\'s source, the grounding gate on your write path, everything the brain volunteers, and learning from this session.',
        'Already-running Claude Code and Codex sessions pick this up on their next hook or next search; a tool DESCRIPTION they cached at startup refreshes at their next restart.',
      ]
      : [
        'While the brain is on it retrieves from rUv\'s real source before answering, and its hooks watch your write path.',
        'Switching it off stops retrieval, the grounding gate, everything it volunteers, and learning — updates and health alarms keep running, and you can pause those separately.',
      ],
  };
}

function saveBrainProfile(values) {
  const profile = values && typeof values === 'object' ? values.brainProfile : undefined;
  if (![PROFILE_COMPLETE, PROFILE_RUVECTOR].includes(profile)) {
    const reason = `expected complete or ruvector, got ${JSON.stringify(profile)}`;
    return { ok: false, rejected: [{ key: 'brainProfile', reason }], log: `nothing was changed — ${reason}` };
  }
  const before = measureBrainProfile(INSTALLED_KB);
  if (!before.stores.includes(PROFILE_RUVECTOR)) {
    return { ok: false, log: `nothing was changed — no RuVector RVF store exists in ${INSTALLED_KB}` };
  }

  let changed;
  try {
    if (profile === PROFILE_RUVECTOR) {
      changed = applyBrainProfile(INSTALLED_KB, profile);
    } else {
      const localComplete = measureBrainProfile(COMPLETE_BRAIN_SOURCE);
      if (localComplete.storeCount > 1) {
        changed = restoreCompleteProfile(INSTALLED_KB, COMPLETE_BRAIN_SOURCE);
      } else {
        const updater = path.join(INSTALLED_KB, 'forge-update.mjs');
        if (!fs.existsSync(updater)) {
          throw new Error('the complete release is not cached here and forge-update.mjs is unavailable');
        }
        const restored = spawnSync(process.execPath, [
          updater,
          '--apply',
          '--restore-complete',
          PROFILE_RUVECTOR,
        ], {
          cwd: INSTALLED_KB,
          env: process.env,
          encoding: 'utf8',
          timeout: 30 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (restored.status !== 0) {
          const detail = String(restored.stderr || restored.stdout || `exit ${restored.status}`).trim().slice(-1200);
          throw new Error(`signed complete-bundle restore failed: ${detail}`);
        }
        changed = { profile: PROFILE_COMPLETE, stores: discoverStoreFamilies(INSTALLED_KB) };
        if (changed.stores.length < 2) {
          throw new Error('the signed updater completed but the complete repository stores did not land');
        }
      }
    }
  } catch (error) {
    return { ok: false, log: `nothing was changed — ${error.message}` };
  }

  const mirrored = saveSettings({ brainProfile: profile });
  publishBrainPowerToCache();
  return {
    ok: true,
    profile,
    values: { brainProfile: profile },
    stores: changed.stores,
    removed: changed.removed || [],
    bytesFreed: changed.bytesFreed || 0,
    mirrored: mirrored.ok,
    backup: mirrored.backup ? mirrored.backup.replace(CONSOLE_ROOT, '~') : null,
    log: mirrored.ok
      ? (profile === PROFILE_RUVECTOR
        ? `RuVector Only is active — ${changed.removed.length} unselected artifact(s) removed`
        : `Complete Brain is active — ${changed.stores.length} repository stores available`)
      : `${profile === PROFILE_RUVECTOR ? 'RuVector Only' : 'Complete Brain'} is active on disk, but the settings mirror could not be updated (${mirrored.log})`,
  };
}

/**
 * PUSH THE NEW SWITCH POSITION INTO THE STATE CACHE, IMMEDIATELY.
 *
 * FOUND BY A LIVE HTTP SMOKE, not by a unit test, and it is worth saying which: every unit
 * assertion around saveBrainPower() passed while the real server, queried over real HTTP one second
 * after a successful `off` save, answered `off: false`. `/api/state` is cache-first by design (the
 * 2026-07-17 outage bargain: never compute inline on a request), and nothing invalidated the cache
 * on this write — so the page's own master switch would have rendered ON for a machine that was OFF
 * until a background refresh happened to land. That is the exact class of statement this console
 * exists to make impossible.
 *
 * PATCH, then back-date — not `expireCachesEmbedding`, and both halves are deliberate:
 *   • PATCH the value, because for THIS field "stale" is not an acceptable stand-in for "wrong".
 *     Back-dating alone still hands the next reader `off: false`, merely labelled old.
 *   • BACK-DATE anyway, so the record is honestly marked as a measurement due for replacement and
 *     serveCached's kickRefresh() produces a wholly fresh one. Staleness here is caused by a WRITE,
 *     not by time passing — the doctrine expireCachesEmbedding's own header states.
 *   • NOT the shared helper: it calls writeCache WITHOUT a scope, and STATE_CACHE is project-scoped.
 *     Dropping the scope would make the next read a scope MISMATCH, which takes the COLD path and
 *     computes inline — reintroducing the multi-second freeze on the very next page load.
 */
function publishBrainPowerToCache() {
  try {
    const c = readJSON(STATE_CACHE);
    if (!c || !c.data || !c.data.sections) return;   // nothing cached yet — the next read is cold and correct
    c.data.sections.brainPower = gatherBrainPower();
    writeCache(STATE_CACHE, new Date(0).toISOString(), c.data, c.scope ?? null);
  } catch { /* a cache we cannot rewrite is one the next refresh replaces anyway */ }
}

/**
 * Publish the two ordinary settings read-models immediately after their writers succeed.
 *
 * `/api/state` is intentionally cache-first, so a successful save followed by reload otherwise
 * repaints the previous choices until a background measurement lands. A live browser test caught
 * exactly that failure for provider and advocacy. Patch the fields whose authoritative stores were
 * just written, retain the project scope, and withdraw the surrounding measurement so the detached
 * refresh still replaces every other section.
 */
function publishSettingsToCache() {
  try {
    const c = readJSON(STATE_CACHE);
    if (!c || !c.data || !c.data.sections) return;
    c.data.sections.config = gatherConfig();
    c.data.sections.userSettings = gatherAdvocacy();
    writeCache(STATE_CACHE, new Date(0).toISOString(), c.data, c.scope ?? null);
  } catch { /* the authoritative stores are already correct; refresh will replace an unreadable cache */ }
}

/**
 * SAVE — the sentinel FIRST, the mirror second, and the receipt tells the truth about both.
 *
 * Order matters and is not arbitrary. The sentinel is what every reader enforces from; the mirror is
 * a record. If the mirror write fails after the switch has flipped, the machine is in the state the
 * user asked for and one display is stale — recoverable, and reported. If it were the other way
 * round, a failed sentinel write would leave a settings file claiming a state the machine is not in,
 * which is the console showing a toggle wired to nothing.
 *
 * The mirror goes through user-settings.mjs's own saveSettings — same lock, same atomic rename, same
 * backup-before-write as every other key. No second writer.
 */
function saveBrainPower(values) {
  const value = values && typeof values === 'object' ? values.brainEnabled : undefined;
  if (value === undefined) return { ok: false, log: 'nothing was saved — no recognised settings were supplied' };
  if (typeof value !== 'boolean') {
    const reason = `expected true or false, got ${JSON.stringify(value)}`;
    return { ok: false, rejected: [{ key: 'brainEnabled', reason }], log: `nothing was saved — brainEnabled: ${reason}` };
  }

  const flipped = value ? setBrainOn() : setBrainOff('switched off from the console');
  if (!flipped.ok) return { ok: false, log: `nothing was changed — ${flipped.log}` };

  const mirrored = saveSettings({ brainEnabled: value });
  const state = readOffState();
  publishBrainPowerToCache();
  return {
    ok: true,
    off: state.off,
    since: state.since,
    backup: mirrored.backup ? mirrored.backup.replace(CONSOLE_ROOT, '~') : null,
    values: { brainEnabled: !state.off },
    // Honest about the half-failure rather than reporting a clean success: the switch is what counts
    // and it moved, but say so plainly if the visible record did not follow it.
    log: mirrored.ok
      ? (value ? 'the brain is on' : 'the brain is off — updates and health alarms keep running')
      : `the brain is ${value ? 'on' : 'off'}, but your settings file could not be updated to match (${mirrored.log})`,
    mirrored: mirrored.ok,
  };
}

/**
 * ── LESSONS: the surface the store was written for and never got ────────────────────────────────
 *
 * lesson-store.mjs:391 says of `pending()`: "what the management surface must show first." There was
 * no management surface. Sixteen lessons — thirteen of them the owner's own words, one of them
 * enforcing at BLOCK level — lived in a JSON file with a CLI over it, which is the owner's exact
 * complaint: "murky things in a .claude file nobody sees." A rule you cannot SEE is a rule you
 * cannot consent to, and an unconsented rule that blocks your work is the fastest route to someone
 * deleting the whole product.
 *
 * Two honesty constraints, both learned the hard way in this repo:
 *
 *  1. NO JARGON IN THE PRIMARY LINE. `origin: 'user-stated'` renders as "you taught me this";
 *     `enforcement: 'block'` renders as what it DOES to you, not what it is called internally.
 *  2. THE STATE IS READ, NEVER ASSERTED. Every field below comes from the store on this request.
 */
const TRIGGER_BY_KEY = new Map(Object.values(TRIGGERS).map((t) => [t.key, t]));

// What each enforcement level actually DOES to the user — the info-bubble text. Written as
// consequence-to-you, because "checklist" is a word about our implementation, not about their day.
const ENFORCEMENT_MEANING = {
  block: { label: 'Stops me', detail: 'I am interrupted at this moment and cannot continue until the check passes. This is the strongest level, and only lessons you stated yourself can reach it.' },
  checklist: { label: 'Checklist', detail: 'I get a checklist item I have to tick at this moment. It does not stop me — it makes skipping it a visible choice rather than an accident.' },
  review: { label: 'Reminder', detail: 'I am reminded at this moment. No stop, no checklist — it shapes what I pay attention to.' },
};

function gatherLessons() {
  let all;
  try { all = loadLessons(); }
  catch (e) {
    // TASK 3: stamped at the read that just failed, not before it was attempted.
    return { ok: false, error: String(e && e.message || e), lessons: [], counts: null, ...freshnessOf(new Date().toISOString()) };
  }
  // TASK 3: the observation instant is loadLessons() finishing, right above — not whenever the
  // .map()/.sort() derived-computation below happens to finish building the response.
  const measuredAt = new Date().toISOString();

  const lessons = all.map((l) => {
    const trig = TRIGGER_BY_KEY.get(l.trigger);
    const meaning = ENFORCEMENT_MEANING[l.enforcement] || { label: l.enforcement, detail: '' };
    const userStated = l.origin === ORIGIN.USER_STATED && l.sourceClass === SOURCE_CLASS.CURRENT_USER;
    const quarantined = l.sourceClass === SOURCE_CLASS.IMPORTED_OWNER || l.sourceClass === SOURCE_CLASS.DEMONSTRATION;
    const origin = l.sourceClass === SOURCE_CLASS.CURRENT_USER
      ? 'you taught me this'
      : l.sourceClass === SOURCE_CLASS.IMPORTED_OWNER
        ? 'imported maintainer history — not yours'
        : l.sourceClass === SOURCE_CLASS.DEMONSTRATION
          ? 'demonstration data — not personal policy'
          : 'I inferred this from what happened';
    return {
      id: l.id,
      statement: l.statement,
      // The moment it fires, in the second person. This is the load-bearing column: a lesson with no
      // observable moment is prose, and the store refuses to construct one (lesson-store.mjs:131).
      when: trig ? `when I'm ${trig.label}` : '(no trigger — this lesson cannot fire)',
      surface: trig ? trig.surface : null,
      enforcement: l.enforcement,
      enforcementLabel: meaning.label,
      enforcementDetail: meaning.detail,
      // Provenance drives trust, so it is stated plainly and never flattened into a badge colour.
      origin,
      sourceClass: l.sourceClass,
      userStated,
      quarantined,
      taughtCount: l.repeatCount || 0,
      projects: Array.isArray(l.projects) ? l.projects : [],
      evidence: l.evidence || null,
      weight: Number(weightOf(l).toFixed(4)),
      status: l.status,
      ratified: l.status === STATUS.RATIFIED || l.status === STATUS.ACTIVE,
      demoted: !!l.demoted,
      // The one thing the user is being ASKED, as opposed to merely shown.
      awaitingYou: l.status === STATUS.CANDIDATE && !l.demoted && !quarantined,
      // Honest ceiling: ratifying a model-inferred lesson can NOT raise it to block
      // (lesson-store.mjs:380). Say so before they click, not after.
      canReachBlock: userStated,
      canRatify: !quarantined,
      intendedEnforcement: l.intendedEnforcement || null,
    };
  });

  // Highest-consequence first — blast radius, not alphabetical. Something that STOPS me outranks a
  // reminder; among equals, the one I have taught most often.
  const rank = { block: 0, checklist: 1, review: 2 };
  lessons.sort((a, b) => {
    if (a.awaitingYou !== b.awaitingYou) return a.awaitingYou ? -1 : 1;
    if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
    const r = (rank[a.enforcement] ?? 9) - (rank[b.enforcement] ?? 9);
    if (r) return r;
    return b.taughtCount - a.taughtCount;
  });

  return {
    ok: true,
    lessons,
    counts: {
      total: lessons.length,
      active: lessons.filter((l) => l.ratified && !l.demoted).length,
      awaitingYou: lessons.filter((l) => l.awaitingYou).length,
      off: lessons.filter((l) => l.demoted).length,
      quarantined: lessons.filter((l) => l.quarantined).length,
      blocking: lessons.filter((l) => l.enforcement === 'block' && l.ratified && !l.demoted).length,
    },
    // TASK 2: this endpoint bypasses serveCached entirely and had NO timestamp of any kind. It is
    // never cached — loadLessons() reads the live file on every call — so this is always fresh, but
    // said so through the SAME envelope every other card uses rather than a bespoke "no age" shape.
    ...freshnessOf(measuredAt),
  };
}

/**
 * The three user verbs, each one an existing lesson-store function. `updateLessons` re-reads the
 * store inside its own transform, so a second console session cannot clobber this one — the same
 * property saveConfig gets from withLock, obtained here from the store rather than re-built.
 */
const LESSON_ACTIONS = {
  ratify:  { fn: ratify,  past: 'turned on'  },
  demote:  { fn: demote,  past: 'turned off' },
  restore: { fn: restore, past: 'restored'   },
};

function setLesson(body) {
  const id = body && typeof body.id === 'string' ? body.id : null;
  const action = body && typeof body.action === 'string' ? body.action : null;
  if (!id) return { ok: false, log: 'nothing changed — no lesson id supplied' };
  const spec = LESSON_ACTIONS[action];
  if (!spec) {
    return { ok: false, log: `nothing changed — action must be one of ${Object.keys(LESSON_ACTIONS).join(', ')}, got ${JSON.stringify(action)}` };
  }
  const before = loadLessons().find((l) => l.id === id);
  if (!before) return { ok: false, log: `nothing changed — no lesson with id ${id}` };
  if (action === 'ratify' && (before.sourceClass === SOURCE_CLASS.IMPORTED_OWNER || before.sourceClass === SOURCE_CLASS.DEMONSTRATION)) {
    return { ok: false, log: 'nothing changed — imported or demonstration history cannot become personal policy' };
  }

  try {
    updateLessons((fresh) => spec.fn(id, fresh));
  } catch (e) {
    return { ok: false, log: `could not save: ${String(e && e.message || e)}` };
  }

  // THE WRITE LANDED, SO EVERY CACHE THAT SPEAKS ABOUT LESSONS IS NOW WRONG.
  //
  // `capability-registry.mjs` derives two rows from this exact store — `lessons-in-force` (it reads
  // ratified-vs-candidate counts) and `cross-project-lessons`. Left alone, the capabilities card
  // would keep asserting the pre-click state for up to a full ceiling, one card away from the lessons
  // card showing the truth, on the same screen. That is the original two-day-old incident in
  // miniature, and this time WE would have caused it.
  //
  // Expired, not deleted — see expireCachesEmbedding for why deleting would resurrect the hang.
  expireCachesEmbedding([CAPABILITY_CACHE]);

  const after = loadLessons().find((l) => l.id === id);
  // Report what MOVED, read back from disk. An "ok" that was never re-read is the failure mode
  // user-settings.mjs was built to end: every writer returned ok:true while losing the write.
  return {
    ok: true,
    id,
    action,
    log: `${id} ${spec.past}.`,
    now: after ? { status: after.status, enforcement: after.enforcement, demoted: !!after.demoted } : null,
    was: { status: before.status, enforcement: before.enforcement, demoted: !!before.demoted },
  };
}

// ── Brain activity read-model (ADR-0018) — read-only, file reads + sqlite3 CLI only ──────────────
// Fleet scan is cached: ~50-100 stores × a CLI spawn each is fine once, not per poll.
// 2026-07-17 (Stuart: "work faster" — measured 49s cold vs 1.8s warm): the cache PERSISTS to disk and
// hydrates at boot, so a fresh server paints real data instantly with its honest "scanned at HH:MM"
// stamp. 2026-07-26 (RVBC-INSTANT-SPEC #5): the SCAN ITSELF now runs only in the detached
// --refresh-cache child. A request never scans — not inline on a first-ever run, and not via
// setImmediate either (deferring synchronous work still blocks the loop when it runs). A machine with
// no fleet scan yet is reported `warming`, never as a fabricated zero.
let ACTIVITY_MACHINE_CACHE = null;
const CONSOLE_CACHE_PATH = path.join(CONSOLE_ROOT, '.cache/ruvnet-brain/console-cache.json');

// ── Warm-cache serving (2026-07-17, the demo-hang fix) ─────────────────────────────────────────────
// Every read-model here does multi-second synchronous work: gatherState ~13s, gatherStack ~22s,
// scanFleet ~40s+ (each opens 100+ SQLite stores or walks ~/Code). Node is single-threaded, so a
// SINGLE inline compute freezes the WHOLE server — which is exactly why fresh loads returned nothing
// (curl saw 000) roughly one request in three while a scan held the event loop. setImmediate does
// NOT help: deferring synchronous work still blocks the loop when it finally runs.
// The fix: the request handler NEVER computes inline once a cache exists. It serves the last cache
// (instant, a file read) and kicks a DETACHED CHILD PROCESS (`--refresh-cache`) to recompute off the
// server's event loop entirely. A truly cold machine (no cache at all) eats ONE inline compute to
// seed the cache, then is warm forever. Caches persist across restarts, so cold is rare.
const STATE_CACHE  = path.join(CONFIG_DIR, 'state-cache.json');
const STACK_CACHE  = path.join(CONFIG_DIR, 'stack-audit-cache.json');
const MEMORY_CACHE = path.join(CONFIG_DIR, 'memory-cache.json');
const CAPABILITY_CACHE = path.join(CONFIG_DIR, 'capability-cache.json');

/**
 * READ-AFTER-WRITE INVALIDATION — the hole a wall clock cannot close.
 *
 * Fable 5, 2026-07-24: age-based freshness gives you "stale by at most N minutes", which is NOT the
 * product's promise. The promise is that it never lies about your machine. The gap is exact and
 * demonstrable: the user toggles a lesson; `/api/lessons` re-reads live and tells the truth; and
 * `/api/capabilities` goes on serving its `lessons-in-force` row from a cache that is under the
 * ceiling, correctly stamped, fully compliant with the new freshness contract — and false, on the
 * same screen, one card away, **caused by the user's own click.**
 *
 * That is the ORIGINAL incident (a cache speaking over the lesson store) reappearing inside the fix
 * written for it. No ceiling short of zero closes it, because the staleness is not caused by time
 * passing — it is caused by a write.
 *
 * EXPIRE, DO NOT DELETE. The obvious move is `unlink`. That would be a bug: with no cache file the
 * next request takes the COLD path, which computes inline — reintroducing the 13-49s server freeze
 * fixed one commit ago. Instead we back-date the stamp. The next reader gets the old value marked
 * `stale: true` with an honest age (fast, non-blocking) and the detached refresher replaces it. The
 * claim is withdrawn the instant the user's write lands, without any request paying for it.
 *
 * PRECISION IS PART OF THE CONTRACT: expire only caches whose payload actually embeds the mutated
 * fact. Blanket-expiring everything would be cheap to write and would turn every toggle into a
 * machine-wide re-scan, which is how a correctness fix becomes a performance complaint.
 */
/**
 * The capability read-model, computed in ONE place because it has TWO writers.
 *
 * It was inline in the `/api/capabilities` handler, and the background refresher did not write this
 * cache at all. Adding the refresher meant either duplicating this logic or extracting it — and the
 * duplicate was already half-written when the MEMORY_CACHE comment forty lines below caught it: that
 * exact mistake ("a cache writer that knew about half the payload") once made a background refresh
 * silently ERASE the advocacy block, so the page showed recommendations on the first request and
 * none ever after. The draft here reproduced it precisely, omitting `advocacy`.
 *
 * One computer, two callers. A shape that cannot drift because there is only one of it.
 */
function computeCapabilities() {
  let rows = [];
  let reconciled = [];
  let reconciledIgnored = [];
  try {
    rows = capabilityAuditAll();
    // Credit APPLIED for anything we offered that the user has since switched on. Derived from this
    // live audit, never guessed; safe on a read (idempotent — a resolved offer is no longer pending).
    reconciled = reconcileApplied(rows);
    // THE DENOMINATOR'S MISSING THIRD (ADR-028 L5): an offer that has sat PENDING, still off, for a
    // full day is `ignored`. Runs AFTER reconcileApplied so a capability the user just switched on is
    // never miscounted as ignored in the same pass.
    reconciledIgnored = reconcileIgnored(findStaleOffers(rows));
    // LATENCY-TO-SURFACE's missing half (ADR-028:103, "the single best summary metric"). The
    // registry is a pure detector with no memory: it can say "this is off", never "this has been off
    // since Tuesday" — so the subtraction had no left-hand side and the metric was uncomputable.
    // Appending state TRANSITIONS here, on the audit that already runs, supplies it.
    //
    // Deliberately inside the try and deliberately non-fatal: a capability audit must never fail
    // because a metric could not be written. recordObservation() already swallows its own IO errors
    // and returns [] — this is the second belt, because the console rendering is load-bearing for
    // the user and the measurement is not.
    try { recordCapabilityStates(rows); } catch { /* the metric is never worth breaking the page for */ }
  } catch (e) {
    // A failed audit must NOT render as "everything is off" — the precise lie this surface kills.
    rows = [{ key: 'audit', label: 'Capability audit', state: 'unknown', scope: 'machine',
      whatItBuysYou: 'a clear picture of what you own and what is switched on',
      evidence: `the audit could not run: ${String(e && e.message || e).slice(0, 160)}` }];
  }
  // THE CAPABILITY ⇄ RECOMMENDATION BRIDGE. `recId` is stamped by the SERVER, and only when
  // buildCapabilityRecommendations() actually constructed a schema-gated rec for this row — never
  // guessed, never derived client-side. This is the field console/app.js's capCheckboxEligible() reads
  // to decide whether a row earns a checkbox at all; see console-engine.mjs's header on that function
  // for why the bar is proven-undo, not merely has-a-command. Wrapped in its own try/catch so a bug in
  // the bridge degrades to "no checkbox anywhere" (recId: null everywhere), never a broken page — the
  // same non-fatal discipline every other enrichment in this function already holds to.
  try {
    const wantIds = new Set(buildCapabilityRecommendations({ capabilities: rows }).map((r) => r.id));
    for (const row of rows) row.recId = wantIds.has(`enable:${row.key}`) ? `enable:${row.key}` : null;
  } catch { for (const row of rows) row.recId = null; }
  // null (not 0) until enough offers have resolved — an honest "not yet judgeable", never a
  // fabricated score. Computed AFTER both reconciles so a freshly-resolved outcome is reflected.
  const prec = advocacyPrecision();
  return { at: new Date().toISOString(), data: { rows, advocacy: { precision: prec, reconciled, reconciledIgnored } } };
}

export function expireCachesEmbedding(files) {
  for (const f of files) {
    try {
      const j = readJSON(f);
      if (!j || !j.data) continue;
      j.at = new Date(0).toISOString();      // epoch ⇒ unambiguously past any ceiling
      // SCOPE SURVIVES THE EXPIRY (fixed 2026-07-26, RVBC-INSTANT-SPEC #3). This was
      // `writeCache(f, j.at, j.data)` — three arguments — and writeCache's fourth parameter defaults
      // to null, so every expiry silently erased WHICH PROJECT the measurement belonged to. Against a
      // project-scoped read that null is a scope MISMATCH, and a mismatch is treated as cold. So the
      // helper written to avoid the freeze ("EXPIRE, DO NOT DELETE — with no cache file the next
      // request takes the COLD path") reintroduced the cold path by another door: not by deleting the
      // file, by deleting its identity. Cold no longer computes inline, but a de-scoped cache still
      // throws away a perfectly good measurement and blanks the page until the child lands.
      writeCache(f, j.at, j.data, j.scope ?? null);
    } catch { /* a cache we cannot rewrite is one the next reader will recompute anyway */ }
  }
}

/**
 * THE THIRD OUTCOME, WIRED (ADR-028 L5). `ignored` had ZERO callers: precision = applied ÷
 * (applied+dismissed+ignored) silently shrank its own denominator, the mirror image of the
 * "record only the applies" fabrication advocacy-outcomes.mjs's own header names. This is the
 * caller advocacy-outcomes.mjs's own docs ask for: it computes staleness (the ledger deliberately
 * does not — see reconcileIgnored()'s header), this file only ever verifies the staleness ledger
 * already has evidence for.
 *
 * THE RULE, AND WHY IT IS THE CHEAP ONE TO DEFEND: an offer is `ignored` once it has been PENDING
 * (never applied nor dismissed) for at least `IGNORE_AFTER_MS` AND the audit, run again right now,
 * still finds the capability `off`. Both halves are load-bearing:
 *   - "still off" rules out the one honest reason silence could mean something OTHER than a miss —
 *     the user already acted and reconcileApplied() simply has not been called yet in THIS request
 *     (it always runs first, immediately above, in the same audit pass).
 *   - "pending ≥ IGNORE_AFTER_MS" is wall-clock time, not a session count, because THIS endpoint has
 *     no session concept of its own (it is a cached HTTP read-model, polled on whatever cadence the
 *     console page happens to be open) — inventing a session counter here would be evidence this
 *     file does not have. 24h is a full day of the capability sitting there, in the one place a user
 *     would see it (the console, `/api/capabilities`'s own consumer), still off, with no dismiss and
 *     no apply — long enough that "hasn't looked yet" stops being the more likely explanation.
 * A day is also symmetric with anticipate.sh's own once-per-project-per-day fallback session key, so
 * the two surfaces do not disagree about what "already had a fair chance to react" means.
 *
 * PURE (besides the ledger read `pendingOffers()` performs) — `now` is a parameter so a test can
 * pass a fixed instant instead of asserting against a moving `Date.now()`.
 */
const IGNORE_AFTER_MS = 24 * 60 * 60 * 1000;
export function findStaleOffers(rows, { file, now = Date.now() } = {}) {
  const stillOff = new Set((Array.isArray(rows) ? rows : []).filter((r) => r && r.state === 'off').map((r) => r.key));
  return pendingOffers({ file })
    .filter((p) => stillOff.has(p.id) && typeof p.at === 'string' && (now - Date.parse(p.at)) >= IGNORE_AFTER_MS)
    .map((p) => p.id);
}

const SELF = fileURLToPath(import.meta.url);
let LAST_REFRESH_KICK = 0;
/**
 * TEMP-THEN-RENAME — every cache writer in this file goes through this, never a bare writeFileSync.
 *
 * A bare writeFileSync truncates the target before the new bytes land. This file writes each cache
 * from at least two independent code paths per refresh cycle (the detached `--refresh-cache` child,
 * PLUS gatherState()/gatherStack() self-caching whenever called directly — see those two functions),
 * and a crash or kill mid-write leaves a TORN, half-written JSON file behind. readJSON()'s JSON.parse
 * then throws on that file, which is indistinguishable from "no cache yet" to every `!c || !c.data`
 * cold-path check in this file — so a torn cache silently demotes the NEXT request into the exact
 * expensive inline compute (13-49s) this caching exists to avoid.
 *
 * NOT hand-rolled: this reuses `writeAtomic` from user-settings.mjs (already imported above, line 46)
 * rather than growing a second copy of open/write/rename — it already does temp-then-rename PLUS an
 * fsync before the rename (a rename alone can land while the new bytes are still in the page cache;
 * without the flush, a power loss can leave an atomically-renamed but EMPTY file). Matches
 * lesson-store.mjs's saveLessons() in spirit, the store this class of fix was hardened for after a
 * real data-loss incident (see that file's own header).
 */
function atomicWriteJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(obj));
}
function writeCache(file, at, data, scope = null) {
  try { atomicWriteJSON(file, { at, data, scope }); }
  catch { /* a cache write must never break a response */ }
}
/**
 * Spawn the detached `--refresh-cache` child that does ALL the measuring.
 *
 * @param {{force?: boolean}} opts  `force` bypasses the 15s time debounce. It exists for the two
 *   callers where a debounced no-op would be a LIE to the user: a COLD/scope-mismatched read (there
 *   is nothing to serve, so "we'll get to it within 15 seconds" means a blank page for 15 seconds)
 *   and the explicit Refresh button (it must answer "yes, I started one", not silently drop the
 *   click and still return ok — RVBC-INSTANT-SPEC #3).
 * @returns {boolean} whether a child was actually started. Reported to the page rather than
 *   swallowed: a refresh that did not start must not render as one that did.
 *
 * ONE SCAN AT A TIME, force or not. The page opens four heavy endpoints at once and then polls, so a
 * force that ignored an in-flight child would fan out into six concurrent full-machine scans — the
 * cure becoming the disease. The in-flight guard has its own expiry (a child that has not exited in
 * five minutes is presumed wedged, not working) so one bad scan can never disable refreshing for the
 * life of the server.
 */
let REFRESH_CHILD = null;
const REFRESH_WEDGED_MS = 5 * 60 * 1000;
function kickRefresh({ force = false } = {}) {
  if (process.env.RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH === '1') return false;
  const now = Date.now();
  if (REFRESH_CHILD && now - LAST_REFRESH_KICK < REFRESH_WEDGED_MS) return false;  // one at a time
  if (!force && now - LAST_REFRESH_KICK < 15000) return false;   // debounce: at most one background refresh / 15s
  LAST_REFRESH_KICK = now;
  try {
    // cwd = the SERVED project, NOT REPO. This was `cwd: REPO` and it was a real console-honesty bug
    // (found 2026-07-24): the refresh child calls gatherState(process.cwd()), so with cwd=REPO it
    // recomputed PROJECT-SCOPED capabilities (memory-distillation, workflow-pattern-learning) for the
    // PLUGIN's own directory and wrote them to the shared cache — meaning that after the first 15s
    // refresh, /api/capabilities and /api/state reported the wrong directory's state for whatever
    // project the user actually opened. That is precisely the "looks on but isn't" failure this
    // console exists to prevent. The server's process.cwd() IS the served project, so the child must
    // inherit it. Machine-level caches (stack/activity/trust) don't depend on cwd, so this is safe
    // for them; it only fixes the project-scoped ones. NOT a change to the withhold-vs-recompute
    // contract (the 2026-07-17 outage) — only to which project the background compute is about.
    const child = spawn(process.execPath, [SELF, '--refresh-cache'], { detached: true, stdio: 'ignore', cwd: process.cwd() });
    REFRESH_CHILD = child;
    // unref() only releases the event-loop hold; these listeners still fire while the server lives.
    child.on('exit', () => { REFRESH_CHILD = null; });
    child.on('error', () => { REFRESH_CHILD = null; });
    child.unref();   // let it outlive this request; it writes the caches and exits on its own
    return true;
  } catch { REFRESH_CHILD = null; return false; /* a failed spawn just means the cache ages until the next kick */ }
}

/**
 * COMPLETION SIGNAL — "it's live, take a look at your page."
 *
 * The cold path prints "first run — scanning… ~15 seconds", then the detached refresh child
 * (kickRefresh, stdio:'ignore') does the scanning and the parent NEVER learns when it finished — so
 * the page just quietly filled in and nothing in the terminal ever said "done". The owner asked for
 * exactly this, verbatim: "a countdown or something that then eventually tells them, okay it's live,
 * take a look at your page." This supplies it, honestly: "live" is defined as "the state cache the
 * page paints first now exists, written by THIS launch" — an observed fact, not a guess or a fixed
 * timer. We watch STATE_CACHE's mtime (the same file the refresh child writes and the page reads
 * first) and print one line when it lands, or a still-scanning line if it runs long. Never holds the
 * process open (unref) and never fires on the warm path — a warm re-open paints instantly and needs
 * no signal.
 */
function announceWhenLive(url) {
  const startedAt = Date.now();
  const deadline = startedAt + 45000;   // generous: a cold gatherState is ~13s; fleet longer
  let lastPrint = startedAt;            // for the countdown ticks
  const timer = setInterval(() => {
    let landed = false;
    try { landed = fs.existsSync(STATE_CACHE) && fs.statSync(STATE_CACHE).mtimeMs >= startedAt - 1000; } catch { /* not yet */ }
    const now = Date.now();
    const waited = Math.round((now - startedAt) / 1000);
    if (landed) {
      clearInterval(timer);
      console.log(`      ✓ it's live — open ${url} (or refresh the tab) to see your machine  ·  ${waited}s\n`);
    } else if (now >= deadline) {
      clearInterval(timer);
      console.log(`      still scanning after ${waited}s — the page fills in as data lands  ·  ${url}`);
    } else if (now - lastPrint >= 2000) {
      // The owner asked for "a COUNTDOWN or something" — one start line then silence reads as a hang
      // on a slow scan. A tick every ~2s keeps the terminal alive (never a silent gap > 3s) and tells
      // the user the scan is still moving, until the honest "it's live" lands. Measured 2026-07-24: the
      // UX QE suite's max-dead-air WARN fired at ~3s with only start+end lines; a 2s tick on a 500ms
      // poll fires at ~2s (not the old 3s boundary), keeping every gap safely under the 3s bar.
      lastPrint = now;
      console.log(`      …scanning (${waited}s)`);
    }
  }, 500);
  timer.unref?.();   // the server keeps the loop alive; never hold it open just for this announcer
}
// Serve <file>'s cached data instantly; on a cold miss, compute once via <compute>, seed the cache,
// and serve that. Always kicks a background refresh so the next reader gets fresher data.
/* HARD CEILING ON CACHED TRUTH.
 *
 * Measured 2026-07-24: this function served a capability cache stamped 2026-07-22T04:52Z — TWO DAYS
 * OLD — as the present-tense state of the user's machine. It reported "all 12 recorded lessons are
 * still candidates … none of them can influence anything yet" while the live store held 16 lessons
 * with 13 ratified and in force. The registry was right the whole time; the cache spoke over it.
 *
 * The defect was structural, not a wrong number: there was NO age limit. Any cache file that existed
 * was served, forever, with a background refresh that only ever helped the NEXT visitor. So a user
 * could open the console, read a confident sentence about their own machine, and be told something
 * false — which is the single failure this product cannot survive, because every other claim it
 * makes is then worth nothing.
 *
 * Stale data is still useful (a 49s cold scan is why the cache exists). What is not acceptable is
 * stale data WEARING THE COSTUME OF FRESH DATA.
 *
 * ── CORRECTED, SAME DAY, BEFORE IT REACHED ANYONE (Fable 5, 2026-07-24) ──────────────────────────
 *
 * The first version of this fix said: "over the ceiling, refuse to serve it and measure again,
 * IN-BAND, even though that costs the user a slow page. A slow honest page beats a fast lying one."
 *
 * That reintroduced the outage this very file documents forty lines above (see "the demo-hang fix",
 * 2026-07-17): every read-model here does multi-second SYNCHRONOUS work — gatherState ~13s,
 * gatherStack ~22s, scanFleet ~40s+ — and Node is single-threaded, so one inline compute freezes the
 * WHOLE server. `curl` saw 000 on roughly one request in three. The rule established then was
 * absolute: THE REQUEST HANDLER NEVER COMPUTES INLINE ONCE A CACHE EXISTS.
 *
 * And the console is opened occasionally, not polled — so "older than the ceiling" is the COMMON
 * case, not the rare one. The first version therefore made the documented hang the DEFAULT path,
 * while every other endpoint, POST and static file on the server froze behind it.
 *
 * The error was treating "honest" and "fast" as the only two options and picking honest. There is a
 * third, and this repo's own DDD-0011 had already named it: INV-4 makes WITHHOLDING a first-class
 * outcome, and the domain-event table says MeasurementExpired triggers "re-measure OR withhold."
 *
 * So: past the ceiling we serve the value with `stale: true` and its real age — the claim is
 * WITHDRAWN, not disguised — and kick the detached refresher. The renderer's job is to present a
 * withdrawn claim as withdrawn ("last measured 2 hours ago, re-measuring now"), never as current.
 * Honest AND non-blocking. Inline compute survives for exactly one case: no prior measurement
 * exists at all, where there is nothing to withhold and nothing older to serve. */
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * ONE ceiling, ONE shape, for every JSON response that carries measured machine state.
 *
 * GPT-5.6-Sol's review of the fix above, verbatim: "Four freshness policies is zero freshness
 * policies." serveCached() got a real ceiling while ACTIVITY_MACHINE_CACHE, TRUST_CACHE, and the
 * always-live /api/lessons read each kept (or lacked) a PRIVATE one — so two cards on the same page,
 * both "compliant" with their own rule, could disagree about whether a given age counts as current.
 * A user cannot tell which promise a card is making, which is the same failure as making none.
 *
 * Pure function of a timestamp the CALLER already took — never `Date.now()` computed in here — so it
 * can never paper over a stamp taken at the wrong moment (see gatherStack()/gatherActivity()/
 * gatherLessons() below, where THAT bug lived). A missing or unparseable `measuredAt` reads as
 * maximally stale, not silently fresh: a card that cannot prove its own age must never claim to be
 * current.
 */
function freshnessOf(measuredAt) {
  const t = typeof measuredAt === 'string' ? Date.parse(measuredAt) : NaN;
  const ageMs = Number.isFinite(t) ? Date.now() - t : Infinity;
  return {
    measuredAt: typeof measuredAt === 'string' ? measuredAt : null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    stale: !(ageMs <= CACHE_MAX_AGE_MS),
  };
}

/**
 * THE WARMING ANSWER — one shape, every endpoint, always instant.
 *
 * `warming: true` is a first-class response, not an error and not an empty payload: "no measurement
 * exists for this project yet; one is being taken; ask again in a moment." The page reads it and
 * KEEPS its skeletons — it must never render a warming answer as empty sections, which would say
 * "you have nothing configured" to someone whose machine simply has not been looked at yet.
 *
 * `stale: true` is deliberate and not a contradiction: there is no current measurement here, so
 * every consumer of the shared freshness contract must treat this as "do not present as fact."
 */
function warmingAnswer(scopeKey, kicked) {
  return { warming: true, scope: scopeKey ?? null, kicked, fromCache: false, measuredAt: null, ageMs: null, stale: true };
}

function serveCached(res, file, decorate = (d) => d, scopeKey = null) {
  const c = readJSON(file);

  // WRONG PROJECT IS AS GOOD AS NO DATA. When a caller passes a scopeKey (the served project, for the
  // project-specific caches), a cached record computed for a DIFFERENT project must never be served —
  // that is the cross-project "looks on but isn't" bug (found 2026-07-24: two consoles, or one opened
  // in project B after A, sharing a user-level cache file).
  const scopeMismatch = scopeKey != null && (!c || c.scope !== scopeKey);

  // ── COLD, OR THE WRONG PROJECT: ANSWER IN MICROSECONDS, MEASURE IN A CHILD ──────────────────────
  //
  // THE THREE MINUTES OF DEAD AIR (owner, 2026-07-26/27) ENDED ON THIS BRANCH. It used to read
  // "this one request eats the compute to seed the cache — the 2026-07-17 bargain", and the bargain
  // was mispriced on two counts:
  //
  //   1. COLD IS NOT RARE, IT IS THE SECOND PROJECT. The caches are single user-level files keyed by
  //      one `scope`. Open the console in project B after project A and B is a scope mismatch —
  //      i.e. cold — every time. "Cold once, then warm forever" was only ever true of a machine with
  //      exactly one project on it.
  //   2. IT WAS NEVER ONE REQUEST. Node is single-threaded: an inline gather freezes the WHOLE
  //      server — the static page, every other endpoint, the token check, all of it — and the page
  //      opens four heavy endpoints at once, so the freezes queued end to end. Measured on this
  //      file's own fixture at the moment of the fix: /api/stack alone answered cold in 23,640 ms.
  //
  // The child already computes every one of these caches (see `--refresh-cache` at the bottom of
  // this file) and writes each one the moment it is ready. So there is nothing for a request handler
  // to do here except say so and get out of the way. There is no longer a `compute` parameter to
  // pass: the guarantee is now structural rather than a rule someone has to remember, and the
  // duplicate compute closures the handlers used to carry (which had ALREADY drifted from the
  // child's copies once — see the MEMORY_CACHE note in --refresh-cache) are gone with it.
  if (!c || !c.data || scopeMismatch) {
    return sendJSON(res, 200, warmingAnswer(scopeKey, kickRefresh({ force: true })));
  }

  // WARM — including over-ceiling. Never compute inline here; hand back what we measured, say when,
  // and let the detached child produce the next one.
  const fresh = freshnessOf(c.at);
  kickRefresh();
  return sendJSON(res, 200, {
    ...decorate(c.data),
    fromCache: true,
    cachedAt: c.at,   // legacy alias — `fresh.measuredAt` (from `...fresh` below) is the contract name (DDD-0011)
    ...fresh,
  });
}
/**
 * @returns {boolean} whether anything was actually restored — the caller uses this to decide
 * whether to warn a first-run user that the page starts empty. It used to return undefined, so a
 * truthiness check on it was always false; reporting what it really did keeps the caller honest.
 */
function loadConsoleCache() {
  let restored = false;
  try {
    const j = JSON.parse(fs.readFileSync(CONSOLE_CACHE_PATH, 'utf8'));
    if (j.activity && j.activity.at) { ACTIVITY_MACHINE_CACHE = j.activity; restored = true; }
    if (j.trust && j.trust.at) { TRUST_CACHE = j.trust; restored = true; }
  } catch { /* no cache yet — first ever boot */ }
  return restored;
}
function saveConsoleCache() {
  // Same torn-write risk as every other cache in this file (Task 4) — routed through the same atomic
  // helper rather than its own bare writeFileSync.
  //
  // MERGE, DON'T CLOBBER (2026-07-26). This file holds TWO independent measurements and, since the
  // fleet scan moved off the request path, TWO independent writers: the server (which has a TRUST_CACHE
  // and, after adoptFleetFromDisk, a fleet) and the detached --refresh-cache child (which scans the
  // fleet and has no trust at all). Writing the in-memory pair wholesale meant the child's fleet write
  // would have blanked the trust card's cache to null every single refresh — the same "a cache writer
  // that knew about half the payload" defect this file has already paid for once, in --refresh-cache's
  // MEMORY_CACHE. Each half now falls back to what is already on disk.
  try {
    const prev = readJSON(CONSOLE_CACHE_PATH) || {};
    atomicWriteJSON(CONSOLE_CACHE_PATH, {
      activity: ACTIVITY_MACHINE_CACHE ?? prev.activity ?? null,
      trust: TRUST_CACHE ?? prev.trust ?? null,
    });
  } catch { /* cache persistence must never break a read */ }
}

/**
 * Pick up a fleet scan performed by ANOTHER process (the detached --refresh-cache child).
 *
 * STRICTLY NEWER ONLY. Adopting an equal-or-older record would let a slow child's write walk a live
 * server backwards to a scan it has already superseded. Cheap: one small JSON read, no scan.
 */
function adoptFleetFromDisk() {
  try {
    const j = readJSON(CONSOLE_CACHE_PATH);
    if (j && j.activity && j.activity.at && (!ACTIVITY_MACHINE_CACHE || j.activity.at > ACTIVITY_MACHINE_CACHE.at)) {
      ACTIVITY_MACHINE_CACHE = j.activity;
    }
  } catch { /* no cache yet — the caller kicks a child and reports `warming` */ }
}
function refreshFleetCache() {
  const projects = [];
  let total = 0;
  const seen = new Set();
  // Scan every candidate root (issue #19) — this is what made machine-wide totals read 0 on a
  // machine whose projects live under ~/source instead of ~/Code.
  for (const root of consoleCandidateRoots()) {
    for (const s of findMemoryStores(root)) {
      // pathIdentity, not path.resolve: resolve() normalises `.`/`..` and nothing else, so a project
      // reached through a symlink OR through the other capitalisation of a case-insensitive volume
      // was two distinct strings for one directory, and its memories were summed twice (#107).
      const resolved = pathIdentity(s.project) ?? path.resolve(s.project);
      if (seen.has(resolved)) continue; // a project visible under two roots counts once
      seen.add(resolved);
      const n = Number(robustRead(s.db, "SELECT COUNT(*) FROM memory_entries WHERE status='active'").value || 0);
      if (n > 0) {
        // MAX(updated_at) = when this project was last actively worked — the memory store doubles
        // as the attention signal (relevance ordering, Stuart 2026-07-15).
        const lastTouched = Number(robustRead(s.db, 'SELECT MAX(updated_at) FROM memory_entries').value || 0);
        // rel = the root-relative path — the SAME key reconcile:<id> recommendations use (wiringSurvey
        // computes projName the same way, relative to whichever root the project was found under).
        projects.push({ name: path.basename(s.project), rel: path.relative(root, s.project), memories: n, lastTouched });
        total += n;
      }
    }
  }
  projects.sort((a, b) => b.memories - a.memories);
  ACTIVITY_MACHINE_CACHE = { at: Date.now(), projects, totalMemories: total };
  saveConsoleCache();
}
function findMemoryStores(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (VENDOR.some((m) => (p + '/').includes(m))) continue;
      if (e.name === '.swarm') {
        // Same resolution as probeMemory — the fleet walk had the identical hardcoded assumption (#127).
        const resolved = ['memory.db', 'agentdb-memory.db'].map((n) => path.join(p, n)).filter((f) => fs.existsSync(f))
          .sort((a, b) => { const sz = (f) => { try { return fs.statSync(f).size; } catch { return 0; } }; return sz(b) - sz(a); })[0];
        if (resolved) out.push({ project: dir, db: resolved });
        continue;
      }
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
function gatherActivity(cwd) {
  const project = fs.existsSync(path.join(cwd, '.swarm/memory.db')) ? cwd : REPO;
  const db = path.join(project, '.swarm/memory.db');
  if (!fs.existsSync(db)) {
    // No store to read — the existence check above IS the entire measurement, so it IS the
    // observation instant. Stamped here, not with a value taken before the check ran.
    const measuredAt = new Date().toISOString();
    return { generatedAt: measuredAt, project: path.basename(project), hasStore: false, ...freshnessOf(measuredAt) };
  }
  const out = { project: path.basename(project), hasStore: true };
  const rows = (sql) => robustReadJSON(db, sql).rows;
  out.totals = {
    memories: Number(robustRead(db, "SELECT COUNT(*) FROM memory_entries WHERE status='active'").value || 0),
    lessons: Number(robustRead(db, "SELECT COUNT(*) FROM memory_entries WHERE namespace='lessons' AND status='active'").value || 0),
  };
  out.lessons = rows("SELECT key, access_count, date(created_at/1000,'unixepoch') AS learned, substr(content,1,600) AS excerpt FROM memory_entries WHERE namespace='lessons' AND status='active' ORDER BY created_at DESC");
  out.recent = rows("SELECT key, namespace, type, datetime(updated_at/1000,'unixepoch','localtime') AS at FROM memory_entries WHERE status='active' ORDER BY updated_at DESC LIMIT 18");
  out.breakdown = rows("SELECT namespace, COUNT(*) AS n FROM memory_entries WHERE status='active' GROUP BY namespace ORDER BY n DESC");
  out.growth = rows("SELECT date(created_at/1000,'unixepoch') AS day, COUNT(*) AS n FROM memory_entries WHERE status='active' GROUP BY 1 ORDER BY 1");
  // TASK 3: stamped HERE, after every sqlite3 shell-out above has actually returned — not at the top
  // of this function (the previous `out = { generatedAt: new Date().toISOString(), ... }`), which
  // dated the whole response before a single row of it had been read.
  const measuredAt = new Date().toISOString();

  // MACHINE-WIDE FLEET SCAN — NEVER ON THIS THREAD (RVBC-INSTANT-SPEC #5).
  //
  // This walk opens 100+ SQLite stores across every scan root: 40s+ on a real machine. It used to run
  // here two ways, both of them on the server's only thread:
  //   • `refreshFleetCache()` outright, whenever no fleet had ever been scanned — i.e. on the very
  //     first open, the one moment a new user is watching a blank tab;
  //   • `setImmediate(refreshFleetCache)` when the fleet was over the ceiling. setImmediate is not
  //     backgrounding — deferring synchronous work still blocks the loop when it finally runs, one
  //     tick later, which is a distinction this file learned the hard way in 2026-07-17 and then
  //     re-introduced here.
  // Both are now the detached child's job. A request only ever READS.
  //
  // adoptFleetFromDisk() is what closes the loop: the child is a separate process, so it cannot
  // hand this one an in-memory result — it writes console-cache.json and this picks it up, strictly
  // newer only, on the next read. Without it the server would sit on `warming` forever.
  adoptFleetFromDisk();
  if (!ACTIVITY_MACHINE_CACHE) {
    // NOTHING TO WITHHOLD AND NOTHING TO FAKE: say it is being measured, and say nothing else.
    // `totalMemories: null` (not 0) on purpose — a zero here would read as "no memories anywhere on
    // your machine", which is the product's cardinal lie, told about the one number this card exists
    // for. The frontend renders `warming` as a skeleton, never as an empty fleet.
    kickRefresh();
    out.machine = { warming: true, projects: [], totalMemories: null, scannedAt: null, measuredAt: null, ageMs: null, stale: true };
    return { generatedAt: measuredAt, ...out, ...freshnessOf(measuredAt) };
  }
  if (Date.now() - ACTIVITY_MACHINE_CACHE.at > CACHE_MAX_AGE_MS) kickRefresh();
  const machineMeasuredAt = new Date(ACTIVITY_MACHINE_CACHE.at).toISOString();
  out.machine = {
    projects: ACTIVITY_MACHINE_CACHE.projects,
    totalMemories: ACTIVITY_MACHINE_CACHE.totalMemories,
    scannedAt: machineMeasuredAt,   // legacy field, unchanged shape
    ...freshnessOf(machineMeasuredAt),
  };
  return { generatedAt: measuredAt, ...out, ...freshnessOf(measuredAt) };
}

// ── Router engine read-model ─────────────────────────────────────────────────────────────────────
// 2026-07-16 (Stuart: "if MetaHarness does all of this then let it do it, but let us add user-
// selected constraints"). This panel previously displayed router-optimizer.mjs — a parallel,
// subscription-blind re-derivation of routing strategy that bypassed the REAL engine wired on
// 2026-07-13 (model-router-engine.mjs → @metaharness/router). The replica is deleted. This
// read-model contains ZERO routing logic: it shows the engine's own inputs (catalog × this user's
// profile → effective marginal prices — the ONLY thing the local layer owns) and the engine's own
// recent decisions from its append-only log. Nothing here can disagree with what actually routes.
function gatherRouterEngine() {
  const profile = engineProfile();
  const candidates = applyProfile(engineCatalog(), profile);
  const prices = effectivePrices(candidates, profile);
  const { rows, unusable } = loadLabelledRows();
  const installed = fs.existsSync(path.join(__dirname, '..', 'node_modules', '@metaharness', 'router', 'package.json'));
  const list = (c) => (typeof c.costPerMTok === 'number' ? c.costPerMTok
    : c.costPerMTok && typeof c.costPerMTok.in === 'number' ? +(((c.costPerMTok.in + c.costPerMTok.out) / 2).toFixed(3))
    : null);
  const decisions = [];
  try {
    const log = path.join(os.homedir(), '.claude', 'metaharness', 'routing-decisions.jsonl');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    for (const l of lines.slice(-8).reverse()) {
      try { const d = JSON.parse(l); decisions.push({ ts: d.ts, model: d.model, tier: d.tier, routedBy: d.routedBy, reason: d.reason }); } catch { /* skip bad line */ }
    }
  } catch { /* no decisions yet */ }
  const cfg = readJSON(CONFIG_PATH) || {};
  // User-constraint detection (Brain-side by design — a fact about THIS user, not routing logic):
  // an OpenRouter key decides whether metered cross-provider candidates are even reachable.
  let openrouterKey = !!process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) openrouterKey = !!(cfg.openrouterKey && String(cfg.openrouterKey).length > 8);
  // House (issue #21): three mechanisms used to disagree — Settings wrote config.json's `provider`,
  // but the chip strip derived "yours" from whichever pool candidate happened to be
  // subscriptionCovered first, sourced from profile.json (a file nothing in the console writes). The
  // user's Settings choice is now the single source of truth, via the SAME detectProvider() the
  // savings.utilization frontier calc already uses (config → env → catalog default) — so this and
  // the frontier calc can never disagree either.
  const subscriptions = detectSubscriptions();
  let house;
  let providerKeys = providerAvailability(null, subscriptions);
  // `keysVerified` is the machine-readable half of `status`, and it is the field every consumer must
  // consult BEFORE presenting `keys` as a fact about the user's machine (issue #86). `status` alone
  // was published and then ignored: the Console rendered a confident "✗ no API key found" per
  // provider straight off `keys`, so a missing catalog asset — an internal packaging failure — was
  // shown to the user as a verified finding about their credentials. Unknown outranks off.
  let providerCatalog = { status: 'degraded', keysVerified: false, detail: 'provider catalog was not loaded; native boolean detections are shown' };
  try {
    const hcat = loadCatalog();
    house = detectProvider(hcat, { provider: cfg.provider });
    // Per-provider credential presence (issue #24): the old chip strip hardcoded "not detected" for
    // every provider that wasn't the current house, so it could never tell "not your house" from "no
    // key found". Read each provider's real detect_env vars — minus the CLAUDECODE / CLAUDE_CODE_ENTRYPOINT
    // run-context markers (which are not credentials), exactly as detectProvider() itself filters them —
    // so the UI's "key found / not found" is now true instead of decorative.
    providerKeys = providerAvailability(hcat, subscriptions);
    providerCatalog = { status: 'ok', keysVerified: true, detail: 'verified provider catalog loaded' };
  } catch (error) {
    house = { provider: cfg.provider && cfg.provider !== 'auto' ? cfg.provider : 'anthropic', source: 'default' };
    providerCatalog = { status: 'degraded', keysVerified: false, detail: `provider catalog unavailable: ${String(error?.message || error)}` };
  }
  return {
    engine: {
      package: '@metaharness/router', installed,
      labels: rows.length, needed: MIN_LABELS, unusableLabels: unusable,
      mode: !installed ? 'UNAVAILABLE' : rows.length >= MIN_LABELS ? 'LEARNED' : 'COLD-START',
      outcomesLog: OUTCOMES.replace(os.homedir(), '~'),
    },
    keys: { openrouter: openrouterKey, ...providerKeys },
    providerCatalog,
    // Paid seats, found at USER level. `keys` above is env-var API keys only, which is exactly why a
    // user with ChatGPT Max and Claude Max read as "auto" — neither plan puts a key in the
    // environment. These two fields are what let the UI say "you already have this" instead of
    // asking someone to paste a credential they are already paying not to need.
    subscriptions,
    preferredSeat: preferredSeat(subscriptions),
    profile: { present: !!profile, path: PROFILE_PATH.replace(os.homedir(), '~') },
    catalogSource: engineCatalogSource(),   // 'catalog' | 'built-in-fallback' — so the UI never calls the stub a real catalog
    house,
    pool: candidates
      .map((c) => ({
        id: c.id, provider: c.provider, tier: c.tier || null, harness: c.harness || [],
        marginalPerMTok: Number.isFinite(prices[c.id]) ? prices[c.id] : null,
        listPerMTok: list(c),
        // From the profile fact, never inferred from a $0 price — a mispriced metered model must
        // not display as "yours" (exactly the bug this read-model caught on 2026-07-16).
        subscriptionCovered: (c.subscription || []).some((h) => profile?.harnesses?.[h]?.subscription === true),
        verified: c.verified || null, note: c.note || null,
      }))
      .sort((a, b) => (a.marginalPerMTok ?? Infinity) - (b.marginalPerMTok ?? Infinity)),
    decisions,
  };
}

// ── Trust & provenance read-model (v3.3 preview; ADR-0013 follow-on) ─────────────────────────────
// Two measurements are REAL today: the release bundle's published sha256, read live from the latest
// GitHub release's .sha256 asset (read-only metadata — the same class of network touch as the stack
// registry audit), and the local CycloneDX SBOM at sbom/ruvnet-brain.cdx.json (v3.3, `npm run sbom`)
// when it has been generated on this machine. Install channel is read from the plugin cache on disk.
// Advisor Mode is v3.3 and is reported as an honest empty state by the frontend — this read-model
// never fabricates.
const TRUST_REPO = 'stuinfla/ruvnet-brain';
const SBOM_PATH = path.join(REPO, 'sbom', 'ruvnet-brain.cdx.json');
// Local-file read, no network: the SBOM is generated by `npm run sbom` (CycloneDX 1.6 via
// @cyclonedx/cyclonedx-npm, --omit dev) and committed alongside releases. Absent = honest empty
// state, matching the "coming v3.3" language already shipped on the console card.
function readSbom() {
  const rel = path.relative(REPO, SBOM_PATH);
  if (!fs.existsSync(SBOM_PATH)) return { present: false, path: rel };
  try {
    const j = JSON.parse(fs.readFileSync(SBOM_PATH, 'utf8'));
    const components = Array.isArray(j.components) ? j.components : [];
    return {
      present: true,
      path: rel,
      componentCount: components.length,
      specVersion: j.specVersion || null,
      bomFormat: j.bomFormat || null,
      generatedAt: (j.metadata && j.metadata.timestamp) || null,
      mainComponent: (j.metadata && j.metadata.component && j.metadata.component.name) || null,
      mainVersion: (j.metadata && j.metadata.component && j.metadata.component.version) || null,
    };
  } catch (e) {
    return { present: false, path: rel, error: String((e && e.message) || e) };
  }
}
let TRUST_CACHE = null; // successful release reads cached; failures are never cached
let TRUST_REFRESHING = false;
let LAST_TRUST_KICK = 0;
/**
 * Background refresh for TRUST_CACHE, fired only once we are PAST CACHE_MAX_AGE_MS — see gatherTrust()
 * below. Debounced the same way kickRefresh() debounces the other caches' detached child, so a console
 * tab left open and polling /api/trust every few seconds cannot turn into a GitHub API hammer.
 *
 * Not a detached child process like kickRefresh(): fetchReleaseDigest() is network I/O, not a
 * synchronous CPU-bound scan, so it does not block the event loop the way gatherStack()/scanFleet() do
 * — an un-awaited fetch() already satisfies "never block the request that asked".
 */
function kickTrustRefresh() {
  const now = Date.now();
  if (TRUST_REFRESHING || now - LAST_TRUST_KICK < 15000) return;
  LAST_TRUST_KICK = now;
  TRUST_REFRESHING = true;
  fetchReleaseDigest()
    .then((release) => {
      if (release.ok) {
        const generatedAt = new Date().toISOString();
        TRUST_CACHE = { at: Date.parse(generatedAt), data: { generatedAt, release } };
        saveConsoleCache();
      }
    })
    .catch(() => { /* keep serving the last good measurement — a failed refresh must not erase it */ })
    .finally(() => { TRUST_REFRESHING = false; });
}
async function fetchReleaseDigest() {
  const ua = { 'user-agent': 'ruvnet-brain-console' };
  const rel = await fetch(`https://api.github.com/repos/${TRUST_REPO}/releases/latest`,
    { headers: { ...ua, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
  if (!rel.ok) throw new Error(`GitHub answered HTTP ${rel.status}`);
  const j = await rel.json();
  const assets = Array.isArray(j.assets) ? j.assets : [];
  const shaAsset = assets.find((a) => String(a.name).endsWith('.sha256'));
  const sigAsset = assets.find((a) => String(a.name).endsWith('.sig'));
  let sha256 = null;
  let file = null;
  if (shaAsset) {
    const r2 = await fetch(shaAsset.browser_download_url, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r2.ok) {
      const m = (await r2.text()).trim().match(/^([0-9a-f]{64})\s+\*?(\S+)/i);
      if (m) { sha256 = m[1]; file = m[2]; }
    }
  }
  return {
    ok: !!sha256,
    tag: j.tag_name || null,
    publishedAt: j.published_at || null,
    asset: file || (shaAsset ? String(shaAsset.name).replace(/\.sha256$/, '') : null),
    sha256,
    sig: !!sigAsset,
    source: `github.com/${TRUST_REPO}/releases/latest`,
  };
}
// The header wears the product version openly (owner, 2026-07-24: "put the version of RuvNet-Brain
// in the heading of the console"). Plugin-cache dir first — the truth on installed machines — then
// the repo's plugin.json for dev checkouts. null hides the chip rather than guessing.
function brainVersionOnDisk() {
  const runtimeIdentity = readJSON(path.join(REPO, 'runtime-identity.json'));
  if (typeof runtimeIdentity?.runtimeVersion === 'string' && runtimeIdentity.runtimeVersion) {
    return runtimeIdentity.runtimeVersion.replace(/^v/, '');
  }
  try { const v = readInstallChannel().version; if (v) return String(v).replace(/^v/, ''); } catch { /* fall through */ }
  try { return getVersion(); } catch { return null; }
}
function readInstallChannel() {
  const reg = readJSON(path.join(SYSTEM_HOME, '.claude/plugins/installed_plugins.json'));
  const entries = reg && reg.plugins && reg.plugins['ruvnet-brain@ruvnet-brain'];
  const e = Array.isArray(entries) ? entries[0] : null;
  if (!e || !e.installPath || !fs.existsSync(e.installPath)) return { installed: false };
  const km = readJSON(path.join(SYSTEM_HOME, '.claude/plugins/known_marketplaces.json'));
  const src = km && km['ruvnet-brain'] && km['ruvnet-brain'].source;
  const pinned = !!(src && (src.ref || src.tag || src.commit)); // no pin recorded → tracking latest
  return {
    installed: true,
    version: path.basename(e.installPath) || e.version || null, // the plugin cache version dir IS the truth
    channel: pinned ? 'pinned' : 'latest',
    lastUpdated: e.lastUpdated || null,
    cacheDir: String(e.installPath).replace(SYSTEM_HOME, '~'),
    repo: (src && src.repo) || null,
  };
}
/**
 * TASK 1: TRUST_CACHE now obeys the SAME ceiling (CACHE_MAX_AGE_MS) as every other cache in this
 * file, and past it we WITHHOLD rather than recompute in-band.
 *
 * The previous version's own age check (a bespoke 600000, not CACHE_MAX_AGE_MS) fell straight through
 * to `await fetchReleaseDigest()` — a GitHub network round-trip with an 8s timeout — INSIDE the
 * request that asked. That is precisely the in-band-recompute-past-the-ceiling pattern the big
 * comment above serveCached() documents as the reintroduced 2026-07-17 outage, just for a network
 * call instead of a synchronous scan. It also meant a cache RESTORED from disk at boot
 * (loadConsoleCache()), which is virtually always older than 10 minutes by the time anyone opens the
 * console, hit that path on its very first request — "restored from disk with no age check" in
 * practice, because the check that did exist only ever triggered a blocking recompute rather than an
 * honest stale-serve.
 */
async function gatherTrust() {
  // COLD ONLY: no successful release read has ever landed, so there is nothing to withhold or serve
  // stale — the one exception serveCached() itself carves out for its own caches.
  if (!TRUST_CACHE) {
    let release;
    try { release = await fetchReleaseDigest(); }
    catch (e) { release = { ok: false, error: String((e && e.message) || e) }; }
    // TASK 3: stamped AFTER the network call above resolves, not before it — the observation instant.
    const generatedAt = new Date().toISOString();
    const data = { generatedAt, release };
    if (release.ok) { TRUST_CACHE = { at: Date.parse(generatedAt), data }; saveConsoleCache(); }
    return { ...data, channel: readInstallChannel(), sbom: readSbom(), ...freshnessOf(generatedAt) };
  }

  // WARM — including over-ceiling. Never await the network here; hand back what we measured, say
  // when, and let a debounced background refresh (never THIS request) produce the next one.
  const fresh = freshnessOf(TRUST_CACHE.data.generatedAt);
  if (fresh.stale) kickTrustRefresh();
  // Disk facts stay live even when the release read is served from cache — the SBOM file and install
  // channel can change (a fresh `npm run sbom`, a plugin update) between two calls inside the ceiling.
  return { ...TRUST_CACHE.data, channel: readInstallChannel(), sbom: readSbom(), ...fresh };
}

// ── Assemble the read-models ─────────────────────────────────────────────────────────────────────
/**
 * PAID SUBSCRIPTIONS, detected at USER level — not project level, not from environment variables.
 *
 * WHY THIS EXISTS. A user with BOTH a ChatGPT Max plan and a Claude Max plan showed up as "auto",
 * because the only thing "auto" ever looked at was `detect_env` — API keys in environment
 * variables. Verified on a real machine 2026-07-20: `~/.codex/auth.json` reads
 * `auth_mode: "chatgpt"`, `OPENAI_API_KEY: null`, with live OAuth tokens. A genuine, paid,
 * authenticated ChatGPT subscription with no API key anywhere — completely invisible to the old
 * detector. Claude's own Max session is worse: on macOS it lives in the LOGIN KEYCHAIN, so there is
 * no file to find at all.
 *
 * WHY IT MATTERS BEYOND A WRONG LABEL. A subscription is already paid for at a flat rate; an API
 * key bills per token. Routing to a key while an authenticated seat sits idle spends money the user
 * has already spent. So a subscription always outranks a key — the key is the LAST resort, never
 * the default. (Same principle as the meta-proxy's Passthrough plane: use the subscription you are
 * already paying for, and treat metered capacity as the fallback.)
 *
 * SECRETS ARE NEVER READ. For the keychain we ask only whether the ITEM EXISTS — never `-w`, which
 * would print the secret. For token files we check for the presence of a field, never its value.
 * Nothing here is logged, transmitted, or written anywhere.
 *
 * @returns {Record<string, {subscription: boolean, apiKey: boolean, how: string}>}
 */
export function detectSubscriptions() {
  const home = os.homedir();
  const out = {};
  const seat = (provider, subscription, apiKey, how) => { out[provider] = { subscription, apiKey, how }; };

  // ── Anthropic (Claude Pro/Max) ────────────────────────────────────────────────────────────────
  // macOS keeps the Claude Code OAuth session in the login keychain; Linux/Windows use a file.
  // Existence only — `security find-generic-password` WITHOUT -w prints metadata, never the secret.
  let claudeSub = false; let claudeHow = 'not found';
  const credFile = path.join(home, '.claude', '.credentials.json');
  if (fs.existsSync(credFile)) { claudeSub = true; claudeHow = '~/.claude/.credentials.json'; }
  else if (process.platform === 'darwin') {
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) { claudeSub = true; claudeHow = 'macOS login keychain'; }
    } catch { /* absent or locked — treated as not found, never as an error */ }
  }
  seat('anthropic', claudeSub, !!process.env.ANTHROPIC_API_KEY, claudeHow);

  // ── OpenAI / ChatGPT (via the Codex CLI) ──────────────────────────────────────────────────────
  // auth_mode === 'chatgpt' means a ChatGPT plan is signed in; 'apikey' means metered billing.
  let oaSub = false; let oaKey = !!process.env.OPENAI_API_KEY; let oaHow = 'not found';
  const codexAuth = path.join(home, '.codex', 'auth.json');
  if (fs.existsSync(codexAuth)) {
    try {
      const j = JSON.parse(fs.readFileSync(codexAuth, 'utf8'));
      if (j.auth_mode === 'chatgpt' || (j.tokens && j.tokens.access_token)) { oaSub = true; oaHow = '~/.codex/auth.json (ChatGPT plan)'; }
      if (j.OPENAI_API_KEY) oaKey = true;
    } catch { /* unreadable/corrupt — report nothing rather than guess */ }
  }
  seat('openai', oaSub, oaKey, oaHow);
  // Codex is the same seat as the ChatGPT plan above, surfaced separately because the UI lists it
  // as its own "house" — one subscription, two labels, so never counted as two entitlements.
  seat('codex', oaSub, oaKey, oaHow === 'not found' ? 'not found' : `${oaHow} — same seat as OpenAI`);

  // ── Google (Gemini) ───────────────────────────────────────────────────────────────────────────
  // gcloud ADC is a real authenticated credential; a bare ~/.gemini directory is NOT — it holds
  // settings and skills and exists on machines that were never signed in. Claiming a subscription
  // from a config folder would be exactly the fabricated-status this project forbids.
  const adc = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
  const gSub = fs.existsSync(adc);
  seat('google', gSub, !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), gSub ? '~/.config/gcloud (ADC)' : 'not found');

  // ── xAI (Grok) ────────────────────────────────────────────────────────────────────────────────
  // No CLI writes a discoverable subscription credential today. Say so honestly rather than
  // inventing a detector that always returns false and looks like a real check.
  seat('xai', false, !!process.env.XAI_API_KEY, 'no detectable subscription credential');

  return out;
}

/**
 * What to actually USE, given what was found. Subscription first, always.
 * @returns {{provider: string|null, basis: 'subscription'|'api-key'|'none', detail: string}}
 */
export function preferredSeat(subs) {
  const order = ['anthropic', 'openai', 'codex', 'google', 'xai'];
  for (const p of order) if (subs[p]?.subscription) return { provider: p, basis: 'subscription', detail: subs[p].how };
  for (const p of order) if (subs[p]?.apiKey) return { provider: p, basis: 'api-key', detail: 'environment variable' };
  return { provider: null, basis: 'none', detail: 'nothing detected' };
}

function gatherState(cwd, { fleet = true } = {}) {
  const wiring = wiringSurvey();
  const memory = gatherMemory(cwd, { fleet });
  try { memory.learnings = learnings(); } catch { memory.learnings = null; }
  const savings = gatherSavings();
  const cfgNow = readJSON(CONFIG_PATH) || {};
  // issue #20: the Savings card's "Turn on smart routing" CTA must reflect what was actually saved —
  // same tri-state rule gatherConfig() uses below, so this and the Settings tab never disagree. null
  // means never chosen, and the card must say that rather than paint a green ON chip over a default.
  savings.routing = cfgNow.routing === 'off' ? 'off' : cfgNow.routing === 'auto' ? 'auto' : null;
  // A PREFERENCE IS NOT A CAPABILITY. Saving routing:'auto' records an intention; it does not install
  // agentic-flow, and the Savings card claiming "Smart routing: ON" while the Capabilities card said
  // "not installed" — in the same render — was the contradiction that made the whole page untrustworthy.
  // The card now carries the same measurement the capability row uses, so the two cannot disagree.
  savings.routingInstalled = fs.existsSync(path.join(SYSTEM_HOME, '.npm-global/bin/agentic-flow'));
  try { savings.routerEngine = gatherRouterEngine(); } catch { savings.routerEngine = null; }
  try {
    const cat = loadCatalog();
    const det = detectProvider(cat, { provider: cfgNow.provider });
    savings.utilization = utilization({ frontier: frontierFor(cat, det.provider) });
  } catch { try { savings.utilization = utilization({}); } catch { savings.utilization = null; } }
  const config = gatherConfig();
  const userSettings = gatherAdvocacy();
  // ADR-054: its own section, never folded into userSettings — see gatherBrainPower()'s header for
  // the three reasons. A failure here must not blank the page: the switch's own surface degrading is
  // no reason to lose the rest of the machine's state.
  let brainPower = null;
  try { brainPower = gatherBrainPower(); } catch { brainPower = null; }
  let gates = null;
  try { gates = gatesSurvey({ repo: REPO }); } catch { gates = null; }
  const recommendations = buildWiringRecommendations({ sites: wiring.sites });
  // The capability ⇄ recommendation bridge (see computeCapabilities()'s recId stamp, same idea here):
  // this is what makes `#rec-enable:memory-distillation` actually exist in the DOM for jumpToRec to
  // scroll to. Advisory-only, so a bug here must degrade to "no capability recs offered", never break
  // the rest of /api/state.
  try {
    const capRows = capabilityAuditAll({ project: cwd });
    recommendations.push(...buildCapabilityRecommendations({ capabilities: capRows }));
  } catch { /* an advisory surface must never break state */ }
  // Relevance order (never alphabetical/walk-order): machine-wide first, then projects by when
  // the user last actually worked in them — read from each project's own memory store.
  {
    const touched = {};
    for (const p of (ACTIVITY_MACHINE_CACHE && ACTIVITY_MACHINE_CACHE.projects) || []) {
      if (p.rel) touched[p.rel] = p.lastTouched || 0;
      touched[p.name] = Math.max(touched[p.name] || 0, p.lastTouched || 0);
    }
    const rank = (r) => r.id.startsWith('reconcile:') ? (touched[r.id.slice('reconcile:'.length)] || 0) : Number.MAX_SAFE_INTEGER;
    recommendations.sort((a, b) => rank(b) - rank(a));
  }
  // A cheap fingerprint of the state the page is about to render. The page echoes it back on apply;
  // apply's authoritative guard is still per-recommendation re-verification (currentValidIds), but
  // this lets the UI reason about staleness too.
  const preStateHash = crypto.createHash('sha1')
    .update(JSON.stringify({ recs: recommendations.map((r) => r.id).sort(), wiring: wiring.summary }))
    .digest('hex').slice(0, 16);
  const result = {
    token: TOKEN,
    generatedAt: new Date().toISOString(),
    preStateHash,
    host: { user: os.userInfo().username, platform: process.platform, node: process.version, npmPrefix: NPM_PREFIX.replace(SYSTEM_HOME, '~'), brainVersion: brainVersionOnDisk() },
    sections: { wiring, memory, savings, config, userSettings, brainPower, gates, recommendations },
  };
  // Cache the last good state so repeat page-loads paint instantly, same as the stack audit does.
  // TOKEN is per-server-run and must never touch disk — ?fast=1 splices the live one back in.
  //
  // TASK 4: routed through the shared atomic writeCache(), not a private writeFileSync. This used to
  // be a SECOND, non-atomic writer to the exact same STATE_CACHE path that serveCached()'s own
  // writeCache() call (and the --refresh-cache CLI branch) also write, right after calling this very
  // function — a bare writeFileSync racing an atomic rename on one file defeats the atomicity of the
  // other writer, because a reader can still land mid-truncate from THIS one. writeCache() is already
  // best-effort internally (never throws), so no extra try/catch is needed here.
  const { token, ...safe } = result;
  writeCache(STATE_CACHE, result.generatedAt, safe, cwd);   // project-scoped stamp
  return result;
}
function gatherStack() {
  const a = auditModel();
  // ISSUE #22 — carry `source` ('npm-global' | 'plugin') + marketplace through so the console can show
  // (and count) tools installed via the Claude Code plugin marketplace, not just `npm install -g` ones.
  const rows = a.rows.map((r) => ({ name: r.name, installed: r.installed, target: r.target, tag: r.tag, state: r.state, source: r.source ?? 'npm-global', marketplace: r.marketplace ?? null }));
  const shadows = a.shadows.map((s) => ({ name: s.name, version: s.version, global: s.global, dir: String(s.dir).replace(SYSTEM_HOME, '~'), stale: !!(s.global && s.version !== s.global) }));
  const by = (st) => rows.filter((r) => r.state === st).length;
  const summary = { total: rows.length, behind: by('BEHIND'), broken: by('BROKEN'), ahead: by('AHEAD'), current: by('CURRENT'), unresolved: by('UNRESOLVED'), shadows: shadows.length, stale: a.stale.length };
  const recommendations = buildStackRecommendations({ rows: a.rows, stale: a.stale });
  const result = { error: a.error, packages: rows, shadows, summary, recommendations };
  // Cache the last good audit so repeat page-loads render instantly ("as of HH:MM — re-checking").
  //
  // TASK 4: routed through the shared atomic writeCache(), same reasoning as gatherState() above —
  // this used to be a private writeFileSync straight to STACK_CACHE's own path (a SECOND, non-atomic
  // writer racing the serveCached()/--refresh-cache callers that also write this exact file right
  // after calling this function). The timestamp is taken HERE, after `result` above is already fully
  // built from `auditModel()`'s completed scan (Task 3) — never before it, unlike the two callers this
  // fix also corrects.
  if (!a.error) writeCache(STACK_CACHE, new Date().toISOString(), result);
  return result;
}

// ── The ONLY writer: apply / save / undo ─────────────────────────────────────────────────────────
function journalUndo(entry) {
  fs.mkdirSync(path.dirname(UNDO_JOURNAL), { recursive: true });
  const token = crypto.randomBytes(9).toString('hex');
  fs.appendFileSync(UNDO_JOURNAL, JSON.stringify({ token, at: new Date().toISOString(), ...entry }) + '\n');
  return token;
}
function runNode(scriptRelPath, args) {
  const r = spawnSync(process.execPath, [path.join(REPO, scriptRelPath), ...args], { encoding: 'utf8', timeout: 16 * 60 * 1000, cwd: REPO });
  return { ok: r.status === 0, code: r.status, log: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-4000) };
}
function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

// A wiring recommendation's `project` id is relative to whichever candidate root it was found under
// (issue #19) — reconstruct the absolute path by checking each root, so reconcile/undo can act on a
// project under ~/source just as well as one under ~/Code.
function resolveProjectDir(project) {
  for (const root of consoleCandidateRoots()) {
    const p = path.join(root, project);
    if (fs.existsSync(p)) return p;
  }
  return path.join(CONSOLE_ROOT, 'Code', project); // last-resort fallback: the previous fixed behavior
}
// Re-derive the currently-valid recommendation set, so apply can only ever act on something STILL true.
/**
 * Observe the learner's REAL state, for the health recommendations.
 *
 * Deliberately reads the global learner, because that is the store the capture flush
 * actually writes to. Reading the project-local `.claude-flow/neural` instead is exactly the mistake
 * that made the console display a dead learner (5 trajectories, last trained 6 days earlier) while
 * the live one held 412 — rUv documents this fragmentation as issue #2245, "four contradictory
 * sources". Until it is unified upstream we read the store that learning writes, never the corpse.
 */
function observeLearning() {
  const queueDir = path.join(SYSTEM_HOME, '.cache', 'ruvnet-brain', 'learn');
  let queueDepth = 0;
  try {
    for (const f of fs.readdirSync(queueDir)) {
      if (!f.endsWith('.jsonl')) continue;
      queueDepth += fs.readFileSync(path.join(queueDir, f), 'utf8').split('\n').filter(Boolean).length;
    }
  } catch { /* no queue dir yet — depth stays 0, which is honest */ }

  let lastTrainSeconds = null; let trajectories = 0;
  try {
    // ISSUE #136 — THE LEARNER IS PROJECT-SCOPED, so this must ask about the SERVED project.
    //
    // `ruflo hooks intelligence --status` reports `Data Dir: <cwd>/.claude-flow/neural`. With
    // `cwd: SYSTEM_HOME` this measured `~/.claude-flow/neural` — a store nothing writes to on a
    // machine whose work happens inside project directories. Measured on one machine, one minute:
    // the home store held 1,216 trajectories last trained 6.9 DAYS ago while the served project held
    // 9,940 last trained 22 SECONDS ago. The card said "Your learner has gone quiet" about a learner
    // training every few seconds.
    //
    // This file already carries the verdict on this exact mistake at the refresh-child spawn: "cwd =
    // the SERVED project, NOT REPO … it was a real console-honesty bug". Same rule, same file,
    // different call site — #104's and #134's residual arriving a third time.
    const r = spawnSync(path.join(SYSTEM_HOME, '.npm-global/bin/ruflo'),
      ['hooks', 'intelligence', '--status'],
      {
        cwd: process.cwd(),
        env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
        encoding: 'utf8',
        timeout: 20_000,
      });
    const out = `${r.stdout || ''}`;
    const t = out.match(/Last Training:\s*(\d+)s ago/);
    const j = out.match(/Trajectories\s*\|\s*(\d+)/);
    if (t) lastTrainSeconds = Number(t[1]);
    if (j) trajectories = Number(j[1]);
  } catch { /* ruflo absent or slow — leave null, and null NEVER produces a recommendation */ }

  // The fleet is what makes ADR-027's North Star recommendation constructible at all — without it,
  // `learning:distill-fleet` can never be built, so it can never be offered, so clicking it would be
  // rejected as "your machine changed". It was missing here, which is exactly how a recommendation
  // ends up existing in code and nowhere else.
  //
  // Read from the cache the /api/memory scan already writes: a live scan opens 100+ SQLite stores at
  // ~90ms each, which is far too slow to sit on this path. A cold cache honestly yields [] — and []
  // produces no recommendation, which is the correct answer when we have not looked.
  const fleet = readJSON(MEMORY_CACHE)?.data?.fleet ?? [];

  return { queueDepth, lastTrainSeconds, trajectories, fleet };
}

function currentValidIds(onlyId = null) {
  const ids = new Set();
  const wiringOnly = typeof onlyId === 'string' && onlyId.startsWith('reconcile:');
  const stackOnly = typeof onlyId === 'string'
    && (onlyId === 'purge:shadows'
      || onlyId.startsWith('sync:')
      || (onlyId.startsWith('repair:') && onlyId !== 'repair:memory-index'));
  const healthOnly = onlyId === 'repair:memory-index'
    || (typeof onlyId === 'string' && onlyId.startsWith('learning:'));
  const capabilityOnly = typeof onlyId === 'string' && onlyId.startsWith('enable:');
  const validateAll = !wiringOnly && !stackOnly && !healthOnly && !capabilityOnly;

  if (validateAll || wiringOnly) {
    for (const r of buildWiringRecommendations({ sites: wiringSurvey().sites })) ids.add(r.id);
  }
  let auditRows = [];
  if (validateAll || stackOnly) {
    const a = auditModel();
    auditRows = a.rows;
    for (const r of buildStackRecommendations({ rows: a.rows, stale: a.stale })) ids.add(r.id);
  }
  // Health + learning. Previously the console could SEE a corrupt store and score it 49/100 while
  // offering nothing to do about it — detection without a remedy, which ADR-027 prohibits.
  if (validateAll || healthOnly) {
    try {
      const project = projectDirectory();
      const health = scoreMemoryHealth({ project: path.basename(project), probes: probeMemory(project) });
      for (const r of buildHealthRecommendations({ memory: health, learning: observeLearning() })) ids.add(r.id);
    } catch { /* an advisory surface must never break the apply path */ }
  }
  // Capability recs (e.g. `enable:memory-distillation`) — without this, clicking the one recommended
  // capability checkbox would always report "already resolved / your machine changed", because apply()
  // only ever accepts ids this function has vouched for. Separate try from the health block above so a
  // failure in one surface never silently hides the other's ids too.
  if (validateAll || capabilityOnly) {
    try {
      for (const r of buildCapabilityRecommendations({ capabilities: capabilityAuditAll({ project: process.cwd() }) })) ids.add(r.id);
    } catch { /* an advisory surface must never break the apply path */ }
  }
  return { ids, auditRows };
}
function apply(ids) {
  const startedAt = performance.now();
  const phaseMs = { revalidationMs: 0, undoJournalMs: 0, childRemedyMs: 0 };
  const results = [];
  for (const id of ids) {
    // Re-read immediately before EACH fix. A batch can change the validity of the next item; one
    // pre-flight snapshot for the whole list would let item 2 run against the world item 1 changed.
    const revalidationStartedAt = performance.now();
    const { ids: validNow } = currentValidIds(id);
    phaseMs.revalidationMs += elapsedMs(revalidationStartedAt);
    if (!validNow.has(id)) { results.push({ id, ok: false, skipped: true, error: 'worldMoved', log: 'Skipped — this is already resolved, or your machine changed since the page loaded. Nothing was done. Reload to see the current state.' }); continue; }

    // ONE dispatch, through the registry (scripts/remedy-registry.mjs). This used to be a chain of
    // `if (id.startsWith(...))` whose handled-id set no code could inspect — so it drifted from the
    // builders and nothing noticed: `learning:enable-fleet` was offered with NO executor and fell
    // through to "Unknown recommendation id", and one reordering silently routed a database repair
    // into a global npm sync. Now the id→executor→inverse binding is a value, an ambiguous id
    // THROWS instead of picking a winner, and remedy-registry.test.mjs proves every offerable id
    // resolves to exactly one runnable remedy with a real undo behind it.
    let plan;
    try { plan = planFor(id); }
    catch (e) { results.push({ id, ok: false, log: e.message }); continue; } // ambiguous — a bug, said out loud
    if (!plan) { results.push({ id, ok: false, log: `Unknown recommendation id: ${id}` }); continue; }

    // Record the inverse BEFORE the change, and fill in the parts only this moment knows.
    const undoSpec = { ...plan.undo, id };
    if (undoSpec.kind === 'reinstall-version') {
      const prev = installedVersion(undoSpec.pkg);
      // No readable previous version ⇒ there is nothing to reinstall. Say that, rather than
      // journalling an inverse that would fail later while looking recorded.
      if (prev) undoSpec.prevVersion = prev; else { undoSpec.kind = 'auto-rebuild'; undoSpec.human = `no previous version of ${undoSpec.pkg} was readable, so there is nothing to roll back to`; }
    }
    if (undoSpec.kind === 'restore-memory-backup') undoSpec.db = path.join(process.cwd(), '.swarm/memory.db');
    // The console is scoped to ONE project (process.cwd()) for its whole life — same fact
    // `restore-memory-backup` just used above, recorded here too so undo() can hand it straight back
    // to distill-project.mjs's own `--restore`.
    if (undoSpec.kind === 'restore-project-distill') undoSpec.project = process.cwd();

    let args = [...plan.exec.args];
    if (plan.exec.resolveProject) {
      const i = args.indexOf('--project');
      if (i >= 0) args[i + 1] = resolveProjectDir(args[i + 1]);
    }
    // `usesServerProject`: this remedy's script must run against the ACTUAL project the console is
    // serving, never REPO — runNode() spawns every script with `cwd: REPO` (see its own comment),
    // so a script that fell back to its own `process.cwd()` default would silently describe THIS
    // package's checkout instead of the user's project. That exact REPO-vs-project confusion is
    // capability-registry.mjs's own header's "single most damaging bug this file has shipped"; this
    // flag exists so it cannot recur here.
    if (plan.exec.usesServerProject) args = [...args, '--project', process.cwd()];
    if (plan.exec.needsReceipt) {
      const receipt = path.join(CONSOLE_ROOT, '.cache', 'ruvnet-brain', 'undo', `${plan.key}-${stamp()}.json`);
      undoSpec.receipt = receipt;
      args = [...args, '--receipt', receipt];
    }

    const journalStartedAt = performance.now();
    const undoToken = journalUndo(undoSpec);
    phaseMs.undoJournalMs += elapsedMs(journalStartedAt);
    const remedyStartedAt = performance.now();
    const res = runNode(plan.exec.script, args);
    phaseMs.childRemedyMs += elapsedMs(remedyStartedAt);
    results.push({ id, ...res, undoToken });
  }
  // This receipt contains only aggregate durations, never the applied ids, paths, command output,
  // or undo tokens. It makes an end-user-visible delay diagnosable without exposing their machine.
  return { results, timings: { ...phaseMs, totalMs: elapsedMs(startedAt) } };
}

function autoEligibleIds(recommendations = []) {
  return recommendations
    .filter((rec) => rec?.scope === 'project')
    .filter((rec) => {
      const plan = planFor(rec.id);
      return plan?.autoEligible === true && plan.undo?.kind !== 'none';
    })
    .map((rec) => rec.id);
}
/**
 * VALIDATE AGAINST THE SCHEMA THAT IS ALREADY DECLARED. Without this, `/api/save-config` wrote
 * whatever arrived: MEASURED, `{routing:'banana', nightly:'yes-please', provider:{evil:1}}` landed in
 * the config file verbatim, and gatherConfig then read `routing:'banana'` as "not off" and rendered
 * it as ON. Every one of these keys has its type and its allowed values stated ten lines up in
 * CONFIG_SCHEMA; nothing was consulting them.
 *
 * Rejected values are REPORTED, not silently dropped and not silently coerced — a bad value must not
 * quietly become a different setting than the one the user believes they chose.
 */
function validateConfigPatch(values) {
  const clean = {};
  const rejected = [];
  for (const s of CONFIG_SCHEMA) {
    const v = values?.[s.key];
    if (v === undefined || v === null) continue;
    if (s.secret) {
      // Only overwrite a secret when a real new value is typed — '••••' is the masked placeholder
      // the form echoes back, and treating it as a new key would destroy the stored one.
      if (typeof v === 'string' && v.trim() && v !== '••••') clean[s.key] = v.trim();
      else if (typeof v !== 'string') rejected.push({ key: s.key, reason: 'expected a string' });
      continue;
    }
    if (s.type === 'bool') {
      if (typeof v === 'boolean') clean[s.key] = v;
      else rejected.push({ key: s.key, reason: `expected true or false, got ${JSON.stringify(v)}` });
      continue;
    }
    if (s.type === 'enum') {
      if (typeof v === 'string' && s.options.includes(v)) clean[s.key] = v;
      else rejected.push({ key: s.key, reason: `expected one of ${s.options.join(', ')}, got ${JSON.stringify(v)}` });
      continue;
    }
    if (typeof v === 'string') clean[s.key] = v;
    else rejected.push({ key: s.key, reason: 'expected a string' });
  }
  // Keys not in the schema never reach disk. The old writer only ever copied schema keys either, but
  // it did so while trusting their values, which is the half of the job that mattered.
  return { clean, rejected };
}

/**
 * SAVE — the writer users actually reach, and now the one that is actually safe.
 *
 * This function used to be the counter-example to the entire user-settings.mjs module sitting beside
 * it: that file has a lock, an atomic rename, an exclusive-create backup and a from-the-future
 * refusal, all tested — and ZERO non-test callers, while this truncating, unlocked, unvalidated
 * writeFileSync served every click on the page. The hardening was real and unreachable.
 *
 * Now it borrows those primitives directly rather than growing a second, weaker copy of them:
 *   withLock      two Claude Code sessions on one machine is the normal case, not the exotic one, and
 *                 read-modify-write without a lock loses whichever key the loser wrote.
 *   read-inside   `prev` is re-read INSIDE the lock; reading before acquiring reintroduces the race.
 *   writeAtomic   writeFileSync truncates first, so a crash mid-write leaves an EMPTY config and the
 *                 user's answers are gone having passed the backup step successfully.
 *   backup 'wx'   exclusive creation, so a racing writer cannot overwrite the backup this save's undo
 *                 token points at.
 */
function saveConfig(values) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); }
  catch (e) { return { ok: false, log: `could not create ${CONFIG_DIR.replace(CONSOLE_ROOT, '~')}: ${e.message}` }; }

  const { clean, rejected } = validateConfigPatch(values);
  // Nothing valid to write is not a save. Saying "Saved." here would be the dead-button failure with
  // a receipt attached.
  if (!Object.keys(clean).length) {
    return {
      ok: false,
      rejected,
      log: rejected.length
        ? `nothing was saved — ${rejected.map((r) => `${r.key}: ${r.reason}`).join('; ')}`
        : 'nothing was saved — no recognised settings were supplied',
    };
  }

  // Credential and scheduler changes are real effects, not JSON preferences. Execute their existing
  // owners, remember their inverses, then commit the ordinary config. If the final config write
  // fails, both effects are rolled back before the error is returned.
  const requestedSecret = clean.openrouterKey;
  delete clean.openrouterKey;
  const requestedNightly = clean.nightly;
  let credentialChange = null;
  let nightlyChange = null;
  const rollbackCredential = () => {
    if (!credentialChange?.ok) return;
    try {
      if (credentialChange.backup) {
        fs.copyFileSync(credentialChange.backup, credentialChange.path);
      } else if (!credentialChange.existed) {
        fs.rmSync(credentialChange.path, { force: true });
      }
    } catch { /* reported by the caller as a partial rollback below */ }
  };
  if (requestedSecret !== undefined) {
    credentialChange = saveOpenRouterCredential(requestedSecret, { cwd: process.cwd() });
    if (!credentialChange.ok) return { ok: false, rejected, log: credentialChange.log };
  }
  if (requestedNightly !== undefined) {
    nightlyChange = applyNightlyChoice(requestedNightly);
    if (!nightlyChange.ok) {
      rollbackCredential();
      return { ok: false, rejected, log: nightlyChange.log };
    }
  }

  const held = withLock(CONFIG_PATH, () => {
    const existed = fs.existsSync(CONFIG_PATH);
    const prev = readJSON(CONFIG_PATH) || {};

    let backup = null;
    if (existed) {
      const base = `${CONFIG_PATH}.bak-${stamp()}`;
      backup = base;
      for (let n = 2; fs.existsSync(backup); n++) backup = `${base}-${String(n).padStart(2, '0')}`;
      try { fs.writeFileSync(backup, fs.readFileSync(CONFIG_PATH), { flag: 'wx', mode: 0o600 }); }
      catch (e) { return { ok: false, log: `refusing to write — backup failed: ${e.message}` }; }
    }

    const next = { ...prev, ...clean };
    // A successfully encrypted credential retires the legacy plaintext field on this same commit.
    if (credentialChange?.ok) delete next.openrouterKey;
    try { writeAtomic(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n'); }
    catch (e) { return { ok: false, backup, log: `write failed: ${e.message}${backup ? `; your previous settings are at ${backup.replace(CONSOLE_ROOT, '~')}` : ''}` }; }
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on non-posix */ }

    // The undo token is journalled only AFTER the write succeeded. Recording an undo for a save that
    // never happened hands the user a button that would revert a change they never made.
    const undoToken = journalUndo({
      kind: 'restore-config',
      backup,
      existed,
      nightlyBefore: nightlyChange?.before?.state ?? null,
      secretBackup: credentialChange?.backup ?? null,
      secretPath: credentialChange?.path ?? null,
      secretExisted: credentialChange?.existed ?? null,
    });
    return { ok: true, backup: backup ? backup.replace(CONSOLE_ROOT, '~') : null, undoToken, rejected };
  });

  if (held.timedOut) {
    if (nightlyChange?.ok && ['on', 'off'].includes(nightlyChange.before?.state)) {
      applyNightlyChoice(nightlyChange.before.state === 'on');
    }
    rollbackCredential();
    return {
      ok: false,
      rejected,
      log: `another process is writing your settings and did not finish within ${LOCK_WAIT_MS}ms — nothing was written; try again`,
    };
  }
  if (!held.value?.ok) {
    if (nightlyChange?.ok && ['on', 'off'].includes(nightlyChange.before?.state)) {
      applyNightlyChoice(nightlyChange.before.state === 'on');
    }
    rollbackCredential();
  }
  if (held.value?.ok) publishSettingsToCache();
  return held.value;
}
/** Read the append-only undo journal. Malformed lines are skipped; they are not entries. */
function readUndoJournal() {
  if (!fs.existsSync(UNDO_JOURNAL)) return [];
  try {
    return fs.readFileSync(UNDO_JOURNAL, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * An undo is spent once it is used. The journal is append-only, so "spent" is itself an appended
 * record rather than a mutation — same reason the project-state checkpoint is append-only.
 */
function markUndoConsumed(token) {
  try { fs.appendFileSync(UNDO_JOURNAL, JSON.stringify({ consumed: token, at: new Date().toISOString() }) + '\n'); }
  catch { /* the restore already happened; failing to record it must not un-happen it */ }
}

function restoreConfigEffects(entry) {
  const failures = [];
  if (entry.secretPath) {
    try {
      if (entry.secretBackup && fs.existsSync(entry.secretBackup)) fs.copyFileSync(entry.secretBackup, entry.secretPath);
      else if (entry.secretExisted === false) fs.rmSync(entry.secretPath, { force: true });
    } catch (error) {
      failures.push(`encrypted credential restore failed: ${error.message}`);
    }
  }
  if (entry.nightlyBefore === 'on' || entry.nightlyBefore === 'off') {
    const restored = applyNightlyChoice(entry.nightlyBefore === 'on');
    if (!restored.ok) failures.push(restored.log);
  }
  return failures;
}

function undo(undoToken) {
  if (!fs.existsSync(UNDO_JOURNAL)) return { ok: false, log: 'no undo history' };
  const journal = readUndoJournal();
  const entry = journal.find((e) => e.token === undoToken);
  if (!entry) return { ok: false, log: 'that undo token was not found' };

  // ONE UNDO, ONCE. The token was never consumed, so the same button replayed forever: clicking it
  // twice re-restored a backup over whatever the user had done in between, and reported success both
  // times. An undo you can accidentally apply to a state it was not computed against is a data-loss
  // button wearing a safety label.
  if (journal.some((e) => e.consumed === undoToken)) {
    return { ok: false, log: 'that undo has already been used — it cannot be applied twice, because what it would restore is no longer what came before' };
  }

  if (entry.kind === 'restore-config') {
    // A LATER SAVE MAKES THIS UNDO WRONG, and this was the worst defect on the page. MEASURED: save A,
    // save B, then click A's undo — the console reported "restored your previous settings" and B's
    // choices were silently gone, because A's backup predates B entirely. Reachable in a single
    // screen: saving Settings shows an undo button, clicking "Turn on smart routing" is a second save
    // through the same endpoint, and A's undo then reverts routing while the CTA still reads ON.
    //
    // An undo can only speak for the last write. If something was written after it, the honest answer
    // is to refuse and say so — restoring anyway would be destroying newer data while claiming to
    // protect older data.
    const laterSave = journal.some((e) => e.kind === 'restore-config' && e.at > entry.at && e.token !== undoToken);
    if (laterSave) {
      return { ok: false, log: 'your settings were saved again after this point, so this undo would wipe out that newer save — nothing was changed. Use the undo from the most recent save, or restore a backup by hand.' };
    }

    if (entry.backup && fs.existsSync(entry.backup)) {
      // Locked and atomic, matching the save path. A half-written config during an UNDO leaves the
      // user with neither their old settings nor their new ones.
      let held;
      try {
        const bytes = fs.readFileSync(entry.backup);
        held = withLock(CONFIG_PATH, () => writeAtomic(CONFIG_PATH, bytes));
      } catch (e) { return { ok: false, log: `restore failed: ${e.message} — your backup at ${entry.backup.replace(CONSOLE_ROOT, '~')} is intact` }; }
      if (held.timedOut) return { ok: false, log: `another process is writing your settings and did not finish within ${LOCK_WAIT_MS}ms — NOTHING was restored and your backup is intact; try again` };
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on non-posix */ }
      const effectFailures = restoreConfigEffects(entry);
      if (effectFailures.length) {
        return { ok: false, log: `the settings file was restored, but ${effectFailures.join('; ')}. The undo remains available.` };
      }
      markUndoConsumed(undoToken);
      return { ok: true, log: 'restored your previous settings' };
    }

    if (!entry.existed && fs.existsSync(CONFIG_PATH)) {
      // The first-ever-save case: undo means removing the file. Guarded by the same later-save check
      // above — without it, this branch DELETED THE WHOLE CONFIG including every choice made after,
      // and reported "removed the settings file (there was none before)" as if that were harmless.
      let held;
      try { held = withLock(CONFIG_PATH, () => { fs.rmSync(CONFIG_PATH); return true; }); }
      catch (e) { return { ok: false, log: `could not remove the settings file: ${e.message}` }; }
      if (held.timedOut) return { ok: false, log: `another process is writing your settings and did not finish within ${LOCK_WAIT_MS}ms — nothing was removed; try again` };
      const effectFailures = restoreConfigEffects(entry);
      if (effectFailures.length) {
        return { ok: false, log: `the settings file was removed, but ${effectFailures.join('; ')}. The undo remains available.` };
      }
      markUndoConsumed(undoToken);
      return { ok: true, log: 'removed the settings file (there was none before this save)' };
    }
    return { ok: false, log: 'no backup available to restore' };
  }
  // EVERY branch below marks its token consumed on success, for the reason spelled out on the
  // restore-config branch above: these all copy a saved snapshot over a live file, so replaying one
  // re-applies an old state over whatever the user has done since. The replay guard at the top of
  // this function covers all kinds; these calls are what arm it.
  if (entry.kind === 'reinstall-version' && entry.pkg && entry.prevVersion) {
    const r = spawnSync('npm', ['install', '-g', '--prefix', NPM_PREFIX, `${entry.pkg}@${entry.prevVersion}`], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
    if (r.status === 0) markUndoConsumed(undoToken);
    return { ok: r.status === 0, log: r.status === 0 ? `reinstalled ${entry.pkg}@${entry.prevVersion}` : (r.stderr || '').slice(-800) };
  }
  if (entry.kind === 'restore-backup' && entry.project) {
    const dir = resolveProjectDir(entry.project);
    let restored = 0;
    for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) {
      const target = path.join(dir, f);
      const baks = (() => { try { return fs.readdirSync(path.dirname(target)).filter((n) => n.startsWith(path.basename(target) + '.bak-reconcile-')); } catch { return []; } })();
      if (!baks.length) continue;
      baks.sort();
      fs.copyFileSync(path.join(path.dirname(target), baks[baks.length - 1]), target); restored++;
    }
    if (restored > 0) markUndoConsumed(undoToken);
    return { ok: restored > 0, log: restored ? `restored ${restored} settings file(s) from backup` : 'no reconcile backups found to restore' };
  }
  // THE BRANCH THAT DID NOT EXIST. `repair:memory-index` journalled kind 'restore-memory-backup'
  // and nothing here handled it, so it fell to the default arm below and answered "nothing to undo
  // (the change reverses itself automatically)" — while the recommendation had promised to restore
  // the pre-repair backup. health-repair.mjs writes that backup as `<db>.rescue-<iso>`; this finds
  // the newest one and puts it back.
  if (entry.kind === 'restore-memory-backup' && entry.db) {
    const dir = path.dirname(entry.db);
    const base = `${path.basename(entry.db)}.rescue-`;
    let baks = [];
    try { baks = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort(); } catch { /* dir gone */ }
    if (!baks.length) return { ok: false, log: `no pre-repair backup found next to ${entry.db.replace(CONSOLE_ROOT, '~')} — nothing was restored` };
    const from = path.join(dir, baks[baks.length - 1]);
    try { fs.copyFileSync(from, entry.db); }
    catch (e) { return { ok: false, log: `could not restore ${from.replace(CONSOLE_ROOT, '~')}: ${e.message}` }; }
    markUndoConsumed(undoToken);
    return { ok: true, log: `restored your memory store from the snapshot taken before the repair (${baks[baks.length - 1]})` };
  }
  // `enable:memory-distillation`'s inverse. Deliberately handed BACK to distill-project.mjs's own
  // `--restore` rather than re-derived here: it already knows where its snapshots live (that
  // project's `.swarm/backups`) and its restore path is the one proven end to end (see the script's
  // header: 644 → 648 → 644 → 648, 2026-07-24). Re-implementing "find the newest backup" a second time
  // in this file is exactly the duplicate-inverse pattern ADR-047 was rejected for.
  if (entry.kind === 'restore-project-distill' && entry.project) {
    const r = spawnSync(process.execPath,
      [path.join(REPO, 'scripts/distill-project.mjs'), '--project', entry.project, '--restore'],
      { encoding: 'utf8', timeout: 5 * 60 * 1000 });
    if (r.status === 0) markUndoConsumed(undoToken);
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: r.status === 0, log: out.slice(-2000) || (r.status === 0 ? 'restored the pre-distill snapshot' : 'restore failed') };
  }
  // Fleet distillation touches a set of stores discovered at run time, so its executor writes a
  // receipt naming each store it snapshotted. No receipt ⇒ we do not know what was touched, and we
  // say so instead of guessing — restoring the wrong snapshot over a live store is worse than
  // restoring nothing.
  if (entry.kind === 'restore-store-backups') {
    const rec = entry.receipt && fs.existsSync(entry.receipt) ? readJSON(entry.receipt) : null;
    const stores = Array.isArray(rec?.stores) ? rec.stores : [];
    if (!stores.length) return { ok: false, log: 'no receipt of which stores were distilled — nothing was restored. Each store\'s own snapshot is still in its .swarm/backups folder.' };
    let restored = 0; const failures = [];
    for (const s of stores) {
      let snaps = [];
      try { snaps = fs.readdirSync(s.backupDir).filter((n) => n.endsWith('.db') || n.includes('memory')).sort(); } catch { /* dir gone */ }
      if (!snaps.length) { failures.push(`${s.name}: no snapshot found`); continue; }
      try { fs.copyFileSync(path.join(s.backupDir, snaps[snaps.length - 1]), s.db); restored++; }
      catch (e) { failures.push(`${s.name}: ${e.message}`); }
    }
    return {
      ok: restored > 0,
      log: `${restored} of ${stores.length} store(s) restored from their pre-distill snapshots`
        + (failures.length ? ` — could not restore: ${failures.join('; ')}` : ''),
    };
  }
  // Only kinds that genuinely reverse themselves reach here. Anything else arriving at this arm is
  // a registry/undo drift, and remedy-registry.test.mjs fails the build before it can reach a user.
  if (entry.kind === 'none' || entry.kind === 'auto-rebuild') {
    return { ok: true, log: entry.human || 'nothing to undo (the change reverses itself automatically)' };
  }
  return { ok: false, log: `no undo is implemented for "${entry.kind}" — nothing was changed back. Please report this.` };
}
// The undo kinds this function actually implements. Exported so the closure test can check the
// registry against the REAL handler set rather than a hand-copied list that would drift from it.
export const HANDLED_UNDO_KINDS = Object.freeze([
  'restore-config', 'reinstall-version', 'restore-backup',
  'restore-memory-backup', 'restore-store-backups', 'restore-project-distill', 'auto-rebuild', 'none',
]);

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(CONSOLE_DIR, rel);
  if (!file.startsWith(CONSOLE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'text/plain', 'not found');
  let body = fs.readFileSync(file);
  const ext = path.extname(file);
  if (ext === '.html') body = Buffer.from(String(body).replace('</head>', `<script>window.__CONSOLE_TOKEN__=${JSON.stringify(TOKEN)}</script></head>`));
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}
function send(res, code, type, body) { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); }
function sendJSON(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }

/**
 * Open the console AND PUT IT IN FRONT OF THE USER.
 *
 * `open <url>` creates the tab but does NOT raise the browser window. Observed live 2026-07-21:
 * the console had been opened twice and was sitting in two Chrome tabs the whole time, behind
 * VS Code, while the user stared at their editor and reasonably concluded it was broken — and I
 * kept reporting "opened" because the command exited 0. Exit code 0 meant "a tab exists
 * somewhere", never "you can see it".
 *
 * So on macOS we also `activate` the browser. Raising a window the user asked for is not a
 * surprise; leaving them looking at the wrong app while claiming success is.
 */
/* ASYNCHRONOUS, ALWAYS (RVBC-INSTANT-SPEC #5). This runs inside the `server.listen()` callback, so
   every synchronous millisecond here is a millisecond the freshly-opened tab spends waiting for its
   own first byte. `spawnSync(open)` costs a launch-services round-trip and `spawnSync(osascript)`
   was capped at EIGHT SECONDS — which is to say the browser could have the tab while the server that
   is supposed to answer it was blocked, by the very act of opening it. Detached + unref'd spawns
   start the same processes without ever holding the loop. */
function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const bg = (cmd, args, opts = {}) => {
    try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts }); c.on('error', () => {}); c.unref(); }
    catch { /* headless is fine */ }
  };
  bg(opener, [url]);
  if (process.platform !== 'darwin') return;
  // Bring whichever browser now holds the tab to the front. Best-effort and silent: a failure here
  // must never break serving the page.
  {
    bg('osascript', ['-e', `
      tell application "System Events"
        set brs to name of every application process whose bundle identifier is in ¬
          {"com.google.Chrome","com.apple.Safari","company.thebrowser.Browser","org.mozilla.firefox","com.brave.Browser"}
      end tell
      repeat with b in brs
        try
          tell application (b as text) to activate
          exit repeat
        end try
      end repeat
    `], { timeout: 8000 });   // spawn's own timeout kills a wedged osascript; it never blocks us
  }
}
function startServer({ port = Number(process.env.CONSOLE_PORT) || 7411, open = false, cwd = process.cwd() } = {}) {
  const controlToken = crypto.randomBytes(24).toString('hex');
  let activeRuntime = null;
  let receiptFile = null;
  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: this server binds 127.0.0.1 only. Reject any request whose Host header
    // isn't loopback, so a malicious web page can't rebind a hostname to 127.0.0.1 and read local state.
    const reqHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (reqHost !== '127.0.0.1' && reqHost !== 'localhost' && reqHost !== '::1' && reqHost !== '[::1]') {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden host'); return;
    }
    try {
      const url = req.url.split('?')[0];
      // This identity endpoint is deliberately cache-independent and never exposes the shutdown
      // token. The private receipt is ownership proof; this endpoint only proves which generation
      // is listening before reuse or replacement.
      if (req.method === 'GET' && url === '/api/runtime') {
        return sendJSON(res, activeRuntime ? 200 : 503, activeRuntime || { error: 'runtime not ready' });
      }
      if (req.method === 'POST' && url === '/api/runtime/shutdown') {
        const body = await readBody(req);
        if (body.controlToken !== controlToken) return sendJSON(res, 403, { error: 'bad or missing control token' });
        sendJSON(res, 202, { ok: true, stopping: true });
        setImmediate(() => server.close());
        return;
      }
      // Heavy read-models: ALWAYS cache-first (fast=1 or not — both land here now). The handler
      // never blocks the event loop; kickRefresh() recomputes in a detached child. See writeCache/
      // serveCached above and the --refresh-cache CLI mode. TOKEN is injected at serve time so it
      // never has to live in the on-disk cache.
      if (req.method === 'GET' && url === '/api/state') {
        // project-scoped: never serve another project's cached state. The measuring lives in the
        // --refresh-cache child; this handler only ever reads a file and stamps the token on it.
        return serveCached(res, STATE_CACHE, (d) => ({ ...d, token: TOKEN }), cwd);
      }
      // ── /api/capabilities — "what do I own, and is it on?" ──────────────────────────────────────
      //
      // THE MISSING WIRE. capability-registry.mjs and capability-audit.mjs were both written, both
      // tested, and had ZERO call sites — a parallel reviewer found it with one grep. The client
      // referenced them only in COMMENTS. So the console could compute the single thing the owner
      // has asked for all night ("a ton of people don't know what is or isn't turned on because
      // it's very much a black box") and served it to nobody.
      //
      // That is this project's signature failure in its purest form: built, tested, unwired. It is
      // the same shape as the recommendation with no executor, and the advocacy engine that
      // rendered nowhere. Detection without delivery is a nicer way of doing nothing.
      //
      // Cached like the other heavy read-models — auditAll() shells out to real commands to derive
      // each state, which is far too slow for a first paint but is exactly why the answers are
      // trustworthy: every row is DERIVED on this machine, never asserted.
      if (req.method === 'GET' && url === '/api/capabilities') {
        return serveCached(res, CAPABILITY_CACHE, (d) => d, cwd);
      }
      if (req.method === 'GET' && url === '/api/memory') {
        // THE THESIS, FINALLY CONNECTED (ADR-027, 2026-07-22).
        //
        // buildHealthRecommendations() has existed since the ADR was written and was reachable ONLY
        // from apply() — i.e. only once a user clicked something that was never displayed. The brain
        // could see a corrupt store, a starving learner, and a fleet of memory stores that teach it
        // nothing, and it said none of it out loud. Every word in ADR-027 about the brain advocating
        // was true of the code and invisible to the person in front of it.
        //
        // It rides /api/memory rather than /api/state because it needs the fleet scan (100+ SQLite
        // stores at ~90ms each) and a `ruflo hooks intelligence --status` round-trip. That is far too
        // slow for first paint — so it is measured ONLY in the --refresh-cache child, which builds
        // the fleet and hands it straight to the recommendation builder so the advice is derived
        // from the same scan the user is looking at.
        return serveCached(res, MEMORY_CACHE, (d) => d, cwd);   // project-scoped: health + recs are about THIS project
      }
      if (req.method === 'GET' && url === '/api/stack') {
        // Machine-level (no scopeKey): the installed stack is the same whichever project you opened
        // from. Measured only in the child — this is the endpoint that answered cold in 23,640 ms on
        // the request path before the instant-open fix.
        return serveCached(res, STACK_CACHE);
      }
      if (req.method === 'GET' && url === '/api/activity') return sendJSON(res, 200, gatherActivity(cwd));
      if (req.method === 'GET' && url === '/api/lessons') return sendJSON(res, 200, gatherLessons());
      if (req.method === 'GET' && url === '/api/trust') return sendJSON(res, 200, await gatherTrust());
      if (req.method === 'GET' && url === '/tips') { req.url = '/tips.html'; return serveStatic(req, res); }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.token !== TOKEN) return sendJSON(res, 403, { error: 'bad or missing token' });
        if (url === '/api/apply') return sendJSON(res, 200, apply(Array.isArray(body.ids) ? body.ids : []));
        if (url === '/api/save-config') return sendJSON(res, 200, saveConfig(body.values || {}));
        if (url === '/api/save-advocacy') return sendJSON(res, 200, saveAdvocacy(body.values || {}));
        // ADR-054 — a distinct endpoint because it writes a distinct thing (the sentinel + the
        // mirror), never routed through save-advocacy/save-config.
        if (url === '/api/save-brain-power') return sendJSON(res, 200, saveBrainPower(body.values || {}));
        if (url === '/api/save-brain-profile') return sendJSON(res, 200, saveBrainProfile(body.values || {}));
        if (url === '/api/refresh') {
          // THE ONE REFRESH STORY (owner directive 2026-07-26; RVBC-INSTANT-SPEC #8). The page opens
          // instantly on the last measurement, SAYS how old it is, and this is the button that takes
          // a new one. Three things it must get right, each of which was wrong in the first draft:
          //
          //   • ALL FOUR caches, not just state. The header pill speaks for the whole page; going
          //     green after state alone — while stack, capabilities and the fleet were still a
          //     minute behind — is a page-wide "measured just now" that is false for three of its
          //     four cards. (Live cache stamps from the incident: state 03:36:58, stack 03:37:23,
          //     memory/capabilities 03:38:02.)
          //   • EXPIRE, NEVER DELETE, AND NEVER DE-SCOPE — see expireCachesEmbedding: the data
          //     survives, marked withdrawn, so the page keeps showing the last honest picture with
          //     an honest age while the new one is taken.
          //   • FORCE the kick. kickRefresh's 15s debounce would silently swallow a click made
          //     within 15s of any background kick — and the old code still answered `ok: true`. A
          //     refresh that did not start must not report that it did, so `started` is the child's
          //     real answer, not a constant.
          expireCachesEmbedding([STATE_CACHE, STACK_CACHE, MEMORY_CACHE, CAPABILITY_CACHE]);
          const started = kickRefresh({ force: true });
          return sendJSON(res, 200, { ok: true, refreshing: true, started });
        }
        if (url === '/api/undo') return sendJSON(res, 200, undo(body.undoToken));
        if (url === '/api/set-lesson') return sendJSON(res, 200, setLesson(body));
        return sendJSON(res, 404, { error: 'unknown endpoint' });
      }
      if (req.method === 'GET') return serveStatic(req, res);
      return send(res, 405, 'text/plain', 'method not allowed');
    } catch (e) { return sendJSON(res, 500, { error: String(e && e.message || e) }); }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port !== 0) { console.error(`  port ${port} busy — trying a free one…`); startServer({ port: 0, open, cwd }); }
    else { console.error(`  server error: ${e.message}`); process.exit(1); }
  });
  server.on('close', () => {
    if (receiptFile) removeOwnedRuntimeReceipt(receiptFile, controlToken);
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    const url = `http://127.0.0.1:${actual}/`;
    activeRuntime = runtimeIdentity({ port: actual, cwd });
    receiptFile = writeRuntimeReceipt({ ...activeRuntime, controlToken });
    console.log(`\n  🧠  RuvNet Brain — Onboarding Console`);
    console.log(`      ${url}`);
    console.log(`      read-only until you click · token-gated · ^C to stop\n`);
    // Cold-start fix (2026-07-17): hydrate last run's fleet/trust caches from disk FIRST — the
    // first page load paints real, honestly-stamped data in ~2s instead of a 25–50s scan — then
    // warm a fresh scan off the request path.
    // Tell a FIRST-RUN user what to expect. With a warm cache the page paints immediately; with no
    // cache at all it is genuinely empty until the detached scan lands, and an empty page with no
    // explanation reads as broken. Measured 2026-07-20: URL is printed in ~0.3s either way, so the
    // wait a user perceives is the page filling in, not the server starting.
    //
    // COLD-VS-WARM DEFINITION: loadConsoleCache() returns true only when a disk cache was successfully
    // restored at boot (meaning a prior run exists and has persisted data). First-ever run → no cache
    // file exists → loadConsoleCache returns false → message prints. Warm re-opens → cache file exists
    // and loads → message does not print. This is the same definition serveCached() uses.
    const hadCache = loadConsoleCache();
    if (!hadCache) {
      console.log(`      ${'first run — the page opens now and narrates its own scan'}`);
      console.log(`      ${"(next time you open this, it's already measured)"}\n`);
      announceWhenLive(url);   // print "it's live — take a look at your page" when the scan lands
    }
    // ORDER MATTERS AND IS THE WHOLE POINT (RVBC-INSTANT-SPEC #5). Browser FIRST — the tab is what
    // the user is waiting for and openBrowser is now fully asynchronous — then the scan, in a
    // detached child, off this thread entirely.
    //
    // WHAT WAS HERE BEFORE, AND WHY IT COST THE OWNER HIS THREE MINUTES: `setTimeout(gatherActivity,
    // 50)`. Fifty milliseconds after the URL printed — which is to say exactly as the browser was
    // opening — the server ran the machine-wide fleet scan ON ITS OWN EVENT LOOP: 100+ SQLite stores,
    // 40s+, during which the brand-new tab could not be answered at all. A blank white page, at the
    // precise moment a first-time user is deciding whether this thing works. The child does that
    // scan now (see --refresh-cache), and gatherActivity reports `warming` until it lands.
    if (open) openBrowser(url);
    // Browser acceptance pre-warms a disposable fixture root and disables only this redundant second scan.
    // The production default is unchanged: every ordinary console start refreshes in the background.
    if (process.env.RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH !== '1') kickRefresh({ force: true });
  });
  return server;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('onboarding-console.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--print-state')) { console.log(JSON.stringify(gatherState(process.cwd()), null, 2)); }
  else if (args.includes('--print-stack')) { console.log(JSON.stringify(gatherStack(), null, 2)); }
  else if (args.includes('--runtime-status')) { console.log(JSON.stringify(await inspectConsoleRuntime())); }
  else if (args.includes('--refresh-cache')) {
    // Runs as a DETACHED CHILD of the server (kickRefresh) — or standalone to pre-warm. Computes the
    // heavy read-models HERE, in a separate process, so the server's event loop is never blocked, and
    // writes each cache the moment it is ready (state first — it is what the page paints first).
    try {
      let st = gatherState(process.cwd(), { fleet: false });
      const autoApplyOn = loadSettings().values.autoApply === true;
      const eligible = autoApplyOn ? autoEligibleIds(st.sections.recommendations) : [];
      if (eligible.length) {
        const receipt = apply(eligible);
        // Re-measure after the mutations. A pre-apply read model must never be stamped as current.
        st = gatherState(process.cwd(), { fleet: false });
        st.sections.autoApply = {
          at: new Date().toISOString(),
          requested: eligible,
          results: receipt.results,
        };
      }
      const { token, ...safe } = st;
      writeCache(STATE_CACHE, st.generatedAt, safe, process.cwd());
    } catch { /* leave the old cache in place */ }
    // TASK 3: function-call arguments are evaluated left-to-right, so the previous
    // `writeCache(STACK_CACHE, new Date().toISOString(), gatherStack())` evaluated the timestamp
    // BEFORE gatherStack()'s ~22s scan ran — the same bug as the /api/stack handler above, duplicated
    // here. gatherStack() as its own statement first fixes it the same way.
    try { const stackData = gatherStack(); writeCache(STACK_CACHE, new Date().toISOString(), stackData); } catch { /* keep prior */ }
    // Must compute the SAME shape the /api/memory handler does — fleet AND recommendations.
    //
    // This wrote fleet-only, so the background refresh silently ERASED the advocacy the handler had
    // just produced: the first request returned 2 recommendations, the refresh landed, and every
    // request after it returned 0. The page would have shown the thesis once and then quietly
    // stopped, which is indistinguishable from "your machine is fine" — the precise failure ADR-027
    // exists to end, reintroduced by a cache writer that knew about half the payload. Caught by
    // polling the live endpoint twice instead of once.
    try {
      const fleet = scanFleet();
      let recommendations = [];
      try {
        const project = projectDirectory();
        const health = scoreMemoryHealth({ project: path.basename(project), probes: probeMemory(project) });
        recommendations = buildHealthRecommendations({ memory: health, learning: { ...observeLearning(), fleet } });
      } catch { /* advisory only */ }
      writeCache(MEMORY_CACHE, new Date().toISOString(), { fleet, recommendations }, process.cwd());
    } catch { /* keep prior */ }

    // CAPABILITY_CACHE WAS NOT IN THIS LIST — the single most consequential omission in the file.
    //
    // Measured 2026-07-24: after the freshness ceiling landed, a capability cache past the ceiling was
    // correctly marked stale and `kickRefresh()` was fired — and this child, the only thing that ever
    // refreshes anything in the background, did not know CAPABILITY_CACHE existed. Polled every 5s for
    // a minute: it never came back fresh. It could not. The only other writer is serveCached's COLD
    // path, which requires the file to be absent, and it never is.
    //
    // So capabilities had NO refresher whatsoever. Under the old code that was invisible, because the
    // cache was served forever while *looking* current — the two-day-old lie was not a stale-cache bug
    // with an unlucky timestamp, it was this: a read-model nothing was ever going to recompute. The
    // ceiling did not cause the problem, it EXPOSED it, by turning a silent lie into a visible refusal.
    //
    // Found only because a test's PRECONDITION failed: waiting for the cache to become fresh so the
    // real assertion could run. Had the precondition been assumed rather than checked, the run would
    // have passed and reported a guarantee that does not exist.
    try {
      const { at, data } = computeCapabilities();   // the SAME computer the handler uses
      writeCache(CAPABILITY_CACHE, at, data, process.cwd());
    } catch { /* keep prior — a failed audit must never blank the card */ }

    // THE MACHINE-WIDE FLEET SCAN LIVES HERE NOW (RVBC-INSTANT-SPEC #5), and this is the last thing
    // the child does because it is the longest (100+ SQLite stores, 40s+) and everything above it is
    // what the page paints first. It used to run on the SERVER's thread — inline on a first-ever
    // /api/activity, and via a setTimeout 50ms after boot, which is to say while the browser was
    // opening. loadConsoleCache() first so this process holds the previous trust measurement and
    // saveConsoleCache's merge has something to preserve.
    try { loadConsoleCache(); refreshFleetCache(); } catch { /* keep prior — a failed walk must never blank the fleet */ }

    process.exit(0);
  }
  else if (args.includes('--serve') || args.length === 0) {
    await launchConsole({
      port: Number(process.env.CONSOLE_PORT) || 7411,
      open: args.includes('--open'),
      cwd: process.cwd(),
    });
  }
  else { console.log(`\n  onboarding-console — the RuvNet Brain configure page\n\n    --serve [--open]   start or safely replace the scoped local server\n    --runtime-status   print candidate, receipt, and live runtime status\n    --print-state      print the read-only state JSON and exit (for tests)\n    --print-stack      print the stack audit JSON and exit\n`); }
}

export {
  gatherState,
  gatherStack,
  gatherTrust,
  wiringSurvey,
  probeMemory,
  apply,
  saveConfig,
  undo,
  gatherAdvocacy,
  saveAdvocacy,
  gatherBrainPower,
  saveBrainPower,
  gatherBrainProfile,
  saveBrainProfile,
  gatherRouterEngine,
  autoEligibleIds,
};
// Exported for the cross-project cache-isolation test (console-cache-scope.test.mjs). serveCached's
// scopeKey is the guard that stops one project's cached state being served for another.
export { serveCached, writeCache, kickRefresh };
export { inspectConsoleRuntime, launchConsole, runtimeReceiptPath, startServer };
