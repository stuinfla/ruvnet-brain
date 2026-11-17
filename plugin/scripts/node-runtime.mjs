// node-runtime.mjs — which Node binary a long-lived process should start its children with.
//
// WHY (2026-11-16, search outage). The MCP shell started its search worker with process.execPath: the
// node the shell was LAUNCHED under, which Node reports as a resolved, versioned Homebrew keg
// (/opt/homebrew/Cellar/node@24/24.22.3/bin/node). At 3:31 a.m. a `brew upgrade` replaced simdjson
// (libsimdjson.36 -> .37); the old keg's node then died in 7 ms with "dyld: Library not loaded", so every
// search in every already-open session failed with "brain worker exited". The same pin broke `claude`
// itself on 2026-10-08 through the terminal launchers. A path captured at start-up is a claim about the
// past; a child must be started with a node that works NOW.
//
// So: an ordered chain of candidates, resolved at spawn time, each proved by a real start (`node -e 0`)
// before use. A broken binary is skipped, never chosen. Only node: builtins are imported here — the
// terminal-launcher runtime snapshot copies this file by following relative imports.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const KEG = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/;

/** Homebrew's stable `opt` link for a versioned keg node, or null. The keg path disappears on every
 *  `brew upgrade`; `<prefix>/opt/<formula>` is re-pointed at the new keg by brew itself. */
export function homebrewOptNode(file) {
  const m = KEG.exec(String(file || ''));
  return m ? path.join(m[1], 'opt', m[2], 'bin', 'node') : null;
}

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** Newest installed version under a version-manager directory (nvm/fnm layouts), as a bin/node path. */
function newestUnder(dir, tail) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const num = (v) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  names.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return names.map((n) => path.join(dir, n, ...tail));
}

/**
 * The ordered candidate chain (unique, existing files only). process.execPath is LAST: it is the one
 * path known to be captured in the past.
 *   0. $RUVNET_BRAIN_NODE_CANDIDATES (path-delimited) — explicit override, also the test seam
 *   1. the stable Homebrew opt link of the launch node (follows `brew upgrade`)
 *   2. the Brain's own vendored node (~/.local/share/ruvnet-brain/node/current/bin/node)
 *   3. `node` on PATH (plus well-known prefixes), i.e. what `command -v node` finds
 *   4. version-manager shims: volta, mise, asdf, nvm, fnm
 *   5. process.execPath
 * $RUVNET_BRAIN_NODE_WELL_KNOWN replaces the well-known prefixes (empty = none), so a test can build a
 * world in which every candidate is broken.
 */
export function nodeCandidates({ execPath = process.execPath, env = process.env, home = env.HOME || os.homedir() } = {}) {
  const list = [];
  // Absolute paths only: a relative entry would resolve against whatever project the host started in.
  for (const p of String(env.RUVNET_BRAIN_NODE_CANDIDATES || '').split(path.delimiter)) if (p && path.isAbsolute(p)) list.push(p);
  let real = execPath;
  try { real = fs.realpathSync(execPath); } catch { /* the launch node may already be gone */ }
  list.push(homebrewOptNode(execPath), homebrewOptNode(real));
  list.push(path.join(home, '.local', 'share', 'ruvnet-brain', 'node', 'current', 'bin', 'node'));
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of String(env.PATH || '').split(path.delimiter)) if (dir && path.isAbsolute(dir)) list.push(path.join(dir, exe));
  const wellKnown = env.RUVNET_BRAIN_NODE_WELL_KNOWN !== undefined
    ? env.RUVNET_BRAIN_NODE_WELL_KNOWN.split(path.delimiter).filter(Boolean)
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  list.push(...wellKnown);
  list.push(path.join(home, '.volta', 'bin', 'node'), path.join(home, '.local', 'share', 'mise', 'shims', 'node'),
    path.join(home, '.asdf', 'shims', 'node'));
  list.push(...newestUnder(path.join(home, '.nvm', 'versions', 'node'), ['bin', 'node']));
  list.push(...newestUnder(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin', 'node']));
  list.push(execPath);
  return [...new Set(list.filter(Boolean))].filter(isFile);
}

/** Start the candidate and prove it runs. Resolves { ok, version, reason }. Never rejects. */
export function selfTest(node, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let proc;
    try {
      proc = spawn(node, ['-e', 'process.stdout.write(process.versions.node)'], { stdio: ['ignore', 'pipe', 'pipe'], env: selfTestEnv(), cwd: os.tmpdir() });
    } catch (e) { return finish({ ok: false, broken: true, reason: e.code || e.message }); }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, broken: false, reason: `no answer in ${timeoutMs / 1000}s` }); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    proc.on('error', (e) => finish({ ok: false, broken: true, reason: e.code || e.message }));
    // 'close', not 'exit': stdout can still be unread when 'exit' fires, and a healthy node must never be
    // judged broken because its version string had not arrived yet.
    proc.on('close', (code, signal) => {
      if (code === 0 && /^\d+\.\d+\.\d+/.test(out)) finish({ ok: true, version: out.trim() });
      else finish({ ok: false, broken: true, reason: `${signal ? `killed by ${signal}` : `exit ${code}`}${err ? `: ${firstLine(err)}` : ''}` });
    });
  });
}

/** The self-test's environment: what node.exe needs to start on Windows (SystemRoot) and a version-manager
 *  shim needs to resolve (HOME), but never NODE_OPTIONS / NODE_PATH, which could load arbitrary code. It runs
 *  in the temp directory, never the project the host started in (a shim must not read a project's config). */
function selfTestEnv(env = process.env) {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR',
    'ASDF_DIR', 'ASDF_DATA_DIR', 'MISE_DATA_DIR', 'VOLTA_HOME', 'NVM_DIR', 'FNM_DIR'];
  const out = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

export const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) || '';

/**
 * Order the chain for use: candidates that passed the self-test first (same major version as this
 * process before other majors — native modules were built for one ABI), then candidates whose self-test
 * merely timed out (a loaded machine is not a broken binary). Proven-broken and missing binaries are
 * dropped and reported in `rejected`. Stops testing at the first same-major pass.
 */
export async function resolveNodeChain({ candidates = nodeCandidates(), skip = new Set(), timeoutMs, budgetMs = 15_000, major = process.versions.node.split('.')[0] } = {}) {
  const same = [], other = [], slow = [], rejected = [];
  const deadline = Date.now() + budgetMs; // a loaded machine must not turn ten 5 s self-tests into a minute
  for (const node of candidates) {
    if (skip.has(node)) continue;
    if (Date.now() > deadline) { slow.push({ node, version: null }); continue; }
    const r = await selfTest(node, { timeoutMs });
    if (r.ok) {
      (r.version.split('.')[0] === major ? same : other).push({ node, version: r.version });
      if (same.length) break;
    } else if (r.broken) rejected.push({ node, reason: r.reason });
    else slow.push({ node, version: null });
  }
  return { usable: [...same, ...other, ...slow], rejected };
}
