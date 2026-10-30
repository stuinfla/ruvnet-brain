// scripts/issue-autofix-sandbox.mjs — the ONLY way the autofix job (ADR-107) runs code a model wrote.
//
// The build stage edits files from a stranger's issue. Running its tests (test validity, the verifier's evidence
// re-runs) executes that code on the owner's Mac, where the gh token sits in ~/.config/gh/hosts.yml and Claude's
// OAuth credential sits in the login keychain. So every such run goes through macOS `sandbox-exec` with a profile
// that denies ALL outbound network, keychain lookups, reads of credential stores and private folders, and every write
// outside the worktree and a per-run temp dir; the child also gets a minimal environment (no tokens, HOME = temp).
// Measured on this Mac (Darwin 27, 2026-10-30): inside the profile vitest runs normally while ~/.npmrc,
// ~/.config/gh, ~/.ssh, the Claude keychain item, curl and fetch are all refused (scratchpad probe, see ADR-107).
// Off macOS, or with sandbox-exec missing, nothing runs: AutofixAbort('sandbox-unavailable') — fail closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutofixAbort } from './issue-autofix-policy.mjs';

export const SANDBOX_BIN = '/usr/bin/sandbox-exec';
const q = (p) => JSON.stringify(String(p)); // SBPL string literal (paths never contain quotes; JSON escaping is exact)

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** Every hop of a symlink chain: the kernel checks each link it walks, so each must be readable. */
function linkChain(p, out = new Set()) {
  let cur = path.resolve(p);
  for (let i = 0; i < 16 && !out.has(cur); i += 1) {
    out.add(cur);
    let next;
    try { next = path.resolve(path.dirname(cur), fs.readlinkSync(cur)); } catch { break; }
    cur = next;
  }
  out.add(real(p));
  return out;
}

/** Home-relative stores the child may never read (credentials, browser data, other projects' .env files). */
export const READ_DENY_HOME = ['.ssh', '.npmrc', '.netrc', '.aws', '.config', '.claude', '.gnupg', '.docker', '.kube',
  '.git-credentials', '.gitconfig', '.local/share', '.npm/_cacache', 'Library', 'Documents', 'Desktop', 'Downloads', 'Code', '.cache/ruvnet-brain'];
const SECRET_MACH = ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.security.agent', 'com.apple.secd',
  'com.apple.security.keychain-circle-notification', 'com.apple.trustd.agent'];

/**
 * The SBPL profile. `writable` and `readable` are absolute paths; `readable` re-opens subpaths of a denied tree (for
 * example a node_modules the worktree links to). Later rules win in SBPL, so the allows come after the denies.
 */
export function sandboxProfile({ home, writable = [], readable = [] }) {
  if (!home || !path.isAbsolute(home)) throw new Error('sandboxProfile: home must be absolute');
  if (!writable.length || !writable.every((p) => path.isAbsolute(p))) throw new Error('sandboxProfile: writable paths must be absolute');
  const h = real(home);
  const deny = READ_DENY_HOME.map((d) => `(subpath ${q(path.join(h, d))})`);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound (remote ip))',
    '(deny network-outbound (remote unix-socket))',
    '(deny network-bind)',
    `(deny mach-lookup ${SECRET_MACH.map((n) => `(global-name ${q(n)})`).join(' ')})`,
    `(deny file-read-data ${deny.join(' ')} (subpath "/Library/Keychains") (regex #"/\\.env(\\.[^/]*)?$"))`,
    readable.length ? `(allow file-read-data ${[...new Set(readable.flatMap((p) => [...linkChain(p)]))].map((p) => `(subpath ${q(p)})`).join(' ')})` : '',
    `(deny file-write* (require-not (require-any ${writable.map((p) => `(subpath ${q(real(p))})`).join(' ')} (subpath "/dev"))))`,
    '',
  ].filter((l, i, a) => l !== '' || i === a.length - 1).join('\n');
}

/** The child environment: nothing inherited but what node/npx need to find themselves. */
export function sandboxEnv({ tmpHome, pathDirs }) {
  return { PATH: pathDirs.join(':'), HOME: tmpHome, TMPDIR: tmpHome, CI: '1', NO_COLOR: '1', LANG: 'en_US.UTF-8',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_offline: 'true' };
}

/**
 * Returns run(cmd, args, { cwd, timeoutMs, readable }) that executes through `exec` (so assertCommandAllowed and the
 * primary-checkout guard still apply) inside the sandbox, writable only in `cwd` and a fresh temp dir.
 */
export function makeSandboxRunner({ exec, tmpRoot = os.tmpdir(), platform = process.platform, sandboxBin = SANDBOX_BIN,
  home = os.homedir(), nodeDir = path.dirname(process.execPath), exists = fs.existsSync } = {}) {
  return function runSandboxed(cmd, args = [], { cwd, timeoutMs, readable = [], stage = 'S4' } = {}) {
    if (platform !== 'darwin' || !exists(sandboxBin)) {
      throw new AutofixAbort(stage, 'sandbox-unavailable', `untrusted code runs only under ${sandboxBin} on macOS`);
    }
    if (!cwd || !path.isAbsolute(cwd)) throw new AutofixAbort(stage, 'sandbox-unavailable', 'sandboxed runs need an absolute cwd');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'autofix-sbx-'));
    const profile = path.join(tmp, 'profile.sb');
    // node_modules is usually a link out of the worktree; its target must stay readable even under a denied tree.
    // node_modules is a directory of links into the shared install (issue-autofix-diff.mjs linkModules) or, in older
    // layouts, a single link: either way the install it points into must stay READABLE even inside a denied tree such as
    // ~/.cache/ruvnet-brain (measured 2026-10-30: without this, vitest itself could not be read and no test started).
    const nm = path.join(cwd, 'node_modules');
    const targets = new Set();
    if (exists(nm)) {
      targets.add(real(nm));
      try {
        for (const e of fs.readdirSync(nm)) {
          const p = path.join(nm, e);
          if (fs.lstatSync(p).isSymbolicLink()) targets.add(path.dirname(real(p)));
        }
      } catch { /* an unreadable node_modules just gets no extra grants */ }
    }
    const extra = [cwd, ...readable, ...targets];
    fs.writeFileSync(profile, sandboxProfile({ home, writable: [cwd, tmp], readable: extra }));
    const tmpHome = path.join(tmp, 'home');
    fs.mkdirSync(tmpHome);
    const env = sandboxEnv({ tmpHome, pathDirs: [nodeDir, '/usr/bin', '/bin'] });
    try {
      return exec(sandboxBin, ['-f', profile, cmd, ...args], { cwd, env, timeoutMs });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp only */ }
    }
  };
}
