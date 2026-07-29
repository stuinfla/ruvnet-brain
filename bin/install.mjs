#!/usr/bin/env node
// bin/install.mjs — the one-command installer for RuvNet Brain.
//
//   npx ruvnet-brain                           # published on npm — shortest, recommended
//   npx github:stuinfla/ruvnet-brain           # always the latest commit, even ahead of the npm release
//   node bin/install.mjs --local               # from a repo clone with assembled dist/ruvnet-brain/
//
// Goal: a newcomer runs ONE command and ends up with (a) the brain on disk and (b) the Claude Code
// plugin wired at user scope — narrating "what I'm doing and why" at every step (the product's ethos).
//
// Design rules: dependency-free (Node built-ins + shelling to unzip/npm/claude only), idempotent
// (safe to re-run), and never a silent half-state (every failure explains the next step).

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { applyBrainProfile, readBrainProfile } from '../kb/brain-profile.mjs';
import {
  requiredEmbedderModels,
  missingEmbedderModels,
} from '../kb/model-requirements.mjs';

// SEC-0010 #6 — the Ed25519 PUBLIC key is EMBEDDED here (not a separate file) so the installer's
// trust root travels with the installer code itself: an attacker who swaps the downloaded bundle
// cannot also swap the key the installer checks it against. Rotate via `node scripts/sign-bundle.mjs
// --gen-key` and paste the new keys/…pub.pem here. Verify logic mirrors scripts/verify-bundle.mjs.
const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgse9TAtehXUvUfTrJFY2CCHiCbmelR8yCgS//sen5/w=
-----END PUBLIC KEY-----`;
function verifyBundle(bundlePath, sigPath) {
  try {
    if (!fs.existsSync(bundlePath)) return { ok: false, reason: `bundle not found: ${bundlePath}` };
    if (!fs.existsSync(sigPath)) return { ok: false, reason: `signature missing (fail-closed)` };
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
    const pub = crypto.createPublicKey(SIGNING_PUBKEY_PEM);
    const ok = crypto.verify(null, Buffer.from(digest, 'hex'), pub, fs.readFileSync(sigPath));
    return ok ? { ok: true, reason: `signature valid (sha256 ${digest.slice(0, 12)}…)` } : { ok: false, reason: 'signature does NOT match — bundle may be tampered' };
  } catch (e) { return { ok: false, reason: `verify error: ${e.message}` }; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version; }
  catch { return null; }
})();

const REPO = 'stuinfla/ruvnet-brain';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_NAME = 'ruvnet-brain.zip';
// Known-good BUNDLE tag, used when we can't reach GitHub (offline / rate-limited / no releases),
// and by --pin. Default behavior is "get the latest Release"; this is only the safety net.
//
// This MUST NOT be derived from this package's own version. The installer and the brain bundle are
// two independent version streams (README: "Three independent things version separately here — by
// design"). Reading it from package.json produced a tag that has never existed — installer 1.14.0-dev
// asking for releases/download/v1.14.0-dev/ruvnet-brain.zip, which 404s, while the newest bundle
// Release is v0.5.0-dev. Verified live: v1.14.0-dev → HTTP 404, v0.5.0-dev → HTTP 200. The safety net
// was broken in exactly the situation it exists for. Bump this by hand when a new bundle ships.
const RELEASE_VERSION = 'v2.9.0'; // sync-version-ignore: the BUNDLE Release tag, not this package's version
const fallbackUrl = (tag) => `https://github.com/${REPO}/releases/download/${tag}/${ASSET_NAME}`;
const APPROX_SIZE = '~736MB';

const argv = process.argv.slice(2);
const FLAG_LOCAL = argv.includes('--local');
const FLAG_FORCE = argv.includes('--force');
const FLAG_HELP = argv.includes('--help') || argv.includes('-h');
const FLAG_DOCTOR = argv.includes('--doctor');
// `--doctor --hooks`: the post-install hook battery (ADR-053 §2 / ADR-055 build item 2). Fires every
// registration in the INSTALLED hooks.json through the real shim under four stdin regimes with an
// external process-group watchdog. Separate flag because it spawns real hooks — the plain --doctor
// stays a pure read.
const FLAG_HOOKS = argv.includes('--hooks');
const FLAG_NO_VERIFY = argv.includes('--no-verify');
// Escape hatch for the installer's closing self-check ONLY (it never disables --doctor's verdict).
const FLAG_NO_SELFCHECK = argv.includes('--no-selfcheck');
const FLAG_PIN = argv.includes('--pin'); // skip the latest-check, use the bundled default
const FLAG_DEMO = argv.includes('--demo'); // guided, real (non-fabricated) walkthrough of the brain in action
const FLAG_FEEDBACK = argv.includes('--feedback'); // prefill a GitHub Discussion (version + health, nothing private) and open it
// ── freshness flags — invoke/schedule the SELF-UPDATER the bundle already ships (kb/forge-update.mjs) ──
const FLAG_UPDATE = argv.includes('--update'); // one-shot: pull the latest Release bundle into the installed brain now
const FLAG_AUTO = argv.includes('--auto'); // with --update: also enroll in Evergreen auto-update, so it's never run by hand again
const FLAG_ENABLE_NIGHTLY = argv.includes('--enable-nightly'); // schedule that update nightly (macOS LaunchAgent)
const FLAG_DISABLE_NIGHTLY = argv.includes('--disable-nightly'); // remove the nightly schedule
const FLAG_NO_NIGHTLY_PROMPT = argv.includes('--no-nightly-prompt'); // don't offer nightly auto-updates at the end of an install
const FLAG_NO_TELEMETRY = argv.includes('--no-telemetry'); // decline anonymous usage counts without being asked
// High-impact, so it needs its OWN flag — `-y` cannot install a launchd job (see ask()'s note).
const FLAG_ENABLE_SPEND_GUARD = argv.includes('--enable-spend-guard');
const FLAG_DISABLE_SPEND_GUARD = argv.includes('--disable-spend-guard'); // the missing undo
const FLAG_UNINSTALL = argv.includes('--uninstall'); // reverse everything, in one command
const FLAG_WHAT_CHANGED = argv.includes('--what-changed'); // show our footprint on this machine
// ── onboarding-experience flags (all optional; every offer is safe to decline) ──
const FLAG_YES = argv.includes('--yes') || argv.includes('-y'); // accept every optional offer non-interactively
const FLAG_PLAN = argv.includes('--plan') || argv.includes('--dry-run'); // show the interactive checklist, then exit — install NOTHING
const FLAG_WITH_STACK = argv.includes('--with-stack'); // add missing Ruflo/RuVector without prompting
const FLAG_NO_STACK = argv.includes('--no-stack'); // skip the toolkit offer entirely
const FLAG_ENHANCE_CLAUDE_MD = argv.includes('--enhance-claude-md'); // add the CLAUDE.md section without prompting
const FLAG_NO_ENHANCE = argv.includes('--no-enhance'); // skip the CLAUDE.md offer entirely
const FLAG_STATUSLINE = argv.includes('--statusline'); // opt in to the status-bar version segment, non-interactively
const FLAG_NO_STATUSLINE = argv.includes('--no-statusline'); // decline the status-bar offer without prompting
// --version <tag> forces a specific Release tag (e.g. --version v0.5.0-dev)
const versionIdx = argv.indexOf('--version');
const FORCED_VERSION =
  versionIdx !== -1 && argv[versionIdx + 1] && !argv[versionIdx + 1].startsWith('-')
    ? argv[versionIdx + 1]
    : null;

// ── tiny narrating logger — every step says WHAT and WHY ─────────────────────────────────────────
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
let stepNo = 0;
function step(what, why) {
  stepNo += 1;
  console.log(`\n${c.cyan(`[${stepNo}]`)} ${c.bold(what)}`);
  if (why) console.log(`    ${c.dim('why: ' + why)}`);
}
const info = (s) => console.log(`    ${s}`);
const ok = (s) => console.log(`    ${c.green('✓')} ${s}`);
const warn = (s) => console.log(`    ${c.yellow('!')} ${s}`);

// Prints an unmistakable "this is RuvNet Brain, and it's running right now" banner — so a user
// never has to wonder whether the right tool is doing the work. Used by the installer, --doctor,
// and --demo alike, so every entry point identifies itself the same way.
function printBanner(subtitle) {
  const line = '─'.repeat(64);
  console.log(`\n${c.cyan(line)}`);
  console.log(`  🧠  ${c.bold(c.cyan('RuvNet Brain'))} ${c.dim('—')} ${c.bold(subtitle)}`);
  console.log(`${c.cyan(line)}`);
}

function die(msg, hint) {
  console.error(`\n${c.red('✗ install stopped:')} ${msg}`);
  if (hint) console.error(`\n${hint}`);
  console.error(
    `\nNothing is left half-installed — fix the above and re-run the same command (it's safe to re-run).`,
  );
  process.exit(1);
}

// ── shell helpers ────────────────────────────────────────────────────────────────────────────────
// On Windows, npm/claude/claude-flow/ruflo etc. are `.cmd` shims, not `.exe` binaries. Node's
// spawnSync uses CreateProcess directly (no shell:true) which CANNOT launch .cmd/.bat files — it
// fails with ENOENT even when the command works fine in any real terminal. shell:true routes the
// call through cmd.exe, which resolves .cmd shims the same way an interactive shell would.
const IS_WIN = process.platform === 'win32';
// Existence check via the OS's own PATH resolver — `where` on Windows, POSIX `command -v` elsewhere —
// NEVER by invoking the tool itself. Probing with `<cmd> --version` (the previous approach) is
// fundamentally fragile: plenty of real, correctly-installed tools don't support that exact flag and
// exit non-zero — e.g. Info-ZIP unzip exits 10 on `--version` (verified: this happens even on macOS's
// own bundled unzip, not just Debian's — same codebase), and Windows PowerShell 5.1's powershell.exe
// parses `--version` as a PowerShell expression and exits 1. Both read as "not installed" when the
// tool plainly is. Asking the OS "is this on PATH?" sidesteps every tool's own argument parsing.
function have(cmd) {
  const probe = IS_WIN
    ? spawnSync('where', [cmd], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', `command -v -- ${cmd}`], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${r.status}`);
}
function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN, ...opts });
  return !r.error && r.status === 0;
}

// ── download with redirect-following + progress ──────────────────────────────────────────────────
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'ruvnet-brain-installer', Accept: 'application/octet-stream' } },
      (res) => {
        const { statusCode = 0, headers } = res;
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          res.resume(); // drain so the socket frees up
          const next = new URL(headers.location, url).toString();
          return resolve(download(next, dest, redirects + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`server returned HTTP ${statusCode}`));
        }
        const total = Number(headers['content-length'] || 0);
        let received = 0;
        let lastShown = -1;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          const mb = (received / 1e6).toFixed(0);
          if (total) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastShown && pct % 5 === 0) {
              process.stdout.write(`\r    …${pct}% (${mb}MB / ${(total / 1e6).toFixed(0)}MB)`);
              lastShown = pct;
            }
          } else if (mb % 20 === 0 && Number(mb) !== lastShown) {
            process.stdout.write(`\r    …${mb}MB`);
            lastShown = Number(mb);
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          process.stdout.write('\n');
          resolve();
        }));
        out.on('error', (e) => reject(e));
      },
    );
    req.on('error', (e) => reject(e));
  });
}

// ── fetch a small JSON payload (redirect-following, dependency-free) ──────────────────────────────
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    const req = https.get(
      url,
      {
        headers: {
          // GitHub's API requires a User-Agent; the Accept header pins the v3 JSON schema.
          'User-Agent': 'ruvnet-brain-installer',
          Accept: 'application/vnd.github+json',
        },
        timeout: 15000,
      },
      (res) => {
        const { statusCode = 0, headers } = res;
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          res.resume();
          const next = new URL(headers.location, url).toString();
          return resolve(fetchJson(next, redirects + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`GitHub API returned HTTP ${statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`GitHub API response was not valid JSON: ${e.message}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('GitHub API request timed out')));
    req.on('error', (e) => reject(e));
  });
}

// ── step: resolve which Release to download (latest by default; safe fallback) ───────────────────
// Default behavior: ask GitHub for the LATEST Release and use its ruvnet-brain.zip asset.
// --version <tag> forces a tag; --pin skips the network check and uses the bundled known-good tag.
// Any failure (offline / rate-limited / no releases) FALLS BACK to the pinned known-good Release,
// narrated clearly so the user knows exactly what happened.
async function resolveRelease() {
  step(
    'Finding the latest brain to install',
    'so a stranger always gets the most current brain — not whatever was hardcoded when this script shipped',
  );

  if (FLAG_PIN) {
    info(`--pin set: skipping the latest-check and using the bundled known-good ${c.bold(RELEASE_VERSION)}`);
    return { tag: RELEASE_VERSION, url: fallbackUrl(RELEASE_VERSION), source: 'pinned' };
  }

  if (FORCED_VERSION) {
    info(`--version set: forcing Release ${c.bold(FORCED_VERSION)} (no latest-check)`);
    return { tag: FORCED_VERSION, url: fallbackUrl(FORCED_VERSION), source: 'forced' };
  }

  // Deterministic integration seam: stale/current behavior must not depend on GitHub API quota.
  // It is inert unless the installer's existing mutation-safe test mode is explicitly enabled.
  if (process.env.RUVNET_BRAIN_TEST === '1' && process.env.RUVNET_BRAIN_TEST_LATEST_TAG) {
    const tag = process.env.RUVNET_BRAIN_TEST_LATEST_TAG;
    info(`test mode: latest Release is ${c.bold(tag)}`);
    return { tag, url: fallbackUrl(tag), source: 'latest' };
  }

  try {
    info(`checking ${RELEASE_API} …`);
    const rel = await fetchJson(RELEASE_API);
    const tag = rel && rel.tag_name;
    if (!tag) throw new Error('latest Release has no tag_name');
    const asset = Array.isArray(rel.assets) ? rel.assets.find((a) => a.name === ASSET_NAME) : null;
    const url = asset && asset.browser_download_url ? asset.browser_download_url : fallbackUrl(tag);
    if (!asset) {
      warn(`latest Release ${tag} has no ${ASSET_NAME} asset listed — using the conventional download URL`);
    }
    ok(`latest Release is ${c.bold(tag)}`);
    return { tag, url, source: 'latest' };
  } catch (e) {
    warn(`couldn't check for the latest version (${e.message})`);
    info(`using the known-good ${c.bold(RELEASE_VERSION)} instead — the install is still safe and complete`);
    return { tag: RELEASE_VERSION, url: fallbackUrl(RELEASE_VERSION), source: 'fallback' };
  }
}

// ── step: resolve the cache dir ──────────────────────────────────────────────────────────────────
function resolveCacheDir() {
  const custom = process.env.RUVNET_BRAIN_KB;
  const cacheDir = custom || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
  step(
    'Choosing where the brain will live',
    'the Claude Code plugin looks here by default, so put it where it expects',
  );
  info(`brain dir: ${c.bold(cacheDir)}`);
  if (custom) info(`(from your RUVNET_BRAIN_KB override)`);
  fs.mkdirSync(cacheDir, { recursive: true });
  return { cacheDir, isCustom: Boolean(custom) };
}

// ── step: obtain the bundle (local or download) ──────────────────────────────────────────────────
async function obtainBundle(release) {
  const localZip = path.join(REPO_ROOT, 'dist', 'ruvnet-brain.zip');
  const localDir = path.join(REPO_ROOT, 'dist', 'ruvnet-brain');
  const haveLocal = fs.existsSync(localZip);
  const haveLocalDir = fs.existsSync(path.join(localDir, 'forge-mcp-all.mjs'));

  if (FLAG_LOCAL && !haveLocalDir) {
    die(
      `--local was passed but ${localDir} is not an assembled brain bundle.`,
      `Build it first with:  ${c.bold('node scripts/build-bundle.mjs')}  (then re-run with --local),\nor drop --local to download the published brain instead.`,
    );
  }

  if (FLAG_LOCAL) {
    step('Using the local brain bundle', 'you are running from the repo, so no download is needed');
    info(`source: ${localDir}`);
    return { sourceDir: localDir, downloaded: false };
  }

  if (haveLocal) {
    step('Using the local brain bundle', 'you are running from the repo, so no download is needed');
    info(`source: ${localZip}`);
    return { zipPath: localZip, downloaded: false };
  }

  const downloadUrl = (release && release.url) || fallbackUrl(RELEASE_VERSION);
  step(
    `Downloading the brain (${APPROX_SIZE})`,
    'the brain embeds source from dozens of RuvNet repos — too big for git, so it ships as a Release',
  );
  info(`version: ${c.bold((release && release.tag) || RELEASE_VERSION)}`);
  info(`from: ${downloadUrl}`);
  // Download into a PRIVATE, per-run temp DIR — never a predictable os.tmpdir()/ruvnet-brain-<pid>.zip
  // filename (CWE-377: a guessable path invites a pre-created or symlinked file at that location to be
  // clobbered, or the extraction target to be hijacked). mkdtempSync creates a fresh, unguessable,
  // owner-only (0700) directory; we write the zip inside it. The exit handler guarantees the whole dir
  // is removed on ANY exit — success, thrown error, or die()→process.exit — and the caller also removes
  // it immediately on success so ~512MB isn't held for the rest of the install.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-'));
  process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const tmp = path.join(tmpDir, ASSET_NAME);
  try {
    console.log(`    downloading the brain (${APPROX_SIZE})…`);
    await download(downloadUrl, tmp);
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    die(
      `couldn't download the brain (${e.message}).`,
      `Check your connection, then re-run. Or, if you have a repo clone, build the bundle locally\n(${c.bold('node scripts/build-bundle.mjs')}) and run ${c.bold('node bin/install.mjs --local')}.`,
    );
  }
  ok(`downloaded to ${tmp}`);
  // Fetch the detached Ed25519 signature published alongside the asset (SEC-0010 #6).
  // We record WHY a fetch failed rather than discarding it. Swallowing the error made two very
  // different worlds look identical: "this release genuinely has no signature" and "someone
  // 404'd/reset/stripped the .sig so verification would be skipped." The second is the whole
  // downgrade attack — strip one small file and 800MB+ of executable .mjs extracts unverified.
  let sigError = null;
  try {
    await download(`${downloadUrl}.sig`, `${tmp}.sig`);
  } catch (e) {
    sigError = e && e.message ? e.message : String(e);
  }
  return { zipPath: tmp, tmpDir, downloaded: true, sigError };
}

// ── step: unzip into the cache dir (flattening the top-level ruvnet-brain/ folder) ───────────────
//
// EXTRACTION IS NO LONGER GATED ON AN EXTERNAL BINARY (stranger-matrix, windows cells).
// The old code shelled to `unzip`, with PowerShell's Expand-Archive only as a fallback when `unzip`
// was ABSENT. That has two measured failure modes on a stranger's Windows machine:
//   · windows-powershell: no `unzip` exists at all — the fallback carried the whole install.
//   · windows-gitbash:    `unzip` IS on PATH (MSYS2 build), so the fallback never engaged, and the
//                         call died — `unzip -q -o D:\a\_temp\...\ruvnet-brain.zip -d D:\a\...`
//                         exited 1. Windows spawns go through `shell: true` here (mandatory, for
//                         .cmd shims), so native backslash paths reach a POSIX-ish tool that treats
//                         `\` as an escape. A path handed to a shell must be correct for THAT shell.
// The fix is to stop involving a shell: kb/zip-extract.mjs reads the archive in-process with
// node:zlib. Measured on macOS against a real `zip -r -y` archive, its output is byte-for-byte
// identical to `unzip -q -o` (same tree, sizes, 0755/0644 modes, symlinks preserved).
//
// ORDER IS DELIBERATE, and the non-Windows default is UNCHANGED:
//   non-win32 -> `unzip` first (byte-identical to every previous release), node:zlib as fallback
//                so a slim container without unzip now installs instead of dying.
//   win32     -> node:zlib first (no PATH lookup, no shell, no quoting), PowerShell second.
// Every attempt is recorded and, if all of them fail, ALL are printed with the exact command and
// exit code. The old message's best property — it named the precise failing command — is kept.
export function copyLocalBundleInto(sourceDir, cacheDir) {
  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir)) {
    fs.cpSync(path.join(sourceDir, entry), path.join(cacheDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    copied++;
  }
  return copied;
}

async function unzipInto(zipPath, cacheDir, sourceDir = null) {
  step(
    'Unpacking the brain into place',
    'so the plugin finds forge-mcp-all.mjs and the vector stores right where it looks',
  );

  const localCopy = async () => `local directory copy — ${copyLocalBundleInto(sourceDir, cacheDir)} top-level entries`;
  const nodeExtract = async () => {
    const { extractZip } = await import(new URL('../kb/zip-extract.mjs', import.meta.url).href);
    const r = await extractZip(zipPath, cacheDir);
    return `node:zlib — ${r.files} files, ${(r.bytes / 1e6).toFixed(1)}MB${r.crcChecked ? ', CRC verified' : ''}`;
  };
  const unzipExtract = async () => {
    if (!have('unzip')) throw new Error('`unzip` is not on PATH');
    run('unzip', ['-q', '-o', zipPath, '-d', cacheDir]);
    return 'unzip';
  };
  const psExtract = async () => {
    // PowerShell's Expand-Archive handles .zip natively with -Force for overwrite.
    // shell:false here (pwsh/powershell are real .exe files, not .cmd shims) — routing this
    // through cmd.exe would re-tokenize the already-quoted -Command string and break it.
    // -ExecutionPolicy Bypass: Expand-Archive ships as a script module (.psm1); on a locked-down
    // machine (Restricted/AllSigned policy — common in sandboxes) importing it fails with
    // "running scripts is disabled on this system" even though the exe itself runs fine. Bypass
    // only affects this one child process, not any persistent machine setting.
    const psExe = ['pwsh', 'powershell'].find(have);
    if (!psExe) throw new Error('neither `pwsh` nor `powershell` is on PATH');
    run(psExe, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${cacheDir}" -Force`,
    ], { shell: false });
    return `${psExe} Expand-Archive`;
  };

  const strategies = sourceDir
    ? [['local assembled directory', localCopy]]
    : (IS_WIN
        ? [['node:zlib (built-in)', nodeExtract], ['PowerShell Expand-Archive', psExtract]]
        : [['unzip', unzipExtract], ['node:zlib (built-in)', nodeExtract]]);

  // The zip extracts to a top-level `ruvnet-brain/` folder. Extract into the cache dir, then lift
  // its CONTENTS up one level so that cacheDir/forge-mcp-all.mjs exists (idempotent: overwrites).
  const failures = [];
  let extractedBy = null;
  for (const [label, attempt] of strategies) {
    try { extractedBy = await attempt(); break; }
    catch (e) { failures.push(`  • ${label}: ${(e && e.message) || e}`); }
  }
  if (!extractedBy) {
    die(
      `extraction failed — every available method was tried and each one is reported below.\n${failures.join('\n')}`,
      [
        `The archive may be incomplete or corrupt — re-run to download a fresh copy.`,
        `If it keeps failing, one of these gives the same job to a tool you control:`,
        `  • macOS/Linux:  ${c.bold(`unzip -o "${zipPath}" -d "${cacheDir}"`)}`,
        `  • Windows:  ${c.bold(`Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${cacheDir}" -Force`)}`,
      ].join('\n'),
    );
  }
  if (failures.length) warn(`extracted via ${extractedBy} after ${failures.length} method(s) failed:\n${failures.join('\n')}`);

  const nested = path.join(cacheDir, 'ruvnet-brain');
  if (fs.existsSync(path.join(nested, 'forge-mcp-all.mjs'))) {
    for (const entry of fs.readdirSync(nested)) {
      const from = path.join(nested, entry);
      const to = path.join(cacheDir, entry);
      fs.rmSync(to, { recursive: true, force: true }); // idempotent overwrite
      fs.renameSync(from, to); // same filesystem → cheap rename
    }
    fs.rmdirSync(nested);
  }

  // An update is a replacement, not an overlay. Before this prune existed, installing a public
  // bundle over a KB that once contained private stores left every omitted `.rvf` and passages file
  // behind. discoverRepos() then served those stale stores as if they were part of the new bundle.
  // Only repo-artifact families are touched; reader deps, local logs, preferences, and unrelated
  // files remain byte-for-byte.
  const pruned = pruneUnlistedStores(cacheDir);
  if (pruned.length) {
    warn(`pruned ${pruned.length} stale repo artifact file(s) omitted by this bundle: ${[...new Set(pruned.map((p) => p.repo))].join(', ')}`);
  }

  if (!fs.existsSync(path.join(cacheDir, 'forge-mcp-all.mjs'))) {
    die(
      `the brain unpacked but forge-mcp-all.mjs is missing from ${cacheDir}.`,
      `The archive layout may have changed. Re-run, or report this at https://github.com/stuinfla/ruvnet-brain/issues`,
    );
  }
  ok(`brain unpacked to ${cacheDir}`);
}

export function pruneUnlistedStores(cacheDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'));
    const allowed = new Set((manifest.builtRepos || []).map((r) => String(r?.name || '')).filter(Boolean));
    if (manifest.conceptsStore?.store) allowed.add(String(manifest.conceptsStore.store).replace(/\.big\.rvf$|\.rvf$/, ''));
    // ruv-gists is a separately assembled provenance store, not a registry builtRepo.
    if (fs.existsSync(path.join(cacheDir, 'ruv-gists.rvf')) || fs.existsSync(path.join(cacheDir, 'ruv-gists.big.rvf'))) {
      allowed.add('ruv-gists');
    }
    if (!allowed.size) return [];

    const presentRepos = new Set();
    for (const entry of fs.readdirSync(cacheDir)) {
      const m = /^(.*?)(?:\.big)?\.rvf$/.exec(entry);
      if (m?.[1] && /^[A-Za-z0-9._-]+$/.test(m[1])) presentRepos.add(m[1]);
      const primer = /^(.*)-primer\.md$/.exec(entry);
      if (primer?.[1] && /^[A-Za-z0-9._-]+$/.test(primer[1])) presentRepos.add(primer[1]);
    }
    const stale = [...presentRepos].filter((repo) => !allowed.has(repo));
    const removed = [];
    for (const repo of stale) {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry !== repo && entry !== `${repo}-primer.md` && !entry.startsWith(`${repo}.`)) continue;
        fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
        removed.push({ repo, entry });
      }
    }
    return removed;
  } catch {
    // A missing/corrupt manifest is already a verification failure. Never guess what to delete.
    return [];
  }
}

// ── step: install the reader deps ────────────────────────────────────────────────────────────────
function installReader(cacheDir) {
  step(
    'Installing the local reader',
    'the brain reads its vectors with @ruvector/rvf and reranks with a local model — no cloud calls',
  );
  if (!have('npm')) {
    die(`\`npm\` isn't available, but the brain needs it for its reader.`, `Install Node.js (which includes npm) and re-run.`);
  }
  info('installing the local reader…');
  // Prefer `npm ci` for a PINNED, reproducible install when the bundle shipped its lockfile
  // (SEC-0010 #8 — otherwise every install did a fully unpinned resolve). Fall back to `npm i`
  // for older bundles that predate the shipped lockfile.
  const hasLock = fs.existsSync(path.join(cacheDir, 'package-lock.json'));
  const npmArgs = hasLock
    ? ['ci', '--no-audit', '--no-fund', '--loglevel=error']
    : ['i', '--no-audit', '--no-fund', '--loglevel=error'];
  try {
    run('npm', npmArgs, {
      cwd: cacheDir,
      // silence npm's "new version available" update-notifier so the narration stays clean
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    });
  } catch (e) {
    // `npm ci` is strict (fails if lock and package.json disagree); fall back to `npm i` once
    // rather than hard-failing a user's install on a lockfile mismatch.
    if (hasLock) {
      warn(`pinned install (npm ci) failed (${e.message}); retrying with npm i`);
      try {
        run('npm', ['i', '--no-audit', '--no-fund', '--loglevel=error'], {
          cwd: cacheDir, env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
        });
      } catch (e2) {
        die(`the reader install failed (${e2.message}).`, `Re-run after checking your network / npm setup.`);
      }
    } else {
      die(`the reader install failed (${e.message}).`, `Re-run after checking your network / npm setup.`);
    }
  }
  ok('reader installed');
}

// ── plugin presence: the ONLY reliable proof the slash commands will exist ───────────────────────
// Reported by a user on 3.4.21-dev whose install was otherwise healthy: `/rvbc` returned
// "Unknown command: /rvbc. Did you mean /rvf?". search_ruvnet worked, the KB was current — the
// plugin had simply never landed, and the installer had said everything was fine.
//
// The brain ships as TWO independent artifacts and this is the one people lose:
//   • KB + search_ruvnet  — installed by this script into ~/.cache/ruvnet-brain
//   • the Claude Code plugin — slash commands, the Console, the grounding hook
// Checking the commands directory on disk is what distinguishes them; a `claude plugin install`
// exit code does not.
/** @returns {string|null} the commands dir if the plugin is really installed, else null */
function pluginCommandsDir() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin', 'commands'),
    path.join(os.homedir(), '.claude', 'plugins', 'ruvnet-brain', 'commands'),
  ];
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'rvbc.md'))) return dir; } catch { /* unreadable — treat as absent */ }
  }
  return null;
}

// ── step: wire the Claude Code plugin ────────────────────────────────────────────────────────────
function wirePlugin() {
  step(
    'Wiring the Claude Code plugin',
    'this registers search_ruvnet + the grounding hook so Claude uses the brain automatically',
  );
  const manualMarketplace = 'claude plugin marketplace add stuinfla/ruvnet-brain';
  const manualInstall = 'claude plugin install ruvnet-brain@ruvnet-brain --scope user';

  if (!have('claude')) {
    warn(`I couldn't run the \`claude\` command from this shell.`);
    info(`That's normal if you use Claude Code as the ${c.bold('VS Code extension')} or ${c.bold('desktop app')} — the`);
    info(`command just isn't on your terminal's PATH. ${c.green('The brain itself is fully downloaded.')}`);
    info(`Finish wiring in ~20s — paste these two into ${c.bold("Claude Code's integrated terminal")} (or any shell with \`claude\`):`);
    info(`  ${c.bold(manualMarketplace)}`);
    info(`  ${c.bold(manualInstall)}`);
    info(`Then reopen Claude Code once. ${c.dim('Or simply open Claude Code and ask: “finish setting up the RuvNet Brain.”')}`);
    return { wired: false, manualMarketplace, manualInstall };
  }

  const addedMarket = tryRun('claude', ['plugin', 'marketplace', 'add', 'stuinfla/ruvnet-brain']);
  // Deliberately NOT reassuring here. This used to say "it may already be added — that's fine",
  // which is a GUESS about someone else's machine, and when it was wrong the user finished the
  // install with a working search_ruvnet, no slash commands, and a message telling them all was
  // well. The real state is checked below; nothing is declared fine until it has been looked at.
  if (!addedMarket) info(`marketplace add didn't report success — checking what actually landed…`);

  tryRun('claude', ['plugin', 'install', 'ruvnet-brain@ruvnet-brain', '--scope', 'user']);

  // NEVER take "installed" on faith — same discipline verifyInstall() applies to the KB. An exit
  // code says the command ran, not that the plugin is usable; the commands either exist on disk or
  // they do not. This is the difference between `/rvbc` working and "Unknown command: /rvbc".
  const commandsDir = pluginCommandsDir();
  if (commandsDir) {
    ok('plugin installed at user scope (global, alongside Ruflo / RuVector)');
    info(`  commands available after a restart: ${c.bold('/rvbc')}, ${c.bold('/ruvnet-brain:configure')}`);
    return { wired: true, manualMarketplace, manualInstall };
  }

  // The honest failure. The brain still WORKS — this is the difference between a broken install and
  // a partial one, and the user is told exactly which they have instead of being congratulated.
  warn(`the plugin did NOT land — so slash commands like ${c.bold('/rvbc')} will not exist yet.`);
  info(`${c.green('Your brain still works')}: search_ruvnet is wired and Claude will ground answers with it.`);
  info(`Only the plugin extras (slash commands, the Console, the grounding hook) are missing.`);
  info(`Run these two yourself to finish:`);
  info(`  ${c.bold(manualMarketplace)}`);
  info(`  ${c.bold(manualInstall)}`);
  return { wired: false, manualMarketplace, manualInstall };
}

// ── step: wire the Codex host (issue #42, Henrik Pettersen) ──────────────────────────────────────
// We shipped a .codex/ directory AND a working MCP server and never wired them together, so on a
// Codex host the brain was entirely absent — no search_ruvnet at all. Every artifact was present;
// only the registration was missing. Codex reads its MCP servers from ~/.codex/config.toml, which is
// the USER's file and already carries their own settings, so this MERGES and never rewrites wholesale.
//
// Two rules make that merge safe:
//   1. Our lines live inside a comment-delimited managed block, so a reinstall rewrites exactly
//      those bytes and leaves every other section byte-identical.
//   2. An [mcp_servers.ruvnet-brain] found OUTSIDE our markers is the user's, not ours — we report
//      it and touch nothing. Their hand-written config outranks our convenience.
//
// The registered path must also OUTLIVE the install. The npx checkout is ephemeral (the same reason
// the spend watchdog and the router tools get copied under ~/.claude). The MCP shell and its one
// local structured-interface module use node builtins only; both are copied to a persistent home and
// THAT absolute server path is registered. Registering the npx dir would rot when the temp dir vanished.
const CODEX_BLOCK_START = '# --- ruvnet-brain (managed block, installer-rewritten) ---';
const CODEX_BLOCK_END = '# --- end ruvnet-brain ---';
const codexHomeDir = () => path.join(os.homedir(), '.codex');
const codexConfigPath = () => path.join(codexHomeDir(), 'config.toml');
const codexServerDir = () => path.join(os.homedir(), '.claude', 'ruvnet-brain', 'mcp');
const codexHookWrapperPath = (codexDir = codexHomeDir()) =>
  path.join(path.dirname(codexDir), '.cache', 'ruvnet-brain', 'codex-hook.mjs');

// The exact bytes we own. Kept in one place so the writer and the doctor probe can never disagree.
function codexManagedBlock(serverPath) {
  return [
    CODEX_BLOCK_START,
    '# Written by `npx ruvnet-brain`. This block is rewritten on every reinstall;',
    '# everything outside the two markers is yours and is never touched.',
    '[mcp_servers.ruvnet-brain]',
    'command = "node"',
    `args = [${JSON.stringify(serverPath)}]`,
    CODEX_BLOCK_END,
  ].join('\n');
}

// Pure, so the merge contract is testable without going near a real ~/.codex. Returns the new text
// plus which of the three things happened, and is idempotent: re-running over its own output
// reproduces it byte for byte.
export function mergeCodexConfig(existing, serverPath) {
  const text = typeof existing === 'string' ? existing : '';
  const block = codexManagedBlock(serverPath);
  const start = text.indexOf(CODEX_BLOCK_START);
  const end = text.indexOf(CODEX_BLOCK_END);
  if (start !== -1 && end > start) {
    return { text: text.slice(0, start) + block + text.slice(end + CODEX_BLOCK_END.length), action: 'rewritten' };
  }
  // Their own declaration, outside our markers. Never clobber a user's hand-written server entry.
  if (/^[ \t]*\[mcp_servers\.(?:ruvnet-brain|"ruvnet-brain"|'ruvnet-brain')\]/m.test(text)) {
    return { text, action: 'user-owned' };
  }
  const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${sep}${block}\n`, action: 'added' };
}

// What the doctor asserts from disk — never from the fact that we once ran. "Wired" means our entry
// is in the config AND the server.mjs it points at is really there, because a registration pointing
// at a deleted file is worse than no registration: Codex fails at spawn time with nothing to read.
export function codexStatus({ configPath = codexConfigPath(), codexDir = codexHomeDir() } = {}) {
  let host = false;
  try { host = fs.existsSync(codexDir); } catch { /* unreadable — treat as absent */ }
  if (!host) return { host: false, wired: false, serverPath: null, serverExists: false };
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { /* no config yet */ }
  const m = /^[ \t]*\[mcp_servers\.(?:ruvnet-brain|"ruvnet-brain"|'ruvnet-brain')\][^[]*?args\s*=\s*\[\s*"([^"]+)"/m.exec(text);
  const serverPath = m ? m[1] : null;
  let serverExists = false;
  try { serverExists = serverPath ? fs.existsSync(serverPath) : false; } catch { /* unreadable */ }
  return { host: true, wired: Boolean(serverPath) && serverExists, serverPath, serverExists };
}

// Atomic file replacement: produce the new bytes BESIDE the target, then rename() over it. Against
// process interruption (the issue #43 scenario) either the old file or the complete new file
// exists — never a torn write. (Power-loss durability — fsync of file and directory — is
// deliberately out of scope for a config write.) On failure the temp is removed and the target is
// untouched; same-directory rename keeps it on one filesystem.
//
// rename() swaps INODES, so two properties of the old write-through path must be carried over
// explicitly: a symlinked target (a dotfiles-managed ~/.codex/config.toml) is resolved to its real
// file so the link survives and the bytes land where the user keeps them, and the target's mode is
// re-applied so a chmod-600 config never comes back world-readable.
function atomicReplace(targetPath, writeTmp) {
  let target = targetPath;
  try { target = fs.realpathSync(targetPath); } catch { /* target doesn't exist yet */ }
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* first write — default mode is fine */ }
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeTmp(tmp);
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true, recursive: true }); } catch { /* best effort */ }
    throw e;
  }
}

export function wireCodexHost({
  codexDir = codexHomeDir(),
  configPath = path.join(codexDir, 'config.toml'),
  serverDir = codexServerDir(),
  source = path.join(__dirname, '..', 'plugin', 'mcp', 'server.mjs'),
  hookWrapperSource = path.join(__dirname, '..', 'plugin', 'scripts', 'codex-hook-wrapper.mjs'),
  hookWrapperPath = codexHookWrapperPath(codexDir),
  announce = true,
} = {}) {
  let host = false;
  try { host = fs.existsSync(codexDir); } catch { /* unreadable — treat as absent */ }
  // No Codex on this machine is not a warning. Say nothing and change nothing.
  if (!host) return { host: false, action: 'no-host' };

  if (announce) {
    step('Wiring the Codex host', 'Codex reads MCP servers from ~/.codex/config.toml — the brain was never registered there');
  }
  if (!fs.existsSync(source)) {
    if (announce) warn('MCP server missing from this bundle — Codex left untouched (non-fatal)');
    return { host: true, action: 'no-source' };
  }
  const managedCliSource = path.join(path.dirname(source), 'managed-cli-interface.mjs');
  if (!fs.existsSync(managedCliSource)) {
    if (announce) warn('MCP structured-interface module missing from this bundle — Codex left untouched (non-fatal)');
    return { host: true, action: 'no-source' };
  }
  const serverPath = path.join(serverDir, 'server.mjs');
  const managedCliPath = path.join(serverDir, 'managed-cli-interface.mjs');
  fs.mkdirSync(serverDir, { recursive: true });
  // Write-beside-then-rename, both here and for the config below (issue #43): an interrupted plain
  // copy leaves a TORN server.mjs at the exact path a prior install's config already points at, so
  // Codex spawns half a file. rename() over the target is atomic; a failure leaves the old bytes.
  // Copy the dependency first. If the later server swap fails, the previously registered server
  // remains byte-intact and continues to import a backward-compatible module at the same path.
  atomicReplace(managedCliPath, (tmp) => fs.copyFileSync(managedCliSource, tmp));
  atomicReplace(serverPath, (tmp) => fs.copyFileSync(source, tmp));
  if (fs.existsSync(hookWrapperSource)) {
    fs.mkdirSync(path.dirname(hookWrapperPath), { recursive: true });
    atomicReplace(hookWrapperPath, (tmp) => fs.copyFileSync(hookWrapperSource, tmp));
  }

  let before = '';
  try { before = fs.readFileSync(configPath, 'utf8'); } catch { /* first run — no config yet */ }
  const { text, action } = mergeCodexConfig(before, serverPath);
  if (action === 'user-owned') {
    if (announce) {
      ok('Codex already declares ruvnet-brain in your own config — left exactly as you wrote it');
      info(`  to hand it to us instead, delete that ${c.bold('[mcp_servers.ruvnet-brain]')} block and re-run this installer`);
    }
    return { host: true, action, serverPath, managedCliPath, hookWrapperPath };
  }
  if (text !== before) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicReplace(configPath, (tmp) => fs.writeFileSync(tmp, text));
  }
  if (announce) {
    ok(`search_ruvnet registered for Codex → ${c.bold(configPath)}`);
    info(`  server: ${serverPath} ${c.dim('(persistent copy — the npx dir vanishes)')}`);
    info(`  ${c.dim('only our marked block is written; every other section is byte-preserved')}`);
  }
  return { host: true, action, serverPath, managedCliPath, hookWrapperPath, changed: text !== before };
}

const CODEX_PLUGIN_ID = 'ruvnet-brain@ruvnet-brain';
const CODEX_MARKETPLACE = 'ruvnet-brain';
const CODEX_MARKETPLACE_SOURCE = 'stuinfla/ruvnet-brain';

// Codex 0.145 returns `{ marketplaces: [...] }`; early preview builds returned the array itself.
// Keep both shapes so an installer update never turns a harmless host-version difference into a
// repeated "marketplace already exists" failure.
export function codexMarketplaceRows(value) {
  if (Array.isArray(value?.marketplaces)) return value.marketplaces;
  return Array.isArray(value) ? value : [];
}

function runCodexJson(args, {
  codexBin = process.env.CODEX_BIN || 'codex',
  codexHome = codexHomeDir(),
  cwd = process.cwd(),
} = {}) {
  const r = spawnSync(codexBin, args, {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    const detail = String(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim();
    return { ok: false, error: detail };
  }
  try { return { ok: true, value: JSON.parse(r.stdout || 'null') }; }
  catch { return { ok: false, error: `Codex returned non-JSON output for ${args.join(' ')}` }; }
}

export function codexPluginStatus(options = {}) {
  const { runJson = runCodexJson, ...commandOptions } = options;
  const listed = runJson(['plugin', 'list', '--json'], commandOptions);
  if (!listed.ok) return { available: false, installed: false, enabled: false, error: listed.error };
  const rows = Array.isArray(listed.value?.installed) ? listed.value.installed : [];
  const row = rows.find((candidate) => candidate?.pluginId === CODEX_PLUGIN_ID);
  return {
    available: true,
    installed: Boolean(row?.installed),
    enabled: Boolean(row?.enabled),
    version: row?.version || null,
    row: row || null,
  };
}

export function wireCodexPlugin({
  codexDir = codexHomeDir(),
  codexHome = codexDir,
  codexBin = process.env.CODEX_BIN || 'codex',
  marketplaceSource = CODEX_MARKETPLACE_SOURCE,
  expectedVersion = PACKAGE_VERSION,
  cwd = process.cwd(),
  announce = true,
  runJson = runCodexJson,
} = {}) {
  if (!fs.existsSync(codexDir)) return { host: false, action: 'no-host' };
  const options = { codexBin, codexHome, cwd };
  const before = codexPluginStatus({ ...options, runJson });
  if (!before.available) {
    if (announce) warn(`Codex plugin lifecycle not installed — ${before.error}`);
    return { host: true, action: 'codex-unavailable', ...before };
  }
  if (before.installed && !before.enabled) {
    if (announce) warn(`Codex Brain plugin is installed but disabled by user or policy — left disabled (${CODEX_PLUGIN_ID}).`);
    return { host: true, action: 'disabled', ...before };
  }
  if (before.installed && before.enabled && (!expectedVersion || before.version === expectedVersion)) {
    if (announce) ok(`Codex Brain plugin already installed and enabled (${before.version || 'version unknown'}) — no changes.`);
    return { host: true, action: 'unchanged', ...before };
  }

  const markets = runJson(['plugin', 'marketplace', 'list', '--json'], options);
  if (!markets.ok) {
    if (announce) warn(`Codex marketplace check failed — ${markets.error}`);
    return { host: true, action: 'marketplace-check-failed', error: markets.error };
  }
  const marketRows = codexMarketplaceRows(markets.value);
  const known = marketRows.some((market) => market?.name === CODEX_MARKETPLACE);
  const marketAction = known
    ? runJson(['plugin', 'marketplace', 'upgrade', CODEX_MARKETPLACE, '--json'], options)
    : runJson(['plugin', 'marketplace', 'add', marketplaceSource, '--json'], options);
  if (!marketAction.ok) {
    if (announce) warn(`Codex marketplace ${known ? 'upgrade' : 'add'} failed — ${marketAction.error}`);
    return { host: true, action: 'marketplace-failed', error: marketAction.error };
  }
  const added = runJson(['plugin', 'add', CODEX_PLUGIN_ID, '--json'], options);
  if (!added.ok) {
    if (announce) warn(`Codex plugin install failed — ${added.error}. The prior MCP registration remains intact.`);
    return { host: true, action: 'plugin-failed', error: added.error };
  }
  const after = codexPluginStatus({ ...options, runJson });
  if (!after.installed || !after.enabled) {
    if (announce) warn('Codex accepted the install command but the Brain plugin is not installed and enabled.');
    return { host: true, action: 'verification-failed', ...after };
  }
  if (announce) {
    ok(`Codex Brain plugin installed and enabled (${after.version || 'version unknown'}).`);
  }
  return { host: true, action: before.installed ? 'updated' : 'installed', ...after };
}

function codexHooksList({
  codexBin = process.env.CODEX_BIN || 'codex',
  codexHome = codexHomeDir(),
  cwd = process.cwd(),
  timeoutMs = 8_000,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      resolve(value);
    };
    const child = spawn(codexBin, ['app-server'], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => finish({ ok: false, error: `Codex hooks probe timed out after ${timeoutMs}ms` }), timeoutMs);
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ method: 'hooks/list', id: 2, params: { cwds: [cwd] } })}\n`);
        } else if (message.id === 2) {
          finish(message.error
            ? { ok: false, error: message.error.message || JSON.stringify(message.error) }
            : { ok: true, value: message.result });
        }
      }
    });
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: stderr.trim() || `Codex app-server exited ${code} before hooks/list` });
    });
    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'ruvnet_brain_doctor', title: 'RuvNet Brain Doctor', version: PACKAGE_VERSION || '0' } },
    })}\n`);
  });
}

export function classifyCodexLifecycle(plugin, listed = null) {
  if (!plugin.available) return { state: 'probe-failed', plugin, hooks: [], error: plugin.error };
  if (!plugin.installed) return { state: 'not-installed', plugin, hooks: [] };
  if (!plugin.enabled) return { state: 'disabled', plugin, hooks: [] };
  if (!listed.ok) return { state: 'probe-failed', plugin, hooks: [], error: listed.error };
  const groups = Array.isArray(listed.value?.data) ? listed.value.data : [];
  const hooks = groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter((hook) => hook?.pluginId === CODEX_PLUGIN_ID);
  const errors = groups.flatMap((group) => Array.isArray(group?.errors) ? group.errors : []);
  if (errors.length || hooks.length === 0) {
    return { state: 'missing-runtime-hooks', plugin, hooks, errors };
  }
  if (hooks.some((hook) => hook.enabled === false)) return { state: 'disabled', plugin, hooks, errors };
  if (hooks.every((hook) => hook.trustStatus === 'trusted')) return { state: 'active', plugin, hooks, errors };
  return { state: 'pending-trust', plugin, hooks, errors };
}

export async function codexLifecycleStatus(options = {}) {
  const plugin = codexPluginStatus(options);
  if (!plugin.available || !plugin.installed || !plugin.enabled) {
    return classifyCodexLifecycle(plugin);
  }
  return classifyCodexLifecycle(plugin, await codexHooksList(options));
}

export function codexLifecycleGuidance(status) {
  const hookCount = Array.isArray(status?.hooks) ? status.hooks.length : 0;
  switch (status?.state) {
    case 'active':
      return {
        healthy: true,
        intentional: false,
        summary: `Codex lifecycle active (${hookCount} Brain hook${hookCount === 1 ? '' : 's'} enabled and trusted).`,
        detail: 'Proactive grounding, routing, learning capture, and session continuity are on.',
        action: null,
      };
    case 'pending-trust':
      return {
        healthy: false,
        intentional: false,
        summary: `Codex installed the Brain, but ${hookCount || 'its'} lifecycle hook${hookCount === 1 ? '' : 's'} await review.`,
        detail: 'Search works now; proactive interventions start after Codex records hook trust.',
        action: `Start a fresh Codex session, run /hooks, and trust only ${CODEX_PLUGIN_ID}.`,
      };
    case 'disabled':
      return {
        healthy: false,
        intentional: true,
        summary: 'Codex Brain lifecycle is disabled.',
        detail: 'The installer preserved your explicit disabled state instead of silently overriding it.',
        action: null,
      };
    case 'not-installed':
      return {
        healthy: false,
        intentional: false,
        summary: 'Codex can reach the Brain MCP, but the proactive lifecycle plugin is not installed.',
        detail: 'Questions can still be grounded; automatic routing, learning, and session guidance are inactive.',
        action: 'Run npx ruvnet-brain to install and verify the Codex lifecycle plugin.',
      };
    case 'missing-runtime-hooks':
      return {
        healthy: false,
        intentional: false,
        summary: 'Codex has the Brain plugin, but its runtime hooks are missing or invalid.',
        detail: Array.isArray(status?.errors) && status.errors.length
          ? status.errors.map(String).join('; ')
          : 'The installed plugin snapshot did not produce runnable lifecycle definitions.',
        action: `Run codex plugin marketplace upgrade ${CODEX_MARKETPLACE}, then npx ruvnet-brain.`,
      };
    default:
      return {
        healthy: false,
        intentional: false,
        summary: 'Codex lifecycle status could not be verified.',
        detail: status?.error || 'Codex did not return a lifecycle status.',
        action: 'Run npx ruvnet-brain --doctor after confirming codex is on PATH.',
      };
  }
}

function printCodexLifecycle(status) {
  const guidance = codexLifecycleGuidance(status);
  console.log(`  ${guidance.healthy ? c.green('✓') : guidance.intentional ? c.dim('○') : c.yellow('!')} ${guidance.summary}`);
  if (guidance.detail) console.log(`    ${guidance.detail}`);
  if (guidance.action) console.log(`    ${c.bold(`Fix: ${guidance.action}`)}`);
  return guidance;
}

// ── step: verify the install is REAL (counts — never take "installed" on faith) ──────────────────
// Shared state-gatherer behind verifyInstall / --doctor / --feedback: what is REALLY on disk.
// Pure read, never prints — callers decide how to narrate (or, for --feedback, how to report) it.
function gatherInstallState(cacheDir) {
  let repos = 0;
  try {
    repos = fs
      .readdirSync(cacheDir)
      .filter((f) => f.endsWith('.rvf')).length;
  } catch {
    /* ignore */
  }
  return {
    repos,
    // A bare node_modules dir is not enough — on 2026-07-12 the dir test passed conceptually while
    // the embedder was gone and every search failed. Check the two load-bearing packages directly.
    reader:
      fs.existsSync(path.join(cacheDir, 'node_modules', '@xenova', 'transformers', 'package.json'))
      && fs.existsSync(path.join(cacheDir, 'node_modules', '@ruvector')),
    mcp: fs.existsSync(path.join(cacheDir, 'forge-mcp-all.mjs')),
  };
}

function verifyInstall(cacheDir) {
  step(
    'Verifying the brain is real and reachable',
    "you should never have to trust the word \"installed\" — here's the proof on disk",
  );
  const { repos, reader, mcp } = gatherInstallState(cacheDir);
  if (repos > 0) ok(`${repos} RuvNet repos indexed (vector stores present on disk)`);
  else warn(`no .rvf stores found in ${cacheDir} — the brain may be incomplete (re-run with --force)`);

  if (reader) ok('local reader installed (vector reads happen offline — no cloud, no API key)');
  else warn(`reader deps missing — every search WILL fail until fixed: cd ${cacheDir} && npm i`);

  if (mcp) ok('search_ruvnet server present (this is what Claude calls to ground answers)');
  else warn('forge-mcp-all.mjs missing — the brain unpacked incompletely');

  // Plugin presence is part of "what is really on disk" — it is the difference between `/rvbc`
  // working and "Unknown command". A user whose plugin never landed had no way to see that.
  const plugin = pluginCommandsDir() !== null;
  return { repos, reader, mcp, plugin };
}

// ── step: warm the model + prove grounding with one real question (best-effort, never fatal) ──────
// The verifier ships as a real file (kb/verify-citation.mjs, in package.json files[]).
// It used to live here as a ~4KB base64 literal that was decoded at runtime, written to disk as
// .mjs, and then dynamically imported. That is the canonical staged-payload chain, and EDR
// behavioural engines score write-then-execute on a just-created file as high-confidence dropper
// activity — a benign explanation that arrives only AFTER the alarm. Copying a file we shipped is
// the same capability with none of the signature. (base64 was originally chosen to dodge escaping
// bugs — the module contains backticks, ${...} and backslashes — which shipping a file also solves.)

// The verifier belongs next to the data it verifies, so it lives in the KB. But every bundle
// published before 2026-07-09 predates it, and telling those users "grounding not verifiable —
// re-run the installer" would send them in a circle, because re-running fetches the same bundle.
// So the installer CARRIES the verifier and writes it in when it's missing. A newer bundle's copy
// always wins: we never overwrite a file the bundle shipped.
function ensureVerifier(cacheDir) {
  const p = path.join(cacheDir, 'verify-citation.mjs');
  if (fs.existsSync(p)) return 'from-bundle';
  const shipped = path.join(REPO_ROOT, 'kb', 'verify-citation.mjs');
  if (!fs.existsSync(shipped)) return 'unavailable';
  try {
    fs.copyFileSync(shipped, p);
    return 'installed';
  } catch { return 'unavailable'; }
}

async function loadCitationVerifier(cacheDir) {
  ensureVerifier(cacheDir);
  const p = path.join(cacheDir, 'verify-citation.mjs');
  if (!fs.existsSync(p)) return null;
  try { return await import(pathToFileURL(p).href); } catch { return null; }
}

// Proving grounding means proving the answer's CITATION RESOLVES — that the file it points at is a
// real, indexed passage on this disk. The old check here tested `/rvf|ruvector|hnsw/` against the
// answer text, which a hallucinated "just use RVF!" passes with zero sources. Keyword presence is
// not evidence. We now print the cited path as a receipt, so you can go look at it yourself.
export function resolveRuntimeModelCache(env = process.env, home = os.homedir()) {
  if (env.KB_MODEL_CACHE) return env.KB_MODEL_CACHE;
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  return path.join(brainHome, 'models');
}

async function smokeQuery(cacheDir) {
  const ask = path.join(cacheDir, 'forge-ask-all.mjs');
  if (!fs.existsSync(ask)) return { ran: false };
  step(
    'Asking the brain a real question',
    'this warms the local model so your first real answer is instant — and proves grounding works end to end',
  );
  const Q = 'How should I store embeddings in this project without running a server?';
  info(`Q: ${c.cyan(`"${Q}"`)}`);
  info(c.dim('(first run downloads a small local model once — this can take a minute)'));
  const started = Date.now();
  let r;
  try {
    // Relative filename + matching cwd (NOT the absolute `ask` path) — forge-ask-all.mjs only runs
    // its CLI main() when `path.resolve(process.argv[1]) === path.resolve(__filename)`; passed as an
    // absolute path via spawnSync (no shell involved) that identity check silently fails on this
    // machine, so main() never runs — exit 0, zero stdout, zero stderr, no exception. Looks like a
    // clean success; is actually a total no-op. Verified: switching to a relative name + cwd fixes it.
    r = spawnSync('node', ['forge-ask-all.mjs', '--dir', cacheDir, '--q', Q, '--k', '3'], {
      cwd: cacheDir,
      encoding: 'utf8',
      timeout: 240000,
      // The stable MCP shell sets this exact default before spawning its worker. Passing the same
      // path here makes the install smoke warm the model cache the product will actually reopen,
      // instead of a second kb-local cache that can go green while the real door stays cold.
      env: { ...process.env, KB_MODEL_CACHE: resolveRuntimeModelCache() },
    });
  } catch {
    warn("skipped the live test (couldn't launch the reader) — it'll warm on your first real question");
    return { ran: false };
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const out = `${r.stdout || ''}`;
  if (r.status !== 0 || !out.trim()) {
    warn('no answer came back (first-run model download or offline) — the brain is installed; it\'ll warm on your first real question');
    // SHOW THE ACTUAL ERROR (issue #37 bug 2, Agentist-Elder, 2026-07-21).
    //
    // This captured stderr and then threw it away, so every hard failure — a crash, a missing
    // module, a bad model path — arrived looking identical to a slow first-run download. That is
    // exactly how a total grounding outage (a static import of a module missing from the bundle,
    // crashing before any model code ran) presented as the reassuring line above and cost the
    // reporter a full debugging session to attribute. Their words, and they are right: this
    // wrapper "will hide the *next* breakage too, whatever it is."
    //
    // A diagnostic that discards the diagnosis is worse than no diagnostic, because it reads as
    // information. Print it. Truncated, because a stack trace is not a friendly install screen —
    // but never hidden.
    const err = `${r.stderr || ''}`.trim();
    if (err) {
      const lines = err.split('\n');
      info(c.dim('  the reader reported:'));
      for (const line of lines.slice(0, 12)) info(c.dim(`    ${line.slice(0, 200)}`));
      if (lines.length > 12) info(c.dim(`    … ${lines.length - 12} more line(s)`));
    }
    return { ran: true, grounded: false, reason: 'no-answer', stderr: err.slice(0, 4000) };
  }

  const verifier = await loadCitationVerifier(cacheDir);
  if (!verifier) {
    info(`the brain answered in ${secs}s, but this bundle predates the citation verifier —`);
    info(c.dim('  re-run `npx ruvnet-brain` to refresh it, and grounding will be PROVEN, not assumed'));
    return { ran: true, grounded: null, reason: 'verifier-missing' };
  }

  const v = await verifier.verifyGrounding(out, cacheDir);
  if (v.grounded) {
    ok(`grounded in rUv's real source — verified in ${secs}s, not guessed ✦`);
    console.log(`      ${c.dim('cited:')}    ${c.bold(v.receipt.path)}`);
    if (v.receipt.title) console.log(`      ${c.dim('title:')}    ${v.receipt.title}`);
    console.log(`      ${c.dim('verified:')} that passage really exists in ${c.bold(v.receipt.file)}`);
    return { ran: true, grounded: true, receipt: v.receipt, secs };
  }
  warn(
    v.reason === 'no-citations'
      ? 'the answer cited no source at all — NOT grounded (re-run the installer to repair the KB)'
      : "the answer's citations don't resolve to any indexed passage — NOT grounded (KB may be corrupt; re-run the installer)",
  );
  return { ran: true, grounded: false, reason: v.reason };
}

// ── `--demo`: a guided, REAL walkthrough — proves grounding live, never fabricates output ─────────
const DEMO_QUESTIONS = [
  {
    q: 'How should I store embeddings in this project without running a server?',
    why: 'shows the brain reaching for RuVector/RVF — a single local file — instead of Pinecone or pgvector',
  },
  {
    q: 'How do I orchestrate multiple agents working on a task in parallel?',
    why: 'shows it grounding in Ruflo (the real orchestration engine) instead of guessing at a generic pattern',
  },
];
async function runDemo() {
  printBanner('demo');
  const cacheDir = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
  const ask = path.join(cacheDir, 'forge-ask-all.mjs');
  if (!fs.existsSync(ask)) {
    warn(`no brain found at ${cacheDir}.`);
    info(`Install it first:  ${c.bold('npx ruvnet-brain')}`);
    return;
  }
  console.log(c.dim(`\nThis asks your installed brain ${DEMO_QUESTIONS.length} real questions and shows you the`));
  console.log(c.dim(`actual, unedited answers — grounded in rUv's real source, cited by file path. Nothing here`));
  console.log(c.dim(`is scripted or faked; it's the same brain your Claude Code sessions use.\n`));

  for (const [i, { q, why }] of DEMO_QUESTIONS.entries()) {
    step(`Question ${i + 1} of ${DEMO_QUESTIONS.length}`, why);
    info(`${c.cyan('Q:')} "${q}"`);
    let r;
    try {
      // Relative filename + matching cwd — see the identity-check note in smokeQuery() above.
      r = spawnSync('node', ['forge-ask-all.mjs', '--dir', cacheDir, '--q', q, '--k', '1'], {
        cwd: cacheDir, encoding: 'utf8', timeout: 150000, env: process.env,
      });
    } catch (e) {
      warn(`couldn't run this question (${e.message}) — skipping`);
      continue;
    }
    const out = `${r.stdout || ''}`.trim();
    if (r.status !== 0 || !out) {
      warn(`no answer came back — the local model may still be warming up (run this again in a moment)`);
      // Same discarded-diagnosis bug as smokeQuery() — see the note there (issue #37 bug 2).
      const err = `${r.stderr || ''}`.trim();
      if (err) {
        info(c.dim('  the reader reported:'));
        for (const line of err.split('\n').slice(0, 8)) info(c.dim(`    ${line.slice(0, 200)}`));
      }
      continue;
    }
    // Show the top hit's actual citation (repo/path/title + the start of its real cited text) —
    // skip past the noisy per-repo-hit-count header so the meaningful, confidence-building part
    // (WHICH file this came from, and its real words) isn't crowded out. This is a TRIM of the
    // real output, never a rewrite of it.
    const hitStart = out.indexOf('\n#1');
    const firstResult = (hitStart >= 0 ? out.slice(hitStart + 1) : out).split(/\n={10,}\n/)[0];
    const trimmed = firstResult.length > 500 ? `${firstResult.slice(0, 500)}\n…` : firstResult;
    console.log(`\n${c.dim(trimmed.split('\n').map((l) => `    ${l}`).join('\n'))}\n`);
    ok('grounded in real source — cited above, not guessed');
  }

  console.log(`\n${c.green('─'.repeat(64))}`);
  console.log(`  ${c.bold('That\'s it — no cloud calls, no API key, just your local brain.')}`);
  console.log(`${c.green('─'.repeat(64))}`);
  // ── SCOPE + UPGRADE CONVERSATION ────────────────────────────────────────────────────────────
  //
  // The owner, 2026-07-22: "Normally this happens on a per-user basis, which lets learning,
  // intelligence, access and software versions stay updated across ALL your projects. Only choose
  // per-project if this is something you absolutely only use in one place. Our strong
  // recommendation is per-user — but we always want YOU to be the arbiter of how things run on
  // your machine."
  //
  // And, critically, for people who already have it installed: "That's only going to help people
  // newly installing. It needs to be smart enough when it comes up to say version 4 is here, here
  // are your choices."
  //
  // Both modules were BUILT AND WIRED TO NOTHING until this was added — the seventh instance of
  // built-tested-unwired in one session, which is why scripts/wired-check.mjs now gates the release.
  //
  // Read-only here by design: this INFORMS and never changes scope on its own. P3 (nudge, never
  // force) and P4 (the user is the arbiter). Fail-silent, because an informational block must never
  // break an install that otherwise succeeded.
  try {
    const { detectCurrentScope, explainChoice, RECOMMENDED } = await import(new URL('../scripts/install-scope.mjs', import.meta.url).href);
    const current = detectCurrentScope();
    if (current && current.scope !== RECOMMENDED) {
      console.log(`\n${c.dim('  ── how this is set up on your machine ──')}`);
      for (const line of String(explainChoice({ current: current.scope })).split('\n').slice(0, 12)) {
        console.log(`  ${line}`);
      }
    }
  } catch (e) {
    // REPORT, never swallow. A bare `catch {}` here is how this block stayed dead: install-scope.mjs
    // was missing from package.json `files[]`, so on every real npm install the import threw
    // MODULE_NOT_FOUND and the empty catch made that indistinguishable from "nothing to say". Both
    // halves are fixed — it ships now, and if it ever stops shipping, this line says so out loud.
    warn(`scope explainer could not run (${e && e.message}) — the setup summary was skipped`);
  }

  try {
    const { shouldNotify, noticeFor } = await import(new URL('../scripts/upgrade-notice.mjs', import.meta.url).href);
    const v = wrapperVersion();
    if (v && shouldNotify(v)) {
      const notice = noticeFor(v);
      if (notice) {
        console.log('');
        for (const line of String(notice).split('\n').slice(0, 14)) console.log(`  ${line}`);
      }
    }
  } catch { /* informational only */ }

  console.log(`\n  Now try it for real: open Claude Code in any project and ask it something about`);
  console.log(`  RuVector, Ruflo, AgentDB, or SPARC — it'll ground the same way, automatically.`);
  console.log(`  Run this demo again any time:  ${c.bold('npx ruvnet-brain --demo')}`);
  console.log(`  Full health check:              ${c.bold('npx ruvnet-brain --doctor')}\n`);
}

// ── token meter one-liner for --doctor (ADR-0011 token_cost_efficiency) ──────────────────────────
// The hooks + MCP server append one JSON line per fire to a SINGLE user-level ledger at
// ~/.cache/ruvnet-brain/token-ledger.jsonl (see scripts/token-report.mjs for the full breakdown).
// It used to be written per-CWD, which scattered hidden .ruvnet-brain/ directories through users'
// project trees and dirtied their git status — issue #36. Each line now carries a `cwd` field, so
// the per-project view survives without writing anything into a project.
// Fail-silent by design: a meter problem never reddens a checkup.
function meterSummaryLine() {
  try {
    const canonical = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ruvnet-brain', 'token-ledger.jsonl');
    const legacy = path.join(process.cwd(), '.ruvnet-brain', 'token-ledger.jsonl');
    // Read the legacy per-project ledger only if it exists and the canonical one does not — an
    // existing user's measurements should not disappear the day the location changes.
    const ledger = fs.existsSync(canonical) || !fs.existsSync(legacy) ? canonical : legacy;
    if (!fs.existsSync(ledger)) return 'meter: no data yet (appears after the first hook/MCP fire)';
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 1); // start of yesterday, local time
    let count = 0;
    let bytes = 0;
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e?.ts || new Date(e.ts) < since) continue;
      count++;
      bytes += Number(e.bytes) || 0;
    }
    if (count === 0) return 'meter: no data yet (nothing measured in this project yesterday/today)';
    return `meter: ${count} injections measured here yesterday+today — ${bytes} bytes ≈ ${Math.round(bytes / 4)} tokens (full breakdown: node scripts/token-report.mjs)`;
  } catch { return 'meter: ledger unreadable'; }
}

// ── `--doctor`: a standalone health check the user can run any time ───────────────────────────────
//
// EXIT CODES ARE THE POINT (the 40/100 finding). Before this, doctor() printed "! Needs attention."
// on an install with zero stores and no reader, then returned `undefined` — so:
//
//     $ npx ruvnet-brain --doctor >/dev/null 2>&1; echo $?
//     0
//
// Honest prose that no machine can read is not a check. It could not gate a CI job, a nightly probe,
// or a `&&` in someone's shell. It now RETURNS a verdict and main() exits with it, so "needs
// attention" and "success" can never again be the same thing to a script.
async function doctor() {
  printBanner('doctor');
  console.log(c.dim('Checking every part of the install and reporting green/red.\n'));
  const cacheDir = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
  info(`brain dir: ${c.bold(cacheDir)}`);
  const present = fs.existsSync(path.join(cacheDir, 'forge-mcp-all.mjs'));
  if (!present) {
    warn('brain not found here — run the installer first:  npx ruvnet-brain');
    return 1; // "not installed" is a FAILING doctor, not a neutral one
  }
  have('node') ? ok('node present') : warn('node missing');
  have('npm') ? ok('npm present') : warn('npm missing');
  have('claude') ? ok('claude CLI present') : warn('claude CLI missing (plugin wiring needs it)');
  // Two independent version streams (KB bundle vs plugin wrapper) — see checkVersionDrift()'s
  // header comment for the full story. Silent unless they've genuinely diverged.
  reportVersionDrift(cacheDir);
  // Extraction no longer needs an external binary at all — kb/zip-extract.mjs does it with node:zlib
  // (see unzipInto()). So this reports the file's PRESENCE, not a PATH lookup: if it is missing from
  // the install, extraction on Windows silently loses its primary method, which is exactly the class
  // of "shipped, never actually there" gap tests/unit/installer-sibling-imports-packaged.test.mjs
  // exists to catch. Naming the external tools too, because they are still the fallback/primary
  // depending on platform.
  fs.existsSync(fileURLToPath(new URL('../kb/zip-extract.mjs', import.meta.url)))
    ? ok(`zip extraction available (built-in node:zlib${have('unzip') ? ' + unzip' : ''}${have('pwsh') || have('powershell') ? ' + PowerShell Expand-Archive' : ''})`)
    : (have('unzip') || have('pwsh') || have('powershell')
      ? warn('built-in extractor kb/zip-extract.mjs is MISSING from this install — falling back to an external tool')
      : warn('no zip extraction available: kb/zip-extract.mjs missing AND no unzip/PowerShell on PATH'));
  have('git')
    ? ok('git present (not required by this installer, but handy)')
    : info('git not found — that\'s fine, this installer never needs it');
  cleanupStrayRuvectorDb(); // issue #39: sweep a leftover empty scaffold from before this fix, if one's here
  const env = detectEnvironment();
  env.ruflo
    ? ok('Ruflo present — orchestration / swarms / SPARC available')
    : warn('Ruflo not found — answers still work. To build: npm install -g claude-flow@alpha  (or /plugin add ruvnet/claude-flow)');
  env.ruvector
    ? ok('RuVector present — vector CLI / MCP available')
    : warn(`RuVector not found — answers still work. To add: ${buildRuvectorMcpAddCommand(env).say}`);
  // Network probe (issue #27, Jan Lafko): in a network-restricted sandbox the cold-cache embedder
  // pull used to hang FOREVER. Diagnose the condition here, explicitly and in 3 seconds flat: if the
  // model host is unreachable AND no local model cache exists, the first query needs the network and
  // will fail loud (bounded by RUVNET_BRAIN_FETCH_TIMEOUT_MS) — tell the user BEFORE they hit it.
  // ONE CACHE, NOT TWO (2026-07-27). This defaulted to `<cacheDir>/models-cache` — and cacheDir is
  // `~/.cache/ruvnet-brain/KB` (note the /kb) — while the RUNTIME
  // reads `<BRAIN_HOME>/models` (plugin/mcp/server.mjs:99, mirrored by plugin/test/model-cache.mjs:36).
  // So the installer verified — and warmed — a directory the product never opens.
  //
  // MEASURED ON THIS MACHINE, which is how it was found: `<cacheDir>/models-cache` DID NOT EXIST at
  // all, while `<BRAIN_HOME>/models` held 23MB containing ONLY the ms-marco reranker — the bge-base
  // EMBEDDER, the model every query needs first, was absent (0 files). That is the 53s cold start:
  // every cold query re-fetches the embedder because install warmed the wrong path, and it is why
  // search_ruvnet timed out twice in one session. A smoke test that passes against a cache the
  // runtime never reads proves nothing about the runtime — the D8 deduction, in one line of path.
  const modelCacheDir = resolveRuntimeModelCache();
  const requiredModels = requiredEmbedderModels(cacheDir);
  const missingModels = missingEmbedderModels(modelCacheDir, requiredModels);
  const haveLocalModel = missingModels.length === 0;
  try {
    await fetch('https://huggingface.co', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    ok('model host reachable (huggingface.co) — cold-cache model download would work');
  } catch {
    if (haveLocalModel) {
      ok(`model host UNREACHABLE, but every required embedder is cached locally (${modelCacheDir}) — queries work offline`);
    } else {
      warn('network-restricted environment detected: huggingface.co unreachable (3s probe) AND no local model cache.');
      warn(`  Missing query model(s): ${missingModels.join(', ')}`);
      warn(`  The first query needs the embedder model once. Fix: on a networked machine run one query, then copy`);
      warn(`  its model cache to this machine and set KB_MODEL_CACHE to that path. (Queries fail loud, not hang.)`);
    }
  }
  const v = verifyInstall(cacheDir);
  const smoke = await smokeQuery(cacheDir);
  const allGreen = v.repos > 0 && v.reader && v.mcp;
  console.log(
    `\n  ${allGreen ? c.green('✓ Healthy.') : c.yellow('! Needs attention.')} ${
      allGreen ? 'The brain is installed and reachable.' : 'Re-run the installer to fix the warnings above.'
    }`,
  );
  // Installed-and-reachable and actually-grounded are different claims. Keep them separate, so a
  // healthy install can never be mistaken for proven grounding.
  if (smoke.grounded === true) {
    console.log(`  ${c.green('✓ Grounding PROVEN.')} It answered from ${c.bold(smoke.receipt.path)} — a passage that`);
    console.log(`    really exists in your local KB. Checked in ${smoke.secs}s, no cloud, no API key.`);
  } else if (smoke.grounded === false) {
    console.log(`  ${c.yellow('! Grounding NOT proven')} (${smoke.reason}). The install is present but the brain did not`);
    console.log('    answer from a verifiable source. Re-run  npx ruvnet-brain  to repair the KB.');
  } else if (smoke.grounded === null) {
    console.log(`  ${c.yellow('! Grounding not verifiable')} on this bundle — it predates the citation verifier.`);
    console.log('    Re-run  npx ruvnet-brain  to refresh, then --doctor will prove it.');
  }
  // Codex is a SECOND host, and until issue #42 the doctor was silent about it — so a machine where
  // the brain was completely unavailable in Codex still read "Healthy … Grounding PROVEN". Probed
  // from disk (our entry present AND the server.mjs it names really there), never asserted from the
  // fact that an install once ran.
  const cx = codexStatus();
  let codexLifecycle = null;
  if (!cx.host) {
    console.log(`  ${c.dim('Codex: no host detected (no ~/.codex) — nothing to wire.')}`);
  } else if (cx.wired) {
    console.log(`  ${c.green('✓ Codex: wired.')} search_ruvnet is registered in ~/.codex/config.toml and its server exists.`);
    codexLifecycle = await codexLifecycleStatus();
    printCodexLifecycle(codexLifecycle);
  } else {
    console.log(`  ${c.yellow('! Codex: host detected but NOT wired')}${
      cx.serverPath && !cx.serverExists ? ` — registered server is missing (${cx.serverPath})` : ' — no [mcp_servers.ruvnet-brain] entry'
    }.`);
    console.log(`    Codex cannot reach the brain until it is. Fix: re-run  ${c.bold('npx ruvnet-brain')}`);
  }
  console.log(`  ${c.dim(meterSummaryLine())}`);
  if (allGreen) {
    console.log(`\n  ${c.bold('What this means for you:')}`);
    // "EVERY project" is a claim about Claude Code. On a machine with an unwired Codex host it would
    // be read as "every editor", which is exactly the invisible gap issue #42 reported — so scope the
    // sentence honestly instead of quietly overclaiming.
    if (cx.host && !cx.wired) {
      console.log(`    • ${c.bold('It works in EVERY project in Claude Code')} — user-level (global). Open Claude Code in any`);
      console.log(`      repo or VS Code window and it's there. ${c.bold('No reinstall per project.')} ${c.yellow('Codex is NOT wired yet')} (above).`);
    } else {
      console.log(`    • ${c.bold('It works in EVERY project')} — user-level (global). Open Claude Code in any repo or VS Code`);
      console.log(`      window and it's there. ${c.bold('No reinstall per project. No second download.')} One brain, shared.`);
    }
    console.log(`    • ${c.bold('Nothing to git-ignore')} in your projects — it drops zero files into your working repos.`);
    console.log(`    • ${c.bold('To use it:')} just ask Claude about rUv's stack (RuVector, Ruflo, AgentDB, SPARC…) — it`);
    console.log(`      grounds the answer automatically and takes the lead on builds. You don't invoke anything.`);
    console.log(`    • ${c.bold("To know it's on:")} a fresh session greets you with "🧠 RuvNet Brain active". Or run this`);
    console.log(`      ${c.bold('--doctor')} command any time.`);
  }
  console.log(
    c.dim('\n  Heads-up: a window that was ALREADY open when you installed needs a restart to pick it up;\n  newly-opened windows are fine.\n'),
  );

  // ── THE MECHANICAL VERDICT ────────────────────────────────────────────────────────────────────
  // `--hooks` additionally fires every registration in the INSTALLED hooks.json through the real
  // shim under the four stdin regimes. Opt-in because it spawns real hooks; plain --doctor stays a
  // pure read that anyone can run without side effects.
  let hookResult = null;
  if (FLAG_HOOKS) {
    console.log(`  ${c.dim('── hook battery (installed hooks.json, four stdin regimes, external watchdog) ──')}`);
    hookResult = await runSelfCheck({ installState: { repos: v.repos, reader: v.reader, mcp: v.mcp } });
  }

  // ── THE PERSISTED GROUNDING VERDICT (ADR-058 §D8) — read-only, never re-derived here ────────────
  // bin/install.mjs's own install run is the ONLY writer (right after its real smoke query), so a
  // failed smoke stays non-fatal there. `--doctor` is different: it is the command someone runs
  // SPECIFICALLY TO ASK whether the install is healthy, so this is the one place an unresolved
  // "unproven" verdict DOES gate the exit code — without doctor() re-running a second live query
  // (the live smoke result printed above already updates the SAME file the next real install or
  // search_ruvnet touches; this just reads back whatever the most recent real attempt recorded).
  let groundingUnprovenPersisted = false;
  try {
    const mod = await import(new URL('../scripts/selfcheck.mjs', import.meta.url).href);
    groundingUnprovenPersisted = mod.groundingUnproven(mod.readInstallState());
    if (groundingUnprovenPersisted) {
      console.log(`  ${c.yellow('! Grounding UNPROVEN')} (recorded at ${c.bold(mod.installStatePath())}).`);
      console.log(`    This is what makes ${c.bold('--doctor')} fail here even though nothing above crashed — re-run`);
      console.log(`    ${c.bold('npx ruvnet-brain')} once you're online, or ask a real question, to clear it.`);
    }
  } catch { /* selfcheck.mjs unavailable — degrade to the live smoke signal already printed above */ }

  // Without --hooks the verdict is the install-state check the old code already computed and threw
  // away, PLUS the persisted grounding verdict above. `allGreen` was RIGHT here all along; nothing
  // ever read it.
  const codexLifecycleFailed = Boolean(
    codexLifecycle
    && !codexLifecycleGuidance(codexLifecycle).healthy
    && !codexLifecycleGuidance(codexLifecycle).intentional,
  );
  const failed = (hookResult ? hookResult.exitCode !== 0 : !allGreen)
    || groundingUnprovenPersisted
    || codexLifecycleFailed;
  if (failed && !hookResult && !groundingUnprovenPersisted) {
    console.log(`  ${c.red('✗ FAILING')} — the warnings above are real. Re-run  ${c.bold('npx ruvnet-brain')}  to repair.`);
  }
  return failed ? 1 : 0;
}

// ── the post-install self-check, wired for both --doctor --hooks and the installer's last step ────
//
// Loaded dynamically and failing SOFT on a load error: bin/install.mjs is the one file that runs
// before anything is installed, so it must survive a partial/odd delivery rather than crash. A load
// failure is REPORTED, never silently swallowed — a self-check that quietly does not run is exactly
// the 40/100 finding again.
//
// THE COMMENT THAT USED TO BE HERE SAID "scripts/selfcheck.mjs is shipped in package.json `files`".
// It was not. Checked with `npm pack --dry-run` on 2026-07-27, one day after this block merged under
// the headline "the installer can finally FAIL": the tarball carried 21 entries and selfcheck.mjs was
// not among them, so on every real npm install this import threw and the installer could NOT fail.
// The same comment correctly identified install-scope.mjs as having that exact defect and deferred
// fixing it — while asserting from intent, not from `npm pack`, that its own dependency was fine.
// All three of install.mjs's dynamic imports are in `files[]` now, and
// tests/integration/pack-completeness.test.mjs derives the list from this file instead of trusting a
// sentence about it.
async function runSelfCheck({ installState = null, quiet = false } = {}) {
  let mod;
  try {
    mod = await import(new URL('../scripts/selfcheck.mjs', import.meta.url).href);
  } catch (e) {
    warn(`self-check could not run (${e && e.message}) — this install has NOT been verified end to end`);
    return { exitCode: 0, violations: [], lines: [], unavailable: true };
  }
  const result = await mod.selfCheck({ installState, security: true });
  if (!quiet || result.violations.length) console.log(mod.formatVerdict(result, { color: c }));
  return result;
}

// ── `--feedback`: the easiest possible way to tell us how it went ────────────────────────────────
// Composes a prefilled GitHub Discussion — brain version, platform, install age, and a 3-line
// --doctor-style health summary — SHOWS the user exactly what's in it (that's all there is), prints
// the URL, and opens the browser. Deliberately boring on privacy: no queries, no code, no paths,
// no env — every field is generic. The user still writes and posts the actual feedback themselves.
const DISCUSSIONS_URL = `https://github.com/${REPO}/discussions`;

/**
 * Compare two release tags. Returns >0 if a is newer, <0 if older, 0 if equal.
 *
 * Local to this file on purpose: bin/install.mjs is the ONLY file that runs before anything is
 * installed, so it may not import from scripts/ (which isn't in the npm `files` list). Duplicating
 * ~10 lines is the correct trade against an installer that cannot run.
 *
 * Prerelease handling matters here because every tag this project ships is `X.Y.Z-dev`. Numeric
 * parts compare numerically (so 3.10.0 > 3.9.0, which a string compare gets backwards), and a
 * release WITHOUT a prerelease suffix outranks the same numbers WITH one, per semver.
 */
function cmpTag(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;   // 3.5.0 is newer than 3.5.0-dev
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

function installedBrainVersion(cacheDir) {
  // Same read the telemetry ping uses: the bundle stamps its Release tag into SOURCE.json.
  // "unknown" is honest for a locally-built or pre-stamping bundle — never guess a tag.
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDir, 'SOURCE.json'), 'utf8'));
    const v = String(j.releaseTag || '');
    if (/^[A-Za-z0-9._-]{1,32}$/.test(v)) return v;
  } catch { /* fall through */ }
  return 'unknown';
}

// ── the OTHER version: the plugin WRAPPER's own plugin.json ──────────────────────────────────────
// installedBrainVersion() above answers "what KB is on disk". This answers "what PLUGIN WRAPPER is
// on disk" — a genuinely different artifact (hooks, skills, slash commands), updated on a genuinely
// different schedule (see the drift note at checkVersionDrift() below). Reuses pluginCommandsDir()
// — the ONE locator for "is the plugin really here" — instead of growing a second one: plugin.json
// always lives one directory above commands/, in both layouts that function checks.
function wrapperVersion() {
  const commandsDir = pluginCommandsDir();
  if (!commandsDir) return null; // plugin not installed — nothing to read, nothing to compare
  try {
    const p = path.join(path.dirname(commandsDir), '.claude-plugin', 'plugin.json');
    const v = String(JSON.parse(fs.readFileSync(p, 'utf8')).version || '');
    return /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null; // present-but-unparsable = "don't know"
  } catch { return null; }
}

/**
 * The brain ships as TWO independently-versioned artifacts: the KB content bundle (self-updates
 * nightly via forge-update.mjs + GitHub Releases) and the Claude Code PLUGIN WRAPPER (hooks,
 * skills, slash commands), which updates ONLY when Claude Code itself pulls the marketplace git
 * clone at ~/.claude/plugins/marketplaces/ruvnet-brain — NOT AT ALL if a user's
 * ~/.claude/settings.json has "autoUpdate": false for that marketplace. They drift silently, and —
 * this is the damaging part — the version a user is SHOWN always comes from the frozen wrapper,
 * never the brain. Verified live on this machine 2026-07-20: KB SOURCE.json built today, wrapper
 * plugin.json still 3.4.18-dev, nine commits behind origin/main, because autoUpdate was false. A
 * user (Dr. Mark Allen) hit exactly this: KB current, wrapper still the June v0.5.0-dev build, and
 * nothing anywhere told him the two had diverged.
 *
 * NEVER invent or guess a version — this project's hardest rule. Either side unresolved → null, and
 * null is NEVER treated as drift: a locally-built or pre-stamping KB legitimately has no releaseTag
 * (see installedBrainVersion's own comment above), and a plugin that simply isn't installed yet is
 * a DIFFERENT, already-reported situation (wirePlugin / verifyInstall), not a version mismatch.
 * Drift is reported ONLY when BOTH sides resolved to a real value AND those values differ.
 *
 * @returns {{wrapper: string|null, kb: string|null, drift: boolean}}
 */
function checkVersionDrift(cacheDir) {
  const wrapper = wrapperVersion();
  const kbRaw = installedBrainVersion(cacheDir); // already honest — 'unknown' rather than a guess
  const kb = kbRaw === 'unknown' ? null : kbRaw;
  // COMPARE NUMBERS, NOT NAMESPACES. The two sides are written by different writers in different
  // formats: build-bundle stamps SOURCE.json.releaseTag as a git TAG (v-prefixed) while
  // sync-version writes plugin.json.version as a bare SEMVER (no prefix). A raw !== is therefore
  // ALWAYS true, so the first version of this check told every perfectly healthy user their install
  // had drifted, and handed them a fix command that could never clear it. Caught by adversarial
  // review, not by the tests — the test fixture used a v-prefixed plugin version that sync-version
  // never produces, so an impossible input was green-lighting a false claim.
  // Duplicated deliberately from scripts/version.mjs's stripTag(): this installer ships standalone
  // on npm (package.json `files` excludes scripts/version.mjs) and imports node builtins ONLY, so
  // it cannot import the canonical one. Same one-line rule, kept identical on purpose.
  const stripV = (v) => String(v).replace(/^v/, '');
  const drift = Boolean(wrapper && kb && stripV(wrapper) !== stripV(kb));
  return { wrapper, kb, drift };
}

/**
 * Shared narration for --doctor and --what-changed (via printFootprint). Silent whenever there is
 * nothing actionable to say — matched versions, or either side not comparable — so this never adds
 * noise to a healthy machine or a not-yet-fully-installed one. Speaks up only when the two
 * artifacts have genuinely diverged, in plain, warm, non-alarming language (neither artifact is
 * broken — they just update on different schedules), and always hands over the exact command to
 * fix it — verified live against `claude plugin marketplace --help` (2026-07-20) before ever being
 * printed here.
 */
function reportVersionDrift(cacheDir) {
  const state = checkVersionDrift(cacheDir);
  if (!state.drift) return state;
  warn(`the brain (${c.bold(state.kb)}) and the Claude Code plugin (${c.bold(state.wrapper)}) have drifted apart —`);
  info(`that's normal (they update on separate schedules) and neither one is broken. To bring the`);
  info(`plugin up to date:  ${c.bold('claude plugin marketplace update ruvnet-brain')}  ${c.dim('(then restart Claude Code)')}`);
  return state;
}

function installAgeLine(cacheDir) {
  // SOURCE.json's mtime is when the bundle last landed here (install or self-update) — say which.
  for (const f of ['SOURCE.json', 'forge-mcp-all.mjs']) {
    try {
      const days = Math.floor((Date.now() - fs.statSync(path.join(cacheDir, f)).mtimeMs) / 86400000);
      return days === 0 ? 'installed/updated today' : `installed/updated ${days} day${days === 1 ? '' : 's'} ago`;
    } catch { /* try the next anchor file */ }
  }
  return 'not installed here';
}

// The last-3-lines-of---doctor health summary, from the SAME state --doctor reads (gatherInstallState
// + detectEnvironment) — counts and presence only, never a path.
function feedbackHealthLines(cacheDir) {
  const s = gatherInstallState(cacheDir);
  const env = detectEnvironment();
  const allGreen = s.repos > 0 && s.reader && s.mcp;
  return [
    `${s.repos} repo stores on disk · reader ${s.reader ? 'ok' : 'MISSING'} · search_ruvnet ${s.mcp ? 'ok' : 'MISSING'} · plugin ${s.plugin ? 'ok' : 'NOT INSTALLED (no /rvbc)'}`,
    `toolkit: Ruflo ${env.ruflo ? 'present' : 'not found'} · RuVector ${env.ruvector ? 'present' : 'not found'} · claude CLI ${env.claude ? 'present' : 'not found'}`,
    allGreen ? 'verdict: Healthy — installed and reachable' : 'verdict: Needs attention — re-run npx ruvnet-brain',
  ];
}

function openInBrowser(url) {
  if (TEST_MODE) return false; // tests: print the URL, never open anything
  try {
    // rundll32 on Windows (not `cmd /c start`): the URL's & would need cmd-metachar escaping there.
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : IS_WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
    const r = spawnSync(cmd, args, { stdio: 'ignore', shell: false });
    return !r.error && r.status === 0;
  } catch { return false; }
}

function runFeedback() {
  printBanner('feedback');
  const cacheDir = resolvedKbDir();
  const brainV = installedBrainVersion(cacheDir);
  let installerV = 'unknown';
  try { installerV = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || 'unknown'; } catch { /* honest */ }
  const health = feedbackHealthLines(cacheDir);

  const title = `Feedback: RuvNet Brain ${brainV} on ${process.platform}`;
  const body = [
    `**Brain version:** ${brainV} · installer ${installerV}`,
    `**Platform:** ${process.platform}/${process.arch} · node ${process.version}`,
    `**Install age:** ${installAgeLine(cacheDir)}`,
    `**Health (--doctor, last 3 lines):**`,
    '```',
    ...health,
    '```',
    '',
    '**What happened / what you\'d like:**',
    '_(your words here — what you asked, what you got, what you wish it did)_',
    '',
  ].join('\n');

  console.log(c.dim('\nThis prefills a public GitHub Discussion with the block below — and NOTHING else.'));
  console.log(c.dim('No queries, no code, no paths. You review it on GitHub and post it yourself.\n'));
  console.log(body.split('\n').map((l) => `    ${c.dim('│')} ${l}`).join('\n'));

  const url = `${DISCUSSIONS_URL}/new?category=general&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  console.log(`\n  ${c.bold('Prefilled Discussion URL')} ${c.dim('(open it anywhere if no browser pops up):')}`);
  console.log(`  ${url}\n`);

  if (TEST_MODE) {
    warn('RUVNET_BRAIN_TEST=1 — not opening a browser (URL printed above)');
    return;
  }
  if (openInBrowser(url)) ok('opened in your browser — say anything, even one line helps');
  else info(`couldn't open a browser here — copy the URL above into any browser to post`);
}

// ── `--update` / `--enable-nightly` / `--disable-nightly`: end-user freshness controls ────────────
// The brain bundle SHIPS its own self-updater (forge-update.mjs, right in the KB dir): it pulls the
// canonical Release bundle, backs the current copy up, extracts, and re-verifies with forge-guard —
// failing loud with no partial clobber. These flags never reimplement any of that; they only INVOKE
// it once (--update) or SCHEDULE it per-user (--enable-nightly). Nothing here ever publishes.
const NIGHTLY_LABEL = 'com.ruvnet.brain-update';
const resolvedKbDir = () =>
  process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
const nightlyPlistPath = () =>
  path.join(os.homedir(), 'Library', 'LaunchAgents', `${NIGHTLY_LABEL}.plist`);
// RUVNET_BRAIN_TEST=1 → write/remove the plist but NEVER call launchctl. Tests point HOME at a temp
// dir; bootstrapping a temp-dir plist into the user's real gui domain would mutate exactly the
// system state the tests promise not to touch.
const TEST_MODE = process.env.RUVNET_BRAIN_TEST === '1';
// RUVNET_BRAIN_IMPORT_ONLY=1 → import this file for its EXPORTS (parseNightlyAnswer, offerNightly)
// without running the installer as an import side effect. An EXPLICIT env var, not an argv[1]
// path-identity check, because this repo has already watched a path-identity check fail silently
// (see smokeQuery's launch note) — and a silently-skipped installer main is the worst possible
// failure mode for a stranger's first contact. With the variable unset, behavior is unchanged.
const IMPORT_ONLY = process.env.RUVNET_BRAIN_IMPORT_ONLY === '1';
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The same nightly command, cron-flavored — the pattern forge-update.mjs documents in its header.
// 03:47 on purpose: an off-hour minute, so it never piles onto the :00 cron rush.
const cronExample = (kbDir) =>
  `47 3 * * *  cd ${kbDir} && ${process.execPath} forge-update.mjs --apply >> ${kbDir}/update.log 2>&1`;

function missingUpdaterHelp(kbDir) {
  console.error(`\n${c.red('✗ can\'t update:')} ${c.bold('forge-update.mjs')} is missing from ${kbDir}.`);
  console.error(`  Either no brain is installed there, or the bundle predates the self-updater.`);
  console.error(`  Fix: re-run the installer —  ${c.bold('npx ruvnet-brain')}  ${c.dim('(add --force if a brain is already present)')}`);
  console.error(`  — the current bundle ships forge-update.mjs; then this command will work.`);
}

function runUpdate() {
  printBanner('update');
  const kbDir = resolvedKbDir();
  info(`brain dir: ${c.bold(kbDir)}`);
  let updateStatus = 1;
  // NO updater at all = no brain installed here (or a pre-self-updater bundle). That is a USER
  // message, not a fallback trigger: fail LOUD with the re-run-installer help and exit — never
  // surprise the user with a full fresh install as a side effect of `--update` on an empty dir.
  // (Restored 2026-07-18: the 2026-07-17 fallback below accidentally swallowed this branch too,
  // turning `--update` on an empty dir into a silent 512MB re-install — it hung CI's 60s smoke
  // test on both platforms, mutated a dir the contract promises untouched, and on a machine with
  // private KB stores a surprise fresh PUBLIC install is exactly the store-stripping hazard the
  // project docs warn about. The fallback's own comment scopes it to an updater that EXISTS but
  // is broken — this branch enforces that scope.)
  if (!fs.existsSync(path.join(kbDir, 'forge-update.mjs'))) {
    missingUpdaterHelp(kbDir);
    process.exit(1);
  }
  info(c.dim("running the bundle's own self-updater (backs up first, re-verifies, never half-applies)…\n"));
  // Relative filename + matching cwd — same launch convention as smokeQuery(); stdio:'inherit'
  // streams the updater's narration live and unedited.
  const r = spawnSync(process.execPath, ['forge-update.mjs', '--apply'], { cwd: kbDir, stdio: 'inherit' });
  updateStatus = r.error ? 1 : (r.status === null ? 1 : r.status);
  // FALLBACK (2026-07-17), scoped 2026-07-18 to exists-but-FAILED only. An OLDER bundle whose
  // canonicalManifestUrl points at the dead main/kb/.last-built.json path and 404s (the exact break a
  // real user, Jan Lafko, hit). NEVER leave the user stranded at a 404: re-run THIS installer as a
  // fresh install, which pulls the latest Release DIRECTLY (releases/latest) and never touches the
  // manifest — so --update always succeeds and self-heals the stale SOURCE.json in one shot.
  if (updateStatus !== 0 && !process.env.RUVNET_BRAIN_NO_UPDATE_FALLBACK) {
    warn("\nthe bundle's own updater couldn't complete — falling back to a fresh install of the latest Release (this always works)…\n");
    const self = fileURLToPath(import.meta.url);
    const fr = spawnSync(process.execPath, [self, '--force'], { stdio: 'inherit',
      env: { ...process.env, RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1' } });
    updateStatus = fr.error ? 1 : (fr.status === null ? 1 : fr.status);
  }
  // `--update --auto` = update now AND enroll in Evergreen, so this is the LAST time it's ever run by
  // hand. Only enroll if the update itself succeeded — never promise "you're set forever" on a failed
  // update. enableNightly() prints its own real verification (plist path + launchctl result).
  if (updateStatus === 0 && FLAG_AUTO) {
    info(c.dim("\n--auto set: enrolling in Evergreen auto-update so you never run this again…\n"));
    enableNightly(); // exits on its own with verified output; if it returns, fall through to the update verdict
  }
  process.exit(updateStatus); // exit with the updater's own verdict
}

function enableNightly() {
  printBanner('enable nightly updates');
  const kbDir = resolvedKbDir();

  if (process.platform !== 'darwin') {
    info('The LaunchAgent scheduler is macOS-only (for now).');
    info("On this platform, schedule the bundle's self-updater with cron — the pattern");
    info('forge-update.mjs itself documents:');
    console.log(`\n    ${c.bold(cronExample(kbDir))}\n`);
    info(`(${c.bold('crontab -e')}, paste the line, save. Remove the line to disable.)`);
    return; // exit 0 — the user got the working recipe
  }

  info(`brain dir: ${c.bold(kbDir)}`);
  if (!fs.existsSync(path.join(kbDir, 'forge-update.mjs'))) {
    // Refuse to schedule a job that is guaranteed to fail every night — fail loud NOW instead.
    missingUpdaterHelp(kbDir);
    process.exit(1);
  }

  // Template the plist to THIS user's kb dir + node binary.
  //
  // No `/bin/sh -c` (ADR-038): a LaunchAgent whose ProgramArguments invoke a shell is the standard
  // macOS persistence pattern, and EDR persistence monitors score it well above a plist that execs a
  // binary directly. launchd provides everything the shell was doing here natively —
  // WorkingDirectory replaces `cd`, StandardOutPath/StandardErrorPath replace `>>` and `2>&1` — so
  // dropping the shell costs nothing and removes both a shell parse of interpolated paths and the
  // signature. Same schedule, same command, same log.
  const logPath = path.join(kbDir, 'update.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${NIGHTLY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>forge-update.mjs</string>
    <string>--apply</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(kbDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>47</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
  const plistPath = nightlyPlistPath();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
  } catch (e) {
    console.error(`\n${c.red('✗ couldn\'t write the LaunchAgent:')} ${e.message}`);
    process.exit(1);
  }
  ok(`wrote ${c.bold(plistPath)}`);
  info(c.dim('runs nightly at 03:47 — an off-hour minute, so it never lands on the :00 rush'));

  if (TEST_MODE) {
    warn('RUVNET_BRAIN_TEST=1 — skipping launchctl bootout/bootstrap (plist written only)');
  } else {
    const uid = process.getuid();
    // bootout first so re-running replaces the loaded job cleanly; failure just means "wasn't loaded".
    spawnSync('launchctl', ['bootout', `gui/${uid}/${NIGHTLY_LABEL}`], { stdio: 'ignore' });
    const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
    if (boot.status === 0) ok('LaunchAgent loaded — your brain now updates while you sleep');
    else {
      warn(`launchctl bootstrap failed (${(boot.stderr || '').trim() || `exit ${boot.status}`}) — the plist is in place;`);
      info(`load it yourself:  ${c.bold(`launchctl bootstrap gui/${uid} ${plistPath}`)}`);
    }
  }

  console.log(`\n  ${c.bold('Verify it:')}   launchctl list | grep ${NIGHTLY_LABEL}`);
  console.log(`  ${c.bold('Watch it:')}    tail ${logPath}   ${c.dim('(appears after the first nightly run)')}`);
  console.log(`  ${c.bold('Disable it:')}  npx ruvnet-brain --disable-nightly`);
  console.log(`\n  ${c.dim('It only ever PULLS the published Release bundle (backup + re-verify built in) — it never publishes,')}`);
  console.log(`  ${c.dim('and a night with no new Release is a clean no-op.')}\n`);
}

function disableNightly() {
  printBanner('disable nightly updates');
  if (process.platform !== 'darwin') {
    info('The LaunchAgent nightly is macOS-only, so nothing was scheduled here by this tool.');
    info(`If you added the cron line yourself, remove it with:  ${c.bold('crontab -e')}`);
    return;
  }
  const plistPath = nightlyPlistPath();
  const existed = fs.existsSync(plistPath);
  if (TEST_MODE) {
    warn('RUVNET_BRAIN_TEST=1 — skipping launchctl bootout (plist removal only)');
  } else {
    // Ignore failure: "not loaded" is exactly the state we want anyway.
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${NIGHTLY_LABEL}`], { stdio: 'ignore' });
  }
  if (existed) {
    try {
      fs.rmSync(plistPath);
    } catch (e) {
      console.error(`\n${c.red('✗ couldn\'t remove the LaunchAgent:')} ${e.message}`);
      console.error(`  Remove it yourself:  rm ${plistPath}`);
      process.exit(1);
    }
    ok(`nightly updates disabled — removed ${plistPath}`);
  } else {
    ok('nightly updates were already off — nothing to remove (safe to run any time)');
  }
  info(`re-enable any time:  ${c.bold('npx ruvnet-brain --enable-nightly')}`);
}

// ── spend guard: the alarm that catches a runaway agentic fleet BEFORE it drains a card ───────────
// WHY THIS SHIPS: on 2026-07-09 an automated QE fleet spawned 374+ headless agents, each billing the
// Anthropic API on Sonnet, and burned ~$1,600 SILENTLY while a paid Max plan sat unused — nothing
// alerted. That is the exact failure this guard makes impossible: a tiny hourly watchdog that trips
// the moment automated agents flood a project (burst detector, no key needed) or — with
// ANTHROPIC_ADMIN_KEY — daily API spend crosses a threshold. Alert-only; it NEVER spends. Same
// non-fatal, TEST_MODE-aware, default-yes contract as the nightly updater above.
const SPEND_GUARD_LABEL = 'com.ruvnet.spend-watchdog';
const spendGuardScriptPath = () => path.join(os.homedir(), '.claude', 'scripts', 'api-spend-watchdog.mjs');
const spendGuardPlistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${SPEND_GUARD_LABEL}.plist`);

function enableSpendGuard() {
  // The npx checkout is ephemeral, so copy the bundled watchdog to a persistent home the launchd
  // job can point at for good.
  const src = path.join(__dirname, 'api-spend-watchdog.mjs');
  const dst = spendGuardScriptPath();
  if (!fs.existsSync(src)) { warn('spend-watchdog source missing from this bundle — skipping (non-fatal)'); return 'no-source'; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  ok(`installed the spend watchdog → ${c.bold(dst)}`);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SPEND_GUARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${dst}</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SPEND_ALERT_USD</key><string>50</string>
    <key>SPEND_BURST_AGENTS</key><string>20</string>
  </dict>
</dict>
</plist>
`;
  const plistPath = spendGuardPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  ok(`wrote ${c.bold(plistPath)} — runs hourly, alert-only`);

  if (TEST_MODE) { warn('RUVNET_BRAIN_TEST=1 — skipping launchctl (plist written only)'); return 'test'; }
  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${SPEND_GUARD_LABEL}`], { stdio: 'ignore' });
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
  if (boot.status === 0) ok('spend watchdog is live — it warns you the moment a fleet runs away');
  else { warn(`launchctl bootstrap failed (${(boot.stderr || '').trim() || `exit ${boot.status}`}) — the plist is in place;`); info(`load it:  ${c.bold(`launchctl bootstrap gui/${uid} ${plistPath}`)}`); }
  return 'enabled';
}

/**
 * Remove the spend watchdog. Mirrors disableNightly() exactly.
 *
 * This did not exist until 2026-07-20, which meant the watchdog was the one thing this installer
 * could put on a machine with no supported way to take it back off. "Reversible" has to be a
 * command someone can run, not a paragraph telling them which files to delete by hand — a user
 * asking how to undo our changes should never need us to answer.
 */
function disableSpendGuard() {
  printBanner('disable spend watchdog');
  if (process.platform !== 'darwin') {
    info('The spend-watchdog LaunchAgent is macOS-only, so nothing was scheduled here by this tool.');
    return;
  }
  const plistPath = spendGuardPlistPath();
  const scriptPath = spendGuardScriptPath();
  const existed = fs.existsSync(plistPath);
  if (TEST_MODE) {
    warn('RUVNET_BRAIN_TEST=1 — skipping launchctl bootout (plist removal only)');
  } else {
    // Ignore failure: "not loaded" is the state we want anyway.
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${SPEND_GUARD_LABEL}`], { stdio: 'ignore' });
  }
  let failed = false;
  for (const p of [plistPath, scriptPath]) {
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p); } catch (e) {
      failed = true;
      console.error(`\n${c.red("✗ couldn't remove:")} ${p} — ${e.message}`);
      console.error(`  Remove it yourself:  rm ${p}`);
    }
  }
  if (failed) process.exit(1);
  if (existed) ok(`spend watchdog disabled — removed ${plistPath}`);
  else ok('spend watchdog was already off — nothing to remove (safe to run any time)');
}

// Default STATE_PATH from scripts/upgrade-notice.mjs, duplicated (not imported — see the cmpTag()
// comment above this file's own rule on why) so machineFootprint()/uninstallAll() can find and
// remove it without a module this file may not statically depend on.
const upgradeNoticeStatePath = () =>
  process.env.RUVNET_UPGRADE_NOTICE_FILE || path.join(os.homedir(), '.config', 'ruvnet-brain', 'upgrade-notice.json');

// The brain on/off switch (ADR-054 §2). Same duplicate-rather-than-import rule as the line above:
// this installer runs standalone from a fetched tarball and may not depend on scripts/brain-state.mjs.
//
// IT IS REMOVED ON --uninstall, and that is a deliberate lifecycle decision, not tidiness (ADR-054
// §5, Fable's inherited-invisible-OFF find). If an uninstall preserved it, the next `npx
// ruvnet-brain` would install a product that boots switched off, says almost nothing, and gives the
// user no reason to suspect a stale file from a previous life is the cause. `--update` and the
// nightly never touch it — only an explicit uninstall, which is the one moment the user has said
// they want none of this on their machine.
const brainOffSentinelPath = () =>
  path.join(process.env.RUVNET_BRAIN_STATE_DIR || path.join(os.homedir(), '.config', 'ruvnet-brain'), 'brain-off');

/**
 * Everything this installer can leave on a machine, DERIVED from disk — never asserted.
 *
 * A user who wants out should not have to ask us which files to delete. That was the actual
 * position the corporate-machine report left someone in: they had to reverse-engineer our
 * footprint from a bug report. Anything listed here has a real undo next to it.
 *
 * @returns {{label:string, path:string, undo:string}[]}
 */
export function machineFootprint() {
  const items = [];
  const add = (label, p, undo) => { try { if (p && fs.existsSync(p)) items.push({ label, path: p, undo }); } catch { /* unreadable → not ours to claim */ } };

  add('Brain bundle (knowledge base)', resolvedKbDir(), 'npx ruvnet-brain --uninstall');
  if (process.platform === 'darwin') {
    add('Nightly updater (LaunchAgent)', nightlyPlistPath(), 'npx ruvnet-brain --disable-nightly');
    add('Spend watchdog (LaunchAgent)', spendGuardPlistPath(), 'npx ruvnet-brain --disable-spend-guard');
    add('Spend watchdog script', spendGuardScriptPath(), 'npx ruvnet-brain --disable-spend-guard');
  }
  const cmds = pluginCommandsDir();
  if (cmds) items.push({
    label: 'Claude Code plugin',
    path: path.dirname(cmds),
    // `claude plugin uninstall` removes the INSTALLED plugin only — it leaves the marketplace itself
    // registered (a separate git clone + registry entry: `claude plugin marketplace list` still
    // shows it, and wirePlugin() above is the thing that added it via `claude plugin marketplace add
    // stuinfla/ruvnet-brain`). Verified live against `claude plugin marketplace --help` (marketplace
    // name = "ruvnet-brain", from this repo's own .claude-plugin/marketplace.json) that `remove` takes
    // that same short name. Without this second command someone who ran every undo we printed would
    // still have us registered as a marketplace.
    undo: 'claude plugin uninstall ruvnet-brain@ruvnet-brain && claude plugin marketplace remove ruvnet-brain',
  });
  const cmdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  try {
    if (fs.existsSync(cmdPath) && fs.readFileSync(cmdPath, 'utf8').includes(CLAUDE_MD_START)) {
      items.push({ label: 'CLAUDE.md block (6 lines, between markers)', path: cmdPath, undo: 'npx ruvnet-brain --uninstall' });
    }
  } catch { /* unreadable */ }
  add('Usage-counts preference', telemetryConsentPath(), 'delete this file');

  // EVERYTHING ELSE THIS INSTALLER WRITES. The first version of this listed the KB bundle and
  // little else — one artifact out of six — while the help text promised "exactly what RuvNet Brain
  // has put on this machine" and uninstallAll() went on to print "Verified clean". That is the same
  // position the corporate-machine reporter was left in, reproduced by the very feature written to
  // prevent it. It also explains a user seeing ~5 GB used for a ~2 GB knowledge base: most of the
  // footprint was never reported. Anything this installer can create belongs here, or the summary
  // is a comfortable fiction.
  add('Status-bar version script', path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ruvnet-brain-statusline.cjs'),
      'remove the statusLine entry in ~/.claude/settings.json, then delete this file');
  add('Status-bar preference', path.join(telemetryStateDir(), '.statusline-pref'), 'delete this file');
  add('Model-router files', path.join(os.homedir(), '.claude', 'model-router'),
      'rm -rf ~/.claude/model-router');
  // GAP FIX: this used to be a loose `.includes('ruvnet-brain')` substring test against the WHOLE
  // settings.json file — which (a) could also fire on something unrelated (e.g. a marketplace
  // autoUpdate setting that merely mentions our name) and get mislabeled as "the statusLine entry",
  // and (b) meant this was ALWAYS reported as a manual edit, never auto-removed, even though this
  // installer is the one that wrote the key and knows exactly what it wrote. detectStatusLine() now
  // checks the actual parsed statusLine.command against the exact string writeSettingsStatusLine()
  // writes — precise enough that removeSettingsStatusLine() (called from uninstallAll()) can safely
  // reverse just this key, the same way removeClaudeMdBlock() reverses just its own block. A status
  // line a user has since edited or folded into their own script no longer matches and is correctly
  // left off this list entirely (nothing to claim, nothing to undo).
  try {
    const settings = settingsJsonPath();
    const detected = detectStatusLine(settings);
    if (detected.hasStatusLine && !detected.parseError && detected.command === `node "${statuslineHelperPath()}"`) {
      items.push({ label: 'The statusLine entry in settings.json', path: settings, undo: 'npx ruvnet-brain --uninstall (removes just this key; settings.json is backed up first)' });
    }
  } catch { /* unreadable — do not claim it */ }
  try {
    const claudeJson = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(claudeJson) && fs.readFileSync(claudeJson, 'utf8').includes('ruvnet-brain')) {
      items.push({ label: 'The search_ruvnet MCP server registration', path: claudeJson, undo: 'claude mcp remove ruvnet-brain --scope user' });
    }
  } catch { /* unreadable — do not claim it */ }
  // GAP FIX: recordNotified() (scripts/upgrade-notice.mjs, invoked from main() and runDemo() below)
  // writes this file the first time a "what's new" notice is shown — a real disk artifact this
  // installer's own code path creates, that was never listed here and never removed on --uninstall.
  // Path duplicated rather than imported (see the cmpTag() comment above: this file must not import
  // from scripts/ at module scope, since scripts/upgrade-notice.mjs isn't in the npm `files` list —
  // it only reaches a user via a repo clone or `npx github:...`, never a plain npm publish; harmless
  // no-op existence check either way). Env override name matches STATE_PATH there exactly.
  add('Upgrade-notice state (release-notice tracking)', upgradeNoticeStatePath(), 'delete this file');

  return items;
}

/** Print the footprint. Called at the end of an install so nobody is ever surprised later. */
function printFootprint({ heading = 'What this put on your machine' } = {}) {
  const items = machineFootprint();
  if (!items.length) { info('Nothing from RuvNet Brain is currently installed.'); return items; }
  console.log(`\n  ${c.bold(heading)}`);
  for (const it of items) {
    console.log(`    • ${it.label}`);
    console.log(`      ${c.dim(it.path.replace(os.homedir(), '~'))}`);
    console.log(`      ${c.dim(`undo: ${it.undo}`)}`);
  }
  console.log(`\n  ${c.dim('Remove all of it at once:')}  ${c.bold('npx ruvnet-brain --uninstall')}`);
  // Same "two artifacts, one machine" story as --doctor — surfaced here too, since a footprint
  // listing is exactly where a user would otherwise reasonably assume one version covers both.
  // Silent unless they've genuinely diverged.
  reportVersionDrift(resolvedKbDir());
  return items;
}

/**
 * Surgically remove ONLY our block from CLAUDE.md, leaving every other line exactly as it was.
 * Backed up and written atomically, same as when it was added — taking something away is at least
 * as sensitive as putting it there.
 */
function removeClaudeMdBlock() {
  const p = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  let src = '';
  try { src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return 'unreadable'; }
  // PAIR THE MARKERS PROPERLY. The first version took the FIRST start and the FIRST end, unpaired.
  // Adversarial review proved that eats the user's file: a CLAUDE.md that merely MENTIONS the start
  // marker in prose (entirely plausible — we print both marker strings to the console when adding
  // the block) above a real installed block causes everything between the prose mention and the real
  // block's end marker to be deleted. Their rules, silently gone, under a message saying "your
  // content untouched".
  //
  // Take the LAST start that has an end after it, and the FIRST end after that start — the real
  // block is the innermost well-formed pair. Anything we cannot pair confidently is left alone:
  // refusing to edit is always better than removing the wrong span from a file we do not own.
  const end = src.indexOf(CLAUDE_MD_END);
  if (end === -1) return 'absent';
  const start = src.lastIndexOf(CLAUDE_MD_START, end);
  if (start === -1) return 'absent';

  // Splice ONLY the block. The previous version also ran .replace(/\n{3,}/g,'\n\n') and stripped
  // leading whitespace across the WHOLE document, which silently reformatted unrelated content —
  // including collapsing blank lines inside fenced code blocks — while the docstring promised
  // "every other line exactly as it was". Normalize only at the seam we actually cut.
  const before = src.slice(0, start).replace(/\n{3,}$/, '\n\n');
  const after = src.slice(end + CLAUDE_MD_END.length).replace(/^\n{3,}/, '\n\n');
  const next = `${before}${after}`;
  try {
    const backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(p, backup);
    const tmp = `${p}.ruvnet-tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, p);
    return 'removed';
  } catch { return 'failed'; }
}

/** Reverse everything, and PROVE it rather than claiming it. */
function uninstallAll() {
  printBanner('uninstall RuvNet Brain');
  const before = machineFootprint();
  if (!before.length) { ok('Nothing to remove — RuvNet Brain is not installed here.'); return; }

  // SPLIT WHAT WE REMOVE FROM WHAT WE CANNOT. The first version printed one flat "This will remove:"
  // list built from the whole footprint — including the Claude Code plugin and edits inside files
  // the user owns, none of which this function touches. It then closed by admitting those same
  // items still needed a manual step. One command contradicting itself inside a single run is
  // exactly the sloppiness that makes people stop believing any of our output, so the promise is now
  // scoped to what actually happens.
  // Ours-by-construction directories and files are removed; things that live INSIDE a file the user
  // owns (settings.json entries, the MCP registration) and the Claude Code plugin itself are not
  // ours to delete, so they are handed over as commands.
  const AUTO = new Set(['Brain bundle (knowledge base)', 'Nightly updater (LaunchAgent)',
    'Spend watchdog (LaunchAgent)', 'Spend watchdog script', 'CLAUDE.md block (6 lines, between markers)',
    'Model-router files', 'Status-bar version script', 'Status-bar preference', 'Usage-counts preference',
    // Two gaps closed here: the statusLine KEY is now removable in place (we know exactly what we
    // wrote — see removeSettingsStatusLine()), and the upgrade-notice tracker is a file we fully own.
    'The statusLine entry in settings.json', 'Upgrade-notice state (release-notice tracking)']);
  const willRemove = before.filter((it) => AUTO.has(it.label));
  const manual = before.filter((it) => !AUTO.has(it.label));

  console.log(`  This will remove:`);
  for (const it of willRemove) console.log(`    • ${it.label}  ${c.dim(it.path.replace(os.homedir(), '~'))}`);
  if (!willRemove.length) console.log(`    ${c.dim('(nothing that this command removes automatically)')}`);
  if (manual.length) {
    console.log(`\n  ${c.bold('It will NOT remove these')} — they are not ours to delete, so you get the command instead:`);
    for (const it of manual) console.log(`    • ${it.label}\n      ${c.dim(it.undo)}`);
  }
  console.log(`\n  ${c.dim('Your own CLAUDE.md content is preserved — only our marked block is taken out,')}`);
  console.log(`  ${c.dim('and the file is backed up first.')}\n`);

  if (process.platform === 'darwin') { disableNightly(); disableSpendGuard(); }

  const claudeMd = removeClaudeMdBlock();
  if (claudeMd === 'removed') ok('removed our block from ~/.claude/CLAUDE.md (your content untouched, backup saved)');

  // GAP FIX: this used to be permanently "manual" — machineFootprint() treated ANY settings.json edit
  // as something only the user could safely touch. That blanket rule was right for edits we cannot
  // attribute with confidence, but wrong for this one specific key: we wrote it ourselves and know
  // the exact string we wrote, so we can reverse exactly that (never a status line the user has since
  // customized — removeSettingsStatusLine() checks the live command before touching anything).
  const statusLine = removeSettingsStatusLine();
  if (statusLine === 'removed') ok('removed the statusLine entry from ~/.claude/settings.json (your other settings untouched, backup saved)');

  // NEVER rm -rf A PATH WE HAVE NOT PROVEN IS OURS. resolvedKbDir() honours $RUVNET_BRAIN_KB, which
  // the docs encourage for custom install locations — so `RUVNET_BRAIN_KB=$HOME npx ruvnet-brain
  // --uninstall` would have recursively deleted the user's home directory. Found by adversarial
  // review. The asymmetry was already visible in this same file: runUpdate() refuses to act unless
  // forge-update.mjs is present, precisely so it can never surprise someone. Uninstall skipped it.
  //
  // Proof-of-ownership: the directory must actually contain the reader we install. That is cheap,
  // unspoofable in practice, and fails CLOSED — if we cannot prove it is a brain, we do not touch it
  // and we say why.
  const kb = resolvedKbDir();
  const looksLikeBrain = kb && ['forge-ask.mjs', 'forge-mcp.mjs', 'SOURCE.json']
    .some((marker) => { try { return fs.existsSync(path.join(kb, marker)); } catch { return false; } });
  if (kb && fs.existsSync(kb) && !looksLikeBrain) {
    warn(`refusing to delete ${kb.replace(os.homedir(), '~')} — it does not look like a brain bundle.`);
    info(`  (no forge-ask.mjs / forge-mcp.mjs / SOURCE.json found there). Nothing was removed.`);
    info(`  If that really is your brain, remove it yourself:  rm -rf ${kb.replace(os.homedir(), '~')}`);
  } else if (kb && fs.existsSync(kb)) {
    try { fs.rmSync(kb, { recursive: true, force: true }); ok(`removed the brain bundle (${kb.replace(os.homedir(), '~')})`); }
    catch (e) { warn(`couldn't remove ${kb}: ${e.message}`); }
  }

  // The rest of what is ours by construction. Leaving these behind is how an "uninstalled" machine
  // still shows gigabytes of us — 8 executables under ~/.claude/model-router, a statusline script
  // that settings.json is still pointing at, and preference files. Each is removed only if it is
  // inside a directory this installer creates, never a path the user chose.
  for (const [label, target] of [
    ['model-router files', path.join(os.homedir(), '.claude', 'model-router')],
    ['status-bar script', path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ruvnet-brain-statusline.cjs')],
    ['status-bar preference', path.join(telemetryStateDir(), '.statusline-pref')],
    ['usage-counts preference', telemetryConsentPath()],
    // GAP FIX: written by recordNotified() (scripts/upgrade-notice.mjs) whenever the "what's new"
    // notice fires from main()/runDemo() below — a single-purpose file under a directory this
    // installer alone writes to, safe to remove outright (not the whole ~/.config/ruvnet-brain/ dir,
    // which can also hold lessons.json/settings.json this installer never creates and must not touch).
    ['upgrade-notice state', upgradeNoticeStatePath()],
    // ADR-054 §5: a reinstall must never inherit an invisible OFF. See brainOffSentinelPath().
    ['brain on/off switch', brainOffSentinelPath()],
  ]) {
    if (!fs.existsSync(target)) continue;
    try { fs.rmSync(target, { recursive: true, force: true }); ok(`removed the ${label}`); }
    catch (e) { warn(`couldn't remove ${target.replace(os.homedir(), '~')}: ${e.message}`); }
  }

  // PROOF, not a claim — re-derive the footprint and show what (if anything) survived.
  const after = machineFootprint();
  console.log('');
  if (!after.length) { ok('Verified clean — nothing from RuvNet Brain remains.'); }
  else {
    warn('These need one more step (they are not ours to remove automatically):');
    for (const it of after) console.log(`    • ${it.label} — ${c.bold(it.undo)}`);
  }
}

// Exported (testable under RUVNET_BRAIN_IMPORT_ONLY=1, like offerNightly). Never throws — the caller
// also guards, because a finished install must never be broken by an optional safety offer.
export async function offerSpendGuard() {
  if (FLAG_NO_NIGHTLY_PROMPT || TEST_MODE) return 'suppressed';
  if (process.platform !== 'darwin') return 'unsupported';
  if (fs.existsSync(spendGuardPlistPath())) { ok('spend watchdog already installed — runaway API spend will alert you'); return 'already-on'; }

  step(
    'One more safety net — a spend watchdog',
    'agentic tools can bill the paid API in the background; this alarm catches a runaway before it drains your card',
  );
  info(`${c.green('Recommended')} — an hourly check that alerts you the moment an automated agent fleet`);
  info(`floods a project. That pattern has quietly burned real money. ${c.bold('Your call, and easy to undo.')}`);
  info(`${c.dim('What it sets up:')} a small background job (a macOS LaunchAgent) that watches for the burst`);
  info(`${c.dim('                 ')} pattern. ${c.bold('Alert-only — it never spends, and never changes your billing.')}`);
  info(`${c.dim('If you skip:')}     nothing changes; add it later with  ${c.bold('npx ruvnet-brain --enable-spend-guard')}`);

  // NOT gated on FLAG_YES — second launchd job, same rule as the nightly updater above.
  if (!process.stdin.isTTY && !FLAG_ENABLE_SPEND_GUARD) { info(`No terminal to prompt on — install it any time with  ${c.bold('npx ruvnet-brain --enable-spend-guard')}`); return 'recommended'; }
  let yes = true;
  const plannedSpend = plannedChoice('spend');
  if (plannedSpend !== undefined) {
    yes = plannedSpend;   // answered in the up-front checklist — never re-ask
  } else if (!FLAG_ENABLE_SPEND_GUARD) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(`    ${c.cyan('?')} Install the spend watchdog? ${c.dim('[Y/n]')} `, resolve));
    rl.close();
    yes = parseNightlyAnswer(answer);
  }
  if (!yes) { info(`No problem — install it any time by re-running  ${c.bold('npx ruvnet-brain')}`); return 'declined'; }
  try { enableSpendGuard(); } catch (e) { warn(`spend guard install skipped: ${e.message}`); return 'error'; }
  return 'enabled';
}

// ── step: offer nightly auto-updates at the end of a successful install (recommended, default YES) ──
// Requirement: a default `npx ruvnet-brain` run must never leave the user unaware of nightly
// auto-updates — it VERY CLEARLY recommends them, asks, and DEFAULTS TO YES. Before this, the
// nightly LaunchAgent only ever installed via the explicit --enable-nightly flag.
//
// The answer parsing is exported so the default-yes contract is unit-testable without a TTY:
// ENTER (empty) and y/yes (any case) accept; ONLY an explicit n/no declines.
export function parseNightlyAnswer(answer) {
  const s = String(answer ?? '').trim().toLowerCase();
  return s !== 'n' && s !== 'no';
}

// Exported for the same reason: the decision matrix (TTY/non-TTY × platform × already-enabled ×
// suppression flags) is testable in-process under RUVNET_BRAIN_IMPORT_ONLY=1 without a real install.
// Returns a status string; never throws (the caller also guards — a finished install must never
// be broken by an optional offer).
// ── MetaHarness router: config materialization + THIS user's subscription profile (2026-07-12) ──
// Stuart's mandate: subscription-awareness must be per-user. Detect what the machine can PROVE
// (Codex auth mode from ~/.codex/auth.json's SHAPE — never its secrets), ASK what it can't (Claude
// plan tiers aren't probeable from disk), and RECORD both with their basis, so the router's
// $0-floor never assumes a plan this user doesn't have (billing them) or misses one they do
// (wasting it). Config templates ship in the npm package's config/; router tools are copied to
// ~/.claude/model-router/bin/ because the npx run dir vanishes after install. Never overwrites
// user-edited files. Non-fatal like every offer.
export async function offerRouterProfile() {
  if (TEST_MODE) return 'suppressed';
  const routerDir = path.join(os.homedir(), '.claude', 'model-router');
  const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  step(
    'MetaHarness model router — the right model for each task, cheapest first',
    "your subscription models are $0 marginal; the router just needs to know which ones YOU have",
  );

  fs.mkdirSync(path.join(routerDir, 'bin'), { recursive: true });
  for (const [src, dst] of [['catalog.template.json', 'catalog.json'], ['policy.default.mjs', 'policy.default.mjs']]) {
    const s = path.join(pkgRoot, 'config', 'model-router', src);
    const d = path.join(routerDir, dst);
    if (fs.existsSync(s) && !fs.existsSync(d)) { fs.copyFileSync(s, d); ok(`installed ${dst} (edit freely — goldie keeps prices fresh where scheduled)`); }
  }
  let copied = 0;
  // dispatch-receipt + metaharness-receipts added 2026-07-13: without the LOGGER, subagent routing is
  // invisible; without the VIEWER, the user has no scoreboard to hold it to. Shipping one without the
  // other is how a router ends up "working" with three test pings in its log and nobody the wiser.
  // (dispatch-receipt.mjs relative-imports route-cheap.mjs — they land in the same bin/ dir, so it resolves.)
  for (const t of ['model-router-engine.mjs', 'model-router-setup.mjs', 'model-router-status.mjs', 'model-router-outcome.mjs', 'subscription-hosts.mjs', 'dual-host-deliberation.mjs', 'dual-host-suggest.mjs', 'route-cheap.mjs', 'dispatch-receipt.mjs', 'metaharness-receipts.mjs', 'codex-routed.sh']) {
    const s = path.join(pkgRoot, 'scripts', t);
    if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(routerDir, 'bin', t)); copied++; }
  }
  if (copied) {
    try { fs.chmodSync(path.join(routerDir, 'bin', 'codex-routed.sh'), 0o755); } catch { /* not fatal */ }
    ok(`${copied} router tools at ~/.claude/model-router/bin/ (stable path — the npx dir vanishes)`);
  }

  const profilePath = path.join(routerDir, 'profile.json');
  if (fs.existsSync(profilePath)) { ok('subscription profile already exists — routing already uses it'); return 'already'; }

  // Codex is the one subscription we can PROVE: OAuth tokens in auth.json = signed in with ChatGPT
  // (Plus/Pro/Business all include Codex). An API key instead = metered per-token.
  let codexAuth = null;
  try {
    const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    codexAuth = a.tokens ? 'chatgpt' : a.OPENAI_API_KEY ? 'api-key' : null;
  } catch { /* codex absent or not authed */ }

  const today = new Date().toISOString().slice(0, 10);
  // This installer's audience is Claude Code users — claude-code is available by definition.
  let claudeSub = true;
  let claudeBasis = `assumed: installing the Claude Code brain (${today}); confirm with model-router-setup.mjs --show`;
  let codexSub = codexAuth === 'chatgpt';
  let codexBasis =
    codexAuth === 'chatgpt' ? `verified: ~/.codex/auth.json ChatGPT OAuth tokens (${today})`
    : codexAuth === 'api-key' ? `verified: ~/.codex/auth.json API key — METERED, not subscription (${today})`
    : `detected: codex not authed on this machine (${today})`;

  if (process.stdin.isTTY && !FLAG_YES) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const q = (text) => new Promise((resolve) => rl.question(text, resolve));
    const a1 = await q(`    ${c.cyan('?')} Do you have a Claude subscription (Pro or Max) covering your Claude Code use? ${c.dim('[Y/n]')} `);
    claudeSub = !/^n/i.test((a1 || '').trim());
    claudeBasis = `user-attested ${today}`;
    if (codexAuth === 'chatgpt') {
      info(`Codex: verified signed in with ChatGPT — your ChatGPT plan covers it ($0). Nothing to ask.`);
    } else {
      const a2 = await q(`    ${c.cyan('?')} Do you also use OpenAI's Codex CLI signed in with a ChatGPT subscription? ${c.dim('[y/N]')} `);
      codexSub = /^y/i.test((a2 || '').trim());
      codexBasis = `user-attested ${today}${codexSub && codexAuth !== 'chatgpt' ? ' (auth.json does not show ChatGPT login yet — run `codex login`)' : ''}`;
    }
    rl.close();
  } else {
    info('No interactive terminal — recording detections with labeled assumptions. Refine any time:');
    info(`  ${c.bold('node ~/.claude/model-router/bin/model-router-setup.mjs')}`);
  }

  const profile = {
    updated: today,
    harnesses: {
      'claude-code': { available: true, subscription: claudeSub, plan: claudeSub ? 'pro-or-max' : 'api-billed', basis: claudeBasis },
      codex: { available: codexAuth !== null, subscription: codexSub, plan: codexAuth, basis: codexBasis },
    },
    keys: Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'].map((k) => [k, !!process.env[k]])),
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
  ok(`subscription profile saved — Claude Code: ${claudeSub ? 'subscription ($0)' : 'API-billed'}; Codex: ${codexSub ? 'subscription ($0)' : codexAuth === 'api-key' ? 'METERED' : 'not in use'}`);
  return 'created';
}

export async function offerNightly() {
  // Suppressed outright: --no-nightly-prompt (the user said don't ask) and RUVNET_BRAIN_TEST=1
  // (tests must stay non-interactive and must never schedule anything).
  if (FLAG_NO_NIGHTLY_PROMPT || TEST_MODE) return 'suppressed';
  const kbDir = resolvedKbDir();
  // A bundle that predates the self-updater has nothing to run nightly — don't offer a job that
  // is guaranteed to fail (enableNightly would refuse it anyway).
  if (!fs.existsSync(path.join(kbDir, 'forge-update.mjs'))) return 'no-updater';

  step(
    'One last thing — keeping the brain fresh',
    'rUv ships constantly; a brain that updates itself stays current with zero effort from you',
  );

  if (process.platform !== 'darwin') {
    info('The LaunchAgent scheduler is macOS-only (for now).');
    info(`Update manually any time with:  ${c.bold('npx ruvnet-brain --update')}`);
    info(`(or schedule it yourself with the cron line documented in the brain's own forge-update.mjs)`);
    return 'unsupported';
  }

  if (fs.existsSync(nightlyPlistPath())) {
    ok('nightly auto-updates are already on — new repos and gists arrive while you sleep');
    return 'already-on';
  }

  info(`${c.bold('Recommended:')} your brain updates itself while you sleep — new repos, new gists, zero effort.`);

  // Recommend it, mean it, and still make declining feel completely fine. The goal is a user who
  // understands what they're agreeing to — not one who is either scared off by a wall of caveats or
  // nudged past a decision they'd have made differently. Both failures cost trust; only one is loud.
  info(`${c.green('Recommended')} — rUv ships constantly, and this is how fixes reach you without you`);
  info(`thinking about it. ${c.bold('Entirely your call, though')}, and easy to undo.`);
  info(`${c.dim('What it sets up:')} a small background job (a macOS LaunchAgent) that checks each night`);
  info(`${c.dim('                 ')} and downloads a fresher brain — signature-verified before anything is applied.`);
  info(`${c.dim('If you skip:')}     nothing changes; update whenever you like with  ${c.bold('npx ruvnet-brain --update')}`);
  info(`${c.dim('Turn it off:')}     ${c.bold('npx ruvnet-brain --disable-nightly')}  ${c.dim('(any time, no reinstall)')}`);

  // NOT gated on FLAG_YES — see the high-impact consent note on ask(). A blanket `-y` means nobody is
  // present to READ the explanation above, and an explanation nobody read is not consent. It takes the
  // explicit --enable-nightly, or a human answering in a terminal.
  if (!process.stdin.isTTY && !FLAG_ENABLE_NIGHTLY) {
    // No terminal to ask on (CI / piped install) — recommend clearly instead of prompting.
    info(`No interactive terminal here, so I won't prompt. Enable it any time with one command:`);
    info(`  ${c.bold('npx ruvnet-brain --enable-nightly')}`);
    return 'recommended';
  }

  let yes = true;
  const planned = plannedChoice('nightly');
  if (planned !== undefined) {
    // Already answered in the up-front checklist — don't ask twice (the owner's complaint).
    yes = planned;
  } else if (!FLAG_ENABLE_NIGHTLY) {
    // Not ask(): its parser treats anything but y/yes as no. Here the DEFAULT is yes — only an
    // explicit n/no declines (parseNightlyAnswer holds that contract, and the tests hold it there).
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`    ${c.cyan('?')} Enable nightly auto-updates? ${c.dim('[Y/n]')} `, resolve),
    );
    rl.close();
    yes = parseNightlyAnswer(answer);
  }

  if (!yes) {
    info(`No problem — enable it any time with:  ${c.bold('npx ruvnet-brain --enable-nightly')}`);
    return 'declined';
  }
  enableNightly(); // prints its own real verification output (plist path, launchctl result, how to check)
  return 'enabled';
}

// ── step: offer OPT-IN anonymous usage counts (asked once ever; explicit yes required) ────────────
// The whole contract, honestly: counts ONLY (installs / searches / sessions + version) — NEVER the
// user's queries, code, repo names, or paths. Consent is a plain yes/no file the user can read and
// flip (~/.cache/ruvnet-brain/.telemetry-consent); nothing is ever sent without the literal "yes".
// Fail-private everywhere: no TTY → not asked → not enabled; TEST mode → suppressed entirely.
const telemetryStateDir = () => path.join(os.homedir(), '.cache', 'ruvnet-brain');
const telemetryConsentPath = () => path.join(telemetryStateDir(), '.telemetry-consent');

// Same default-yes contract as parseNightlyAnswer, exported under its own name so the telemetry
// tests read as telemetry tests: ENTER/y/yes accept; ONLY an explicit n/no declines.
export const parseTelemetryAnswer = parseNightlyAnswer;

// Fire-and-forget install ping — 3s cap, all failures swallowed, payload is { event, v } and
// nothing else. Exported (with injectable fetch) so tests can assert the payload without a network.
export async function sendInstallPing({
  version = 'unknown',
  fetchFn = globalThis.fetch,
  pingUrl = process.env.RUVNET_BRAIN_PING_URL || 'https://ruvnet-brain.vercel.app/api/ping',
} = {}) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    await fetchFn(pingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'install', v: version }),
      signal: ctl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch { /* a lost count is nothing; a broken install step would be everything */ }
}

// Exported decision matrix (testable under RUVNET_BRAIN_IMPORT_ONLY=1, like offerNightly).
// Returns a status string; never throws — a finished install must never be broken by an offer.
export async function offerTelemetry(cacheDir) {
  if (TEST_MODE) return 'suppressed'; // tests: never prompt, never write, NEVER send
  const consentPath = telemetryConsentPath();
  if (fs.existsSync(consentPath)) return 'already-set'; // asked once ever — respect the answer
  if (FLAG_NO_TELEMETRY) {
    try { fs.mkdirSync(telemetryStateDir(), { recursive: true }); fs.writeFileSync(consentPath, 'no\n'); } catch { /* best-effort */ }
    return 'declined-flag';
  }

  step(
    'Optional: anonymous usage counts',
    'a simple count of installs/searches tells Stuart the brain is actually helping people — nothing about WHAT you ask',
  );
  info(`Counts only — installs, searches, sessions, version. ${c.bold('Never your queries, code, repo names, or paths.')}`);
  info(c.dim(`Your answer is a plain-text file you can read or flip any time: ${consentPath}`));

  if (!process.stdin.isTTY && !FLAG_YES) {
    // No terminal to ask on → fail PRIVATE: no consent recorded, so nothing will ever be sent.
    info(`No interactive terminal here, so I won't assume — usage counts stay ${c.bold('OFF')}.`);
    info(`Opt in any time:  echo yes > ${consentPath}`);
    return 'not-asked';
  }

  let yes = true; // --yes accepts every optional offer, this one included
  const plannedTelemetry = plannedChoice('telemetry');
  if (plannedTelemetry !== undefined) {
    yes = plannedTelemetry;   // answered in the up-front checklist — never re-ask
  } else if (!FLAG_YES) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`    ${c.cyan('?')} Share anonymous usage counts (installs/searches — never your queries or code)? ${c.dim('[Y/n]')} `, resolve),
    );
    rl.close();
    yes = parseTelemetryAnswer(answer);
  }

  try {
    fs.mkdirSync(telemetryStateDir(), { recursive: true });
    fs.writeFileSync(consentPath, yes ? 'yes\n' : 'no\n');
  } catch (e) {
    warn(`couldn't record the answer (${e.message}) — defaulting to OFF (nothing will be sent)`);
    return 'error';
  }
  if (!yes) {
    ok('usage counts are OFF — nothing will ever be sent');
    return 'declined';
  }
  ok('thanks — anonymous counters only, batched to at most one ping a day');
  // Count this install (the one event the brain itself can't see). Version = the bundle we
  // just put on disk, read live from its own SOURCE.json — never guessed.
  let v = 'unknown';
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDir, 'SOURCE.json'), 'utf8'));
    if (typeof j.releaseTag === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(j.releaseTag)) v = j.releaseTag;
  } catch { /* unknown is honest */ }
  await sendInstallPing({ version: v });
  return 'enabled';
}

// ── tiny interactive yes/no — SAFE in non-TTY (returns the default; never blocks a piped install) ──
/**
 * @param {string} question
 * @param {boolean} def answer used when there is no terminal to ask on
 * @param {{blanketYes?: boolean}} opts blanketYes:false means --yes does NOT answer this one
 *
 * HIGH-IMPACT CONSENT (2026-07-20). `--yes` is documented as "accept every optional offer", and it
 * used to include the two changes nobody would call optional: installing a persistent LaunchAgent
 * that pulls code from GitHub on a schedule, and editing a global config file. Reported by a user on
 * a CORPORATE machine whose enterprise policy correctly blocked the plugin/MCP install but had no
 * rule covering a launchd job — so the one thing that survived was the background daemon.
 *
 * It almost certainly arrived via an AI agent: hit an interactive prompt, cannot answer it, re-run
 * with `-y`. Entirely reasonable behaviour, and with blanket consent it silently authorizes a
 * daemon. rUv's own ADR-302 already says why this is wrong — "accepting the enrollment screen is
 * not blanket authorization... four distinct decisions, each with its own consent, its own prompt
 * moment, and its own record." We were violating his design inside our own installer.
 *
 * So: persistent background jobs and global-config edits require their OWN explicit flag. There is
 * no combination of `-y` alone that installs a daemon.
 */
/**
 * THE PLAN — everything this run may do, stated BEFORE the first thing is done.
 *
 * WHY THIS EXISTS (real user feedback, 2026-07-24, relayed by the owner): people were not running
 * `npx ruvnet-brain` *because they could not tell what it would do.* One of them, a sophisticated
 * user, put the general objection precisely: he dislikes "the virus/plugin approach… it all works in
 * memory, with invisible hooks and all."
 *
 * The installer already asked consent for every high-impact step — watchdog, nightly updates,
 * telemetry, stack tools, statusline. That was necessary and NOT sufficient: consent granted one
 * question at a time, after the run has already started, never tells you the SHAPE of what you
 * agreed to. You cannot decline a thing you have not yet been told is coming, and a person deciding
 * whether to paste a command into their terminal is deciding about the whole run, not about step 4.
 *
 * So: the whole list, up front, with what each one costs you and how to undo it. Steps marked [?] are
 * asked individually as before — this screen does not replace those prompts, it makes them
 * predictable. Nothing here mutates anything; it prints and waits.
 *
 * TRUTHFULNESS RULE: every line below names a real step this file performs and a real reversal
 * command. If a step is added to the installer and not to this list, the list becomes a lie about
 * the installer — which is worse than having no list. Keep them together.
 */
async function printPlanAndConfirm() {
  const H = os.homedir();
  const short = (p) => p.replace(H, '~');

  // The REQUIRED core — always runs, shown for transparency, never a question (nothing works without
  // these, so asking would be theatre).
  const core = [
    { name: 'Download the knowledge base',
      cost: short(resolveCacheDir().cacheDir),
      what: 'Real rUv source, on your disk, so answers cite files instead of guessing.' },
    { name: 'Register the Claude Code plugin + MCP server',
      cost: `an entry in ${short(path.join(H, '.claude'))}`,
      what: 'Gives Claude a search_ruvnet tool. Adds no hooks you have not agreed to.' },
  ];
  // The OPTIONAL steps — each asked ONCE here, stored in PLAN_CHOICES, and consumed by its offer
  // later (no second prompt). `def` is the pre-check: nightly + spend are recommended (default yes),
  // the rest default off. `rec` tags the two recommended ones for the display grouping.
  const optional = [
    { key: 'nightly', rec: true,  name: 'Evergreen auto-updates',
      what: 'Keeps the KB and plugin current — declining makes updates manual forever. rUv ships fast, and a stale brain is the main way this stops being useful.',
      undo: 'npx ruvnet-brain --disable-nightly', def: true },
    { key: 'spend',   rec: true,  name: 'Spend watchdog',
      what: 'Warns you if an agent fleet starts burning API credit unexpectedly.',
      undo: 'npx ruvnet-brain --disable-spend-guard', def: true },
    { key: 'stack',   name: 'Add rUv tools you are missing',
      what: 'So the brain can build with them, not just answer questions about them. The brain answers grounded questions fine without them.',
      undo: 'npm uninstall -g <tool>', def: false },
    { key: 'statusline', name: 'Status-bar version segment',
      what: 'Shows which brain version is live while you work.',
      undo: 'npx ruvnet-brain --no-statusline', def: false },
    { key: 'telemetry', name: 'Anonymous usage counts',
      what: 'Installs and searches only — never your queries, your code, or your paths.',
      undo: 'npx ruvnet-brain --no-telemetry', def: true },
  ];

  console.log(`  ${c.bold('Here is everything this will do.')} Nothing has happened yet.\n`);
  console.log(`  ${c.bold('The core')} ${c.dim('— required; happens automatically')}`);
  for (const s of core) {
    console.log(`    ${c.green('✓')} ${c.bold(s.name)}  ${c.dim('· ' + s.cost)}`);
    console.log(`        ${s.what}`);
  }
  console.log('');

  // FLAG_YES / non-TTY: the caller already decided (agentic-kit, scripted installs). Print the plan,
  // leave PLAN_CHOICES empty, and let each offer honor its own flags/defaults as before. Never block.
  if (FLAG_YES || FLAG_AUTO || !process.stdin.isTTY) {
    console.log(`  ${c.dim('The rest (auto-update, spend watchdog, extras) is handled non-interactively by each step.')}`);
    if (FLAG_PLAN) {
      console.log(`  ${c.dim('--plan: preview only. Nothing was installed.')}\n`);
      process.exit(0);
    }
    console.log(c.dim('  (non-interactive — continuing)\n'));
    return;
  }

  // INTERACTIVE CHECKLIST — decide each optional ONCE, here, instead of being re-asked one by one.
  console.log(`  ${c.bold('Choose the optional pieces')} ${c.dim('— press Enter to accept the [default]; every one is reversible')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askOne = (q, def) => new Promise((resolve) => {
    const suffix = def ? c.dim('[Y/n]') : c.dim('[y/N]');
    rl.question(`  ${def ? c.yellow('●') : c.dim('○')} ${c.bold(q)} ${suffix} `, (a) => {
      const s = String(a).trim().toLowerCase();
      resolve(s === '' ? def : (s === 'y' || s === 'yes'));
    });
  });
  for (const s of optional) {
    console.log(`      ${s.what}`);
    console.log(`      ${c.dim('undo: ' + s.undo)}`);
    // eslint-disable-next-line no-await-in-loop
    PLAN_CHOICES[s.key] = await askOne(s.name + (s.rec ? c.dim(' (recommended)') : ''), s.def);
    console.log('');
  }
  rl.close();

  const on = optional.filter((s) => PLAN_CHOICES[s.key]).map((s) => s.name);
  console.log(`  ${c.green('✓')} Plan set — the core, plus: ${on.length ? c.bold(on.join(', ')) : c.dim('none of the optional pieces')}.`);
  if (FLAG_PLAN) {
    console.log(`  ${c.dim('--plan: preview only. Nothing was installed. Re-run without --plan to apply this.')}\n`);
    process.exit(0);
  }
  console.log(`  ${c.dim('`npx ruvnet-brain --what-changed` lists everything it touched. Installing…')}\n`);
}

// THE CHECKLIST'S ANSWERS, collected ONCE up front in printPlanAndConfirm() and consumed by each
// offer instead of a second serial prompt. The owner's complaint (2026-07-24): the plan screen
// showed everything, then every offer asked again, one at a time. Now you decide once. Empty in the
// non-interactive / --yes / CI paths (printPlanAndConfirm returns before populating it), so every
// offer falls through to its existing flag/default behavior unchanged.
export const PLAN_CHOICES = Object.create(null);
/** The checklist's answer for `key`, or undefined if it wasn't collected (so the offer prompts as before). */
export function plannedChoice(key) { return key in PLAN_CHOICES ? PLAN_CHOICES[key] : undefined; }

export function ask(question, def = false, { blanketYes = true, planKey = null } = {}) {
  if (planKey != null) { const p = plannedChoice(planKey); if (p !== undefined) return Promise.resolve(p); }
  if (FLAG_YES && blanketYes) return Promise.resolve(true);
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? c.dim('[Y/n]') : c.dim('[y/N]');
  return new Promise((resolve) => {
    rl.question(`    ${c.cyan('?')} ${question} ${suffix} `, (a) => {
      rl.close();
      const s = String(a).trim().toLowerCase();
      if (s === '') return resolve(def);
      resolve(s === 'y' || s === 'yes');
    });
  });
}

// `claude mcp add <name> --scope user` writes to the top-level `mcpServers` object in ~/.claude.json
// (NOT ~/.claude/settings.json, and NOT the per-project `projects[cwd].mcpServers` used by the
// default "local" scope). Checking the wrong file/scope is why a successfully-added server can still
// show up as "not found" on the next run.
function hasUserScopeMcpServer(name) {
  try {
    const p = path.join(os.homedir(), '.claude.json');
    if (!fs.existsSync(p)) return false;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Boolean(j.mcpServers && Object.keys(j.mcpServers).some((k) => k.toLowerCase() === name.toLowerCase()));
  } catch {
    return false;
  }
}

// ── detect the user's environment + rUv toolkit (never mutates anything) ──────────────────────────
function detectEnvironment() {
  const nodeMajor = (() => { const m = /^v(\d+)/.exec(process.version); return m ? Number(m[1]) : 0; })();
  const env = {
    node: process.version,
    nodeOK: nodeMajor >= 18,
    platform: process.platform,
    arch: process.arch,
    claude: have('claude'),
    ruflo: have('ruflo') || have('claude-flow'),
    ruvector: have('ruvector') || hasUserScopeMcpServer('ruvector'),
  };
  // Also honor a toolkit that's wired into the Claude config even if the CLI isn't on PATH (npx users).
  try {
    const settings = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settings)) {
      const s = fs.readFileSync(settings, 'utf8');
      if (/claude-flow|\bruflo\b/i.test(s)) env.ruflo = true;
    }
  } catch { /* ignore — detection is best-effort */ }
  return env;
}

// ── issue #39: the ruvector MCP server's own native VectorDb defaults ITS storage to
// "./ruvector.db" relative to whatever cwd it happens to be launched in — and Claude Code
// always launches an MCP server with cwd = the current project, so every consumer project got
// an empty ~1.5MB scaffold dropped in its own root. Traced live (2026-07-24) to
// ruvector/dist/core/intelligence-engine.js `initVectorDb()`, which constructs the native
// VectorDb with `{ dimensions, distanceMetric: 'Cosine' }` and NO storagePath at all — that
// constructor runs unconditionally from a module-level `new Intelligence()` the instant
// `ruvector mcp start` boots. `claude mcp add` has no --cwd flag, and `ruvector mcp start
// --help` documents only `-h` (verified live) — no flag or env var lets us set the storage
// path directly. So the fix has to live in the command we REGISTER: a tiny `node -e` launcher
// that uses child_process's own `cwd` option (no shell, so it behaves the same on Windows) to
// relocate into a fixed cache dir before delegating to the real `npx -y ruvector mcp start`.
// Verified live: this reproduces the exact same empty scaffold, just under
// ~/.cache/ruvnet-brain/ruvector-mcp instead of whatever project happens to be open.
const RUVECTOR_MCP_CWD = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ruvector-mcp');
function buildRuvectorMcpLauncher(cwd) {
  return (
    'const fs=require("fs"),os=require("os"),path=require("path"),cp=require("child_process");' +
    `const d=${JSON.stringify(cwd)};` +
    'fs.mkdirSync(d,{recursive:true});' +
    'const r=cp.spawnSync("npx",["-y","ruvector","mcp","start"],{stdio:"inherit",cwd:d});' +
    'process.exit(r.status==null?1:r.status);'
  );
}
export function buildRuvectorMcpAddCommand(env, cwd = RUVECTOR_MCP_CWD) {
  const launcher = buildRuvectorMcpLauncher(cwd);
  return {
    shell: env.claude ? ['claude', ['mcp', 'add', 'ruvector', '--scope', 'user', '--', 'node', '-e', launcher]] : null,
    say: `claude mcp add ruvector --scope user -- node -e '${launcher}'`,
  };
}

// ── issue #39 mitigation: clean up the empty ruvector.db this bug already left behind in
// projects that installed before this fix landed. Matches ONLY the exact empty-scaffold
// signature (dimensions 384, Cosine, storage_path "./ruvector.db" — literally the string the
// buggy native default writes, verified live byte-for-byte) under a conservative size cap, so
// a real store that just happens to share the filename is never at risk: a populated store
// either exceeds the cap or lacks this exact header.
const RUVECTOR_EMPTY_DB_SIGNATURE =
  '{"dimensions":384,"distance_metric":"Cosine","storage_path":"./ruvector.db","hnsw_config":null,"quantization":null}';
const RUVECTOR_EMPTY_DB_MAX_BYTES = 3 * 1024 * 1024; // observed empty scaffold: 1,589,248 bytes; headroom, still far below any real dataset
export function cleanupStrayRuvectorDb(dir = process.cwd()) {
  const p = path.join(dir, 'ruvector.db');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return false; // doesn't exist — nothing to do
  }
  if (!st.isFile() || st.size === 0 || st.size > RUVECTOR_EMPTY_DB_MAX_BYTES) return false;
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    return false; // unreadable — never guess, just leave it alone
  }
  if (!buf.includes(RUVECTOR_EMPTY_DB_SIGNATURE)) return false;
  try {
    fs.unlinkSync(p);
  } catch {
    return false;
  }
  warn(`removed ${p} — an empty container the ruvector MCP server left in this project before issue #39 was fixed (matched the known empty signature; nothing was stored in it)`);
  return true;
}

// ── step: is the rUv toolkit here? the brain ANSWERS alone; it BUILDS best with Ruflo + RuVector ──
async function offerStack(env) {
  step(
    'Checking your rUv toolkit',
    "the brain answers on its own with zero setup — but it can also BUILD, and that shines when the tools it recommends are here",
  );
  cleanupStrayRuvectorDb(); // issue #39: sweep a leftover scaffold from before this fix, if one's here
  const mark = (ok) => (ok ? c.green('✓ present') : c.yellow('— not found'));
  info(`platform: ${c.bold(`${env.platform}/${env.arch}`)} · node ${c.bold(env.node)}`);
  info(`Ruflo (claude-flow · swarms / SPARC / orchestration): ${mark(env.ruflo)}`);
  info(`RuVector (vector engine · CLI + MCP):                 ${mark(env.ruvector)}`);

  if (env.ruflo && env.ruvector) {
    ok('your full rUv toolkit is here — the brain can orchestrate end-to-end, not just answer');
    return;
  }

  // Grounded canonical commands (verified from rUv's own source: ruflo INSTALLATION.md + ruvector mcp-server.js).
  const missing = [];
  if (!env.ruflo)
    missing.push({
      what: 'Ruflo (orchestration + swarms)',
      shell: env.claude ? ['npm', ['install', '-g', 'claude-flow@alpha']] : null,
      say: 'npm install -g claude-flow@alpha',
      plugin: '/plugin add ruvnet/claude-flow',
      verify: () => have('claude-flow') || have('ruflo'),
    });
  if (!env.ruvector)
    missing.push({
      what: 'RuVector (vectors / RVF)',
      // --scope user: same reason the plugin itself installs at user scope — the brain is "one
      // toolkit, every project", and the default "local" scope ties the server to whatever
      // directory happens to be the cwd when this runs. The registered command itself also
      // pins ITS OWN cwd (issue #39) — see buildRuvectorMcpAddCommand above.
      ...buildRuvectorMcpAddCommand(env),
      plugin: null,
      verify: () => hasUserScopeMcpServer('ruvector'),
    });

  info('');
  info(c.dim("The brain is FULLY working right now for grounded answers — these two optional tools add the \"build it\" muscle:"));

  const printCmds = () =>
    missing.forEach((m) => {
      info(`  ${c.bold(m.what)}: ${c.cyan(m.say)}`);
      if (m.plugin) info(`      ${c.dim(`or in Claude Code: ${m.plugin}`)}`);
    });

  if (FLAG_NO_STACK) {
    info('(--no-stack: skipping. Add them any time with:)');
    printCmds();
    return;
  }

  const yes = FLAG_WITH_STACK || (await ask('Add the missing rUv tools now so the brain can build, not just answer?', false, { planKey: 'stack' }));
  if (!yes) {
    info("No problem — nothing's missing for answers. To add the build tools any time:");
    printCmds();
    return;
  }

  for (const m of missing) {
    if (m.shell) {
      info(`installing ${m.what} … ${c.dim(m.say)}`);
      const ran = tryRun(m.shell[0], m.shell[1]);
      // Don't trust the exit code alone — e.g. `claude mcp add` exits non-zero on "already exists",
      // which is functionally success. Re-check the real state (m.verify) before warning.
      if (ran || (m.verify && m.verify())) ok(`${m.what} added`);
      else warn(`couldn't auto-add ${m.what}; run it yourself: ${c.bold(m.say)}${m.plugin ? `  (or ${m.plugin})` : ''}`);
    } else {
      info(`${m.what}: run ${c.bold(m.say)}${m.plugin ? `  ${c.dim(`(or ${m.plugin} in Claude Code)`)}` : ''}`);
    }
  }
  if (missing.some((m) => m.plugin))
    info(c.dim('Tip: the Claude Code plugin path (/plugin add ruvnet/claude-flow) also wires Ruflo\'s MCP + slash commands.'));
}

// ── step: teach the user's Claude to lean on the brain (opt-in, idempotent, marker-guarded) ───────
const CLAUDE_MD_START = '<!-- ruvnet-brain:start -->';
const CLAUDE_MD_END = '<!-- ruvnet-brain:end -->';
const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
## RuvNet Brain (installed · user-level · works in every project)
This machine has the RuvNet Brain. When a task touches rUv's stack — RuVector/RVF, Ruflo (claude-flow),
AgentDB, SPARC, agentic-flow, agenticow, QuDAG, SAFLA, RuLake — GROUND answers in real source via the
\`search_ruvnet\` MCP tool BEFORE asserting what any tool can do; training priors on this stack are stale.
Prefer rUv-native primitives (RVF over Pinecone/pgvector, Ruflo over LangChain, AgentDB over ad-hoc memory).
Not sure it's active? Run \`npx ruvnet-brain --doctor\`.
${CLAUDE_MD_END}`;

export async function offerClaudeMd() {
  if (FLAG_NO_ENHANCE) return;
  const p = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  let existing = '';
  try { existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { /* ignore */ }
  if (existing.includes(CLAUDE_MD_START)) { return; } // already there — idempotent, stay silent

  // DON'T ASK WHEN IT ADDS NOTHING. If the plugin is installed, its hooks already enforce grounding
  // on every turn and this block is pure duplication — the old skip-branch message said exactly that
  // out loud. Asking to edit the most sensitive file we touch, for a benefit the user already has,
  // is how a helpful tool starts feeling invasive. So the question is only worth someone's attention
  // when the plugin is absent, which is a real population (see the "Unknown command: /rvbc" report)
  // but not the common one.
  if (pluginCommandsDir()) return;

  step(
    'Optional — a note in your global CLAUDE.md',
    "so Claude leans on the brain in projects where the plugin's hooks aren't running",
  );
  // Say precisely what changes on their disk, in their words, BEFORE asking. "Enhance your CLAUDE.md"
  // is the kind of phrasing that makes a careful person assume the worst — and on a managed machine
  // that file may be governed. Six lines at the bottom, markers, reversible, backed up: all of that
  // is far less alarming than the vague version, and it happens to be the whole truth.
  info(`Adds ${c.bold('6 lines to the BOTTOM')} of ${c.bold('~/.claude/CLAUDE.md')}, wrapped in`);
  info(`  ${c.dim('<!-- ruvnet-brain:start -->')} … ${c.dim('<!-- ruvnet-brain:end -->')}`);
  info(`Nothing already in the file is changed or removed. Delete the block any time.`);
  info(`${c.green("We back the file up first")}, and re-running never adds it twice.`);
  info(c.dim(`Honestly: if you install the plugin, you don't need this — its hooks already do it.`));

  const yes =
    FLAG_ENHANCE_CLAUDE_MD ||
    // blanketYes:false — editing a file THEY own is not something a blanket `-y` gets to decide.
    (await ask('Add it?', false, { blanketYes: false }));
  if (!yes) {
    info(`No problem, skipped — add it any time with  ${c.bold('npx ruvnet-brain --enhance-claude-md')}`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Back up before touching it — the same courtesy this installer already extends to settings.json,
    // and this is the more sensitive file of the two.
    let backup = null;
    if (existing) {
      backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(p, backup);
    }
    const next = existing ? `${existing.replace(/\s*$/, '')}\n\n${CLAUDE_MD_BLOCK}\n` : `${CLAUDE_MD_BLOCK}\n`;
    // ATOMIC write — temp sibling then rename. The content was always a pure append, but the old
    // code rewrote the whole file in place, so an interruption (disk full, power loss) could leave
    // a TRUNCATED CLAUDE.md. Fine 999 times out of 1000 and unforgivable the other time. This is the
    // discipline rUv already applies to credential files (cognitum-seed cloud_key.rs: tmp → rename).
    const tmp = `${p}.ruvnet-tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, p);
    ok(`added 6 lines to the bottom of ${p}`);
    if (backup) info(c.dim(`  your original is saved at ${backup}`));
    info(c.dim(`  to remove: delete the block between the two ruvnet-brain markers`));
  } catch (e) {
    warn(`couldn't update CLAUDE.md (${e.message}) — your file is untouched, and this was optional anyway`);
  }
}

// ── step: OPT-IN status-bar version segment — "which RuvNet Brain am I on?" at a glance ───────────
// Claude Code renders its status bar from `statusLine.command` in ~/.claude/settings.json (verified
// live: code.claude.com/docs/en/statusline — `{ type: "command", command: "<script>", padding? }`;
// Claude Code pipes JSON session data to the command's stdin, and whatever it prints to stdout
// becomes the line). Users often already have a rich statusline (git branch, context %, other tool
// versions) — silently replacing it would be exactly the clobber this installer refuses to do
// anywhere else. So: detect first, and only ADD a statusLine when NONE exists. If one is already
// wired, settings.json is never touched — we hand back the helper's path so it can be folded into
// their own script instead. Asked once ever (pref file, same contract as .telemetry-consent): a
// "no", or a silent non-interactive run with no explicit flag, never gets re-asked or half-applied.
// .cjs (CommonJS), not .mjs: measured live on this machine (Node 22) — the ESM loader costs the
// statusline ~4-5ms extra per invocation versus a plain `require()` script (median 50.4ms vs
// 46.7ms across 30 interleaved runs of otherwise-identical logic), which is the difference between
// sitting under the <50ms budget and blowing past it on every single prompt. `.cjs` forces
// CommonJS unambiguously regardless of any stray package.json a user's HOME might contain.
const STATUSLINE_HELPER_NAME = 'ruvnet-brain-statusline.cjs';
// Exported (ADR-058 D5): the coexistence suite reconstructs the exact "ours" command string under
// an overridden HOME, so the settings.json byte-preservation claim is measured against the real
// path computation rather than a hand-copied guess.
export const statuslineHelperPath = () => path.join(telemetryStateDir(), STATUSLINE_HELPER_NAME);
const statuslinePrefPath = () => path.join(telemetryStateDir(), '.statusline-pref');
const settingsJsonPath = () => path.join(os.homedir(), '.claude', 'settings.json');

// Self-contained, dependency-free script Claude Code's statusLine command runs on EVERY prompt — it
// must stay well under budget, so it's a single sync read with no imports beyond node builtins.
// Reads the version LIVE from the installed bundle's SOURCE.json (releaseTag) — never hardcoded, so
// it always matches whatever is actually on disk. Degrades to silent empty output on ANY failure
// (brain not installed, file unreadable, malformed JSON) — a missing/broken brain must never break
// the rest of the user's statusline.
const STATUSLINE_HELPER_SRC = `#!/usr/bin/env node
// ruvnet-brain-statusline.cjs — one segment for Claude Code's statusLine command.
// See https://code.claude.com/docs/en/statusline. Written by the installer's --statusline offer.
// Prints "RuvNet Brain v<version>" read LIVE from the installed bundle's SOURCE.json — never
// hardcoded. Any failure (brain missing, unreadable, malformed JSON) degrades to empty output so
// a broken or missing brain can never break the rest of the status line. CommonJS on purpose —
// measurably faster to start than ESM for a script this runs on every single prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');

try {
  const kbDir = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
  const j = JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8'));
  const raw = String(j.releaseTag || '');
  if (/^[A-Za-z0-9._-]{1,32}$/.test(raw)) {
    process.stdout.write('RuvNet Brain ' + (raw.startsWith('v') ? raw : 'v' + raw));
  }
} catch { /* not installed / unreadable — print nothing, never break the statusline */ }
`;

function writeStatuslineHelper() {
  const dst = statuslineHelperPath();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, STATUSLINE_HELPER_SRC, { mode: 0o755 });
  return dst;
}

// Pure read — NEVER writes. Exported so detection is independently testable
// (RUVNET_BRAIN_IMPORT_ONLY=1) with zero risk of mutating a real settings.json.
export function detectStatusLine(settingsPath = settingsJsonPath()) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return { path: settingsPath, exists: false, hasStatusLine: false, command: null, parseError: false, json: {} };
  }
  try {
    const j = raw.trim() ? JSON.parse(raw) : {};
    const sl = j && typeof j === 'object' ? j.statusLine : null;
    const command = sl && typeof sl.command === 'string' ? sl.command : null;
    return { path: settingsPath, exists: true, hasStatusLine: Boolean(command), command, parseError: false, json: j };
  } catch {
    return { path: settingsPath, exists: true, hasStatusLine: false, command: null, parseError: true, json: null };
  }
}

// Same `.bak-<ISO timestamp>` convention used elsewhere in this project (see onboarding-console.mjs's
// config backup) — always taken before an EXISTING file is touched, never before a brand-new one.
function backupSettingsJson(settingsPath) {
  const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(settingsPath, backup);
  return backup;
}

// Exported (ADR-058 D5): same testability contract as wireCodexHost — the coexistence suite calls
// this directly against a scratch settings.json rather than reaching for the CLI, so the invariant
// under test is the real write path, never a reimplementation of it.
export function writeSettingsStatusLine(detected, command) {
  const backup = detected.exists ? backupSettingsJson(detected.path) : null;
  const next = { ...(detected.json || {}), statusLine: { type: 'command', command } };
  fs.mkdirSync(path.dirname(detected.path), { recursive: true });
  fs.writeFileSync(detected.path, JSON.stringify(next, null, 2) + '\n');
  return backup;
}

// The uninstall-side mirror of writeSettingsStatusLine() above — this installer is the ONLY writer
// that can safely reverse this specific edit, because it is the only one that knows the EXACT string
// it wrote. Match on that exact command (never a loose "mentions ruvnet-brain" guess — see the
// machineFootprint() comment this replaces) so a status line the user has since folded their own
// script into, or edited by hand, is left completely alone. Same "refuse rather than guess"
// discipline removeClaudeMdBlock() already applies to CLAUDE.md, and the same backup-first courtesy.
// Exported (ADR-058 D5): the uninstall-side mirror, made independently callable for the same
// reason as writeSettingsStatusLine above.
export function removeSettingsStatusLine() {
  const settingsPath = settingsJsonPath();
  const detected = detectStatusLine(settingsPath);
  if (!detected.exists || detected.parseError || !detected.hasStatusLine) return 'absent';
  const ours = `node "${statuslineHelperPath()}"`;
  if (detected.command !== ours) return 'not-ours'; // never touch a status line we didn't write
  try {
    const backup = backupSettingsJson(settingsPath);
    const next = { ...(detected.json || {}) };
    delete next.statusLine;
    const tmp = `${settingsPath}.ruvnet-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath);
    info(c.dim(`  your original is saved at ${backup}`));
    return 'removed';
  } catch (e) {
    warn(`couldn't remove the statusLine entry (${e.message}) — remove it yourself from ${settingsPath}`);
    return 'error';
  }
}

// Only called after explicit consent. NEVER overwrites an existing statusLine — detectStatusLine()
// is the single source of truth for "is one already there", checked fresh right before any write.
function applyStatusline() {
  const helperPath = writeStatuslineHelper();
  ok(`installed the version-segment script → ${c.bold(helperPath)}`);
  const command = `node "${helperPath}"`;

  const detected = detectStatusLine();

  if (detected.parseError) {
    warn(`${detected.path} isn't valid JSON — leaving it untouched (never merging into a file I can't parse).`);
    info(`Add this to it yourself once it's fixed:`);
    info(`  ${c.bold(`"statusLine": { "type": "command", "command": "${command}" }`)}`);
    return 'manual-parse-error';
  }

  if (detected.hasStatusLine) {
    ok(`you already have a status line (${c.dim(detected.command)}) — leaving it exactly as is.`);
    info(`To fold the brain version in, have your own script also run this and print the result:`);
    info(`  ${c.bold(command)}`);
    return 'existing-preserved';
  }

  try {
    const backup = writeSettingsStatusLine(detected, command);
    if (backup) ok(`backed up your settings to ${c.bold(backup)} before editing`);
    ok(`status line set in ${c.bold(detected.path)} — restart Claude Code to see it`);
    return 'set';
  } catch (e) {
    warn(`couldn't write ${detected.path} (${e.message}) — add it yourself:`);
    info(`  ${c.bold(`"statusLine": { "type": "command", "command": "${command}" }`)}`);
    return 'write-error';
  }
}

// Exported (testable under RUVNET_BRAIN_IMPORT_ONLY=1, like offerTelemetry). Never throws — the
// caller also guards, because a finished install must never be broken by an optional offer.
export async function offerStatusline() {
  if (TEST_MODE) return 'suppressed'; // tests: never prompt, never write, never touch settings.json
  const prefPath = statuslinePrefPath();
  if (fs.existsSync(prefPath)) {
    // asked once ever — respect the answer, never re-ask. (Delete the file to be asked again.)
    let pref = '';
    try { pref = fs.readFileSync(prefPath, 'utf8').trim().toLowerCase(); } catch { /* treat as declined */ }
    return pref === 'yes' ? 'already-on' : 'already-set';
  }

  if (FLAG_NO_STATUSLINE) {
    try { fs.mkdirSync(telemetryStateDir(), { recursive: true }); fs.writeFileSync(prefPath, 'no\n'); } catch { /* best-effort */ }
    return 'declined-flag';
  }

  step(
    'Optional: show the brain version in your status bar',
    "so you can always tell at a glance which RuvNet Brain version you're on",
  );
  info(`Adds a small ${c.bold('"RuvNet Brain vX.Y.Z"')} segment, read live from your installed brain — it`);
  info(`updates itself the moment the brain updates. ${c.bold('Never overwrites an existing status line.')}`);

  // FLAG_YES deliberately does NOT appear here. This writes ~/.claude/settings.json — a file the
  // USER owns — and installs a script Claude Code then executes on EVERY PROMPT. An adversarial
  // review caught that a blanket `-y` on a non-TTY still did both, which made the security fix in
  // 9ad02f5 ("`-y` can no longer install a daemon or edit a global config file") FALSE as written:
  // the two functions that commit gated were the two I happened to be thinking about, and this
  // third one — higher-frequency persistent execution than the LaunchAgent — was never checked.
  // Same footprint rule as everywhere else: their config, their explicit yes.
  const interactive = process.stdin.isTTY || FLAG_STATUSLINE;
  if (!interactive) {
    // No terminal to ask on, and no explicit flag either — skip WITHOUT recording an answer, so a
    // future interactive (or flagged) run still gets a real chance to ask.
    info(`No interactive terminal here, so I won't assume — skipping for now.`);
    info(`Add it any time:  ${c.bold('npx ruvnet-brain --statusline')}`);
    return 'not-asked';
  }

  const yes = FLAG_STATUSLINE || (await ask('Add a RuvNet Brain version segment to your Claude Code status bar?', false, { blanketYes: false, planKey: 'statusline' }));

  try {
    fs.mkdirSync(telemetryStateDir(), { recursive: true });
    fs.writeFileSync(prefPath, yes ? 'yes\n' : 'no\n');
  } catch (e) {
    warn(`couldn't record the answer (${e.message})`);
  }

  if (!yes) {
    info(`No problem — add it any time:  ${c.bold('npx ruvnet-brain --statusline')}`);
    return 'declined';
  }

  return applyStatusline();
}

// ── final success block ──────────────────────────────────────────────────────────────────────────
function installedRepoCount(cacheDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'));
    return Array.isArray(manifest.builtRepos) && manifest.builtRepos.length
      ? String(manifest.builtRepos.length)
      : 'dozens of';
  } catch {
    return 'dozens of';
  }
}

function success({ cacheDir, isCustom, plugin, env, nightly }) {
  const line = '─'.repeat(64);
  console.log(`\n${c.green(line)}`);
  console.log(`${c.green(c.bold('  RuvNet Brain is installed.'))}`);
  console.log(`${c.green(line)}`);
  console.log(`\n  What you now have:`);
  console.log(`    • the brain (embedded source of ${installedRepoCount(cacheDir)} RuvNet repos) at:`);
  console.log(`        ${c.bold(cacheDir)}`);
  console.log(
    `    • the Claude Code plugin ${plugin.wired ? c.green('wired at user scope') : c.yellow('(finish the 2 commands above)')} — search_ruvnet + grounding hook`,
  );
  if (env) {
    const t = (okv) => (okv ? c.green('✓ present') : c.yellow('not added (optional)'));
    console.log(`    • rUv build toolkit — Ruflo: ${t(env.ruflo)} · RuVector: ${t(env.ruvector)}  ${c.dim('answers work without them')}`);
  }
  if (isCustom) {
    console.log(`\n  ${c.yellow('Heads up:')} you installed to a custom dir, so make this export permanent`);
    console.log(`  (add it to your shell profile) so the plugin can find the brain:`);
    console.log(`    ${c.bold(`export RUVNET_BRAIN_KB="${cacheDir}"`)}`);
  }
  // ── where + how it runs — the confidence answers, stated up front ──
  console.log(`\n  ${c.bold('Where it runs:')} ${c.bold('everywhere you use Claude Code')} — CLI, VS Code, JetBrains, the desktop app.`);
  console.log(`    It's ${c.bold('user-level (global)')}: open ANY repo or folder and it's already there. Nothing per project,`);
  console.log(`    nothing to copy in, nothing to git-ignore. ${c.dim('(Runs locally — it is not active in the claude.ai web app.)')}`);
  console.log(`\n  ${c.bold('How it runs:')} ${c.bold('automatically')} — you never call or configure anything. Ask normally; on rUv-stack work it`);
  console.log(`    grounds in real source and cites it, and if you drift to a classical default it steps in with the rUv option.`);
  console.log(`\n  ${c.bold('Keep it fresh:')} re-run ${c.bold('npx ruvnet-brain')} any time — the brain itself always pulls the latest`);
  console.log(`  Release regardless (that part isn't cached). For the bleeding-edge installer too, use ${c.bold('npx github:stuinfla/ruvnet-brain')}.`);

  // ── one important expectation: the hook activates on the NEXT session ──
  console.log(`\n  ${c.yellow(c.bold('One thing to know:'))} the grounding hook turns on at your ${c.bold('next')} Claude Code session.`);
  console.log(`  ${c.dim('If Claude Code is open right now, quit and reopen it — then the brain is live on every prompt.')}`);

  // ── what to do now ──
  console.log(`\n  ${c.bold('What to do now:')}`);
  console.log(`    ${c.cyan('1.')} Open Claude Code in ${c.bold('any')} project (your own, or a fresh repo — nothing to copy in).`);
  console.log(`    ${c.cyan('2.')} Just ask, normally. Try:  ${c.bold('"Set up vector search here the way rUv would."')}`);
  console.log(`    ${c.cyan('3.')} Watch what changes (below).`);

  // ── how you'll KNOW it's working ──
  console.log(`\n  ${c.bold('How you\'ll know it\'s working:')}`);
  console.log(`    ${c.green('✓')} Claude reaches for ${c.bold('RuVector / RVF, Ruflo, AgentDB')} instead of Pinecone / pgvector / LangChain.`);
  console.log(`    ${c.green('✓')} It ${c.bold('cites real source paths')} (it calls ${c.bold('search_ruvnet')}) instead of guessing.`);
  console.log(`    ${c.green('✓')} If you start to drift to a generic default, the brain ${c.bold('steps in')} and points you back.`);

  // ── honest expectations ──
  console.log(`\n  ${c.bold('What to expect (honestly):')}`);
  console.log(`    • On rUv-stack work (vectors, swarms, agent memory, SPARC) it grounds ${c.bold('every time')}.`);
  console.log(`    • On unrelated work, it stays quiet — Claude behaves normally. It only speaks up when it should.`);
  console.log(`    • Not sure it's on?  Run  ${c.bold('npx ruvnet-brain --doctor')}  any time for a health check.
    • Want to see it answer, live, right now?  ${c.bold('npx ruvnet-brain --demo')}  — 2 real questions, real cited answers.`);

  console.log(`\n  ${c.bold('Set it up your way:')} this default is ${c.bold('global')} — live in every VS Code project automatically,`);
  console.log(`    which is what most people want. Want it different (project-only, moved, with the build stack`);
  console.log(`    added)? ${c.bold('Just tell Claude')} once it's on. You never have to learn its internals.`);

  if (nightly === 'enabled' || nightly === 'already-on') {
    // The offer just above turned nightly on (or found it on) — don't contradict that here.
    console.log(`\n  ${c.bold('Staying current:')} nightly auto-updates are ${c.green(c.bold('ON'))} — your brain refreshes itself at 03:47.`);
    console.log(`    • update right now anyway:  ${c.bold('npx ruvnet-brain --update')}   ${c.dim('· turn nightly off: --disable-nightly')}`);
    console.log(`    ${c.dim('It only advances when a new Release is actually published — a quiet night is a clean no-op.')}`);
  } else {
    console.log(`\n  ${c.bold('Staying current:')} nightly updates are ${c.bold('OFF right now')} — nothing runs on your machine unasked.`);
    console.log(`    • one-shot check + update now:   ${c.bold('npx ruvnet-brain --update')}`);
    console.log(`    • nightly at 03:47 (macOS):      ${c.bold('npx ruvnet-brain --enable-nightly')}   ${c.dim('· off again: --disable-nightly')}`);
    console.log(`    • Linux/Windows: the cron line documented in the brain's own ${c.bold('forge-update.mjs')}`);
    console.log(`    ${c.dim('Either way, your copy only advances when a new Release is actually published.')}`);
  }

  // One tasteful ask, at the moment the value was just delivered — never repeated by the plugin
  // more than once ever (see session-start.sh's stamped one-liner).
  console.log(`\n  ${c.bold('If it earns it:')} a GitHub star helps other people find the brain —`);
  console.log(`    ${c.bold('https://github.com/stuinfla/ruvnet-brain')}   ${c.dim('· feedback in one command: npx ruvnet-brain --feedback')}`);

  console.log(`\n  ${c.dim('You can\'t break anything — the plugin is disable-able and only acts on RuvNet-shaped work.')}`);
  console.log('');
}

function showHelp() {
  console.log(`
RuvNet Brain installer

By default this installs the LATEST published Release (it asks GitHub which one that is),
and falls back to a known-good version if GitHub can't be reached.

Usage:
  npx ruvnet-brain                         Install the brain + Claude Code plugin (recommended, npm)
  npx github:stuinfla/ruvnet-brain         Same, but from the bleeding-edge GitHub commit
  npx ruvnet-brain --doctor   Health-check an existing install (green/red per part).
                              EXITS NON-ZERO when the install is genuinely broken, so it can gate a
                              script:  npx ruvnet-brain --doctor && ./deploy.sh
  npx ruvnet-brain --doctor --hooks
                              …and additionally fire every hook this plugin registered on THIS
                              machine through the real shim under four stdin regimes (valid event
                              JSON, empty EOF, 1MB garbage, and stdin held open past budget), with an
                              external process-group watchdog. Asserts each hook's declared exit
                              codes, a 4KB stdout cap, its declared timeout with margin, and zero
                              surviving descendants. Your own hooks are listed, never executed.
  npx ruvnet-brain --demo     Guided walkthrough — 2 real questions, real cited answers
  npx ruvnet-brain --feedback Tell us how it went — prefills a GitHub Discussion with your brain
                              version, platform, and a 3-line health summary (you see exactly
                              what's in it; never your queries, code, or paths), then opens it
  npx ruvnet-brain --update   One-shot: pull the latest Release bundle into your installed brain
                              (runs the bundle's own forge-update.mjs --apply: backup + re-verify)
  npx ruvnet-brain --enable-nightly    Schedule that update nightly at 03:47 — macOS LaunchAgent;
                              other platforms get the documented cron line. OFF by default.
  npx ruvnet-brain --disable-nightly   Remove the nightly schedule (safe to run any time)
  npx ruvnet-brain --what-changed     Show exactly what RuvNet Brain has put on this machine,
                              with the undo command for each piece
  npx ruvnet-brain --uninstall        Remove all of it (bundle, LaunchAgents, and our CLAUDE.md
                              block only — your own CLAUDE.md content is preserved and backed up)
  npx ruvnet-brain --enable-spend-guard   Install the hourly runaway-agent spend alarm (alert-only)
  npx ruvnet-brain --disable-spend-guard  Remove it (safe to run any time)
  npx ruvnet-brain --enhance-claude-md    Add the 6-line RuvNet-Brain block to ~/.claude/CLAUDE.md
                              (appended at the bottom between markers; your file is backed up first)
                              (a default install RECOMMENDS nightly and asks, defaulting to yes)
  node bin/install.mjs --no-nightly-prompt Don't offer nightly auto-updates at the end of the install
  node bin/install.mjs --no-telemetry      Decline anonymous usage counts without being asked
                              (counts of installs/searches ONLY — never queries, code, or paths;
                              opt-in prompt appears once at install; answer lives in a plain file:
                              ~/.cache/ruvnet-brain/.telemetry-consent)
  node bin/install.mjs --version <tag>     Install a specific Release tag (e.g. --version v0.5.0-dev)
  node bin/install.mjs --pin               Skip the latest-check; use the bundled known-good version
  node bin/install.mjs --local             Install from a repo clone's assembled dist/ruvnet-brain/
  node bin/install.mjs --force             Re-fetch and reinstall even if already present
  node bin/install.mjs --no-verify         Skip the post-install verify + warm-up smoke test
  node bin/install.mjs --with-stack        Also add missing Ruflo / RuVector (no prompt)
  node bin/install.mjs --no-stack          Don't offer to add Ruflo / RuVector
  node bin/install.mjs --enhance-claude-md Add a RuvNet-Brain section to ~/.claude/CLAUDE.md (no prompt)
  node bin/install.mjs --no-enhance        Don't offer the CLAUDE.md section
  node bin/install.mjs --statusline        Add a "RuvNet Brain vX.Y.Z" segment to your Claude Code
                              status bar (no prompt). Never overwrites an existing status line — if
                              you already have one, this only prints a snippet to fold it into yours.
  node bin/install.mjs --no-statusline     Don't offer the status-bar segment
  node bin/install.mjs --yes, -y           Accept every optional offer (good for scripted installs)

Env:
  RUVNET_BRAIN_KB       Override where the brain is stored (default ~/.cache/ruvnet-brain/kb)
  RUVNET_STRICT_INSTALL Make an unproven grounding smoke FATAL (default: never — a first-run model
                        download or an air-gapped machine is not a broken install). Only ever set
                        this for a locked-down environment where you want to know immediately.

It is safe to re-run at any time. After installing, restart Claude Code so the grounding hook loads.
`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  if (IMPORT_ONLY) return; // imported for its exports (tests) — never run the installer as a side effect
  if (FLAG_HELP) return showHelp();
  // `process.exitCode`, not `return` — doctor()'s verdict is the whole point of running it in a
  // script. A bare `return await doctor()` discarded the number, which is how "! Needs attention"
  // and `echo $?` → 0 coexisted for so long.
  if (FLAG_DOCTOR) { process.exitCode = await doctor(); return; }
  if (FLAG_DEMO) return runDemo();
  if (FLAG_FEEDBACK) return runFeedback();
  if (FLAG_UPDATE) return runUpdate();
  if (FLAG_ENABLE_NIGHTLY) return enableNightly();
  if (FLAG_DISABLE_NIGHTLY) return disableNightly();
  // Standalone, like the nightly pair above. Without these, the flags existed only as a way to
  // pre-answer a prompt DURING a full install — so the copy telling someone to "add it later with
  // npx ruvnet-brain --enable-spend-guard" would have kicked off an entire reinstall instead of the
  // small targeted action they asked for. Promised in the UI, therefore real here.
  if (FLAG_ENABLE_SPEND_GUARD) { enableSpendGuard(); return; }
  if (FLAG_DISABLE_SPEND_GUARD) { disableSpendGuard(); return; }
  if (FLAG_UNINSTALL) { uninstallAll(); return; }
  if (FLAG_WHAT_CHANGED) { printBanner('what RuvNet Brain put on this machine'); printFootprint(); return; }

  printBanner('installer');
  console.log(c.dim("I'll set up the brain and the Claude Code plugin, explaining each step as I go.\n"));

  // ── environment guard: fail early and CLEARLY on unsupported Node, not cryptically mid-install ──
  // Node itself can't be silently auto-upgraded from inside a script it's currently running as —
  // that's the running process replacing its own runtime, which is invasive and can go wrong in
  // platform-specific ways (permissions, competing version managers). The safe, correct move is to
  // hand back the exact right one-liner for the platform actually in front of us.
  {
    const m = /^v(\d+)/.exec(process.version);
    const major = m ? Number(m[1]) : 0;
    if (major && major < 18) {
      const fix = IS_WIN
        ? `Update Node (pick one):\n  • winget install OpenJS.NodeJS.LTS\n  • or download the LTS installer: https://nodejs.org`
        : process.platform === 'darwin'
          ? `Update Node (pick one):\n  • brew install node\n  • or: nvm install 20 && nvm use 20 (https://nodejs.org)`
          : `Update Node (pick one):\n  • nvm install 20 && nvm use 20\n  • or your distro's Node 20+ package (see https://nodejs.org)`;
      die(`RuvNet Brain needs Node 18 or newer — you're on ${process.version}.`, `${fix}\nThen re-run this same command — everything else is ready.`);
    }
  }

  await printPlanAndConfirm();

  const { cacheDir, isCustom } = resolveCacheDir();

  // ── "ALREADY PRESENT" IS THE WRONG QUESTION — ask "already CURRENT" ──────────────────────────
  //
  // THE STALE-INSTALL TRAP, and the root cause of "users are still on 0.5". This used to skip the
  // download whenever forge-mcp-all.mjs merely EXISTED — a pure file-existence check, no version
  // anywhere in it. So a June v0.5 brain made `alreadyInstalled` true, the download was skipped,
  // and the installer went on to print its success banner. Re-running the installer — the fix we
  // ADVERTISE in recovery messages — refreshed the reader and the plugin wiring and left the actual
  // brain untouched, forever. A closed trap: the advertised escape hatch was the thing that failed.
  //
  // The honest question is whether the installed brain is CURRENT, so that is what we now ask.
  // Fail-safe by design: if the version cannot be resolved (offline, API rate limit) we keep the
  // old skip behaviour rather than force a 2 GB download on someone with no network — but we SAY
  // that is what happened, instead of implying everything is up to date.
  const alreadyInstalled = fs.existsSync(path.join(cacheDir, 'forge-mcp-all.mjs'));
  let staleSkip = false;
  let ahead = false;
  let installedTag = null;
  let latestTag = null;
  let resolvedRelease = null;   // reused below so the release is resolved at most once
  if (alreadyInstalled && !FLAG_FORCE) {
    installedTag = installedBrainVersion(cacheDir); // 'unknown' when SOURCE.json has no releaseTag
    try {
      resolvedRelease = await resolveRelease();
      // ONLY a genuine `latest` lookup counts as "what current means". resolveRelease() does NOT
      // throw when the GitHub API fails — it returns the hardcoded known-good pin with
      // source:'fallback'. Treating that as latest inverts this whole fix: a rate-limited lookup
      // would report installed v3.4.21-dev "→ latest v2.9.0" and DOWNGRADE a perfectly current
      // machine. (Caught by exercising the failure path against a 404 repo — the first version of
      // this fix did exactly that.) A pinned/forced resolution is likewise the operator's explicit
      // choice, not a staleness verdict, so neither drives this comparison.
      latestTag = resolvedRelease && resolvedRelease.source === 'latest'
        ? (resolvedRelease.tag_name || resolvedRelease.tag || null)
        : null;
    } catch { latestTag = null; }
    const norm = (v) => (v == null || v === 'unknown' ? null : String(v).replace(/^v/, ''));
    const a = norm(installedTag), b = norm(latestTag);
    // BEHIND => download. SAME => skip. AHEAD => skip, and say so honestly.
    //
    // This was a bare `a !== b`, which treats "newer than the latest release" as staleness. Anyone
    // running a pre-release or dev build — or who simply updated in the window before a release was
    // cut — was told "Brain is out of date" and pushed through a 2 GB download that would DOWNGRADE
    // them. Found 2026-07-22 the moment this repo's own version moved to 3.5.0-dev ahead of the
    // 3.4.22-dev release: the installer immediately declared its own newest brain stale.
    //
    // stack-sync.mjs has modelled AHEAD as legal from the start ("AHEAD is legal and produces NO
    // recommendation — that modelling choice is what makes the alpha-vs-latest downgrade war
    // structurally impossible"). The installer never learned the same lesson. It has now.
    ahead = Boolean(a && b && cmpTag(a, b) > 0);
    staleSkip = Boolean(b && (a === null || (a !== b && !ahead)));
  }

  if (alreadyInstalled && !FLAG_FORCE && !staleSkip) {
    if (latestTag && ahead) {
      // Never silently imply equality when the user is AHEAD — that would be a small lie, and it is
      // the one that hides a downgrade. Skipping is right; misdescribing why is not.
      step('Brain already current — skipping the download', `installed ${installedTag} is NEWER than the latest release (${latestTag})`);
      ok(`found an up-to-date brain at ${cacheDir} — nothing to download, and we will never downgrade you`);
    } else if (latestTag) {
      step('Brain already current — skipping the download', `installed ${installedTag} matches the latest release`);
      ok(`found an up-to-date brain at ${cacheDir}`);
    } else {
      // Could not check. Say so plainly rather than letting silence imply "current".
      step('Brain present — could not check for a newer one', 'the release lookup failed (offline or rate-limited)');
      warn(`skipping the download WITHOUT verifying it is current. Installed: ${installedTag || 'unknown'}.`);
      info(`When you have a connection:  ${c.bold('npx ruvnet-brain --update')}   ${c.dim('(or --force to refetch now)')}`);
    }
  } else {
    if (staleSkip) {
      step('Brain is out of date — fetching the current release', `installed ${installedTag || 'unknown'} → latest ${latestTag}`);
      info(`${c.dim('(the old installer skipped this whenever any brain was present, which is why stale installs never moved)')}`);
    }
    // Resolve which Release to fetch BEFORE downloading. Skipped entirely on the --local path
    // (obtainBundle short-circuits to the repo's assembled dist/ directory and never touches the network).
    const localZipPresent =
      FLAG_LOCAL || fs.existsSync(path.join(REPO_ROOT, 'dist', 'ruvnet-brain.zip'));
    // Reuse the staleness check's resolution when it already ran — one network round-trip, not two.
    const release = localZipPresent ? null : (resolvedRelease || await resolveRelease());
    const { zipPath, sourceDir, tmpDir, downloaded, sigError } = await obtainBundle(release);
    // Verify the Ed25519 signature BEFORE extracting a downloaded bundle into the user's config
    // (SEC-0010 #6 — trust root = the pubkey EMBEDDED in this file, so an attacker who swaps the
    // bundle cannot also swap the key it is checked against).
    //
    // SIGNING_REQUIRED was `false` transitionally, for releases that predated signing. That is over:
    // every release from v2.0.0 on is signed, including the pinned offline fallback (RELEASE_VERSION).
    // Leaving it false left a real downgrade path — strip or 404 the small .sig file and the missing-
    // signature branch printed a warning and extracted 800MB+ of executable .mjs anyway. No alarm
    // fired, because no signature was ever obtained. Now a missing signature fails closed like an
    // invalid one, and --no-verify remains the single explicit, user-chosen override.
    const SIGNING_REQUIRED = true;
    if (downloaded && !FLAG_NO_VERIFY) {
      const sigPath = `${zipPath}.sig`;
      const hasSig = fs.existsSync(sigPath);
      if (!hasSig) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        die(`no signature published alongside this release — refusing to extract an unverified bundle${sigError ? `\n  (signature fetch failed: ${sigError})` : ''}`,
            `Every release from v2.0.0 on is signed, so a missing signature means the download was\nincomplete, blocked, or tampered with. Re-run to fetch a fresh copy. If it persists, report it.\n(Override at your own risk with ${c.bold('--no-verify')}.)`);
      } else {
        step('Verifying the bundle signature', 'so a tampered or MITM-swapped download can never be extracted');
        const { ok: valid, reason } = verifyBundle(zipPath, sigPath);
        if (!valid) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
          die(`bundle signature check FAILED — ${reason}`,
              `Refusing to extract an unverified bundle. Re-run to fetch a fresh copy; if it persists, the\nrelease may be tampered — report it. (Override at your own risk with ${c.bold('--no-verify')}.)`);
        }
        ok(reason);
      }
    }
    await unzipInto(zipPath, cacheDir, sourceDir);
    const brainProfile = readBrainProfile();
    if (brainProfile !== 'complete') {
      const scoped = applyBrainProfile(cacheDir, brainProfile);
      ok(`${brainProfile} profile preserved (${scoped.stores.join(', ')} kept; ${scoped.removed.length} unselected artifact(s) removed)`);
    }
    if (downloaded && tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave temp behind, not fatal */ }
    }
  }

  installReader(cacheDir);
  const plugin = wirePlugin();
  // Codex hosts got nothing before this (issue #42): shipped, never registered. Non-fatal like every
  // other wiring step — a second host we cannot reach must never break the one we can.
  try {
    const codexHost = wireCodexHost();
    if (codexHost.host) {
      const codexPlugin = wireCodexPlugin();
      if (codexPlugin.available) printCodexLifecycle(await codexLifecycleStatus());
    }
  } catch (e) {
    warn(`(Codex wiring skipped: ${e && e.message})`);
  }
  // THE CONSUMPTION FIX (the 40/100 finding, half two). These two lines used to be exactly this:
  //
  //     verifyInstall(cacheDir);
  //     await smokeQuery(cacheDir);
  //
  // Both functions RETURN a verdict. Both were called as statements. So an install with zero vector
  // stores, missing reader deps, or no MCP server printed three yellow warnings and then exited 0 —
  // and every downstream consumer (a CI job, a Dockerfile, a `&&` chain, a nightly probe) was told
  // the install succeeded. The detection was never the problem; dropping the result was.
  let verified = null;
  let smoke = null;
  if (!FLAG_NO_VERIFY) {
    verified = verifyInstall(cacheDir);
    smoke = await smokeQuery(cacheDir);
  }

  // ── onboarding: detect the toolkit + make offers (all optional, all non-fatal) ──
  const env = detectEnvironment();
  try { await offerStack(env); } catch (e) { warn(`(toolkit check skipped: ${e && e.message})`); }
  try { await offerClaudeMd(); } catch { /* non-fatal — never let an offer break the install */ }
  // Stuart's requirement: a default install must end by clearly recommending nightly auto-updates
  // and asking, DEFAULTING TO YES (TTY + macOS + not already on). Non-fatal like every other offer.
  let nightly = 'skipped';
  try { nightly = await offerNightly(); } catch { /* never let the offer break a finished install */ }
  // A spend watchdog, offered right after the updater: agentic tools can bill the paid API in the
  // background (a real 2026-07-09 incident burned ~$1,600 silently). This alarm makes that loud.
  // Non-fatal like every other offer — a safety net can never break a finished install.
  try { await offerSpendGuard(); } catch { /* a safety offer must never break a finished install */ }
  // Per-user subscription profile + router config (Stuart's mandate 2026-07-12: detect, ASK,
  // verify, record — never assume this user's subscriptions match anyone else's).
  try { await offerRouterProfile(); } catch { /* router setup must never break a finished install */ }
  // Anonymous usage counts — OPT-IN, asked once ever, right after the nightly offer. Same rule:
  // an optional offer can never break a finished install.
  try { await offerTelemetry(cacheDir); } catch { /* fail-private: unanswered = OFF */ }
  // Status-bar version segment — OPT-IN, asked once ever, never clobbers an existing statusline.
  // Same rule: an optional offer can never break a finished install.
  try { await offerStatusline(); } catch { /* non-fatal — a status-bar nicety must never break the install */ }

  success({ cacheDir, isCustom, plugin, env, nightly });

  // Close every install by stating, in one place, exactly what is now on their machine and how to
  // take each piece back off. Someone reading this should never have to file a bug report to find
  // out what we did — which is precisely the position the 2026-07-20 corporate-machine reporter was
  // left in. Derived from disk, so it can only ever describe what is actually there.
  try { printFootprint(); } catch { /* a summary must never break a finished install */ }

  // ── SCOPE + UPGRADE, on the path a real user actually takes ─────────────────────────────────
  //
  // These two blocks were first added inside runDemo(), which only runs with --demo — so almost
  // nobody would have seen them. Caught by running the install path instead of reasoning about it
  // (P1: verify through the USER'S path, never your own). printFootprint() is the right neighbour:
  // it already exists to tell someone exactly what is now on their machine.
  //
  // Read-only and fail-silent. This INFORMS; it never changes scope on its own. P3 (nudge, never
  // force) and P4 (the user is the arbiter of their own machine).
  try {
    const { detectCurrentScope, explainChoice, RECOMMENDED } = await import(new URL('../scripts/install-scope.mjs', import.meta.url).href);
    const current = detectCurrentScope();
    if (current && current.scope !== RECOMMENDED) {
      console.log(`\n${c.dim('  ── how this is set up on your machine ──')}`);
      for (const line of String(explainChoice({ current: current.scope })).split('\n').slice(0, 12)) console.log(`  ${line}`);
    }
  } catch (e) {
    // Same reasoning as the sibling block above — a silent import failure is what hid this for good.
    warn(`scope explainer could not run (${e && e.message}) — the setup summary was skipped`);
  }

  try {
    const { shouldNotify, noticeFor, recordNotified } = await import(new URL('../scripts/upgrade-notice.mjs', import.meta.url).href);
    const v = wrapperVersion();
    if (v && shouldNotify(v)) {
      const notice = noticeFor(v);
      if (notice) {
        console.log('');
        for (const line of String(notice).split('\n').slice(0, 14)) console.log(`  ${line}`);
        // Record it so this fires at most once per minor version — the anti-nag rule is only real
        // if the "already told them" state is actually written.
        try { recordNotified(v); } catch { /* best effort */ }
      }
    }
  } catch { /* informational only */ }

  // ── FINAL STEP: THE POST-INSTALL SELF-CHECK — the thing that runs on a stranger's machine and
  //    CAN FAIL (ADR-053 §2, ADR-055 build item 2). Deliberately last, so it observes the machine in
  //    the exact state the user is left in, after every wiring step and every optional offer.
  //
  //    ON A HEALTHY MACHINE: one calm confirming line. No nagging, no restating what already
  //    printed above.
  //    ON A BROKEN ONE: the violations, plainly, and a NON-ZERO exit code.
  //
  //    "Never block a healthy install" is honoured literally: a healthy install still exits 0 and
  //    nothing above this point is undone. What changes is that a genuinely broken install can no
  //    longer masquerade as a successful one to a script. The user's OWN hooks and third-party
  //    plugins are enumerated and reported but NEVER charged against them — only registrations this
  //    package ships can make this fail.
  if (!FLAG_NO_SELFCHECK) {
    const selfcheck = await runSelfCheck({
      installState: verified ? { repos: verified.repos, reader: verified.reader, mcp: verified.mcp } : null,
      quiet: true,
    });
    if (selfcheck.exitCode !== 0) {
      console.log(`\n  ${c.dim(`Re-run  ${c.bold('npx ruvnet-brain --doctor --hooks')}  after fixing, to re-check.`)}`);
      process.exitCode = selfcheck.exitCode;
    }
  }
  // The grounding smoke result is consumed here rather than discarded: it is a SEPARATE claim from
  // "installed and reachable" (an unproven grounding is not a broken install), so it informs the
  // user without failing the install.
  if (smoke && smoke.grounded === false) {
    warn('grounding was not proven on this run — the install is present but no verifiable citation came back.');
  }

  // ── THE DEGRADED STATE, PERSISTED, NOT DODGED (ADR-058 §D8 "the grounding-smoke decision") ──────
  // A failed smoke stays NON-FATAL here — a first-run model download or an air-gapped machine is
  // not a broken install, and blocking on it here would fail every offline user on first contact.
  // What changes is that the verdict stops EVAPORATING: it is written to disk so `--doctor` and
  // session-start.sh can see it without re-running a live query, and the FIRST REAL search_ruvnet
  // later either clears it (a real cited answer came back) or reconfirms it. `RUVNET_STRICT_INSTALL`
  // is the one place this non-fatal default flips to fatal — used ONLY by the hostile-machine CI
  // cell to prove the strict path is real, never set by a real install.
  try {
    const mod = await import(new URL('../scripts/selfcheck.mjs', import.meta.url).href);
    const grounding = smoke && smoke.grounded === true ? 'proven' : 'unproven';
    mod.writeInstallState({
      grounding,
      reason: !smoke ? 'verify-skipped' : (smoke.grounded === true ? null : (smoke.reason || (smoke.ran ? 'not-grounded' : 'no-answer'))),
    });
    if (grounding !== 'proven' && process.env.RUVNET_STRICT_INSTALL === '1') {
      die(
        'RUVNET_STRICT_INSTALL=1 and grounding was not proven on this run — refusing to report success.',
        'This strict mode exists only to prove the DEGRADED state is real (ADR-058 §D8); a default\ninstall never fails here — unset RUVNET_STRICT_INSTALL to get the normal, non-fatal behavior.',
      );
    }
  } catch (e) {
    // Persisting the verdict must never break a finished install — but a silently-skipped write is
    // exactly the kind of thing that must be visible, not swallowed, so it is named here.
    warn(`(could not persist the grounding verdict: ${e && e.message})`);
  }
})().catch((e) => {
  die(e && e.message ? e.message : String(e));
});
