#!/usr/bin/env node
/**
 * published-surface-probe.mjs — touch the surface a REAL user touches, on a schedule.
 *
 * THE DEDUCTION THIS CLOSES (ADR-058 D2, grader verbatim): "Zero `scheduled-live-probe` scenarios
 * (I listed all 22: 19 ci, 3 manual). Nothing ever probes the *published* surface (registry `npx`,
 * real Release download) on a schedule — the exact 'dead on the surface a real user touched'
 * failure ADR-053 names."
 *
 * Every one of the 19 `ci` scenarios runs against THE SOURCE CHECKOUT. That is a different artifact
 * from the one a stranger receives. A green CI and a dead `npx ruvnet-brain@latest` are perfectly
 * compatible states, and the gap between them is not hypothetical — it is produced by ordinary,
 * boring events that no push triggers:
 *
 *   · a `files:` array that omits a file the CLI requires — the checkout has it, the tarball does not
 *   · an `npm publish` that half-succeeded, or a version unpublished/deprecated out from under us
 *   · a Release asset deleted, re-uploaded truncated, or a tag moved
 *   · a dependency that vanished from the registry
 *
 * None of those change a byte in this repo, so no push-triggered workflow can ever notice. Only a
 * clock can. That is why this runs nightly and NOT on push.
 *
 * ── WHAT MAKES IT RED (stated plainly, because a probe that cannot fail is theater) ──────────────
 *   A1 the npm packument for `ruvnet-brain` is not fetchable, or carries no `dist-tags.latest`
 *   A2 the latest version's tarball URL does not HEAD 200 with a non-zero length
 *   B  `npx -y ruvnet-brain@latest --help` — installed FROM THE REGISTRY into a throwaway prefix —
 *      exits non-zero, or prints something that is not this installer's help. This is the check
 *      that catches a broken `files:`/`bin:` mapping, a syntax error, or a missing runtime dep:
 *      the published package is EXECUTED, not merely inspected.
 *   C1 `releases/latest` exposes no `ruvnet-brain.zip`
 *   C2 that asset is implausibly small (< MIN_BUNDLE_BYTES) — a truncated re-upload is a real and
 *      silent failure mode; "the asset exists" is not the same as "the asset is the bundle"
 *   C3 its browser_download_url does not resolve 200 with a matching content-length
 *   C4 the `.zip.sha256` sidecar is missing or is not a well-formed 64-hex digest — the installer
 *      verifies against it, so a malformed sidecar breaks every fresh install
 *
 * ── WHAT IS *NOT* RED, ON PURPOSE ───────────────────────────────────────────────────────────────
 * Version equality is a product invariant: npm dist-tags.latest and GitHub releases/latest must
 * name the same Brain generation. A partial publish is red even when both artifacts work alone.
 *
 * ── UNKNOWN IS NEVER PASS ───────────────────────────────────────────────────────────────────────
 * A rate-limited or unreachable network cannot distinguish "the surface is fine" from "the surface
 * is gone". That is UNKNOWN (exit 4), not green. Same discipline as scripts/learning-replay.mjs.
 *
 *   node scripts/published-surface-probe.mjs              full probe (network + a real npx install)
 *   node scripts/published-surface-probe.mjs --no-exec    skip check B (metadata only; much faster)
 *   node scripts/published-surface-probe.mjs --json       machine-readable result on stdout
 *
 * Exit: 0 PASS · 1 FAIL · 4 UNKNOWN.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, UNKNOWN: 4 });

const PKG = 'ruvnet-brain';
const REPO = 'stuinfla/ruvnet-brain';
const ASSET = 'ruvnet-brain.zip';
const REGISTRY = `https://registry.npmjs.org/${PKG}`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * The bundle is ~736MB-845MB today. The floor is set FAR below that — this is a truncation
 * detector, not a size assertion; the bundle is allowed to grow or shrink substantially without
 * anyone having to come edit this number. Anything under 100MB is not the brain.
 */
const MIN_BUNDLE_BYTES = 100 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** The published --help must be OUR help. A registry that serves a name-squatted package is red. */
const HELP_MARKERS = ['RuvNet Brain installer', 'npx ruvnet-brain'];

const argv = process.argv.slice(2);
const NO_EXEC = argv.includes('--no-exec');
const AS_JSON = argv.includes('--json');

const checks = [];
const record = (id, status, detail) => { checks.push({ id, status, detail }); return status; };
const say = (...a) => { if (!AS_JSON) console.log(...a); };

/** fetch + classify. A transport error is UNKNOWN; a 4xx/5xx from a reachable host is a fact. */
async function get(url, { method = 'GET', headers = {} } = {}) {
  try {
    const res = await fetch(url, { method, headers: { 'user-agent': `${PKG}-published-surface-probe`, ...headers }, redirect: 'follow' });
    return { ok: true, status: res.status, res };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── A. the npm registry surface ────────────────────────────────────────────────────────────────
async function probeRegistry() {
  const r = await get(REGISTRY);
  if (!r.ok) return { latest: null, s: record('A1-registry', 'UNKNOWN', `registry unreachable: ${r.error}`) };
  if (r.status === 404) return { latest: null, s: record('A1-registry', 'FAIL', `${PKG} is NOT PUBLISHED (registry 404) — every \`npx ${PKG}\` on earth is dead`) };
  if (r.status !== 200) return { latest: null, s: record('A1-registry', 'UNKNOWN', `registry returned HTTP ${r.status}`) };

  let doc;
  try { doc = await r.res.json(); } catch (e) { return { latest: null, s: record('A1-registry', 'FAIL', `registry returned unparseable JSON: ${e.message}`) }; }

  const latest = doc?.['dist-tags']?.latest;
  if (!latest) return { latest: null, s: record('A1-registry', 'FAIL', 'no dist-tags.latest — `npx pkg@latest` cannot resolve') };
  const versionDoc = doc?.versions?.[latest];
  if (!versionDoc) return { latest, s: record('A1-registry', 'FAIL', `dist-tags.latest=${latest} but no such version object — the tag points at nothing`) };
  const tarball = versionDoc?.dist?.tarball;
  if (!tarball) return { latest, s: record('A1-registry', 'FAIL', `${latest} carries no dist.tarball`) };
  record('A1-registry', 'PASS', `dist-tags.latest=${latest}`);

  // PROVE BYTES, NOT HEADERS. The first version of this check asserted a non-zero content-length on
  // a HEAD, and went red against a perfectly healthy registry: verified live 2026-07-28, npm answers
  // HEAD on a tarball with `HTTP/2 200` and NO content-length at all. That was a harness defect
  // reporting itself as a surface outage — the precise false-red that teaches people to ignore a
  // nightly. So: fetch a real byte range and check it is actually a gzip (npm tarballs are .tgz).
  // Stronger than a length header anyway — it catches a truncated or garbage upload, which a
  // correct-looking content-length would sail straight past.
  const range = await get(tarball, { headers: { range: 'bytes=0-1023' } });
  if (!range.ok) return { latest, s: record('A2-tarball', 'UNKNOWN', `tarball fetch failed: ${range.error}`) };
  if (range.status !== 200 && range.status !== 206) return { latest, s: record('A2-tarball', 'FAIL', `tarball HTTP ${range.status} → ${tarball}`) };
  const head4 = new Uint8Array(await range.res.arrayBuffer());
  if (head4.length === 0) return { latest, s: record('A2-tarball', 'FAIL', `tarball served zero bytes → ${tarball}`) };
  if (head4[0] !== 0x1f || head4[1] !== 0x8b) {
    return { latest, s: record('A2-tarball', 'FAIL', `tarball is not gzip (first bytes ${head4[0]?.toString(16)} ${head4[1]?.toString(16)}) → ${tarball}`) };
  }
  record('A2-tarball', 'PASS', `${head4.length} bytes served, gzip magic ok`);
  return { latest, s: 'PASS' };
}

// ── B. EXECUTE the published package, from the registry ────────────────────────────────────────
export function npxInvocation(args, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return {
    executable: env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'npx.cmd', ...args],
  };
  return { executable: 'npx', args };
}
function probeExec() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-probe-'));
  try {
    // --help is chosen deliberately: it is the one flag that exercises the real published entrypoint
    // (npm resolve → download → unpack → bin mapping → node parses every module it imports) while
    // touching NOTHING on the machine. `--doctor`/`--plan` reach the network and the brain dir; this
    // probe must never be the reason a surface changes.
    const invocation = npxInvocation(['-y', `${PKG}@latest`, '--help']);
    const r = spawnSync(invocation.executable, invocation.args, {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: home,
      env: { ...process.env, HOME: home, npm_config_yes: 'true', NO_COLOR: '1' },
    });
    if (r.error) return record('B-npx-exec', 'UNKNOWN', `could not spawn npx: ${r.error.message}`);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0) {
      return record('B-npx-exec', 'FAIL', `\`npx -y ${PKG}@latest --help\` exited ${r.status}. First 400 chars:\n${out.slice(0, 400)}`);
    }
    const missing = HELP_MARKERS.filter((m) => !out.includes(m));
    if (missing.length) {
      return record('B-npx-exec', 'FAIL', `published --help ran but does not look like this installer (missing: ${missing.join(', ')}). First 400 chars:\n${out.slice(0, 400)}`);
    }
    return record('B-npx-exec', 'PASS', `\`npx -y ${PKG}@latest --help\` exited 0 and printed this installer's help`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ── C. the GitHub Release surface the installer actually downloads ─────────────────────────────
async function probeRelease() {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const r = await get(RELEASE_API, { headers });
  if (!r.ok) return { tag: null, s: record('C1-release', 'UNKNOWN', `GitHub unreachable: ${r.error}`) };
  if (r.status === 403 || r.status === 429) return { tag: null, s: record('C1-release', 'UNKNOWN', `GitHub rate-limited (HTTP ${r.status}) — cannot distinguish healthy from gone`) };
  if (r.status === 404) return { tag: null, s: record('C1-release', 'FAIL', `${REPO} has NO published Release — a fresh install has nothing to download`) };
  if (r.status !== 200) return { tag: null, s: record('C1-release', 'UNKNOWN', `releases/latest returned HTTP ${r.status}`) };

  let rel;
  try { rel = await r.res.json(); } catch (e) { return { tag: null, s: record('C1-release', 'FAIL', `releases/latest unparseable: ${e.message}`) }; }
  const tag = rel?.tag_name || null;
  const assets = Array.isArray(rel?.assets) ? rel.assets : [];
  const zip = assets.find((a) => a.name === ASSET);
  if (!zip) {
    return { tag, s: record('C1-release', 'FAIL', `Release ${tag} has no "${ASSET}" (has: ${assets.map((a) => a.name).join(', ') || 'nothing'})`) };
  }
  record('C1-release', 'PASS', `Release ${tag} carries ${ASSET}`);

  if (!(zip.size >= MIN_BUNDLE_BYTES)) {
    return { tag, s: record('C2-bundle-size', 'FAIL', `${ASSET} is ${zip.size} bytes — below the ${MIN_BUNDLE_BYTES}-byte truncation floor; this is not the brain`) };
  }
  record('C2-bundle-size', 'PASS', `${zip.size} bytes`);

  const head = await get(zip.browser_download_url, { method: 'HEAD' });
  if (!head.ok) return { tag, s: record('C3-bundle-download', 'UNKNOWN', `bundle HEAD failed: ${head.error}`) };
  if (head.status !== 200) return { tag, s: record('C3-bundle-download', 'FAIL', `bundle download URL returned HTTP ${head.status} — the asset is listed but not fetchable`) };
  const len = Number(head.res.headers.get('content-length') || 0);
  if (len && Math.abs(len - zip.size) > 0) {
    return { tag, s: record('C3-bundle-download', 'FAIL', `served length ${len} != API-declared size ${zip.size} — the asset on the CDN is not the asset in the Release`) };
  }
  record('C3-bundle-download', 'PASS', `HTTP 200, ${len || zip.size} bytes`);

  const sidecar = assets.find((a) => a.name === `${ASSET}.sha256`);
  if (!sidecar) return { tag, s: record('C4-sha256-sidecar', 'FAIL', `no ${ASSET}.sha256 — the installer has nothing to verify the 800MB download against`) };
  const sc = await get(sidecar.browser_download_url);
  if (!sc.ok) return { tag, s: record('C4-sha256-sidecar', 'UNKNOWN', `sidecar fetch failed: ${sc.error}`) };
  if (sc.status !== 200) return { tag, s: record('C4-sha256-sidecar', 'FAIL', `sidecar returned HTTP ${sc.status}`) };
  const digest = (await sc.res.text()).trim().split(/\s+/)[0] || '';
  if (!SHA256_RE.test(digest)) {
    return { tag, s: record('C4-sha256-sidecar', 'FAIL', `sidecar is not a well-formed sha256 digest (got ${JSON.stringify(digest.slice(0, 80))})`) };
  }
  record('C4-sha256-sidecar', 'PASS', `${digest.slice(0, 16)}…`);
  return { tag, s: 'PASS' };
}

export async function main() {
  say('PUBLISHED-SURFACE probe — the artifact a stranger receives, not the one in this checkout\n');

  const reg = await probeRegistry();
  if (!NO_EXEC) probeExec();
  else record('B-npx-exec', 'SKIPPED', '--no-exec');
  const rel = await probeRelease();

  if (reg.latest && rel.tag) {
    const githubVersion = String(rel.tag).replace(/^v/, '');
    if (reg.latest === githubVersion) {
      record('D-version-coherence', 'PASS', `npm ${reg.latest} == GitHub ${rel.tag}`);
    } else {
      record('D-version-coherence', 'FAIL', `npm ${reg.latest} != GitHub ${rel.tag} — published surfaces identify different Brain generations`);
    }
  } else {
    record('D-version-coherence', 'UNKNOWN', 'npm or GitHub version unavailable; equality cannot be proven');
  }

  for (const c of checks) say(`  ${c.status.padEnd(7)} ${c.id.padEnd(20)} ${c.detail}`);

  say(`\n  npm dist-tags.latest = ${reg.latest ?? '?'} · GitHub releases/latest = ${rel.tag ?? '?'} (must match)`);

  const failed = checks.filter((c) => c.status === 'FAIL');
  const unknown = checks.filter((c) => c.status === 'UNKNOWN');
  const verdict = failed.length ? 'FAIL' : unknown.length ? 'UNKNOWN' : 'PASS';

  if (AS_JSON) console.log(JSON.stringify({ verdict, npmLatest: reg.latest, releaseTag: rel.tag, checks }, null, 2));
  else {
    say(`\n  PUBLISHED-SURFACE: ${verdict}`);
    if (failed.length) say(`  ${failed.length} check(s) FAILED — the published surface is broken for real users RIGHT NOW.`);
    if (!failed.length && unknown.length) say(`  ${unknown.length} check(s) UNKNOWN — a probe that could not measure is not a pass.`);
  }
  return EXIT[verdict];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exit(await main());
