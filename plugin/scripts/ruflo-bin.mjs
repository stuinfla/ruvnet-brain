/**
 * ruflo-bin.mjs — the ONE place this repo decides WHERE the global `ruflo` binary is.
 *
 * WHY THIS FILE EXISTS. Issues #99 and #105 are one defect filed twice: `scripts/distill-project.mjs`
 * and the learning flusher each hardcoded `~/.npm-global/bin/ruflo` — the owner's npm
 * prefix, nobody else's. On a Homebrew, nvm, Volta, or plain `npm -g` install that path does not
 * exist, so #99 died with "ruflo is not at ~/.npm-global/bin/ruflo" and #105 failed every feed
 * silently — both on machines where ruflo was installed and sitting on PATH the whole time.
 *
 * `health-repair.mjs` had already fixed exactly this, and its header says why: "Telling someone their
 * tool is missing when it is on their PATH is the product lying, and it is unfalsifiable from their
 * side: they cannot see why we looked in one place." That fix lived as a private function inside one
 * file, so its two siblings kept the bug — the identical shape ADR-021 was written about ("One class,
 * fixed in one file, regenerated in the sibling"). So the resolver moves here instead of being pasted
 * a third time.
 *
 * MECHANISM — the hardened form, not the first draft. Two resolvers already existed in this repo:
 *   • health-repair.mjs      (2026-07-21)  preferred path, then `sh -lc 'command -v ruflo'`
 *   • capability-registry.mjs (2026-07-22)  preferred path, then a plain PATH walk, NO shell
 * The second IS the first one, hardened, and it says so in place: `-l` sources the user's entire
 * profile — every export, shim, and one-off line anyone has ever pasted into .profile — as the price
 * of answering "where is ruflo?". Resolving a name against directories is all `command -v` was ever
 * wanted for here, and it needs no shell at all. This module takes that version. Adopting the older
 * mechanism would mean re-introducing, in a shared module, a bug the repo had already fixed one file
 * over.
 *
 * ORDER, and each step earns its place:
 *   1. RUFLO_BIN, if set, is AUTHORITATIVE — returned as given, whether or not it exists. An explicit
 *      override that quietly falls back to some other ruflo is not an override, and the caller's
 *      "not at <path>" message has to name the path the user actually asked for.
 *   2. ~/.npm-global/bin/ruflo — Rule 21's ONE global binary, checked first so a machine that has it
 *      never depends on PATH ordering.
 *   3. A PATH walk — the entire point of #99/#105: an installed ruflo living anywhere else.
 *   4. null — "I could not find it", said plainly. Never guess a path and then blame the user for it.
 *
 * Rule 21 is untouched by this: still ONE ruflo, still the global one, never `npx ruflo@latest`. This
 * resolves WHERE that one global binary is rather than assuming everyone's prefix matches the owner's.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WHICH NODE RUNS RUFLO (measured 2026-10-14, ruflo 3.56.9 / better-sqlite3 12.11.1). `ruflo` is
// `#!/usr/bin/env node`, so the interpreter is whatever is FIRST on the CALLER's PATH — and an
// installed better-sqlite3 holds ONE native ABI (this machine's was built for node 24). A hook
// launched with PATH=/opt/homebrew/bin:… got node 26, and `memory store` was refused with
// "Native memory writer required; refusing whole-image sql.js fallback": 67 failed captures in a day,
// each one a lost turn record. Same command, only PATH changed: node 26 first → refused, node 24 first
// → stored. Upstream's guard (ruflo#2219) covers shipping prebuilds for Node 20–26, not one install
// being run under several nodes, so the choice belongs here, in the one resolver every caller shares.
//
// The test is the load itself — open an in-memory database through the SAME better-sqlite3 ruflo
// will use — never a version string. Healthy machines are untouched: when the PATH node loads the
// binding, this returns null and the invocation stays exactly `ruflo …`.
function defaultNodeCandidates(env) {
  const out = [];
  for (const dir of String(env.PATH || '').split(path.delimiter)) if (dir) out.push(path.join(dir, 'node'));
  out.push(process.execPath);
  try {
    const opt = '/opt/homebrew/opt';
    for (const name of fs.readdirSync(opt).filter((n) => /^node(@\d+)?$/.test(n)).sort().reverse()) {
      out.push(path.join(opt, name, 'bin', 'node'));
    }
  } catch { /* no Homebrew opt dir */ }
  out.push('/opt/homebrew/bin/node', '/usr/local/bin/node');
  return [...new Set(out)].filter((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}

// Where ruflo's native better-sqlite3 lives depends on the ruflo release. Measured 2026-10-17 with npm -g: ruflo
// 3.56.10 hoisted nothing (copies nested under @claude-flow/cli, @claude-flow/memory and agentdb), so probing only
// <ruflo>/node_modules/better-sqlite3 found nothing and node selection silently never ran; ruflo 3.57.0 hoists it.
// We probe the hoisted copy first, so a machine that has one behaves exactly as before, then the nested layouts.
// Every candidate is a fixed path under ruflo's own realpath. Copies can differ in version (3.57.0: hoisted 12.11.1,
// agentdb's nested 11.10.0), so the probed copy is a proxy for the one the writer loads, not proof of it.
const ADDON_DIRS = [
  ['node_modules', 'better-sqlite3'],
  ['node_modules', '@claude-flow', 'cli', 'node_modules', 'better-sqlite3'],
  ['node_modules', '@claude-flow', 'memory', 'node_modules', 'better-sqlite3'],
  ['node_modules', 'agentdb', 'node_modules', 'better-sqlite3'],
];

function findAddon(packageRoot) {
  for (const parts of ADDON_DIRS) {
    const dir = path.join(packageRoot, ...parts);
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* try the next layout */ }
  }
  return null;
}

const nativeNodeCache = new Map();
const PROBE_TIMEOUT_MS = 2000;
const PROBE_BUDGET_MS = 3000;

/**
 * rufloInvocation for callers that must never throw: an unrecognised shim keeps the plain `bin args` they
 * always ran, so routing a call site through node selection can only add the correct interpreter.
 */
export function rufloInvocationOrPlain(binary, args, opts) {
  try { return rufloInvocation(binary, args, opts); } catch { return { executable: binary, args }; }
}

/**
 * The node that can load ruflo's native better-sqlite3, or null when the caller's own PATH node
 * already can, when ruflo is not a node package we can inspect, or when no candidate can.
 * Null always means "leave the invocation exactly as it was" — this never makes anything worse.
 *
 * @param {string} binary  path to the ruflo bin (symlink or script)
 * @param {{ env?: Record<string,string|undefined>, candidates?: string[] }} [opts]
 * @returns {{ node: string, entry: string }|null}
 */
export function nativeNodeFor(binary, { env = process.env, candidates } = {}) {
  let entry;
  try { entry = fs.realpathSync(binary); } catch { return null; }
  const addon = findAddon(path.dirname(path.dirname(entry)));
  if (!addon) return null;

  const list = candidates ?? defaultNodeCandidates(env);
  const cacheKey = `${entry}\0${list.join('\0')}`;
  if (nativeNodeCache.has(cacheKey)) return nativeNodeCache.get(cacheKey);

  const probe = `new (require(${JSON.stringify(addon)}))(':memory:').close()`;
  let chosen = null;
  // Bounded: this runs inside hooks that have their own deadline (SessionStart is stopped 1.5 s early), so a
  // wedged candidate must cost seconds at most and then leave the invocation exactly as it was.
  const started = Date.now();
  for (let i = 0; i < list.length; i += 1) {
    if (Date.now() - started > PROBE_BUDGET_MS) break;
    const r = spawnSync(list[i], ['-e', probe], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    if (r.status === 0) { chosen = i === 0 ? null : { node: list[i], entry }; break; }
  }
  nativeNodeCache.set(cacheKey, chosen);
  return chosen;
}

// npm's Windows .cmd shim cannot be spawned without a shell. Resolve the declared entry
// inside that same managed installation and pass argv directly to Node instead.
export function rufloInvocation(binary, args, { platform = process.platform, env = process.env, nodeCandidates } = {}) {
  if (platform !== 'win32') {
    const native = nativeNodeFor(binary, { env, candidates: nodeCandidates });
    return native ? { executable: native.node, args: [native.entry, ...args] } : { executable: binary, args };
  }
  if (!/\.cmd$/i.test(binary)) return { executable: binary, args };
  if (path.basename(binary).toLowerCase() !== 'ruflo.cmd') throw new Error('unsupported managed Ruflo shim');
  const packageRoot = fs.realpathSync(path.join(path.dirname(fs.realpathSync(binary)), 'node_modules', 'ruflo'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.ruflo;
  if (manifest.name !== 'ruflo' || typeof declared !== 'string' || !declared
    || path.isAbsolute(declared) || path.win32.isAbsolute(declared) || declared.split(/[\\/]/).includes('..')) {
    throw new Error('managed Ruflo package has no safe declared CLI entry');
  }
  const entry = fs.realpathSync(path.resolve(packageRoot, declared));
  const relative = path.relative(packageRoot, entry);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) {
    throw new Error('managed Ruflo CLI entry escapes its package');
  }
  return { executable: process.execPath, args: [entry, ...args] };
}

/**
 * Locate the global ruflo. LOCATES, NEVER EXECUTES — no shell, no daemon, no side effects.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string|null} path to ruflo, or null when it is genuinely not on this machine.
 */
export function resolveRuflo({ env = process.env, home = os.homedir() } = {}) {
  if (env.RUFLO_BIN) return env.RUFLO_BIN;

  // On Windows a global npm ruflo is `ruflo.cmd`; the extensionless sibling is a POSIX shell wrapper
  // that Node cannot exec (and refuses to spawn without a shell since CVE-2024-27980).
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];

  // The preferred path needs that SAME rule. It first checked a bare `ruflo` only, so on Windows it
  // either missed the real `ruflo.cmd` entirely or returned the POSIX wrapper the comment above
  // says is unrunnable — and the caller then reported "ruflo is not at ~/.npm-global/bin/ruflo" to
  // someone who had ruflo installed. That is the exact complaint #99 and #105 were filed about,
  // reintroduced one platform over.
  const preferredDir = path.join(home, '.npm-global', 'bin');
  for (const ext of exts) {
    const cand = path.join(preferredDir, `ruflo${ext}`);
    try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch { /* unreadable */ }
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, `ruflo${ext}`);
      try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

/**
 * What to say when resolveRuflo() returns null. ONE wording, so every caller reports the same thing
 * and names both places it looked — the diagnostic #99 and #105 never gave anyone.
 */
export const RUFLO_MISSING = 'ruflo was not found in ~/.npm-global/bin or anywhere on your PATH'
  + ' — install it with `npm i -g ruflo@latest`, or set RUFLO_BIN to its full path';

// ── Private per-project ruflo working directories ──
import crypto from 'node:crypto';

/**
 * The working directory ruflo runs in. ruflo writes into its cwd on every invocation even when --path
 * names the store (measured 2026-10-01, ruflo 3.49.0): `.claude/`, `.claude-flow/`, `ruvector.db`, and
 * `<cwd>/.swarm/` holding hnsw.metadata.json — the stored snapshot CONTENT — which it also LOADS when it
 * finds one there (ruflo/v3/@claude-flow/cli/src/memory/memory-initializer.ts: getMemoryRoot() = cwd).
 * So the cwd must be:
 *  - never the project tree (it changed the customer's working tree and broke no-op capture detection),
 *    never inside `.swarm` (nested `.swarm/.swarm`);
 *  - PER PROJECT (one shared dir would pool every project's snapshot text and let one project load
 *    another's metadata);
 *  - private and ours: under the Brain's own home (never a shared /tmp name another user could pre-create
 *    or symlink), every directory we create checked to be a real directory, owned by us, mode 0700.
 * Every ruflo call carries --path, so the store it reads and writes is unaffected by the cwd.
 */
export function rufloScratchRoot(env = process.env) {
  if (env.RUVNET_RUFLO_CWD_ROOT) return path.resolve(env.RUVNET_RUFLO_CWD_ROOT);
  return path.join(env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain'), 'ruflo-cwd');
}

/** Create-or-verify one private directory: a real directory (not a link), owned by us, mode 0700. */
export function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`ruflo scratch directory ${dir} is not a real directory (symlink or file); refusing to use it`);
  }
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid()) {
      throw new Error(`ruflo scratch directory ${dir} is owned by uid ${stat.uid}, not ${process.getuid()}; refusing to use it`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
      if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) throw new Error(`ruflo scratch directory ${dir} could not be made private (0700)`);
    }
  }
  return dir;
}

export function rufloCwdFor(storePath, { root = rufloScratchRoot() } = {}) {
  const projectKey = crypto.createHash('sha256').update(path.resolve(storePath)).digest('hex').slice(0, 32);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  ensurePrivateDir(root);
  return ensurePrivateDir(path.join(root, projectKey));
}

const RUFLO_CWD_ARTIFACTS = Object.freeze(['.swarm', '.claude', '.claude-flow', 'ruvector.db']);
const STALE_RUN_MS = 3_600_000;

/**
 * One ruflo invocation's working directory: a fresh private `run-*` directory inside the project's
 * scratch dir, removed again by the caller after the call. ruflo copies every snapshot it touches into
 * `<cwd>/.swarm/hnsw.metadata.json`; with one cwd per call that copy never accumulates (4.4.0 kept one
 * per project that grew without bound and outlived the project). Also clears what 4.4.0 left directly
 * in the project scratch dir and any `run-*` older than an hour (a call killed before its cleanup).
 */
export function rufloRunDir(storePath, { root = rufloScratchRoot(), now = Date.now() } = {}) {
  const projectScratch = rufloCwdFor(storePath, { root });
  for (const name of fs.readdirSync(projectScratch)) {
    const entry = path.join(projectScratch, name);
    let stat;
    try { stat = fs.lstatSync(entry); } catch { continue; }
    const stale = name.startsWith('run-') && stat.isDirectory() && now - stat.mtimeMs > STALE_RUN_MS;
    if (RUFLO_CWD_ARTIFACTS.includes(name) || stale) fs.rmSync(entry, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(projectScratch, 'run-'));
}
